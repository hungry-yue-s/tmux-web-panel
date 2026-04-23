import { describe, it, expect } from 'vitest';
import { scanLazygit } from '../../server/scene-discover/lazygit.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configFile = join(__dirname, '../fixtures/lazygit-config.yml');

describe('scanLazygit', () => {
  it('detects has custom config', async () => {
    const result = await scanLazygit({ configFile });
    expect(result.hasCustomConfig).toBe(true);
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
