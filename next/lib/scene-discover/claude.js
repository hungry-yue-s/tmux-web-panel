/**
 * Claude config scanner
 * Scans ~/.claude/commands for slash command markdown files
 * and extracts id + description from YAML frontmatter.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_COMMANDS_DIR = join(homedir(), '.claude', 'commands');

/**
 * Parse YAML frontmatter from markdown content.
 * Extracts only the `description` field.
 *
 * @param {string} content - Raw file content
 * @returns {{ description?: string }}
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const yaml = match[1];
  const descMatch = yaml.match(/^description:\s*(.+)$/m);
  return { description: descMatch ? descMatch[1].trim() : undefined };
}

/**
 * Recursively collect all .md files under a directory.
 * Returns entries as { filePath, relativeParts } where relativeParts
 * is the path segments relative to the root commandsDir.
 *
 * @param {string} dir - Directory to scan
 * @param {string} root - Root directory (used to compute relative path)
 * @returns {Promise<Array<{ filePath: string, relativeParts: string[] }>>}
 */
async function collectMdFiles(dir, root) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const results = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let info;
    try {
      info = await stat(fullPath);
    } catch {
      continue;
    }

    if (info.isDirectory()) {
      const nested = await collectMdFiles(fullPath, root);
      results.push(...nested);
    } else if (entry.endsWith('.md')) {
      // Build relative parts from root to this file (without extension)
      const relativePath = fullPath.slice(root.length + 1); // strip leading slash
      const parts = relativePath.replace(/\.md$/, '').split('/');
      results.push({ filePath: fullPath, relativeParts: parts });
    }
  }

  return results;
}

/**
 * Derive command id from relative path parts.
 * Top-level file: just the filename stem.
 * Nested file:    "dir:filename" (joining all parts with ':')
 *
 * @param {string[]} parts
 * @returns {string}
 */
function buildCommandId(parts) {
  return parts.join(':');
}

/**
 * Scan Claude commands directory for slash commands.
 *
 * @param {{ commandsDir?: string }} options
 * @returns {Promise<{ slashCommands: Array<{ id: string, description: string }>, skills: [], sourceDir: string }>}
 */
export async function scanClaude({ commandsDir = DEFAULT_COMMANDS_DIR } = {}) {
  const files = await collectMdFiles(commandsDir, commandsDir);

  const slashCommands = await Promise.all(
    files.map(async ({ filePath, relativeParts }) => {
      const id = buildCommandId(relativeParts);
      let description = '';

      try {
        const content = await readFile(filePath, 'utf8');
        const fm = parseFrontmatter(content);
        description = fm.description ?? '';
      } catch {
        // unreadable file — include command with empty description
      }

      return { id, description };
    })
  );

  return {
    slashCommands,
    skills: [],
    sourceDir: commandsDir,
  };
}
