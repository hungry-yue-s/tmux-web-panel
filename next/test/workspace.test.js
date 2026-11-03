import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Context, Service } from 'cordis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import TmuxService from '../plugins/tmux/index.js';
import { FIELD_SEP, parseInstance, parseTree } from '../plugins/tmux/format.js';
import { msysQuote, resolveMsysRoot, resolveTmuxBin, toNativePath, withNoGlob } from '../plugins/tmux/msys.js';
import TmuxWorkspace from '../plugins/workspace-tmux/index.js';
import * as workspaceFeature from '../plugins/workspace/index.js';
import HttpService from '../plugins/http/index.js';

const S = FIELD_SEP;

const SNAPSHOT = [
  `I${S}4242:1700000000`,
  `S${S}$1${S}main${S}2${S}1${S}1700000100`,
  `S${S}$2${S}odd${S}name${S}1${S}0${S}0`,
  `W${S}$1${S}@1${S}0${S}editor${S}1${S}120${S}40${S}0${S}1700000200`,
  `W${S}$1${S}@2${S}1${S}C:\\Users\\me\\bin\\claude.exe${S}0${S}120${S}40${S}1${S}1700000300`,
  `W${S}$2${S}@3${S}0${S}shell${S}1${S}80${S}24${S}0${S}0`,
  `P${S}@1${S}%1${S}0${S}0${S}60${S}40${S}1${S}vim${S}`,
  `P${S}@1${S}%2${S}61${S}0${S}59${S}40${S}0${S}bash${S}logs`,
  `P${S}@2${S}%3${S}0${S}0${S}120${S}40${S}1${S}C:\\Users\\me\\bin\\claude.exe${S}`,
  `P${S}@3${S}%4${S}0${S}0${S}80${S}24${S}1${S}fish${S}`,
  // A linked window's panes are listed again for the other session.
  `P${S}@1${S}%1${S}0${S}0${S}60${S}40${S}1${S}vim${S}`,
].join('\n');

describe('tmux formats', () => {
  it('parses a snapshot into sessions, windows and panes', () => {
    expect(parseInstance(SNAPSHOT)).toBe('4242:1700000000');
    const tree = parseTree(SNAPSHOT);
    expect(tree.map((session) => session.name)).toEqual(['main', `odd${S}name`]);
    const [main] = tree;
    expect(main.windowList.map((window) => window.name)).toEqual(['editor', 'claude']);
    expect(main.windowList[0].panes.map((pane) => pane.id)).toEqual(['%1', '%2']);
    expect(main.windowList[0].panes[1].label).toBe('logs');
    expect(main.windowList[1].panes[0].command).toBe('claude');
    expect(main.windowList[1].bell).toBe(true);
  });

  it('quotes for MSYS and keeps noglob', () => {
    expect(msysQuote(`{"V":2} it's`)).toBe(`'{"V":2} it'"'"'s'`);
    expect(withNoGlob('winsymlinks:nativestrict glob')).toBe('winsymlinks:nativestrict noglob');
    expect(withNoGlob('noglob')).toBe('noglob');
    expect(resolveTmuxBin({ env: { TMUX_BIN: '/x/tmux' }, platform: 'linux' })).toBe('/x/tmux');
    expect(resolveTmuxBin({ env: {}, platform: 'win32', exists: () => false })).toBe('tmux');
  });
});

class FakeTmux extends Service {
  constructor(ctx, config) {
    super(ctx, 'tmux');
    this.calls = 0;
    this.answer = config.answer;
  }
  async exec() {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return this.answer();
  }
}

async function mountWorkspace(answer) {
  const ctx = new Context();
  await ctx.plugin(FakeTmux, { answer });
  await ctx.plugin(TmuxWorkspace);
  return { ctx, tmux: ctx.get('tmux'), workspace: ctx.get('workspace') };
}

describe('workspace-tmux', () => {
  it('provides the workspace seam from one snapshot call and shares concurrent reads', async () => {
    const { tmux, workspace } = await mountWorkspace(() => SNAPSHOT);
    const [a, b] = await Promise.all([workspace.read(), workspace.read()]);
    expect(tmux.calls).toBe(1);
    expect(a).toBe(b);
    expect(a.provider).toBe('tmux');
    expect(a.instanceId).toBe('4242:1700000000');
    expect(a.complete).toBe(true);
    expect(a.sessions[0]).toMatchObject({ id: '$1', name: 'main', active: true, windowCount: 2 });
    expect(a.sessions[0].windows[0].panes[1]).toMatchObject({ id: '%2', name: 'logs', label: 'logs', command: 'bash' });
  });

  it('marks a read without a window\'s panes as incomplete', async () => {
    const withoutPanes = SNAPSHOT.split('\n').filter((line) => !line.startsWith(`P${S}@3`)).join('\n');
    const { workspace } = await mountWorkspace(() => withoutPanes);
    const result = await workspace.read();
    expect(result.complete).toBe(false);
    expect(result.sessions[1].windows[0].panesComplete).toBe(false);
  });

  it('treats a missing tmux server as an empty workspace, and other failures as errors', async () => {
    const noServer = Object.assign(new Error('exit 1'), { stderr: 'no server running on /tmp/tmux-1000/default' });
    const { workspace } = await mountWorkspace(() => { throw noServer; });
    expect(await workspace.read()).toEqual({ provider: 'tmux', instanceId: null, complete: true, sessions: [] });

    const other = Object.assign(new Error('exit 1'), { stderr: 'protocol version mismatch' });
    const { workspace: broken } = await mountWorkspace(() => { throw other; });
    await expect(broken.read()).rejects.toBe(other);
  });

  it('serves the tree at /api/workspace and answers 503 when it cannot be read', async () => {
    let fail = false;
    const { ctx } = await mountWorkspace(() => {
      if (fail) throw Object.assign(new Error('x'), { stderr: 'boom' });
      return SNAPSHOT;
    });
    const httpFiber = ctx.plugin(HttpService, { port: 0 });
    await httpFiber;
    await ctx.plugin(workspaceFeature);
    const base = `http://127.0.0.1:${ctx.get('http').port}`;
    const ok = await (await fetch(`${base}/api/workspace`)).json();
    expect(ok.sessions).toHaveLength(2);
    fail = true;
    const failed = await fetch(`${base}/api/workspace`);
    expect(failed.status).toBe(503);
    expect((await failed.json()).error.code).toBe('WORKSPACE_UNAVAILABLE');
    await httpFiber.dispose();
  });
});

// A real tmux on a private socket: never the user's default server.
const tmuxBin = resolveTmuxBin();
const haveTmux = tmuxBin === 'tmux' ? process.platform !== 'win32' : existsSync(tmuxBin);

describe.skipIf(!haveTmux)('workspace-tmux against a private tmux server', () => {
  const socket = `twp-next-test-${process.pid}`;
  let ctx;
  let tmux;

  beforeAll(async () => {
    ctx = new Context();
    await ctx.plugin(TmuxService, { socket, configFile: '/dev/null', timeout: 15000 });
    await ctx.plugin(TmuxWorkspace);
    tmux = ctx.get('tmux');
    await tmux.exec(['new-session', '-d', '-s', 'alpha', '-x', '80', '-y', '24']);
    await tmux.exec(['new-window', '-t', 'alpha', '-n', 'second window']);
  }, 30000);

  afterAll(async () => {
    if (!tmux) return;
    const socketPath = (await tmux.exec(['display-message', '-p', '#{socket_path}']).catch(() => '')).trim();
    await tmux.exec(['kill-server']).catch(() => {});
    // MSYS2's tmux leaves its socket file behind when the server exits.
    if (process.platform === 'win32' && socketPath.startsWith('/')) {
      await rm(toNativePath(socketPath, resolveMsysRoot({ tmuxBin })), { force: true });
    }
  });

  it('reads the sessions, windows and panes of that server', async () => {
    const result = await ctx.get('workspace').read();
    expect(result.instanceId).toMatch(/^\d+:\d+$/);
    expect(result.complete).toBe(true);
    expect(result.sessions).toHaveLength(1);
    const [alpha] = result.sessions;
    expect(alpha.name).toBe('alpha');
    expect(alpha.windows.map((window) => window.name)).toContain('second window');
    expect(alpha.windows.every((window) => window.panes.length === 1)).toBe(true);
    expect(alpha.windows[0].panes[0].id).toMatch(/^%\d+$/);
  });
});
