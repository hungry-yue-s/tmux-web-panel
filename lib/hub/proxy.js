/**
 * /n/:serverId/* — the hub's only route into a machine.
 *
 * The browser addresses every machine the same way: the node API path, behind
 * a /n/:serverId prefix. `local` is this process, so its prefix is stripped and
 * the request continues through the normal routes. Any other id is streamed to
 * that node over its link — or, when the machine is reachable over SSH but does
 * not run the panel (basic mode), answered by the hub itself for the workspace
 * and terminals (hub/basic/).
 *
 * Only machine-scoped paths are relayed. Login, the server registry, plugins
 * and installation management belong to whichever panel the browser is using,
 * so a hub never operates them on a node.
 */

import { AppError, ErrorCode, fail } from '../servers/errors.js';
import { LOCAL_SERVER_ID } from '../servers/registry.js';
import { watchUpgradeSocket } from './node-link.js';
import { diagnostics } from '../diagnostics.js';

const PREFIX_RE = /^\/n\/([a-z0-9][a-z0-9._-]{0,63})(\/[^?#]*)?(\?[^#]*)?$/;
const HUB_ONLY = /^\/api\/(auth|servers|plugins|managed-resources)(\/|$)/;
// Answered only to a hub's own calls: relaying would hand a browser the node token's powers.
const HUB_INTERNAL = /^\/api\/mosh(\/|$)/;

/** Splits `/n/:serverId/rest?query`; null for anything else. */
export function parseNodePath(url) {
  const match = PREFIX_RE.exec(String(url || ''));
  if (!match) return null;
  return { serverId: match[1], path: (match[2] || '/') + (match[3] || ''), pathname: match[2] || '/' };
}

/** Machine-scoped paths a hub may relay. */
export function isRelayable(pathname, { upgrade = false } = {}) {
  if (upgrade) return pathname === '/ws/status' || pathname.startsWith('/ws/terminal/');
  if (!pathname.startsWith('/api/') || HUB_ONLY.test(pathname)) return false;
  // Spelled any way a router might still match it.
  let plain = pathname;
  try { plain = decodeURIComponent(pathname); } catch { return false; }
  return !HUB_INTERNAL.test(plain.replace(/\/{2,}/g, '/').toLowerCase());
}

function sendError(res, err) {
  const appError = err instanceof AppError ? err : new AppError(ErrorCode.INTERNAL, 'Proxy failed');
  if (res.headersSent) { res.destroy(); return; }
  res.status(appError.status).json(fail(appError));
}

/**
 * @param {object} deps
 * @param {import('../servers/registry.js').ServerRegistry} deps.registry
 * @param {import('./link-pool.js').LinkPool} deps.links
 * @param {import('express').RequestHandler} deps.authorize hub login check
 * @param {import('express').RequestHandler} deps.sameOrigin cross-origin write guard
 * @param {Function} [deps.basic] handler for basic-mode hosts (createBasicHttp)
 * @param {() => Function | null} [deps.getBasic] the same, looked up per request
 *   (the basic-mode plugin may come and go)
 */
export function createNodeProxy({ registry, links, authorize, sameOrigin, basic = null, getBasic = () => basic }) {
  return (req, res, next) => {
    const target = parseNodePath(req.url);
    // `local` is never relayed: the node plugin strips that prefix before this
    // runs (rewriteLocalNodePath); without it there is nothing to serve it.
    if (!target || target.serverId === LOCAL_SERVER_ID) return next();
    if (!isRelayable(target.pathname)) {
      sendError(res, new AppError(ErrorCode.UNSUPPORTED, 'This path is not relayed to other servers'));
      return undefined;
    }
    return authorize(req, res, () => sameOrigin(req, res, () => {
      if (!registry.has(target.serverId)) {
        sendError(res, new AppError(ErrorCode.SERVER_NOT_FOUND, `Server ${target.serverId} is not registered`));
        return;
      }
      const began = performance.now();
      links.mode(target.serverId)
        .then((mode) => {
          diagnostics.record('proxy', { ...req.diagnosticContext, serverId: target.serverId, path: target.path,
            phase: 'mode', durationMs: performance.now() - began, provider: mode });
          if (mode === 'node') return links.link(target.serverId).proxy(req, res, target.path);
          const basicHandler = getBasic();
          if (!basicHandler) throw new AppError(ErrorCode.NODE_NOT_INSTALLED, 'tmux-web-panel is not running on that machine');
          return basicHandler(req, res, target.serverId, target);
        })
        .catch((err) => {
          diagnostics.record('proxy', { ...req.diagnosticContext, serverId: target.serverId, path: target.path,
            phase: 'dispatch-error', code: err.code, durationMs: performance.now() - began });
          sendError(res, err);
        });
    }));
  };
}

/**
 * `/n/local/…` addresses this process: strips the prefix in place and says
 * whether it did. That is this machine's own addressing, not relaying, so the
 * node plugin applies it before the hub relay (which may not be loaded) sees
 * the URL.
 */
export function rewriteLocalNodePath(req) {
  const target = parseNodePath(req.url);
  if (!target || target.serverId !== LOCAL_SERVER_ID) return false;
  req.url = target.path;
  return true;
}

/**
 * Upgrade counterpart. Returns false when the URL is not a relayed /n/ path
 * (`local` included, see createNodeProxy), so the caller continues with its own routes.
 */
export function relayNodeUpgrade(req, socket, head, {
  registry, links, authorize, basic = null, mosh = null, getBasic = () => basic, getMosh = () => mosh,
}) {
  const target = parseNodePath(req.url);
  if (!target || target.serverId === LOCAL_SERVER_ID) return false;
  const reject = (status) => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  };
  if (!isRelayable(target.pathname, { upgrade: true })) { reject('404 Not Found'); return true; }
  if (!authorize(req)) { reject('401 Unauthorized'); return true; }
  if (!registry.has(target.serverId)) { reject('404 Not Found'); return true; }
  watchUpgradeSocket(socket);
  links.mode(target.serverId)
    .then((mode) => {
      // The browser may have left already: nothing may attach on its behalf.
      if (socket.destroyed) return undefined;
      // A terminal over mosh is answered here and relays itself when mosh is not to be had.
      const moshTerminals = mode === 'node' ? getMosh() : null;
      if (moshTerminals && target.pathname.startsWith('/ws/terminal/') && moshTerminals.wants(target.serverId)) {
        return moshTerminals.open(req, socket, head, target.serverId, target);
      }
      if (mode === 'node') return links.link(target.serverId).proxyUpgrade(req, socket, head, target.path);
      const basicHandler = getBasic();
      if (!basicHandler) { reject('503 Service Unavailable'); return undefined; }
      return basicHandler(req, socket, head, target.serverId, target);
    })
    .catch(() => reject('503 Service Unavailable'));
  return true;
}
