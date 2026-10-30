import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { layoutPanes, controlEvents } from '../bin/twp.mjs';

let B;
beforeAll(() => {
  const w = {};
  new Function('window', 'Api', fs.readFileSync('public/js/blocks.js', 'utf8') + '\nwindow.Blocks = Blocks;')(w, {});
  B = w.Blocks._test;
});

const DIFF = [
  'diff --git a/a.txt b/a.txt',
  'index 1..2 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,4 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '+four',
  '',
].join('\n');

describe('line staging patches', () => {
  it('parses files and hunks', () => {
    const files = B.parseUnifiedDiff(DIFF);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('a.txt');
    expect(files[0].hunks[0].lines).toEqual([' one', '-two', '+TWO', ' three', '+four']);
  });

  it('keeps unselected deletions as context when staging', () => {
    const [file] = B.parseUnifiedDiff(DIFF);
    const patch = B.buildPatch(file, file.hunks[0], { 4: true }, false);
    expect(patch.split('\n').slice(5)).toEqual([' one', ' two', ' three', '+four', '']);
  });

  it('keeps unselected additions as context when unstaging', () => {
    const [file] = B.parseUnifiedDiff(DIFF);
    const patch = B.buildPatch(file, file.hunks[0], { 1: true }, true);
    expect(patch.split('\n').slice(5)).toEqual([' one', '-two', ' TWO', ' three', ' four', '']);
  });

  it('returns null when nothing is selected', () => {
    const [file] = B.parseUnifiedDiff(DIFF);
    expect(B.buildPatch(file, file.hunks[0], { 0: true }, false)).toBeNull();
  });
});

describe('blocks on native glass', () => {
  const css = fs.readFileSync('public/css/blocks.css', 'utf8');
  const glass = css.slice(css.indexOf('/* --- native glass'));

  it('lets the window material show through and tints each depth separately', () => {
    expect(glass).toMatch(/html\[data-native-transparency\] :is\(\.blk-dock, \.blk-frame, \.git-side, \.git-log\) \{ background: transparent; \}/);
    for (const depth of ['--g-well', '--g-bar', '--g-raised', '--g-float']) {
      expect(glass).toContain(depth + ':');
    }
    expect(glass).toContain('[data-color-scheme="light"]');
    expect(fs.readFileSync('public/js/theme.js', 'utf8')).toContain("root.setAttribute('data-color-scheme', t.colorScheme)");
  });

  it('blurs only surfaces with content moving behind them, never a scrolling pane', () => {
    const blurred = [...glass.matchAll(/([^{}]+)\{[^{}]*backdrop-filter[^{}]*\}/g)].map((m) => m[1].trim());
    expect(blurred.join(' ')).not.toMatch(/\.git-(list|log|main|diff-scroll|side)\b/);
    expect(blurred.join(' ')).toContain('.blk-mode-float');
    expect(blurred.join(' ')).toContain('.blk-menu');
  });
});

describe('TODO.md board', () => {
  it('round-trips sections, notes and indented card details', () => {
    const text = '# Plan\n\nintro\n\n## Todo\n\nsome note\n\n- [ ] a\n  - detail\n- [ ] b\n\n## Done\n\n- [x] c\n';
    const board = B.parseBoard(text);
    expect(board.columns.map((c) => [c.title, c.cards.length])).toEqual([['Todo', 2], ['Done', 1]]);
    expect(B.serializeBoard(board)).toBe(text);
  });

  it('splits a heading-less checklist into todo and done', () => {
    const board = B.parseBoard('Tasks\n\n- [ ] a\n- [x] b\n');
    expect(board.statusMode).toBe(true);
    expect(board.columns.map((c) => c.cards.length)).toEqual([1, 1]);
    board.columns[1].cards.push(board.columns[0].cards.pop());
    expect(B.serializeBoard(board)).toBe('Tasks\n\n- [x] b\n- [ ] a\n');
  });
});

describe('twp events', () => {
  it('reads pane ids from layout leaves', () => {
    expect([...layoutPanes('b25f,80x24,0,0{40x24,0,0,1,39x24,41,0[39x12,41,0,2,39x11,41,13,5]}')]).toEqual(['%1', '%2', '%5']);
  });

  it('derives pane_spawned and pane_closed from layout changes', () => {
    const panes = new Map([['@1', new Set(['%1'])]]);
    const spawned = controlEvents('%layout-change @1 b25f,80x24,0,0{40x24,0,0,1,39x24,41,0,7} b25f,80x24,0,0 *', panes);
    expect(spawned.map((e) => e.event)).toEqual(['pane_spawned', 'layout_changed']);
    expect(spawned[0].paneId).toBe('%7');
    const closed = controlEvents('%layout-change @1 a,80x24,0,0,7 a *', panes);
    expect(closed.map((e) => [e.event, e.paneId])).toEqual([['pane_closed', '%1'], ['layout_changed', undefined]]);
    expect(controlEvents('%output %1 hi', panes)).toEqual([]);
  });
});
