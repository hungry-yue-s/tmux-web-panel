/**
 * NotificationStore — server-side notification persistence.
 *
 * Stores task-completion notifications in a JSON file so they survive
 * service restarts and are accessible from any device/browser.
 *
 * Cleanup policy: read notifications older than 1 hour are automatically
 * removed. Unread notifications are kept indefinitely.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const PERSIST_DEBOUNCE_MS = 2000;
const REAP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const READ_TTL_MS = 60 * 60 * 1000; // 1 hour

export class NotificationStore {
  /**
   * @param {string} filePath — absolute path to the JSON persistence file
   */
  constructor(filePath) {
    /** @type {Array<{id: string, session: string, windowIndex: number, windowName: string, command: string, paneId: string, timestamp: number, read: boolean, readAt: number|null}>} */
    this._notifications = [];
    this._filePath = filePath;
    this._persistTimer = null;
    this._reapTimer = null;

    this._load();
  }

  /** Start the periodic reaper that removes stale read notifications. */
  startReaper() {
    if (this._reapTimer) return;
    this._reapTimer = setInterval(() => this._reap(), REAP_INTERVAL_MS);
  }

  stopReaper() {
    if (this._reapTimer) {
      clearInterval(this._reapTimer);
      this._reapTimer = null;
    }
  }

  /**
   * Add a new notification.
   * @param {{ session: string, windowIndex: number, windowName?: string, prevCommand?: string, paneId?: string }} entry
   * @returns {object} the created notification
   */
  add(entry) {
    const notification = {
      id: randomBytes(8).toString('hex'),
      session: entry.session,
      windowIndex: entry.windowIndex,
      windowName: entry.windowName || '',
      command: entry.prevCommand || '',
      paneId: entry.paneId || '',
      timestamp: Date.now(),
      read: false,
      readAt: null,
    };
    this._notifications.unshift(notification);
    this._schedulePersist();
    return notification;
  }

  /** Get all notifications (newest first). */
  getAll() {
    return this._notifications;
  }

  /**
   * Mark a single notification as read.
   * @param {string} id
   * @returns {boolean} true if found and updated
   */
  markRead(id) {
    const n = this._notifications.find((n) => n.id === id);
    if (!n || n.read) return !!n;
    n.read = true;
    n.readAt = Date.now();
    this._schedulePersist();
    return true;
  }

  /**
   * Mark all notifications for a given session + window as read.
   * @param {string} session
   * @param {number|string} windowIndex
   * @returns {number} count of newly marked
   */
  markReadByWindow(session, windowIndex) {
    const winIdx = String(windowIndex);
    let count = 0;
    for (const n of this._notifications) {
      if (!n.read && n.session === session && String(n.windowIndex) === winIdx) {
        n.read = true;
        n.readAt = Date.now();
        count++;
      }
    }
    if (count > 0) this._schedulePersist();
    return count;
  }

  /** Clear all notifications. */
  clearAll() {
    this._notifications = [];
    this._schedulePersist();
  }

  /** Count of unread notifications. */
  unreadCount() {
    return this._notifications.filter((n) => !n.read).length;
  }

  // --- Internal ---

  /** Remove read notifications older than READ_TTL_MS. */
  _reap() {
    const now = Date.now();
    const before = this._notifications.length;
    this._notifications = this._notifications.filter((n) => {
      if (!n.read) return true;
      return (now - n.readAt) < READ_TTL_MS;
    });
    if (this._notifications.length !== before) {
      this._schedulePersist();
    }
  }

  _load() {
    try {
      const raw = readFileSync(this._filePath, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        this._notifications = data;
        // Run an immediate reap to clean stale entries from disk
        this._reap();
      }
    } catch (_e) {
      // File doesn't exist yet or is corrupt — start fresh
    }
  }

  _schedulePersist() {
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  _persistNow() {
    try {
      mkdirSync(dirname(this._filePath), { recursive: true });
      writeFileSync(this._filePath, JSON.stringify(this._notifications), 'utf8');
    } catch (_e) {
      // Best-effort
    }
  }
}
