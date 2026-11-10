// The window layout picker: preset layouts, resizing and swapping panes on a
// live preview (client/js/layout-picker.js), opened from split mode and with
// its shortcut. Only a front end: it works through the workspace API, by
// window and pane id, and a Node-only installation has no pages to put it on.

export const name = 'layouts';

export function apply(ctx) {
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
