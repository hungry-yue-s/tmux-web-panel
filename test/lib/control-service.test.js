import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchService } from '../../lib/terminal/control-service.js';

function fixture(configDir, outcome = '@7|%9') {
  const mutations = [];
  const pool = { socketIdentity: 'private', capability: async () => ({ available: true, protocol: 1 }),
    resolve: async target => ({ ...target, cols: 80, rows: 24 }) };
  const tmux = { run: async args => {
    if (args[0] === 'display-message') return '77:88|$1';
    if (args[0] === 'if-shell') { mutations.push(args); if (outcome instanceof Error) throw outcome; return outcome; }
    throw Error('unexpected');
  } };
  const service = new WorkbenchService({ pool, nativePool: pool, tmux, workspace: {}, configDir });
  return { service, mutations, pool, tmux };
}
const body = { instanceId: '77:88', sessionId: '$1', requestId: '01234567-0123-4567-8901-012345678901', cols: 100, rows: 30 };

describe('workbench pane creation', () => {
  it('creates native windows without forcing manual sizing or rejecting the user new-window hook', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-window-ledger-'));
    try {
      const { service, mutations, pool } = fixture(dir);
      pool.resolve = async () => { throw Error('Raw single-pane checks must not run for a native window'); };
      const first = await service.createWindow(body);
      expect(first).toMatchObject({ paneId: '%9', windowId: '@7' });
      expect(mutations).toHaveLength(1);
      expect(mutations[0][5]).toContain('new-window -d');
      expect(mutations[0][5]).not.toMatch(/resize-window|set-option/);
      const restarted = fixture(dir);
      expect(await restarted.service.createWindow(body)).toEqual(first);
      expect(restarted.mutations).toHaveLength(0);
      await expect(restarted.service.createPane(body)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('creates a detached single-pane window only once for simultaneous and persisted request retries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'control-ledger-'));
    try {
      const { service, mutations } = fixture(dir);
      const [a, b] = await Promise.all([service.createPane(body), service.createPane(body)]);
      expect(a).toEqual(b);
      expect(a).toMatchObject({ paneId: '%9', windowId: '@7', instanceId: '77:88', requestId: body.requestId });
      expect(mutations.filter(args => args[5].startsWith('new-window'))).toHaveLength(1);
      expect(mutations[0][5]).toContain('new-window -d');
      expect(mutations[0][5]).not.toMatch(/attach-session|select-pane|resize-pane|kill-/);
      const resumed = fixture(dir);
      expect(await resumed.service.createPane(body)).toEqual(a);
      expect(resumed.mutations).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('never retries an ambiguous failed creation, including after service restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'control-ledger-'));
    try {
      const { service, mutations } = fixture(dir, Error('connection lost after server accepted mutation'));
      await expect(service.createPane(body)).rejects.toBeDefined();
      await expect(service.createPane(body)).rejects.toBeDefined();
      expect(mutations.filter(args => args[5].startsWith('new-window'))).toHaveLength(1);
      const resumed = fixture(dir);
      await expect(resumed.service.createPane(body)).rejects.toBeDefined();
      expect(resumed.mutations).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('retries the same request after a preflight failure that never reached a mutation receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'control-ledger-'));
    try {
      const { service, mutations, tmux } = fixture(dir);
      const run = tmux.run; let attempts = 0;
      tmux.run = async args => {
        if (args[0] === 'display-message' && ++attempts === 1) throw Error('temporary read failure');
        return run(args);
      };
      await expect(service.createPane(body)).rejects.toBeDefined();
      expect(mutations).toHaveLength(0);
      expect(await service.createPane(body)).toMatchObject({ paneId: '%9' });
      expect(attempts).toBe(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('does not submit a mutation after disposal and lets a fresh service retry a request that never mutated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'control-ledger-'));
    try {
      const { service, mutations, pool } = fixture(dir);
      pool.capability = async () => { service.dispose(); return { available: true }; };
      await expect(service.createPane(body)).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' });
      expect(mutations).toHaveLength(0);
      const fresh = fixture(dir);
      expect(await fresh.service.createPane(body)).toMatchObject({ paneId: '%9' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('retains an uncertain receipt if disposal happens after creation and prevents the following resize mutation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'control-ledger-'));
    try {
      const { service, mutations, tmux } = fixture(dir);
      const run = tmux.run;
      tmux.run = async args => { const result = await run(args); if (args[0] === 'if-shell') service.dispose(); return result; };
      await expect(service.createPane(body)).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' });
      expect(mutations).toHaveLength(1);
      const fresh = fixture(dir);
      await expect(fresh.service.createPane(body)).rejects.toMatchObject({ code: 'TERMINAL_BUSY' });
      expect(fresh.mutations).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('requires exact instance and rejects reusing a request with different parameters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'control-ledger-'));
    try {
      const { service, mutations } = fixture(dir);
      await expect(service.createPane({ ...body, instanceId: '1:2' })).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' });
      expect(mutations).toHaveLength(0);
      await service.createPane(body);
      await expect(service.createPane({ ...body, cols: 200 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(mutations.filter(args => args[5].startsWith('new-window'))).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
