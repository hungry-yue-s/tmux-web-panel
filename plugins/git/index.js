// Git: the Git block beside the terminal, the git status chip in the top bar
// and the Git command (client/), and /api/git for them (lib/api/git.js):
// status, diffs, history, staging and commits of the repository a path
// belongs to, within the file roots (root CLAUDE.md, 文件预览分窗契约).

import { createGitRouter } from '../../lib/api/git.js';

export const name = 'git';

export const inject = ['http', 'fileAccess'];

export function apply(ctx) {
  ctx.http.mount('/api/git', createGitRouter({ pathGuard: ctx.fileAccess.pathGuard }));
  // The front end, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
