// Files on this machine: browse, preview, upload, and the blocks that act on
// previewable files — Git, SQLite, notebooks and `twp open`.
//
// Every path is checked against the allowed roots (the home directories and
// /tmp; on Windows the MSYS2 homes, since panes run MSYS2 shells and report
// MSYS paths). Uploads land in an installation-owned directory and are
// reported by the path a pane would use.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { IS_WINDOWS, msysHomeRoots, toNativePath, toPosixPath } from '../../lib/msys.js';
import { createUploadRouter } from '../../lib/api/upload.js';
import { createFilesRouter, createPathGuard } from '../../lib/api/files.js';
import { createGitRouter } from '../../lib/api/git.js';
import { createSqliteRouter } from '../../lib/api/sqlite.js';
import { createNotebookRouter, createOpenRouter } from '../../lib/api/open.js';

export const name = 'files';

export const inject = ['launch', 'http'];

/** @param {{ roots?: string[], uploadDir?: string }} [config] */
export function apply(ctx, config) {
  const launch = ctx.launch;
  const roots = config?.roots ?? (IS_WINDOWS ? [...msysHomeRoots(), '/tmp'] : [homedir(), '/tmp']);

  if (IS_WINDOWS) {
    const dir = config?.uploadDir ?? toNativePath('/tmp/tmux-web-panel-uploads');
    ctx.http.mount('/api/upload', createUploadRouter(dir, { displayPath: toPosixPath }), { json: false });
  } else {
    const dir = config?.uploadDir ?? (launch.managedRuntime ? join(launch.configDir, 'uploads') : '/tmp/tmux-web-panel-uploads');
    ctx.http.mount('/api/upload', createUploadRouter(dir), { json: false });
  }

  ctx.http.mount('/api/files', createFilesRouter(roots));
  const pathGuard = createPathGuard(roots);
  ctx.http.mount('/api/git', createGitRouter({ pathGuard }));
  ctx.http.mount('/api/sqlite', createSqliteRouter({ pathGuard }));
  ctx.http.mount('/api/notebook', createNotebookRouter({ pathGuard }));
  ctx.http.mount('/api/open', createOpenRouter({ pathGuard, broadcast: (event) => ctx.emit('status/event', event) }));
  // The front end, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
