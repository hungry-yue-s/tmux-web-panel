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
  win.Blocks = {
    ui: { el: noop, button: noop, iconButton: noop, toast: vi.fn(), errorText: String },
    icon: noop,
    registerPreviewActions: vi.fn(),
  };
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

  it('knows which plugins run here from the page, and on another server from its health', () => {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'http://localhost/', runScripts: 'outside-only' });
    const win = dom.window;
    win.eval(readFileSync('plugins/ui/client/js/slots.js', 'utf8'));
    // Nothing known yet: assume the plugin is there, as before the lists existed.
    expect(win.PanelSlots.hasPlugin('metrics')).toBe(true);
    win.PANEL_PLUGINS = ['ui', 'files'];
    expect(win.PanelSlots.hasPlugin('files')).toBe(true);
    expect(win.PanelSlots.hasPlugin('metrics', 'local')).toBe(false);
    const health = { box: { node: { installed: true, plugins: ['metrics'] } }, old: { node: { installed: true, plugins: null } } };
    win.AppShell = { health: (id) => health[id] || null };
    expect(win.PanelSlots.hasPlugin('metrics', 'box')).toBe(true);
    expect(win.PanelSlots.hasPlugin('files', 'box')).toBe(false);
    expect(win.PanelSlots.hasPlugin('files', 'old')).toBe(true);
    expect(win.PanelSlots.hasPlugin('files', 'unknown')).toBe(true);
    dom.window.close();
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

  it('renders notebooks and SQLite, and offers Git in the preview, only with their plugins', () => {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'http://localhost/', runScripts: 'outside-only' });
    const win = dom.window;
    win.eval(readFileSync('plugins/ui/client/js/blocks-kit.js', 'utf8'));
    win.eval(readFileSync('plugins/files/client/js/file-blocks.js', 'utf8'));
    const markdown = { isDirectory: false, isText: true, isMarkdown: true, rawContent: '# x', absPath: '/r/notes.md' };
    expect(win.Blocks.rendererFor('/r/a.ipynb', true)).toBeNull();
    expect(typeof win.Blocks.rendererFor('/r/fix.patch', true)).toBe('function');
    expect(win.Blocks.renderSqlite).toBeUndefined();
    expect(win.Blocks.previewActions(markdown, {}).map((item) => item.label)).toEqual(['编辑', '看板视图']);

    win.eval(readFileSync('plugins/notebook/client/js/notebook-block.js', 'utf8'));
    win.eval(readFileSync('plugins/sqlite/client/js/sqlite-block.js', 'utf8'));
    expect(typeof win.Blocks.rendererFor('/r/a.ipynb', true)).toBe('function');
    expect(typeof win.Blocks.renderSqlite).toBe('function');
    dom.window.close();
  });

  it('loads the block kit before every script that registers with it', () => {
    const kit = at('/js/blocks-kit.js');
    expect(kit).toBeGreaterThan(-1);
    for (const src of ['/js/block-host.js', '/js/file-blocks.js', '/js/notebook-block.js', '/js/sqlite-block.js',
      '/js/git-block.js', '/js/browser-block.js', '/js/files-commands.js', '/js/workspace-commands.js']) {
      expect(at(src)).toBeGreaterThan(kit);
    }
  });

  it('registers each plugin section after the component it puts on the page', () => {
    for (const [component, section] of [
      ['/js/perf-panel.js', '/js/perf-section.js'],
      ['/js/agent-hub.js', '/js/agent-section.js'],
      ['/js/session-protection.js', '/js/session-section.js'],
    ]) {
      expect(at(component)).toBeGreaterThan(-1);
      expect(at(section)).toBeGreaterThan(at(component));
    }
    for (const src of ['/js/management-page.js', '/js/managed-resources.js', '/js/panel-plugins.js']) {
      expect(at(src)).toBeGreaterThan(at('/js/slots.js'));
    }
  });

  it('shows the management centre only while some plugin puts a panel in it', () => {
    const dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>', { url: 'http://localhost/', runScripts: 'outside-only' });
    const win = dom.window;
    win.eval(readFileSync('plugins/ui/client/js/slots.js', 'utf8'));
    win.eval(readFileSync('plugins/ui/client/js/management-page.js', 'utf8'));
    const management = win.PanelSlots.settingsSections.get('management');
    expect(management.available()).toBe(false);

    win.AppShell = { escape: String, toast: vi.fn() };
    win.Api = { get: vi.fn(async () => ({ plugins: [{ id: 'tmux-agent', name: 'Tmux Agent', version: '1', description: '', installed: false }] })) };
    win.eval(readFileSync('plugins/panel-plugins/client/js/panel-plugins.js', 'utf8'));
    expect(management.available()).toBe(true);
    return win.ManagementPage.mount(win.document.getElementById('root')).then(() => {
      // Only the panel-plugins panel: no tmux runtime or skills without managed-resources.
      expect(win.document.querySelectorAll('[data-management-panel]')).toHaveLength(1);
      expect(win.document.querySelector('[data-managed="plugin-install"]')).not.toBeNull();
      expect(win.Api.get).toHaveBeenCalledWith('/api/plugins');
      expect(win.Api.get).not.toHaveBeenCalledWith('/api/managed-resources');
      dom.window.close();
    });
  });
});
