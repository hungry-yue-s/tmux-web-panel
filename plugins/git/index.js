// Git for the Git block (/api/git, lib/api/git.js): status, diffs, history,
// staging and commits of the repository a path belongs to, within the file
// roots (root CLAUDE.md, 文件预览分窗契约).

import { createGitRouter } from '../../lib/api/git.js';

export const name = 'git';

export const inject = ['http', 'fileAccess'];

export function apply(ctx) {
  ctx.http.mount('/api/git', createGitRouter({ pathGuard: ctx.fileAccess.pathGuard }));
}
