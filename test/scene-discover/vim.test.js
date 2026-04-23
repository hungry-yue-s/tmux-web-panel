import { describe, it, expect } from 'vitest';
import { scanVim } from '../../server/scene-discover/vim.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configFile = join(__dirname, '../fixtures/nvim-config.lua');

describe('scanVim', () => {
  it('extracts mapleader value', async () => {
    const result = await scanVim({ configFiles: [configFile] });
    expect(result.leaderKey).toBe(' ');
  });

  it('extracts custom leader keymaps', async () => {
    const result = await scanVim({ configFiles: [configFile] });
    const keys = result.customKeymaps.map(k => k.key);
    expect(keys).toContain('<leader>ff');
    expect(keys).toContain('<leader>e');
    expect(keys).toContain('<leader>mp');
  });

  it('returns empty when file missing', async () => {
    const result = await scanVim({ configFiles: ['/nonexistent'] });
    expect(result.customKeymaps).toEqual([]);
  });
});
