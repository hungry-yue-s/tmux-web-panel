// Profiles and patches: how a running panel is assembled.
//
// A profile is an ordered list of plugin entries. Patches are applied on top of
// it, in order: the home patch (<home>/patch.yml), then each --patch file. The
// result is the whole application — `twp --dump-config` prints it, and any
// entry it prints can be replaced by a patch. Nothing is assembled anywhere
// else: no plugin is mounted that this list does not name.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

/** The repository root: profiles/, plugins/ and client/ are found from here. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ID_RE = /^[a-z][a-z0-9-]*$/;
const ENTRY_KEYS = new Set(['id', 'use', 'config', 'disabled']);

export class ProfileError extends Error {
  constructor(file, where, message) {
    super(`${file}${where ? ` (${where})` : ''}: ${message}`);
    this.name = 'ProfileError';
  }
}

function isPathLike(value) {
  return /^\.{1,2}[\\/]/.test(value) || isAbsolute(value);
}

/**
 * What `use` names, as an import specifier:
 * - `./x.js`, `../x.js`, an absolute path: a file, relative to the file that
 *   declared the entry;
 * - a bare id such as `http`: plugins/<id>/index.js when it exists;
 * - anything else: a package, imported from the repository root.
 */
export function resolveUse(use, declaredIn, root = ROOT) {
  if (isPathLike(use)) return pathToFileURL(resolve(dirname(declaredIn), use)).href;
  if (ID_RE.test(use)) {
    const builtin = join(root, 'plugins', use, 'index.js');
    if (existsSync(builtin)) return pathToFileURL(builtin).href;
  }
  return use;
}

function normalizeEntry(raw, file, where, root) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProfileError(file, where, 'an entry must be a mapping');
  }
  for (const key of Object.keys(raw)) {
    if (!ENTRY_KEYS.has(key)) throw new ProfileError(file, where, `unknown key "${key}"`);
  }
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) {
    throw new ProfileError(file, where, `"id" must match ${ID_RE}`);
  }
  if (typeof raw.use !== 'string' || !raw.use) {
    throw new ProfileError(file, where, `entry "${raw.id}" needs "use"`);
  }
  if (raw.disabled !== undefined && typeof raw.disabled !== 'boolean') {
    throw new ProfileError(file, where, `"disabled" of "${raw.id}" must be true or false`);
  }
  return {
    id: raw.id,
    use: raw.use,
    module: resolveUse(raw.use, file, root),
    config: raw.config ?? null,
    disabled: raw.disabled ?? false,
  };
}

function parseYaml(text, file) {
  try {
    return YAML.parse(text);
  } catch (error) {
    throw new ProfileError(file, null, `invalid YAML: ${error.message}`);
  }
}

/** A profile by name (profiles/<name>.yml) or by path. */
export async function readProfile(name, { root = ROOT } = {}) {
  const file = isPathLike(name) ? resolve(name) : join(root, 'profiles', `${name}.yml`);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new ProfileError(file, null, 'no such profile');
    throw error;
  }
  const doc = parseYaml(text, file);
  if (!doc || !Array.isArray(doc.plugins)) throw new ProfileError(file, null, 'expected a "plugins" list');
  const entries = doc.plugins.map((raw, index) => normalizeEntry(raw, file, `plugins[${index}]`, root));
  assertUniqueIds(entries, file);
  return { name: typeof doc.name === 'string' ? doc.name : String(name), file, entries };
}

function assertUniqueIds(entries, file) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new ProfileError(file, null, `duplicate id "${entry.id}"`);
    seen.add(entry.id);
  }
}

/**
 * A patch is a list of operations, applied in order:
 *   { id, config }                     replace that entry's whole config
 *   { id, use }                        swap its implementation, keeping the id
 *   { id, disabled: true | false }     turn it off or back on
 *   { insert: <entry>, after | before: <id> }   add an entry (default: at the end)
 * An operation may combine config, use and disabled for the same id.
 */
export async function readPatch(file, { root = ROOT } = {}) {
  const doc = parseYaml(await readFile(file, 'utf8'), file);
  if (doc === null || doc === undefined) return [];
  if (!Array.isArray(doc)) throw new ProfileError(file, null, 'a patch must be a list of operations');
  return doc.map((op, index) => normalizeOp(op, file, `[${index}]`, root));
}

function normalizeOp(op, file, where, root) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) {
    throw new ProfileError(file, where, 'an operation must be a mapping');
  }
  if ('insert' in op) {
    for (const key of Object.keys(op)) {
      if (!['insert', 'after', 'before'].includes(key)) throw new ProfileError(file, where, `unknown key "${key}"`);
    }
    if (op.after !== undefined && op.before !== undefined) {
      throw new ProfileError(file, where, 'use either "after" or "before", not both');
    }
    return { kind: 'insert', entry: normalizeEntry(op.insert, file, `${where}.insert`, root), after: op.after, before: op.before, where, file };
  }
  for (const key of Object.keys(op)) {
    if (!['id', 'config', 'use', 'disabled'].includes(key)) throw new ProfileError(file, where, `unknown key "${key}"`);
  }
  if (typeof op.id !== 'string') throw new ProfileError(file, where, 'an operation needs "id" or "insert"');
  if (op.disabled !== undefined && typeof op.disabled !== 'boolean') {
    throw new ProfileError(file, where, '"disabled" must be true or false');
  }
  const change = { kind: 'change', id: op.id, where, file };
  if ('config' in op) change.config = op.config ?? null;
  if ('disabled' in op) change.disabled = op.disabled;
  if ('use' in op) {
    if (typeof op.use !== 'string' || !op.use) throw new ProfileError(file, where, '"use" must be a non-empty string');
    change.use = op.use;
    change.module = resolveUse(op.use, file, root);
  }
  return change;
}

/** Applies operations to a list of entries and returns the new list. */
export function applyPatch(entries, ops) {
  let next = entries.map((entry) => ({ ...entry }));
  for (const op of ops) {
    if (op.kind === 'insert') {
      if (next.some((entry) => entry.id === op.entry.id)) {
        throw new ProfileError(op.file, op.where, `"${op.entry.id}" already exists; patch it by id instead`);
      }
      const anchor = op.after ?? op.before;
      let index = next.length;
      if (anchor !== undefined) {
        const at = next.findIndex((entry) => entry.id === anchor);
        if (at < 0) throw new ProfileError(op.file, op.where, `no entry "${anchor}" to insert next to`);
        index = op.after !== undefined ? at + 1 : at;
      }
      next = [...next.slice(0, index), { ...op.entry }, ...next.slice(index)];
      continue;
    }
    const target = next.find((entry) => entry.id === op.id);
    if (!target) throw new ProfileError(op.file, op.where, `no entry "${op.id}" to patch`);
    if ('config' in op) target.config = op.config;
    if ('disabled' in op) target.disabled = op.disabled;
    if ('use' in op) {
      target.use = op.use;
      target.module = op.module;
    }
  }
  return next;
}

/**
 * The application a profile describes, after every patch layer.
 * `layers` lists the files that took part, in the order they were applied.
 */
export async function resolveEntries({ profile = 'panel', patches = [], home = null, root = ROOT } = {}) {
  const base = await readProfile(profile, { root });
  let entries = base.entries;
  const layers = [base.file];
  const files = [];
  if (home) {
    const homePatch = join(home, 'patch.yml');
    if (existsSync(homePatch)) files.push(homePatch);
  }
  files.push(...patches.map((file) => resolve(file)));
  for (const file of files) {
    entries = applyPatch(entries, await readPatch(file, { root }));
    layers.push(file);
  }
  return { name: base.name, entries, layers };
}

/** The assembled application as YAML, in the same shape a profile is written in. */
export function dumpEntries({ name, entries, layers }) {
  const header = [`# profile: ${name}`, ...layers.map((file, index) => `# layer ${index}: ${file}`)].join('\n');
  const plugins = entries.map((entry) => {
    const out = { id: entry.id, use: entry.use };
    if (entry.config !== null && entry.config !== undefined) out.config = entry.config;
    if (entry.disabled) out.disabled = true;
    return out;
  });
  return `${header}\n${YAML.stringify({ name, plugins })}`;
}
