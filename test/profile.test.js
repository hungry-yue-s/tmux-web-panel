import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { applyPatch, dumpEntries, ProfileError, readProfile, resolveEntries, resolveUse, ROOT } from '../kernel/profile.js';
import { defaultProfile } from '../kernel/app.js';

let dir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'twp-profile-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name, value) {
  const file = join(dir, name);
  await writeFile(file, typeof value === 'string' ? value : YAML.stringify(value));
  return file;
}

describe('resolveUse', () => {
  it('maps a bare id to the built-in plugin, a path to a file, anything else to a package', () => {
    const declared = join(dir, 'profile.yml');
    expect(resolveUse('http', declared)).toBe(pathToFileURL(join(ROOT, 'plugins', 'http', 'index.js')).href);
    expect(resolveUse('./mine.js', declared)).toBe(pathToFileURL(join(dir, 'mine.js')).href);
    expect(resolveUse('@cordisjs/plugin-timer', declared)).toBe('@cordisjs/plugin-timer');
    expect(resolveUse('no-such-builtin', declared)).toBe('no-such-builtin');
  });
});

describe('readProfile', () => {
  it('reads the shipped panel profile', async () => {
    const profile = await readProfile('panel');
    expect(profile.name).toBe('panel');
    expect(profile.entries.map((entry) => entry.id).slice(0, 4)).toEqual(['logger', 'timer', 'launch', 'http']);
    expect(profile.entries.at(-1).id).toBe('ui');
  });

  it('ships a Node-only profile: the panel without the hub, the shared previews and the pages', async () => {
    const panel = (await readProfile('panel')).entries.map((entry) => entry.id);
    const node = (await readProfile('node')).entries.map((entry) => entry.id);
    expect(node.every((id) => panel.includes(id))).toBe(true);
    expect(panel.filter((id) => !node.includes(id)).sort()).toEqual([
      'basic-mode', 'client', 'hub-links', 'hub-relay', 'mosh-hub', 'node-installer', 'server-health',
      'server-registry', 'servers', 'share', 'ui',
    ]);
    // Same ids, same order: a user's patch applies to either.
    expect(panel.filter((id) => node.includes(id))).toEqual(node);
    expect(defaultProfile({ NODE_ONLY: '1' })).toBe('node');
    expect(defaultProfile({})).toBe('panel');
  });

  it('rejects unknown keys, bad ids and duplicates with the file in the message', async () => {
    const unknown = await write('a.yml', { plugins: [{ id: 'x', use: 'http', confg: {} }] });
    await expect(readProfile(unknown)).rejects.toThrow(/a\.yml.*unknown key "confg"/);
    const badId = await write('b.yml', { plugins: [{ id: 'X Y', use: 'http' }] });
    await expect(readProfile(badId)).rejects.toThrow(ProfileError);
    const dup = await write('c.yml', { plugins: [{ id: 'x', use: 'http' }, { id: 'x', use: 'tmux' }] });
    await expect(readProfile(dup)).rejects.toThrow(/duplicate id "x"/);
  });
});

describe('patches', () => {
  const base = [
    { id: 'a', use: 'a', module: 'a', config: { n: 1 }, disabled: false },
    { id: 'b', use: 'b', module: 'b', config: null, disabled: false },
  ];

  it('replaces a whole config, swaps an implementation, disables, and inserts', () => {
    const next = applyPatch(base, [
      { kind: 'change', id: 'a', config: { m: 2 } },
      { kind: 'change', id: 'b', use: 'c', module: 'c', disabled: true },
      { kind: 'insert', entry: { id: 'x', use: 'x', module: 'x', config: null, disabled: false }, after: 'a' },
      { kind: 'insert', entry: { id: 'y', use: 'y', module: 'y', config: null, disabled: false }, before: 'a' },
    ]);
    expect(next.map((entry) => entry.id)).toEqual(['y', 'a', 'x', 'b']);
    expect(next[1].config).toEqual({ m: 2 });
    expect(next[3]).toMatchObject({ use: 'c', disabled: true });
    // The input is not modified.
    expect(base[0].config).toEqual({ n: 1 });
  });

  it('refuses to patch an entry that does not exist or to insert a duplicate', () => {
    expect(() => applyPatch(base, [{ kind: 'change', id: 'zz', disabled: true, file: 'p.yml' }])).toThrow(/no entry "zz"/);
    expect(() => applyPatch(base, [{ kind: 'insert', entry: { id: 'a' }, file: 'p.yml' }])).toThrow(/already exists/);
  });

  it('layers the home patch before --patch files and records every layer', async () => {
    const home = join(dir, 'home');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(home);
    await writeFile(join(home, 'patch.yml'), YAML.stringify([{ id: 'http', config: { port: 1 } }]));
    const cli = await write('cli.yml', [
      { id: 'http', config: { port: 2 } },
      { insert: { id: 'mine', use: './mine.js' }, after: 'http' },
    ]);
    const assembled = await resolveEntries({ profile: 'panel', home, patches: [cli] });
    const http = assembled.entries.find((entry) => entry.id === 'http');
    expect(http.config).toEqual({ port: 2 });
    expect(assembled.entries.map((entry) => entry.id).indexOf('mine')).toBe(assembled.entries.map((entry) => entry.id).indexOf('http') + 1);
    expect(assembled.entries.find((entry) => entry.id === 'mine').module).toBe(pathToFileURL(join(dir, 'mine.js')).href);
    expect(assembled.layers).toHaveLength(3);
  });

  it('treats an empty patch file as no operations', async () => {
    const empty = await write('empty.yml', '');
    const assembled = await resolveEntries({ profile: 'panel', patches: [empty] });
    expect(assembled.entries).toHaveLength((await readProfile('panel')).entries.length);
  });

  it('dumps in the shape a profile is written in', async () => {
    const assembled = await resolveEntries({ profile: 'panel' });
    const text = dumpEntries(assembled);
    expect(text).toMatch(/^# profile: panel/);
    const doc = YAML.parse(text);
    expect(doc.plugins[3]).toEqual({ id: 'http', use: 'http' });
  });
});
