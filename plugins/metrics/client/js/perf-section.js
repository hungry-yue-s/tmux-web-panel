// A server's performance page, put on the server page through PanelSlots
// (plugins/ui/client/js/slots.js). PerfPanel draws it and owns its pollers.

(function (global) {
  'use strict';
  if (!global.PanelSlots) return;

  function panel() {
    return global.PerfPanel && typeof global.PerfPanel.renderSkeleton === 'function' ? global.PerfPanel : null;
  }

  global.PanelSlots.serverSections.register({
    id: 'performance',
    label: '性能',
    order: 10,
    monitor: true,
    visible: function (ui) { return ui.showPerformance; },
    render: function () {
      var perf = panel();
      if (!perf) return '<div class="ms-card empty"><h3>性能组件未加载</h3><p>PerfPanel 脚本缺失，无法显示本机性能。</p></div>';
      return '<div class="section local-perf-host">' + perf.renderSkeleton('performance') + '</div>';
    },
    mount: function () {
      var perf = panel();
      if (!perf || typeof perf.start !== 'function' || !global.document.getElementById('perf-panel')) return false;
      perf.start('performance');
      return true;
    },
    unmount: function () {
      var perf = panel();
      if (perf && typeof perf.stop === 'function') perf.stop();
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
