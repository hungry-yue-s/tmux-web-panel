// The mobile key drawer (root CLAUDE.md, 移动端工具盘交互契约): extra keys and
// scenes for what a pane runs. The server side is scene discovery
// (/api/scene/discover, lib/scene-discover/): the drawer seeds its scenes
// from this machine's lazygit, vim, Claude and terminal configuration.

import { createSceneDiscoverRouter } from '../../lib/api/scene-discover.js';

export const name = 'keypad';

export const inject = ['http'];

export function apply(ctx) {
  ctx.http.mount('/api/scene/discover', createSceneDiscoverRouter());
}
