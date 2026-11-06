/**
 * Lazygit config scanner
 * Scans lazygit config YAML and extracts custom commands and OSC52 clipboard setting.
 * Uses minimal line-by-line parsing to avoid external YAML library dependency.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_CONFIG_FILE = join(homedir(), '.config', 'lazygit', 'config.yml');

const EMPTY_RESULT = {
  hasCustomConfig: false,
  hasOsc52: false,
  customCommands: [],
  sourceFile: null,
};

/**
 * Detect OSC52 clipboard usage in config content.
 * Looks for copyToClipboardCmd containing osc52 references.
 *
 * @param {string} content
 * @returns {boolean}
 */
function detectOsc52(content) {
  return /copyToClipboardCmd\s*:.*osc52/i.test(content);
}

/**
 * Parse customCommands block from lazygit config content.
 * Extracts key and description from list items under customCommands:
 *
 * Supports YAML list item format:
 *   - key: '<c-a>'
 *     description: 'Some description'
 *
 * @param {string} content
 * @returns {Array<{ key: string, description?: string }>}
 */
function parseCustomCommands(content) {
  const lines = content.split('\n');
  const commands = [];

  let inCustomCommands = false;
  let currentCmd = null;

  for (const line of lines) {
    // Detect start of customCommands block (top-level key, no leading spaces)
    if (/^customCommands\s*:/.test(line)) {
      inCustomCommands = true;
      continue;
    }

    // Exit customCommands block when we hit another top-level key
    if (inCustomCommands && /^[a-zA-Z]/.test(line) && !/^\s/.test(line)) {
      if (currentCmd) {
        commands.push(currentCmd);
        currentCmd = null;
      }
      inCustomCommands = false;
      continue;
    }

    if (!inCustomCommands) continue;

    // New list item starting with key field: '  - key: <value>'
    // Supports both quoted and unquoted values
    const listItemMatch = line.match(/^\s+-\s+key\s*:\s*(.+)$/);
    if (listItemMatch) {
      // Save previous command if any
      if (currentCmd) {
        commands.push(currentCmd);
      }
      const rawKey = listItemMatch[1].trim().replace(/^['"]|['"]$/g, '');
      currentCmd = { key: rawKey };
      continue;
    }

    // Description field for current command
    if (currentCmd) {
      const descMatch = line.match(/^\s+description\s*:\s*['"]?(.+?)['"]?\s*$/);
      if (descMatch) {
        currentCmd = { ...currentCmd, description: descMatch[1].trim() };
      }
    }
  }

  // Flush last command
  if (currentCmd) {
    commands.push(currentCmd);
  }

  return commands;
}

/**
 * Scan lazygit config file for custom commands and OSC52 clipboard setting.
 *
 * @param {{ configFile?: string }} options
 * @returns {Promise<{
 *   hasCustomConfig: boolean,
 *   hasOsc52: boolean,
 *   customCommands: Array<{ key: string, description?: string }>,
 *   sourceFile: string | null
 * }>}
 */
export async function scanLazygit({ configFile = DEFAULT_CONFIG_FILE } = {}) {
  let content;
  try {
    content = await readFile(configFile, 'utf8');
  } catch {
    return EMPTY_RESULT;
  }

  const hasOsc52 = detectOsc52(content);
  const customCommands = parseCustomCommands(content);

  return {
    hasCustomConfig: true,
    hasOsc52,
    customCommands,
    sourceFile: configFile,
  };
}
