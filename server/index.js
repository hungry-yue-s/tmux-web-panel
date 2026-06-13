import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import express from 'express';
import { WebSocketServer } from 'ws';
import {
  hashPassword,
  verifyPassword,
  createToken,
  deleteToken,
  tokenAuth,
  wsTokenAuth,
  startTokenReaper,
  initTokenPersistence,
} from './auth.js';
import * as tmux from './tmux.js';
import { TerminalManager } from './terminal.js';
import { StatusMonitor } from './monitor.js';
import sessionsRouter from './api/sessions.js';
import windowsRouter from './api/windows.js';
import { nestedPanesRouter, flatPanesRouter } from './api/panes.js';
import { createUploadRouter } from './api/upload.js';
import { createFilesRouter } from './api/files.js';
import systemStatsRouter from './api/system-stats.js';
import windowStatsRouter from './api/window-stats.js';
import perfHistoryRouter, { startSampler as startPerfHistorySampler } from './api/perf-history.js';
import perfDrilldownRouter from './api/perf-drilldown.js';
import { NotificationStore } from './notifications.js';
import { createNotificationsRouter } from './api/notifications.js';
import { createSceneDiscoverRouter } from './api/scene-discover.js';
import createClaudeUsageRouter from './api/claude-usage.js';
import createCodexUsageRouter from './api/codex-usage.js';
import { PinStore } from './pins.js';
import { createPinsRouter } from './api/pins.js';
import { ShareStore } from './share-store.js';
import { createShareRouter } from './api/share.js';

// --- CLI Argument Parsing ---

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--') && i + 1 < argv.length) {
      const key = arg.slice(2);
      args[key] = argv[++i];
    }
  }
  return args;
}

const cliArgs = parseArgs(process.argv);

const tlsCert = cliArgs['tls-cert'] ?? process.env.TLS_CERT ?? null;
const tlsKey = cliArgs['tls-key'] ?? process.env.TLS_KEY ?? null;

const config = Object.freeze({
  port: Number(cliArgs.port ?? process.env.PORT ?? 7681),
  host: cliArgs.host ?? process.env.HOST ?? '0.0.0.0',
  auth: cliArgs.auth ?? process.env.AUTH ?? null,
  pollInterval: Number(
    cliArgs['poll-interval'] ?? process.env.POLL_INTERVAL ?? 3000,
  ),
  maxConnections: Number(
    cliArgs['max-connections'] ?? process.env.MAX_CONNECTIONS ?? 5,
  ),
  tls: tlsCert && tlsKey ? { cert: tlsCert, key: tlsKey } : null,
});

// --- Express App ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Parse JSON request bodies (before auth routes that need it)
app.use(express.json());

// --- Auth Setup ---

const tokenMap = new Map();
let authUser = null;
let authSalt = null;
let authHash = null;

if (config.auth) {
  const colonIndex = config.auth.indexOf(':');
  authUser = config.auth.slice(0, colonIndex);
  const rawPass = config.auth.slice(colonIndex + 1);
  const hashed = hashPassword(rawPass);
  authSalt = hashed.salt;
  authHash = hashed.hash;

  // Restore persisted tokens (survives restarts)
  const tokenFile = join(homedir(), '.config', 'tmux-web-panel', 'tokens.json');
  initTokenPersistence(tokenMap, tokenFile);

  // --- Public auth routes (no token required) ---

  app.post('/api/auth/login', (req, res) => {
    const { username, password, trusted } = req.body || {};

    if (
      username === authUser &&
      password &&
      verifyPassword(password, authSalt, authHash)
    ) {
      const token = createToken(tokenMap, { trusted: !!trusted });
      res.json({ success: true, data: { token, trusted: !!trusted }, error: null });
      return;
    }

    res.status(401).json({
      success: false,
      data: null,
      error: 'Invalid username or password',
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    const authHeader = req.headers.authorization || '';
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      deleteToken(tokenMap, parts[1]);
    }
    res.json({ success: true, data: null, error: null });
  });

}

// Serve static files from public/ (publicly accessible — client JS handles auth redirect)
app.use(express.static(join(__dirname, '..', 'public'), { etag: false, maxAge: 0 }));

// --- Token auth middleware (protects API routes below) ---

if (config.auth) {
  app.use('/api', tokenAuth(tokenMap));
}

// API status route
app.get('/api/status', async (_req, res) => {
  try {
    const sessions = await tmux.listSessions();
    const totalWindows = sessions.reduce((sum, s) => sum + s.windows, 0);
    res.json({
      success: true,
      data: { sessions: sessions.length, windows: totalWindows },
      error: null,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      data: null,
      error: err.message,
    });
  }
});

// --- Notification Store (must be initialized before mounting routes) ---

const notificationStore = new NotificationStore(
  join(homedir(), '.config', 'tmux-web-panel', 'notifications.json'),
);

// --- Pin Store (window-id pinning, persisted across restarts) ---

const pinStore = new PinStore(
  join(homedir(), '.config', 'tmux-web-panel', 'pins.json'),
);
await pinStore.load();

// --- Share Store (file-preview snapshots shared via /s/:id, persisted) ---

const shareStore = new ShareStore(
  join(homedir(), '.config', 'tmux-web-panel', 'shares.json'),
);
await shareStore.load();

// Public viewer for shared snapshots — registered OUTSIDE the /api auth gate so
// recipients on the LAN need no panel login. Snapshots are self-contained
// (images inlined), so this only ever reads the snapshot dir — never the FS.
const SHARE_ID_RE = /^[A-Za-z0-9_-]{16,48}$/;
app.get('/s/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!SHARE_ID_RE.test(id)) return _shareGone(res);
    const snap = await shareStore.get(id);
    if (!snap) return _shareGone(res);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cache-Control', 'no-store');
    res.type('html').send(snap.html);
  } catch {
    res.status(500).type('html').send('<h1>500</h1>');
  }
});

function _shareGone(res) {
  res.status(410).type('html').send(
    '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>链接已失效</title>'
    + '<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;'
    + 'font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0d1117;color:#c9d1d9;text-align:center">'
    + '<div><div style="font-size:42px;margin-bottom:12px">🔗</div>'
    + '<h2 style="margin:0 0 6px">链接已过期或不存在</h2>'
    + '<p style="color:#8b949e;margin:0">分享可能已被回收或已超过有效期。</p></div></body>',
  );
}

// Best-effort startup sweep — drop orphan pins from prior tmux sessions.
try {
  const live = await tmux.listAllWindowIds();
  await pinStore.sweep(live);
} catch {
  // Startup sweep failure is non-fatal.
}

// Ensure the global pane-border title line is on so pane labels render.
// Best-effort: tmux server may not be up yet (the panel never auto-starts it).
await tmux.ensurePaneBorderConfig().catch(() => {});

// Mount API routes
app.use('/api/sessions', sessionsRouter);
app.use('/api/sessions/:name/windows', windowsRouter);
app.use('/api/sessions/:name/windows/:index/panes', nestedPanesRouter);
app.use('/api/panes', flatPanesRouter);
app.use('/api/system-stats', systemStatsRouter);
app.use('/api/perf/history', perfHistoryRouter);
app.use('/api/perf/drilldown', perfDrilldownRouter);
app.use('/api/window-stats', windowStatsRouter);
app.use('/api/notifications', createNotificationsRouter(notificationStore));
app.use('/api/scene/discover', createSceneDiscoverRouter());
app.use('/api/pins', createPinsRouter(pinStore));
app.use('/api/share', createShareRouter(shareStore));

// File upload (uses /tmp — cleaned by OS on reboot)
app.use('/api/upload', createUploadRouter('/tmp/tmux-web-panel-uploads'));
app.use('/api/files', createFilesRouter([homedir(), '/tmp']));
app.use('/api/claude-usage', createClaudeUsageRouter());
app.use('/api/codex-usage', createCodexUsageRouter());

// --- HTTP(S) + WebSocket Server ---

const server = config.tls
  ? createSecureServer(
      {
        cert: readFileSync(config.tls.cert),
        key: readFileSync(config.tls.key),
      },
      app,
    )
  : createServer(app);

const wss = new WebSocketServer({ noServer: true });

const terminalManager = new TerminalManager({
  maxConnectionsPerPane: config.maxConnections,
});

const statusMonitor = new StatusMonitor({ notificationStore });

server.on('upgrade', (req, socket, head) => {
  const proto = config.tls ? 'https' : 'http';
  const url = new URL(req.url, `${proto}://${req.headers.host}`);

  // Enforce auth on WebSocket upgrade if configured
  if (config.auth) {
    if (!wsTokenAuth(tokenMap, req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  if (url.pathname.startsWith('/ws/terminal/')) {
    // Extract paneId (URL decode %250 → %0)
    const paneId = decodeURIComponent(url.pathname.split('/ws/terminal/')[1]);

    // Parse optional cols/rows/nozoom from query string
    const cols = Number(url.searchParams.get('cols')) || 80;
    const rows = Number(url.searchParams.get('rows')) || 24;
    const nozoom = url.searchParams.get('nozoom') === '1';

    wss.handleUpgrade(req, socket, head, (ws) => {
      terminalManager.create(ws, paneId, cols, rows, nozoom);
    });
    return;
  }

  if (url.pathname === '/ws/status') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      statusMonitor.subscribe(ws);
      ws.on('close', () => statusMonitor.unsubscribe(ws));
    });
    return;
  }

  // Unknown WebSocket path — reject
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

// --- Graceful Shutdown ---

function shutdown(signal) {
  console.log(`\n${signal} received — shutting down...`);

  // Stop token reaper
  if (tokenReapTimer) clearInterval(tokenReapTimer);

  // Stop share-snapshot sweeper
  if (shareSweepTimer) clearInterval(shareSweepTimer);

  // Stop status monitor polling
  statusMonitor.stop();

  // Stop notification reaper
  notificationStore.stopReaper();

  // Destroy all terminal PTY connections
  terminalManager.destroyAll();

  // Close all WebSocket connections
  for (const client of wss.clients) {
    client.close(1001, 'Server shutting down');
  }

  // Close HTTP redirect server if running
  if (httpRedirectServer) {
    httpRedirectServer.close();
  }

  wss.close(() => {
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
  });

  // Force exit after 5 seconds if graceful shutdown stalls
  setTimeout(() => {
    console.error('Forced exit after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Start ---

statusMonitor.start(config.pollInterval);
terminalManager.startReaper();
notificationStore.startReaper();
const tokenReapTimer = config.auth ? startTokenReaper(tokenMap) : null;
// Sweep expired shares every 10 minutes.
const shareSweepTimer = setInterval(() => { shareStore.sweep().catch(() => {}); }, 10 * 60 * 1000);
if (shareSweepTimer.unref) shareSweepTimer.unref();

server.listen(config.port, config.host, () => {
  const proto = config.tls ? 'https' : 'http';
  console.log(`tmux-web-panel listening on ${proto}://${config.host}:${config.port}`);
  startPerfHistorySampler();
  console.log('perf-history sampler started (2s interval, 1h buffer)');
  if (config.auth) {
    console.log('Authentication: enabled');
  } else {
    console.log('Authentication: disabled (no --auth flag)');
  }
  console.log(`Poll interval: ${config.pollInterval}ms`);
  console.log(`Max connections: ${config.maxConnections}`);
});

// When TLS is enabled, also start an HTTP server that redirects to HTTPS
let httpRedirectServer = null;
if (config.tls) {
  const httpPort = Number(cliArgs['http-port'] ?? process.env.HTTP_PORT ?? 80);
  httpRedirectServer = createServer((req, res) => {
    const host = (req.headers.host || '').replace(/:.*/, '');
    const portSuffix = config.port === 443 ? '' : ':' + config.port;
    res.writeHead(301, { Location: `https://${host}${portSuffix}${req.url}` });
    res.end();
  });
  httpRedirectServer.listen(httpPort, config.host, () => {
    console.log(`HTTP redirect listening on http://${config.host}:${httpPort} → https`);
  });
  httpRedirectServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
      console.log(`HTTP redirect on port ${httpPort} skipped (${err.code})`);
    }
  });
}

// Export for testing
export { app, server, wss, config, terminalManager, statusMonitor };
