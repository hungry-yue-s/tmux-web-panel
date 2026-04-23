/**
 * Vim/Neovim config scanner
 * Scans Neovim/Vim config files and extracts leader key and custom keymaps.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_CONFIG_FILES = [
  join(homedir(), '.config', 'nvim', 'init.lua'),
  join(homedir(), '.config', 'nvim', 'init.vim'),
  join(homedir(), '.config', 'nvim', 'lua', 'config', 'keymaps.lua'),
  join(homedir(), '.vimrc'),
];

/**
 * Extract mapleader value from config content.
 * Supports Lua: vim.g.mapleader = '...'
 * Supports VimScript: let mapleader='...'
 *
 * @param {string} content
 * @returns {string | null}
 */
function extractLeader(content) {
  // Lua syntax: vim.g.mapleader = '...' or vim.g.mapleader = "..."
  const luaMatch = content.match(/vim\.g\.mapleader\s*=\s*['"](.*)['"]/ );
  if (luaMatch) return luaMatch[1];

  // VimScript syntax: let mapleader='...' or let mapleader="..."
  const vimMatch = content.match(/let\s+mapleader\s*=\s*['"](.*)['"]/ );
  if (vimMatch) return vimMatch[1];

  return null;
}

/**
 * Extract custom keymaps from config content.
 * Supports Lua: vim.keymap.set('n', '<key>', ..., { desc = '...' })
 * Supports VimScript: nnoremap <key> :cmd<CR>
 *
 * @param {string} content
 * @returns {Array<{ key: string, desc: string }>}
 */
function extractKeymaps(content) {
  const keymaps = [];

  // Lua: vim.keymap.set('n', '<key>', ..., { desc = '...' })
  const luaRegex = /vim\.keymap\.set\(\s*'n'\s*,\s*'([^']+)'[^)]*\{\s*desc\s*=\s*'([^']*)'/g;
  let match;
  while ((match = luaRegex.exec(content)) !== null) {
    keymaps.push({ key: match[1], desc: match[2] });
  }

  // VimScript: nnoremap <key> :cmd<CR>
  const vimRegex = /^[ \t]*nnoremap\s+(<[^>]+>)\s+(.+)$/gm;
  while ((match = vimRegex.exec(content)) !== null) {
    keymaps.push({ key: match[1], desc: match[2].trim() });
  }

  return keymaps;
}

/**
 * Scan Vim/Neovim config files for leader key and custom keymaps.
 *
 * @param {{ configFiles?: string[] }} options
 * @returns {Promise<{ leaderKey: string | null, customKeymaps: Array<{ key: string, desc: string }>, sourceFile: string | null }>}
 */
export async function scanVim({ configFiles = DEFAULT_CONFIG_FILES } = {}) {
  for (const filePath of configFiles) {
    let content;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      // File missing or unreadable — try next
      continue;
    }

    const leaderKey = extractLeader(content);
    const customKeymaps = extractKeymaps(content);

    return {
      leaderKey,
      customKeymaps,
      sourceFile: filePath,
    };
  }

  // No readable config file found
  return {
    leaderKey: null,
    customKeymaps: [],
    sourceFile: null,
  };
}
