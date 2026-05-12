import fs from 'node:fs/promises';
import path from 'node:path';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Single-instance pin store backed by a JSON file.
 *
 * - Keys are tmux window_id strings ("@N"), values are `true` (presence is the bit).
 * - All mutations go through a serialized promise queue to avoid lost updates.
 * - Writes go to a temp file then rename, so readers never see a torn file.
 */
export class PinStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.pins = new Map();
    this._queue = Promise.resolve();
    this._loaded = false;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.pins.clear();
      for (const id of Object.keys(parsed)) {
        if (parsed[id]) this.pins.set(id, true);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    this._loaded = true;
  }

  has(windowId) {
    return this.pins.has(windowId);
  }

  list() {
    return Array.from(this.pins.keys());
  }

  async set(windowId, pinned) {
    return this._enqueue(async () => {
      if (pinned) {
        this.pins.set(windowId, true);
      } else {
        this.pins.delete(windowId);
      }
      await this._writeUnsafe();
    });
  }

  async sweep(liveIds) {
    return this._enqueue(async () => {
      let changed = false;
      for (const id of this.pins.keys()) {
        if (!liveIds.has(id)) {
          this.pins.delete(id);
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
    for (const id of this.pins.keys()) obj[id] = true;
    const tmp = this.filePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(obj), { mode: FILE_MODE });
    await fs.rename(tmp, this.filePath);
  }
}
