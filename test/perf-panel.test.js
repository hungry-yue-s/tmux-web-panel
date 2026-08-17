import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const utils = fs.readFileSync('public/js/perf-utils.js', 'utf8');
const panel = fs.readFileSync('public/js/perf-panel.js', 'utf8');

function bootDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    runScripts: 'outside-only',
  });
  // Stub the global `api` ApiClient that perf-panel.js polls through (defined in app.js
  // in real usage). All four ticks resolve immediately to a healthy empty response.
  dom.window.api = {
    get: async () => ({ success: true, data: { points: [] } }),
  };
  // Defensive: also stub fetch in case any code path falls back to it
  dom.window.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: {} }) });
  dom.window.eval(utils);
  dom.window.eval(panel);
  return dom;
}

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
    expect(html).toContain('data-view="perf"');
    expect(html).toContain('data-view="claude"');
    expect(html).toContain('data-view="codex"');
  });

  it('tab click switches active view', () => {
    w.document.getElementById('root').innerHTML = w.PerfPanel.renderSkeleton();
    w.PerfPanel.start();
    const claudeBtn = w.document.querySelector('[data-view="claude"]');
    claudeBtn.click();
    expect(w.document.getElementById('view-perf').classList.contains('pp-active')).toBe(false);
    expect(w.document.getElementById('view-claude').classList.contains('pp-active')).toBe(true);
    w.PerfPanel.stop();
  });

  it('tab click switches to codex view', () => {
    w.document.getElementById('root').innerHTML = w.PerfPanel.renderSkeleton();
    w.PerfPanel.start();
    const codexBtn = w.document.querySelector('[data-view="codex"]');
    codexBtn.click();
    expect(w.document.getElementById('view-perf').classList.contains('pp-active')).toBe(false);
    expect(w.document.getElementById('view-codex').classList.contains('pp-active')).toBe(true);
    w.PerfPanel.stop();
  });

  it('renders Darwin capabilities without fake process IO or NaN widths', () => {
    w.document.getElementById('root').innerHTML = w.PerfPanel.renderSkeleton();
    w.PerfPanel._state.snapshot = {
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
    };
    w.PerfPanel._state.history = { points: [] };
    w.PerfPanel.start();
    w.document.querySelector('[data-view="perf"]').click();

    const text = w.document.getElementById('perf-view-root').textContent;
    const html = w.document.getElementById('perf-view-root').innerHTML;
    expect(text).toContain('23%');
    expect(text).toContain('缓存 2.0 GB');
    expect(text).not.toContain('内存压力口径');
    expect(text).toContain('进程 IO 不可用');
    expect(text).toContain('I/O —（仅提供整机吞吐）');
    expect(html).not.toContain('NaN%');
    w.PerfPanel.stop();
  });
});
