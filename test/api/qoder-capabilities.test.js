import { describe, expect, it, vi } from 'vitest';
import { createQoderCapabilitiesReader } from '../../server/agent-providers/qoder-capabilities.js';

function fixture(status = {}, execFile) {
  const run = execFile || vi.fn(async () => ({ stdout: JSON.stringify({
    version: '1.1.68', logged_in: true, account_type: 'user', user_type: 'teams', allow_byok: 0, ...status,
  }) }));
  return { read: createQoderCapabilitiesReader({ home: '/test-home', execFile: run }), run };
}

describe('Qoder capability reader', () => {
  it.each([0, 1, 2])('requires actual custom URL entitlement (%i)', async (allow_byok) => {
    const { read, run } = fixture({ allow_byok });
    const result = await read();
    expect(result).toMatchObject({ installed: true, version: '1.1.68', loggedIn: true,
      accountType: 'user', userType: 'teams', allowByok: allow_byok, customProviderAvailable: allow_byok >= 2 });
    expect(run).toHaveBeenCalledWith('/test-home/.local/bin/qodercli', ['status', '-o', 'json'],
      { timeout: 5000, maxBuffer: 64 * 1024 });
  });

  it.each([{ account_type: 'service_account' }, { logged_in: false }, { account_type: 'unknown' }, { allow_byok: '2' }])
    ('fails closed for unavailable identity or entitlement %j', async (status) => {
      const { read } = fixture({ allow_byok: 2, ...status });
      expect((await read()).customProviderAvailable).toBe(false);
    });

  it('falls back to the PATH command when the local binary is missing', async () => {
    const run = vi.fn().mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      .mockResolvedValueOnce({ stdout: '{"logged_in":false}' });
    expect(await fixture({}, run).read()).toMatchObject({ installed: true, loggedIn: false });
    expect(run.mock.calls[1][0]).toBe('qodercli');
  });

  it('handles missing commands and failures without exposing subprocess output', async () => {
    for (const code of ['ENOENT', 'ETIMEDOUT']) {
      const run = vi.fn().mockRejectedValue(Object.assign(new Error('private-token'), {
        code, stdout: 'private-token', stderr: 'private-token',
      }));
      const result = await fixture({}, run).read();
      expect(result.installed).toBe(code !== 'ENOENT');
      expect(result.customProviderAvailable).toBe(false);
      expect(JSON.stringify(result)).not.toContain('private-token');
    }
  });

  it('exposes only known capability fields and no account identities or credentials', async () => {
    const { read } = fixture({ email: 'private@example.com', org_id: 'private-org', token: 'private-token',
      unknown: { cookie: 'private-cookie' }, user_type: 'private-type', version: 'private-version' });
    const result = await read();
    expect(Object.keys(result).sort()).toEqual(['installed', 'version', 'loggedIn', 'accountType', 'userType',
      'allowByok', 'customProviderAvailable', 'reason'].sort());
    expect(JSON.stringify(result)).not.toContain('private');
    expect(result).toMatchObject({ userType: null, version: null });
  });

  it.each(['not json', 'null'])('handles malformed status: %s', async (stdout) => {
    const result = await fixture({}, async () => ({ stdout })).read();
    expect(result).toMatchObject({ installed: true, loggedIn: false, customProviderAvailable: false,
      reason: 'Qoder 状态返回格式无法识别' });
  });
});
