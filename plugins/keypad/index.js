// The mobile key drawer (root CLAUDE.md, 移动端工具盘交互契约): extra keys and
// scenes for what a pane runs. On the server, scene discovery
// (/api/scene/discover, lib/scene-discover/): the drawer seeds its scenes
// from this machine's lazygit, vim, Claude and terminal configuration. On the
// page, the drawer itself (client/js/fab-*.js); the terminal opens it when it
// is there and has no drawer when this plugin is off.

import { createSceneDiscoverRouter } from '../../lib/api/scene-discover.js';

export const name = 'keypad';

export const inject = ['http'];

export function apply(ctx) {
  ctx.http.mount('/api/scene/discover', createSceneDiscoverRouter());
  // The front end, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
