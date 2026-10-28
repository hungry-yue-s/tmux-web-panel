#!/usr/bin/env node
// twp — script the panel from inside a pane.
//
//   twp open [--preview] <file|url>   show a file in the panel's preview (or a page in the browser block)
//   twp split [-h] [-c dir] [cmd...]   split this pane, print the new pane id
//   twp run [-t pane] <cmd...>         type a command into a pane and press Enter
//   twp capture [-t pane] [-n lines]   print a pane's text (with scrollback)
//   twp events [--filter a,b]          stream workspace events as JSON lines
//
// `open` talks to this machine's panel with the node token from the pairing
// file; the others drive tmux directly, so open windows update live.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const USAGE = `usage:
  twp open [--preview] <file|url>
  twp split [-h] [-c dir] [cmd...]
  twp run [-t pane] <cmd...>
  twp capture [-t pane] [-n lines]
  twp events [--filter event,...]`;

function die(message, code = 1) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

function tmux(args, options = {}) {
  return execFileSync('tmux', args, { encoding: 'utf8', ...options });
}

function currentPane() {
  return process.env.TMUX_PANE || null;
}

function takeOption(args, names, { flag = false } = {}) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') return flag ? false : null;
    if (names.includes(args[i])) {
      if (flag) { args.splice(i, 1); return true; }
      const value = args[i + 1];
      if (value === undefined) die(`${args[i]} needs a value`);
      args.splice(i, 2);
      return value;
    }
  }
  return flag ? false : null;
}

function rest(args) {
  return args[0] === '--' ? args.slice(1) : args;
}

function readPairing() {
  const path = join(homedir(), '.config', 'tmux-web-panel', 'node.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return die(`twp: no panel on this machine (${path} not found)`);
  }
}

/** TLS socket whose certificate matches the pinned fingerprint, checked before any byte is sent. */
function pinnedSocket(pairing) {
  return new Promise((resolveSocket, reject) => {
    const socket = tls.connect({ host: pairing.host, port: pairing.port, rejectUnauthorized: false }, () => {
      const fingerprint = socket.getPeerCertificate().fingerprint256;
      if (fingerprint !== pairing.tlsFingerprint) {
        socket.destroy();
        reject(new Error('panel certificate does not match the pairing file'));
      } else resolveSocket(socket);
    });
    socket.on('error', reject);
  });
}

async function postJson(path, body) {
  const pairing = readPairing();
  const payload = JSON.stringify(body);
  const socket = pairing.tls ? await pinnedSocket(pairing) : null;
  const options = {
    host: pairing.host,
    port: pairing.port,
    path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      Authorization: `Bearer ${pairing.token}`,
    },
  };
  if (socket) options.createConnection = () => socket;
  return new Promise((resolveResponse, reject) => {
    const req = (pairing.tls ? https : http).request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ }
        if (res.statusCode >= 200 && res.statusCode < 300 && data && data.success !== false) resolveResponse(data.data);
        else reject(new Error((data && (data.error && data.error.message || data.error)) || `HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function cmdOpen(args) {
  takeOption(args, ['--preview', '-p'], { flag: true }); // previewing is the only mode; kept for muscle memory
  const target = rest(args)[0];
  if (!target) die(USAGE);
  const pane = currentPane();
  const body = /^https?:\/\//i.test(target)
    ? { url: target }
    : { path: target.startsWith('/') || target.startsWith('~') ? target : resolve(process.cwd(), target) };
  if (pane) body.paneId = pane;
  // Windows: a native cwd (C:\...) is converted by the panel; MSYS paths pass through.
  const result = await postJson('/api/open', body);
  process.stdout.write(`opened ${result.path || result.url}\n`);
}

function cmdSplit(args) {
  const horizontal = takeOption(args, ['-h'], { flag: true });
  const vertical = takeOption(args, ['-v'], { flag: true });
  const cwd = takeOption(args, ['-c', '--cwd']) || process.cwd();
  const target = takeOption(args, ['-t']) || currentPane();
  const command = rest(args);
  const tmuxArgs = ['split-window', '-P', '-F', '#{pane_id}', '-c', cwd];
  if (horizontal && !vertical) tmuxArgs.push('-h');
  if (target) tmuxArgs.push('-t', target);
  if (command.length) tmuxArgs.push(command.join(' '));
  process.stdout.write(tmux(tmuxArgs));
}

function cmdRun(args) {
  const target = takeOption(args, ['-t']) || currentPane();
  const command = rest(args).join(' ');
  if (!command) die(USAGE);
  const base = target ? ['-t', target] : [];
  tmux(['send-keys', ...base, '-l', command]);
  tmux(['send-keys', ...base, 'Enter']);
}

function cmdCapture(args) {
  const target = takeOption(args, ['-t']) || currentPane();
  const lines = Number.parseInt(takeOption(args, ['-n']) || '0', 10);
  const tmuxArgs = ['capture-pane', '-p', '-J'];
  if (target) tmuxArgs.push('-t', target);
  if (lines > 0) tmuxArgs.push('-S', String(-lines));
  process.stdout.write(tmux(tmuxArgs));
}

/** Pane ids in a tmux layout string: leaves are `WxH,X,Y,ID`. */
export function layoutPanes(layout) {
  const ids = new Set();
  const re = /\d+x\d+,\d+,\d+,(\d+)/g;
  let match;
  while ((match = re.exec(layout))) ids.add('%' + match[1]);
  return ids;
}

/** Turns one control-mode line into zero or more events. */
export function controlEvents(line, panesByWindow) {
  const parts = line.split(' ');
  const at = new Date().toISOString();
  switch (parts[0]) {
    case '%layout-change': {
      const windowId = parts[1];
      const next = layoutPanes(parts[2] || '');
      const previous = panesByWindow.get(windowId) || new Set();
      panesByWindow.set(windowId, next);
      const events = [];
      for (const id of next) if (!previous.has(id) && previous.size) events.push({ event: 'pane_spawned', at, windowId, paneId: id });
      for (const id of previous) if (!next.has(id)) events.push({ event: 'pane_closed', at, windowId, paneId: id });
      events.push({ event: 'layout_changed', at, windowId, layout: parts[2] });
      return events;
    }
    case '%window-add': return [{ event: 'window_added', at, windowId: parts[1] }];
    case '%window-close':
    case '%unlinked-window-close':
      panesByWindow.delete(parts[1]);
      return [{ event: 'window_closed', at, windowId: parts[1] }];
    case '%window-renamed': return [{ event: 'window_renamed', at, windowId: parts[1], name: parts.slice(2).join(' ') }];
    case '%window-pane-changed': return [{ event: 'pane_focused', at, windowId: parts[1], paneId: parts[2] }];
    case '%session-window-changed': return [{ event: 'window_focused', at, sessionId: parts[1], windowId: parts[2] }];
    case '%sessions-changed': return [{ event: 'sessions_changed', at }];
    case '%session-renamed': return [{ event: 'session_renamed', at, sessionId: parts[1], name: parts.slice(2).join(' ') }];
    case '%pane-mode-changed': return [{ event: 'pane_mode_changed', at, paneId: parts[1] }];
    case '%exit': return [{ event: 'exit', at }];
    default: return [];
  }
}

function cmdEvents(args) {
  const filter = takeOption(args, ['--filter', '-f']);
  const wanted = filter ? new Set(filter.split(',').map((name) => name.trim()).filter(Boolean)) : null;
  const panesByWindow = new Map();
  try {
    for (const row of tmux(['list-windows', '-a', '-F', '#{window_id} #{window_layout}']).split('\n')) {
      const [id, layout] = row.split(' ');
      if (id) panesByWindow.set(id, layoutPanes(layout || ''));
    }
  } catch {
    die('twp: no tmux server');
  }
  // A read-only control client that ignores sizes and pane output: it only listens.
  const child = spawn('tmux', ['-C', 'attach-session', '-f', 'read-only,ignore-size,no-output'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buffered = '';
  child.stdout.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline).replace(/\r$/, '');
      buffered = buffered.slice(newline + 1);
      for (const event of controlEvents(line, panesByWindow)) {
        if (!wanted || wanted.has(event.event)) process.stdout.write(JSON.stringify(event) + '\n');
      }
    }
  });
  child.on('exit', (code) => process.exit(code || 0));
  process.on('SIGINT', () => { child.stdin.end(); child.kill(); });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'open': return cmdOpen(args);
    case 'split': return cmdSplit(args);
    case 'run': return cmdRun(args);
    case 'capture': return cmdCapture(args);
    case 'events': return cmdEvents(args);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE + '\n');
      return undefined;
    default:
      return die(USAGE);
  }
}

const invokedDirectly = process.argv[1] && /twp(\.mjs)?$/.test(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  main().catch((error) => die(`twp: ${error.message}`));
}
