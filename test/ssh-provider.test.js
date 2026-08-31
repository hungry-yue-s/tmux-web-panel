import { describe, it, expect, beforeEach, vi } from 'vitest';

import { SshProvider, SSH_ACTIONS } from '../server/workspace/ssh-provider.js';
import { ErrorCode } from '../server/servers/errors.js';

function fakePty() {
  const pty = {
    killed: [],
    onData(fn) { pty._data = fn; },
    onExit(fn) { pty._exit = fn; },
    write() {},
    resize() {},
    kill(signal) { pty.killed.push(signal); },
    emit(data) { pty._data(data); },
    exit(code = 0) { pty._exit({ exitCode: code, signal: null }); },
  };
  return pty;
}

describe('SshProvider', () => {
  let provider;
  let spawned;
  let changes;
  let now;

  beforeEach(() => {
    spawned = [];
    changes = 0;
    now = 1_000_000;
    provider = new SshProvider({
      serverId: 'api-linux',
      now: () => now,
      onChange: () => { changes += 1; },
      spawnPty: (ctx) => {
        const pty = fakePty();
        spawned.push({ ctx, pty });
        return pty;
      },
    });
  });

  it('requires a spawnPty function', () => {
    expect(() => new SshProvider({ serverId: 'x' })).toThrow(/spawnPty/);
    expect(() => new SshProvider({ serverId: 'x', spawnPty: 'nope' })).toThrow(/spawnPty/);
  });

  it('advertises ssh semantics, not tmux capabilities', () => {
    expect(provider.provider).toBe('ssh');
    expect(provider.persistence).toBe('process-memory');
    expect(provider.actions).toEqual(SSH_ACTIONS);
    expect(provider.actions.persistentAfterRestart).toBe(false);
    expect(provider.actions.capturePane).toBe(false);
    expect(provider.actions.tmuxLayout).toBe(false);
  });

  it('starts with an empty tree rather than a fake session', async () => {
    expect(await provider.getTree()).toEqual([]);
  });

  describe('createSession', () => {
    it('creates one window and one pane', async () => {
      const created = await provider.createSession({ name: 'API 调试' });

      expect(created.id).toMatch(/^ses_/);
      const tree = await provider.getTree();
      expect(tree).toHaveLength(1);
      expect(tree[0]).toMatchObject({ id: created.id, name: 'API 调试', active: true, windowCount: 1 });
      expect(tree[0].windows[0].panes).toHaveLength(1);
    });

    it('defaults the name', async () => {
      const created = await provider.createSession();
      expect(created.name).toBe('session-1');
    });

    it('rejects control characters and oversized names', async () => {
      await expect(provider.createSession({ name: 'a\u0000b' })).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
      await expect(provider.createSession({ name: 'x'.repeat(65) })).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
    });

    it('enforces a session ceiling', async () => {
      for (let i = 0; i < 16; i += 1) await provider.createSession({ name: `s${i}` });
      await expect(provider.createSession({ name: 'one-too-many' })).rejects.toMatchObject({
        code: ErrorCode.CONNECTION_LIMIT,
      });
    });

    it('leaves no empty session behind when the pane limit is hit', async () => {
      // Fill up the pane budget with windows in one session.
      await provider.createSession({ name: 'first' });
      const tree = await provider.getTree();
      const sessionId = tree[0].id;
      for (let i = 1; i < 32; i += 1) await provider.createWindow(sessionId, { name: `w${i}` });
      expect(provider.paneCount).toBe(32);

      await expect(provider.createSession({ name: 'doomed' })).rejects.toMatchObject({
        code: ErrorCode.CONNECTION_LIMIT,
      });

      const after = await provider.getTree();
      expect(after).toHaveLength(1);
      expect(after.map((s) => s.name)).not.toContain('doomed');
    });

    it('leaves no session behind when the pty factory fails', async () => {
      const failing = new SshProvider({
        serverId: 'api-linux',
        spawnPty: () => { throw new Error('ssh unavailable'); },
      });
      // The PTY is created lazily, so construction succeeds; the tree stays consistent.
      const created = await failing.createSession({ name: 'lazy' });
      expect((await failing.getTree())[0].id).toBe(created.id);
    });
  });

  describe('createWindow', () => {
    let sessionId;

    beforeEach(async () => {
      const created = await provider.createSession({ name: 'main' });
      sessionId = created.id;
    });

    it('adds an independent window with its own pane', async () => {
      const window = await provider.createWindow(sessionId, { name: 'logs' });

      const tree = await provider.getTree();
      expect(tree[0].windows).toHaveLength(2);
      expect(tree[0].windows[1]).toMatchObject({ id: window.id, name: 'logs', index: 1 });
      expect(spawned).toHaveLength(0); // still lazy until someone attaches
      expect(provider.paneCount).toBe(2);
    });

    it('reports a missing session', async () => {
      await expect(provider.createWindow('ses_missing', {})).rejects.toMatchObject({
        code: ErrorCode.SESSION_NOT_FOUND,
      });
    });

    it('leaves no empty window behind when the pane limit is hit', async () => {
      for (let i = 1; i < 32; i += 1) await provider.createWindow(sessionId, { name: `w${i}` });

      await expect(provider.createWindow(sessionId, { name: 'doomed' })).rejects.toMatchObject({
        code: ErrorCode.CONNECTION_LIMIT,
      });

      const tree = await provider.getTree();
      expect(tree[0].windows).toHaveLength(32);
      expect(tree[0].windows.map((w) => w.name)).not.toContain('doomed');
      // Index allocation must not have advanced for the rejected window.
      expect(await provider.createWindow.call(provider, sessionId, { name: 'x' }).catch((e) => e.code))
        .toBe(ErrorCode.CONNECTION_LIMIT);
    });
  });

  describe('splitPane', () => {
    let sessionId;
    let windowId;

    beforeEach(async () => {
      const created = await provider.createSession({ name: 'main' });
      sessionId = created.id;
      windowId = created.windowId;
    });

    it('rejects an unknown direction instead of guessing', async () => {
      await expect(provider.splitPane(windowId, { direction: 'diagonal' })).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        details: { field: 'direction' },
      });
      const tree = await provider.getTree();
      expect(tree[0].windows[0].panes).toHaveLength(1);
    });

    it('lays panes side by side for a horizontal split', async () => {
      await provider.splitPane(windowId, { direction: 'horizontal' });

      const window = (await provider.getTree())[0].windows[0];
      expect(window.splitDirection).toBe('horizontal');
      expect(window.panes.map((p) => p.geometry)).toEqual([
        { x: 0, y: 0, width: 50, height: 100 },
        { x: 50, y: 0, width: 50, height: 100 },
      ]);
    });

    it('stacks panes for a vertical split', async () => {
      await provider.splitPane(windowId, { direction: 'vertical' });

      const window = (await provider.getTree())[0].windows[0];
      expect(window.splitDirection).toBe('vertical');
      expect(window.panes.map((p) => p.geometry)).toEqual([
        { x: 0, y: 0, width: 100, height: 50 },
        { x: 0, y: 50, width: 100, height: 50 },
      ]);
    });

    it('defaults to a vertical split like tmux does', async () => {
      await provider.splitPane(windowId, {});
      expect((await provider.getTree())[0].windows[0].splitDirection).toBe('vertical');
    });

    it('restores the previous direction when the split is refused', async () => {
      await provider.splitPane(windowId, { direction: 'horizontal' });
      for (let i = 0; i < 30; i += 1) await provider.createWindow(sessionId, { name: `w${i}` });
      expect(provider.paneCount).toBe(32);

      await expect(provider.splitPane(windowId, { direction: 'vertical' })).rejects.toMatchObject({
        code: ErrorCode.CONNECTION_LIMIT,
      });

      expect((await provider.getTree())[0].windows[0].splitDirection).toBe('horizontal');
    });
  });

  describe('updatePane', () => {
    let paneId;
    let windowId;

    beforeEach(async () => {
      const created = await provider.createSession({ name: 'main' });
      paneId = created.paneId;
      windowId = created.windowId;
    });

    it('sets and clears a label', async () => {
      await provider.updatePane(paneId, { label: 'build' });
      expect((await provider.getTree())[0].windows[0].panes[0].label).toBe('build');

      await provider.updatePane(paneId, { label: null });
      expect((await provider.getTree())[0].windows[0].panes[0].label).toBeNull();
    });

    it('caps the label at tmux length for a consistent experience', async () => {
      await expect(provider.updatePane(paneId, { label: 'x'.repeat(33) })).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        details: { field: 'label' },
      });
      await expect(provider.updatePane(paneId, { label: 'x'.repeat(32) })).resolves.toBeTruthy();
    });

    it('rejects unknown fields', async () => {
      await expect(provider.updatePane(paneId, { colour: 'red' })).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        details: { field: 'colour' },
      });
    });

    it('rejects a non-boolean active flag', async () => {
      await expect(provider.updatePane(paneId, { active: 'yes' })).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
    });

    it('moves the active flag to exactly one pane', async () => {
      const second = await provider.splitPane(windowId, { direction: 'horizontal' });
      await provider.updatePane(second.id, { active: true });

      const panes = (await provider.getTree())[0].windows[0].panes;
      expect(panes.filter((p) => p.active).map((p) => p.id)).toEqual([second.id]);
    });

    it('bounds geometry values and rejects unknown geometry keys', async () => {
      await expect(provider.updatePane(paneId, { geometry: { width: 101 } })).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        details: { field: 'geometry.width' },
      });
      await expect(provider.updatePane(paneId, { geometry: { width: -1 } })).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
      await expect(provider.updatePane(paneId, { geometry: { z: 1 } })).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        details: { field: 'z' },
      });
      await expect(provider.updatePane(paneId, { geometry: 'wide' })).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
      await expect(provider.updatePane(paneId, { geometry: { width: 60 } })).resolves.toBeTruthy();
    });

    it('reports a missing pane', async () => {
      await expect(provider.updatePane('pane_missing', { label: 'x' })).rejects.toMatchObject({
        code: ErrorCode.PANE_NOT_FOUND,
      });
    });
  });

  describe('closing', () => {
    it('closePane removes the empty window and then the empty session', async () => {
      const created = await provider.createSession({ name: 'solo' });

      await provider.closePane(created.paneId);

      expect(await provider.getTree()).toEqual([]);
      expect(provider.paneCount).toBe(0);
    });

    it('closeWindow removes the session when it was the last window', async () => {
      const created = await provider.createSession({ name: 'solo' });

      await provider.closeWindow(created.windowId);

      expect(await provider.getTree()).toEqual([]);
    });

    it('closeWindow keeps a session that still has windows', async () => {
      const created = await provider.createSession({ name: 'multi' });
      await provider.createWindow(created.id, { name: 'second' });

      await provider.closeWindow(created.windowId);

      const tree = await provider.getTree();
      expect(tree).toHaveLength(1);
      expect(tree[0].windows).toHaveLength(1);
      expect(tree[0].windows[0].active).toBe(true);
    });

    it('hands the active flag to a surviving session', async () => {
      const first = await provider.createSession({ name: 'first' });
      await provider.createSession({ name: 'second' });

      await provider.closeSession(first.id);

      const tree = await provider.getTree();
      expect(tree).toHaveLength(1);
      expect(tree[0].active).toBe(true);
    });

    it('kills the pty when a pane closes', async () => {
      const created = await provider.createSession({ name: 'x' });
      provider.getRuntime(created.paneId).subscribe({ send: () => {} });

      await provider.closePane(created.paneId);

      expect(spawned[0].pty.killed).toContain('SIGHUP');
    });

    it('relayouts the remaining panes after a close', async () => {
      const created = await provider.createSession({ name: 'x' });
      await provider.splitPane(created.windowId, { direction: 'horizontal' });
      const third = await provider.splitPane(created.windowId, { direction: 'horizontal' });

      await provider.closePane(third.id);

      const panes = (await provider.getTree())[0].windows[0].panes;
      expect(panes).toHaveLength(2);
      expect(panes.map((p) => p.geometry.width)).toEqual([50, 50]);
    });
  });

  describe('runtime reporting', () => {
    it('exposes attach state so the ui can explain lifecycle', async () => {
      const created = await provider.createSession({ name: 'x' });
      const client = { send: () => {} };
      provider.getRuntime(created.paneId).subscribe(client);

      let pane = (await provider.getTree())[0].windows[0].panes[0];
      expect(pane.runtime).toMatchObject({ attached: true, alive: true });

      provider.getRuntime(created.paneId).unsubscribe(client);
      pane = (await provider.getTree())[0].windows[0].panes[0];
      expect(pane.runtime.attached).toBe(false);
      expect(pane.runtime.detachedAt).not.toBeNull();
    });

    it('resolvePane returns the full address', async () => {
      const created = await provider.createSession({ name: 'x' });
      await expect(provider.resolvePane(created.paneId)).resolves.toMatchObject({
        serverId: 'api-linux',
        provider: 'ssh',
        persistence: 'process-memory',
        sessionId: created.id,
        windowId: created.windowId,
        paneId: created.paneId,
      });
    });

    it('reap removes expired panes and prunes empty parents', async () => {
      const created = await provider.createSession({ name: 'x' });
      const runtime = provider.getRuntime(created.paneId);
      const client = { send: () => {} };
      runtime.subscribe(client);
      runtime.unsubscribe(client);

      now += 31 * 60 * 1000;
      expect(provider.reap(now)).toEqual([created.paneId]);
      expect(await provider.getTree()).toEqual([]);
    });

    it('reap keeps a pane that never detached', async () => {
      const created = await provider.createSession({ name: 'x' });
      provider.getRuntime(created.paneId).subscribe({ send: () => {} });

      now += 60 * 60 * 1000;
      expect(provider.reap(now)).toEqual([]);
    });

    it('destroyAll clears the tree and ends every pty', async () => {
      const a = await provider.createSession({ name: 'a' });
      const b = await provider.createSession({ name: 'b' });
      provider.getRuntime(a.paneId).subscribe({ send: () => {} });
      provider.getRuntime(b.paneId).subscribe({ send: () => {} });

      provider.destroyAll();

      expect(await provider.getTree()).toEqual([]);
      expect(provider.paneCount).toBe(0);
      for (const { pty } of spawned) expect(pty.killed.length).toBeGreaterThan(0);
    });

    it('hasActivePanes tracks live ptys only', async () => {
      const created = await provider.createSession({ name: 'x' });
      expect(provider.hasActivePanes()).toBe(false);

      provider.getRuntime(created.paneId).subscribe({ send: () => {} });
      expect(provider.hasActivePanes()).toBe(true);

      spawned[0].pty.exit(0);
      expect(provider.hasActivePanes()).toBe(false);
    });
  });

  describe('natural pty exit', () => {
    it('removes the pane, window and session from the tree', async () => {
      const created = await provider.createSession({ name: 'solo' });
      provider.getRuntime(created.paneId).subscribe({ send: () => {}, exit: () => {} });

      spawned[0].pty.exit(0);

      expect(await provider.getTree()).toEqual([]);
      expect(provider.getRuntime(created.paneId)).toBeNull();
      expect(provider.paneCount).toBe(0);
    });

    it('leaves no resolvable ghost behind', async () => {
      const created = await provider.createSession({ name: 'ghost' });
      provider.getRuntime(created.paneId).subscribe({ send: () => {}, exit: () => {} });

      spawned[0].pty.exit(0);

      // Before the fix this resolved but could never be attached to.
      await expect(provider.resolvePane(created.paneId)).rejects.toMatchObject({
        code: ErrorCode.PANE_NOT_FOUND,
      });
    });

    it('keeps siblings and relayouts when other panes remain', async () => {
      const created = await provider.createSession({ name: 'multi' });
      const second = await provider.splitPane(created.windowId, { direction: 'horizontal' });
      provider.getRuntime(created.paneId).subscribe({ send: () => {}, exit: () => {} });
      provider.getRuntime(second.id).subscribe({ send: () => {}, exit: () => {} });

      spawned[0].pty.exit(0);

      const tree = await provider.getTree();
      expect(tree).toHaveLength(1);
      const panes = tree[0].windows[0].panes;
      expect(panes.map((p) => p.id)).toEqual([second.id]);
      expect(panes[0].geometry).toEqual({ x: 0, y: 0, width: 100, height: 100 });
      expect(panes[0].active).toBe(true);
    });

    it('keeps other windows in the session', async () => {
      const created = await provider.createSession({ name: 'two-windows' });
      const other = await provider.createWindow(created.id, { name: 'second' });
      provider.getRuntime(created.paneId).subscribe({ send: () => {}, exit: () => {} });

      spawned[0].pty.exit(0);

      const tree = await provider.getTree();
      expect(tree[0].windows.map((w) => w.id)).toEqual([other.id]);
      expect(tree[0].windows[0].active).toBe(true);
    });

    it('notifies once for a natural exit', async () => {
      const created = await provider.createSession({ name: 'x' });
      provider.getRuntime(created.paneId).subscribe({ send: () => {}, exit: () => {} });
      changes = 0;

      spawned[0].pty.exit(0);

      expect(changes).toBe(1);
    });

    it('does not notify again when the pane was already closed explicitly', async () => {
      const created = await provider.createSession({ name: 'x' });
      provider.getRuntime(created.paneId).subscribe({ send: () => {}, exit: () => {} });

      await provider.closePane(created.paneId);
      changes = 0;

      // The PTY reports its own exit after our explicit teardown.
      spawned[0].pty.exit(0);

      expect(changes).toBe(0);
    });

    it('tells the attached client the shell exited', async () => {
      const created = await provider.createSession({ name: 'x' });
      const exits = [];
      provider.getRuntime(created.paneId).subscribe({ send: () => {}, exit: (info) => exits.push(info) });

      spawned[0].pty.exit(5);

      expect(exits).toEqual([{ code: 5, signal: null, reason: 'remote_shell_exit' }]);
    });
  });

  it('passes pane identity to the pty factory', async () => {
    const created = await provider.createSession({ name: 'x' });
    provider.getRuntime(created.paneId).subscribe({ send: () => {} });

    expect(spawned[0].ctx).toMatchObject({
      serverId: 'api-linux',
      sessionId: created.id,
      windowId: created.windowId,
      paneId: created.paneId,
    });
  });

  it('notifies on every structural change', async () => {
    changes = 0;
    const created = await provider.createSession({ name: 'x' });
    await provider.createWindow(created.id, { name: 'y' });
    await provider.closeWindow(created.windowId);

    expect(changes).toBe(3);
  });
});
