import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const utils = fs.readFileSync('public/js/perf-utils.js', 'utf8');
const panel = fs.readFileSync('public/js/perf-panel.js', 'utf8');

function bootDom({ windowStats = null, usageFails = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    runScripts: 'outside-only',
  });
  // Stub the global `api` ApiClient that perf-panel.js polls through (defined in app.js
  // in real usage). Routing by URL lets a test supply the snapshot the panel paints,
  // which is the only way in now that no tab click forces a synchronous repaint.
  const apiCalls = [];
  dom.window.__apiCalls = apiCalls;
  dom.window.api = {
    get: async (url) => {
      const target = String(url);
      apiCalls.push(target);
      if (usageFails && /claude-usage|codex-usage/.test(target)) return { success: false, data: null };
      if (target.includes('/api/window-stats')) {
        return { success: true, data: windowStats || { total: {}, windows: [], external: [], disks: [] } };
      }
      return { success: true, data: { points: [] } };
    },
  };
  // Defensive: also stub fetch in case any code path falls back to it
  dom.window.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: {} }) });
  dom.window.eval(utils);
  dom.window.eval(panel);
  return dom;
}

/** Lets the poll promises started by start() settle so the panels paint. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PerfPanel skeleton', () => {
  let dom, w;
  beforeEach(() => { dom = bootDom(); w = dom.window; });

  it('exposes renderSkeleton, start, stop', () => {
    expect(typeof w.PerfPanel.renderSkeleton).toBe('function');
    expect(typeof w.PerfPanel.start).toBe('function');
    expect(typeof w.PerfPanel.stop).toBe('function');
  });

  it('renderSkeleton returns HTML containing the view containers', () => {
    const html = w.PerfPanel.renderSkeleton();
    expect(html).toContain('id="perf-panel"');
    expect(html).toContain('id="perf-view-root"');
    expect(html).toContain('id="claude-view-root"');
    expect(html).toContain('id="codex-view-root"');
  });

  it('stacks all three panels with their own headings and no tab strip', () => {
    w.document.getElementById('root').innerHTML = w.PerfPanel.renderSkeleton();

    const headings = Array.from(w.document.querySelectorAll('#perf-panel .section-head h3'))
      .map((h) => h.textContent);
    expect(headings).toEqual(['机器性能', 'Claude 用量', 'Codex 用量']);
    // The tab strip competed with the page's own section tabs; it is gone.
    expect(w.document.querySelectorAll('#perf-panel .pp-tt')).toHaveLength(0);
    expect(w.document.querySelector('[data-view]')).toBeNull();
    // No mode preserves the legacy all-in-one dashboard.
    ['perf', 'claude', 'codex'].forEach((name) => {
      expect(w.document.getElementById(name + '-view-root')).not.toBeNull();
    });
  });

  it('renders and polls only machine plus Claude in performance mode', async () => {
    w.document.getElementById('root').innerHTML = w.PerfPanel.renderSkeleton('performance');
    expect(w.document.getElementById('perf-view-root')).not.toBeNull();
    expect(w.document.getElementById('claude-view-root')).not.toBeNull();
    expect(w.document.getElementById('codex-view-root')).toBeNull();

    w.PerfPanel.start('performance');
    await flush();
    expect(w.__apiCalls.some((url) => url.includes('/api/window-stats'))).toBe(true);
    expect(w.__apiCalls.some((url) => url.includes('/api/perf/history'))).toBe(true);
    expect(w.__apiCalls.some((url) => url.includes('/api/claude-usage'))).toBe(true);
    expect(w.__apiCalls.some((url) => url.includes('/api/codex-usage'))).toBe(false);
    w.PerfPanel.stop();
  });

  it('renders and polls only Codex in codex mode', async () => {
    w.document.getElementById('root').innerHTML = w.PerfPanel.renderSkeleton('codex');
    expect(w.document.getElementById('perf-view-root')).toBeNull();
    expect(w.document.getElementById('claude-view-root')).toBeNull();
    expect(w.document.getElementById('codex-view-root')).not.toBeNull();

    w.PerfPanel.start('codex');
    await flush();
    expect(w.__apiCalls).toEqual(['/api/codex-usage']);
    w.PerfPanel.stop();
  });

  it('puts each badge beside its own heading, with the count carrying a unit', async () => {
    const busy = bootDom({
      windowStats: {
        capabilities: { systemCpu: true, systemMemory: true },
        total: {
          cpuCount: 4, systemCpuPercent: 99, windowCpuPercent: 0,
          systemMemTotal: 8 * 1024 ** 3, systemMemUsed: 8 * 1024 ** 3, systemMemCached: 0,
          hostname: 'host.test', load1: 40, uptime: 60,
        },
        windows: [], external: [], disks: [],
      },
    }).window;
    busy.document.getElementById('root').innerHTML = busy.PerfPanel.renderSkeleton();
    busy.PerfPanel.start();
    await flush();

    const perfBadge = busy.document.getElementById('pp-badge-perf');
    // A count and a percentage used to share one row and one style; the unit
    // keeps them apart now that each sits by its own heading.
    expect(perfBadge.hidden).toBe(false);
    expect(perfBadge.textContent).toMatch(/^\d+ 项告警$/);
    expect(perfBadge.className).toBe('ms-badge red');
    expect(perfBadge.closest('.section-head').querySelector('h3').textContent).toBe('机器性能');
    busy.PerfPanel.stop();
  });

  it('hides the alert badge when nothing is firing', async () => {
    const idle = bootDom({
      windowStats: {
        capabilities: { systemCpu: true, systemMemory: true },
        total: {
          cpuCount: 8, systemCpuPercent: 3, windowCpuPercent: 0,
          systemMemTotal: 16 * 1024 ** 3, systemMemUsed: 1024 ** 3, systemMemCached: 0,
          hostname: 'host.test', load1: 0.1, uptime: 60,
        },
        windows: [], external: [], disks: [],
      },
    }).window;
    idle.document.getElementById('root').innerHTML = idle.PerfPanel.renderSkeleton();
    idle.PerfPanel.start();
    await flush();

    expect(idle.document.getElementById('pp-badge-perf').hidden).toBe(true);
    idle.PerfPanel.stop();
  });

  it('says a usage panel has no data rather than sitting on its load message', async () => {
    const noUsage = bootDom({ usageFails: true }).window;
    noUsage.document.getElementById('root').innerHTML = noUsage.PerfPanel.renderSkeleton();
    noUsage.PerfPanel.start();
    await flush();

    ['claude', 'codex'].forEach((name) => {
      const text = noUsage.document.getElementById(name + '-view-root').textContent;
      // Permanently on screen now, so a stuck "loading" would read as a hang.
      expect(text).not.toContain('加载');
      expect(text).toContain('不可用');
    });
    expect(noUsage.document.getElementById('pp-badge-claude').hidden).toBe(true);
    expect(noUsage.document.getElementById('pp-badge-codex').hidden).toBe(true);
    noUsage.PerfPanel.stop();
  });

  it('renders Darwin capabilities without fake process IO or NaN widths', async () => {
    const mac = bootDom({
      windowStats: {
        capabilities: { processIo: false, diskIoPerDevice: false, systemCpu: true, systemMemory: true },
        total: {
          cpuCount: 14, systemCpuPercent: 23, windowCpuPercent: 140,
          systemMemTotal: 24 * 1024 ** 3, systemMemUsed: 10 * 1024 ** 3,
          systemMemCached: 2 * 1024 ** 3,
          systemMemoryMetric: 'activity-monitor', systemDiskIoBps: 1024 ** 2,
          windowIoBps: 0, hostname: 'mac.test', load1: 2, uptime: 3600,
        },
        windows: [{
          session: 'main', windowIndex: 1, windowName: 'zsh', cpuPercent: 50,
          memBytes: 512 * 1024 ** 2, swapBytes: 0, ioBps: 0, procCount: 3,
        }],
        external: [],
        disks: [{ mount: '/', percent: 44, readBps: null, writeBps: null }],
      },
    }).window;
    mac.document.getElementById('root').innerHTML = mac.PerfPanel.renderSkeleton();
    mac.PerfPanel.start();
    await flush();

    const text = mac.document.getElementById('perf-view-root').textContent;
    const html = mac.document.getElementById('perf-view-root').innerHTML;
    expect(text).toContain('23%');
    expect(text).toContain('缓存 2.0 GB');
    expect(text).not.toContain('内存压力口径');
    expect(text).toContain('进程 IO 不可用');
    expect(text).toContain('I/O —（仅提供整机吞吐）');
    expect(html).not.toContain('NaN%');
    mac.PerfPanel.stop();
  });

  it('keeps painting after a remount, which the old tab tracking broke', async () => {
    const remounted = bootDom({
      windowStats: {
        capabilities: { systemCpu: true, systemMemory: true },
        total: {
          cpuCount: 8, systemCpuPercent: 41, windowCpuPercent: 0,
          systemMemTotal: 16 * 1024 ** 3, systemMemUsed: 4 * 1024 ** 3, systemMemCached: 0,
          hostname: 'host.test', load1: 1, uptime: 60,
        },
        windows: [], external: [], disks: [],
      },
    }).window;

    // MsApp renders and starts the panel twice per navigation. The singleton used
    // to keep a stale activeTab across that, leaving the visible panel unpainted.
    for (let i = 0; i < 2; i += 1) {
      remounted.document.getElementById('root').innerHTML = remounted.PerfPanel.renderSkeleton();
      remounted.PerfPanel.start();
      await flush();
    }

    expect(remounted.document.getElementById('perf-view-root').textContent).toContain('41%');
    remounted.PerfPanel.stop();
  });
});
