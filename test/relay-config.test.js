import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveLegacyRelayConfig } from '../plugins/ui/relay-config.js';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'anymux-relay-'));
  dirs.push(root);
  mkdirSync(join(root, 'plugins', 'ui', 'client', 'js'), { recursive: true });
  return { root, target: join(root, 'plugins', 'ui', 'client', 'js', 'relay-config.js') };
}

function writeLegacy(root, text) {
  mkdirSync(join(root, 'public', 'js'), { recursive: true });
  writeFileSync(join(root, 'public', 'js', 'relay-config.js'), text);
}

describe('the relay config left at public/js by an update', () => {
  it('moves to the ui plugin, and the emptied public/ goes away', () => {
    const { root, target } = checkout();
    writeLegacy(root, 'window.PANEL_RELAY_PAGE = "https://example.invalid/";\n');
    expect(moveLegacyRelayConfig(root, target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('https://example.invalid/');
    expect(existsSync(join(root, 'public'))).toBe(false);
  });

  it('never replaces a config at the new place, and keeps other files in public/', () => {
    const { root, target } = checkout();
    writeLegacy(root, 'old');
    writeFileSync(join(root, 'public', 'keep.txt'), 'mine');
    writeFileSync(target, 'new');
    expect(moveLegacyRelayConfig(root, target)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('new');

    rmSync(target);
    expect(moveLegacyRelayConfig(root, target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('old');
    expect(readFileSync(join(root, 'public', 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('does nothing without an old config', () => {
    const { root, target } = checkout();
    expect(moveLegacyRelayConfig(root, target)).toBe(false);
    expect(existsSync(target)).toBe(false);
  });
});
