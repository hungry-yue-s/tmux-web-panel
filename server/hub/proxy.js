/**
 * /n/:serverId/* — the hub's only route into a machine.
 *
 * The browser addresses every machine the same way: the node API path, behind
 * a /n/:serverId prefix. `local` is this process, so its prefix is stripped and
 * the request continues through the normal routes. Any other id is streamed to
 * that node over its link.
 *
 * Only machine-scoped paths are relayed. Login, the server registry, plugins
 * and installation management belong to whichever panel the browser is using,
 * so a hub never operates them on a node.
 */

import { AppError, ErrorCode, fail } from '../servers/errors.js';
import { LOCAL_SERVER_ID } from '../servers/registry.js';

const PREFIX_RE = /^\/n\/([a-z0-9][a-z0-9._-]{0,63})(\/[^?#]*)?(\?[^#]*)?$/;
const HUB_ONLY = /^\/api\/(auth|servers|plugins|managed-resources)(\/|$)/;

/** Splits `/n/:serverId/rest?query`; null for anything else. */
export function parseNodePath(url) {
  const match = PREFIX_RE.exec(String(url || ''));
  if (!match) return null;
  return { serverId: match[1], path: (match[2] || '/') + (match[3] || ''), pathname: match[2] || '/' };
}

/** Machine-scoped paths a hub may relay. */
export function isRelayable(pathname, { upgrade = false } = {}) {
  if (upgrade) return pathname === '/ws/status' || pathname.startsWith('/ws/terminal/');
  return pathname.startsWith('/api/') && !HUB_ONLY.test(pathname);
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
 */
export function createNodeProxy({ registry, links, authorize, sameOrigin }) {
  return (req, res, next) => {
    const target = parseNodePath(req.url);
    if (!target) return next();
    if (target.serverId === LOCAL_SERVER_ID) {
      // This process is the node: carry on as if the prefix was never there.
      req.url = target.path;
      return next();
    }
    if (!isRelayable(target.pathname)) {
      sendError(res, new AppError(ErrorCode.UNSUPPORTED, 'This path is not relayed to other servers'));
      return undefined;
    }
    return authorize(req, res, () => sameOrigin(req, res, () => {
      if (!registry.has(target.serverId)) {
        sendError(res, new AppError(ErrorCode.SERVER_NOT_FOUND, `Server ${target.serverId} is not registered`));
        return;
      }
      let link;
      try {
        link = links.link(target.serverId);
      } catch (err) {
        sendError(res, err);
        return;
      }
      link.proxy(req, res, target.path).catch((err) => sendError(res, err));
    }));
  };
}

/**
 * Upgrade counterpart. Returns false when the URL is not a /n/ path, so the
 * caller can continue with its own routes; for `local` it rewrites req.url
 * and also returns false.
 */
export function relayNodeUpgrade(req, socket, head, { registry, links, authorize }) {
  const target = parseNodePath(req.url);
  if (!target) return false;
  if (target.serverId === LOCAL_SERVER_ID) {
    req.url = target.path;
    return false;
  }
  const reject = (status) => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  };
  if (!isRelayable(target.pathname, { upgrade: true })) { reject('404 Not Found'); return true; }
  if (!authorize(req)) { reject('401 Unauthorized'); return true; }
  if (!registry.has(target.serverId)) { reject('404 Not Found'); return true; }
  let link;
  try {
    link = links.link(target.serverId);
  } catch {
    reject('409 Conflict');
    return true;
  }
  link.proxyUpgrade(req, socket, head, target.path).catch(() => socket.destroy());
  return true;
}
