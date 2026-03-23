import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { httpAuth, wsAuth } from './auth.js';

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

// Serve static files from public/
app.use(express.static(join(__dirname, '..', 'public')));

// Placeholder API route
app.get('/api/status', (_req, res) => {
  res.json({ success: true, data: { status: 'ok' } });
});

// --- HTTP + WebSocket Server ---

const server = createServer(app);

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // Enforce auth on WebSocket upgrade if configured
  if (config.auth) {
    const [user, pass] = config.auth.split(':');
    if (!wsAuth(user, pass, req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="tmux-web-panel"\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// --- Graceful Shutdown ---

function shutdown(signal) {
  console.log(`\n${signal} received — shutting down...`);

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
export { app, server, wss, config };
