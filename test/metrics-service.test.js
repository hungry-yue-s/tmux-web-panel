import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  DARWIN_PROBE,
  LINUX_PROBE,
  SCHEMA_VERSION,
  collectRemoteMetrics,
  normalizeProbe,
  parseProbeOutput,
} from '../server/metrics/ssh-collector.js';
import { MetricsService, FAILURE_CACHE_MS, SAMPLE_MIN_INTERVAL_MS } from '../server/metrics/service.js';
import { ServerState } from '../server/servers/health-service.js';
import { AppError, ErrorCode } from '../server/servers/errors.js';
import { LOCAL_SERVER_ID } from '../server/servers/registry.js';

function probeLine(overrides = {}) {
  return JSON.stringify({
    schema: SCHEMA_VERSION,
    platform: 'linux',
    cpuPercent: 18.4,
    cpuCount: 8,
    mem: '17179869184 9234179686 2147483648',
    load: '3.41 2.10 1.05',
    uptime: 86400,
    disk: '499963174912 299963174912',
    ...overrides,
  });
}

describe('probe scripts', () => {
  it('are read-only and never install or start anything', () => {
    for (const script of [LINUX_PROBE, DARWIN_PROBE]) {
      expect(script).not.toMatch(/apt|yum|dnf|brew|pacman|npm i|pip install|curl |wget /);
      expect(script).not.toMatch(/tmux (new-session|start-server|kill)/);
      expect(script).not.toMatch(/>\s*\/(?!dev\/null)/); // no writes except /dev/null
      expect(script).not.toMatch(/rm |mv |chmod |chown /);
    }
  });

  it('prints byte counts with %.0f so large machines are not truncated', () => {
    // %d in several awk builds is 32-bit and would cap at 2147483647.
    for (const script of [LINUX_PROBE, DARWIN_PROBE]) {
      const awkPrintfs = script.match(/printf "[^"]*"/g) || [];
      const byteFormats = awkPrintfs.filter((p) => p.includes('%d'));
      expect(byteFormats).toEqual([]);
    }
  });

  it('sums only the first eight cpu fields and counts iowait as idle', () => {
    // guest and guest_nice are already included in user and nice.
    expect(LINUX_PROBE).toContain('t=$2+$3+$4+$5+$6+$7+$8+$9');
    expect(LINUX_PROBE).toContain('i=$5+$6');
  });

  it('does not return a hostname that would need escaping', () => {
    for (const script of [LINUX_PROBE, DARWIN_PROBE]) {
      expect(script).not.toContain('"hostname"');
    }
  });
});

describe('parseProbeOutput', () => {
  it('finds the schema line past a login banner', () => {
    const stdout = ['Welcome to Ubuntu', 'Last login: yesterday', probeLine(), ''].join('\n');
    expect(parseProbeOutput(stdout).platform).toBe('linux');
  });

  it('takes the last matching line', () => {
    const stdout = [probeLine({ cpuPercent: 1 }), probeLine({ cpuPercent: 2 })].join('\n');
    expect(parseProbeOutput(stdout).cpuPercent).toBe(2);
  });

  it('ignores json without our schema', () => {
    expect(() => parseProbeOutput('{"schema":99,"platform":"linux"}')).toThrow(/no usable data/);
  });

  it('rejects empty and oversized output', () => {
    expect(() => parseProbeOutput('')).toThrow(/no usable data/);
    expect(() => parseProbeOutput('x'.repeat(70_000))).toThrow(/too much output/);
  });
});

describe('normalizeProbe', () => {
  it('normalizes a healthy linux sample', () => {
    const result = normalizeProbe(JSON.parse(probeLine()));

    expect(result).toMatchObject({
      platform: 'linux',
      cpuPercent: 18.4,
      cpuCount: 8,
      memTotal: 17179869184,
      memUsed: 9234179686,
      uptime: 86400,
    });
    expect(result.memPercent).toBeCloseTo(53.7, 1);
    expect(result.disk).toMatchObject({ total: 499963174912, used: 299963174912 });
    expect(result.availability).toMatchObject({ cpu: 'available', memory: 'available', disk: 'available' });
  });

  it('handles a machine with more than 2 GiB of memory and disk', () => {
    const result = normalizeProbe(JSON.parse(probeLine({
      mem: '412316860416 137438953472 8589934592',
      disk: '8796093022208 4398046511104',
    })));

    // A 32-bit truncation would have shown 2147483647 here.
    expect(result.memTotal).toBe(412316860416);
    expect(result.memUsed).toBe(137438953472);
    expect(result.disk.total).toBe(8796093022208);
    expect(result.memPercent).toBeCloseTo(33.3, 1);
  });

  it('rejects an unknown platform rather than guessing', () => {
    expect(() => normalizeProbe({ schema: 1, platform: 'sunos' })).toThrow(/unknown platform/);
    expect(() => normalizeProbe(null)).toThrow(/unknown platform/);
  });

  it('degrades unreadable fields to null instead of zero', () => {
    const result = normalizeProbe(JSON.parse(probeLine({
      cpuPercent: null,
      mem: 'null null null',
      load: 'null null null',
      disk: 'null null',
      uptime: null,
      cpuCount: null,
    })));

    expect(result.cpuPercent).toBeNull();
    expect(result.memPercent).toBeNull();
    expect(result.disk).toBeNull();
    expect(result.load1).toBeNull();
    expect(result.uptime).toBeNull();
    expect(result.availability).toMatchObject({
      cpu: 'unavailable', memory: 'unavailable', disk: 'unavailable', load: 'unavailable',
    });
  });

  it('rejects negative and absurd capacities', () => {
    const result = normalizeProbe(JSON.parse(probeLine({
      mem: '-1 -5 -9',
      disk: '-100 -50',
      uptime: -3,
      cpuCount: -2,
    })));

    expect(result.memTotal).toBeNull();
    expect(result.disk).toBeNull();
    expect(result.uptime).toBeNull();
    expect(result.cpuCount).toBeNull();
  });

  it('clamps percentages into 0..100', () => {
    expect(normalizeProbe(JSON.parse(probeLine({ cpuPercent: 250 }))).cpuPercent).toBe(100);
    expect(normalizeProbe(JSON.parse(probeLine({ cpuPercent: -12 }))).cpuPercent).toBe(0);
  });

  it('discards a used value larger than the total', () => {
    const result = normalizeProbe(JSON.parse(probeLine({ mem: '1000 5000 0' })));
    expect(result.memUsed).toBeNull();
    expect(result.memPercent).toBeNull();
  });

  it('ignores non-numeric junk', () => {
    const result = normalizeProbe(JSON.parse(probeLine({ cpuPercent: 'lots', mem: 'a b c' })));
    expect(result.cpuPercent).toBeNull();
    expect(result.memTotal).toBeNull();
  });
});

describe('collectRemoteMetrics', () => {
  it('runs the platform probe over stdin', async () => {
    const executor = { runScript: vi.fn(async () => ({ stdout: probeLine(), stderr: '' })) };
    const result = await collectRemoteMetrics(executor, 'linux');

    expect(executor.runScript).toHaveBeenCalledWith(LINUX_PROBE, expect.any(Object));
    expect(result.platform).toBe('linux');
  });

  it('returns null for a platform we have no probe for', async () => {
    const executor = { runScript: vi.fn() };
    await expect(collectRemoteMetrics(executor, 'windows')).resolves.toBeNull();
    expect(executor.runScript).not.toHaveBeenCalled();
  });
});

describe('MetricsService', () => {
  let registry;
  let health;
  let pool;
  let now;
  let runScript;
  let service;
  let statusState;
  let metricsAvailable;

  beforeEach(() => {
    now = 1_000_000;
    statusState = ServerState.ONLINE;
    metricsAvailable = true;
    runScript = vi.fn(async () => ({ stdout: probeLine(), stderr: '' }));
    registry = {
      require: vi.fn((id) => {
        if (id !== 'api-linux' && id !== LOCAL_SERVER_ID) {
          throw new AppError(ErrorCode.SERVER_NOT_FOUND, 'nope');
        }
        return { id };
      }),
      has: vi.fn(() => true),
    };
    health = {
      getStatus: vi.fn(() => ({
        state: statusState,
        facts: { platform: 'linux' },
        capabilities: { metrics: { available: metricsAvailable, level: 'basic' } },
      })),
    };
    pool = { get: vi.fn(() => ({ runScript })) };
    service = new MetricsService({ registry, pool, health, now: () => now });
  });

  it('requires its dependencies', () => {
    expect(() => new MetricsService({ pool, health })).toThrow(/registry/);
    expect(() => new MetricsService({ registry, health })).toThrow(/pool/);
    expect(() => new MetricsService({ registry, pool })).toThrow(/health/);
  });

  it('samples a remote server and caches within the interval', async () => {
    const first = await service.current('api-linux');
    const second = await service.current('api-linux');

    expect(first.cpuPercent).toBe(18.4);
    expect(second).toBe(first);
    expect(runScript).toHaveBeenCalledTimes(1);
  });

  it('resamples after the interval', async () => {
    await service.current('api-linux');
    now += SAMPLE_MIN_INTERVAL_MS + 1;
    await service.current('api-linux');
    expect(runScript).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight probe across concurrent callers', async () => {
    const results = await Promise.all([
      service.current('api-linux'),
      service.current('api-linux'),
      service.current('api-linux'),
    ]);
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(results[0]).toBe(results[2]);
  });

  describe('failure handling', () => {
    it('caches a failure briefly so widgets cannot cause a connection storm', async () => {
      runScript.mockRejectedValue(new AppError(ErrorCode.SSH_TIMEOUT, 'timed out'));

      const first = await service.current('api-linux');
      for (let i = 0; i < 5; i += 1) await service.current('api-linux');

      expect(runScript).toHaveBeenCalledTimes(1);
      expect(first.sampledAt).toBeNull();
      expect(first.reason).toBe(ErrorCode.SSH_TIMEOUT);
      expect(first.cpuPercent).toBeNull();
    });

    it('retries once the failure cache expires', async () => {
      runScript.mockRejectedValue(new AppError(ErrorCode.SSH_TIMEOUT, 'timed out'));
      await service.current('api-linux');

      now += FAILURE_CACHE_MS + 1;
      await service.current('api-linux');

      expect(runScript).toHaveBeenCalledTimes(2);
    });

    it('keeps the last good sample alongside the failure', async () => {
      const good = await service.current('api-linux');
      now += SAMPLE_MIN_INTERVAL_MS + 1;
      runScript.mockRejectedValue(new AppError(ErrorCode.SERVER_OFFLINE, 'gone'));

      const failed = await service.current('api-linux');

      expect(failed.sampledAt).toBeNull();
      expect(failed.last.cpuPercent).toBe(good.cpuPercent);
      expect(failed.last.sampledAt).toBe(good.sampledAt);
    });

    it('does not write a failure into history', async () => {
      await service.current('api-linux');
      now += SAMPLE_MIN_INTERVAL_MS + 1;
      runScript.mockRejectedValue(new AppError(ErrorCode.SERVER_OFFLINE, 'gone'));
      await service.current('api-linux');

      expect(service.history('api-linux').points).toHaveLength(1);
    });

    it('reports unsupported without opening a connection', async () => {
      metricsAvailable = false;
      const result = await service.current('api-linux');

      expect(runScript).not.toHaveBeenCalled();
      expect(result.reason).toBe('unsupported_platform');
      expect(result.availability.cpu).toBe('unsupported');
    });

    it('reports offline when the server is not reachable', async () => {
      metricsAvailable = false;
      statusState = ServerState.OFFLINE;
      expect((await service.current('api-linux')).reason).toBe('server_offline');
    });

    it('reports a disabled server without probing', async () => {
      statusState = ServerState.DISABLED;
      expect((await service.current('api-linux')).reason).toBe('server_disabled');
      expect(runScript).not.toHaveBeenCalled();
    });

    it('degrades a throwing local collector instead of rejecting', async () => {
      const local = new MetricsService({
        registry,
        pool,
        health,
        now: () => now,
        localCollector: async () => { throw new Error('ps failed'); },
      });

      const result = await local.current(LOCAL_SERVER_ID);

      expect(result.sampledAt).toBeNull();
      expect(result.reason).toBe(ErrorCode.INTERNAL);
      expect(result.error.code).toBe(ErrorCode.INTERNAL);
    });

    it('reports a missing local collector', async () => {
      expect((await service.current(LOCAL_SERVER_ID)).reason).toBe('no_local_collector');
    });
  });

  describe('unavailable versus unsupported', () => {
    it('marks a timeout as unavailable, not unsupported', async () => {
      runScript.mockRejectedValue(new AppError(ErrorCode.SSH_TIMEOUT, 'timed out'));
      const result = await service.current('api-linux');

      expect(result.availability).toMatchObject({
        cpu: 'unavailable', memory: 'unavailable', disk: 'unavailable', load: 'unavailable',
      });
    });

    it('marks an offline server as unavailable', async () => {
      metricsAvailable = false;
      statusState = ServerState.OFFLINE;
      expect((await service.current('api-linux')).availability.cpu).toBe('unavailable');
    });

    it('marks an auth failure as unavailable', async () => {
      runScript.mockRejectedValue(new AppError(ErrorCode.SSH_AUTH_REQUIRED, 'denied'));
      expect((await service.current('api-linux')).availability.memory).toBe('unavailable');
    });

    it('marks a disabled server as unavailable', async () => {
      statusState = ServerState.DISABLED;
      expect((await service.current('api-linux')).availability.cpu).toBe('unavailable');
    });

    it('marks an unsupported platform as unsupported', async () => {
      metricsAvailable = false;
      const result = await service.current('api-linux');

      expect(result.reason).toBe('unsupported_platform');
      expect(result.availability).toMatchObject({
        cpu: 'unsupported', memory: 'unsupported', disk: 'unsupported',
      });
    });

    it('marks a missing local collector as unsupported', async () => {
      expect((await service.current(LOCAL_SERVER_ID)).availability.cpu).toBe('unsupported');
    });

    it('keeps process detail unsupported in both cases', async () => {
      runScript.mockRejectedValue(new AppError(ErrorCode.SSH_TIMEOUT, 'nope'));
      const failed = await service.current('api-linux');
      expect(failed.availability.processes).toBe('unsupported');
      expect(failed.availability.diskIo).toBe('unsupported');
      expect(failed.availability.swap).toBe('unsupported');
    });

    it('still preserves the last good sample when unavailable', async () => {
      const good = await service.current('api-linux');
      now += SAMPLE_MIN_INTERVAL_MS + 1;
      runScript.mockRejectedValue(new AppError(ErrorCode.SSH_TIMEOUT, 'nope'));

      const failed = await service.current('api-linux');

      expect(failed.availability.cpu).toBe('unavailable');
      expect(failed.last.cpuPercent).toBe(good.cpuPercent);
    });
  });

  describe('deletion races', () => {
    it('does not repopulate the cache when the server was forgotten mid-sample', async () => {
      let release;
      runScript.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

      const inFlight = service.current('api-linux');
      service.forget('api-linux');
      release({ stdout: probeLine(), stderr: '' });
      await inFlight;

      expect(service._cache.has('api-linux')).toBe(false);
      expect(service.history('api-linux').points).toEqual([]);
    });

    it('does not repopulate history for a server removed from the registry', async () => {
      let release;
      runScript.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

      const inFlight = service.current('api-linux');
      registry.has.mockReturnValue(false);
      release({ stdout: probeLine(), stderr: '' });
      await inFlight;

      expect(service._cache.has('api-linux')).toBe(false);
    });

    it('forget clears cache and history', async () => {
      await service.current('api-linux');
      expect(service.history('api-linux').points).toHaveLength(1);

      service.forget('api-linux');

      expect(service.history('api-linux').points).toEqual([]);
    });
  });

  describe('history', () => {
    it('keeps points per server', async () => {
      await service.current('api-linux');
      now += SAMPLE_MIN_INTERVAL_MS + 1;
      await service.current('api-linux');

      const history = service.history('api-linux');
      expect(history.points).toHaveLength(2);
      expect(history.persisted).toBe(false);
      expect(service.history(LOCAL_SERVER_ID).points).toEqual([]);
    });

    it('clamps the requested window', () => {
      expect(service.history('api-linux', { windowSeconds: 1 }).windowSeconds).toBe(10);
      expect(service.history('api-linux', { windowSeconds: 99999 }).windowSeconds).toBe(3600);
      expect(service.history('api-linux', { windowSeconds: 'abc' }).windowSeconds).toBe(300);
    });

    it('drops points outside the window', async () => {
      await service.current('api-linux');
      now += 400_000;

      expect(service.history('api-linux', { windowSeconds: 60 }).points).toEqual([]);
    });

    it('rejects an unknown server', () => {
      expect(() => service.history('ghost')).toThrow(expect.objectContaining({ code: ErrorCode.SERVER_NOT_FOUND }));
    });
  });

  describe('drilldown', () => {
    it('marks remote process detail unsupported rather than erroring', async () => {
      const result = await service.drilldown('api-linux');
      expect(result).toMatchObject({
        partial: true,
        procs: [],
        availability: { processes: 'unsupported' },
        reason: 'remote_process_drilldown_unsupported',
      });
    });

    it('delegates locally when a collector is installed', async () => {
      service.setLocalDrilldown(async () => ({ procs: [{ pid: 1, comm: 'init' }] }));
      const result = await service.drilldown(LOCAL_SERVER_ID);
      expect(result.procs).toHaveLength(1);
    });
  });

  it('never mixes two servers', async () => {
    registry.require.mockImplementation((id) => ({ id }));
    runScript
      .mockResolvedValueOnce({ stdout: probeLine({ cpuPercent: 11 }), stderr: '' })
      .mockResolvedValueOnce({ stdout: probeLine({ cpuPercent: 77 }), stderr: '' });

    const a = await service.current('api-linux');
    const b = await service.current('build-mac');

    expect(a.cpuPercent).toBe(11);
    expect(b.cpuPercent).toBe(77);
    expect(service.history('api-linux').points).toHaveLength(1);
    expect(service.history('build-mac').points).toHaveLength(1);
  });
});
