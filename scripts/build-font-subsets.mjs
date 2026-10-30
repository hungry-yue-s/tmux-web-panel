#!/usr/bin/env node
// Slices the bundled terminal font (Maple Mono NF CN derivative, ~6 MB per
// weight) into unicode-range subsets so a slow link only downloads what the
// screen shows:
//
//   core     Latin, Greek, Cyrillic, punctuation, arrows, box drawing, braille…
//            Declared in CSS and preloaded: it is all the terminal waits for.
//   cjk      CJK punctuation, kana, Hangul, full-width forms.
//   han-a*   GB2312 level-1 hanzi (the 3755 common characters), in small slices.
//   han-b*   Every other hanzi, by code point interval.
//   pua-*    Nerd Font icons in the private use areas, by interval.
//
// Everything but `core` is registered from JS (public/js/terminal-fonts.js),
// which loads a slice when a character from it reaches the screen. Slice
// files carry a content hash in their name, so they are cached forever.
//
// usage: node scripts/build-font-subsets.mjs
// Re-run only when public/fonts/TmuxPanelMono-*.woff2 change; outputs are committed.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fontkit from 'fontkit';
import subsetFont from 'subset-font';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONT_DIR = join(root, 'public', 'fonts');
const OUT_DIR = join(FONT_DIR, 'tpm');
const FAMILY = 'Tmux Panel Mono';
const SOURCES = [
  { weight: 400, file: 'TmuxPanelMono-Regular.woff2' },
  { weight: 700, file: 'TmuxPanelMono-Bold.woff2' },
];
const HAN_A_SLICE = 470;
const HAN_B_SLICE = 1400;
const PUA_SLICE = 1300;

const isHan = (cp) => (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x4E00 && cp <= 0x9FFF)
  || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0x20000 && cp <= 0x3FFFF);
const isCjk = (cp) => (cp >= 0x2E80 && cp <= 0x33FF) || (cp >= 0x1100 && cp <= 0x11FF)
  || (cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFFEF);
// Powerline separators (U+E0A0–E0D7) draw most shell prompts: they stay in core.
const isPowerline = (cp) => cp >= 0xE0A0 && cp <= 0xE0D7;
const isPua = (cp) => ((cp >= 0xE000 && cp <= 0xF8FF) || cp >= 0xF0000) && !isPowerline(cp);

/** GB2312 hanzi in GB order: level 1 (common, by pinyin) or level 2 (by radical). */
function gb2312(level) {
  const decoder = new TextDecoder('gb18030');
  const [from, to] = level === 1 ? [0xB0, 0xD7] : [0xD8, 0xF7];
  const out = [];
  for (let hi = from; hi <= to; hi++) {
    for (let lo = 0xA1; lo <= 0xFE; lo++) {
      const ch = decoder.decode(new Uint8Array([hi, lo]));
      const cp = ch.codePointAt(0);
      if (ch.length === 1 && isHan(cp)) out.push(cp);
    }
  }
  return out;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Sorted code points → [[start, end], …] runs. */
function runs(cps) {
  const sorted = [...cps].sort((a, b) => a - b);
  const out = [];
  for (const cp of sorted) {
    const last = out[out.length - 1];
    if (last && cp === last[1] + 1) last[1] = cp;
    else out.push([cp, cp]);
  }
  return out;
}

const hex = (cp) => cp.toString(16).toUpperCase();
const unicodeRange = (rs) => rs.map(([a, b]) => (a === b ? 'U+' + hex(a) : 'U+' + hex(a) + '-' + hex(b))).join(', ');

const regular = fontkit.openSync(join(FONT_DIR, SOURCES[0].file));
const covered = new Set(regular.characterSet);

const core = [], cjk = [], han = [], pua = [];
for (const cp of covered) {
  if (isHan(cp)) han.push(cp);
  else if (isPua(cp)) pua.push(cp);
  else if (isCjk(cp)) cjk.push(cp);
  else core.push(cp);
}
const level1 = gb2312(1).filter((cp) => covered.has(cp));
const level1Set = new Set(level1);
const otherHan = han.filter((cp) => !level1Set.has(cp)).sort((a, b) => a - b);

// Declaration order matters: for a character in several ranges the browser
// (and terminal-fonts.js) uses the face declared LAST. Interval slices come
// first so the common-character slices win for their characters.
const slices = [];
chunk(otherHan, HAN_B_SLICE).forEach((cps, i) => slices.push({
  id: 'han-b' + String(i + 1).padStart(2, '0'), cps, range: [[cps[0], cps[cps.length - 1]]],
}));
chunk(pua.sort((a, b) => a - b), PUA_SLICE).forEach((cps, i) => slices.push({
  id: 'pua-' + String(i + 1).padStart(2, '0'), cps, range: [[cps[0], cps[cps.length - 1]]],
}));
slices.push({ id: 'cjk', cps: cjk, range: runs(cjk) });
chunk(level1, HAN_A_SLICE).forEach((cps, i) => slices.push({
  id: 'han-a' + String(i + 1).padStart(2, '0'), cps, chars: true,
}));

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

async function write(source, id, cps) {
  const buffer = readFileSync(join(FONT_DIR, source.file));
  const text = String.fromCodePoint(...cps);
  const subset = await subsetFont(buffer, text, { targetFormat: 'woff2' });
  const hash = createHash('sha256').update(subset).digest('hex').slice(0, 10);
  const name = `tpm-${source.weight}-${id}.${hash}.woff2`;
  writeFileSync(join(OUT_DIR, name), subset);
  return { name, bytes: subset.length };
}

const coreFiles = {};
let total = 0;
for (const source of SOURCES) {
  const out = await write(source, 'core', core);
  coreFiles[source.weight] = out.name;
  total += out.bytes;
  console.log(`core ${source.weight}: ${(out.bytes / 1024).toFixed(1)} KB`);
}
const manifest = [];
for (const slice of slices) {
  const files = {};
  for (const source of SOURCES) {
    const out = await write(source, slice.id, slice.cps);
    files[source.weight] = out.name;
    total += out.bytes;
    if (source.weight === 400) console.log(`${slice.id}: ${slice.cps.length} glyphs, ${(out.bytes / 1024).toFixed(1)} KB`);
  }
  const entry = { id: slice.id, files };
  if (slice.chars) entry.chars = String.fromCodePoint(...slice.cps);
  else entry.ranges = (slice.range).map(([a, b]) => [a, b]);
  manifest.push(entry);
}

// Core faces: plain CSS so the first paint can use them, plus the preload tags.
const coreRange = unicodeRange(runs(core));
const css = `/* Generated by scripts/build-font-subsets.mjs — do not edit. */
/* Core slice of the bundled terminal font; CJK and icon slices are
   registered on demand by /js/terminal-fonts.js. */
${SOURCES.map((s) => `@font-face {
  font-family: '${FAMILY}';
  src: url('/fonts/tpm/${coreFiles[s.weight]}') format('woff2');
  font-weight: ${s.weight};
  font-style: normal;
  font-display: swap;
  unicode-range: ${coreRange};
}`).join('\n')}
`;
writeFileSync(join(root, 'public', 'css', 'terminal-fonts.css'), css);

const data = `/* Generated by scripts/build-font-subsets.mjs — do not edit. */
window.TERMINAL_FONT_SLICES = ${JSON.stringify({ family: FAMILY, base: '/fonts/tpm/', core: coreFiles, slices: manifest })};
`;
writeFileSync(join(root, 'public', 'js', 'terminal-fonts-data.js'), data);

// Keep the preload tags in the HTML pages pointing at the current core files.
for (const page of ['index.html', 'terminal.html']) {
  const path = join(root, 'public', page);
  const html = readFileSync(path, 'utf8');
  const tags = SOURCES.map((s) => `  <link rel="preload" href="/fonts/tpm/${coreFiles[s.weight]}" as="font" type="font/woff2" crossorigin>`).join('\n');
  const next = html.replace(/<!-- terminal-font-preload -->[\s\S]*?<!-- \/terminal-font-preload -->/,
    `<!-- terminal-font-preload -->\n${tags}\n  <!-- /terminal-font-preload -->`);
  if (next !== html) writeFileSync(path, next);
}

console.log(`${slices.length + 1} slices per weight, ${(total / 1024 / 1024).toFixed(2)} MB in all, files in ${OUT_DIR}`);
console.log(readdirSync(OUT_DIR).length, 'files');
