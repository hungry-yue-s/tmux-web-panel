import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import { ControlPool } from '../../lib/terminal/control-pool.js';

class Control extends EventEmitter {
  constructor() { super(); this.commands = []; this.child = { pid: 999 }; }
  async command(text, { onResult } = {}) {
    this.commands.push(text);
    if (text.includes('#{history_size}')) return Buffer.from('99:100|$1|@2|%3|900|0');
    if (text.includes('#{client_pid}')) { const bytes = Buffer.from('99:100|$1|441'); onResult?.(bytes); return bytes; }
    const snapshot = Buffer.from(JSON.stringify({ version: 1, instanceId: '99:100', windowId: '@2', paneId: '%3', cols: 80, rows: 24, dataBase64: Buffer.from('\x1bcSCREEN').toString('base64') }));
    onResult?.(snapshot);
    return snapshot;
  }
  async transaction(commands) { this.commands.push(...commands); return [Buffer.from('99:100|$1|@2|%3|900|0'), Buffer.from('H397\nH398\nH399'), Buffer.from('99:100|$1|@2|%3|900|0')]; }
  dispose() { this.disposed = true; }
}
function fixture() {
  const controls = [];
  const tmux = { run: async argv => {
    if (argv[0] === 'list-panes') return '99:100|$1|@2|%3|80|24|1|0|80|25\n';
    if (argv[0] === 'display-message') return '1';
    if (argv[0] === 'list-clients') return '';
    throw new Error('unexpected command');
  } };
  const pool = new ControlPool({ tmux, workspace: { resolvePane: async () => ({ paneId: '%3', sessionId: '$1', windowId: '@2' }) }, createControl: () => { const item = new Control(); controls.push(item); return item; } });
  const target = { instanceId: '99:100', sessionId: '$1', windowId: '@2', paneId: '%3' };
  return { pool, controls, target, tmux };
}

describe('shared pane streams', () => {
  it('subscribes two views through one control process, fences snapshots before live bytes, and only unsubscribes on close', async () => {
    const { pool, controls, target } = fixture();
    const a = [], b = [];
    const first = await pool.subscribe(target, frame => a.push(frame));
    const second = await pool.subscribe(target, frame => b.push(frame));
    expect(controls).toHaveLength(1);
    controls[0].emit('output', '%3', Buffer.from('中'));
    expect(a.at(-1)).toMatchObject({ type: 'output', encoding: 'base64' });
    expect(Buffer.from(a.at(-1).data, 'base64').toString()).toBe('中');
    expect(b[0].type).toBe('ready');
    expect(b[1]).toMatchObject({ type: 'snapshot', seq: 0 });
    first.close();
    expect(controls[0].commands.some(command => /kill-|detach-client/.test(command))).toBe(false);
    expect(controls[0].disposed).not.toBe(true);
    second.close();
    pool.dispose();
    expect(controls[0].disposed).toBe(true);
  });

  it('suspends hidden views, resnapshots on visibility, and denies input from a view that does not own the lease', async () => {
    const { pool, controls, target } = fixture();
    const frames = [];
    const first = await pool.subscribe(target, frame => frames.push(frame));
    const second = await pool.subscribe(target, () => {});
    expect(await first.input('not focused')).toBe(false);
    await first.visibility(false);
    const count = frames.length;
    controls[0].emit('output', '%3', Buffer.from('hidden'));
    expect(frames).toHaveLength(count);
    await first.visibility(true);
    expect(frames.at(-1).type).toBe('snapshot');
    expect(await first.input('a')).toBe(true);
    expect(controls[0].commands.at(-1)).toBe('send-keys -H -t %3 61');
    second.close(); first.close(); pool.dispose();
  });

  it('fails every view closed if a native resnapshot cannot be decoded instead of silently crossing a broken fence', async () => {
    const { pool, controls, target } = fixture();
    const frames = []; let ended = false;
    await pool.subscribe(target, frame => frames.push(frame), { end: () => { ended = true; } });
    controls[0].command = async (command, { onResult } = {}) => { onResult?.(Buffer.from('unsupported')); };
    await expect(pool.subscribe(target, () => {})).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(ended).toBe(true);
    expect(frames.at(-1)).toMatchObject({ type: 'error', code: 'UNSUPPORTED' });
    pool.dispose();
  });

  it('identifies owned clients by tmux peer pid rather than an MSYS wrapper native Windows pid', async () => {
    const { pool, target, tmux } = fixture();
    const run = tmux.run;
    tmux.run = async args => args[0] === 'list-clients' ? '$1|441\n' : run(args);
    const frames = [];
    const lease = await pool.subscribe(target, frame => frames.push(frame));
    expect(frames.find(frame => frame.type === 'ready').resizeAllowed).toBe(true);
    lease.close(); pool.dispose();
  });

  it('checks the actual control connection server lifetime when the server restarts between resolution and attach', async () => {
    const { pool, controls, target } = fixture();
    pool.createControl = () => {
      const control = new Control(); controls.push(control);
      const command = control.command.bind(control);
      control.command = async (text, options = {}) => {
        if (text.includes('#{client_pid}')) { const bytes = Buffer.from('100:200|$1|441'); options.onResult?.(bytes); return bytes; }
        return command(text, options);
      };
      return control;
    };
    await expect(pool.subscribe(target, () => {})).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' });
    expect(controls[0].disposed).toBe(true);
    expect(controls[0].commands.some(command => command.startsWith('capture-pane'))).toBe(false);
    pool.dispose();
  });

  it('preserves high-bit X10 mouse input bytes without converting them through UTF-8', async () => {
    const { pool, target, controls } = fixture();
    const lease = await pool.subscribe(target, () => {});
    await lease.input(Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0xff, 0x80]));
    expect(controls[0].commands.at(-1)).toBe('send-keys -H -t %3 1b 5b 4d 20 ff 80');
    lease.close(); pool.dispose();
  });

  it('rejects linked windows before opening a control lease', async () => {
    const { pool, controls, target, tmux } = fixture();
    const run = tmux.run;
    tmux.run = async args => args[0] === 'list-panes' ? '99:100|$1|@2|%3|80|24|1|1|80|25\n' : run(args);
    await expect(pool.subscribe(target, () => {})).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(controls).toHaveLength(0);
    pool.dispose();
  });

  it('reads a bounded plain-text history page through the verified control connection', async () => {
    const { pool, target, controls } = fixture();
    expect(await pool.history(target, { before: 400, limit: 3 })).toEqual({
      ...target, lines: ['H397', 'H398', 'H399'], total: 900, before: 400, nextBefore: 397,
    });
    expect(controls[0].commands).toContain('capture-pane -p -t %3 -S -503 -E -501');
    await expect(pool.history(target, { limit: 501 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    pool.dispose();
  });

  it('rejects a stale instance before opening a client or sending input', async () => {
    const { pool, controls, target } = fixture();
    await expect(pool.subscribe({ ...target, instanceId: '88:99' }, () => {})).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' });
    expect(controls).toHaveLength(0);
    pool.dispose();
  });

  it('hex encodes input, does not replay it, and gives the latest visible subscriber sole resize ownership', async () => {
    const { pool, controls, target } = fixture();
    const first = await pool.subscribe(target, () => {});
    const second = await pool.subscribe(target, () => {});
    await second.input('a\n;kill-server');
    expect(controls[0].commands.at(-1)).toBe('send-keys -H -t %3 61 0a 3b 6b 69 6c 6c 2d 73 65 72 76 65 72');
    const before = controls[0].commands.length;
    expect(await first.resize(100, 30)).toBe(false);
    expect(controls[0].commands).toHaveLength(before);
    expect(await second.resize(100, 30)).toBe(true);
    expect(controls[0].commands).toContain('resize-window -t @2 -x 100 -y 31');
    expect(controls[0].commands.at(-1)).toBe('capture-pane -Q -p -t %3');
    const afterResize = controls[0].commands.length;
    await second.resize(100, 30);
    expect(controls[0].commands).toHaveLength(afterResize); // unattainable grids cannot clear/redraw forever
    pool.dispose();
  });
});
