import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

await import('../public/js/router.js');
const Router = window.Router;

const DEFAULT = { name: 'terminal', params: { serverId: 'local' } };

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function until(predicate, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return false;
}

async function setHash(hash) {
  dom.window.location.hash = hash;
  await tick();
}

describe('Router.parse / Router.serialize round trip', () => {
  const table = [
    ['#/terminal/local', { name: 'terminal', params: { serverId: 'local' } }],
    [
      '#/terminal/prod/%243/%405/%2512',
      { name: 'terminal', params: { serverId: 'prod', sessionId: '$3', windowId: '@5', paneId: '%12' } },
    ],
    ['#/servers', { name: 'servers', params: {} }],
    ['#/servers/new', { name: 'servers', params: { intent: 'new' } }],
    ['#/servers/prod/overview', { name: 'server', params: { serverId: 'prod', section: 'overview' } }],
    ['#/servers/prod/performance', { name: 'server', params: { serverId: 'prod', section: 'performance' } }],
    ['#/servers/prod/connection', { name: 'server', params: { serverId: 'prod', section: 'connection' } }],
    ['#/settings', { name: 'settings', params: {} }],
  ];

  table.forEach(([hash, route]) => {
    it(`parses ${hash}`, () => {
      expect(Router.parse(hash)).toEqual(route);
    });
    it(`serializes ${hash}`, () => {
      expect(Router.serialize(route)).toBe(hash);
    });
  });

  it('accepts a hash without the leading #', () => {
    expect(Router.parse('/servers')).toEqual({ name: 'servers', params: {} });
    expect(Router.parse('/terminal/prod')).toEqual({ name: 'terminal', params: { serverId: 'prod' } });
  });

  it('round trips a tmux pane id containing %', () => {
    const route = {
      name: 'terminal',
      params: { serverId: 'prod', sessionId: '$3', windowId: '@5', paneId: '%12' },
    };
    const hash = Router.serialize(route);
    expect(hash).toBe('#/terminal/prod/%243/%405/%2512');
    expect(Router.parse(hash)).toEqual(route);
    expect(Router.serialize(Router.parse(hash))).toBe(hash);
  });

  it('encodes every param, ids with $ @ % included', () => {
    const hash = Router.serialize({ name: 'server', params: { serverId: 'a b/%25', section: 'connection' } });
    expect(hash).toBe('#/servers/a%20b%2F%2525/connection');
    expect(Router.parse(hash)).toEqual({ name: 'server', params: { serverId: 'a b/%25', section: 'connection' } });
  });
});

describe('Router.parse partial terminal targets', () => {
  it('parses serverId + sessionId only', () => {
    const route = Router.parse('#/terminal/prod/%243');
    expect(route).toEqual({ name: 'terminal', params: { serverId: 'prod', sessionId: '$3' } });
    expect(Object.keys(route.params)).toEqual(['serverId', 'sessionId']);
  });

  it('parses serverId + sessionId + windowId only', () => {
    const route = Router.parse('#/terminal/prod/%243/%405');
    expect(route).toEqual({ name: 'terminal', params: { serverId: 'prod', sessionId: '$3', windowId: '@5' } });
    expect(Object.keys(route.params)).toEqual(['serverId', 'sessionId', 'windowId']);
  });

  it('serializes partial targets without trailing separators', () => {
    expect(Router.serialize({ name: 'terminal', params: { serverId: 'prod', sessionId: '$3' } }))
      .toBe('#/terminal/prod/%243');
    expect(Router.serialize({ name: 'terminal', params: { serverId: 'prod', paneId: '%12' } }))
      .toBe('#/terminal/prod');
  });
});

describe('Router.parse aliases', () => {
  it('accepts the singular /server/:id/:section form', () => {
    expect(Router.parse('#/server/prod/overview')).toEqual({
      name: 'server',
      params: { serverId: 'prod', section: 'overview' },
    });
    expect(Router.parse('#/server/prod/performance')).toEqual({
      name: 'server',
      params: { serverId: 'prod', section: 'performance' },
    });
  });

  it('maps /server/:id/tmux to the terminal route', () => {
    expect(Router.parse('#/server/prod/tmux')).toEqual({ name: 'terminal', params: { serverId: 'prod' } });
  });

  it('defaults a missing section to overview', () => {
    expect(Router.parse('#/servers/prod')).toEqual({
      name: 'server',
      params: { serverId: 'prod', section: 'overview' },
    });
  });

  it('treats #/home, #/ and empty as the default route', () => {
    expect(Router.parse('#/home')).toEqual(DEFAULT);
    expect(Router.parse('#/')).toEqual(DEFAULT);
    expect(Router.parse('#')).toEqual(DEFAULT);
    expect(Router.parse('')).toEqual(DEFAULT);
  });

  it('never serializes an alias', () => {
    expect(Router.serialize(Router.parse('#/server/prod/overview'))).toBe('#/servers/prod/overview');
    expect(Router.serialize(Router.parse('#/server/prod/tmux'))).toBe('#/terminal/prod');
    expect(Router.serialize(Router.parse('#/home'))).toBe('#/terminal/local');
  });
});

describe('Router.parse fallbacks', () => {
  it('falls back on a malformed percent escape', () => {
    expect(Router.parse('#/terminal/prod/%zz')).toEqual(DEFAULT);
    expect(Router.parse('#/terminal/prod/%243/%405/%12')).toEqual(DEFAULT);
    expect(Router.parse('#/servers/%E0%A4%A/overview')).toEqual(DEFAULT);
  });

  it('falls back on unknown routes', () => {
    expect(Router.parse('#/nope')).toEqual(DEFAULT);
    expect(Router.parse('#/servers/prod/bogus')).toEqual(DEFAULT);
    expect(Router.parse('#/servers/prod/overview/extra')).toEqual(DEFAULT);
    expect(Router.parse('#/settings/extra')).toEqual(DEFAULT);
    expect(Router.parse('#/terminal')).toEqual(DEFAULT);
    expect(Router.parse('#/terminal/a/b/c/d/e')).toEqual(DEFAULT);
  });

  it('falls back when serializing an unknown route name', () => {
    expect(Router.serialize({ name: 'ghost', params: {} })).toBe('#/terminal/local');
    expect(Router.serialize(null)).toBe('#/terminal/local');
  });

  it('ignores a query string in the hash', () => {
    expect(Router.parse('#/servers?foo=1')).toEqual({ name: 'servers', params: {} });
  });
});

describe('Router.isSame', () => {
  it('compares name and params deeply', () => {
    expect(Router.isSame(DEFAULT, { name: 'terminal', params: { serverId: 'local' } })).toBe(true);
    expect(Router.isSame(DEFAULT, { name: 'terminal', params: { serverId: 'prod' } })).toBe(false);
    expect(Router.isSame(DEFAULT, { name: 'servers', params: {} })).toBe(false);
  });

  it('ignores undefined params', () => {
    expect(Router.isSame(
      { name: 'terminal', params: { serverId: 'local' } },
      { name: 'terminal', params: { serverId: 'local', paneId: undefined } },
    )).toBe(true);
  });

  it('is false when one side has extra params', () => {
    expect(Router.isSame(
      { name: 'terminal', params: { serverId: 'local' } },
      { name: 'terminal', params: { serverId: 'local', sessionId: '$1' } },
    )).toBe(false);
  });

  it('handles missing arguments', () => {
    expect(Router.isSame(null, null)).toBe(true);
    expect(Router.isSame(DEFAULT, null)).toBe(false);
  });
});

describe('Router.current', () => {
  it('reads location.hash', async () => {
    await setHash('#/servers/prod/performance');
    expect(Router.current()).toEqual({ name: 'server', params: { serverId: 'prod', section: 'performance' } });
  });
});

describe('Router lifecycle', () => {
  let calls;
  let unsubscribe;

  beforeEach(async () => {
    calls = [];
    await setHash('#/terminal/local');
    Router.start();
    unsubscribe = Router.subscribe((route, previous) => calls.push([route, previous]));
  });

  afterEach(() => {
    if (unsubscribe) unsubscribe();
    Router.stop();
  });

  it('notifies once on start', async () => {
    Router.stop();
    const seen = [];
    const off = Router.subscribe((route) => seen.push(route));
    Router.start();
    expect(seen).toEqual([DEFAULT]);
    off();
  });

  it('drives notification through hashchange only', async () => {
    Router.go({ name: 'servers', params: {} });
    expect(calls.length).toBe(0);
    await tick();
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toEqual({ name: 'servers', params: {} });
    expect(calls[0][1]).toEqual(DEFAULT);
  });

  it('does not notify when go() targets the current hash', async () => {
    Router.go({ name: 'servers', params: {} });
    await tick();
    calls.length = 0;
    Router.go({ name: 'servers', params: {} });
    await tick();
    expect(calls.length).toBe(0);
    expect(dom.window.location.hash).toBe('#/servers');
  });

  it('replaces the hash when opts.replace is set', async () => {
    Router.go({ name: 'settings', params: {} }, { replace: true });
    await tick();
    expect(dom.window.location.hash).toBe('#/settings');
    expect(calls[calls.length - 1][0]).toEqual({ name: 'settings', params: {} });
  });

  it('stops notifying after unsubscribe', async () => {
    unsubscribe();
    unsubscribe = null;
    Router.go({ name: 'settings', params: {} });
    await tick();
    expect(calls.length).toBe(0);
  });

  it('stops notifying after stop()', async () => {
    Router.stop();
    Router.go({ name: 'settings', params: {} });
    await tick();
    expect(calls.length).toBe(0);
  });

  it('does not double-register the hashchange listener when start() is called twice', async () => {
    Router.start();
    Router.start();
    Router.go({ name: 'settings', params: {} });
    await tick();
    expect(calls.length).toBe(1);
  });

  it('produces the right route objects for back and forward', async () => {
    Router.go({ name: 'servers', params: {} });
    await until(() => calls.length === 1);
    Router.go({ name: 'terminal', params: { serverId: 'prod', sessionId: '$3', paneId: '%12' } });
    await until(() => calls.length === 2);
    expect(dom.window.location.hash).toBe('#/terminal/prod/%243');
    calls.length = 0;

    dom.window.history.back();
    await until(() => calls.length === 1);
    expect(calls[0][0]).toEqual({ name: 'servers', params: {} });

    dom.window.history.forward();
    await until(() => calls.length === 2);
    expect(calls[1][0]).toEqual({ name: 'terminal', params: { serverId: 'prod', sessionId: '$3' } });
    expect(calls[1][1]).toEqual({ name: 'servers', params: {} });
  });
});

describe('Router.start with no hash', () => {
  it('replaces into the default route', async () => {
    Router.stop();
    dom.window.history.replaceState(null, '', '/');
    expect(dom.window.location.hash).toBe('');
    const seen = [];
    const off = Router.subscribe((route) => seen.push(route));
    Router.start();
    expect(dom.window.location.hash).toBe('#/terminal/local');
    expect(seen).toEqual([DEFAULT]);
    await tick();
    expect(seen.length).toBe(1);
    off();
    Router.stop();
  });
});
