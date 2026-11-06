// Files on this machine: browse and preview (/api/files), and `ctx.fileAccess`,
// the roots every file route is confined to and the guard that checks a path
// against them. The plugins that act on files (git, sqlite, notebook, open)
// use that guard; uploads are their own plugin.
//
// The roots are the home directories and /tmp; on Windows the MSYS2 homes,
// since panes run MSYS2 shells and report MSYS paths.

import { homedir } from 'node:os';
import { IS_WINDOWS, msysHomeRoots } from '../../lib/msys.js';
import { createFilesRouter, createPathGuard } from '../../lib/api/files.js';

export const name = 'files';

export const inject = ['http'];

/** @param {{ roots?: string[] }} [config] */
export function apply(ctx, config) {
  const roots = config?.roots ?? (IS_WINDOWS ? [...msysHomeRoots(), '/tmp'] : [homedir(), '/tmp']);
  ctx.http.mount('/api/files', createFilesRouter(roots));
  ctx.provide('fileAccess', Object.freeze({ roots: Object.freeze([...roots]), pathGuard: createPathGuard(roots) }));
  // The front end, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
