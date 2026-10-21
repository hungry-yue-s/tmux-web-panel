import { describe, expect, it, vi } from 'vitest';
import { createEnterpriseAiService } from '../../server/agent-providers/enterprise-ai.js';

function fixture() {
  const readAliLang = vi.fn(async () => ({ installed: true, reason: '阿里郎签名桥未接入' }));
  const readTokenSwitch = vi.fn(async () => ({ installed: true, loggedIn: true, models: [] }));
  const readQoder = vi.fn(async () => ({ customProviderAvailable: false, allowByok: 0 }));
  const readQoderUsage = vi.fn(async () => ({ status: 'available', source: 'qoder-cli',
    usedCredits: 20000, totalCredits: 20000, remainingCredits: 0, usedPercent: 100,
    expiresAt: '2026-10-22T16:00:00.000Z' }));
  const execFile = vi.fn(async () => ({ stdout: '' }));
  const relay = {
    preview: vi.fn(async () => ({ dryRun: true, prepared: false })),
    prepare: vi.fn(async () => ({ prepared: true })),
  };
  return { readAliLang, readTokenSwitch, readQoder, readQoderUsage, execFile, relay, platform: 'darwin' };
}

describe('enterprise AI integration', () => {
  it('keeps live Qoder credits separate from the unconnected group pool and caches reads', async () => {
    const options = fixture();
    const service = createEnterpriseAiService(options);
    const result = await service.status();
    expect(result.pools[0]).toMatchObject({ id: 'qoder-ide', status: 'available', usage: {
      totalCredits: 20000, remainingCredits: 0, resetsAt: 1792684800,
    } });
    expect(result.pools[1]).toMatchObject({ id: 'enterprise', status: 'unavailable', reason: '阿里郎签名桥未接入' });
    expect(result.pools[1].usage).toBeUndefined();
    await service.status();
    expect(options.readQoderUsage).toHaveBeenCalledTimes(1);
    expect(options.execFile).not.toHaveBeenCalled();
  });

  it('does not start hidden data sources or a Qoder session when disabled', async () => {
    const options = fixture();
    const service = createEnterpriseAiService(options);
    expect(await service.status({ claude: false, codex: false })).toBeNull();
    expect(options.readTokenSwitch).not.toHaveBeenCalled();
    const result = await service.status({ claude: true, codex: false });
    expect(options.readQoder).not.toHaveBeenCalled();
    expect(options.readQoderUsage).not.toHaveBeenCalled();
    expect(result.pools.map((p) => p.id)).toEqual(['enterprise']);
  });

  it('uses the already authenticated AliLang Qoder quota when its CLI is unavailable', async () => {
    const options = fixture();
    options.readQoderUsage.mockResolvedValue({ status: 'unavailable', reason: 'CLI 未安装' });
    options.readAliLang.mockResolvedValue({ installed: true, pools: [{ id: 'qoder-ide', status: 'available',
      usage: { usedCredits: 12, totalCredits: 100, remainingCredits: 88 } }] });
    const result = await createEnterpriseAiService(options).status();
    expect(result.pools[0]).toMatchObject({ status: 'available', usage: { remainingCredits: 88 } });
    expect(result.pools[0].reason).toBeUndefined();
  });

  it('opens only known native applications with fixed arguments and keeps relay previews read-only', async () => {
    const options = fixture();
    const service = createEnterpriseAiService(options);
    await expect(service.openApp('tokenswitch')).resolves.toEqual({ app: 'tokenswitch', opened: true });
    expect(options.execFile.mock.calls[0].slice(0, 2)).toEqual(['open', ['-a', '/Applications/Token Switch.app']]);
    await expect(service.openApp('../../bin/sh')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.openApp('__proto__')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.previewClaudeRelay()).resolves.toEqual({ dryRun: true, prepared: false });
    expect(options.relay.prepare).not.toHaveBeenCalled();
    expect(options.execFile).toHaveBeenCalledTimes(1);
  });
});
