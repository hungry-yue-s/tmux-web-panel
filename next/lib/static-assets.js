import express from 'express';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

// Static files for slow links.
//
// The HTML pages are rendered with every local script, stylesheet and font
// URL rewritten to carry a hash of that file's content (`?h=…`). Those URLs
// are cached by browsers for a year, so a returning client loads the panel
// with one HTML request. The pages themselves are always revalidated (ETag),
// so editing a file under public/ still shows up on the next refresh — the
// new content means a new hash, hence a new URL.
//
// Files that already carry a hash in their name (the font slices) are cached
// the same way. Everything else is revalidated on each use.

const ASSET_REF_RE = /(\b(?:src|href)=")(\/(?:js|css|vendor|fonts)\/[^"?#]+)(?:\?[^"#]*)?(")/g;
const HASHED_NAME_RE = /\.[0-9a-f]{10}\.[a-z0-9]+$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const PAGE_RE = /^\/(?:[A-Za-z0-9_-]+\.html)?$/;

export function createStaticAssets(publicDir) {
  const root = resolve(publicDir);
  const fileHashes = new Map(); // absolute path -> { mtimeMs, size, hash }

  function inside(path) {
    return path === root || path.startsWith(root + sep);
  }

  async function hashOf(urlPath) {
    const file = resolve(join(root, decodeURIComponent(urlPath)));
    if (!inside(file)) return null;
    let info;
    try {
      info = await stat(file);
    } catch {
      return null;
    }
    const cached = fileHashes.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.hash;
    const hash = createHash('sha256').update(await readFile(file)).digest('hex').slice(0, 12);
    fileHashes.set(file, { mtimeMs: info.mtimeMs, size: info.size, hash });
    return hash;
  }

  /** The page with each local asset URL pinned to its current content hash. */
  async function renderPage(name) {
    const html = await readFile(join(root, name), 'utf8');
    const refs = [...html.matchAll(ASSET_REF_RE)].map((m) => m[2]);
    const hashes = new Map(await Promise.all([...new Set(refs)].map(async (ref) => [ref, await hashOf(ref)])));
    return html.replace(ASSET_REF_RE, (whole, before, path, after) => {
      const hash = hashes.get(path);
      if (!hash || HASHED_NAME_RE.test(path)) return whole;
      return before + path + '?h=' + hash + after;
    });
  }

  const router = express.Router();

  router.get(PAGE_RE, async (req, res, next) => {
    const name = req.path === '/' ? 'index.html' : req.path.slice(1);
    let html;
    try {
      html = await renderPage(name);
    } catch {
      return next();
    }
    res.set('Cache-Control', 'no-cache');
    // res.send adds an ETag and answers 304 when the page is unchanged.
    res.type('html').send(html);
  });

  router.use(express.static(root, {
    etag: true,
    lastModified: true,
    maxAge: 0,
    setHeaders(res, path) {
      const hashed = HASHED_NAME_RE.test(path) || (res.req && res.req.query && typeof res.req.query.h === 'string');
      res.setHeader('Cache-Control', hashed ? IMMUTABLE : 'no-cache');
    },
  }));

  return router;
}
