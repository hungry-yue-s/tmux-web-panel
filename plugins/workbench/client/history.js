import { validateTarget } from './model.js';

/** An independent plain-text reader. It never writes into or resets the xterm. */
export function openHistory(global, input, { title = '终端', returnFocus = global.document.activeElement, onClose = () => {} } = {}) {
  const target = validateTarget(input);
  if (!target) throw new Error('缺少有效的远端窗格');
  const doc = global.document;
  const dialog = doc.createElement('dialog'); dialog.className = 'wb-history';
  dialog.setAttribute('aria-label', title + '的滚动历史');
  const header = doc.createElement('header'); header.className = 'wb-history-header';
  const heading = doc.createElement('strong'); heading.textContent = title + ' · 滚动历史';
  const closeButton = doc.createElement('button'); closeButton.type = 'button'; closeButton.className = 'wb-button'; closeButton.textContent = '关闭'; closeButton.setAttribute('aria-label', '关闭历史');
  header.append(heading, closeButton);
  const hint = doc.createElement('p'); hint.className = 'wb-history-hint'; hint.textContent = '历史随终端输出滚动，刷新读取最新记录。';
  const status = doc.createElement('p'); status.className = 'wb-history-status'; status.setAttribute('role', 'status');
  const content = doc.createElement('pre'); content.className = 'wb-history-content'; content.tabIndex = 0; content.setAttribute('aria-label', '当前历史页');
  const footer = doc.createElement('footer'); footer.className = 'wb-history-footer';
  const earlier = doc.createElement('button'); earlier.type = 'button'; earlier.className = 'wb-button'; earlier.textContent = '更早 500 行';
  const refresh = doc.createElement('button'); refresh.type = 'button'; refresh.className = 'wb-button'; refresh.textContent = '刷新最新';
  footer.append(earlier, refresh); dialog.append(header, hint, status, content, footer); doc.body.append(dialog);
  let disposed = false, controller, request, nextBefore = null;
  function close() {
    if (disposed) return;
    disposed = true; controller?.abort();
    if (dialog.open) dialog.close();
    dialog.remove();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    onClose();
  }
  function load(before) {
    if (disposed) return Promise.resolve();
    if (request) return request;
    const query = new URLSearchParams({ instanceId: target.instanceId, sessionId: target.sessionId, windowId: target.windowId, limit: '500' });
    if (before != null) query.set('before', String(before));
    const url = global.Api.nodeUrl(target.serverId, '/api/workbench/panes/' + encodeURIComponent(target.paneId) + '/history') + '?' + query;
    controller = new global.AbortController();
    dialog.setAttribute('aria-busy', 'true'); earlier.disabled = refresh.disabled = true; status.textContent = '正在读取历史…';
    request = global.Api.get(url, { signal: controller.signal }).then((result) => {
      if (disposed) return;
      if (['instanceId', 'sessionId', 'windowId', 'paneId'].some((key) => result[key] !== target[key])
        || !Array.isArray(result.lines) || result.lines.length > 500 || result.lines.some((line) => typeof line !== 'string')
        || !Number.isSafeInteger(result.total) || !Number.isSafeInteger(result.before) || result.before < 0 || result.total < result.before
        || !(result.nextBefore === null || Number.isSafeInteger(result.nextBefore) && result.nextBefore >= 0 && result.nextBefore < result.before)) throw new Error('历史记录的来源或分页信息无效');
      nextBefore = result.nextBefore;
      content.textContent = result.lines.join('\n'); content.scrollTop = 0;
      status.textContent = result.lines.length ? (result.before - result.lines.length + 1) + '–' + result.before + ' / ' + result.total + ' 行' : '暂无滚动历史，当前屏幕仍显示在终端中。';
    }).catch((error) => { if (!disposed) status.textContent = '读取失败：' + error.message; }).finally(() => {
      request = null;
      if (!disposed) { dialog.setAttribute('aria-busy', 'false'); earlier.disabled = nextBefore == null; refresh.disabled = false; }
    });
    return request;
  }
  const api = { dialog, target, close, refresh: () => load(), loadEarlier: () => nextBefore == null ? Promise.resolve() : load(nextBefore) };
  closeButton.addEventListener('click', close); earlier.addEventListener('click', api.loadEarlier); refresh.addEventListener('click', api.refresh);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); }); dialog.addEventListener('close', close);
  dialog.showModal();
  api.ready = load();
  return api;
}
