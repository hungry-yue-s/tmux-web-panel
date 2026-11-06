import { describe, it, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import { BLOCKS } from '../helpers/blocks.js';

let dom;
afterEach(() => dom?.window.close());

/** The blocks' request client over an Api whose answers are held until let go. */
function setup() {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'https://panel.test/', runScripts: 'outside-only' });
  const win = dom.window;
  const pending = [];
  const hold = (entry) => new Promise((resolve, reject) => { pending.push({ ...entry, resolve, reject }); });
  win.Api = {
    activeServerId: () => 'local',
    nodeUrl: (serverId, path) => (serverId === 'local' ? '' : '/n/' + serverId) + path,
    get: vi.fn((url) => hold({ url })),
    request: vi.fn((method, url) => hold({ method, url })),
  };
  win.eval(BLOCKS);
  const settled = () => new Promise((resolve) => { setTimeout(resolve, 0); });
  return { ui: win.Blocks.ui, Api: win.Api, pending, settled };
}

describe('reads asked for again while one is under way', () => {
  it('go out once, and every caller gets the answer', async () => {
    const { ui, Api, pending } = setup();
    const first = ui.client().get('/api/git/status', { path: '/repo' });
    const second = ui.client('local').get('/api/git/status', { path: '/repo' });
    expect(Api.get).toHaveBeenCalledOnce();
    expect(Api.get).toHaveBeenCalledWith('/api/git/status?path=%2Frepo');
    pending[0].resolve({ branch: 'main' });
    await expect(first).resolves.toEqual({ branch: 'main' });
    await expect(second).resolves.toEqual({ branch: 'main' });
  });

  it('go out again once the first has answered, or failed', async () => {
    const { ui, Api, pending, settled } = setup();
    ui.client().get('/api/git/status', { path: '/repo' });
    pending[0].resolve({});
    await settled();
    ui.client().get('/api/git/status', { path: '/repo' }).catch(() => {});
    expect(Api.get).toHaveBeenCalledTimes(2);
    pending[1].reject(new Error('Network request failed'));
    await settled();
    ui.client().get('/api/git/status', { path: '/repo' });
    expect(Api.get).toHaveBeenCalledTimes(3);
  });

  it('stay apart when they differ, by what they ask or which server they ask', () => {
    const { ui, Api } = setup();
    ui.client().get('/api/git/status', { path: '/repo' });
    ui.client().get('/api/git/status', { path: '/other' });
    ui.client('remote').get('/api/git/status', { path: '/repo' });
    expect(Api.get.mock.calls.map(([url]) => url)).toEqual([
      '/api/git/status?path=%2Frepo', '/api/git/status?path=%2Fother', '/n/remote/api/git/status?path=%2Frepo',
    ]);
  });

  it('never hand a read from before a write to one asked for after it', async () => {
    const { ui, Api, pending, settled } = setup();
    const before = ui.client().get('/api/git/status', { path: '/repo' });
    const write = ui.client().send('POST', '/api/git/stage', { path: '/repo' });
    // Still writing: a read now may as well join the one out.
    ui.client().get('/api/git/status', { path: '/repo' });
    expect(Api.get).toHaveBeenCalledOnce();

    pending[1].resolve({});
    await write;
    ui.client().get('/api/git/status', { path: '/repo' });
    expect(Api.get).toHaveBeenCalledTimes(2);
    // A write on another server changes nothing here.
    ui.client('remote').send('POST', '/api/git/stage', {});
    ui.client().get('/api/git/status', { path: '/repo' });
    expect(Api.get).toHaveBeenCalledTimes(2);

    pending[0].resolve({ stale: true });
    await expect(before).resolves.toEqual({ stale: true });
    await settled();
  });

  it('do not merge writes', () => {
    const { ui, Api } = setup();
    ui.client().send('POST', '/api/git/stage', { files: ['a'] });
    ui.client().send('POST', '/api/git/stage', { files: ['a'] });
    expect(Api.request).toHaveBeenCalledTimes(2);
  });
});
