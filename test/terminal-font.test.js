import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('terminal font configuration', () => {
  it('uses the CJK Nerd Font in both terminal entry points', () => {
    const sources = [
      readFileSync(resolve(import.meta.dirname, '../public/js/terminal.js'), 'utf8'),
      readFileSync(resolve(import.meta.dirname, '../public/terminal.html'), 'utf8'),
    ];

    for (const source of sources) {
      expect(source).toContain("fontFamily: \"'Maple Mono NF CN'");
    }
  });
});
