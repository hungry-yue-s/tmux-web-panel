// The browser remembers a native tmux client, never a second pane layout.
const VERSION = 2;
const MAX_VIEWS = 64;
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const newId = (prefix = 'v') => prefix + '-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));

export function validateTarget(value) {
  if (!plain(value) || !text(value.serverId) || !text(value.instanceId) || !/^\$\d+$/.test(value.sessionId) || !/^@\d+$/.test(value.windowId) || !/^%\d+$/.test(value.paneId)) return null;
  return Object.freeze(Object.fromEntries(['serverId', 'instanceId', 'sessionId', 'windowId', 'paneId'].map((key) => [key, value[key]])));
}
export function validateWindowTarget(value) {
  if (!plain(value) || !text(value.serverId) || !text(value.instanceId) || !/^\$\d+$/.test(value.sessionId) || !/^@\d+$/.test(value.windowId) || !validId(value.clientId)) return null;
  return Object.freeze(Object.fromEntries(['serverId', 'instanceId', 'sessionId', 'windowId', 'clientId'].map((key) => [key, value[key]])));
}
function cleanView(raw) {
  if (!plain(raw) || !validId(raw.id) || !text(raw.serverId) || !text(raw.instanceId) || !/^\$\d+$/.test(raw.sessionId) || !validId(raw.clientId) || !validId(raw.requestId)) return null;
  if (raw.windowId != null && !/^@\d+$/.test(raw.windowId)) return null;
  const create = { cols: Math.max(2, Math.min(500, Math.round(Number(raw.create?.cols) || 100))), rows: Math.max(2, Math.min(300, Math.round(Number(raw.create?.rows) || 30))) };
  if (text(raw.create?.cwd, 4096)) create.cwd = raw.create.cwd;
  return { version: VERSION, id: raw.id, title: text(raw.title, 120) ? raw.title : '工作台', serverId: raw.serverId,
    instanceId: raw.instanceId, sessionId: raw.sessionId, windowId: raw.windowId || null, clientId: raw.clientId, requestId: raw.requestId, create,
    ...(Number.isFinite(raw.fontSize) ? { fontSize: Math.max(8, Math.min(22, Math.round(raw.fontSize))) } : {}), updatedAt: Number(raw.updatedAt) || Date.now() };
}
export function createViewStore(storage, scope = 'local') {
  const key = 'anymux_workbench_v2:' + encodeURIComponent(scope);
  const legacyKey = 'twp_workbench_v2:' + encodeURIComponent(scope);
  const prefix = 'anymux_workbench_v3:' + encodeURIComponent(scope) + ':';
  const closedPrefix = prefix + 'closed:';
  const legacy = new Map(), memory = new Map(), closed = new Set();
  let persistent = !!storage;
  try {
    const saved = JSON.parse(storage?.getItem(key) ?? storage?.getItem(legacyKey) ?? 'null');
    if (saved?.version === VERSION && Array.isArray(saved.views)) {
      for (const view of saved.views.slice(0, MAX_VIEWS).map(cleanView).filter(Boolean)) legacy.set(view.id, view);
    }
  } catch { /* corrupt/blocked legacy storage never causes remote changes */ }
  function get(id) {
    if (!validId(id) || closed.has(id)) return null;
    let raw;
    try {
      if (storage?.getItem(closedPrefix + id) === '1') return null;
      raw = storage?.getItem(prefix + id);
    } catch { persistent = false; }
    if (raw != null) { try { return cleanView(JSON.parse(raw)); } catch { return null; } }
    return cleanView(memory.has(id) ? memory.get(id) : legacy.get(id));
  }
  function list(serverId) {
    const ids = new Set([...legacy.keys(), ...memory.keys()]);
    try {
      for (let i = 0; i < (storage?.length || 0); i++) {
        const name = storage.key(i);
        if (name?.startsWith(prefix) && validId(name.slice(prefix.length))) ids.add(name.slice(prefix.length));
      }
    } catch { persistent = false; }
    return [...ids].map(get).filter(view => view && (!serverId || view.serverId === serverId)).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  function write(view) {
    memory.set(view.id, view);
    try { storage?.setItem(prefix + view.id, JSON.stringify(view)); persistent = !!storage; } catch { persistent = false; }
    return get(view.id);
  }
  function save(view) {
    if (!get(view.id)) throw new Error('工作台不存在');
    const clean = cleanView({ ...view, updatedAt: Date.now() });
    if (!clean) throw new Error('工作台身份无效');
    return write(clean);
  }
  function follow(id, target) {
    const view = get(id); if (!view) throw new Error('工作台不存在');
    if (target.serverId && target.serverId !== view.serverId || target.instanceId !== view.instanceId || !/^\$\d+$/.test(target.sessionId) || !/^@\d+$/.test(target.windowId)) throw new Error('远端窗口身份不匹配');
    return save({ ...view, sessionId: target.sessionId, windowId: target.windowId });
  }
  return {
    get, list, get persistent() { return persistent; },
    create(options) {
      if (list().length >= MAX_VIEWS) throw new Error('最多保存 64 个工作台');
      const view = cleanView({ ...options, id: newId(), clientId: options.clientId || newId('c'), requestId: newId('r'), create: options.create || options });
      if (!view) throw new Error('需要有效的服务器、tmux 实例和会话'); return write(view);
    },
    update(id, change) {
      const view = get(id); if (!view) throw new Error('工作台不存在'); const next = { ...view, create: { ...view.create } }; change(next);
      if (['id', 'serverId', 'instanceId', 'sessionId', 'windowId', 'clientId', 'requestId'].some((key) => next[key] !== view[key])) throw new Error('不能更换工作台身份'); return save(next);
    },
    bind(id, target) { const view = get(id); if (view?.sessionId !== target.sessionId || view?.windowId && view.windowId !== target.windowId) throw new Error('不能更换已绑定窗口'); return follow(id, target); },
    follow,
    close(id) {
      if (!validId(id)) return;
      closed.add(id); memory.delete(id);
      // A separate tombstone cannot be erased by an update from a stale tab.
      try { storage?.setItem(closedPrefix + id, '1'); persistent = !!storage; } catch { persistent = false; }
    },
  };
}
