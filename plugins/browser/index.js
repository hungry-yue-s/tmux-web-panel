// The browser block: a page of this machine's localhost, or any URL, beside
// the terminal (client/js/browser-block.js), with its command and
// `twp open <url>` from a pane. Only a front end: it adds nothing to the
// server, and a Node-only installation has no pages to put it on.

export const name = 'browser';

export function apply(ctx) {
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
