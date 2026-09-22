import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClaudeProviderSwitcher } from '../../server/agent-providers/claude-provider-switch.js';

const roots = [];

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'tmux-claude-switch-'));
  roots.push(home);
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(home, '.cc-switch'), { recursive: true });
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_AUTH_TOKEN: 'live-token', KEEP_ME: 'yes' }, permissions: { allow: ['Bash'] },
  }));
  await writeFile(join(home, '.cc-switch', 'settings.json'), JSON.stringify({ currentProviderClaude: 'old' }));
  return home;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('embedded Claude provider switcher', () => {
  it('backfills the current provider and replaces only provider-owned environment variables', async () => {
    const home = await fixture();
    const sql = [];
    const rows = [
      { id: 'old', name: 'Old', category: 'custom', is_current: 1, settings_config: JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'stale' } }) },
      { id: 'official', name: 'Claude Official', category: 'official', is_current: 0, settings_config: JSON.stringify({ env: {} }) },
    ];
    const runSQLite = async (_path, query) => {
      sql.push(query);
      if (query.includes('from providers where')) return JSON.stringify(rows);
      if (query.includes('proxy_live_backup')) return '[{"count":0}]';
      return '';
    };
    const switchProvider = createClaudeProviderSwitcher({ home, databasePath: join(home, 'cc.db'), runSQLite });

    await expect(switchProvider('official')).resolves.toMatchObject({ providerId: 'official', active: true });
    const live = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'));
    expect(live.env).toEqual({ KEEP_ME: 'yes' });
    expect(live.permissions.allow).toEqual(['Bash']);
    expect(sql.some((query) => query.includes('live-token'))).toBe(true);
    expect(sql.some((query) => query.includes("id='official'"))).toBe(true);
  });

  it('restores files and current provider when a switch fails', async () => {
    const home = await fixture();
    const rows = [
      { id: 'old', name: 'Old', category: 'custom', is_current: 1, settings_config: '{"env":{"ANTHROPIC_AUTH_TOKEN":"stale"}}' },
      { id: 'next', name: 'Next', category: 'custom', is_current: 0, settings_config: '{"env":{"ANTHROPIC_AUTH_TOKEN":"next"}}' },
    ];
    let commits = 0;
    const runSQLite = async (_path, query) => {
      if (query.includes('from providers where')) return JSON.stringify(rows);
      if (query.includes('proxy_live_backup')) return '[{"count":0}]';
      if (query.startsWith('begin immediate') && commits++ === 0) throw new Error('db failed');
      return '';
    };
    const switchProvider = createClaudeProviderSwitcher({ home, databasePath: join(home, 'cc.db'), runSQLite });
    await expect(switchProvider('next')).rejects.toThrow('db failed');
    const live = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'));
    expect(live.env.ANTHROPIC_AUTH_TOKEN).toBe('live-token');
  });
});
