// `ctx.servers`: the hub side of multi-server (docs/architecture.md, Hub 与 Node).
//
// - The registry of servers, their health (one GET /api/node/info each), and
//   one SSH link per server: SFTP for the pairing file plus an `ssh -N -L`
//   forward. Day-to-day work runs on the Node itself; the only remote
//   execution is the installer the user starts explicitly.
// - /n/:serverId/… is relayed untouched to that Node, before compression and
//   body parsing (order -50). Login tokens only: a node token cannot chain hubs.
// - Basic mode (SSH login, no panel) gets a workspace and terminals from this
//   hub; those terminals are local PTYs running ssh, so each spawn goes
//   through trackConsoleSpawn like every other PTY.
// - Mosh terminals this hub runs to a Node (transport.terminal = 'mosh'),
//   reported in the health and relayed in place of the WebSocket attach.
// - Installing a Node, or the Mosh components, on a server.
//
// Shutting down, the mosh terminals end their Node sessions through the
// links before the links close.

import pty from 'node-pty';
import { ServerRegistry } from '../../lib/servers/registry.js';
import { HealthService } from '../../lib/servers/health-service.js';
import { ServerService } from '../../lib/servers/server-service.js';
import { LinkPool } from '../../lib/hub/link-pool.js';
import { createNodeProxy, relayNodeUpgrade } from '../../lib/hub/proxy.js';
import { BasicHost } from '../../lib/hub/basic/basic-host.js';
import { createBasicHttp, createBasicUpgrade } from '../../lib/hub/basic/basic-routes.js';
import { MoshTerminals } from '../../lib/hub/mosh-terminal.js';
import { NodeInstaller } from '../../lib/hub/node-installer.js';
import { createNodeInstallRouter } from '../../lib/api/node-install.js';
import { createServersRouter } from '../../lib/api/servers.js';
import { requireSameOrigin } from '../../lib/api/same-origin.js';
import { trackConsoleSpawn } from '../../lib/terminal/console-reaper.js';
import { sshPtyBinary } from '../../lib/transport/ssh-connection.js';
import { REPO_ROOT } from '../../lib/paths.js';

export const name = 'servers';

export const inject = ['launch', 'http', 'auth', 'node', 'terminals', 'timer'];

const HEALTH_INTERVAL_MS = 5000;
const BASIC_REAP_MS = 60 * 1000;

function spawnBasicPty(argv, env, { cols, rows }) {
  return trackConsoleSpawn(() => pty.spawn(sshPtyBinary(), argv, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    env: {
      ...process.env,
      ...env,
      LANG: process.env.LANG || 'C.UTF-8',
      LC_CTYPE: process.env.LC_CTYPE || process.env.LANG || 'C.UTF-8',
    },
  })).term;
}

export async function apply(ctx) {
  const { configDir } = ctx.launch;
  const auth = ctx.auth;

  const registry = new ServerRegistry({ configDir });
  await registry.load();

  const links = new LinkPool({
    registry,
    configDir,
    createBasicHost: (connection) => new BasicHost({ connection, spawnPty: spawnBasicPty }),
  });
  const mosh = new MoshTerminals({ registry, links, wss: ctx.http.wss });
  // One effect, so the order holds: mosh terminals end their Node sessions
  // through the links, then the links close.
  ctx.effect(() => async () => {
    await mosh.closeAll().catch(() => false);
    links.closeAll();
  }, 'servers.links');
  ctx.effect(() => ctx.node.setCapability('moshClient', () => mosh.clientCapability()), 'servers.mosh-client');

  // Relayed requests stream untouched: before compression and body parsers.
  ctx.http.use(createNodeProxy({
    registry,
    links,
    authorize: auth.loginOnly,
    sameOrigin: requireSameOrigin,
    basic: createBasicHttp({ links }),
  }), { order: -50 });

  // Another server's socket is relayed whole; /n/local/… is rewritten in place.
  const basicUpgrade = createBasicUpgrade({ links, wss: ctx.http.wss, terminalManager: ctx.terminals });
  ctx.http.useUpgrade(({ req, socket, head }) => relayNodeUpgrade(req, socket, head, {
    basic: basicUpgrade,
    mosh,
    registry,
    links,
    authorize: auth.authorizeRelayUpgrade,
  }), { order: -50 });

  const health = new HealthService({
    registry,
    links,
    localInfo: () => ctx.node.info(),
    moshStatus: (serverId, context) => mosh.status(serverId, context),
    onStatus: (status) => ctx.emit('status/server-status', status),
  });
  ctx.effect(() => {
    health.start(HEALTH_INTERVAL_MS);
    return () => health.stop();
  }, 'servers.health');

  const service = new ServerService({ registry, links, health, mosh });
  const installer = new NodeInstaller({
    links,
    registry,
    projectDir: REPO_ROOT,
    onInstalled: (serverId) => {
      health.invalidate(serverId);
      health.probe(serverId, { force: true }).catch(() => {});
    },
    onComponentInstalled: async (serverId) => {
      if (serverId === 'local') {
        // The mosh plugin refreshes this Node's components.
        await ctx.parallel('mosh/refresh-components').catch(() => {});
      } else {
        // Older Nodes may not expose this yet; their normal capability cache still expires.
        await links.link(serverId).requestJson('POST', '/api/mosh/components/refresh', undefined, { timeout: 10_000 }).catch(() => {});
      }
      mosh.retry(serverId);
      health.invalidate(serverId);
      await health.probe(serverId, { force: true }).catch(() => {});
    },
  });

  ctx.http.mount('/api/servers', createNodeInstallRouter({ installer }));
  ctx.http.mount('/api/servers', createServersRouter({ serverService: service }));

  // End hub-hosted shells of basic-mode hosts whose detached TTL has passed.
  ctx.interval(() => {
    try {
      links.reapBasic();
    } catch {
      // The next tick retries.
    }
  }, BASIC_REAP_MS);

  ctx.provide('servers', Object.freeze({ registry, links, health, service, installer, mosh }));
}
