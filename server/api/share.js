import { Router } from 'express';
import { networkInterfaces } from 'node:os';
import { createSocket } from 'node:dgram';
import { MAX_TTL_MS } from '../share-store.js';

const VIRTUAL_IFACE = /^(utun|tun|tap|vmnet|vnic|bridge|virbr|docker|awdl|llw|ipsec|pktap|lo)/i;

function interfaceFallback() {
  let physical = null;
  let any = null;
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const addr of list || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (!any) any = addr.address;
      if (!physical && /^(en|eth)/i.test(name)) physical = addr.address;
    }
  }
  return physical || any;
}

function knownLocal(address) {
  if (!address) return false;
  return Object.values(networkInterfaces()).some((list) =>
    (list || []).some((a) => a.family === 'IPv4' && a.address === address));
}

// The address the OS routes outbound traffic through is the one peers on the
// same network reach this machine by; RFC1918 preference would wrongly pick a
// secondary or corporate-VPN-adjacent NIC on networks that use public ranges.
function detectLanHost() {
  return new Promise((resolve) => {
    const sock = createSocket('udp4');
    const finish = (value) => {
      try { sock.close(); } catch (_) { /* already closed */ }
      resolve(knownLocal(value) ? value : interfaceFallback());
    };
    sock.once('error', () => finish(null));
    try {
      sock.connect(53, '8.8.8.8', () => finish(sock.address().address));
    } catch (_) {
      finish(null);
    }
  });
}

let lanHostPromise = null;
function lanHost() {
  if (!lanHostPromise) lanHostPromise = detectLanHost();
  return lanHostPromise;
}

/**
 * Authenticated management routes for shared preview snapshots.
 * The public view route (GET /s/:id) lives in index.js, before the /api auth
 * gate, so recipients need no panel login.
 */
export function createShareRouter(shareStore) {
  const router = Router();

  // The browser cannot discover the machine's LAN address on its own; share
  // links must be reachable by others on the network, not just via loopback.
  router.get('/lan-host', async (_req, res) => {
    res.json({ success: true, data: { host: await lanHost() }, error: null });
  });

  // Create a share from a client-rendered, self-contained HTML snapshot.
  router.post('/', async (req, res) => {
    try {
      const { html, filename, ttlMs } = req.body ?? {};
      if (typeof html !== 'string' || html.length === 0) {
        return res.status(400).json({ success: false, data: null, error: 'html_required' });
      }
      const ttl = Number(ttlMs);
      if (!Number.isFinite(ttl) || ttl <= 0) {
        return res.status(400).json({ success: false, data: null, error: 'invalid_ttl' });
      }
      const { id, filename: name, createdAt, expiresAt } =
        await shareStore.create({ html, filename, ttlMs: Math.min(ttl, MAX_TTL_MS) });
      res.json({ success: true, data: { id, url: '/s/' + id, filename: name, createdAt, expiresAt }, error: null });
    } catch (err) {
      const code = (err.message === 'html_too_large') ? 413 : 500;
      res.status(code).json({ success: false, data: null, error: err.message });
    }
  });

  // List the caller's live shares (single-user panel — all shares).
  router.get('/', (_req, res) => {
    try {
      res.json({ success: true, data: { shares: shareStore.list() }, error: null });
    } catch (err) {
      res.status(500).json({ success: false, data: null, error: err.message });
    }
  });

  // Manually revoke a share before it expires.
  router.delete('/:id', async (req, res) => {
    try {
      const existed = await shareStore.delete(req.params.id);
      res.json({ success: true, data: { deleted: existed }, error: null });
    } catch (err) {
      res.status(500).json({ success: false, data: null, error: err.message });
    }
  });

  return router;
}
