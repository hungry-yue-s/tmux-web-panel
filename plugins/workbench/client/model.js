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
  const key = 'twp_workbench_v2:' + encodeURIComponent(scope);
  let views = [], persistent = true;
  try { const saved = JSON.parse(storage?.getItem(key) || 'null'); if (saved?.version === VERSION && Array.isArray(saved.views)) views = saved.views.slice(0, MAX_VIEWS).map(cleanView).filter(Boolean); } catch { /* v1 and corrupt data never cause remote changes */ }
  const get = (id) => cleanView(views.find((view) => view.id === id));
  function persist() { try { storage?.setItem(key, JSON.stringify({ version: VERSION, views })); persistent = !!storage; } catch { persistent = false; } }
  function save(view) { const clean = cleanView({ ...view, updatedAt: Date.now() }); if (!clean) throw new Error('工作台身份无效'); views = views.map((item) => item.id === clean.id ? clean : item); persist(); return get(clean.id); }
  function follow(id, target) {
    const view = get(id); if (!view) throw new Error('工作台不存在');
    if (target.serverId && target.serverId !== view.serverId || target.instanceId !== view.instanceId || !/^\$\d+$/.test(target.sessionId) || !/^@\d+$/.test(target.windowId)) throw new Error('远端窗口身份不匹配');
    return save({ ...view, sessionId: target.sessionId, windowId: target.windowId });
  }
  return {
    get, list: (serverId) => views.filter((view) => !serverId || view.serverId === serverId).map(cleanView).sort((a, b) => b.updatedAt - a.updatedAt), get persistent() { return persistent; },
    create(options) {
      if (views.length >= MAX_VIEWS) throw new Error('最多保存 64 个工作台');
      const view = cleanView({ ...options, id: newId(), clientId: options.clientId || newId('c'), requestId: newId('r'), create: options.create || options });
      if (!view) throw new Error('需要有效的服务器、tmux 实例和会话'); views.push(view); persist(); return get(view.id);
    },
    update(id, change) {
      const view = get(id); if (!view) throw new Error('工作台不存在'); const next = { ...view, create: { ...view.create } }; change(next);
      if (['id', 'serverId', 'instanceId', 'sessionId', 'windowId', 'clientId', 'requestId'].some((key) => next[key] !== view[key])) throw new Error('不能更换工作台身份'); return save(next);
    },
    bind(id, target) { const view = get(id); if (view?.sessionId !== target.sessionId || view?.windowId && view.windowId !== target.windowId) throw new Error('不能更换已绑定窗口'); return follow(id, target); },
    follow,
    close(id) { views = views.filter((view) => view.id !== id); persist(); },
  };
}
