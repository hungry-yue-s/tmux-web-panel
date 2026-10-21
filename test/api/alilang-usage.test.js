import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAliLangUsageReader } from '../../server/agent-providers/alilang-usage.js';

const roots = [];
const NOW = Date.parse('2026-10-15T09:00:00Z');
const session = { token: 'private-session-token', ownerId: 'private-employee' };
const DEVICE_UUID = '00000000-0000-0000-0000-000000000001';

function certificateSubject(employee = session.ownerId, device = DEVICE_UUID) {
  const title = Buffer.from(`${employee}|MDMSERVER${device}|user`);
  return Buffer.concat([Buffer.from('060355040c0c', 'hex'), Buffer.from([title.length]), title]).toString('hex');
}

async function fixture(installed = true) {
  const home = await mkdtemp(join(tmpdir(), 'tmux-alilang-usage-'));
  roots.push(home);
  const appPath = join(home, 'AliLang.app');
  if (installed) {
    await mkdir(join(appPath, 'Contents'), { recursive: true });
    await writeFile(join(appPath, 'Contents', 'Info.plist'),
      '<plist><dict><key>CFBundleShortVersionString</key><string>6.35.11</string></dict></plist>');
  }
  return { home, appPath, platform: 'darwin', now: () => NOW };
}

function response(items = [], cycle = {}) {
  const enterprise = { success: true, data: { items, ...cycle }, accessToken: 'private-outer-token' };
  const qoder = { success: true, data: { qoderTotalQuota: 20000, qoderUsedQuota: 20000,
    cycleStartDate: '2026-09-23', cycleEndDate: '2026-10-22', account: 'private-account' } };
  return `${JSON.stringify(enterprise)}\nTMUX_ALILANG_RESULT:enterprise:200\n`
    + `${JSON.stringify(qoder)}\nTMUX_ALILANG_RESULT:qoder-ide:200\n`;
}

function commands(output = response(), curl = null) {
  return vi.fn(async (file, args, options) => {
    if (file === '/usr/bin/security' && args[0] === 'find-identity') {
      return { stdout: `1) ${'A'.repeat(40)} "private-client-identity"\n1 valid identities found` };
    }
    if (file === '/usr/bin/security' && args[0] === 'find-certificate') {
      return { stdout: `    "issu"<blob>=0x416C6962616261 "Alibaba Client CA"\n"subj"<blob>=0x${certificateSubject()}\nprivate-public-metadata` };
    }
    if (file === '/usr/sbin/ioreg') return { stdout: `"IOPlatformUUID" = "${DEVICE_UUID}"` };
    if (file === '/usr/bin/curl') return curl ? curl(options) : { stdout: output };
    throw new Error('Unexpected command');
  });
}

function integer(value) {
  const bytes = [];
  do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value = Math.floor(value / 128); } while (value);
  return Buffer.from(bytes);
}

function localKey(name, origin = 'file://') {
  return Buffer.from(`_${origin}\0\x01${name}`);
}

function encoded(value) { return Buffer.concat([Buffer.from([1]), Buffer.from(value)]); }

function block(rows) {
  const entries = rows.map(([key, value]) => Buffer.concat([integer(0), integer(key.length), integer(value.length), key, value]));
  const restarts = Buffer.alloc(8);
  restarts.writeUInt32LE(1, 4);
  return Buffer.concat([...entries, restarts]);
}

function compressed(bytes) {
  if (bytes.length < 60) return Buffer.concat([integer(bytes.length), Buffer.from([(bytes.length - 1) << 2]), bytes]);
  const length = Buffer.alloc(2);
  length.writeUInt16LE(bytes.length - 1);
  return Buffer.concat([integer(bytes.length), Buffer.from([61 << 2]), length, bytes]);
}

function table(rows) {
  const data = compressed(block(rows.map(([key, value, sequence]) => {
    const suffix = Buffer.alloc(8);
    suffix.writeBigUInt64LE((BigInt(sequence) << 8n) | 1n);
    return [Buffer.concat([key, suffix]), value];
  })));
  const indexOffset = data.length + 5;
  const index = block([[Buffer.from('last'), Buffer.concat([integer(0), integer(data.length)])]]);
  const footer = Buffer.alloc(48);
  Buffer.concat([integer(0), integer(0), integer(indexOffset), integer(index.length)]).copy(footer);
  footer.writeBigUInt64LE(0xdb4775248b80fb57n, 40);
  return Buffer.concat([data, Buffer.from([1, 0, 0, 0, 0]), index, Buffer.alloc(5), footer]);
}

function wal(sequence, rows) {
  const header = Buffer.alloc(12);
  header.writeBigUInt64LE(BigInt(sequence));
  header.writeUInt32LE(rows.length, 8);
  const body = Buffer.concat([header, ...rows.map(([key, value]) => Buffer.concat([
    Buffer.from([value === null ? 0 : 1]), integer(key.length), key,
    ...(value === null ? [] : [integer(value.length), value]),
  ]))]);
  const physical = Buffer.alloc(7);
  physical.writeUInt16LE(body.length, 4);
  physical[6] = 1;
  return Buffer.concat([physical, body]);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AliLang direct quota reader', () => {
  it('does not start any system process before a visible caller reads it, or create a missing application', async () => {
    const options = await fixture(false), runCommand = commands();
    const read = createAliLangUsageReader({ ...options, runCommand });
    expect(runCommand).not.toHaveBeenCalled();
    await expect(read()).resolves.toMatchObject({ installed: false, version: null, status: 'unavailable', pools: [] });
    expect(runCommand).not.toHaveBeenCalled();
    expect(await readdir(options.home)).toEqual([]);
  });

  it('preserves independent credits, supported apps and package categories, without leaking login material', async () => {
    const options = await fixture();
    const items = [
      { teamName: 'AI生产力计划', cycleUsedAmount: 0.57, cycleAmountLimit: 6000, appNames: ['Codex', 'Claude Code'],
        modeConfigList: [{ modeName: 'Auto', accessToken: 'private-mode-token' }], account: 'private-member' },
      ...[7500, 1000, 10000].map((amount) => ({ teamName: `资源包 ${amount}`, cycleUsedAmount: 0, cycleAmountLimit: amount })),
      { teamName: '活动钱包', chargeType: 'wallet', cycleUsedAmount: 2, cycleAmountLimit: 500, appCodes: ['OpenCode'] },
      { teamName: '免费资源', chargeType: 'free', cycleUsedAmount: 0, cycleAmountLimit: 999999 },
    ];
    const runCommand = commands(response(items));
    const result = await createAliLangUsageReader({ ...options, runCommand, readSession: async () => session })();
    expect(result).toMatchObject({ installed: true, version: '6.35.11', status: 'available' });
    const [enterprise, qoder] = result.pools;
    expect(enterprise).toMatchObject({ id: 'enterprise', status: 'available', applications: ['Codex', 'Claude Code', 'OpenCode'],
      usage: { unit: 'credits', totalCredits: 24500, usedCredits: 0.57, remainingCredits: 24499.43,
        periodStart: '2026-09-23', periodEnd: '2026-10-22', periodSource: 'interface-rule',
        resetsAt: Date.parse('2026-10-23T00:00:00+08:00') / 1000 } });
    expect(enterprise.packages[0]).toMatchObject({ applications: ['Codex', 'Claude Code'], models: ['Auto'] });
    expect(enterprise.packages[4].category).toBe('activity');
    expect(qoder.usage).toMatchObject({ totalCredits: 20000, usedCredits: 20000, remainingCredits: 0, periodSource: 'api' });
    expect(JSON.stringify(result)).not.toMatch(/private-|accessToken|ownerId|identity|account/);
    const [file, args, command] = runCommand.mock.calls.find(([file]) => file === '/usr/bin/curl');
    expect(file).toBe('/usr/bin/curl');
    expect(args).toEqual(['-q', '--verbose', '--config', '-']);
    expect(command.timeout).toBeGreaterThan(2 * 15000);
    expect(command.env.CURL_SSL_BACKEND).toBe('secure-transport');
    expect(command.input).toContain('accessToken=private-session-token');
    expect(command.input).toContain('/tokenhub/packs.json?');
    expect(command.input).toContain('/sm/qoder/quota/usage.json?');
    expect(command.input).not.toMatch(/insecure|location|apply\.json|alilang\.sock|BEGIN.*KEY/);
    expect(runCommand.mock.calls.filter(([, args]) => args[0] === 'find-certificate').every(([, args]) => !args.includes('-p'))).toBe(true);
  });

  it('uses the China cycle boundary at the 23rd rather than a UTC calendar month', async () => {
    const options = await fixture();
    const runCommand = commands(response([{ teamName: '周期', cycleUsedAmount: 0, cycleAmountLimit: 10 }]));
    const read = createAliLangUsageReader({ ...options, now: () => Date.parse('2026-01-22T15:59:59Z'),
      runCommand, readSession: async () => session });
    expect((await read()).pools[0].usage).toMatchObject({ periodStart: '2025-12-23', periodEnd: '2026-01-22',
      resetsAt: Date.parse('2026-01-22T16:00:00Z') / 1000 });
  });

  it('preserves overuse and uses an upstream category before the wallet fallback', async () => {
    const options = await fixture();
    const items = [
      { teamName: '超用包', cycleUsedAmount: 12, cycleAmountLimit: 10 },
      { teamName: '明确生产力', category: 'default', chargeType: 'wallet', cycleUsedAmount: 4, cycleAmountLimit: 10 },
      { teamName: '钱包活动', chargeType: 'wallet', cycleUsedAmount: 100, cycleAmountLimit: 100 },
      { teamName: '独立分类', category: 'other', cycleUsedAmount: 500, cycleAmountLimit: 500 },
    ];
    const result = await createAliLangUsageReader({ ...options, runCommand: commands(response(items)), readSession: async () => session })();
    expect(result.pools[0].usage).toMatchObject({ usedCredits: 16, totalCredits: 20, remainingCredits: 4 });
    expect(result.pools[0].packages[0].usage).toMatchObject({ usedCredits: 12, totalCredits: 10, remainingCredits: 0, usedPercent: 120 });
    expect(result.pools[0].packages.map((entry) => entry.category)).toEqual(['default', 'default', 'activity', 'other']);
  });

  it('prefers explicit API periods and avoids implying a shared cycle for differently dated packages', async () => {
    const options = await fixture();
    const item = { teamName: '服务端周期', cycleUsedAmount: 2, cycleAmountLimit: 10,
      cycleStartDate: '2026-10-01', cycleEndDate: '2026-10-31' };
    const single = await createAliLangUsageReader({ ...options, runCommand: commands(response([item])), readSession: async () => session })();
    expect(single.pools[0].usage).toMatchObject({ periodStart: '2026-10-01', periodEnd: '2026-10-31', periodSource: 'api',
      resetsAt: Date.parse('2026-11-01T00:00:00+08:00') / 1000 });
    const envelope = await createAliLangUsageReader({ ...options,
      runCommand: commands(response([{ teamName: '顶层周期', cycleUsedAmount: 1, cycleAmountLimit: 10 }],
        { cycleStartDate: '2026-10-01', cycleEndDate: '2026-10-31' })), readSession: async () => session })();
    expect(envelope.pools[0].usage).toMatchObject({ periodStart: '2026-10-01', periodEnd: '2026-10-31', periodSource: 'api' });
    const mixed = await createAliLangUsageReader({ ...options,
      runCommand: commands(response([item, { ...item, cycleStartDate: '2026-09-23', cycleEndDate: '2026-10-22' }])),
      readSession: async () => session })();
    expect(mixed.pools[0].usage).toMatchObject({ periodStart: null, periodEnd: null, resetsAt: null, periodSource: 'mixed' });
  });

  it('keeps missing quota unknown and a zero denominator without a fabricated zero percent', async () => {
    const options = await fixture();
    const missing = await createAliLangUsageReader({ ...options,
      runCommand: commands(response([{ teamName: '尚无统计', appNames: ['Codex'] }])), readSession: async () => session })();
    expect(missing.pools[0].usage).toBeNull();
    expect(missing.pools[0].packages[0].usage).toBeNull();
    const zero = await createAliLangUsageReader({ ...options,
      runCommand: commands(response([{ teamName: '零额度', cycleUsedAmount: 0, cycleAmountLimit: 0 }])), readSession: async () => session })();
    expect(zero.pools[0].usage).toMatchObject({ totalCredits: 0, usedCredits: 0, usedPercent: null });
  });

  it('does not call an undiagnosed process timeout an authorization failure, and waits for manual retry', async () => {
    const options = await fixture();
    let calls = 0;
    const runCommand = commands('', async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('private-session-token sensitive diagnostics'), { killed: true, signal: 'SIGKILL' });
      return { stdout: response() };
    });
    const read = createAliLangUsageReader({ ...options, runCommand, readSession: async () => session });
    const result = await read();
    expect(result).toMatchObject({ installed: true, status: 'unavailable', manualRetryRequired: true });
    expect(result.reason).toContain('尚未获得完整连接诊断');
    expect(result.pools.every((pool) => pool.usage === null)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(await read()).toEqual(result);
    expect(calls).toBe(1);
    expect((await read.retry()).status).toBe('available');
    expect(calls).toBe(2);
  });

  it('deduplicates concurrent reads and does not retry a missing eligible identity automatically', async () => {
    const options = await fixture();
    const runCommand = vi.fn(async () => ({ stdout: '0 valid identities found' }));
    const read = createAliLangUsageReader({ ...options, runCommand, readSession: async () => session });
    const results = await Promise.all([read(), read()]);
    expect(results[0].status).toBe('identity-unavailable');
    expect(results[1]).toEqual(results[0]);
    await read();
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('selects an employee and device bound identity instead of an unrelated Alibaba SSL identity', async () => {
    const options = await fixture();
    const base = commands();
    const identities = ['foreign-employee', 'other-device', 'bound-identity', 'later-bound-identity'];
    const runCommand = vi.fn(async (file, args, config) => {
      if (file === '/usr/bin/security' && args[0] === 'find-identity') {
        expect(args).toEqual(['find-identity', '-p', 'basic']);
        return { stdout: identities.map((name, index) => `${index + 1}) ${'A'.repeat(40)} "${name}"`).join('\n') };
      }
      if (file === '/usr/bin/security' && args[0] === 'find-certificate') {
        const title = args[2] === 'foreign-employee' ? certificateSubject('other-employee')
          : args[2] === 'other-device' ? certificateSubject(session.ownerId, '00000000-0000-0000-0000-000000000002') : certificateSubject();
        return { stdout: `"issu"<blob>=0x416C6962616261\n"subj"<blob>=0x${title}` };
      }
      return base(file, args, config);
    });
    const result = await createAliLangUsageReader({ ...options, runCommand, readSession: async () => session })();
    expect(result.status).toBe('available');
    const config = runCommand.mock.calls.find(([file]) => file === '/usr/bin/curl')[2].input;
    expect(config).toContain('cert = "bound-identity"');
    expect(config).not.toMatch(/foreign-employee|other-device|later-bound/);
    expect(runCommand.mock.calls.filter(([, args]) => args[0] === 'find-certificate')).toHaveLength(3);
  });

  it('reports the observed mTLS failure without exposing the HTML or fabricating quota values', async () => {
    const options = await fixture();
    const runCommand = commands('<title>400 No required SSL certificate was sent</title>private-session-token\nTMUX_ALILANG_RESULT:enterprise:400\n');
    const result = await createAliLangUsageReader({ ...options, runCommand, readSession: async () => session })();
    expect(result).toMatchObject({ status: 'needs-authorization', manualRetryRequired: true });
    expect(result.pools[0]).toMatchObject({ status: 'needs-authorization', usage: null });
    expect(JSON.stringify(result)).not.toMatch(/private-|totalCredits/);
  });

  it('retains a completed quota when a later transfer fails, with safe per-request TLS diagnostics', async () => {
    const options = await fixture();
    const first = JSON.stringify({ success: true, data: { items: [{ teamName: '已读取', cycleUsedAmount: 12, cycleAmountLimit: 100 }] } });
    const runCommand = commands('', async () => { throw Object.assign(new Error('private-session-token'), {
      code: 28,
      stdout: `${first}\nTMUX_ALILANG_RESULT:enterprise:200:0:0.001:0.02:0.1:0.2:0.2\n`
        + '\nTMUX_ALILANG_RESULT:qoder-ide:000:28:0.001:0.02:0:0:15\n',
      stderr: 'Client certificate: private-client-identity',
    }); });
    const read = createAliLangUsageReader({ ...options, runCommand, readSession: async () => session });
    const result = await read();
    expect(result).toMatchObject({ status: 'available', manualRetryRequired: true });
    expect(result.pools[0].usage).toMatchObject({ usedCredits: 12, remainingCredits: 88 });
    expect(result.pools[1]).toMatchObject({ status: 'unavailable', stage: 'tls', usage: null });
    expect(result.pools[1].reason).toContain('建立 TLS 连接超时');
    expect(result.diagnostics[1]).toMatchObject({ id: 'qoder-ide', stage: 'tls', httpStatus: 0, exitCode: 28, tcp: 0.02 });
    expect(JSON.stringify(result)).not.toContain('private-');
    await read();
    expect(runCommand.mock.calls.filter(([file]) => file === '/usr/bin/curl')).toHaveLength(1);
  });

  it('distinguishes server certificate validation from client identity access failures', async () => {
    const options = await fixture();
    const read = createAliLangUsageReader({ ...options, readSession: async () => session,
      runCommand: commands('', async () => { throw Object.assign(new Error('private'), { code: 60 }); }) });
    const result = await read();
    expect(result.status).toBe('unavailable');
    expect(result.pools[0]).toMatchObject({ stage: 'server-certificate', status: 'unavailable' });
    expect(result.reason).toContain('服务端证书验证失败');
    expect(result.reason).not.toContain('访问授权');
  });

  it('reads the latest local LevelDB session from compressed tables and WAL, without writing the app store', async () => {
    const options = await fixture();
    const directory = join(options.home, 'Library', 'Application Support', 'AliLang', 'Local Storage', 'leveldb');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '000001.ldb'), table([
      [localKey('KEY_ACCESS_TOKEN'), encoded('stale-token'), 4],
      [localKey('KEY_WORK_ID'), encoded('current-employee'), 8],
    ]));
    await writeFile(join(directory, '000002.log'), wal(10, [
      [localKey('KEY_ACCESS_TOKEN'), encoded('current-token')],
      [localKey('KEY_ACCESS_TOKEN', 'https://untrusted.test'), encoded('untrusted-token')],
    ]));
    const runCommand = commands();
    const original = runCommand.getMockImplementation();
    runCommand.mockImplementation((file, args, options) => file === '/usr/bin/security' && args[0] === 'find-certificate'
      ? Promise.resolve({ stdout: `"issu"<blob>=0x416C6962616261\n"subj"<blob>=0x${certificateSubject('current-employee')}` })
      : original(file, args, options));
    const result = await createAliLangUsageReader({ ...options, runCommand })();
    expect(result.status).toBe('available');
    const config = runCommand.mock.calls.find(([file]) => file === '/usr/bin/curl')[2].input;
    expect(config).toContain('accessToken=current-token');
    expect(config).toContain('ownerId=current-employee');
    expect(config).not.toMatch(/stale-token|untrusted-token/);
    expect(await readdir(directory)).toEqual(['000001.ldb', '000002.log']);
  });

  it('honors a newer session deletion and never sends an old token to the network', async () => {
    const options = await fixture();
    const directory = join(options.home, 'Library', 'Application Support', 'AliLang', 'Local Storage', 'leveldb');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '000001.ldb'), table([
      [localKey('KEY_ACCESS_TOKEN'), encoded('deleted-token'), 4],
      [localKey('KEY_WORK_ID'), encoded('employee'), 8],
    ]));
    await writeFile(join(directory, '000002.log'), wal(10, [[localKey('KEY_ACCESS_TOKEN'), null]]));
    const runCommand = commands();
    const result = await createAliLangUsageReader({ ...options, runCommand })();
    expect(result).toMatchObject({ installed: true, status: 'login-required', pools: [] });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('rejects malformed session material before any system authorization request', async () => {
    const options = await fixture(), runCommand = commands();
    const result = await createAliLangUsageReader({ ...options, runCommand,
      readSession: async () => ({ ...session, token: 'token\ncertificate = other' }) })();
    expect(result.status).toBe('login-required');
    expect(runCommand).not.toHaveBeenCalled();
  });
});
