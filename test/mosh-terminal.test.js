import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

import { MoshTerminals, RETRY_AFTER_MS, createContactWatch, findMoshClient } from '../server/hub/mosh-terminal.js';
import { relayNodeUpgrade } from '../server/hub/proxy.js';

const KEY = 'AbCdEfGhIjKlMnOpQrStUv';

describe('finding mosh-client', () => {
  it('does not offer a Windows client, finds one elsewhere, and says why not', () => {
    expect(findMoshClient({ platform: 'win32', env: {}, exists: () => true })).toEqual({ available: false, path: null, reason: 'client_platform' });
    expect(findMoshClient({ platform: 'darwin', env: { PATH: '/x' }, exists: (p) => p === '/opt/homebrew/bin/mosh-client' }))
      .toEqual({ available: true, path: '/opt/homebrew/bin/mosh-client', reason: null });
    expect(findMoshClient({ platform: 'linux', env: { PATH: '' }, exists: () => false })).toMatchObject({ available: false, reason: 'mosh_client_not_found' });
  });
});

describe('telling the remote screen from mosh\'s own notices', () => {
  it('ignores the first row, however mosh redraws it, and sees text further down', () => {
    const watch = createContactWatch();
    // What mosh-client printed with no server: setup, then its notice on the top row, then a counter redraw.
    expect(watch('\x1b[?1049h\x1b[22;0;0t\x1b[?1h\x1b=\x1b[H\x1b[2J')).toBe(false);
    expect(watch('\x1b[H\x1b[7mmosh: Nothing received from server on UDP port 60999. [To quit: Ctrl-^ .]\x1b[K\x1b[0m')).toBe(false);
    expect(watch('\x1b[1;2H6\x1b[1;10Hwh\x1b[1;14Hou')).toBe(false);
    expect(watch('\x1b]0;[mosh]\x07  \x1b[2;1H \x1b[3;1H')).toBe(false);
    // tmux's status line arriving on the last row.
    expect(watch('\x1b[24;1H[exp] 0:cat*')).toBe(true);
  });

  it('follows the cursor through relative moves and newlines, and sequences split across chunks', () => {
    expect(createContactWatch()('\x1b[Hx\r\ny')).toBe(true);
    expect(createContactWatch()('\x1b[5;1H\x1b[4Az')).toBe(false);
    const split = createContactWatch();
    expect(split('\x1b[1;1Hok\x1b[1')).toBe(false);
    expect(split('0;1Hrow ten')).toBe(true);
  });
});

/**
 * A mosh-client stand-in: what it prints and how it ends are up to the test. A kill
 * makes it exit a moment later, unless it is told to ignore the first few.
 */
function fakeTerm({ ignoreKills = 0 } = {}) {
  const listeners = { data: [], exit: [] };
  return {
    listeners,
    writes: [],
    sizes: [],
    signals: [],
    killed: false,
    onData(fn) { listeners.data.push(fn); return { dispose() {} }; },
    onExit(fn) { listeners.exit.push(fn); return { dispose() {} }; },
    write(data) { this.writes.push(data); },
    resize(cols, rows) { this.sizes.push([cols, rows]); },
    kill(signal = 'SIGHUP') {
      this.killed = true;
      this.signals.push(signal);
      if (this.signals.length > ignoreKills && !this.gone) setTimeout(() => this.exit({ exitCode: 0, signal: 1 }), 5);
    },
    emit(data) { for (const fn of listeners.data) fn(data); },
    exit(info) { if (this.gone) return; this.gone = true; for (const fn of listeners.exit) fn(info); },
  };
}

describe('MoshTerminals', () => {
  let warn;
  const cleanups = [];
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => {
    warn.mockRestore();
    for (const clean of cleanups.splice(0)) clean();
  });

  /**
   * A hub with one node-mode server whose terminal transport is mosh. `screen` is what
   * the fake mosh-client prints right after it starts.
   */
  async function hub({ screen = '\x1b[24;1H[exp] 0:bash*', proxied = false, post = null, remove = null, state = () => ({ state: 'active' }),
    transport = 'mosh', client = { available: true, path: '/usr/bin/mosh-client' }, sessionWatchMs = 60_000, ignoreKills = 0,
    host = '192.0.2.10', lookup = vi.fn(async () => ({ address: '192.0.2.10', family: 4 })), lookupTimeoutMs = 50 } = {}) {
    const terms = [];
    const requests = [];
    const adopted = new Set();
    const link = {
      serverId: 'box',
      generation: 0,
      adopt: vi.fn((owned) => { adopted.add(owned); return () => adopted.delete(owned); }),
      /** What NodeLink.reset does to what it adopted. */
      reset() { link.generation += 1; for (const owned of [...adopted]) owned.end('test-reset'); adopted.clear(); },
      adopted,
      ensure: vi.fn(async () => {}),
      connection: { resolveTarget: vi.fn(async () => ({ host, port: 22, proxied })) },
      requestJson: vi.fn(async (method, path, body) => {
        requests.push({ method, path, body });
        if (method === 'POST') {
          if (post) return post(body);
          return { id: body.id, port: 60001, key: KEY, paneId: body.paneId };
        }
        if (method === 'GET') return state();
        if (remove) return remove();
        return { stopped: true, clean: true };
      }),
      proxyUpgrade: vi.fn(async (req, socket) => { socket.end('HTTP/1.1 418 Relayed\r\nConnection: close\r\n\r\n'); }),
    };
    const registry = { get: () => ({ id: 'box', transport: { terminal: transport } }), has: () => true };
    const links = { link: () => link, mode: async () => 'node' };
    const wss = new WebSocketServer({ noServer: true });
    const spawnPty = vi.fn((file, args, options) => {
      const term = fakeTerm({ ignoreKills });
      term.spawned = { file, args, options };
      terms.push(term);
      if (screen) setTimeout(() => term.emit(screen), 5);
      return term;
    });
    const mosh = new MoshTerminals({ registry, links, wss, client, spawnPty, contactTimeoutMs: 150, sessionWatchMs, localExitWaitMs: 60,
      lookup, lookupTimeoutMs });
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => {
      relayNodeUpgrade(req, socket, head, { registry, links, authorize: () => true, mosh });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => { for (const c of wss.clients) c.terminate(); server.close(); });
    return { mosh, link, terms, requests, spawnPty, port: server.address().port };
  }

  function connect(port, path = '/n/box/ws/terminal/%251?cols=100&rows=30') {
    return new Promise((resolve) => {
      const frames = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      ws.on('message', (data) => frames.push(JSON.parse(String(data))));
      ws.on('open', () => resolve({ ws, frames, status: 101 }));
      ws.on('unexpected-response', (_req, res) => { res.resume(); resolve({ status: res.statusCode, frames }); });
      ws.on('error', () => resolve({ status: 'error', frames }));
      cleanups.push(() => ws.terminate());
    });
  }

  it.each(['192.0.2.10', '2001:db8::10'])('passes the literal IP %s through without a DNS request', async (host) => {
    const lookup = vi.fn();
    const fixture = await hub({ host, lookup });
    const result = await connect(fixture.port);
    expect(result.status).toBe(101);
    expect(lookup).not.toHaveBeenCalled();
    expect(fixture.terms[0].spawned.args).toEqual([host, '60001']);
  });

  it('resolves a hostname before reserving a remote session and passes only its numeric address to the client', async () => {
    const lookup = vi.fn(async () => ({ address: '192.0.2.22', family: 4 }));
    const fixture = await hub({ host: 'node.example', lookup });
    expect((await connect(fixture.port)).status).toBe(101);
    expect(lookup).toHaveBeenCalledExactlyOnceWith('node.example');
    expect(fixture.requests[0].method).toBe('POST');
    expect(fixture.terms[0].spawned.args).toEqual(['192.0.2.22', '60001']);
  });

  it('bounds a DNS request that never settles and relays without reserving or spawning', async () => {
    const fixture = await hub({ host: 'node.example', lookup: () => new Promise(() => {}), lookupTimeoutMs: 20 });
    expect((await connect(fixture.port)).status).toBe(418);
    expect(fixture.requests).toEqual([]);
    expect(fixture.terms).toEqual([]);
    expect(fixture.mosh.status('box')).toMatchObject({ status: 'down', reason: 'dns_timeout' });
    expect(fixture.link.adopted.size).toBe(0);
  });

  it.each([() => Promise.reject(new Error('private DNS diagnostic')), () => Promise.resolve({ address: 'not-an-ip' }), () => Promise.resolve(null)])(
    'classifies failed or invalid DNS results without exposing the resolver error', async (lookup) => {
      const fixture = await hub({ host: 'node.example', lookup });
      expect((await connect(fixture.port)).status).toBe(418);
      expect(fixture.requests).toEqual([]);
      expect(fixture.terms).toEqual([]);
      expect(fixture.mosh.status('box')).toMatchObject({ reason: 'dns_failed' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private DNS diagnostic');
    },
  );

  it('abandons DNS on a link reset, ignoring a late address without reserving or spawning', async () => {
    let release;
    const lookup = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const fixture = await hub({ host: 'node.example', lookup, lookupTimeoutMs: 1000 });
    const pending = connect(fixture.port);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    fixture.link.reset();
    expect((await pending).status).toBe(503);
    release({ address: '192.0.2.22', family: 4 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fixture.requests).toEqual([]);
    expect(fixture.terms).toEqual([]);
    expect(fixture.link.proxyUpgrade).not.toHaveBeenCalled();
  });

  it('rechecks the link generation after a hostname resolves', async () => {
    let release;
    const lookup = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const fixture = await hub({ host: 'node.example', lookup, lookupTimeoutMs: 1000 });
    const pending = connect(fixture.port);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    fixture.link.generation += 1;
    release({ address: '192.0.2.22', family: 4 });
    expect((await pending).status).toBe(503);
    expect(fixture.requests).toEqual([]);
    expect(fixture.terms).toEqual([]);
  });

  it('stops waiting for DNS when the browser leaves and ignores the late result', async () => {
    let release;
    const lookup = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const fixture = await hub({ host: 'node.example', lookup, lookupTimeoutMs: 1000 });
    const ws = new WebSocket(`ws://127.0.0.1:${fixture.port}/n/box/ws/terminal/%251`);
    ws.on('error', () => {});
    cleanups.push(() => ws.terminate());
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    ws.terminate();
    await vi.waitFor(() => expect(fixture.mosh._opening.size).toBe(0));
    release({ address: '192.0.2.22', family: 4 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fixture.requests).toEqual([]);
    expect(fixture.terms).toEqual([]);
    expect(fixture.link.proxyUpgrade).not.toHaveBeenCalled();
  });

  it('bridges the socket to a mosh-client it started with the node\'s port and key, which the browser never sees', async () => {
    const { link, terms, requests, port } = await hub();
    const { ws, frames, status } = await connect(port);
    expect(status).toBe(101);
    const [term] = terms;
    expect(term.spawned.file).toBe('/usr/bin/mosh-client');
    expect(term.spawned.args).toEqual(['192.0.2.10', '60001']);
    expect(term.spawned.options).toMatchObject({ cols: 100, rows: 30 });
    expect(term.spawned.options.env.MOSH_KEY).toBe(KEY);
    // The hub names the session, so it can end it even without an answer.
    const sessionId = requests[0].body.id;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(requests[0]).toEqual({ method: 'POST', path: '/api/mosh/sessions', body: { id: sessionId, paneId: '%1', nozoom: false } });
    // The terminal belongs to the link now: a reset would end it.
    expect(link.adopted.size).toBe(1);

    await vi.waitFor(() => expect(frames.map((f) => f.type)).toEqual(['ready', 'output']));
    expect(frames[0]).toMatchObject({ provider: 'mosh', persistence: 'tmux' });
    // What mosh drew before the socket was taken over is not lost.
    expect(frames[1].data).toContain('[exp] 0:bash*');

    term.emit('\x1b[2;1Hls');
    ws.send(JSON.stringify({ type: 'input', data: 'ls\r' }));
    for (const [cols, rows] of [[90, 25], [120, 40], [110, 33]]) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    await vi.waitFor(() => expect(term.writes).toEqual(['ls\r']));
    // A burst of sizes reaches mosh as its last one.
    await vi.waitFor(() => expect(term.sizes).toEqual([[110, 33]]));
    await vi.waitFor(() => expect(frames.at(-1).data).toContain('ls'));

    ws.close();
    await vi.waitFor(() => expect(term.killed).toBe(true));
    await vi.waitFor(() => expect(requests.at(-1)).toMatchObject({ method: 'DELETE', path: `/api/mosh/sessions/${sessionId}` }));
    expect(link.proxyUpgrade).not.toHaveBeenCalled();
    expect(link.adopted.size).toBe(0);
    expect(JSON.stringify(frames)).not.toContain(KEY);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
  });

  it('relays the socket to the node when mosh shows nothing, ends that session first, and leaves the server on SSH for a while', async () => {
    const { mosh, link, terms, requests, port } = await hub({ screen: '\x1b[H\x1b[7mmosh: Nothing received from server on UDP port 60001.' });
    const { status } = await connect(port);
    expect(status).toBe(418);
    expect(terms[0].killed).toBe(true);
    expect(requests.map((r) => r.method)).toEqual(['POST', 'DELETE']);
    expect(link.proxyUpgrade).toHaveBeenCalledOnce();
    expect(mosh.wants('box')).toBe(false);
    expect(mosh.status('box')).toEqual({ status: 'down', reason: 'no_contact' });
    const line = JSON.parse(warn.mock.calls.find(([tag]) => tag === '[mosh] terminal')[1]);
    expect(line).toMatchObject({ serverId: 'box', status: 'down', reason: 'no_contact' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('node.example');

    // The next socket goes straight to the node.
    expect((await connect(port)).status).toBe(418);
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('tries again after a while', async () => {
    const { mosh } = await hub();
    let clock = 0;
    mosh._now = () => clock;
    mosh._fail('box', 'no_contact');
    expect(mosh.wants('box')).toBe(false);
    clock += RETRY_AFTER_MS;
    expect(mosh.wants('box')).toBe(true);
  });

  it('does not try a host behind a jump host, nor a node without mosh-server', async () => {
    const jumped = await hub({ proxied: true });
    expect((await connect(jumped.port)).status).toBe(418);
    expect(jumped.requests).toEqual([]);
    expect(jumped.mosh.status('box')).toMatchObject({ reason: 'proxied' });

    // Refused before the node reserved anything: nothing to end there, straight to the node.
    const missing = await hub({ post: () => { throw Object.assign(new Error('nope'), { code: 'UNSUPPORTED' }); } });
    expect((await connect(missing.port)).status).toBe(418);
    expect(missing.terms).toEqual([]);
    expect(missing.requests.map((r) => r.method)).toEqual(['POST']);
    expect(missing.mosh.status('box')).toMatchObject({ reason: 'unsupported' });
  });

  it('asks the node to end a session whose answer never came, by the id it chose, before relaying', async () => {
    const lost = await hub({ post: () => { throw Object.assign(new Error('timeout'), { code: 'SSH_TIMEOUT' }); } });
    expect((await connect(lost.port)).status).toBe(418);
    const [post, del] = lost.requests;
    expect(del).toEqual({ method: 'DELETE', path: `/api/mosh/sessions/${post.body.id}`, body: undefined });
    expect(lost.link.proxyUpgrade).toHaveBeenCalledOnce();
  });

  it('insists when its own mosh-client ignores the first request, and relays only once it has really exited', async () => {
    const stubborn = await hub({ screen: '\x1b[H\x1b[7mmosh: Nothing received', ignoreKills: 1 });
    expect((await connect(stubborn.port)).status).toBe(418);
    expect(stubborn.terms[0].signals).toEqual(['SIGHUP', process.platform === 'win32' ? 'SIGHUP' : 'SIGKILL']);
    expect(stubborn.link.proxyUpgrade).toHaveBeenCalledOnce();
  });

  it('attaches nothing else while its own mosh-client has not been seen to exit', async () => {
    const stuck = await hub({ screen: '\x1b[H\x1b[7mmosh: Nothing received', ignoreKills: Infinity });
    expect((await connect(stuck.port)).status).toBe(503);
    expect(stuck.link.proxyUpgrade).not.toHaveBeenCalled();
    expect(warn.mock.calls.some(([tag, line]) => tag === '[mosh] terminal' && line.includes('local_client_unconfirmed'))).toBe(true);
  });

  it('attaches nothing else while the node cannot confirm its mosh session is gone', async () => {
    for (const remove of [() => ({ stopped: true, clean: false }), () => { throw Object.assign(new Error('down'), { code: 'NODE_NOT_RUNNING' }); }]) {
      const unsure = await hub({ screen: '\x1b[H\x1b[7mmosh: Nothing received', remove });
      expect((await connect(unsure.port)).status).toBe(503);
      expect(unsure.link.proxyUpgrade).not.toHaveBeenCalled();
      expect(unsure.terms[0].killed).toBe(true);
      expect(warn.mock.calls.some(([tag, line]) => tag === '[mosh] terminal' && line.includes('cleanup_unconfirmed'))).toBe(true);
    }
  });

  it('ends an attempt a link reset overtook, and does not fall back on the old pairing', async () => {
    const { link, terms, requests, port } = await hub({ screen: null });
    const pending = connect(port);
    await vi.waitFor(() => expect(terms).toHaveLength(1));
    link.reset();
    expect((await pending).status).toBe(503);
    expect(terms[0].killed).toBe(true);
    expect(requests.map((r) => r.method)).toEqual(['POST', 'DELETE']);
    expect(link.proxyUpgrade).not.toHaveBeenCalled();
  });

  it('ends a bridged terminal when the link resets, and the node\'s session with it', async () => {
    const { link, terms, requests, port } = await hub();
    const { ws, frames } = await connect(port);
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    const closed = new Promise((resolve) => ws.once('close', resolve));
    link.reset();
    expect(await closed).toBe(1011);
    expect(terms[0].killed).toBe(true);
    await vi.waitFor(() => expect(requests.at(-1).method).toBe('DELETE'));
  });

  it('ends the client and the session when the browser\'s handshake is refused after mosh connected', async () => {
    const { link, terms, requests, port } = await hub();
    const socket = (await import('node:net')).connect({ host: '127.0.0.1', port });
    socket.on('error', () => {});
    // A version ws does not speak: it answers 400 and never hands over a socket.
    socket.write('GET /n/box/ws/terminal/%251 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
      + 'Sec-WebSocket-Version: 99\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    const answer = await new Promise((resolve) => socket.once('data', (data) => resolve(String(data))));
    expect(answer).toMatch(/^HTTP\/1\.1 400/);
    await vi.waitFor(() => expect(terms[0].killed).toBe(true));
    await vi.waitFor(() => expect(requests.map((r) => r.method)).toEqual(['POST', 'DELETE']));
    expect(link.adopted.size).toBe(0);
    socket.destroy();
  });

  it('ends the session that a late answer created for a browser already gone', async () => {
    let answer;
    const { terms, requests, port } = await hub({ post: (body) => new Promise((resolve) => { answer = () => resolve({ id: body.id, port: 60001, key: KEY }); }) });
    const socket = (await import('node:net')).connect({ host: '127.0.0.1', port });
    socket.on('error', () => {});
    socket.write('GET /n/box/ws/terminal/%251 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
      + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    socket.destroy();
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    answer();
    await vi.waitFor(() => expect(requests.map((r) => r.method)).toEqual(['POST', 'DELETE']));
    expect(terms).toEqual([]);
  });

  it('closes a terminal whose session the node says is over, even if mosh never told its client', async () => {
    let state = { state: 'active' };
    const { terms, requests, port } = await hub({ state: () => state, sessionWatchMs: 40 });
    const { ws, frames } = await connect(port);
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    await new Promise((resolve) => { setTimeout(resolve, 120); });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    // A failed question decides nothing either.
    state = null;
    await new Promise((resolve) => { setTimeout(resolve, 120); });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    const closed = new Promise((resolve) => ws.once('close', resolve));
    state = { state: 'ended', clean: true };
    expect(await closed).toBe(1000);
    expect(frames.at(-1)).toMatchObject({ type: 'exit', reason: 'mosh_session_ended' });
    expect(terms[0].killed).toBe(true);
    await vi.waitFor(() => expect(requests.at(-1).method).toBe('DELETE'));
  });

  it('on shutdown ends attempts and bridged terminals, and waits for their sessions to end', async () => {
    const { mosh, terms, requests, port } = await hub();
    const { frames } = await connect(port);
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    expect(mosh.busy()).toBe(true);
    expect(await mosh.closeAll()).toBe(true);
    expect(terms[0].killed).toBe(true);
    expect(requests.at(-1).method).toBe('DELETE');
    expect(mosh.busy()).toBe(false);
  });

  it('is not used for other servers, the status socket, or without a client here', async () => {
    const other = await hub({ transport: 'ssh' });
    expect((await connect(other.port)).status).toBe(418);
    expect(other.spawnPty).not.toHaveBeenCalled();
    expect(other.mosh.status('box')).toBeNull();

    const status = await hub();
    expect((await connect(status.port, '/n/box/ws/status')).status).toBe(418);
    expect(status.spawnPty).not.toHaveBeenCalled();

    const noClient = await hub({ client: { available: false, path: null, reason: 'mosh_client_not_found' } });
    expect((await connect(noClient.port)).status).toBe(418);
    expect(noClient.mosh.status('box')).toEqual({ status: 'down', reason: 'mosh_client_not_found' });
  });

  it('ends the session for a browser that left while mosh was coming up, and opens nothing', async () => {
    const { link, terms, requests, port } = await hub({ screen: null });
    const socket = (await import('node:net')).connect({ host: '127.0.0.1', port });
    socket.on('error', () => {});
    socket.write('GET /n/box/ws/terminal/%251 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
      + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    await vi.waitFor(() => expect(terms).toHaveLength(1));
    socket.destroy();
    await vi.waitFor(() => expect(terms[0].killed).toBe(true));
    await vi.waitFor(() => expect(requests.map((r) => r.method)).toEqual(['POST', 'DELETE']));
    expect(link.proxyUpgrade).not.toHaveBeenCalled();
  });

  it('closes for good when the tmux client leaves cleanly, and for a retry otherwise', async () => {
    const { terms, port } = await hub();
    const first = await connect(port);
    await vi.waitFor(() => expect(first.frames.length).toBeGreaterThan(0));
    const closed = new Promise((resolve) => first.ws.once('close', resolve));
    terms[0].exit({ exitCode: 0 });
    expect(await closed).toBe(1000);
    expect(first.frames.at(-1)).toMatchObject({ type: 'exit', code: 0, reason: 'mosh_client_exit' });

    const second = await connect(port);
    await vi.waitFor(() => expect(second.frames.length).toBeGreaterThan(0));
    const closedAgain = new Promise((resolve) => second.ws.once('close', resolve));
    terms[1].exit({ exitCode: 1 });
    expect(await closedAgain).toBe(1011);
  });
});
