import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import express from 'express';
import { WebSocketServer } from 'ws';
import {
  verifyPassword,
  createToken,
  deleteToken,
  tokenAuth,
  wsTokenAuth,
  startTokenReaper,
  initTokenPersistence,
  flushTokenPersistence,
  createLoginRateLimiter,
} from './auth.js';
import { loadTotpSecret, verifyTotp, totpFilePath } from './totp.js';
import { resolveRuntimeConfig } from './runtime-config.js';
import * as tmux from './tmux.js';
import { IS_WINDOWS, msysHomeRoots, toNativePath, toPosixPath } from './msys.js';
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
import { AgentEventService } from './agent-events.js';
import { createNotificationsRouter } from './api/notifications.js';
import { createAgentEventsRouter } from './api/agent-events.js';
import { createSceneDiscoverRouter } from './api/scene-discover.js';
import createClaudeUsageRouter from './api/claude-usage.js';
import createCodexUsageRouter from './api/codex-usage.js';
import { createAgentHubRouter, createAgentHubService } from './api/agent-hub.js';
import { PinStore } from './pins.js';
import { createPinsRouter } from './api/pins.js';
import { ShareStore } from './share-store.js';
import { createShareRouter } from './api/share.js';
import { ServerRegistry } from './servers/registry.js';
import { HealthService } from './servers/health-service.js';
import { ServerService } from './servers/server-service.js';
import { handle } from './servers/errors.js';
import { WorkspaceService } from './workspace/service.js';
import { MetricsService } from './metrics/service.js';
import { collectLocalMetrics } from './metrics/local-collector.js';
import { TerminalGateway } from './terminal/gateway.js';
import { createServersRouter } from './api/servers.js';
import { createWorkspaceRouter } from './api/workspace.js';
import { createMetricsRouter } from './api/metrics.js';
import { requireSameOrigin } from './api/same-origin.js';
import { initNodeIdentity } from './node/identity.js';
import { collectNodeInfo } from './node/info.js';
import { LinkPool } from './hub/link-pool.js';
import { createNodeProxy, relayNodeUpgrade } from './hub/proxy.js';
import { BasicHost } from './hub/basic/basic-host.js';
import { createBasicHttp, createBasicUpgrade } from './hub/basic/basic-routes.js';
import { NodeInstaller } from './hub/node-installer.js';
import { createNodeInstallRouter } from './api/node-install.js';
import pty from 'node-pty';
import { sshPtyBinary } from './transport/ssh-connection.js';
import { PluginManager } from './plugins.js';
import { createPluginsRouter } from './api/plugins.js';
import { ManagedResources } from './managed-resources.js';
import { createManagedResourcesRouter } from './api/managed-resources.js';

const config = resolveRuntimeConfig();
const configDir = config.configDir;

// --- Express App ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// --- Node identity and hub links ---
//
// Every installation is a node: it serves its own machine and writes a pairing
// file so another panel (a hub) can reach this API over an SSH port forward.
// It is also a hub for the servers in its registry, reached at /n/:serverId.

const nodeIdentity = await initNodeIdentity({
  configDir,
  port: config.port,
  listenHost: config.host,
  tlsCertPath: config.tls ? config.tls.cert : null,
});

const serverRegistry = new ServerRegistry({ configDir });
await serverRegistry.load();

// A machine without the panel (basic mode) still gets a workspace and
// terminals: its remote tmux, or login shells this hub hosts over ssh -tt.
const spawnBasicPty = (argv, env, { cols, rows }) => pty.spawn(sshPtyBinary(), argv, {
  name: 'xterm-256color',
  cols: cols || 80,
  rows: rows || 24,
  env: {
    ...process.env,
    ...env,
    LANG: process.env.LANG || 'C.UTF-8',
    LC_CTYPE: process.env.LC_CTYPE || process.env.LANG || 'C.UTF-8',
  },
});

const links = new LinkPool({
  registry: serverRegistry,
  configDir,
  createBasicHost: (connection) => new BasicHost({ connection, spawnPty: spawnBasicPty }),
});

// Must precede every body parser: relayed requests are streamed untouched.
// Only a login token opens the relay — a node token must not chain hubs.
app.use(createNodeProxy({
  registry: serverRegistry,
  links,
  authorize: config.auth || config.nodeOnly ? (req, res, next) => tokenAuth(tokenMap)(req, res, next) : (_req, _res, next) => next(),
  sameOrigin: requireSameOrigin,
  basic: createBasicHttp({ links }),
}));

// Share snapshots can be several MB (inlined images) — give /api/share a large
// JSON limit BEFORE the global 100KB parser (which then no-ops on these requests).
// The real cap is enforced in ShareStore (MAX_HTML_BYTES) with a clean 413.
app.use('/api/share', express.json({ limit: '16mb' }));

// Parse JSON request bodies (before auth routes that need it)
app.use(express.json());

// --- Auth Setup ---

const tokenMap = new Map();
let authUser = null;
let authSalt = null;
let authHash = null;

if (config.auth) {
  authUser = config.authCredentials.username;
  authSalt = config.authCredentials.salt;
  authHash = config.authCredentials.hash;

  // Restore persisted tokens (survives restarts)
  const tokenFile = join(configDir, config.tokenFileName);
  initTokenPersistence(tokenMap, tokenFile);

  // --- Public auth routes (no token required) ---

  const loginLimiter = createLoginRateLimiter();

  app.post('/api/auth/login', (req, res) => {
    const lockedUntil = loginLimiter.isBlocked(req.ip);
    if (lockedUntil !== null) {
      const retryAfter = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({
        success: false,
        data: null,
        error: `Too many failed attempts. Try again in ${retryAfter}s.`,
      });
      return;
    }

    const { username, password, trusted, totp } = req.body || {};

    const passwordOk =
      username === authUser &&
      password &&
      verifyPassword(password, authSalt, authHash);

    // Read per attempt so enrolling or removing MFA needs no restart.
    const totpSecret = loadTotpSecret(totpFilePath(configDir));
    const totpOk = !totpSecret || verifyTotp(totpSecret, String(totp ?? ''));

    if (passwordOk && totpOk) {
      loginLimiter.recordSuccess(req.ip);
      const token = createToken(tokenMap, { trusted: !!trusted });
      res.json({ success: true, data: { token, trusted: !!trusted }, error: null });
      return;
    }

    loginLimiter.recordFailure(req.ip);
    // One generic message: differing errors would reveal which factor matched.
    res.status(401).json({
      success: false,
      data: null,
      error: 'Invalid credentials',
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
if (config.managedRuntime) {
  app.get('/js/relay-config.js', (_req, res) => {
    res.type('application/javascript').set('Cache-Control', 'no-store')
      .send('window.PANEL_RELAY_PAGE = ' + JSON.stringify(config.relayPage) + ';\n');
  });
}
app.use(express.static(join(__dirname, '..', 'public'), { etag: false, maxAge: 0 }));

// --- Token auth middleware (protects API routes below) ---

// A node-only install has no login: only the managing panel's token opens the API.
const apiGuarded = Boolean(config.auth || config.nodeOnly);
if (apiGuarded) {
  app.use('/api', tokenAuth(tokenMap, { isServiceToken: nodeIdentity.isNodeToken }));
}

const localNodeInfo = () => collectNodeInfo({ tmuxVersion: tmux.tmuxVersion });
app.get('/api/node/info', handle(async () => localNodeInfo()));

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
  join(configDir, 'notifications.json'),
);

const agentEvents = new AgentEventService({ notificationStore });

const statusMonitor = new StatusMonitor({ notificationStore, agentEvents });

// --- Pin Store (window-id pinning, persisted across restarts) ---

const pinStore = new PinStore(
  join(configDir, 'pins.json'),
);
await pinStore.load();

// --- Share Store (file-preview snapshots shared via /s/:id, persisted) ---

const shareStore = new ShareStore(
  join(configDir, 'shares.json'),
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
app.use('/api/agent-events', createAgentEventsRouter(agentEvents, {
  onNotifications: (notifications) => statusMonitor.broadcastNotifications(notifications),
}));
app.use('/api/scene/discover', createSceneDiscoverRouter());
app.use('/api/pins', createPinsRouter(pinStore));
app.use('/api/share', createShareRouter(shareStore));

// Desktop uploads stay in this installation's data directory.
if (IS_WINDOWS) {
  // Panes run MSYS2 shells, so uploads land in MSYS's /tmp and are reported
  // (and previewed) by their MSYS path.
  app.use('/api/upload', createUploadRouter(toNativePath('/tmp/tmux-web-panel-uploads'), { displayPath: toPosixPath }));
  app.use('/api/files', createFilesRouter([...msysHomeRoots(), '/tmp']));
} else {
  app.use('/api/upload', createUploadRouter(config.managedRuntime ? join(configDir, 'uploads') : '/tmp/tmux-web-panel-uploads'));
  app.use('/api/files', createFilesRouter([homedir(), '/tmp']));
}
app.use('/api/claude-usage', createClaudeUsageRouter());
app.use('/api/codex-usage', createCodexUsageRouter({ configDir }));
const agentHubService = createAgentHubService({ configDir });
app.use('/api/agent-hub', createAgentHubRouter(agentHubService));

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

const wss = new WebSocketServer({
  noServer: true,
  // A terminal frame is keystrokes or a paste; nothing legitimate is larger.
  maxPayload: 1024 * 1024,
});

const terminalManager = new TerminalManager({
  maxConnectionsPerPane: config.maxConnections,
});

// Terminal and status sockets of basic-mode hosts are answered here, not relayed.
const basicUpgrade = createBasicUpgrade({ links, wss, terminalManager });

// --- This machine's workspace, metrics and terminals; the hub's registry ---

const workspaceService = new WorkspaceService({
  tmux: tmux.localTmux,
  onChange: (revision) => statusMonitor.broadcastWorkspaceChanged(revision),
});

const healthService = new HealthService({
  registry: serverRegistry,
  links,
  localInfo: localNodeInfo,
  onStatus: (status) => statusMonitor.broadcastServerStatus(status),
});

const metricsService = new MetricsService({ collector: collectLocalMetrics });

const serverService = new ServerService({ registry: serverRegistry, links, health: healthService });

const terminalGateway = new TerminalGateway({ workspace: workspaceService, terminalManager });

app.use('/api/workspace', createWorkspaceRouter({ workspaceService }));
app.use('/api/metrics', createMetricsRouter({ metricsService }));
const nodeInstaller = new NodeInstaller({
  links,
  projectDir: join(__dirname, '..'),
  onInstalled: (serverId) => {
    healthService.invalidate(serverId);
    healthService.probe(serverId, { force: true }).catch(() => {});
  },
});

app.use('/api/servers', createNodeInstallRouter({ installer: nodeInstaller }));
app.use('/api/servers', createServersRouter({ serverService }));

const pluginManager = new PluginManager({
  configDir, catalogDir: join(__dirname, '..', 'plugins'),
  dependencies: {
    tmux: tmux.localTmux,
    workspaceService,
    servers: serverService,
    // Tool calls for another server run in that server's own copy of the plugin.
    remote: {
      call: (serverId, pluginId, tool, args) => links.link(serverId).requestJson(
        'POST',
        '/api/plugins/' + encodeURIComponent(pluginId) + '/tools/' + encodeURIComponent(tool),
        args,
        { timeout: 30_000 },
      ),
    },
  },
});
await pluginManager.load();
app.use('/api/plugins', createPluginsRouter(pluginManager));

const managedResources = new ManagedResources({ projectDir: join(__dirname, '..'), configDir,
  packaged: config.managedRuntime, runtimePath: config.runtimePath });
await managedResources.load();
app.use('/api/managed-resources', createManagedResourcesRouter(managedResources));

server.on('upgrade', (req, socket, head) => {
  // Another server's socket is relayed whole; /n/local/... is rewritten in place.
  const relayed = relayNodeUpgrade(req, socket, head, {
    basic: basicUpgrade,
    registry: serverRegistry,
    links,
    authorize: (upgradeReq) => !(config.auth || config.nodeOnly) || wsTokenAuth(tokenMap, upgradeReq),
  });
  if (relayed) return;

  const proto = config.tls ? 'https' : 'http';
  const url = new URL(req.url, `${proto}://${req.headers.host}`);

  // Enforce auth on WebSocket upgrade if configured
  if (apiGuarded) {
    if (!wsTokenAuth(tokenMap, req, { isServiceToken: nodeIdentity.isNodeToken })) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  if (url.pathname.startsWith('/ws/terminal/')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      // The gateway resolves serverId/paneId, verifies ownership and picks the
      // provider. It never throws: a bad address closes just this socket.
      terminalGateway.handle(ws, url.pathname, url.searchParams).catch(() => {
        try {
          ws.close(1011, 'terminal setup failed');
        } catch {
          // Socket already gone.
        }
      });
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

  // Stop automatic Codex warm-up checks.
  agentHubService.stopAutoWarmup();
  void agentHubService.stopEnterpriseRuntime();

  // Destroy all terminal PTY connections
  terminalManager.destroyAll();

  // Stop server health polling and close every port forward.
  healthService.stop();
  links.closeAll();

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
      flushTokenPersistence(tokenMap);
      process.exit(0);
    });
  });

  // Force exit after 5 seconds if graceful shutdown stalls
  setTimeout(() => {
    console.error('Forced exit after timeout.');
    flushTokenPersistence(tokenMap);
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Start ---

statusMonitor.start(config.pollInterval);
terminalManager.startReaper();
notificationStore.startReaper();
agentHubService.startAutoWarmup();
agentHubService.startEnterpriseRuntime().catch(() => console.error('集团模型中继恢复失败，请在 Agent 控制台重新启用'));
// Server liveness and capability detection, with its own per-server backoff.
healthService.start(5000);
// End hub-hosted shells of basic-mode hosts whose detached TTL has passed.
const basicReapTimer = setInterval(() => {
  try { links.reapBasic(); } catch { /* the next tick retries */ }
}, 60 * 1000);
if (basicReapTimer.unref) basicReapTimer.unref();
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
if (config.tls && config.httpPort !== null) {
  const httpPort = config.httpPort;
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
