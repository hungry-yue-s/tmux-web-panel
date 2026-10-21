import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createQoderUsageReader } from '../../server/agent-providers/qoder-usage.js';

function fixture(usage, responseType = 'success') {
  const requests = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', 0)); });
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const frame = JSON.parse(String(chunk));
      requests.push(frame);
      const response = frame.request_id === 'quota-read' ? { usage,
        session: { total_credits: 0, model_usage: {} }, token: 'private-token' } : { account: { email: 'private@example.com' } };
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ type: 'control_response',
        response: { request_id: frame.request_id, subtype: responseType, response } })}\n`));
      callback();
    },
    final(callback) { queueMicrotask(() => child.emit('close', 0)); callback(); },
  });
  const spawn = vi.fn(() => child);
  return { requests, spawn, read: createQoderUsageReader({ home: '/test-home', spawn }) };
}

describe('read-only Qoder resource package usage', () => {
  it('queries the observed enterprise bucket without an Agent turn or credentials in output', async () => {
    const { read, requests, spawn } = fixture({ userId: 'private-id', userType: 'teams', expiresAt: 1792684800000,
      totalUsagePercentage: 0, orgResourcePackage: { used: 20000, cap: 20000, remaining: 0,
        percentage: 100, available: false, unit: 'credits' } });
    const result = await read();
    expect(result).toEqual({ status: 'available', installed: true, source: 'qoder-cli', unit: 'credits',
      usedCredits: 20000, totalCredits: 20000, remainingCredits: 0, usedPercent: 100,
      available: false, expiresAt: '2026-10-22T16:00:00.000Z' });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(requests.map((frame) => frame.type)).toEqual(['control_request', 'control_request']);
    expect(requests.map((frame) => frame.request.type)).toEqual(['initialize', 'get_usage_info']);
    const [binary, args, options] = spawn.mock.calls[0];
    expect(binary).toBe('/test-home/.local/bin/qodercli');
    expect(options.cwd).toBe('/test-home');
    expect(args).toEqual(expect.arrayContaining(['--no-session-persistence', '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--tools', '', '--disable-builtin-skills']));
  });

  it.each([null, { userQuota: { used: 10, total: 100 } },
    { orgResourcePackage: { used: 0, cap: 0, remaining: 0, unit: 'credits' } },
    { orgResourcePackage: { used: '20000', cap: 20000, remaining: 0, unit: 'credits' } }])
    ('does not substitute another quota or invent missing numbers: %j', async (usage) => {
      expect(await fixture(usage).read()).toMatchObject({ status: 'unavailable' });
    });

  it('handles rejected control requests without exposing the response', async () => {
    const { read, requests } = fixture({ secret: 'private-secret' }, 'error');
    const result = await read();
    expect(result.status).toBe('unavailable');
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('handles missing binaries gracefully', async () => {
    const spawn = vi.fn(() => { throw Object.assign(new Error('private-path'), { code: 'ENOENT' }); });
    const result = await createQoderUsageReader({ home: '/test-home', spawn })();
    expect(result).toMatchObject({ installed: false, status: 'unavailable' });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('bounds a stuck subprocess and terminates only the owned child', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = vi.fn();
      const read = createQoderUsageReader({ home: '/test-home', spawn: () => child });
      const pending = read();
      await vi.advanceTimersByTimeAsync(16_000);
      expect(await pending).toMatchObject({ status: 'unavailable', reason: 'Qoder 额度查询超时' });
      expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    } finally { vi.useRealTimers(); }
  });
});
