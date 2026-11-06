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
