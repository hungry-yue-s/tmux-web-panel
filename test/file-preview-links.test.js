import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';

// Load the DOM-free cores into a sandbox. file-preview.js references LinkDetect
// as a bare global and exposes a _test seam for the buffer-level logic.
let FP;
beforeAll(() => {
  const w = {};
  new Function('window', fs.readFileSync('public/js/link-detect.js', 'utf8'))(w);
  globalThis.LinkDetect = w.LinkDetect;
  new Function('window', fs.readFileSync('public/js/file-preview.js', 'utf8'))(w);
  FP = w.FilePreview._test;
});

// Minimal xterm-buffer mock: fixed width, ASCII cells (width 1).
function mkBuffer(rows, cols) {
  const lines = rows.map((r) => ({
    isWrapped: !!r.wrapped,
    length: cols,
    translateToString(trim) {
      const padded = (r.text + ' '.repeat(cols)).slice(0, cols);
      return trim ? padded.replace(/\s+$/, '') : padded;
    },
    getCell(col) {
      const ch = col < r.text.length ? r.text[col] : ' ';
      return { getWidth: () => 1, getChars: () => ch };
    },
  }));
  return { length: lines.length, getLine: (i) => lines[i] || null };
}

describe('F1 — wrapped-row end offset stays on the correct row', () => {
  it('a link ending exactly at the row boundary does not bleed onto the next row', () => {
    const cols = 8;
    const buf = mkBuffer([
      { text: 'x/aa/bbb' },               // full row, link fills it
      { text: ' next', wrapped: true },   // soft-wrap continuation (leading space)
    ], cols);
    const logical = FP.getLogicalLine(buf, 0);
    const links = FP.findLinks(logical.text);
    const path = links.find((m) => m.text === 'x/aa/bbb');
    expect(path, 'path should be detected').toBeTruthy();
    const range = FP.buildLinkRange(logical, path);
    expect(range.start).toEqual({ y: 1, x: 1 });
    expect(range.end.y).toBe(1);   // NOT row 2
    expect(range.end.x).toBe(8);
  });
});

describe('F3 — hard-newline continuation resolves to the joined line', () => {
  const cols = 28;
  const buf = () => mkBuffer([
    { text: 'https://example.com/a/b/c/d/' },  // full, ends with an open token
    { text: 'h/i.html' },                       // hard newline (not wrapped)
  ], cols);

  it('forward: row 0 merges the hard-split URL', () => {
    const l = FP.getLogicalLine(buf(), 0);
    expect(l.startRow).toBe(0);
    expect(FP.findLinks(l.text).some((m) => m.kind === 'web' && m.text.includes('h/i.html'))).toBe(true);
  });

  it('continuation row 1 resolves back to row 0 (no wrong standalone fragment)', () => {
    const l = FP.getLogicalLine(buf(), 1);
    expect(l.startRow).toBe(0);
    const links = FP.findLinks(l.text);
    expect(links.some((m) => m.kind === 'web')).toBe(true);
    expect(links.some((m) => m.kind === 'file' && m.text === 'h/i.html')).toBe(false);
  });

  it('does NOT join when the next row is indented', () => {
    const b = mkBuffer([
      { text: 'https://example.com/a/b/c/d/' },
      { text: '    indented' },
    ], cols);
    expect(FP.getLogicalLine(b, 0).rows.length).toBe(1);
  });
});

describe('F4 — hanging-indent hard wrap stays one file link', () => {
  const first = '  Documents/Obsidian_document/DataAnt/三绿/DataAnt-Android14-';
  const second = '  property_service-Wuying属性重写问题说明.md';
  const fullPath = first.slice(2) + second.slice(2);
  // Codex-like TUI wraps to a content width narrower than the xterm row, so
  // the first physical row still has visible blank cells on the right.
  const cols = first.length + 12;
  const buf = () => mkBuffer([
    { text: first },
    { text: second },
  ], cols);

  it('joins a continuation aligned with the path start column', () => {
    const logical = FP.getLogicalLine(buf(), 1);
    expect(logical.startRow).toBe(0);
    expect(logical.text.trimEnd()).toBe('  ' + fullPath);
    const links = FP.findLinks(logical.text);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe(fullPath);
  });

  it('maps the joined continuation back to its indented terminal columns', () => {
    const logical = FP.getLogicalLine(buf(), 0);
    const link = FP.findLinks(logical.text)[0];
    const range = FP.buildLinkRange(logical, link);
    expect(range.start).toEqual({ y: 1, x: 3 });
    expect(range.end).toEqual({ y: 2, x: second.length });
  });

  it('does not clamp a short continuation to the first row start column', () => {
    const shortFirst = '      abc/defghijklmnopqrstuv-';
    const shortSecond = '      x';
    const shortBuf = mkBuffer([
      { text: shortFirst },
      { text: shortSecond },
    ], shortFirst.length);
    const logical = FP.getLogicalLine(shortBuf, 0);
    const link = FP.findLinks(logical.text)[0];
    const range = FP.buildLinkRange(logical, link);
    expect(range.end).toEqual({ y: 2, x: shortSecond.length });
  });

  it('does not join when the continuation indentation differs', () => {
    const mismatch = mkBuffer([
      { text: first },
      { text: '    property_service-Wuying属性重写问题说明.md' },
    ], cols);
    expect(FP.getLogicalLine(mismatch, 0).rows).toHaveLength(1);
  });
});

describe('pane context resolution', () => {
  it('uses the live active pane supplied by split mode', async () => {
    const used = await FP.resolvePaneForAction('%1', () => Promise.resolve('%2'), (paneId) => paneId);
    expect(used).toBe('%2');
  });

  it('falls back to the attached pane when live lookup fails', async () => {
    const used = await FP.resolvePaneForAction('%1', () => Promise.reject(new Error('offline')), (paneId) => paneId);
    expect(used).toBe('%1');
  });

  it('does not retry the action when the action itself fails', async () => {
    var calls = 0;
    await expect(FP.resolvePaneForAction('%1', () => '%2', () => {
      calls++;
      throw new Error('open failed');
    })).rejects.toThrow('open failed');
    expect(calls).toBe(1);
  });
});
