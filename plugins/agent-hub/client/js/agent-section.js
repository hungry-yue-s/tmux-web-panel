// A server's Agent console, put on the server page through PanelSlots
// (plugins/ui/client/js/slots.js). The former Claude and Codex usage pages
// lead here.

(function (global) {
  'use strict';
  if (!global.PanelSlots) return;

  function hub() {
    return global.AgentHub && typeof global.AgentHub.renderSkeleton === 'function' ? global.AgentHub : null;
  }

  global.PanelSlots.serverSections.register({
    id: 'agents',
    label: 'Agent 控制台',
    order: 20,
    aliases: ['claude', 'codex'],
    monitor: true,
    visible: function (ui) { return ui.showClaude || ui.showCodex; },
    render: function () {
      var agents = hub();
      if (!agents) return '<div class="ms-card empty"><h3>Agent 控制台组件未加载</h3></div>';
      return '<div class="section local-agent-host">' + agents.renderSkeleton() + '</div>';
    },
    mount: function () {
      var agents = hub();
      if (!agents || typeof agents.start !== 'function' || !global.document.getElementById('agent-hub')) return false;
      agents.start();
      return true;
    },
    unmount: function () {
      var agents = hub();
      if (agents && typeof agents.stop === 'function') agents.stop();
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
