import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const SRC_URL = new URL('../public/js/store.js', import.meta.url);
const SRC = fs.readFileSync(SRC_URL, 'utf8');

function makeLocalStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
    clear: () => map.clear(),
  };
}

function loadStore(initialStorage) {
  const win = { localStorage: makeLocalStorage(initialStorage) };
  new Function('window', SRC)(win);
  return { Store: win.Store, win, storage: win.localStorage };
}

function counter(Store) {
  const state = { count: 0, last: null };
  Store.subscribe((next) => {
    state.count += 1;
    state.last = next;
  });
  return state;
}

describe('Store initial state', () => {
  it('has the documented shape', () => {
    const { Store } = loadStore();
    expect(Store.getState()).toEqual({
      route: {},
      entities: {
        serversById: {},
        healthByServerId: {},
        workspaceByServerId: {},
        metricsByServerId: {},
      },
      ui: {
        sidebarCollapsed: true,
        sidebarWidth: 248,
        expandedSessionIdsByServer: {},
        terminalModeByServer: {},
        lastStatusServerId: null,
        pendingDialog: null,
      },
      requests: {
        workspaceByServerId: {},
        metricsByServerId: {},
      },
    });
  });
});

describe('Store mutations', () => {
  it('setRoute stores the route and notifies once', () => {
    const { Store } = loadStore();
    const seen = counter(Store);
    Store.setRoute({ name: 'servers', params: {} });
    expect(seen.count).toBe(1);
    expect(Store.getState().route).toEqual({ name: 'servers', params: {} });
  });

  it('setServers keys the list by id and notifies once', () => {
    const { Store } = loadStore();
    const seen = counter(Store);
    Store.setServers([{ id: 'local', name: 'Local' }, { id: 'prod', name: 'Prod' }, null, { name: 'no id' }]);
    expect(seen.count).toBe(1);
    expect(Object.keys(Store.getState().entities.serversById)).toEqual(['local', 'prod']);
    expect(Store.getState().entities.serversById.prod).toEqual({ id: 'prod', name: 'Prod' });
  });

  it('setServers replaces the previous map', () => {
    const { Store } = loadStore();
    Store.setServers([{ id: 'a' }, { id: 'b' }]);
    Store.setServers([{ id: 'c' }]);
    expect(Object.keys(Store.getState().entities.serversById)).toEqual(['c']);
  });

  it('setHealth / setWorkspace / setMetrics each notify exactly once', () => {
    const { Store } = loadStore();
    const seen = counter(Store);
    Store.setHealth('prod', { status: 'online' });
    expect(seen.count).toBe(1);
    Store.setWorkspace('prod', { sessions: [] });
    expect(seen.count).toBe(2);
    Store.setMetrics('prod', { cpu: 1 });
    expect(seen.count).toBe(3);
    const e = Store.getState().entities;
    expect(e.healthByServerId.prod).toEqual({ status: 'online' });
    expect(e.workspaceByServerId.prod).toEqual({ sessions: [] });
    expect(e.metricsByServerId.prod).toEqual({ cpu: 1 });
  });

  it('setUi notifies exactly once', () => {
    const { Store } = loadStore();
    const seen = counter(Store);
    Store.setUi({ sidebarCollapsed: false });
    expect(seen.count).toBe(1);
  });

  it('removeServer drops the server and every derived entry', () => {
    const { Store } = loadStore();
    Store.setServers([{ id: 'a' }, { id: 'b' }]);
    ['a', 'b'].forEach((id) => {
      Store.setHealth(id, { status: 'online' });
      Store.setWorkspace(id, { sessions: [] });
      Store.setMetrics(id, { cpu: 1 });
      Store.beginRequest('workspace', id);
      Store.beginRequest('metrics', id);
    });
    const seen = counter(Store);
    Store.removeServer('a');
    expect(seen.count).toBe(1);
    const s = Store.getState();
    expect(s.entities.serversById.a).toBeUndefined();
    expect(s.entities.healthByServerId.a).toBeUndefined();
    expect(s.entities.workspaceByServerId.a).toBeUndefined();
    expect(s.entities.metricsByServerId.a).toBeUndefined();
    expect(s.requests.workspaceByServerId.a).toBeUndefined();
    expect(s.requests.metricsByServerId.a).toBeUndefined();
    expect(s.entities.serversById.b).toEqual({ id: 'b' });
    expect(s.entities.healthByServerId.b).toEqual({ status: 'online' });
    expect(s.requests.metricsByServerId.b).toBeGreaterThan(0);
  });
});

describe('Store ui prefs persistence', () => {
  it('persists only the whitelisted ui keys', () => {
    const { Store, storage } = loadStore();
    Store.setUi({ sidebarCollapsed: false, sidebarWidth: 320, pendingDialog: { kind: 'add-server' } });
    const raw = storage.getItem('tmux_ui_prefs');
    expect(raw).toBeTruthy();
    const saved = JSON.parse(raw);
    expect(Object.keys(saved).sort()).toEqual([
      'expandedSessionIdsByServer',
      'lastStatusServerId',
      'sidebarCollapsed',
      'sidebarWidth',
      'terminalModeByServer',
    ]);
    expect(saved.sidebarCollapsed).toBe(false);
    expect(saved.sidebarWidth).toBe(320);
    expect(saved.pendingDialog).toBeUndefined();
  });

  it('reloads persisted prefs into a fresh store', () => {
    const first = loadStore();
    first.Store.setUi({
      sidebarCollapsed: false,
      sidebarWidth: 300,
      expandedSessionIdsByServer: { local: ['$1', '$2'] },
      terminalModeByServer: { prod: 'split' },
      lastStatusServerId: 'prod',
    });
    const raw = first.storage.getItem('tmux_ui_prefs');

    const second = loadStore({ tmux_ui_prefs: raw });
    const seen = counter(second.Store);
    second.Store.loadUiPrefs();
    expect(seen.count).toBe(1);
    expect(second.Store.getState().ui).toEqual({
      sidebarCollapsed: false,
      sidebarWidth: 300,
      expandedSessionIdsByServer: { local: ['$1', '$2'] },
      terminalModeByServer: { prod: 'split' },
      lastStatusServerId: 'prod',
      pendingDialog: null,
    });
  });

  it('tolerates corrupt JSON', () => {
    const { Store } = loadStore({ tmux_ui_prefs: '{not json' });
    expect(() => Store.loadUiPrefs()).not.toThrow();
    expect(Store.getState().ui.sidebarCollapsed).toBe(true);
    expect(Store.getState().ui.sidebarWidth).toBe(248);
  });

  it('tolerates absent prefs', () => {
    const { Store } = loadStore();
    expect(() => Store.loadUiPrefs()).not.toThrow();
    expect(Store.getState().ui.expandedSessionIdsByServer).toEqual({});
  });

  it('clamps a persisted sidebar width into the usable range', () => {
    for (const [stored, expected] of [[9999, 360], [10, 220], ['300', 300], [248.6, 249]]) {
      const { Store } = loadStore({ tmux_ui_prefs: JSON.stringify({ sidebarWidth: stored }) });
      Store.loadUiPrefs();
      expect(Store.getState().ui.sidebarWidth).toBe(expected);
    }
  });

  it('ignores persisted values of the wrong type', () => {
    const { Store } = loadStore({
      tmux_ui_prefs: JSON.stringify({
        sidebarCollapsed: 'yes',
        sidebarWidth: 'wide',
        expandedSessionIdsByServer: ['not', 'a', 'map'],
        terminalModeByServer: 'tab',
        lastStatusServerId: 42,
      }),
    });
    Store.loadUiPrefs();

    const ui = Store.getState().ui;
    expect(ui.sidebarCollapsed).toBe(true);
    expect(ui.sidebarWidth).toBe(248);
    expect(ui.expandedSessionIdsByServer).toEqual({});
    expect(ui.terminalModeByServer).toEqual({});
    expect(ui.lastStatusServerId).toBeNull();
  });

  it('rejects an empty remembered status server id', () => {
    // An empty id would select nothing while still looking like a real choice.
    const { Store: fresh } = loadStore({
      tmux_ui_prefs: JSON.stringify({ lastStatusServerId: '' }),
    });
    fresh.loadUiPrefs();
    expect(fresh.getState().ui.lastStatusServerId).toBeNull();
  });

  it('drops malformed entries inside the persisted maps', () => {
    const { Store } = loadStore({
      tmux_ui_prefs: JSON.stringify({
        expandedSessionIdsByServer: { local: ['$1', 7, '', null], broken: 'nope', empty: [] },
        terminalModeByServer: { a: 'tab', b: 'window', c: 42 },
      }),
    });
    Store.loadUiPrefs();

    const ui = Store.getState().ui;
    expect(ui.expandedSessionIdsByServer).toEqual({ local: ['$1'] });
    expect(ui.terminalModeByServer).toEqual({ a: 'tab' });
  });

  it('sanitizeUiPrefs rejects non-objects', () => {
    const { Store } = loadStore();
    expect(Store.sanitizeUiPrefs(null)).toEqual({});
    expect(Store.sanitizeUiPrefs('str')).toEqual({});
    expect(Store.sanitizeUiPrefs([1, 2])).toEqual({});
  });
});

describe('Store session expansion', () => {
  it('keys expansion by server so identical session ids do not collide', () => {
    const { Store } = loadStore();

    Store.setSessionExpanded('local', '$1', true);

    // The same tmux session id on another server must stay collapsed.
    expect(Store.isSessionExpanded('local', '$1')).toBe(true);
    expect(Store.isSessionExpanded('api-linux', '$1')).toBe(false);
    expect(Store.expandedSessionIds('api-linux')).toEqual([]);
  });

  it('toggles independently per server', () => {
    const { Store } = loadStore();

    Store.toggleSessionExpanded('local', '$1');
    Store.toggleSessionExpanded('api-linux', '$1');
    expect(Store.isSessionExpanded('local', '$1')).toBe(true);
    expect(Store.isSessionExpanded('api-linux', '$1')).toBe(true);

    Store.toggleSessionExpanded('local', '$1');
    expect(Store.isSessionExpanded('local', '$1')).toBe(false);
    expect(Store.isSessionExpanded('api-linux', '$1')).toBe(true);
  });

  it('does not duplicate an id that is expanded twice', () => {
    const { Store } = loadStore();
    Store.setSessionExpanded('local', '$1', true);
    Store.setSessionExpanded('local', '$1', true);
    expect(Store.expandedSessionIds('local')).toEqual(['$1']);
  });

  it('persists expansion across a reload', () => {
    const first = loadStore();
    first.Store.setSessionExpanded('local', '$3', true);
    const raw = first.storage.getItem('tmux_ui_prefs');

    const second = loadStore({ tmux_ui_prefs: raw });
    second.Store.loadUiPrefs();
    expect(second.Store.isSessionExpanded('local', '$3')).toBe(true);
  });

  it('ignores a missing server or session id', () => {
    const { Store } = loadStore();
    expect(() => Store.setSessionExpanded(null, '$1', true)).not.toThrow();
    expect(() => Store.setSessionExpanded('local', null, true)).not.toThrow();
    expect(Store.getState().ui.expandedSessionIdsByServer).toEqual({});
  });
});

describe('Store setServers pruning', () => {
  it('drops derived state for servers that no longer exist', () => {
    const { Store } = loadStore();
    Store.setServers([{ id: 'local' }, { id: 'gone' }]);
    Store.setHealth('gone', { state: 'online' });
    Store.setWorkspace('gone', { sessions: [] });
    Store.setMetrics('gone', { cpuPercent: 5 });
    Store.beginRequest('workspace', 'gone');
    Store.beginRequest('metrics', 'gone');
    Store.setHealth('local', { state: 'online' });

    Store.setServers([{ id: 'local' }]);

    const s = Store.getState();
    expect(Object.keys(s.entities.serversById)).toEqual(['local']);
    expect(s.entities.healthByServerId.gone).toBeUndefined();
    expect(s.entities.workspaceByServerId.gone).toBeUndefined();
    expect(s.entities.metricsByServerId.gone).toBeUndefined();
    expect(s.requests.workspaceByServerId.gone).toBeUndefined();
    expect(s.requests.metricsByServerId.gone).toBeUndefined();
    // Surviving servers keep theirs.
    expect(s.entities.healthByServerId.local).toEqual({ state: 'online' });
  });

  it('notifies once', () => {
    const { Store } = loadStore();
    const seen = counter(Store);
    Store.setServers([{ id: 'local' }]);
    expect(seen.count).toBe(1);
  });
});

describe('Store storage resilience', () => {
  it('tolerates a non-object payload', () => {
    const { Store } = loadStore({ tmux_ui_prefs: '"nope"' });
    Store.loadUiPrefs();
    expect(Store.getState().ui.sidebarWidth).toBe(248);
  });

  it('survives a throwing localStorage', () => {
    const win = {
      localStorage: {
        getItem() {
          throw new Error('blocked');
        },
        setItem() {
          throw new Error('blocked');
        },
      },
    };
    new Function('window', SRC)(win);
    expect(() => win.Store.loadUiPrefs()).not.toThrow();
    expect(() => win.Store.setUi({ sidebarCollapsed: false })).not.toThrow();
    expect(win.Store.getState().ui.sidebarCollapsed).toBe(false);
  });
});

describe('Store never persists the route', () => {
  it('writes nothing to storage on setRoute', () => {
    const { Store, storage } = loadStore();
    Store.setRoute({ name: 'terminal', params: { serverId: 'prod', paneId: '%12' } });
    expect(storage.map.size).toBe(0);
  });

  it('keeps the route out of the persisted prefs payload', () => {
    const { Store, storage } = loadStore();
    Store.setRoute({ name: 'terminal', params: { serverId: 'prod' } });
    Store.setUi({ sidebarCollapsed: false });
    const saved = JSON.parse(storage.getItem('tmux_ui_prefs'));
    expect(saved.route).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('prod');
  });

  it('never references sessionStorage', () => {
    expect(SRC).not.toMatch(/sessionStorage/);
  });
});

describe('Store request tokens', () => {
  it('returns increasing tokens', () => {
    const { Store } = loadStore();
    const a = Store.beginRequest('workspace', 'prod');
    const b = Store.beginRequest('workspace', 'prod');
    expect(b).toBeGreaterThan(a);
  });

  it('only the newest token for a server is current', () => {
    const { Store } = loadStore();
    const stale = Store.beginRequest('workspace', 'prod');
    const fresh = Store.beginRequest('workspace', 'prod');
    expect(Store.isCurrentRequest('workspace', 'prod', stale)).toBe(false);
    expect(Store.isCurrentRequest('workspace', 'prod', fresh)).toBe(true);
  });

  it('keeps tokens independent per server', () => {
    const { Store } = loadStore();
    const a = Store.beginRequest('workspace', 'A');
    const b = Store.beginRequest('workspace', 'B');
    expect(Store.isCurrentRequest('workspace', 'A', a)).toBe(true);
    expect(Store.isCurrentRequest('workspace', 'B', b)).toBe(true);
    expect(Store.isCurrentRequest('workspace', 'A', b)).toBe(false);
    expect(Store.isCurrentRequest('workspace', 'B', a)).toBe(false);
  });

  it('keeps tokens independent per kind', () => {
    const { Store } = loadStore();
    const ws = Store.beginRequest('workspace', 'prod');
    const metrics = Store.beginRequest('metrics', 'prod');
    expect(Store.isCurrentRequest('workspace', 'prod', ws)).toBe(true);
    expect(Store.isCurrentRequest('metrics', 'prod', metrics)).toBe(true);
    expect(Store.isCurrentRequest('metrics', 'prod', ws)).toBe(false);
  });

  it('rejects an unknown kind', () => {
    const { Store } = loadStore();
    expect(Store.beginRequest('bogus', 'prod')).toBe(0);
    expect(Store.isCurrentRequest('bogus', 'prod', 0)).toBe(false);
  });

  it('notifies once per beginRequest', () => {
    const { Store } = loadStore();
    const seen = counter(Store);
    Store.beginRequest('workspace', 'prod');
    expect(seen.count).toBe(1);
  });
});

describe('Store subscribers', () => {
  it('returns a working unsubscribe', () => {
    const { Store } = loadStore();
    let hits = 0;
    const off = Store.subscribe(() => {
      hits += 1;
    });
    Store.setRoute({ name: 'servers', params: {} });
    off();
    Store.setRoute({ name: 'settings', params: {} });
    expect(hits).toBe(1);
  });

  it('isolates a throwing subscriber', () => {
    const { Store } = loadStore();
    const order = [];
    Store.subscribe(() => order.push('first'));
    Store.subscribe(() => {
      throw new Error('boom');
    });
    Store.subscribe(() => order.push('third'));
    expect(() => Store.setRoute({ name: 'settings', params: {} })).not.toThrow();
    expect(order).toEqual(['first', 'third']);
  });

  it('passes the new state to subscribers', () => {
    const { Store } = loadStore();
    const seen = counter(Store);
    Store.setHealth('prod', { status: 'offline' });
    expect(seen.last.entities.healthByServerId.prod).toEqual({ status: 'offline' });
    expect(seen.last).toBe(Store.getState());
  });
});
