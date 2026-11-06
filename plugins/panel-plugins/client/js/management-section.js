// The settings page's management section, put there through PanelSlots
// (plugins/ui/client/js/slots.js). ManagementPage fills it.

(function (global) {
  'use strict';
  if (!global.PanelSlots) return;

  global.PanelSlots.settingsSections.register({
    id: 'management',
    label: '管理中心',
    order: 20,
    render: function () { return '<div id="managed-resources"></div>'; },
    mount: function (view) {
      if (!global.ManagementPage) return undefined;
      return global.ManagementPage.mount(view.querySelector('#managed-resources'));
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
