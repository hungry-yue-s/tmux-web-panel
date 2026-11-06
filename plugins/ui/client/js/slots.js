// Places in the shell that other plugins fill.
//
// A plugin's script registers what it adds to the shell (a section of a
// server's page, a section of the settings page), and the shell renders what
// is registered. A plugin that is turned off has no scripts on the page, so
// its sections are simply not there: the shell never names another plugin's
// feature. Loaded before every other script.

(function (global) {
  'use strict';
  // Loaded twice (a test, a cached page), the first registrations stay.
  if (global.PanelSlots) return;

  function slot() {
    var items = [];
    return {
      /** Adds an item (`id` unique, `order` sorts) and returns a function that removes it. */
      register: function (item) {
        if (!item || typeof item.id !== 'string') throw new TypeError('a slot item needs an id');
        items = items.filter(function (other) { return other.id !== item.id; });
        items.push(item);
        items.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
        return function () {
          items = items.filter(function (other) { return other !== item; });
        };
      },
      /** The item with this id, or that lists it among its `aliases`. */
      get: function (id) {
        for (var i = 0; i < items.length; i++) {
          if (items[i].id === id || (items[i].aliases || []).indexOf(id) >= 0) return items[i];
        }
        return null;
      },
      list: function () {
        return items.slice();
      },
    };
  }

  global.PanelSlots = {
    /**
     * Sections of a server's page (#/servers/:serverId/:section), in tab order:
     *   { id, label, order, aliases?, monitor?, visible?(ui), render(route) → html, mount?(route), unmount?() }
     * A `monitor` section is a status page: the page-visibility settings
     * (visible(ui)) can hide it, and the first visible one is the default.
     * mount runs once its HTML is in the page and returns whether it started;
     * unmount runs when the route leaves.
     */
    serverSections: slot(),
    /**
     * Sections of the settings page, in order:
     *   { id, label, order, render() → html, mount?(host) }
     */
    settingsSections: slot(),
    /**
     * Commands for the palette, the Alt+Shift shortcuts and the shortcut sheet:
     *   { id, order, group: 'block' | 'nav' | 'window', title, icon, keys, code, keywords, run() }
     * `code` is the KeyboardEvent.code that, with Alt+Shift, runs it.
     */
    commands: slot(),
    /**
     * What `twp open` from a pane does on the page, by event type (the id):
     *   { id: 'open-file' | 'open-url', run(event) }
     */
    openers: slot(),
  };
})(typeof window !== 'undefined' ? window : globalThis);
