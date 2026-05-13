window.PerfUtils = (function () {
// Pure helpers for the perf panel. No DOM access, no fetch, safe to unit test.

const ALERT_THRESHOLDS = {
  cpuMachine:  { warn: 60, critical: 80 },      // % of all cores
  windowCpu:   { warn: 80, critical: 200 },     // absolute % (per window)
  memMachine:  { warn: 70, critical: 85 },      // % of total RAM
  windowMem:   { warn: 5,  critical: 8 },       // % of total RAM (per window)
  disk:        { warn: 80, critical: 95 },      // % per mount
  loadPerCore: { warn: 0.7, critical: 1.0 },    // load1 / cpuCount
};

const PALETTE = ['#f7768e','#e0af68','#7aa2f7','#9ece6a','#bb9af7','#7dcfff','#ff9e64','#73daca','#c0caf5','#f4a261'];

function colorFor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) & 0xffffffff;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function fmtBytes(n) {
  if (n == null) return '—';
  if (n === 0) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  const d = v >= 10 ? 0 : 1;
  return `${v.toFixed(d)} ${u[i]}`;
}

function fmtBps(n) { return `${fmtBytes(n)}/s`; }

function fmtUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtPercent(v, d = 1) {
  return `${v.toFixed(v >= 10 ? 0 : d)}%`;
}

// Returns {line, fill} SVG path strings sized to fit `w × h`.
function sparkPath(values, w, h, opts = {}) {
  if (!values || values.length === 0) return { line: '', fill: '' };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = opts.pad ?? 1;
  const innerH = h - pad * 2;
  const dx = values.length > 1 ? w / (values.length - 1) : 0;
  const pts = values.map((v, i) => [
    values.length > 1 ? i * dx : w / 2,
    pad + innerH - ((v - min) / range) * innerH,
  ]);
  const line = pts.map((p, i) =>
    (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)
  ).join('');
  const fill = `${line}L${w},${h}L0,${h}Z`;
  return { line, fill };
}

// item: { cpuPercent, memBytes, ioBps }; total: { cpuCount, systemMemTotal, windowIoBps }
function pressureScore(item, total) {
  const cpuShare = total.cpuCount > 0 ? item.cpuPercent / (total.cpuCount * 100) : 0;
  const memShare = total.systemMemTotal > 0 ? item.memBytes / total.systemMemTotal : 0;
  const ioShare  = total.windowIoBps > 0 ? item.ioBps / total.windowIoBps : 0;
  return (cpuShare * 0.5 + memShare * 0.35 + ioShare * 0.15) * 100;
}

// Returns { critical: [...], warn: [...] }; each entry: { kind, message, severity }.
function detectAlerts(snap) {
  const out = { critical: [], warn: [] };
  const t = snap.total;
  const cpuMachinePct = t.cpuCount > 0 ? (t.windowCpuPercent / (t.cpuCount * 100)) * 100 : 0;
  const memMachinePct = t.systemMemTotal > 0 ? (t.systemMemUsed / t.systemMemTotal) * 100 : 0;
  const loadPerCore = t.cpuCount > 0 ? t.load1 / t.cpuCount : 0;

  const push = (bucket, kind, message) => out[bucket].push({ kind, message, severity: bucket });

  if (cpuMachinePct >= ALERT_THRESHOLDS.cpuMachine.critical) push('critical', 'cpu-machine', `机器 CPU ${cpuMachinePct.toFixed(0)}%`);
  else if (cpuMachinePct >= ALERT_THRESHOLDS.cpuMachine.warn) push('warn', 'cpu-machine', `机器 CPU ${cpuMachinePct.toFixed(0)}%`);

  if (memMachinePct >= ALERT_THRESHOLDS.memMachine.critical) push('critical', 'mem-machine', `内存 ${memMachinePct.toFixed(0)}%`);
  else if (memMachinePct >= ALERT_THRESHOLDS.memMachine.warn) push('warn', 'mem-machine', `内存 ${memMachinePct.toFixed(0)}%`);

  if (loadPerCore >= ALERT_THRESHOLDS.loadPerCore.critical) push('critical', 'load', `load ${t.load1.toFixed(2)} / ${t.cpuCount} cores`);
  else if (loadPerCore >= ALERT_THRESHOLDS.loadPerCore.warn) push('warn', 'load', `load ${t.load1.toFixed(2)}`);

  (snap.windows || []).forEach((w) => {
    if (w.cpuPercent >= ALERT_THRESHOLDS.windowCpu.critical) push('critical', 'window-cpu', `${w.session}:${w.windowIndex} ${w.cpuPercent.toFixed(0)}% CPU`);
    const wMemPct = t.systemMemTotal > 0 ? (w.memBytes / t.systemMemTotal) * 100 : 0;
    if (wMemPct >= ALERT_THRESHOLDS.windowMem.critical) push('critical', 'window-mem', `${w.session}:${w.windowIndex} ${wMemPct.toFixed(1)}% of RAM`);
  });

  (snap.disks || []).forEach((d) => {
    if (d.percent >= ALERT_THRESHOLDS.disk.critical) push('critical', 'disk', `${d.mount} ${d.percent}%`);
    else if (d.percent >= ALERT_THRESHOLDS.disk.warn) push('warn', 'disk', `${d.mount} ${d.percent}%`);
  });

  return out;
}

return {
  ALERT_THRESHOLDS, colorFor, fmtBytes, fmtBps, fmtUptime, fmtPercent,
  sparkPath, pressureScore, detectAlerts,
};
})();
