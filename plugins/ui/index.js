// `ctx.ui`: the pages and their static files.
//
// The main page is composed, not written by hand: every plugin with a front
// end contributes its directory and its scripts and styles (`page.json`, see
// compose.js) through `ctx.ui.contribute(...)`, and the page is the ui
// plugin's template with those parts in one global order. A plugin that is
// not loaded contributes nothing; its scripts are not on the page.
//
// URLs stay what they always were (/js/…, /css/…, /fonts/…, /vendor/…): each
// plugin serves its client directory at "/", and the directories are tried
// in registration order. Pages are always revalidated; every local script,
// stylesheet and font URL in them is pinned to a content hash (?h=…) and
// cached for a year, so an edited file shows up on the next refresh without
// a restart. Mounted last (order 1000): every API is tried first.

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Service } from 'cordis';
import express from 'express';
import { REPO_ROOT } from '../../lib/paths.js';
import { composePage, readContribution } from './compose.js';
import { moveLegacyRelayConfig } from './relay-config.js';

export const name = 'ui';

const ASSET_REF_RE = /(\b(?:src|href)=")(\/(?:js|css|vendor|fonts)\/[^"?#]+)(?:\?[^"#]*)?(")/g;
const HASHED_NAME_RE = /\.[0-9a-f]{10}\.[a-z0-9]+$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const PAGE_RE = /^\/(?:[A-Za-z0-9_-]+\.html)?$/;

export const TEMPLATE = fileURLToPath(new URL('./client/index.html', import.meta.url));
export const OWN_CONTRIBUTION = fileURLToPath(new URL('./client/page.json', import.meta.url));
const RELAY_CONFIG = fileURLToPath(new URL('./client/js/relay-config.js', import.meta.url));

function toPath(file) {
  return file instanceof URL || String(file).startsWith('file:') ? fileURLToPath(file) : resolve(String(file));
}

function setCacheHeaders(res, path) {
  const hashed = HASHED_NAME_RE.test(path) || (res.req && res.req.query && typeof res.req.query.h === 'string');
  res.setHeader('Cache-Control', hashed ? IMMUTABLE : 'no-cache');
}

export default class UiService extends Service {
  static inject = ['launch', 'http'];

  constructor(ctx) {
    super(ctx, 'ui');
    this._seq = 0;
    /** { dir, seq, handler } — tried in order */
    this.roots = [];
    /** { slot, order, seq, ...kind | render } */
    this.parts = [];
    /** absolute path → { mtimeMs, size, hash } */
    this.hashes = new Map();

    const launch = ctx.launch;
    if (launch.managedRuntime) {
      // The desktop app's relay page, from its settings rather than a file.
      ctx.http.get('/js/relay-config.js', ({ res }) => {
        res.type('application/javascript').set('Cache-Control', 'no-store')
          .send(`window.PANEL_RELAY_PAGE = ${JSON.stringify(launch.relayPage)};\n`);
      });
    } else {
      try {
        if (moveLegacyRelayConfig(REPO_ROOT, RELAY_CONFIG)) ctx.logger.info('moved public/js/relay-config.js to %s', RELAY_CONFIG);
      } catch (error) {
        ctx.logger.warn('could not move public/js/relay-config.js: %s', error.message);
      }
    }

    this.contribute(OWN_CONTRIBUTION);

    const router = express.Router();
    router.get(PAGE_RE, (req, res, next) => {
      this._sendPage(req, res, next).catch(next);
    });
    router.use((req, res, next) => this._sendStatic(req, res, next));
    ctx.http.mount('/', router, { json: false, order: 1000 });
  }

  /** Adds a plugin's page.json: its served directories and its page parts. */
  contribute(file) {
    const contribution = readContribution(toPath(file));
    return this.ctx.effect(() => {
      const removers = [
        ...contribution.serve.map((dir) => this._add(this.roots, { dir, handler: this._staticFor(dir) })),
        ...contribution.parts.map((part) => this._add(this.parts, { ...part })),
      ];
      return () => removers.forEach((remove) => remove());
    }, `ui.contribute(${basename(resolve(contribution.file, '..', '..'))})`);
  }

  /** Adds one part computed at render time, e.g. the import map. */
  part(slot, order, render) {
    const item = { slot, order, render: typeof render === 'function' ? render : () => render };
    return this.ctx.effect(() => this._add(this.parts, item), `ui.part(${slot}, ${order})`);
  }

  /** Serves one more directory at "/". */
  serve(dir) {
    const path = toPath(dir);
    return this.ctx.effect(() => this._add(this.roots, { dir: path, handler: this._staticFor(path) }), 'ui.serve()');
  }

  /** The composed main page, before content hashes are applied. */
  async composeIndex() {
    return composePage(await readFile(TEMPLATE, 'utf8'), this.parts);
  }

  /** A page with every local asset URL pinned to its current content hash. */
  async renderPage(name) {
    let html;
    if (name === 'index.html') {
      html = await this.composeIndex();
    } else {
      const file = await this._locate(`/${name}`);
      if (!file) return null;
      html = await readFile(file, 'utf8');
    }
    const refs = [...new Set([...html.matchAll(ASSET_REF_RE)].map((match) => match[2]))];
    const hashes = new Map(await Promise.all(refs.map(async (ref) => [ref, await this._hashOf(ref)])));
    return html.replace(ASSET_REF_RE, (whole, before, path, after) => {
      const hash = hashes.get(path);
      if (!hash || HASHED_NAME_RE.test(path)) return whole;
      return `${before}${path}?h=${hash}${after}`;
    });
  }

  _add(list, item) {
    item.seq = ++this._seq;
    list.push(item);
    return () => {
      const index = list.indexOf(item);
      if (index >= 0) list.splice(index, 1);
    };
  }

  _staticFor(dir) {
    return express.static(dir, { etag: true, lastModified: true, maxAge: 0, setHeaders: setCacheHeaders });
  }

  /** The first served file a URL path names, or null. */
  async _locate(urlPath) {
    let decoded;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.split('/').some((part) => part.startsWith('.') && part !== '')) return null;
    for (const root of [...this.roots]) {
      const file = resolve(root.dir, `.${decoded}`);
      if (file !== root.dir && !file.startsWith(root.dir + sep)) continue;
      try {
        if ((await stat(file)).isFile()) return file;
      } catch {
        // Not in this root.
      }
    }
    return null;
  }

  async _hashOf(urlPath) {
    const file = await this._locate(urlPath);
    if (!file) return null;
    const info = await stat(file);
    const cached = this.hashes.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.hash;
    const hash = createHash('sha256').update(await readFile(file)).digest('hex').slice(0, 12);
    this.hashes.set(file, { mtimeMs: info.mtimeMs, size: info.size, hash });
    return hash;
  }

  async _sendPage(req, res, next) {
    const name = req.path === '/' ? 'index.html' : req.path.slice(1);
    const html = await this.renderPage(name);
    if (html === null) return next();
    res.set('Cache-Control', 'no-cache');
    // res.send adds an ETag and answers 304 when the page is unchanged.
    res.type('html').send(html);
    return undefined;
  }

  _sendStatic(req, res, next) {
    const roots = [...this.roots];
    let index = 0;
    const tryNext = (error) => {
      if (error) return next(error);
      const root = roots[index++];
      if (!root) return next();
      return root.handler(req, res, tryNext);
    };
    tryNext();
  }
}
