// The settings page's management centre: a frame for the panels plugins put
// in it (PanelSlots.managementPanels, slots.js): the tmux runtime and Agent
// Skills (managed-resources), the panel plugins (panel-plugins). Each panel
// loads, acts and reports on its own; the page has one status line for
// what an action reports. Without any panel there is no management centre.

(function (global) {
  'use strict';
  if (!global.PanelSlots) return;

  function panels() {
    return global.PanelSlots.managementPanels.list();
  }

  async function mount(root) {
    if (!root) return;
    var list = panels();
    root.innerHTML = '<div class="intro"><h2>管理中心</h2><p>管理面板所在机器的 tmux、配置、插件和 Agent Skills。</p></div>'
      + list.map(function (panel) { return '<div data-management-panel="' + panel.id + '"></div>'; }).join('')
      + '<p id="managed-feedback" role="status" aria-live="polite"></p>';
    var status = root.querySelector('#managed-feedback');
    var page = {
      feedback: function (text) { status.textContent = text || ''; },
    };
    await Promise.all(list.map(function (panel) {
      return panel.mount(root.querySelector('[data-management-panel="' + panel.id + '"]'), page);
    }));
  }

  global.ManagementPage = { mount: mount };

  global.PanelSlots.settingsSections.register({
    id: 'management',
    label: '管理中心',
    order: 20,
    available: function () { return panels().length > 0; },
    render: function () { return '<div id="managed-resources"></div>'; },
    mount: function (view) { return mount(view.querySelector('#managed-resources')); },
  });
})(typeof window !== 'undefined' ? window : globalThis);
