import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export const MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
export const MAX_HTML_BYTES = 12 * 1024 * 1024; // 12 MiB snapshot cap
const ID_BYTES = 18; // 24-char base64url, unguessable

/**
 * Persisted store of shared file-preview snapshots.
 *
 * - Metadata (id -> { filename, createdAt, expiresAt }) lives in a JSON file,
 *   mirroring PinStore: serialized write queue + temp-file rename so readers
 *   never see a torn file.
 * - The (potentially large) snapshot HTML is stored one file per id under a
 *   sibling `snapshots/` directory, NOT inlined into the JSON.
 * - Expiry is enforced lazily on read AND swept periodically; expired entries
 *   delete both the metadata row and the snapshot file.
 */
export class ShareStore {
  constructor(filePath) {
    this.filePath = filePath; // shares.json
    this.snapDir = path.join(path.dirname(filePath), 'snapshots');
    this.meta = new Map(); // id -> { filename, createdAt, expiresAt }
    this._queue = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      this.meta.clear();
      for (const id of Object.keys(parsed)) {
        const m = parsed[id];
        if (m && typeof m.expiresAt === 'number') this.meta.set(id, m);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    // Drop anything already expired on boot (best-effort).
    await this.sweep();
  }

  _snapPath(id) {
    return path.join(this.snapDir, id + '.html');
  }

  _isExpired(m, now = Date.now()) {
    return !m || m.expiresAt <= now;
  }

  /**
   * Persist a snapshot. ttlMs is clamped to (0, MAX_TTL_MS]; html size capped.
   * @returns {{ id, filename, createdAt, expiresAt }}
   */
  async create({ html, filename, ttlMs }) {
    if (typeof html !== 'string' || html.length === 0) {
      throw new Error('html_required');
    }
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
      throw new Error('html_too_large');
    }
    const ttl = Number(ttlMs);
    if (!Number.isFinite(ttl) || ttl <= 0) throw new Error('invalid_ttl');
    const clamped = Math.min(ttl, MAX_TTL_MS);
    const name = (typeof filename === 'string' && filename.trim()) ? filename.trim().slice(0, 255) : 'preview';

    return this._enqueue(async () => {
      const id = crypto.randomBytes(ID_BYTES).toString('base64url');
      const now = Date.now();
      const entry = { filename: name, createdAt: now, expiresAt: now + clamped };
      await fs.mkdir(this.snapDir, { recursive: true, mode: DIR_MODE });
      const tmp = this._snapPath(id) + '.tmp';
      await fs.writeFile(tmp, html, { mode: FILE_MODE });
      await fs.rename(tmp, this._snapPath(id));
      this.meta.set(id, entry);
      await this._writeUnsafe();
      return { id, ...entry };
    });
  }

  /** Returns { filename, expiresAt, html } for a live share, else null. */
  async get(id) {
    const m = this.meta.get(id);
    if (this._isExpired(m)) {
      if (m) await this.delete(id); // lazy GC
      return null;
    }
    try {
      const html = await fs.readFile(this._snapPath(id), 'utf8');
      return { filename: m.filename, expiresAt: m.expiresAt, html };
    } catch (err) {
      if (err.code === 'ENOENT') { await this.delete(id); return null; }
      throw err;
    }
  }

  /** Live (unexpired) shares, newest first, without html bodies. */
  list() {
    const now = Date.now();
    const out = [];
    for (const [id, m] of this.meta.entries()) {
      if (!this._isExpired(m, now)) {
        out.push({ id, filename: m.filename, createdAt: m.createdAt, expiresAt: m.expiresAt });
      }
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  }

  async delete(id) {
    return this._enqueue(async () => {
      const existed = this.meta.delete(id);
      try { await fs.unlink(this._snapPath(id)); } catch (_) { /* already gone */ }
      if (existed) await this._writeUnsafe();
      return existed;
    });
  }

  /** Remove every expired entry (metadata + snapshot). */
  async sweep() {
    return this._enqueue(async () => {
      const now = Date.now();
      let changed = false;
      for (const [id, m] of Array.from(this.meta.entries())) {
        if (this._isExpired(m, now)) {
          this.meta.delete(id);
          try { await fs.unlink(this._snapPath(id)); } catch (_) { /* gone */ }
          changed = true;
        }
      }
      if (changed) await this._writeUnsafe();
    });
  }

  _enqueue(fn) {
    const next = this._queue.then(fn, fn);
    this._queue = next.catch(() => {});
    return next;
  }

  async _writeUnsafe() {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
    const obj = {};
    for (const [id, m] of this.meta.entries()) obj[id] = m;
    const tmp = this.filePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(obj), { mode: FILE_MODE });
    await fs.rename(tmp, this.filePath);
  }
}
