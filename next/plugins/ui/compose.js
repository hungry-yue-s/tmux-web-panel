// Composing the main page from what plugins contribute.
//
// A plugin's client directory holds a `page.json`:
//
//   {
//     "serve": ["."],                       directories served at "/", relative to page.json
//     "head": [{ "order": 10, "style": "/css/x.css?v=1" },
//              { "order": 20, "preload": "/fonts/x.woff2" },
//              { "order": 30, "script": "/vendor/x.js" }],
//     "body": [{ "order": 10, "script": "/js/x.js?v=2" },
//              { "order": 20, "module": "/js/y.js?v=1" }]
//   }
//
// The template (the ui plugin's index.html) marks where they go with
// <!--ui:head--> and <!--ui:body-->. Parts are ordered by `order` across
// plugins, so the page keeps one global load order no matter which plugin
// contributed what. Pure functions: tests compose the page without a server.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SLOTS = ['head', 'body'];
const KINDS = ['style', 'script', 'module', 'preload', 'html'];

function attr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** The markup of one declared part. */
export function renderPart(part) {
  if (part.style) return `<link rel="stylesheet" href="${attr(part.style)}">`;
  if (part.script) return `<script src="${attr(part.script)}"></script>`;
  if (part.module) return `<script type="module" src="${attr(part.module)}"></script>`;
  if (part.preload) return `<link rel="preload" href="${attr(part.preload)}" as="font" type="font/woff2" crossorigin>`;
  if (part.html !== undefined) return String(part.html);
  throw new Error(`a page part needs one of: ${KINDS.join(', ')}`);
}

/** Reads a page.json: the directories to serve and the parts to place. */
export function readContribution(file) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const base = dirname(file);
  const serve = (manifest.serve ?? []).map((dir) => resolve(base, dir));
  const parts = [];
  for (const slot of SLOTS) {
    for (const item of manifest[slot] ?? []) {
      if (!Number.isFinite(item.order)) throw new Error(`${file}: every ${slot} part needs a numeric "order"`);
      if (!KINDS.some((kind) => kind in item)) throw new Error(`${file}: a ${slot} part needs one of ${KINDS.join(', ')}`);
      parts.push({ slot, ...item });
    }
  }
  return { file, serve, parts };
}

/**
 * Places the parts into the template. A part may carry `render` (a function
 * returning markup, possibly async) instead of a declared kind.
 */
export async function composePage(template, parts) {
  const ordered = [...parts].sort((a, b) => a.order - b.order || (a.seq ?? 0) - (b.seq ?? 0));
  let page = template;
  for (const slot of SLOTS) {
    const marker = `<!--ui:${slot}-->`;
    if (!page.includes(marker)) continue;
    const tags = [];
    for (const part of ordered.filter((item) => item.slot === slot)) {
      tags.push(part.render ? await part.render() : renderPart(part));
    }
    page = page.replace(marker, tags.join('\n  '));
  }
  return page;
}

/** composePage for declared parts only (no render functions), synchronously. */
export function composePageSync(template, parts) {
  if (parts.some((part) => part.render)) throw new Error('composePageSync takes declared parts only');
  const ordered = [...parts].sort((a, b) => a.order - b.order || (a.seq ?? 0) - (b.seq ?? 0));
  let page = template;
  for (const slot of SLOTS) {
    const marker = `<!--ui:${slot}-->`;
    if (!page.includes(marker)) continue;
    page = page.replace(marker, ordered.filter((item) => item.slot === slot).map(renderPart).join('\n  '));
  }
  return page;
}

/** Every page.json under plugins/<id>/client/, for tests and tools. */
export function findContributions(pluginsDir) {
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => join(pluginsDir, item.name, 'client', 'page.json'))
    .filter((file) => existsSync(file));
}
