// Replacing a file by renaming a finished temporary copy over it.
//
// On Windows that rename fails with EPERM, EACCES or EBUSY while anything else
// has the destination open: a reader, an antivirus scan, the search indexer.
// It lasts milliseconds, so retry for a bounded time (graceful-fs does the
// same) instead of losing the write. Elsewhere, and for any other error, the
// first failure is final.

import { rename } from 'node:fs/promises';

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
export const REPLACE_RETRY_MS = 2000;

export async function replaceFile(from, to, {
  platform = process.platform, retryForMs = REPLACE_RETRY_MS, renameFile = rename,
} = {}) {
  const started = Date.now();
  for (let delay = 10; ; delay = Math.min(delay * 2, 200)) {
    try {
      return await renameFile(from, to);
    } catch (error) {
      if (platform !== 'win32' || !TRANSIENT.has(error.code) || Date.now() - started >= retryForMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
