import { describe, expect, it } from 'vitest';
import { indexSource as composedIndex } from '../helpers/pages.js';

const scripts = [...composedIndex().matchAll(/<script[^>]*\bsrc="([^"?]+)/g)].map((m) => m[1]);
const at = (src) => scripts.indexOf(src);

describe('PanelSlots on the composed page', () => {
  it('loads the slots before any script that registers into them', () => {
    const first = scripts.findIndex((src) => src.startsWith('/js/'));
    expect(scripts[first]).toBe('/js/slots.js');
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
