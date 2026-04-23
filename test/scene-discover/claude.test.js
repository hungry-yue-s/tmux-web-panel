import { describe, it, expect } from 'vitest';
import { scanClaude } from '../../server/scene-discover/claude.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsDir = join(__dirname, '../fixtures/claude-commands');

describe('scanClaude', () => {
  it('lists slash commands from commands dir', async () => {
    const result = await scanClaude({ commandsDir });
    const ids = result.slashCommands.map(c => c.id);
    expect(ids).toContain('plan');
    expect(ids).toContain('review');
  });

  it('returns empty when commands dir missing', async () => {
    const result = await scanClaude({ commandsDir: '/nonexistent' });
    expect(result.slashCommands).toEqual([]);
  });

  it('extracts description from frontmatter', async () => {
    const result = await scanClaude({ commandsDir });
    const plan = result.slashCommands.find(c => c.id === 'plan');
    expect(plan.description).toBe('Planning slash command');
  });
});
