import { describe, it, expect } from 'vitest';
import { scanTerminal } from '../../server/scene-discover/terminal.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, '../fixtures/shell-history-sample.txt');

describe('scanTerminal', () => {
  it('extracts top commands by first word', async () => {
    const result = await scanTerminal({ historyFile: fixturePath });
    const topWords = result.topCommands.slice(0, 3).map(c => c.command);
    expect(topWords).toContain('git');
    expect(topWords).toContain('ls');
  });

  it('extracts top complete commands', async () => {
    const result = await scanTerminal({ historyFile: fixturePath });
    const topFull = result.topFullCommands.slice(0, 5).map(c => c.command);
    expect(topFull).toContain('./gradlew assembleDebug');
  });

  it('filters secrets from history', async () => {
    const result = await scanTerminal({ historyFile: fixturePath });
    const hasSecret = result.topFullCommands.some(c => c.command.includes('API_KEY=sk-secret'));
    expect(hasSecret).toBe(false);
  });

  it('returns empty structure when file missing', async () => {
    const result = await scanTerminal({ historyFile: '/nonexistent/path' });
    expect(result.topCommands).toEqual([]);
    expect(result.topFullCommands).toEqual([]);
  });
});
