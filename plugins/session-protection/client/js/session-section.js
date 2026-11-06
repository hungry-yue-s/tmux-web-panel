// A server's sessions page, put on the server page through PanelSlots
// (plugins/ui/client/js/slots.js). Not a status page, so the page-visibility
// settings do not hide it. SessionProtectionPage reads that machine's Node.

(function (global) {
  'use strict';
  if (!global.PanelSlots) return;

  global.PanelSlots.serverSections.register({
    id: 'sessions',
    label: '会话',
    order: 80,
    render: function () { return '<div class="section" id="session-protection-host"></div>'; },
    mount: function (route) {
      var host = global.document.getElementById('session-protection-host');
      if (!host || !global.SessionProtectionPage) return false;
      global.SessionProtectionPage.mount(host, (route.params || {}).serverId || 'local');
      return true;
    },
    unmount: function () {
      if (global.SessionProtectionPage) global.SessionProtectionPage.unmount();
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
