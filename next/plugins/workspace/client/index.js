// The workspace view: sessions, windows and panes in the sidebar, the selected
// pane in the main area. Refreshes on an interval that ends with the plugin.

import { h } from '@twp/client';

export const name = 'workspace-view';

export const inject = ['api', 'shell', 'timer'];

export const REFRESH_MS = 5000;

function findPane(data, paneId) {
  for (const session of data?.sessions ?? []) {
    for (const window of session.windows) {
      const pane = window.panes.find((item) => item.id === paneId);
      if (pane) return { session, window, pane };
    }
  }
  return null;
}

export function apply(ctx) {
  const tree = h('div', { class: 'ws-tree' });
  const sidebar = h('section', { class: 'ws', 'aria-labelledby': 'ws-heading' },
    h('h2', { class: 'ws-heading', id: 'ws-heading' }, '会话'),
    tree,
  );
  const detail = h('section', { class: 'ws-detail', 'aria-live': 'polite' });
  ctx.shell.mount('sidebar', sidebar);
  ctx.shell.mount('main', detail);

  let data = null;
  let failure = null;
  let selected = null;
  let generation = 0;
  let live = true;
  ctx.effect(() => () => { live = false; }, 'workspace-view.live');

  function select(paneId) {
    selected = paneId;
    render();
  }

  function renderTree() {
    if (!data) {
      tree.replaceChildren(h('p', { class: 'ws-empty' }, failure ? '无法读取工作区' : '正在读取…'));
      return;
    }
    if (data.sessions.length === 0) {
      tree.replaceChildren(h('p', { class: 'ws-empty' }, '没有运行中的 tmux 会话'));
      return;
    }
    tree.replaceChildren(h('ul', { class: 'ws-sessions' }, data.sessions.map((session) => h('li', { class: 'ws-session' },
      h('div', { class: 'ws-session-name' }, session.name, session.active ? h('span', { class: 'ws-badge' }, '已连接') : null),
      h('ul', { class: 'ws-windows' }, session.windows.map((window) => h('li', { class: 'ws-window' },
        h('div', { class: 'ws-window-name' }, h('span', { class: 'ws-index' }, window.index), window.name),
        h('ul', { class: 'ws-panes' }, window.panes.map((pane) => h('li', null,
          h('button', {
            type: 'button',
            class: 'ws-pane',
            'aria-pressed': pane.id === selected ? 'true' : 'false',
            onClick: () => select(pane.id),
          }, h('span', { class: 'ws-pane-name' }, pane.name), h('span', { class: 'ws-pane-id' }, pane.id)),
        ))),
      ))),
    ))));
  }

  function renderDetail() {
    const found = selected && findPane(data, selected);
    if (!found) {
      detail.replaceChildren(h('div', { class: 'ws-placeholder' },
        h('p', null, '选择一个窗格'),
      ));
      return;
    }
    const { session, window, pane } = found;
    detail.replaceChildren(
      h('h2', { class: 'ws-detail-title' }, `${session.name} › ${window.index}:${window.name} › ${pane.name}`),
      h('dl', { class: 'ws-facts' },
        h('dt', null, '窗格'), h('dd', null, pane.id),
        h('dt', null, '程序'), h('dd', null, pane.command || '—'),
        h('dt', null, '尺寸'), h('dd', null, `${pane.geometry.width} × ${pane.geometry.height}`),
        h('dt', null, '实例'), h('dd', null, data.instanceId ?? '—'),
      ),
      h('p', { class: 'ws-note' }, '终端会在下一阶段作为插件接入。'),
    );
  }

  function render() {
    renderTree();
    renderDetail();
    if (failure) ctx.shell.status('刷新失败', { tone: 'error' });
    else ctx.shell.status(data ? `${data.sessions.length} 个会话` : '');
  }

  async function refresh() {
    const ticket = ++generation;
    try {
      const next = await ctx.api.get('/api/workspace');
      // A later refresh, or the plugin going away, makes this answer stale.
      if (!live || ticket !== generation) return;
      data = next;
      failure = null;
      // Only a complete read may forget a pane: a partial one can miss it.
      if (selected && data.complete && !findPane(data, selected)) selected = null;
    } catch (error) {
      if (!live || ticket !== generation) return;
      // Keep what is on screen; say that this refresh failed.
      failure = error;
    }
    render();
  }

  render();
  refresh();
  ctx.interval(refresh, REFRESH_MS);
}
