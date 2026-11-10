// The whole panel profile, started from real inputs: AUTH, a temporary config
// directory and home, and a private tmux server. Nothing here touches the
// user's tmux server, pairing file or panel state.

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import YAML from 'yaml';
import { createApp } from '../kernel/app.js';
import { IS_WINDOWS, MSYS_ROOT, TMUX_BIN, toNativePath } from '../lib/msys.js';
import { localTmux } from '../lib/tmux.js';

const SOCKET = `anymux-next-panel-${process.pid}`;
const haveTmux = IS_WINDOWS ? existsSync(TMUX_BIN) : true;

let app;
let base;
let dir;

async function json(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // Not JSON.
  }
  return { status: response.status, data };
}

function socketStatus(path) {
  return new Promise((resolve) => {
    const ws = new WebSocket(base.replace('http', 'ws') + path);
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('error', () => resolve('error'));
  });
}

describe.skipIf(!haveTmux)('the panel profile', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anymux-panel-'));
    const patch = join(dir, 'patch.yml');
    await writeFile(patch, YAML.stringify([
      { id: 'launch', config: { argv: [], env: { AUTH: 'admin:correct horse', PORT: '0', HOST: '127.0.0.1', ANYMUX_CONFIG_DIR: join(dir, 'config') } } },
      { id: 'node', config: { home: join(dir, 'home') } },
      { id: 'tmux', config: { socket: SOCKET } },
      { id: 'auth', config: { trustLocal: false } },
      { id: 'logger', config: { level: 'warn' } },
      // They read ~/.claude, ~/.codex and the CC Switch database, and may start a model relay.
      { id: 'agent-usage', disabled: true },
      { id: 'agent-hub', disabled: true },
      { id: 'enterprise-ai', disabled: true },
    ]));
    app = await createApp({ patches: [patch], home: join(dir, 'anymux-home') });
    base = `http://127.0.0.1:${app.ctx.get('http').port}`;
    // A session on the private server only; every call carries -L.
    await localTmux.run(['-f', '/dev/null', 'new-session', '-d', '-s', 'alpha', '-x', '100', '-y', '30'], { timeout: 15000 });
  }, 60000);

  afterAll(async () => {
    const socketPath = (await localTmux.run(['display-message', '-p', '#{socket_path}']).catch(() => '')).trim();
    if (socketPath) {
      // Never end a server that is not the private one.
      expect(socketPath.endsWith(`/${SOCKET}`)).toBe(true);
      await localTmux.run(['kill-server']).catch(() => {});
      if (IS_WINDOWS) await rm(toNativePath(socketPath, MSYS_ROOT), { force: true });
    }
    await app?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 30000);

  it('loads every entry', () => {
    const states = Object.fromEntries(app.loader.status().map((entry) => [entry.id, entry.state]));
    expect(states).toMatchObject({
      http: 'active', auth: 'active', terminal: 'active', ui: 'active', 'agent-hub': 'off', 'enterprise-ai': 'off',
      // The hub, plugin by plugin.
      'server-registry': 'active', 'hub-links': 'active', 'server-health': 'active', 'hub-relay': 'active',
      servers: 'active', 'node-installer': 'active', 'basic-mode': 'active', 'mosh-hub': 'active', mosh: 'active',
      // Files and what acts on them.
      files: 'active', upload: 'active', git: 'active', sqlite: 'active', notebook: 'active', open: 'active',
      notifications: 'active', 'agent-events': 'active', status: 'active', keypad: 'active',
      'managed-resources': 'active', 'session-protection': 'active',
    });
    expect(Object.entries(states).filter(([, state]) => !['active', 'off'].includes(state))).toEqual([]);
  });

  it('serves the pages publicly and keeps the API behind a login', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/src="\/js\/ms-app\.js\?h=[0-9a-f]{12}"/);
    // No relay set up here: the login page still gets a config, an empty one.
    const relay = await fetch(`${base}/js/relay-config.js`);
    expect(relay.status).toBe(200);
    expect(await relay.text()).toContain('window.PANEL_RELAY_PAGE');
    expect((await json('/api/workspace')).status).toBe(401);
    expect((await json('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } })).status).toBe(401);
  });

  it('logs in and reads the private server through the workspace API', async () => {
    const login = await json('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'correct horse' } });
    expect(login.status).toBe(200);
    const token = login.data.data.token;
    const workspace = await json('/api/workspace', { token });
    expect(workspace.status).toBe(200);
    const names = JSON.stringify(workspace.data).match(/"name":"alpha"/g);
    expect(names).not.toBeNull();
    expect((await json('/api/node/info', { token })).status).toBe(200);
    expect((await json('/api/auth/check', { token })).status).toBe(200);
    expect((await json('/api/auth/check')).status).toBe(401);
    // The legacy name-based tmux API is gone; the workspace API is the one.
    expect((await json('/api/status', { token })).status).toBe(404);
    expect((await json('/api/sessions', { token })).status).toBe(404);
  });

  it('reads a window layout and a pane through the workspace API, by id', async () => {
    const login = await json('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'correct horse' } });
    const token = login.data.data.token;
    const windowId = (await localTmux.run(['display-message', '-p', '-t', 'alpha', '#{window_id}'])).trim();
    const paneId = (await localTmux.run(['display-message', '-p', '-t', 'alpha', '#{pane_id}'])).trim();
    const layout = await json(`/api/workspace/windows/${encodeURIComponent(windowId)}/layout`, { token });
    expect(layout.status).toBe(200);
    expect(layout.data.data).toEqual({ width: 100, height: 30 });
    const capture = await json(`/api/workspace/panes/${encodeURIComponent(paneId)}/capture`, { token });
    expect(capture.status).toBe(200);
    expect(typeof capture.data.data.content).toBe('string');
    const bad = await json(`/api/workspace/windows/${encodeURIComponent(windowId)}/layout`, { method: 'POST', token, body: { layout: 'nope' } });
    expect(bad.status).toBe(400);
  });

  it('refuses sockets without a token and attaches a terminal with one', async () => {
    expect(await socketStatus('/ws/status')).toBe(401);
    const login = await json('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'correct horse' } });
    const token = login.data.data.token;
    expect(await socketStatus(`/ws/status?token=${token}`)).toBe('open');

    const paneId = (await localTmux.run(['display-message', '-p', '-t', 'alpha', '#{pane_id}'])).trim();
    const frames = await new Promise((resolve, reject) => {
      const seen = [];
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/terminal/${encodeURIComponent(paneId)}?cols=100&rows=30&token=${token}`);
      const timer = setTimeout(() => {
        ws.close();
        resolve(seen);
      }, 8000);
      ws.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        seen.push(message.type);
        if (message.type === 'output') {
          clearTimeout(timer);
          ws.close();
          resolve(seen);
        }
      });
      ws.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    expect(frames[0]).toBe('ready');
    expect(frames).toContain('output');
  }, 30000);

  it('undoes what a plugin registered when it is turned off', async () => {
    await app.loader.setDisabled('share', true);
    const login = await json('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'correct horse' } });
    expect((await json('/api/share', { token: login.data.data.token })).status).toBe(404);
    await app.loader.setDisabled('share', false);
    expect((await json('/api/share', { token: login.data.data.token })).status).not.toBe(404);
  });

  it('tells the page and a hub which plugins run, so neither calls an API that is not there', async () => {
    const login = await json('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'correct horse' } });
    const token = login.data.data.token;
    const pagePlugins = async () => {
      const html = await (await fetch(`${base}/`)).text();
      return JSON.parse(html.match(/window\.PANEL_PLUGINS = (\[[^\]]*\]);/)[1]);
    };
    expect(await pagePlugins()).toEqual(expect.arrayContaining(['ui', 'files', 'share']));
    expect((await json('/api/node/info', { token })).data.data.plugins).toEqual(expect.arrayContaining(['files', 'share']));
    await app.loader.setDisabled('share', true);
    try {
      expect(await pagePlugins()).not.toContain('share');
      expect((await json('/api/node/info', { token })).data.data.plugins).not.toContain('share');
    } finally {
      await app.loader.setDisabled('share', false);
    }
  });

  it('answers /n/local/ without the hub relay, which only reaches other servers', async () => {
    const login = await json('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'correct horse' } });
    const token = login.data.data.token;
    await app.loader.setDisabled('hub-relay', true);
    try {
      expect((await json('/n/local/api/node/info', { token })).status).toBe(200);
      expect(await socketStatus(`/n/local/ws/status?token=${token}`)).toBe('open');
      expect((await json('/n/some-server/api/node/info', { token })).status).toBe(404);
    } finally {
      await app.loader.setDisabled('hub-relay', false);
    }
    expect((await json('/n/some-server/api/node/info', { token })).status).not.toBe(200);
  });

  it('keeps the status socket and the servers API when optional plugins are off', async () => {
    const login = await json('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'correct horse' } });
    const token = login.data.data.token;
    await app.loader.setDisabled('notifications', true);
    await app.loader.setDisabled('basic-mode', true);
    await app.loader.setDisabled('mosh-hub', true);
    try {
      const states = Object.fromEntries(app.loader.status().map((entry) => [entry.id, entry.state]));
      expect(states).toMatchObject({ status: 'active', 'agent-events': 'active', servers: 'active', 'hub-relay': 'active' });
      expect(await socketStatus(`/ws/status?token=${token}`)).toBe('open');
      expect((await json('/api/servers', { token })).status).toBe(200);
      expect((await json('/api/notifications', { token })).status).toBe(404);
    } finally {
      await app.loader.setDisabled('mosh-hub', false);
      await app.loader.setDisabled('basic-mode', false);
      await app.loader.setDisabled('notifications', false);
    }
    expect((await json('/api/notifications', { token })).status).toBe(200);
  });
});
