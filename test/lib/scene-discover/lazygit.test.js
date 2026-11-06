import { describe, it, expect } from 'vitest';
import { scanLazygit } from '../../../lib/scene-discover/lazygit.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configFile = join(__dirname, '../fixtures/lazygit-config.yml');

describe('scanLazygit', () => {
  it('detects has custom config', async () => {
    const result = await scanLazygit({ configFile });
    expect(result.hasCustomConfig).toBe(true);
  });

  it('reads a config written with CRLF line ends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lazygit-crlf-'));
    try {
      const crlfFile = join(dir, 'config.yml');
      writeFileSync(crlfFile, readFileSync(configFile, 'utf8').replace(/\r?\n/g, '\r\n'));
      const result = await scanLazygit({ configFile: crlfFile });
      expect(result.customCommands[0].key).toBe('<c-a>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extracts custom commands', async () => {
    const result = await scanLazygit({ configFile });
    expect(result.customCommands.length).toBeGreaterThan(0);
    expect(result.customCommands[0].key).toBe('<c-a>');
  });

  it('returns empty for missing config', async () => {
    const result = await scanLazygit({ configFile: '/nonexistent' });
    expect(result.hasCustomConfig).toBe(false);
    expect(result.customCommands).toEqual([]);
  });
});
