import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { httpAuth, wsAuth } from './auth.js';
import * as tmux from './tmux.js';
import { TerminalManager } from './terminal.js';
import { StatusMonitor } from './monitor.js';
import sessionsRouter from './api/sessions.js';
import windowsRouter from './api/windows.js';
import { nestedPanesRouter, flatPanesRouter } from './api/panes.js';

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
});

// --- Express App ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Auth middleware (only when --auth is provided)
if (config.auth) {
  const [user, pass] = config.auth.split(':');
  app.use(httpAuth(user, pass));
}

// Parse JSON request bodies
app.use(express.json());

// Serve static files from public/
app.use(express.static(join(__dirname, '..', 'public')));

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

// Mount API routes
app.use('/api/sessions', sessionsRouter);
app.use('/api/sessions/:name/windows', windowsRouter);
app.use('/api/sessions/:name/windows/:index/panes', nestedPanesRouter);
app.use('/api/panes', flatPanesRouter);

// --- HTTP + WebSocket Server ---

const server = createServer(app);

const wss = new WebSocketServer({ noServer: true });

const terminalManager = new TerminalManager({
  maxConnectionsPerPane: config.maxConnections,
});

const statusMonitor = new StatusMonitor();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Enforce auth on WebSocket upgrade if configured
  if (config.auth) {
    const [user, pass] = config.auth.split(':');
    if (!wsAuth(user, pass, req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="tmux-web-panel"\r\n\r\n');
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

  // Stop status monitor polling
  statusMonitor.stop();

  // Destroy all terminal PTY connections
  terminalManager.destroyAll();

  // Close all WebSocket connections
  for (const client of wss.clients) {
    client.close(1001, 'Server shutting down');
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

server.listen(config.port, config.host, () => {
  console.log(`tmux-web-panel listening on http://${config.host}:${config.port}`);
  if (config.auth) {
    console.log('Authentication: enabled');
  } else {
    console.log('Authentication: disabled (no --auth flag)');
  }
  console.log(`Poll interval: ${config.pollInterval}ms`);
  console.log(`Max connections: ${config.maxConnections}`);
});

// Export for testing
export { app, server, wss, config, terminalManager, statusMonitor };
