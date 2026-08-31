import { describe, it, expect, beforeEach, vi } from 'vitest';

import { OutputRing, PaneRuntime, utf8Tail, DEFAULT_BUFFER_BYTES } from '../server/terminal/pane-runtime.js';
import { ErrorCode } from '../server/servers/errors.js';

/** Minimal node-pty stand-in. */
function fakePty() {
  const pty = {
    written: [],
    resized: [],
    killed: [],
    _data: null,
    _exit: null,
    onData(fn) { pty._data = fn; },
    onExit(fn) { pty._exit = fn; },
    write(data) { pty.written.push(data); },
    resize(cols, rows) { pty.resized.push([cols, rows]); },
    kill(signal) { pty.killed.push(signal); },
    emit(data) { pty._data(data); },
    exit(exitCode = 0, signal = null) { pty._exit({ exitCode, signal }); },
  };
  return pty;
}

function subscriber() {
  const received = [];
  const exits = [];
  return {
    received,
    exits,
    send: (data) => received.push(data),
    exit: (info) => exits.push(info),
  };
}

function makeRuntime(overrides = {}) {
  const pty = fakePty();
  let clock = 1_000_000;
  const runtime = new PaneRuntime({
    serverId: 'api-linux',
    sessionId: 'ses_1',
    windowId: 'win_1',
    paneId: 'pane_1',
    spawn: () => pty,
    now: () => clock,
    ...overrides,
  });
  return { runtime, pty, advance: (ms) => { clock += ms; }, at: () => clock };
}

describe('utf8Tail', () => {
  it('honors a byte budget for multi-byte text', () => {
    const emoji = '🚀'.repeat(100); // 4 bytes each
    const tail = utf8Tail(emoji, 40);
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(40);
    expect(tail).toBe('🚀'.repeat(10));
  });

  it('never splits a character', () => {
    const text = 'a' + '🚀'.repeat(10);
    // 39 bytes lands in the middle of a rocket.
    const tail = utf8Tail(text, 39);
    expect(tail).not.toContain('\ufffd');
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(39);
  });

  it('returns the input when it already fits', () => {
    expect(utf8Tail('short', 100)).toBe('short');
  });

  it('handles CJK text', () => {
    const cjk = '本机管理'.repeat(50); // 3 bytes per char
    const tail = utf8Tail(cjk, 30);
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(30);
    expect(tail).not.toContain('\ufffd');
  });
});

describe('OutputRing', () => {
  it('replays what was written', () => {
    const ring = new OutputRing(1024);
    ring.push('hello ');
    ring.push('world');
    expect(ring.read()).toBe('hello world');
  });

  it('drops the oldest chunks past the byte cap', () => {
    const ring = new OutputRing(10);
    ring.push('aaaa');
    ring.push('bbbb');
    ring.push('cccc');
    expect(ring.bytes).toBeLessThanOrEqual(10);
    expect(ring.read()).toBe('bbbbcccc');
  });

  it('bounds a single oversized chunk by bytes, not characters', () => {
    const ring = new OutputRing(1024);
    ring.push('🚀'.repeat(2000)); // 8000 bytes in one chunk
    expect(ring.bytes).toBeLessThanOrEqual(1024);
    expect(ring.read()).not.toContain('\ufffd');
  });

  it('keeps a unicode-heavy stream under the default cap', () => {
    const ring = new OutputRing(DEFAULT_BUFFER_BYTES);
    for (let i = 0; i < 500; i += 1) ring.push('本机🚀'.repeat(200));
    expect(ring.bytes).toBeLessThanOrEqual(DEFAULT_BUFFER_BYTES);
  });

  it('clears', () => {
    const ring = new OutputRing(64);
    ring.push('x');
    ring.clear();
    expect(ring.read()).toBe('');
    expect(ring.bytes).toBe(0);
  });
});

describe('PaneRuntime', () => {
  it('does not spawn until someone subscribes', () => {
    const spawn = vi.fn(() => fakePty());
    const runtime = new PaneRuntime({ serverId: 's', sessionId: 'a', windowId: 'b', paneId: 'c', spawn });

    expect(spawn).not.toHaveBeenCalled();
    runtime.subscribe(subscriber());
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('can be preheated without a subscriber', () => {
    const { runtime } = makeRuntime();
    runtime.start();
    expect(runtime.alive).toBe(true);
    expect(runtime.subscribers.size).toBe(0);
  });

  describe('multiple subscribers', () => {
    it('fans output out to every subscriber', () => {
      const { runtime, pty } = makeRuntime();
      const a = subscriber();
      const b = subscriber();
      runtime.subscribe(a);
      runtime.subscribe(b);

      pty.emit('shared output');

      expect(a.received).toEqual(['shared output']);
      expect(b.received).toEqual(['shared output']);
    });

    it('replays the buffer to a late subscriber only', () => {
      const { runtime, pty } = makeRuntime();
      const first = subscriber();
      runtime.subscribe(first);
      pty.emit('earlier output');

      const late = subscriber();
      const replay = runtime.subscribe(late);

      expect(replay).toBe('earlier output');
      expect(late.received).toEqual([]);
      pty.emit('live');
      expect(late.received).toEqual(['live']);
      expect(first.received).toEqual(['earlier output', 'live']);
    });

    it('writes input from any subscriber to the one PTY', () => {
      const { runtime, pty } = makeRuntime();
      const a = subscriber();
      const b = subscriber();
      runtime.subscribe(a);
      runtime.subscribe(b);

      runtime.write('from-a');
      runtime.write('from-b');

      expect(pty.written).toEqual(['from-a', 'from-b']);
    });

    it('keeps fanning out when one subscriber throws', () => {
      const { runtime, pty } = makeRuntime();
      const broken = { send: () => { throw new Error('socket closed'); } };
      const healthy = subscriber();
      runtime.subscribe(broken);
      runtime.subscribe(healthy);

      expect(() => pty.emit('data')).not.toThrow();
      expect(healthy.received).toEqual(['data']);
    });

    it('lets the most recently focused subscriber own the size', () => {
      const { runtime, pty } = makeRuntime();
      const a = subscriber();
      const b = subscriber();
      runtime.subscribe(a);
      runtime.subscribe(b);

      expect(runtime.resize(100, 30, { focusEpoch: 1, subscriber: a })).toBe(true);
      // A stale epoch from the other client must not win.
      expect(runtime.resize(80, 24, { focusEpoch: 0, subscriber: b })).toBe(false);
      expect(runtime.cols).toBe(100);

      expect(runtime.resize(120, 40, { focusEpoch: 2, subscriber: b })).toBe(true);
      expect(runtime.cols).toBe(120);
      expect(pty.resized).toEqual([[100, 30], [120, 40]]);
    });

    it('releases focus ownership when the owner disconnects', () => {
      const { runtime } = makeRuntime();
      const owner = subscriber();
      const other = subscriber();
      runtime.subscribe(owner);
      runtime.subscribe(other);
      runtime.resize(100, 30, { focusEpoch: 5, subscriber: owner });

      // While the owner is present, the other client cannot resize.
      expect(runtime.resize(90, 25, { subscriber: other })).toBe(false);

      runtime.unsubscribe(owner);

      // Ownership must not outlive the socket, or the survivor is stuck forever.
      expect(runtime.resize(90, 25, { subscriber: other })).toBe(true);
      expect(runtime.cols).toBe(90);
      expect(runtime.resize(85, 24, { focusEpoch: 1, subscriber: other })).toBe(true);
    });

    it('lets a reconnecting client take the size after the owner left', () => {
      const { runtime } = makeRuntime();
      const owner = subscriber();
      runtime.subscribe(owner);
      runtime.resize(200, 50, { focusEpoch: 9, subscriber: owner });
      runtime.unsubscribe(owner);

      const reconnected = subscriber();
      runtime.subscribe(reconnected);
      expect(runtime.resize(100, 30, { focusEpoch: 0, subscriber: reconnected })).toBe(true);
      expect(runtime.cols).toBe(100);
    });
  });

  describe('resize guards', () => {
    it('rejects nonsense and out-of-range dimensions', () => {
      const { runtime } = makeRuntime();
      runtime.subscribe(subscriber());

      for (const [cols, rows] of [[0, 24], [80, 0], [-1, 24], [1.5, 24], [3000, 24], [80, 5000]]) {
        expect(runtime.resize(cols, rows)).toBe(false);
      }
      expect(runtime.cols).toBe(80);
    });

    it('survives a PTY that throws on resize', () => {
      const { runtime, pty } = makeRuntime();
      runtime.subscribe(subscriber());
      pty.resize = () => { throw new Error('ioctl failed'); };

      expect(() => runtime.resize(120, 40)).not.toThrow();
      expect(runtime.resize(130, 40)).toBe(false);
    });

    it('skips a no-op resize', () => {
      const { runtime, pty } = makeRuntime();
      runtime.subscribe(subscriber());
      expect(runtime.resize(80, 24)).toBe(true);
      expect(pty.resized).toEqual([]);
    });
  });

  describe('detach and TTL', () => {
    it('stays alive after the last subscriber leaves', () => {
      const { runtime } = makeRuntime();
      const only = subscriber();
      runtime.subscribe(only);
      runtime.unsubscribe(only);

      expect(runtime.alive).toBe(true);
      expect(runtime.detachedAt).not.toBeNull();
    });

    it('reconnects within the TTL and replays', () => {
      const { runtime, pty, advance } = makeRuntime();
      const first = subscriber();
      runtime.subscribe(first);
      pty.emit('work in progress');
      runtime.unsubscribe(first);

      advance(60_000);
      const again = subscriber();
      const replay = runtime.subscribe(again);

      expect(replay).toBe('work in progress');
      expect(runtime.detachedAt).toBeNull();
      expect(runtime.alive).toBe(true);
    });

    it('expires after the TTL with no subscriber and no activity', () => {
      const { runtime, advance } = makeRuntime({ detachedTtlMs: 1000 });
      const only = subscriber();
      runtime.subscribe(only);
      runtime.unsubscribe(only);

      advance(999);
      expect(runtime.isExpired()).toBe(false);
      advance(2);
      expect(runtime.isExpired()).toBe(true);
    });

    it('renews the lease while output keeps arriving', () => {
      const { runtime, pty, advance } = makeRuntime({ detachedTtlMs: 1000 });
      const only = subscriber();
      runtime.subscribe(only);
      runtime.unsubscribe(only);

      advance(800);
      pty.emit('still working');
      advance(800);
      // Activity renewed the lease, per the documented "no subscriber and no I/O" rule.
      expect(runtime.isExpired()).toBe(false);

      advance(1001);
      expect(runtime.isExpired()).toBe(true);
    });

    it('never expires while a subscriber is attached', () => {
      const { runtime, advance } = makeRuntime({ detachedTtlMs: 100 });
      runtime.subscribe(subscriber());
      advance(10_000);
      expect(runtime.isExpired()).toBe(false);
    });

    it('is not expired before it ever detached', () => {
      const { runtime, advance } = makeRuntime({ detachedTtlMs: 100 });
      runtime.start();
      advance(10_000);
      expect(runtime.isExpired()).toBe(false);
    });
  });

  describe('exit', () => {
    it('records the exit code and refuses new subscribers', () => {
      const { runtime } = makeRuntime();
      runtime.subscribe(subscriber());
      runtime.pty.exit(3, null);

      expect(runtime.alive).toBe(false);
      expect(runtime.exitInfo).toEqual({ code: 3, signal: null });
      // A dead PTY must not be handed out as a live connection.
      expect(() => runtime.subscribe(subscriber())).toThrow(
        expect.objectContaining({ code: ErrorCode.PANE_NOT_FOUND }),
      );
    });

    it('tells every subscriber the shell exited', () => {
      const { runtime, pty } = makeRuntime();
      const a = subscriber();
      const b = subscriber();
      runtime.subscribe(a);
      runtime.subscribe(b);

      pty.exit(7, null);

      // Without this the browser socket would stay open on a dead pane.
      expect(a.exits).toEqual([{ code: 7, signal: null, reason: 'remote_shell_exit' }]);
      expect(b.exits).toEqual([{ code: 7, signal: null, reason: 'remote_shell_exit' }]);
      expect(runtime.subscribers.size).toBe(0);
    });

    it('notifies the owner on exit', () => {
      const onExit = vi.fn();
      const { runtime } = makeRuntime({ onExit });
      runtime.subscribe(subscriber());
      runtime.pty.exit(0);
      expect(onExit).toHaveBeenCalledTimes(1);
    });

    it('ignores writes after exit', () => {
      const { runtime, pty } = makeRuntime();
      runtime.subscribe(subscriber());
      pty.exit(0);
      expect(runtime.write('late')).toBe(false);
      expect(pty.written).toEqual([]);
    });

    it('keeps notifying when one subscriber throws on exit', () => {
      const { runtime, pty } = makeRuntime();
      const broken = { send: () => {}, exit: () => { throw new Error('socket gone'); } };
      const healthy = subscriber();
      runtime.subscribe(broken);
      runtime.subscribe(healthy);

      expect(() => pty.exit(1)).not.toThrow();
      expect(healthy.exits).toHaveLength(1);
    });
  });

  describe('destroy', () => {
    it('signals politely first, then escalates', () => {
      vi.useFakeTimers();
      try {
        const { runtime, pty } = makeRuntime();
        runtime.subscribe(subscriber());

        runtime.destroy('closed');
        expect(pty.killed).toEqual(['SIGHUP']);

        vi.advanceTimersByTime(600);
        expect(pty.killed).toEqual(['SIGHUP', 'SIGKILL']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('tells subscribers why the pane went away', () => {
      const { runtime } = makeRuntime();
      const a = subscriber();
      const b = subscriber();
      runtime.subscribe(a);
      runtime.subscribe(b);

      runtime.destroy('window_closed');

      expect(a.exits).toEqual([{ code: null, signal: null, reason: 'window_closed' }]);
      expect(b.exits).toEqual([{ code: null, signal: null, reason: 'window_closed' }]);
      expect(runtime.subscribers.size).toBe(0);
      expect(runtime.alive).toBe(false);
    });

    it('delivers exactly one exit when the pty exits after destroy', () => {
      const { runtime, pty } = makeRuntime();
      const client = subscriber();
      runtime.subscribe(client);

      runtime.destroy('closed');
      pty.exit(0);

      expect(client.exits).toHaveLength(1);
      expect(client.exits[0].reason).toBe('closed');
    });

    it('does not escalate when the PTY already exited', () => {
      vi.useFakeTimers();
      try {
        const { runtime, pty } = makeRuntime();
        runtime.subscribe(subscriber());
        runtime.destroy();
        pty.exit(0);

        vi.advanceTimersByTime(600);
        expect(pty.killed).toEqual(['SIGHUP']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('refuses new subscribers once destroyed', () => {
      const { runtime } = makeRuntime();
      runtime.subscribe(subscriber());
      runtime.destroy('closed');

      expect(() => runtime.subscribe(subscriber())).toThrow(
        expect.objectContaining({ code: ErrorCode.PANE_NOT_FOUND }),
      );
    });

    it('is safe on a runtime that never started', () => {
      const { runtime, pty } = makeRuntime();
      expect(() => runtime.destroy()).not.toThrow();
      expect(pty.killed).toEqual([]);
    });

    it('unsubscribe is idempotent', () => {
      const { runtime } = makeRuntime();
      const client = subscriber();
      runtime.subscribe(client);

      runtime.unsubscribe(client);
      expect(() => runtime.unsubscribe(client)).not.toThrow();
      expect(runtime.subscribers.size).toBe(0);
    });
  });

  it('describes itself without leaking buffered content', () => {
    const { runtime, pty } = makeRuntime();
    runtime.subscribe(subscriber());
    pty.emit('secret token abc');

    const described = runtime.describe();
    expect(described).toMatchObject({ serverId: 'api-linux', paneId: 'pane_1', subscribers: 1, alive: true });
    expect(JSON.stringify(described)).not.toContain('secret token');
  });
});
