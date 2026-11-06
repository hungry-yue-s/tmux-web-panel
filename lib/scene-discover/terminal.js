/**
 * Terminal history scanner for scene discovery.
 * Reads shell history, filters secrets, and returns top commands by frequency.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_HISTORY_FILES = [
  join(homedir(), '.zsh_history'),
  join(homedir(), '.bash_history'),
];

const SECRET_PATTERNS = [
  /password=/i,
  /token=/i,
  /secret=/i,
  /api_key=/i,
  /key=/i,
];

const MAX_LINES = 3000;
const TOP_N = 20;
const MAX_FULL_CMD_LEN = 60;

/**
 * Clean zsh extended history format: `: 1234567890:0;actual command` → `actual command`
 */
function cleanZshExtendedFormat(line) {
  const match = line.match(/^:\s*\d+:\d+;(.+)$/);
  return match ? match[1] : line;
}

/**
 * Check if a line contains a secret pattern and should be filtered.
 */
function containsSecret(line) {
  return SECRET_PATTERNS.some(pattern => pattern.test(line));
}

/**
 * Count occurrences of items in an array, returning sorted array of {command, count}.
 */
function countOccurrences(items) {
  const counts = new Map();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Try to read a file, returning null if not accessible.
 */
async function tryReadFile(filePath) {
  try {
    const content = await readFile(filePath, 'utf8');
    return { content, path: filePath };
  } catch {
    return null;
  }
}

/**
 * Scan shell history and return top commands by frequency.
 *
 * @param {Object} options
 * @param {string} [options.historyFile] - Override history file path
 * @returns {Promise<{sourceFile: string|null, topCommands: Array, topFullCommands: Array, aliases: Array, sampleSize: number}>}
 */
export async function scanTerminal({ historyFile } = {}) {
  const emptyResult = {
    sourceFile: null,
    topCommands: [],
    topFullCommands: [],
    aliases: [],
    sampleSize: 0,
  };

  const filesToTry = historyFile ? [historyFile] : DEFAULT_HISTORY_FILES;

  let fileResult = null;
  for (const filePath of filesToTry) {
    fileResult = await tryReadFile(filePath);
    if (fileResult !== null) break;
  }

  if (fileResult === null) {
    return emptyResult;
  }

  const { content, path: sourceFile } = fileResult;

  const allLines = content.split('\n');
  const recentLines = allLines.slice(-MAX_LINES);

  const cleanedLines = recentLines
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(cleanZshExtendedFormat)
    .filter(line => !containsSecret(line));

  const firstWords = cleanedLines
    .map(line => line.split(/\s+/)[0])
    .filter(word => word.length > 0);

  const fullCommands = cleanedLines
    .map(line => line.slice(0, MAX_FULL_CMD_LEN));

  const topCommands = countOccurrences(firstWords).slice(0, TOP_N);
  const topFullCommands = countOccurrences(fullCommands).slice(0, TOP_N);

  return {
    sourceFile,
    topCommands,
    topFullCommands,
    aliases: [],
    sampleSize: cleanedLines.length,
  };
}
