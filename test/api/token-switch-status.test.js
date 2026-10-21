import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTokenSwitchStatusReader } from '../../server/agent-providers/token-switch-status.js';

const roots = [];
const NOW = 1_800_000_000_000;

async function fixture(installed = true) {
  const home = await mkdtemp(join(tmpdir(), 'tmux-token-switch-status-'));
  roots.push(home);
  if (installed) {
    await mkdir(join(home, '.token-switch'));
    await writeFile(join(home, '.token-switch', 'token-switch.db'), 'fixture');
  }
  return home;
}

function provider(app, extra = {}) {
  return {
    id: 'same-model', app, name: '集团模型', is_current: 1,
    meta: JSON.stringify({ managedCatalog: {
      serverModelId: 'mode-demo', description: '模型说明', multiplier: 0.5, contextWindow: 800000,
      baseUrl: 'https://secret.test', apiKey: 'secret-catalog-key',
    } }),
    settings_config: '{"auth":{"OPENAI_API_KEY":"secret-api-key"}}',
    ...extra,
  };
}

function database(rows = [], expiresAt = NOW + 60_000) {
  return vi.fn(async (_path, query) => {
    if (query.includes('from providers')) return JSON.stringify(rows);
    if (query.includes('from settings')) return JSON.stringify([{ value: JSON.stringify({
      accessTokenExpiresAt: expiresAt, user: { name: 'private-user', empId: 'private-employee' },
    }) }]);
    throw new Error(`Unexpected SQL: ${query}`);
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('read-only Token Switch status', () => {
  it('does not create a missing database or query SQLite', async () => {
    const home = await fixture(false);
    const runSQLite = vi.fn();
    const readStatus = createTokenSwitchStatusReader({ home, runSQLite });
    await expect(readStatus()).resolves.toMatchObject({
      installed: false, loggedIn: false, expiresAt: null, models: [], canSwitchInPanel: false,
    });
    expect(runSQLite).not.toHaveBeenCalled();
    expect(await readdir(home)).toEqual([]);
  });

  it('returns only model and session whitelist fields without credentials or identity', async () => {
    const home = await fixture();
    const runSQLite = database([provider('codex')]);
    const status = await createTokenSwitchStatusReader({ home, runSQLite, now: () => NOW })();
    expect(status).toMatchObject({ installed: true, loggedIn: true, expiresAt: NOW + 60_000 });
    expect(status.models).toEqual([{
      id: 'same-model', app: 'codex', name: '集团模型', is_current: true,
      meta: { managedCatalog: {
        serverModelId: 'mode-demo', description: '模型说明', multiplier: 0.5, contextWindow: 800000,
      } },
    }]);
    expect(status.capabilities.codex).toMatchObject({ supported: true, control: 'native-ui' });
    expect(status.canSwitchInPanel).toBe(false);
    expect(JSON.stringify(status)).not.toMatch(/secret|baseUrl|private-user|private-employee|settings_config/);
    expect(runSQLite.mock.calls.every(([path, query]) => path === join(home, '.token-switch', 'token-switch.db')
      && /^select /i.test(query) && !query.includes('settings_config'))).toBe(true);
    expect(await readdir(join(home, '.token-switch'))).toEqual(['token-switch.db']);
  });

  it('reports expired login without hiding the existing catalog', async () => {
    const home = await fixture();
    const status = await createTokenSwitchStatusReader({ home, runSQLite: database([provider('codex')], NOW), now: () => NOW })();
    expect(status).toMatchObject({ installed: true, loggedIn: false, expiresAt: NOW });
    expect(status.models).toHaveLength(1);
  });

  it('keeps the same provider id in separate apps and never borrows app eligibility', async () => {
    const home = await fixture();
    const codexOnly = await createTokenSwitchStatusReader({ home, runSQLite: database([provider('codex')]) })();
    expect(codexOnly.capabilities.claude.supported).toBe(false);
    const status = await createTokenSwitchStatusReader({ home, runSQLite: database([provider('codex'), provider('claude')]) })();
    expect(status.models.map((entry) => [entry.app, entry.id])).toEqual([
      ['codex', 'same-model'], ['claude', 'same-model'],
    ]);
    expect(status.capabilities.claude).toMatchObject({ supported: true, control: 'native-ui' });
  });

  it('rejects unsupported apps, non-managed providers, and malformed catalog rows', async () => {
    const home = await fixture();
    const rows = [provider('qoder'), provider('unknown'), provider('claude', { meta: '{}' }),
      provider('codex', { meta: 'invalid' }), provider('codex', { meta: '{"managedCatalog":[]}' })];
    const status = await createTokenSwitchStatusReader({ home, runSQLite: database(rows) })();
    expect(status.models).toEqual([]);
    expect(Object.values(status.capabilities).every((entry) => !entry.supported)).toBe(true);
    expect(status.capabilities.qoder.control).toBe('unsupported');
  });

  it('sanitizes database failures instead of returning SQLite diagnostics', async () => {
    const home = await fixture();
    const runSQLite = vi.fn().mockRejectedValue(new Error('secret-token database failure'));
    const status = await createTokenSwitchStatusReader({ home, runSQLite })();
    expect(status).toMatchObject({ installed: true, loggedIn: false, models: [], canSwitchInPanel: false });
    expect(status.error).toBeTruthy();
    expect(JSON.stringify(status)).not.toContain('secret-token');
  });
});
