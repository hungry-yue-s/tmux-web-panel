// `ctx.http`: the HTTP(S) server and its routes.
//
// Every registration — route, upgrade handler, middleware — is an effect of
// the plugin that made it: when that plugin is disposed, its routes answer 404
// again. No plugin ever needs to clean up after itself here.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { Service } from 'cordis';
import { compilePath, HttpError, matchPath, readJson, sendError, sendJson } from './router.js';

export { HttpError, readJson, sendJson } from './router.js';

export const name = 'http';

function remove(list, item) {
  const index = list.indexOf(item);
  if (index >= 0) list.splice(index, 1);
}

/** Routes with a wildcard are tried after every exact route. */
function byPrecedence(a, b) {
  return Number(a.wildcard) - Number(b.wildcard);
}

/**
 * @typedef {object} HttpConfig
 * @property {string} [host] default 127.0.0.1
 * @property {number} [port] default 7690; 0 picks a free port
 * @property {{ cert: string, key: string }} [tls]
 */

export default class HttpService extends Service {
  /** @param {HttpConfig} [config] */
  constructor(ctx, config) {
    super(ctx, 'http');
    this.config = { host: '127.0.0.1', port: 7690, ...config };
    this.routes = [];
    this.upgrades = [];
    this.middlewares = [];
    this.port = null;
    const handler = (req, res) => this._handle(req, res);
    this.server = this.config.tls
      ? createSecureServer({ cert: readFileSync(this.config.tls.cert), key: readFileSync(this.config.tls.key) }, handler)
      : createServer(handler);
    this.server.on('upgrade', (req, socket, head) => this._upgrade(req, socket, head));
  }

  async [Service.init]() {
    const { host, port } = this.config;
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(port, host);
    });
    this.port = this.server.address().port;
    this.ctx.logger.info('listening on %s://%s:%d', this.config.tls ? 'https' : 'http', host, this.port);
    return () => new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  /**
   * Adds a route for the calling plugin.
   * The handler gets `{ req, res, url, params, body }` and either returns a
   * value (sent as JSON; undefined → 204) or writes `res` itself.
   * @returns {() => Promise<void>} removes the route early
   */
  route(method, path, handler) {
    const route = { method: method.toUpperCase(), path, handler, ...compilePath(path) };
    return this.ctx.effect(() => {
      this.routes.push(route);
      this.routes.sort(byPrecedence);
      return () => remove(this.routes, route);
    }, `http.route(${route.method} ${path})`);
  }

  get(path, handler) { return this.route('GET', path, handler); }
  post(path, handler) { return this.route('POST', path, handler); }
  put(path, handler) { return this.route('PUT', path, handler); }
  patch(path, handler) { return this.route('PATCH', path, handler); }
  delete(path, handler) { return this.route('DELETE', path, handler); }

  /**
   * Runs before every route, in registration order. It may throw an
   * HttpError (e.g. 401) or answer the request itself.
   */
  use(middleware) {
    return this.ctx.effect(() => {
      this.middlewares.push(middleware);
      return () => remove(this.middlewares, middleware);
    }, 'http.use()');
  }

  /** Handles WebSocket and other upgrades for a path: `{ req, socket, head, url, params }`. */
  upgrade(path, handler) {
    const route = { path, handler, ...compilePath(path) };
    return this.ctx.effect(() => {
      this.upgrades.push(route);
      this.upgrades.sort(byPrecedence);
      return () => remove(this.upgrades, route);
    }, `http.upgrade(${path})`);
  }

  async _handle(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      for (const middleware of [...this.middlewares]) {
        await middleware({ req, res, url });
        if (res.writableEnded) return;
      }
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      let allowed = false;
      for (const route of [...this.routes]) {
        const params = matchPath(route, url.pathname);
        if (!params) continue;
        if (route.method !== method) {
          allowed = true;
          continue;
        }
        const result = await route.handler({ req, res, url, params, body: () => readJson(req) });
        if (res.headersSent || res.writableEnded) return;
        if (result === undefined) {
          res.writeHead(204);
          res.end();
        } else {
          sendJson(res, 200, result);
        }
        return;
      }
      throw allowed
        ? new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
        : new HttpError(404, 'NOT_FOUND', 'Not found');
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendError(res, error);
        return;
      }
      this.ctx.logger.error(error);
      sendError(res, new HttpError(500, 'INTERNAL', 'Internal error'));
    }
  }

  async _upgrade(req, socket, head) {
    const refuse = (status, text) => {
      if (socket.writable) socket.end(`HTTP/1.1 ${status} ${text}\r\n\r\n`);
      socket.destroy();
    };
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      for (const route of [...this.upgrades]) {
        const params = matchPath(route, url.pathname);
        if (!params) continue;
        await route.handler({ req, socket, head, url, params });
        return;
      }
      refuse(404, 'Not Found');
    } catch (error) {
      if (error instanceof HttpError) {
        refuse(error.status, error.message);
        return;
      }
      this.ctx.logger.error(error);
      refuse(500, 'Internal Server Error');
    }
  }
}
