(function (global) {
  var UI_PREFS_KEY = 'tmux_ui_prefs';
  var PERSISTED_UI_KEYS = [
    'sidebarCollapsed',
    'sidebarWidth',
    'expandedSessionIdsByServer',
    'terminalModeByServer',
    'lastStatusServerId',
  ];
  var REQUEST_MAPS = { workspace: 'workspaceByServerId', metrics: 'metricsByServerId' };
  var SIDEBAR_MIN_WIDTH = 220;
  var SIDEBAR_MAX_WIDTH = 360;
  var SIDEBAR_DEFAULT_WIDTH = 248;
  var TERMINAL_MODES = ['tab', 'split'];

  var listeners = [];
  var tokenSeq = 0;
  var state = initialState();

  function initialState() {
    return {
      route: {},
      entities: {
        serversById: {},
        healthByServerId: {},
        workspaceByServerId: {},
        metricsByServerId: {},
      },
      ui: {
        sidebarCollapsed: true,
        sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
        // Keyed by server: tmux session ids like $3 repeat across servers.
        expandedSessionIdsByServer: {},
        terminalModeByServer: {},
        lastStatusServerId: null,
        pendingDialog: null,
      },
      requests: {
        workspaceByServerId: {},
        metricsByServerId: {},
      },
    };
  }

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      Object.keys(src).forEach(function (k) {
        target[k] = src[k];
      });
    }
    return target;
  }

  function omit(map, key) {
    var out = {};
    Object.keys(map || {}).forEach(function (k) {
      if (k !== key) out[k] = map[k];
    });
    return out;
  }

  function pick(map, allowedKeys) {
    var out = {};
    Object.keys(map || {}).forEach(function (k) {
      if (allowedKeys.indexOf(k) >= 0) out[k] = map[k];
    });
    return out;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function getLocalStorage() {
    try {
      if (global && global.localStorage) return global.localStorage;
    } catch (_e) {}
    return null;
  }

  function getState() {
    return state;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function notify() {
    listeners.slice().forEach(function (fn) {
      try {
        fn(state);
      } catch (_e) {}
    });
  }

  function patchEntities(patch) {
    state = assign({}, state, { entities: assign({}, state.entities, patch) });
  }

  function patchRequests(patch) {
    state = assign({}, state, { requests: assign({}, state.requests, patch) });
  }

  function setEntity(mapName, key, value) {
    var next = assign({}, state.entities[mapName]);
    next[key] = value;
    var patch = {};
    patch[mapName] = next;
    patchEntities(patch);
    notify();
  }

  function setRoute(route) {
    state = assign({}, state, { route: route || {} });
    notify();
  }

  function setServers(list) {
    var byId = {};
    var ids = [];
    (list || []).forEach(function (server) {
      if (server && server.id !== undefined && server.id !== null) {
        byId[server.id] = server;
        ids.push(String(server.id));
      }
    });
    // Drop derived state for servers that no longer exist, or a deleted server
    // keeps haunting the UI with stale health and workspace data.
    state = assign({}, state, {
      entities: {
        serversById: byId,
        healthByServerId: pick(state.entities.healthByServerId, ids),
        workspaceByServerId: pick(state.entities.workspaceByServerId, ids),
        metricsByServerId: pick(state.entities.metricsByServerId, ids),
      },
      requests: {
        workspaceByServerId: pick(state.requests.workspaceByServerId, ids),
        metricsByServerId: pick(state.requests.metricsByServerId, ids),
      },
    });
    notify();
  }

  function setHealth(serverId, health) {
    setEntity('healthByServerId', serverId, health);
  }

  function setWorkspace(serverId, workspace) {
    setEntity('workspaceByServerId', serverId, workspace);
  }

  function setMetrics(serverId, metrics) {
    setEntity('metricsByServerId', serverId, metrics);
  }

  function removeServer(serverId) {
    state = assign({}, state, {
      entities: {
        serversById: omit(state.entities.serversById, serverId),
        healthByServerId: omit(state.entities.healthByServerId, serverId),
        workspaceByServerId: omit(state.entities.workspaceByServerId, serverId),
        metricsByServerId: omit(state.entities.metricsByServerId, serverId),
      },
      requests: {
        workspaceByServerId: omit(state.requests.workspaceByServerId, serverId),
        metricsByServerId: omit(state.requests.metricsByServerId, serverId),
      },
    });
    notify();
  }

  function persistUiPrefs() {
    var store = getLocalStorage();
    if (!store) return;
    var out = {};
    PERSISTED_UI_KEYS.forEach(function (k) {
      out[k] = state.ui[k];
    });
    try {
      store.setItem(UI_PREFS_KEY, JSON.stringify(out));
    } catch (_e) {}
  }

  function setUi(patch) {
    state = assign({}, state, { ui: assign({}, state.ui, patch || {}) });
    persistUiPrefs();
    notify();
  }

  function expandedSessionIds(serverId) {
    var map = state.ui.expandedSessionIdsByServer || {};
    return map[serverId] || [];
  }

  function isSessionExpanded(serverId, sessionId) {
    return expandedSessionIds(serverId).indexOf(sessionId) >= 0;
  }

  function setSessionExpanded(serverId, sessionId, expanded) {
    if (!serverId || !sessionId) return;
    var current = expandedSessionIds(serverId);
    var next = current.filter(function (id) { return id !== sessionId; });
    if (expanded) next.push(sessionId);
    var byServer = assign({}, state.ui.expandedSessionIdsByServer);
    byServer[serverId] = next;
    setUi({ expandedSessionIdsByServer: byServer });
  }

  function toggleSessionExpanded(serverId, sessionId) {
    setSessionExpanded(serverId, sessionId, !isSessionExpanded(serverId, sessionId));
  }

  /**
   * Coerces persisted preferences to their expected shape. A hand-edited or
   * half-written localStorage entry must not be able to break the layout.
   */
  function sanitizeUiPrefs(parsed) {
    var patch = {};
    if (!isPlainObject(parsed)) return patch;

    if (typeof parsed.sidebarCollapsed === 'boolean') {
      patch.sidebarCollapsed = parsed.sidebarCollapsed;
    }

    var width = Number(parsed.sidebarWidth);
    if (Number.isFinite(width)) {
      patch.sidebarWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
    }

    if (isPlainObject(parsed.expandedSessionIdsByServer)) {
      var expanded = {};
      Object.keys(parsed.expandedSessionIdsByServer).forEach(function (serverId) {
        var ids = parsed.expandedSessionIdsByServer[serverId];
        if (!Array.isArray(ids)) return;
        var clean = ids.filter(function (id) { return typeof id === 'string' && id !== ''; });
        if (clean.length > 0) expanded[serverId] = clean;
      });
      patch.expandedSessionIdsByServer = expanded;
    }

    if (isPlainObject(parsed.terminalModeByServer)) {
      var modes = {};
      Object.keys(parsed.terminalModeByServer).forEach(function (serverId) {
        var mode = parsed.terminalModeByServer[serverId];
        if (TERMINAL_MODES.indexOf(mode) >= 0) modes[serverId] = mode;
      });
      patch.terminalModeByServer = modes;
    }

    if (typeof parsed.lastStatusServerId === 'string' && parsed.lastStatusServerId !== '') {
      patch.lastStatusServerId = parsed.lastStatusServerId;
    }

    return patch;
  }

  function loadUiPrefs() {
    var store = getLocalStorage();
    var raw = null;
    if (store) {
      try {
        raw = store.getItem(UI_PREFS_KEY);
      } catch (_e) {
        raw = null;
      }
    }
    var parsed = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch (_e) {
        parsed = null;
      }
    }
    state = assign({}, state, { ui: assign({}, state.ui, sanitizeUiPrefs(parsed)) });
    notify();
    return state.ui;
  }

  function beginRequest(kind, serverId) {
    var mapName = REQUEST_MAPS[kind];
    if (!mapName) return 0;
    tokenSeq += 1;
    var next = assign({}, state.requests[mapName]);
    next[serverId] = tokenSeq;
    var patch = {};
    patch[mapName] = next;
    patchRequests(patch);
    notify();
    return tokenSeq;
  }

  function isCurrentRequest(kind, serverId, token) {
    var mapName = REQUEST_MAPS[kind];
    if (!mapName) return false;
    return state.requests[mapName][serverId] === token;
  }

  global.Store = {
    UI_PREFS_KEY: UI_PREFS_KEY,
    PERSISTED_UI_KEYS: PERSISTED_UI_KEYS,
    SIDEBAR_MIN_WIDTH: SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH: SIDEBAR_MAX_WIDTH,
    SIDEBAR_DEFAULT_WIDTH: SIDEBAR_DEFAULT_WIDTH,
    getState: getState,
    subscribe: subscribe,
    setRoute: setRoute,
    setServers: setServers,
    setHealth: setHealth,
    setWorkspace: setWorkspace,
    setMetrics: setMetrics,
    removeServer: removeServer,
    setUi: setUi,
    expandedSessionIds: expandedSessionIds,
    isSessionExpanded: isSessionExpanded,
    setSessionExpanded: setSessionExpanded,
    toggleSessionExpanded: toggleSessionExpanded,
    sanitizeUiPrefs: sanitizeUiPrefs,
    loadUiPrefs: loadUiPrefs,
    beginRequest: beginRequest,
    isCurrentRequest: isCurrentRequest,
  };
})(typeof window !== 'undefined' ? window : globalThis);
