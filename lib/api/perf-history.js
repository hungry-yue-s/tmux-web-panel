// 1-hour ring buffer of compact perf snapshots, sampled every 2s.
// Memory budget: 1800 points × ~2 KB = ~3.5 MB.

import { sampleWindowStats } from './window-stats.js';

const RING_SIZE = 1800;          // 1800 × 2s = 3600s = 1h
const SAMPLE_INTERVAL_MS = 2000;
const TOP_N = 10;                // keep top N windows per point

const ring = new Array(RING_SIZE);
let head = 0;     // next write index
let count = 0;    // total entries so far (capped at RING_SIZE)
let timer = null;

function compactSnapshot(snap) {
  const t = snap.total;
  const windows = (snap.windows || []).map((w) => ({
    key: `${w.session}|${w.windowIndex}`,
    cpu: w.cpuPercent,
    mem: w.memBytes,
    io: w.ioBps,
  }));
  windows.sort((a, b) => b.cpu - a.cpu);
  return {
    ts: Date.now(),
    total: {
      cpu: Number.isFinite(t.systemCpuPercent)
        ? t.systemCpuPercent
        : (t.cpuCount > 0 ? (t.windowCpuPercent / (t.cpuCount * 100)) * 100 : 0),
      tmuxCpu: t.windowCpuPercent,
      mem: t.systemMemUsed,
      io: Number.isFinite(t.systemDiskIoBps) ? t.systemDiskIoBps : t.windowIoBps,
      tmuxIo: t.windowIoBps,
      load1: t.load1,
    },
    top: windows.slice(0, TOP_N),
  };
}

export async function sampleAndStore() {
  try {
    const snap = await sampleWindowStats();
    ring[head] = compactSnapshot(snap);
    head = (head + 1) % RING_SIZE;
    if (count < RING_SIZE) count++;
  } catch (err) {
    // Skip this tick; next sample will retry. Log once per ~minute to avoid noise.
    if (count % 30 === 0) console.error('[perf-history] sample failed:', err.message);
  }
}

export function getHistory(windowSeconds) {
  const cutoff = Date.now() - windowSeconds * 1000;
  const out = [];
  const maxPoints = Math.ceil((windowSeconds * 1000) / SAMPLE_INTERVAL_MS);
  // Walk ring oldest → newest.
  const start = count < RING_SIZE ? 0 : head;
  for (let i = 0; i < count; i++) {
    const p = ring[(start + i) % RING_SIZE];
    if (p && p.ts >= cutoff) out.push(p);
  }
  return { points: out.slice(-maxPoints) };
}

export function startSampler() {
  if (timer) return;
  sampleAndStore();
  timer = setInterval(sampleAndStore, SAMPLE_INTERVAL_MS);
  timer.unref?.();
}

export function stopSampler() {
  if (timer) clearInterval(timer);
  timer = null;
}

// === Test hooks ===
export const _ringSize = RING_SIZE;
export function _resetForTests() {
  ring.fill(undefined);
  head = 0;
  count = 0;
  stopSampler();
}

import { Router } from 'express';
const router = Router();
router.get('/', (req, res) => {
  const raw = Number(req.query.window);
  const windowSeconds = Number.isFinite(raw) ? Math.max(10, Math.min(3600, raw)) : 60;
  res.json({ success: true, data: getHistory(windowSeconds), error: null });
});
export default router;
