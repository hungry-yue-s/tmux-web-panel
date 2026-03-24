#!/usr/bin/env node

import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_DIR = join(homedir(), '.claude');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
const BACKUP_PATH = join(CLAUDE_DIR, 'settings.json.bak');

const BELL_COMMAND =
  "PID=$PPID; while [ -n \"$PID\" ] && [ \"$PID\" != \"1\" ]; do " +
  "T=$(ps -o tty= -p $PID 2>/dev/null | tr -d ' '); " +
  "if [ -n \"$T\" ] && [ \"$T\" != \"?\" ]; then printf '\\a' > /dev/$T; break; fi; " +
  "PID=$(ps -o ppid= -p $PID 2>/dev/null | tr -d ' '); done";

const BELL_MARKER = "printf '\\a'";

function hasBellHook(settings) {
  const stopHooks = settings?.hooks?.Stop;
  if (!Array.isArray(stopHooks)) return false;
  return stopHooks.some((entry) =>
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => h.command && h.command.includes(BELL_MARKER)),
  );
}

function removeBellHook(settings) {
  const stopHooks = settings?.hooks?.Stop;
  if (!Array.isArray(stopHooks)) return false;

  let removed = false;
  for (let i = stopHooks.length - 1; i >= 0; i--) {
    const entry = stopHooks[i];
    if (!Array.isArray(entry.hooks)) continue;

    entry.hooks = entry.hooks.filter((h) => {
      if (h.command && h.command.includes(BELL_MARKER)) {
        removed = true;
        return false;
      }
      return true;
    });

    if (entry.hooks.length === 0) {
      stopHooks.splice(i, 1);
    }
  }
  return removed;
}

function addBellHook(settings) {
  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];

  settings.hooks.Stop.push({
    hooks: [
      {
        type: 'command',
        command: BELL_COMMAND,
        timeout: 5,
      },
    ],
  });
}

async function readSettings() {
  try {
    const content = await readFile(SETTINGS_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeSettings(settings) {
  await mkdir(CLAUDE_DIR, { recursive: true });
  try {
    await copyFile(SETTINGS_PATH, BACKUP_PATH);
  } catch {
    // No existing file to back up
  }
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

async function install() {
  const settings = await readSettings();

  if (hasBellHook(settings)) {
    console.log('\u2713 Bell hook already installed in ' + SETTINGS_PATH);
    return;
  }

  addBellHook(settings);
  await writeSettings(settings);

  console.log('\u2713 Bell hook installed to ' + SETTINGS_PATH);
  console.log('  Claude Code will now send terminal bell on task completion.');
  console.log('  Restart is not required \u2014 existing sessions will pick up the change.');
}

async function uninstall() {
  const settings = await readSettings();

  if (!hasBellHook(settings)) {
    console.log('\u2713 No bell hook found in ' + SETTINGS_PATH);
    return;
  }

  removeBellHook(settings);
  await writeSettings(settings);

  console.log('\u2713 Bell hook removed from ' + SETTINGS_PATH);
}

const args = process.argv.slice(2);
if (args.includes('--uninstall') || args.includes('--remove')) {
  uninstall().catch((err) => { console.error('Error:', err.message); process.exit(1); });
} else {
  install().catch((err) => { console.error('Error:', err.message); process.exit(1); });
}
