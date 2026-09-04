#!/usr/bin/env node

import http from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function parseArgs(argv) {
  const args = { bell: true };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-bell') {
      args.bell = false;
    } else if (arg.startsWith('--') && i + 1 < argv.length) {
      args[arg.slice(2)] = argv[++i];
    }
  }
  return args;
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  if (!data.trim()) return {};
  try {
    return JSON.parse(data);
  } catch {
    return { message: data.trim() };
  }
}

function shouldBell(event) {
  return !new Set(['session_end', 'session_ended', 'process_exit', 'process_exited']).has(event);
}

function localPanelToken() {
  try {
    const file = join(homedir(), '.config', 'tmux-web-panel', 'tokens.json');
    const entries = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(entries)) return '';
    const now = Date.now();
    const valid = entries.find((entry) => {
      const meta = Array.isArray(entry) ? entry[1] : null;
      return meta && (meta.expiresAt === null || Number(meta.expiresAt) > now);
    });
    return valid && typeof valid[0] === 'string' ? valid[0] : '';
  } catch {
    return '';
  }
}

function postJson(url, payload, token) {
  if (!url) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const target = new URL(url);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'POST',
      headers,
      rejectUnauthorized: !(target.hostname === '127.0.0.1' || target.hostname === 'localhost'),
      timeout: 4000,
    }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('timeout', () => {
      req.destroy(new Error('request timed out'));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const args = parseArgs(process.argv);
const input = await readStdin();
const event = args.event || input.hook_event_name || input.event || 'notification';
const payload = {
  ...input,
  agent: args.agent || input.agent || input.source || 'agent',
  event,
  session: args.session || input.session || input.tmux_session,
  windowIndex: args.windowIndex ?? args['window-index'] ?? input.windowIndex ?? input.window_index,
  windowId: args.windowId || args['window-id'] || input.windowId || input.window_id,
  paneId: args.paneId || args['pane-id'] || input.paneId || input.pane_id,
  tty: args.tty || input.tty || process.env.TTY || '',
};

if (args.bell && shouldBell(event)) {
  try {
    writeFileSync('/dev/tty', '\u0007');
  } catch {
    // Best effort.
  }
}

const panelUrl = args.panelUrl || args['panel-url'] || process.env.TMUX_WEB_PANEL_AGENT_EVENTS_URL || 'https://127.0.0.1:7681/api/agent-events';
const panelToken = args.panelToken || args['panel-token'] || process.env.TMUX_WEB_PANEL_TOKEN || localPanelToken();
const monitorUrl = args.monitorUrl || args['monitor-url'] || process.env.AGENT_MONITOR_URL || '';
const monitorToken = args.monitorToken || args['monitor-token'] || process.env.AGENT_MONITOR_TOKEN || '';

await Promise.allSettled([
  postJson(panelUrl, payload, panelToken),
  postJson(monitorUrl, payload, monitorToken),
]);
