#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');
const ROUTER = join(PROJECT_ROOT, 'scripts', 'agent-event-router.js');
const PANEL_URL = 'https://127.0.0.1:7681/api/agent-events';
const MARKER_PREFIX = 'tmux-web-panel-';

const AGENTS = {
  qoder: {
    path: join(homedir(), '.qoder', 'settings.json'),
    root() { return {}; },
    hooks(root) {
      root.hooks = root.hooks || {};
      return root.hooks;
    },
  },
  codex: {
    path: join(homedir(), '.codex', 'hooks.json'),
    root() { return { description: 'Codex hooks.', hooks: {} }; },
    hooks(root) {
      root.hooks = root.hooks || {};
      return root.hooks;
    },
  },
};

const EVENT_SPECS = [
  ['Stop', 'agent_stop', true],
  ['PermissionRequest', 'permission_wait', true],
  ['Notification', 'notification', true],
  ['StopFailure', 'stop_failure', true],
  ['SessionEnd', 'session_end', false],
  ['SubagentStop', 'agent_stop', false],
];

function usage() {
  console.log('Usage: node scripts/install-agent-hooks.js [qoder|codex|all] [--uninstall]');
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback();
    throw err;
  }
}

async function backup(file) {
  if (!existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const dest = `${file}.bak-${stamp}`;
  await copyFile(file, dest);
  return dest;
}

function hookFor(agent, hookEvent, eventName, bell) {
  return {
    type: 'command',
    command: ROUTER,
    args: [
      '--agent', hookEvent === 'SubagentStop' ? `${agent}-subagent` : agent,
      '--event', eventName,
      '--panel-url', PANEL_URL,
      ...(bell ? [] : ['--no-bell']),
    ],
    name: `${MARKER_PREFIX}${agent}-${hookEvent}`,
    async: true,
    timeout: 5,
  };
}

function installedNames(agent, hookEvent) {
  const names = [`${MARKER_PREFIX}${agent}-${hookEvent}`];
  if (agent === 'qoder') names.push(`${MARKER_PREFIX}${hookEvent}`);
  return names;
}

function installHooks(agent, root) {
  const hooks = AGENTS[agent].hooks(root);
  let added = 0;
  for (const [hookEvent, eventName, bell] of EVENT_SPECS) {
    const list = Array.isArray(hooks[hookEvent]) ? hooks[hookEvent] : [];
    const names = installedNames(agent, hookEvent);
    const exists = list.some((entry) => Array.isArray(entry.hooks) && entry.hooks.some((h) => h && names.includes(h.name)));
    if (!exists) {
      list.push({ matcher: '*', hooks: [hookFor(agent, hookEvent, eventName, bell)] });
      added += 1;
    }
    hooks[hookEvent] = list;
  }
  return { added };
}

function uninstallHooks(agent, root) {
  const hooks = AGENTS[agent].hooks(root);
  let removed = 0;
  for (const hookEvent of Object.keys(hooks)) {
    const list = Array.isArray(hooks[hookEvent]) ? hooks[hookEvent] : [];
    const next = [];
    for (const entry of list) {
      if (!Array.isArray(entry.hooks)) {
        next.push(entry);
        continue;
      }
      const before = entry.hooks.length;
      entry.hooks = entry.hooks.filter((h) => {
        if (!(h && typeof h.name === 'string')) return true;
        if (h.name.startsWith(`${MARKER_PREFIX}${agent}-`)) return false;
        return !(agent === 'qoder' && installedNames(agent, hookEvent).includes(h.name));
      });
      removed += before - entry.hooks.length;
      if (entry.hooks.length > 0) next.push(entry);
    }
    if (next.length > 0) hooks[hookEvent] = next;
    else delete hooks[hookEvent];
  }
  return { removed };
}

async function update(agent, uninstall) {
  const spec = AGENTS[agent];
  const root = await readJson(spec.path, spec.root);
  await mkdir(dirname(spec.path), { recursive: true });
  const backupPath = await backup(spec.path);
  const result = uninstall ? uninstallHooks(agent, root) : installHooks(agent, root);
  await writeFile(spec.path, JSON.stringify(root, null, 2) + '\n');
  return { agent, path: spec.path, backup: backupPath, ...result };
}

const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall') || args.includes('--remove');
const target = args.find((arg) => !arg.startsWith('--')) || 'all';
if (!['qoder', 'codex', 'all'].includes(target)) {
  usage();
  process.exit(1);
}

const targets = target === 'all' ? ['qoder', 'codex'] : [target];
const results = [];
for (const agent of targets) results.push(await update(agent, uninstall));
console.log(JSON.stringify({ ok: true, uninstall, results }, null, 2));
console.log('No bearer token was written to agent configuration. The router uses TMUX_WEB_PANEL_TOKEN or the local tmux-web-panel token store.');
