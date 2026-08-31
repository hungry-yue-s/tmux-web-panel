(function (global) {
  var DEFAULT_SERVER_ID = 'local';
  var TERMINAL_KEYS = ['serverId', 'sessionId', 'windowId', 'paneId'];
  var SERVER_SECTIONS = ['overview', 'performance', 'connection'];

  var CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

  var listeners = [];
  var started = false;
  var hashListener = null;
  var lastRoute = null;

  function defaultRoute() {
    return { name: 'terminal', params: { serverId: DEFAULT_SERVER_ID } };
  }

  function enc(value) {
    return encodeURIComponent(String(value));
  }

  function toSegments(hash) {
    var raw = typeof hash === 'string' ? hash : '';
    if (raw.charAt(0) === '#') raw = raw.slice(1);
    var cut = raw.indexOf('?');
    if (cut >= 0) raw = raw.slice(0, cut);
    var parts = raw.split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '') continue;
      var value = decodeURIComponent(parts[i]);
      // An un-encoded id such as %12 is a valid escape that decodes to a control char, not an id.
      if (CONTROL_CHARS.test(value)) throw new URIError('control character in route segment');
      out.push(value);
    }
    return out;
  }

  function parseTerminal(rest) {
    if (rest.length === 0 || rest.length > TERMINAL_KEYS.length) return defaultRoute();
    var params = {};
    for (var i = 0; i < rest.length; i++) {
      params[TERMINAL_KEYS[i]] = rest[i];
    }
    return { name: 'terminal', params: params };
  }

  function parseServers(rest) {
    if (rest.length === 0) return { name: 'servers', params: {} };
    if (rest.length === 1) {
      if (rest[0] === 'new') return { name: 'servers', params: { intent: 'new' } };
      return { name: 'server', params: { serverId: rest[0], section: 'overview' } };
    }
    if (rest.length === 2) {
      if (rest[1] === 'tmux') return { name: 'terminal', params: { serverId: rest[0] } };
      if (SERVER_SECTIONS.indexOf(rest[1]) >= 0) {
        return { name: 'server', params: { serverId: rest[0], section: rest[1] } };
      }
    }
    return defaultRoute();
  }

  function parse(hash) {
    var parts;
    try {
      parts = toSegments(hash);
    } catch (_e) {
      // A bare tmux pane id such as %12 is an invalid escape; the whole route is unusable.
      return defaultRoute();
    }
    if (parts.length === 0) return defaultRoute();
    var head = parts[0];
    var rest = parts.slice(1);
    if (head === 'home') return defaultRoute();
    if (head === 'terminal') return parseTerminal(rest);
    if (head === 'servers' || head === 'server') return parseServers(rest);
    if (head === 'settings' && rest.length === 0) return { name: 'settings', params: {} };
    return defaultRoute();
  }

  function serialize(route) {
    var r = route && route.name ? route : defaultRoute();
    var p = r.params || {};
    if (r.name === 'terminal') {
      var out = '#/terminal/' + enc(p.serverId || DEFAULT_SERVER_ID);
      for (var i = 1; i < TERMINAL_KEYS.length; i++) {
        var v = p[TERMINAL_KEYS[i]];
        if (v === undefined || v === null || v === '') break;
        out += '/' + enc(v);
      }
      return out;
    }
    if (r.name === 'servers') {
      return p.intent === 'new' ? '#/servers/new' : '#/servers';
    }
    if (r.name === 'server') {
      if (!p.serverId) return '#/servers';
      var section = SERVER_SECTIONS.indexOf(p.section) >= 0 ? p.section : 'overview';
      return '#/servers/' + enc(p.serverId) + '/' + section;
    }
    if (r.name === 'settings') return '#/settings';
    return '#/terminal/' + enc(DEFAULT_SERVER_ID);
  }

  function definedKeys(params) {
    var out = [];
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] !== undefined) out.push(k);
    });
    return out;
  }

  function isSame(a, b) {
    if (!a || !b) return a === b;
    if (a.name !== b.name) return false;
    var pa = a.params || {};
    var pb = b.params || {};
    var ka = definedKeys(pa);
    var kb = definedKeys(pb);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) {
      if (pa[ka[i]] !== pb[ka[i]]) return false;
    }
    return true;
  }

  function getLocation() {
    try {
      if (global && global.location) return global.location;
    } catch (_e) {}
    return null;
  }

  function current() {
    var loc = getLocation();
    return parse(loc ? loc.hash : '');
  }

  function notify(route) {
    var previous = lastRoute;
    lastRoute = route;
    listeners.slice().forEach(function (fn) {
      try {
        fn(route, previous);
      } catch (_e) {}
    });
  }

  function onHashChange() {
    var route = current();
    if (lastRoute && isSame(lastRoute, route)) return;
    notify(route);
  }

  function go(route, opts) {
    var loc = getLocation();
    if (!loc) return;
    var target = serialize(route);
    if ((loc.hash || '') === target) return;
    if (opts && opts.replace && typeof loc.replace === 'function') {
      loc.replace(target);
      return;
    }
    loc.hash = target;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function start() {
    if (started) return;
    started = true;
    hashListener = function () {
      onHashChange();
    };
    if (global && typeof global.addEventListener === 'function') {
      global.addEventListener('hashchange', hashListener);
    }
    var loc = getLocation();
    if (loc && (!loc.hash || loc.hash === '#')) {
      var target = serialize(defaultRoute());
      if (typeof loc.replace === 'function') loc.replace(target);
      else loc.hash = target;
    }
    notify(current());
  }

  function stop() {
    if (!started) return;
    started = false;
    if (hashListener && global && typeof global.removeEventListener === 'function') {
      global.removeEventListener('hashchange', hashListener);
    }
    hashListener = null;
    lastRoute = null;
  }

  global.Router = {
    DEFAULT_SERVER_ID: DEFAULT_SERVER_ID,
    SERVER_SECTIONS: SERVER_SECTIONS,
    defaultRoute: defaultRoute,
    parse: parse,
    serialize: serialize,
    isSame: isSame,
    current: current,
    go: go,
    subscribe: subscribe,
    start: start,
    stop: stop,
  };
})(typeof window !== 'undefined' ? window : globalThis);
