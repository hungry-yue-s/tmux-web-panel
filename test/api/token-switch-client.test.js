import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTokenSwitchClient } from '../../server/agent-providers/token-switch-client.js';

const roots = [];
const NOW = 1_800_000_000_000;
const TOKEN = 'fixture-access-token-with-private-identity';

async function fixture(installed = true) {
  const home = await mkdtemp(join(tmpdir(), 'tmux-token-switch-client-'));
  roots.push(home);
  if (installed) {
    await mkdir(join(home, '.token-switch'));
    await writeFile(join(home, '.token-switch', 'token-switch.db'), 'fixture');
  }
  return home;
}

function encryptedStore(overrides = {}, token = TOKEN) {
  const nonce = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const installId = 'fixture-install-identifier';
  const key = createHash('sha256').update('token-switch-auth-session-v1').update(installId).update(nonce).digest();
  const plaintext = Buffer.from(JSON.stringify({ accessToken: token }));
  const ciphertext = Buffer.alloc(plaintext.length);
  for (let offset = 0, counter = 0n; offset < plaintext.length; offset += 32, counter++) {
    const block = Buffer.alloc(8); block.writeBigUInt64LE(counter);
    const stream = createHash('sha256').update(key).update(nonce).update(block).digest();
    for (let index = 0; index < Math.min(32, plaintext.length - offset); index++) ciphertext[offset + index] = plaintext[offset + index] ^ stream[index];
  }
  return {
    token_switch_auth_install_id: installId,
    token_switch_auth_session_secret_v1: JSON.stringify({ version: 1, algorithm: 'sha256-stream-xor', nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64') }),
    token_switch_auth_session_meta: JSON.stringify({ accessTokenExpiresAt: NOW + 60000, user: { name: 'private-user' } }),
    managed_catalog_device_id: 'fixture-device-identifier',
    ...overrides,
  };
}

function database(values = encryptedStore()) {
  return vi.fn(async () => JSON.stringify(Object.entries(values).map(([key, value]) => ({ key, value }))));
}

function response(data, error_code = 0) {
  return new Response(JSON.stringify({ data, error_code, error_msg: TOKEN }));
}

function catalog(appCode = 'Codex', id = 'mode-demo') {
  return {
    protocol: [{ name: 'openai_chat', base_url: 'https://token-hub.alibaba-inc.com/portal/llm-api/openai/v1' },
      { name: 'anthropic', base_url: 'https://token-hub.alibaba-inc.com/portal/llm-api/anthropic' }],
    apps: [{ appCode, modes: [{ modeCode: id, modeName: 'Auto', description: '集团模型', multiplier: 0.5,
      contextWindow: 800000, multimodal: true, protocolList: ['anthropic'], secret: TOKEN }] }],
    accessToken: TOKEN,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('independent Token Switch client', () => {
  it('reports local session status without exposing identity or tokens', async () => {
    const home = await fixture();
    const runSQLite = database();
    const client = createTokenSwitchClient({ home, runSQLite, now: () => NOW });
    await expect(client.getStatus()).resolves.toEqual({ installed: true, loggedIn: true, expiresAt: NOW + 60000 });
    expect(client.getSession).toBeUndefined();
    expect(runSQLite.mock.calls.every(([_path, sql]) => /^select /i.test(sql))).toBe(true);
    expect(await readdir(join(home, '.token-switch'))).toEqual(['token-switch.db']);
  });

  it('does not create a missing store or contact the network', async () => {
    const home = await fixture(false);
    const runSQLite = vi.fn(), fetchImpl = vi.fn();
    const client = createTokenSwitchClient({ home, runSQLite, fetchImpl });
    await expect(client.getStatus()).resolves.toEqual({ installed: false, loggedIn: false, expiresAt: null });
    expect(runSQLite).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(home)).toEqual([]);
  });

  it('uses the native headers and canonical app spelling, and whitelists the catalog', async () => {
    const home = await fixture();
    const fetchImpl = vi.fn().mockImplementation(async () => response(catalog()));
    const client = createTokenSwitchClient({ home, runSQLite: database(), fetchImpl, now: () => NOW });
    const result = await client.getCatalog(['codex']);
    expect(result.models).toEqual([{
      id: 'mode-demo', name: 'Auto', app: 'codex', appCode: 'Codex',
      baseUrl: 'https://token-hub.alibaba-inc.com/portal/llm-api/openai/v1',
      description: '集团模型', multiplier: 0.5, contextWindow: 800000, multimodal: true, protocolList: ['anthropic'],
    }]);
    expect(JSON.stringify(result)).not.toMatch(/fixture-access-token|private-user|accessToken|secret/);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://token-hub.alibaba-inc.com/portal/token-switch/providers/available');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', body: '{"appCodes":["Codex"]}',
      headers: { 'X-Switch-Token': TOKEN, 'X-Device-Id': 'fixture-device-identifier', 'X-Client-Version': '0.1.7' } });
    expect(await client.gatewayHeaders('codex', 'mode-demo')).toEqual({
      'X-Switch-Token': TOKEN, 'X-CC-Model-ID': 'mode-demo', 'X-App-Tag': 'Codex',
    });
  });

  it('checks quota using the actual boolean response without claiming monthly Credits amounts', async () => {
    const home = await fixture();
    const fetchImpl = vi.fn().mockImplementation(async (url) => response(url.endsWith('/available') ? catalog() : false));
    const client = createTokenSwitchClient({ home, runSQLite: database(), fetchImpl, now: () => NOW });
    await expect(client.checkQuota('Codex', 'mode-demo')).resolves.toEqual({
      app: 'codex', appCode: 'Codex', modelId: 'mode-demo', available: false, observedAt: NOW,
    });
    expect(fetchImpl.mock.calls[1][1].body).toBe('{"appCode":"Codex","modeCode":"mode-demo"}');
  });

  it('keeps application eligibility separate even when callers mutate the returned catalog', async () => {
    const home = await fixture();
    const fetchImpl = vi.fn().mockImplementation(async (_url, options) => {
      const requested = JSON.parse(options.body).appCodes[0];
      const data = catalog(requested);
      if (requested !== 'Codex') data.apps[0].modes = [];
      return response(data);
    });
    const client = createTokenSwitchClient({ home, runSQLite: database(), fetchImpl, now: () => NOW });
    const result = await client.getCatalog(['Codex']);
    result.models.push({ id: 'fake-mode', appCode: 'Codex' });
    await expect(client.gatewayHeaders('Codex', 'fake-mode')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(client.gatewayHeaders('Claude Code', 'mode-demo')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(client.gatewayHeaders('Qoder', 'mode-demo')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('refreshes cached permissions when the logged-in session changes', async () => {
    const home = await fixture();
    const nextToken = 'fixture-second-account-token';
    let values = encryptedStore();
    const runSQLite = vi.fn(async () => database(values)());
    const fetchImpl = vi.fn(async (url, options) => {
      const model = options.headers['X-Switch-Token'] === TOKEN ? 'mode-demo' : 'mode-second';
      return response(url.endsWith('/available') ? catalog('Codex', model) : true);
    });
    const client = createTokenSwitchClient({ home, runSQLite, fetchImpl, now: () => NOW });
    await client.getCatalog();
    values = encryptedStore({}, nextToken);
    await expect(client.gatewayHeaders('Codex', 'mode-demo')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(client.checkQuota('Codex', 'mode-demo')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await client.gatewayHeaders('Codex', 'mode-second'))['X-Switch-Token']).toBe(nextToken);
    expect((await client.checkQuota('Codex', 'mode-second')).available).toBe(true);
    expect(fetchImpl.mock.calls.at(-1)[1]).toMatchObject({
      headers: { 'X-Switch-Token': nextToken }, body: '{"appCode":"Codex","modeCode":"mode-second"}',
    });
  });

  it.each(['gatewayHeaders', 'checkQuota'])('uses one session snapshot for catalog validation and %s', async (method) => {
    const home = await fixture();
    let values = encryptedStore();
    const runSQLite = vi.fn(async () => database(values)());
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/available')) {
        values = encryptedStore({}, 'fixture-new-session-during-catalog-request');
        return response(catalog());
      }
      return response(true);
    });
    const client = createTokenSwitchClient({ home, runSQLite, fetchImpl, now: () => NOW });
    const result = await client[method]('Codex', 'mode-demo');
    expect(runSQLite).toHaveBeenCalledTimes(1);
    if (method === 'gatewayHeaders') expect(result['X-Switch-Token']).toBe(TOKEN);
    else expect(result.available).toBe(true);
    expect(fetchImpl.mock.calls.every(([_url, options]) => options.headers['X-Switch-Token'] === TOKEN)).toBe(true);
  });

  it('does not authorize headers or quota after the session expires during a catalog request', async () => {
    const home = await fixture();
    for (const method of ['gatewayHeaders', 'checkQuota']) {
      let currentTime = NOW;
      const fetchImpl = vi.fn(async () => {
        currentTime = NOW + 60000;
        return response(catalog());
      });
      const client = createTokenSwitchClient({ home, runSQLite: database(), fetchImpl, now: () => currentTime });
      await expect(client[method]('Codex', 'mode-demo')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects expired, corrupt, or unsupported sessions before making metadata requests', async () => {
    const home = await fixture();
    for (const values of [
      encryptedStore({ token_switch_auth_session_meta: JSON.stringify({ accessTokenExpiresAt: NOW }) }),
      encryptedStore({ token_switch_auth_install_id: 'wrong-identifier' }),
      encryptedStore({ token_switch_auth_session_secret_v1: '{"version":2,"algorithm":"unknown"}' }),
    ]) {
      const fetchImpl = vi.fn();
      const client = createTokenSwitchClient({ home, runSQLite: database(values), fetchImpl, now: () => NOW });
      expect((await client.getStatus()).loggedIn).toBe(false);
      await expect(client.getCatalog()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('rejects external catalog endpoints and sanitizes server errors', async () => {
    const home = await fixture();
    const data = catalog(); data.protocol[0].base_url = 'https://untrusted.test/portal/llm-api/openai/v1';
    const client = createTokenSwitchClient({ home, runSQLite: database(), fetchImpl: async () => response(data), now: () => NOW });
    expect((await client.getCatalog()).models).toEqual([]);
    await expect(client.gatewayHeaders('Codex', 'mode-demo')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    const failing = createTokenSwitchClient({ home, runSQLite: database(), fetchImpl: async () => response(null, 401), now: () => NOW });
    let failure;
    try { await failing.getCatalog(); } catch (error) { failure = error; }
    expect(failure.code).toBe('UNSUPPORTED');
    expect(JSON.stringify(failure.toJSON())).not.toContain(TOKEN);
  });
});
