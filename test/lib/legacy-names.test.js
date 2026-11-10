import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptLegacyEnv, appDir, appPathCandidates, currentEnvName, migrateLegacyDirs } from '../../lib/legacy-names.js';

const homes = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'anymux-legacy-'));
  homes.push(dir);
  return dir;
}
function write(path, text) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}
const quiet = () => {};

describe('legacy environment names', () => {
  it('maps each old prefix to ANYMUX_ and never overrides a new name already set', () => {
    expect(currentEnvName('TMUX_PANEL_CONFIG_DIR')).toBe('ANYMUX_CONFIG_DIR');
    expect(currentEnvName('TMUX_WEB_PANEL_TOKEN')).toBe('ANYMUX_TOKEN');
    expect(currentEnvName('TWP_HOME')).toBe('ANYMUX_HOME');
    expect(currentEnvName('TMUX_PANE')).toBeNull();
    const env = adoptLegacyEnv({ TMUX_PANEL_URL: 'old', ANYMUX_URL: 'new', TWP_REPO_ROOT: '/repo', TMUX_PANE: '%1' });
    expect(env).toMatchObject({ ANYMUX_URL: 'new', ANYMUX_REPO_ROOT: '/repo', TMUX_PANE: '%1' });
    expect(env.ANYMUX_PANE).toBeUndefined();
  });
});

describe('legacy directories', () => {
  it('answers with the old directory only while it is the one that exists', () => {
    const dir = home();
    expect(appDir('config', { home: dir })).toBe(join(dir, '.config', 'anymux'));
    mkdirSync(join(dir, '.config', 'tmux-web-panel'), { recursive: true });
    expect(appDir('config', { home: dir })).toBe(join(dir, '.config', 'tmux-web-panel'));
    mkdirSync(join(dir, '.config', 'anymux'));
    expect(appDir('config', { home: dir })).toBe(join(dir, '.config', 'anymux'));
    expect(appPathCandidates('data', 'bin/tmux', { home: dir }))
      .toEqual([join(dir, '.local', 'share', 'anymux', 'bin/tmux'), join(dir, '.local', 'share', 'tmux-web-panel', 'bin/tmux')]);
  });

  it('moves each old directory and links the old path to the new one', () => {
    const dir = home();
    write(join(dir, '.config', 'tmux-web-panel', 'node.json'), '{"port":1}');
    write(join(dir, '.local', 'share', 'tmux-web-panel', 'bin', 'tmux'), 'binary');
    const results = migrateLegacyDirs({ home: dir, windows: true, warn: quiet });
    expect(results.map((result) => [result.kind, result.left])).toEqual([['config', []], ['data', []]]);
    expect(readFileSync(join(dir, '.config', 'anymux', 'node.json'), 'utf8')).toBe('{"port":1}');
    // A Hub of the old version still finds the pairing file at the old path.
    expect(lstatSync(join(dir, '.config', 'tmux-web-panel')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dir, '.config', 'tmux-web-panel', 'node.json'), 'utf8')).toBe('{"port":1}');
    expect(readFileSync(join(dir, '.local', 'share', 'tmux-web-panel', 'bin', 'tmux'), 'utf8')).toBe('binary');
    // The link is not moved again.
    expect(migrateLegacyDirs({ home: dir, windows: true, warn: quiet })).toEqual([]);
  });

  it('merges into an existing new directory and keeps what both have in the old one', () => {
    const dir = home();
    const legacy = join(dir, '.config', 'tmux-web-panel');
    const current = join(dir, '.config', 'anymux');
    write(join(legacy, 'tokens.json'), 'old tokens');
    write(join(legacy, 'logs', 'panel.log'), 'old log');
    write(join(legacy, 'logs', 'tmux-server.log'), 'held open');
    write(join(current, 'logs', 'tmux-server.log'), 'new log');
    const [result] = migrateLegacyDirs({ home: dir, windows: true, warn: quiet });
    expect(result.left).toEqual([join(legacy, 'logs', 'tmux-server.log')]);
    expect(readFileSync(join(current, 'tokens.json'), 'utf8')).toBe('old tokens');
    expect(readFileSync(join(current, 'logs', 'panel.log'), 'utf8')).toBe('old log');
    expect(readFileSync(join(current, 'logs', 'tmux-server.log'), 'utf8')).toBe('new log');
    // Something stayed behind, so the old directory is not replaced by a link yet.
    expect(lstatSync(legacy).isSymbolicLink()).toBe(false);
    expect(existsSync(join(legacy, 'tokens.json'))).toBe(false);
  });

  it('leaves Windows to the service installer unless asked', () => {
    const dir = home();
    write(join(dir, '.config', 'tmux-web-panel', 'windows-service.json'), '{}');
    expect(migrateLegacyDirs({ home: dir, platform: 'win32', warn: quiet })).toEqual([]);
    expect(existsSync(join(dir, '.config', 'anymux'))).toBe(false);
  });
});
