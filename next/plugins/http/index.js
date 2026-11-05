// `ctx.http`: the HTTP(S) server, its routes and its upgrades.
//
// Every registration — route, mounted router, middleware, upgrade handler — is
// an effect of the plugin that made it: when that plugin is disposed, its
// paths answer 404 again. No plugin cleans up after itself here.
//
// Requests go through Express so ported routers keep their semantics
// (req.params, res.json, multer, streaming). The pipeline:
//
//   middlewares with order < 0    raw streams: byte counting, the /n/ relay
//   compression                   pages, scripts and JSON
//   middlewares with order >= 0   e.g. the /api login guard
//   routes and mounts             in registration order, exact paths first
//   404
//
// Upgrades run their hooks in the same order (a hook may handle the socket),
// then the upgrade routes.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { constants as zlibConstants } from 'node:zlib';
import { Service } from 'cordis';
import compression from 'compression';
import express from 'express';
import { WebSocketServer } from 'ws';
import { compilePath, HttpError, matchPath, readJson, sendError, sendJson } from './router.js';

export { HttpError, readJson, sendJson } from './router.js';

export const name = 'http';

/** The WebSocket an upgrade became; diagnostics reads its buffered bytes. */
export const UPGRADED_SOCKET = Symbol.for('twp.upgradedSocket');


const JSON_LIMIT = '100kb';

function remove(list, item) {
  const index = list.indexOf(item);
  if (index >= 0) list.splice(index, 1);
}

function byOrder(a, b) {
  return a.order - b.order || a.seq - b.seq;
}

/** Lower order first; within an order, exact routes before wildcards, then registration order. */
function byPrecedence(a, b) {
  return (a.order ?? 0) - (b.order ?? 0) || Number(a.wildcard) - Number(b.wildcard) || a.seq - b.seq;
}

/**
 * @typedef {object} HttpConfig
 * @property {string} [host] default: the launch settings' host
 * @property {number} [port] default: the launch settings' port; 0 picks a free port
 * @property {{ cert: string, key: string } | null} [tls] default: the launch settings'
 * @property {number | null} [httpPort] plain-HTTP port that redirects to HTTPS (only with TLS)
 * @property {boolean} [compression] default true
 */

export default class HttpService extends Service {
  static inject = ['launch'];

  /** @param {HttpConfig} [config] */
  constructor(ctx, config) {
    super(ctx, 'http');
    const launch = ctx.launch;
    this.config = {
      host: config?.host ?? launch.host,
      port: config?.port ?? launch.port,
      tls: config?.tls !== undefined ? config.tls : launch.tls,
      httpPort: config?.httpPort !== undefined ? config.httpPort : launch.httpPort,
      compression: config?.compression ?? true,
    };
    this._seq = 0;
    this.routes = [];
    this.middlewares = [];
    this.upgrades = [];
    this.upgradeHooks = [];
    this.port = null;
    this.redirectServer = null;

    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => this._runMiddlewares(req, res, next, (mw) => mw.order < 0));
    if (this.config.compression) {
      app.use(compression({
        threshold: 1024,
        brotli: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } },
        // Raw files are streamed with byte ranges (video) and uploads stream in.
        filter: (req, res) => !req.path.startsWith('/api/files/raw') && !req.path.startsWith('/api/upload')
          && compression.filter(req, res),
      }));
    }
    app.use((req, res, next) => this._runMiddlewares(req, res, next, (mw) => mw.order >= 0));
    app.use((req, res, next) => this._dispatch(req, res, next));
    app.use((req, res) => sendError(res, new HttpError(404, 'NOT_FOUND', 'Not found')));
    // eslint-disable-next-line no-unused-vars
    app.use((error, req, res, next) => this._fail(res, error));
    this.app = app;

    this.server = this.config.tls
      ? createSecureServer({ cert: readFileSync(this.config.tls.cert), key: readFileSync(this.config.tls.key) }, app)
      : createServer(app);
    this.server.on('upgrade', (req, socket, head) => this._upgrade(req, socket, head));

    // One WebSocket server for every socket path, as before.
    this.wss = new WebSocketServer({
      noServer: true,
      // A terminal frame is keystrokes or a paste; nothing legitimate is larger.
      maxPayload: 1024 * 1024,
      // Terminal output is highly repetitive: deflate cuts it several times over
      // on a slow link. Keystroke echoes stay below the threshold.
      perMessageDeflate: {
        zlibDeflateOptions: { level: 4, memLevel: 8 },
        threshold: 256,
        concurrencyLimit: 8,
      },
    });
  }

  async [Service.init]() {
    const { host, port, tls, httpPort } = this.config;
    await listen(this.server, port, host);
    this.port = this.server.address().port;
    this.ctx.logger.info('listening on %s://%s:%d', tls ? 'https' : 'http', host, this.port);
    if (tls && httpPort !== null && httpPort !== undefined) this._startRedirect(httpPort);
    return () => new Promise((resolve) => {
      for (const client of this.wss.clients) client.close(1001, 'Server shutting down');
      this.wss.close();
      this.redirectServer?.close();
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  /** Plain HTTP on `httpPort` answers every request with a redirect to HTTPS. */
  _startRedirect(httpPort) {
    const target = this.port;
    const server = createServer((req, res) => {
      const host = String(req.headers.host || '').replace(/:.*/, '');
      const portSuffix = target === 443 ? '' : `:${target}`;
      res.writeHead(301, { Location: `https://${host}${portSuffix}${req.url}` });
      res.end();
    });
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        this.ctx.logger.info('HTTP redirect on port %d skipped (%s)', httpPort, error.code);
      } else {
        this.ctx.logger.warn(error);
      }
    });
    server.listen(httpPort, this.config.host, () => {
      this.ctx.logger.info('HTTP redirect listening on http://%s:%d -> https', this.config.host, httpPort);
    });
    this.redirectServer = server;
  }

  /**
   * Adds a route for the calling plugin. The handler gets
   * `{ req, res, url, params, body }` and either returns a value (sent as
   * JSON; undefined → 204) or answers `res` itself.
   */
  route(method, path, handler, { order = 0 } = {}) {
    const route = { kind: 'route', method: method.toUpperCase(), path, handler, order, ...compilePath(path) };
    return this._register(this.routes, route, byPrecedence, `http.route(${route.method} ${path})`);
  }

  get(path, handler) { return this.route('GET', path, handler); }
  post(path, handler) { return this.route('POST', path, handler); }
  put(path, handler) { return this.route('PUT', path, handler); }
  patch(path, handler) { return this.route('PATCH', path, handler); }
  delete(path, handler) { return this.route('DELETE', path, handler); }

  /**
   * Mounts an Express router (or any `(req, res, next)` handler) at `prefix`,
   * like `app.use(prefix, router)`. JSON bodies are parsed first unless
   * `json: false`; `json: { limit }` raises the limit. A higher `order` is
   * tried later (the static site mounts at `/` with a high order).
   */
  mount(prefix, handler, { json = true, order = 0 } = {}) {
    if (typeof prefix !== 'string' || !prefix.startsWith('/')) throw new Error(`mount prefix must start with "/": ${prefix}`);
    const router = express.Router();
    if (json) router.use(prefix, express.json(json === true ? { limit: JSON_LIMIT } : json));
    router.use(prefix, handler);
    // `:params` work as in app.use(); the prefix matches itself and everything below.
    const scope = compilePath(prefix === '/' ? '/*' : `${prefix.replace(/\/+$/, '')}/*`);
    const mount = { kind: 'mount', prefix, router, scope, wildcard: true, order };
    return this._register(this.routes, mount, byPrecedence, `http.mount(${prefix})`);
  }

  /**
   * Runs before routes. `order < 0` runs before compression and body parsing
   * (raw streams); the default 0 runs after. A middleware is
   * `(req, res, next)`; it may also answer the request or throw an HttpError.
   */
  use(middleware, { order = 0 } = {}) {
    return this._register(this.middlewares, { middleware, order }, byOrder, 'http.use()');
  }

  /** Handles upgrades (WebSocket) for a path: `{ req, socket, head, url, params }`. */
  upgrade(path, handler) {
    const route = { path, handler, ...compilePath(path) };
    return this._register(this.upgrades, route, byPrecedence, `http.upgrade(${path})`);
  }

  /**
   * Accepts WebSockets on a path: `handler({ ws, req, url, params })`.
   * Connections the handler keeps are its own to close when it unloads.
   */
  websocket(path, handler) {
    return this.upgrade(path, ({ req, socket, head, url, params }) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        req[UPGRADED_SOCKET] = ws;
        handler({ ws, req, url, params });
      });
    });
  }

  /**
   * Sees every upgrade before the upgrade routes, in `order`. A hook returns
   * true when it took the socket; it may throw an HttpError to refuse it.
   */
  useUpgrade(hook, { order = 0 } = {}) {
    return this._register(this.upgradeHooks, { hook, order }, byOrder, 'http.useUpgrade()');
  }

  _register(list, item, compare, label) {
    item.seq = ++this._seq;
    return this.ctx.effect(() => {
      list.push(item);
      list.sort(compare);
      return () => remove(list, item);
    }, label);
  }

  _runMiddlewares(req, res, done, select) {
    const queue = this.middlewares.filter(select);
    let index = 0;
    const next = (error) => {
      if (error) return done(error);
      if (res.writableEnded) return undefined;
      const item = queue[index++];
      if (!item) return done();
      try {
        const result = item.middleware(req, res, next);
        if (result && typeof result.then === 'function') result.then(undefined, next);
      } catch (thrown) {
        next(thrown);
      }
      return undefined;
    };
    next();
  }

  async _dispatch(req, res, done) {
    try {
      // req.url, not originalUrl: the /n/local/ relay rewrites it in place.
      const url = new URL(req.url || '/', 'http://localhost');
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      let allowed = false;
      for (const route of [...this.routes]) {
        if (route.kind === 'mount') {
          if (!matchPath(route.scope, url.pathname)) continue;
          const passed = await new Promise((resolve, reject) => {
            route.router(req, res, (error) => (error ? reject(error) : resolve(true)));
            res.once('finish', () => resolve(false));
            res.once('close', () => resolve(false));
          });
          if (!passed || res.headersSent) return;
          continue;
        }
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
      if (allowed) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      done();
    } catch (error) {
      this._fail(res, error);
    }
  }

  _fail(res, error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof HttpError) {
      sendError(res, error);
      return;
    }
    // Body-parser and other http-errors carry a client status.
    const status = Number(error?.status || error?.statusCode);
    if (status >= 400 && status < 500 && error?.expose !== false) {
      sendError(res, new HttpError(status, 'BAD_REQUEST', error.message || 'Bad request'));
      return;
    }
    this.ctx.logger.error(error);
    sendError(res, new HttpError(500, 'INTERNAL', 'Internal error'));
  }

  async _upgrade(req, socket, head) {
    const refuse = (status, text) => {
      if (socket.writable) socket.end(`HTTP/1.1 ${status} ${text}\r\n\r\n`);
      socket.destroy();
    };
    try {
      for (const { hook } of [...this.upgradeHooks]) {
        const seen = new URL(req.url || '/', 'http://localhost');
        if (await hook({ req, socket, head, url: seen })) return;
        if (socket.destroyed) return;
      }
      // A hook may have rewritten req.url (the /n/local/ relay does).
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

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}
