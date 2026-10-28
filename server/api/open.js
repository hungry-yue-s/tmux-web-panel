import { Router } from 'express';
import { spawn } from 'node:child_process';
import { requireSameOrigin } from './same-origin.js';

// `twp open <file|url>` from a pane: asks every browser watching this machine
// to preview the file (or show the page in the browser block). Also runs a
// notebook through Jupyter for the notebook block.

const NOTEBOOK_TIMEOUT_MS = 10 * 60 * 1000;

function fail(res, status, error) {
  res.status(status).json({ success: false, data: null, error });
}

export function createOpenRouter({ pathGuard, broadcast }) {
  const router = Router();

  // The CLI calls this with the node token from the pairing file, so there is
  // no browser Origin to check.
  router.post('/', async (req, res) => {
    try {
      const { path, url, paneId } = req.body || {};
      if (paneId != null && (typeof paneId !== 'string' || !/^%\d+$/.test(paneId))) return fail(res, 400, 'invalid_pane');
      if (typeof url === 'string' && url) {
        if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 4096) return fail(res, 400, 'invalid_url');
        broadcast({ type: 'open-url', url, paneId: paneId || null });
        return res.json({ success: true, data: { url }, error: null });
      }
      const target = await pathGuard.resolve(path, paneId);
      if (target.error) return fail(res, target.status, target.error);
      broadcast({ type: 'open-file', path: target.linkPath, paneId: paneId || null });
      return res.json({ success: true, data: { path: target.linkPath }, error: null });
    } catch (error) {
      return fail(res, 500, error.message);
    }
  });

  return router;
}

export function createNotebookRouter({ pathGuard, run = runJupyter }) {
  const router = Router();
  router.use(requireSameOrigin);

  router.post('/execute', async (req, res) => {
    try {
      const target = await pathGuard.resolve((req.body || {}).path);
      if (target.error) return fail(res, target.status, target.error);
      if (!target.stat.isFile() || !/\.ipynb$/i.test(target.linkPath)) return fail(res, 400, 'not_a_notebook');
      const result = await run(target.nativePath);
      if (!result.ok) return fail(res, result.status || 400, result.error);
      return res.json({ success: true, data: { path: target.linkPath }, error: null });
    } catch (error) {
      return fail(res, 500, error.message);
    }
  });

  return router;
}

export function runJupyter(file) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('jupyter', ['nbconvert', '--to', 'notebook', '--execute', '--inplace', file], {
        windowsHide: true,
        env: process.env,
      });
    } catch {
      resolve({ ok: false, status: 501, error: 'jupyter_not_installed' });
      return;
    }
    const err = [];
    const timer = setTimeout(() => child.kill(), NOTEBOOK_TIMEOUT_MS);
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, status: error.code === 'ENOENT' ? 501 : 500, error: error.code === 'ENOENT' ? 'jupyter_not_installed' : error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else {
        const text = Buffer.concat(err).toString('utf8').trim().split('\n').slice(-12).join('\n');
        resolve({ ok: false, status: 400, error: text || `jupyter exited with ${code}` });
      }
    });
  });
}
