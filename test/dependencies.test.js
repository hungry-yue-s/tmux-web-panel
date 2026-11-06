import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_ROOT, missingDependencies } from '../kernel/dependencies.js';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function app(dependencies) {
  const root = mkdtempSync(join(tmpdir(), 'twp-deps-'));
  dirs.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies }));
  return root;
}

function install(root, name) {
  const dir = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{}');
}

describe('dependency check', () => {
  it('names each dependency node_modules lacks, scoped ones included', () => {
    const root = app({ cordis: 'file:vendor/cordis', '@cordisjs/plugin-timer': 'file:vendor/plugin-timer', express: '^5' });
    install(root, 'express');
    expect(missingDependencies(root)).toEqual(['cordis', '@cordisjs/plugin-timer']);
    install(root, 'cordis');
    install(root, '@cordisjs/plugin-timer');
    expect(missingDependencies(root)).toEqual([]);
  });

  it('passes in this checkout', () => {
    expect(missingDependencies(APP_ROOT)).toEqual([]);
    execFileSync(process.execPath, [join(APP_ROOT, 'bin', 'panel.js'), '--check-dependencies']);
  });

  it('stops the launcher before it imports the kernel, saying what to run', () => {
    // A checkout updated without `npm install`: the launcher and package.json, no node_modules.
    const root = app({ cordis: 'file:vendor/cordis' });
    cpSync(join(APP_ROOT, 'bin', 'panel.js'), join(root, 'bin', 'panel.js'));
    cpSync(join(APP_ROOT, 'kernel', 'dependencies.js'), join(root, 'kernel', 'dependencies.js'));
    writeFileSync(join(root, 'kernel', 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'bin', 'package.json'), '{"type":"module"}');
    const result = spawnSync(process.execPath, [join(root, 'bin', 'panel.js')], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing dependencies: cordis');
    expect(result.stderr).toContain(`run "npm install" in ${root}`);
  });
});
