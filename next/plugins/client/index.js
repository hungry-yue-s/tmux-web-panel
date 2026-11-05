// `ctx.client`: the browser side of the panel.
//
// The browser runs the same Cordis kernel as the server. Which client plugins
// it loads is decided here, not in the page: each server plugin that has a UI
// registers its client entry with `ctx.client.entry(url)`, and the page loads
// whatever the manifest lists. Disposing the server plugin removes its entry.
//
// No bundler: the page carries an import map that pins every module URL to a
// hash of its content (`?h=…`), so modules are cached for a year and a changed
// file is a new URL. The page itself is always revalidated.

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Service } from 'cordis';
import { ROOT } from '../../kernel/profile.js';
import { HttpError } from '../http/index.js';

export const name = 'client';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const MODULE_RE = /\.m?js$/;
const ASSET_REF_RE = /(\b(?:src|href)=")(\/client\/[^"?#]+)(?:\?[^"#]*)?(")/g;
const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** Bare specifiers client code may import, and the file each one is. */
const BARE = {
  cordis: '/client/vendor/cordis/index.js',
  cosmokit: '/client/vendor/cosmokit/index.mjs',
  '@cordisjs/plugin-timer': '/client/vendor/plugin-timer/index.js',
  '@twp/client': '/client/lib/index.js',
};

/** The client's own services: every page loads these before any plugin entry. */
const CORE_ENTRIES = ['/client/core/api.js', '/client/core/shell.js'];

function shortHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 10);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function walk(dir, prefix = '') {
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const item of items) {
    if (item.name.startsWith('.')) continue;
    if (item.isDirectory()) files.push(...await walk(join(dir, item.name), `${prefix}${item.name}/`));
    else if (item.isFile()) files.push(prefix + item.name);
  }
  return files;
}

/**
 * @typedef {object} ClientConfig
 * @property {string} [title] page title
 */

export default class ClientService extends Service {
  static inject = ['http'];

  /** @param {ClientConfig} [config] */
  constructor(ctx, config) {
    super(ctx, 'client');
    this.title = config?.title ?? 'tmux 面板';
    /** url prefix → { dir, refs } */
    this.roots = new Map();
    /** { url, config } in registration order */
    this.entries = [];
    /** absolute path → { mtimeMs, size, hash } */
    this.hashes = new Map();

    // The kernel first: /client/vendor/… must not fall into the /client/ root.
    this._addRoot('/client/vendor/cordis/', join(ROOT, 'vendor', 'cordis', 'lib'));
    this._addRoot('/client/vendor/cosmokit/', join(ROOT, 'vendor', 'cosmokit', 'lib'));
    this._addRoot('/client/vendor/plugin-timer/', join(ROOT, 'vendor', 'plugin-timer', 'lib'));
    this._addRoot('/client/', join(ROOT, 'client'));

    // The plugin-only shell. The site's own pages (the ui plugin) live at /.
    ctx.http.get('/client/', ({ res }) => this._sendPage(res));
    ctx.http.get('/client/index.html', ({ res }) => this._sendPage(res));
    ctx.http.get('/api/client/manifest', () => this.manifest());
    for (const pattern of ['/client/*', '/@plugin/*']) {
      ctx.http.get(pattern, ({ req, res, url }) => this._sendFile(req, res, url));
    }
  }

  /**
   * Adds a client plugin for the calling server plugin. `file` is the module's
   * location on disk (usually `new URL('./client/index.js', import.meta.url)`);
   * its directory is served, so relative imports inside it work. The entry and
   * the directory go away with the calling plugin.
   */
  entry(file, config) {
    const path = file instanceof URL || String(file).startsWith('file:') ? fileURLToPath(file) : resolve(String(file));
    const dir = dirname(path);
    const prefix = `/@plugin/${shortHash(dir)}/`;
    const record = { url: prefix + basename(path), config: config ?? null };
    return this.ctx.effect(() => {
      this._addRoot(prefix, dir);
      this.entries.push(record);
      return () => {
        const index = this.entries.indexOf(record);
        if (index >= 0) this.entries.splice(index, 1);
        this._removeRoot(prefix);
      };
    }, `client.entry(${basename(dirname(dir))})`);
  }

  /** What the page loads: the core services, then each plugin entry. */
  manifest() {
    return {
      title: this.title,
      entries: [...CORE_ENTRIES.map((url) => ({ url, config: null })), ...this.entries],
    };
  }

  /** Maps each bare specifier and every module URL to its content-hashed URL. */
  async importMap() {
    const imports = {};
    for (const [specifier, url] of Object.entries(BARE)) {
      const hash = await this._hashOf(url);
      if (hash) imports[specifier] = `${url}?h=${hash}`;
    }
    for (const [prefix, root] of this.roots) {
      for (const file of await walk(root.dir)) {
        if (!MODULE_RE.test(file)) continue;
        const url = prefix + file;
        const hash = await this._hashOf(url);
        if (hash) imports[url] = `${url}?h=${hash}`;
      }
    }
    return { imports };
  }

  _addRoot(prefix, dir) {
    const root = this.roots.get(prefix);
    if (root) root.refs += 1;
    else this.roots.set(prefix, { dir, refs: 1 });
  }

  _removeRoot(prefix) {
    const root = this.roots.get(prefix);
    if (!root) return;
    root.refs -= 1;
    if (root.refs <= 0) this.roots.delete(prefix);
  }

  /** The file a URL path names, if it lies inside a served root. */
  _locate(pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0')) return null;
    for (const [prefix, root] of this.roots) {
      if (!decoded.startsWith(prefix)) continue;
      const rest = decoded.slice(prefix.length);
      if (!rest || rest.split('/').some((part) => part.startsWith('.'))) return null;
      const file = resolve(root.dir, rest);
      if (file !== root.dir && !file.startsWith(root.dir + sep)) return null;
      return file;
    }
    return null;
  }

  async _hashOf(url) {
    const file = this._locate(url);
    if (!file) return null;
    let info;
    try {
      info = await stat(file);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;
    const cached = this.hashes.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.hash;
    const hash = createHash('sha256').update(await readFile(file)).digest('hex').slice(0, 12);
    this.hashes.set(file, { mtimeMs: info.mtimeMs, size: info.size, hash });
    return hash;
  }

  async renderPage() {
    const template = await readFile(join(ROOT, 'client', 'index.html'), 'utf8');
    const refs = [...new Set([...template.matchAll(ASSET_REF_RE)].map((match) => match[2]))];
    const hashes = new Map(await Promise.all(refs.map(async (ref) => [ref, await this._hashOf(ref)])));
    // `<` is escaped so no file name can close the script element early.
    const map = JSON.stringify(await this.importMap()).replace(/</g, '\\u003c');
    return template
      .replace('<!--title-->', escapeHtml(this.title))
      .replace('<!--importmap-->', `<script type="importmap">${map}</script>`)
      .replace(ASSET_REF_RE, (whole, before, path, after) => {
        const hash = hashes.get(path);
        return hash ? `${before}${path}?h=${hash}${after}` : whole;
      });
  }

  async _sendPage(res) {
    const html = await this.renderPage();
    const etag = `"${shortHash(html)}"`;
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', etag);
    if (res.req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Content-Length': Buffer.byteLength(html) });
    res.end(res.req.method === 'HEAD' ? undefined : html);
  }

  async _sendFile(req, res, url) {
    const file = this._locate(url.pathname);
    const hash = file && await this._hashOf(url.pathname);
    if (!hash) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    const etag = `"${hash}"`;
    res.setHeader('Cache-Control', url.searchParams.get('h') === hash ? IMMUTABLE : 'no-cache');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      res.end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }
}
