import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync('plugins/ui/client/js/legacy-storage.js', 'utf8');
const pageScripts = JSON.parse(readFileSync('plugins/ui/client/page.json', 'utf8')).body;

let dom;
afterEach(() => { dom?.window.close(); dom = null; });

describe('settings saved under the old twp_ prefix', () => {
  it('move to anymux_ once, without replacing a value already saved under the new name', () => {
    dom = new JSDOM('<!doctype html><body></body>', { url: 'https://panel.test/', runScripts: 'outside-only' });
    const storage = dom.window.localStorage;
    storage.setItem('twp_blocks_v1:local', '{"git":1}');
    storage.setItem('twp_block_side_width', '480');
    storage.setItem('anymux_block_side_width', '520');
    storage.setItem('tmux_theme', 'dark');
    dom.window.eval(source);
    expect(storage.getItem('anymux_blocks_v1:local')).toBe('{"git":1}');
    expect(storage.getItem('anymux_block_side_width')).toBe('520');
    expect(storage.getItem('tmux_theme')).toBe('dark');
    expect(Object.keys(dom.window.localStorage).filter((key) => key.startsWith('twp_'))).toEqual([]);
    dom.window.eval(source);
    expect(storage.getItem('anymux_blocks_v1:local')).toBe('{"git":1}');
  });

  it('runs before any script that reads them', () => {
    const order = (src) => pageScripts.find((entry) => entry.script === src).order;
    const readers = pageScripts.filter((entry) => entry.script && entry.script !== '/js/legacy-storage.js' && entry.script !== '/js/slots.js');
    for (const entry of readers) expect(entry.order).toBeGreaterThan(order('/js/legacy-storage.js'));
  });
});
