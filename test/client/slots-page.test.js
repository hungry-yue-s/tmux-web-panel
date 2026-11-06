import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { indexSource as composedIndex } from '../helpers/pages.js';

/** The slots, a stubbed block kit, and the scripts that register commands: all, or without some. */
function commandsWith(without = []) {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const win = dom.window;
  win.eval(readFileSync('plugins/ui/client/js/slots.js', 'utf8'));
  const noop = () => win.document.createElement('div');
  win.Blocks = { ui: { el: noop, button: noop, iconButton: noop, toast: vi.fn(), errorText: String }, icon: noop };
  win.BlockHost = { register: vi.fn(), render: vi.fn(), open: vi.fn() };
  win.setInterval = () => 0;
  win.setTimeout = () => 0;
  for (const path of [
    'plugins/git/client/js/git-block.js',
    'plugins/browser/client/js/browser-block.js',
    'plugins/files/client/js/files-commands.js',
    'plugins/metrics/client/js/perf-section.js',
    'plugins/ui/client/js/workspace-commands.js',
  ]) if (!without.some((plugin) => path.startsWith(`plugins/${plugin}/`))) win.eval(readFileSync(path, 'utf8'));
  const ids = win.PanelSlots.commands.list().map((command) => command.id);
  dom.window.close();
  return ids;
}

const scripts = [...composedIndex().matchAll(/<script[^>]*\bsrc="([^"?]+)/g)].map((m) => m[1]);
const at = (src) => scripts.indexOf(src);

describe('PanelSlots on the composed page', () => {
  it('loads the slots before any script that registers into them', () => {
    const first = scripts.findIndex((src) => src.startsWith('/js/'));
    expect(scripts[first]).toBe('/js/slots.js');
  });

  it('lists every plugin command in the palette order the workspace always had', () => {
    expect(commandsWith()).toEqual([
      'shell', 'git', 'files', 'quick-open', 'board', 'browser', 'tasks',
      'hosts', 'theme', 'shortcuts', 'close-block', 'float-block', 'max-block',
    ]);
  });

  it('loses exactly the commands of a plugin that is off', () => {
    expect(commandsWith(['git', 'browser', 'metrics'])).toEqual([
      'shell', 'files', 'quick-open', 'board', 'hosts', 'theme', 'shortcuts', 'close-block', 'float-block', 'max-block',
    ]);
  });

  it('registers each plugin section after the component it puts on the page', () => {
    for (const [component, section] of [
      ['/js/perf-panel.js', '/js/perf-section.js'],
      ['/js/agent-hub.js', '/js/agent-section.js'],
      ['/js/session-protection.js', '/js/session-section.js'],
      ['/js/management.js', '/js/management-section.js'],
    ]) {
      expect(at(component)).toBeGreaterThan(-1);
      expect(at(section)).toBeGreaterThan(at(component));
    }
  });
});
