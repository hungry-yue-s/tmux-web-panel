// What used to be blocks-workspace.js, now each part in the plugin that owns
// it: the Git block and chip (git), the browser block (browser), the file
// commands (files), and the workspace's own commands and pickers (ui). Joined
// after the slots they register into, for tests that load all of them at once.

import { readFileSync } from 'node:fs';

export const WORKSPACE_BLOCK_SCRIPTS = [
  'plugins/ui/client/js/slots.js',
  'plugins/git/client/js/git-block.js',
  'plugins/browser/client/js/browser-block.js',
  'plugins/files/client/js/files-commands.js',
  'plugins/ui/client/js/workspace-commands.js',
];

export const WORKSPACE_BLOCKS = WORKSPACE_BLOCK_SCRIPTS.map((path) => readFileSync(path, 'utf8')).join('\n;\n');

// What used to be blocks.js: the block kit (ui), then the file preview's
// renderers it holds for each plugin: patches, the editor and the board
// (files), notebooks (notebook), SQLite (sqlite). The Git gutter and the
// preview's Git item come with the Git block, in WORKSPACE_BLOCKS.
export const BLOCK_SCRIPTS = [
  'plugins/ui/client/js/blocks-kit.js',
  'plugins/files/client/js/file-blocks.js',
  'plugins/notebook/client/js/notebook-block.js',
  'plugins/sqlite/client/js/sqlite-block.js',
];

export const BLOCKS = BLOCK_SCRIPTS.map((path) => readFileSync(path, 'utf8')).join('\n;\n');
