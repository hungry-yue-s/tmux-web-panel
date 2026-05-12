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
  // Stub fetch so accidental calls don't fail the test
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

  it('renderSkeleton returns HTML containing the two view containers', () => {
    const html = w.PerfPanel.renderSkeleton();
    expect(html).toContain('id="perf-panel"');
    expect(html).toContain('id="perf-view-root"');
    expect(html).toContain('id="claude-view-root"');
    expect(html).toContain('data-view="perf"');
    expect(html).toContain('data-view="claude"');
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
});
