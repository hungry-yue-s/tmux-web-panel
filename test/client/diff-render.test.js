import { describe, it, expect, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const BLOCKS = fs.readFileSync('plugins/files/client/js/blocks.js', 'utf8');

let dom;
afterEach(() => dom?.window.close());

function setup() {
  dom = new JSDOM('<!doctype html><body><div id="box"></div></body>', { url: 'https://panel.test/', runScripts: 'outside-only' });
  dom.window.eval(BLOCKS);
  return { win: dom.window, ui: dom.window.Blocks.ui, box: dom.window.document.getElementById('box') };
}

/** A file's diff with hunks of the given sizes, every line changed, alternating - and +. */
function fileDiff(name, sizes) {
  let out = `diff --git a/${name} b/${name}\nindex 1..2 100644\n--- a/${name}\n+++ b/${name}\n`;
  let at = 1;
  sizes.forEach((size) => {
    out += `@@ -${at},${size / 2} +${at},${size / 2} @@\n`;
    for (let i = 0; i < size / 2; i += 1) out += `-old ${name} ${at + i}\n+new ${name} ${at + i}\n`;
    at += 1000;
  });
  return out;
}
const BINARY = 'diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n';
const lines = (box) => box.querySelectorAll('.blk-line').length;
const more = (box) => box.querySelector('.blk-diff-more');

describe('drawing a large diff a part at a time', () => {
  it('draws only so many lines, and the rest when asked, from where it stopped', () => {
    const { ui, box } = setup();
    ui.renderDiffInto(box, fileDiff('a.js', [1200, 600]) + BINARY + fileDiff('b.js', [700]), { maxLines: 1000 });

    expect(lines(box)).toBe(1000);
    expect(more(box).textContent).toBe('显示剩余 1500 行');
    more(box).click();
    expect(lines(box)).toBe(2000);
    more(box).click();
    expect(lines(box)).toBe(2500);
    expect(more(box)).toBeNull();

    // Every file has its box, in order, the binary one included.
    expect([...box.querySelectorAll('.blk-diff-filename')].map((n) => n.textContent)).toEqual(['a.js', 'logo.png', 'b.js']);
    expect(box.querySelectorAll('.blk-hunk')).toHaveLength(3);
  });

  it('goes on numbering a hunk across the parts', () => {
    const { ui, box } = setup();
    ui.renderDiffInto(box, fileDiff('a.js', [1200]), { maxLines: 1000 });
    more(box).click();
    const rows = [...box.querySelectorAll('.blk-hunk .blk-line')];
    expect(rows).toHaveLength(1200);
    // Line 999 is the 500th addition, line 1000 the 501st deletion: old 501, new 500 before it.
    const numbers = (row) => [...row.querySelectorAll('.blk-ln')].map((n) => n.textContent);
    expect(numbers(rows[999])).toEqual(['', '500']);
    expect(numbers(rows[1000])).toEqual(['501', '']);
    expect(box.querySelectorAll('.blk-hunk')).toHaveLength(1);
  });

  it('lets lines drawn later be picked for staging, in their own hunk', () => {
    const { win, ui, box } = setup();
    const picked = [];
    ui.renderDiffInto(box, fileDiff('a.js', [1200]), {
      maxLines: 1000,
      actions: (file, hunk, selection) => {
        const b = win.document.createElement('button');
        b.className = 'pick';
        b.addEventListener('click', () => picked.push(selection()));
        return [b];
      },
    });
    more(box).click();
    box.querySelectorAll('.blk-line')[1100].click();
    box.querySelector('.pick').click();
    expect(picked).toEqual([{ 1100: true }]);
    expect(box.querySelector('.blk-hunk').classList.contains('has-selection')).toBe(true);
  });

  it('draws a small diff whole, with no button', () => {
    const { ui, box } = setup();
    ui.renderDiffInto(box, fileDiff('a.js', [10]));
    expect(lines(box)).toBe(10);
    expect(more(box)).toBeNull();
  });
});
