import { describe, it, expect } from 'vitest';
import { parseSsOutput, filterPortsForPid } from '../server/ports.js';

describe('parseSsOutput', () => {
  it('returns empty array for empty input', () => {
    expect(parseSsOutput('')).toEqual([]);
    expect(parseSsOutput(null)).toEqual([]);
    expect(parseSsOutput(undefined)).toEqual([]);
  });

  it('parses a single listening port with pid', () => {
    const output = `Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
tcp   LISTEN 0      128    0.0.0.0:3000       0.0.0.0:*         users:(("node",pid=1234,fd=12))`;
    const result = parseSsOutput(output);
    expect(result).toEqual([{ port: 3000, pid: 1234 }]);
  });

  it('parses multiple ports', () => {
    const output = `Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
tcp   LISTEN 0      128    0.0.0.0:3000       0.0.0.0:*         users:(("node",pid=1234,fd=12))
tcp   LISTEN 0      128    0.0.0.0:8080       0.0.0.0:*         users:(("python",pid=5678,fd=5))`;
    const result = parseSsOutput(output);
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining([
      { port: 3000, pid: 1234 },
      { port: 8080, pid: 5678 },
    ]));
  });

  it('excludes ports <= 1024', () => {
    const output = `Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
tcp   LISTEN 0      128    0.0.0.0:80         0.0.0.0:*         users:(("nginx",pid=100,fd=3))
tcp   LISTEN 0      128    0.0.0.0:1024       0.0.0.0:*         users:(("daemon",pid=101,fd=4))
tcp   LISTEN 0      128    0.0.0.0:1025       0.0.0.0:*         users:(("app",pid=102,fd=5))`;
    const result = parseSsOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].port).toBe(1025);
  });

  it('excludes ports > 65535', () => {
    const output = `Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
tcp   LISTEN 0      128    0.0.0.0:65535      0.0.0.0:*         users:(("app",pid=200,fd=5))
tcp   LISTEN 0      128    0.0.0.0:65536      0.0.0.0:*         users:(("bad",pid=201,fd=6))`;
    const result = parseSsOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].port).toBe(65535);
  });

  it('skips lines without pid', () => {
    const output = `Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
tcp   LISTEN 0      128    0.0.0.0:3000       0.0.0.0:*         `;
    const result = parseSsOutput(output);
    expect(result).toEqual([]);
  });

  it('handles IPv6 format [::]:port', () => {
    const output = `Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
tcp   LISTEN 0      128    [::]:4000           [::]:*             users:(("node",pid=9999,fd=7))`;
    const result = parseSsOutput(output);
    expect(result).toEqual([{ port: 4000, pid: 9999 }]);
  });

  it('handles *:port format', () => {
    const output = `Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
tcp   LISTEN 0      128    *:5000             *:*               users:(("ruby",pid=7777,fd=8))`;
    const result = parseSsOutput(output);
    expect(result).toEqual([{ port: 5000, pid: 7777 }]);
  });
});

describe('filterPortsForPid', () => {
  it('returns empty array when no ports match pid or descendants', () => {
    const allPorts = [
      { port: 3000, pid: 1234 },
      { port: 8080, pid: 5678 },
    ];
    const result = filterPortsForPid(allPorts, 9999, new Set());
    expect(result).toEqual([]);
  });

  it('returns ports owned directly by the pid', () => {
    const allPorts = [
      { port: 3000, pid: 1234 },
      { port: 8080, pid: 5678 },
    ];
    const result = filterPortsForPid(allPorts, 1234, new Set());
    expect(result).toEqual([3000]);
  });

  it('returns ports owned by descendant pids', () => {
    const allPorts = [
      { port: 3000, pid: 100 },
      { port: 4000, pid: 200 },
      { port: 5000, pid: 300 },
    ];
    const result = filterPortsForPid(allPorts, 50, new Set([200, 300]));
    expect(result).toEqual(expect.arrayContaining([4000, 5000]));
    expect(result).toHaveLength(2);
  });

  it('returns ports owned by both pid and descendants', () => {
    const allPorts = [
      { port: 3000, pid: 1234 },
      { port: 4000, pid: 5678 },
    ];
    const result = filterPortsForPid(allPorts, 1234, new Set([5678]));
    expect(result).toEqual(expect.arrayContaining([3000, 4000]));
    expect(result).toHaveLength(2);
  });

  it('handles empty allPorts', () => {
    const result = filterPortsForPid([], 1234, new Set([5678]));
    expect(result).toEqual([]);
  });

  it('deduplicates ports if same port appears multiple times for same pid', () => {
    const allPorts = [
      { port: 3000, pid: 1234 },
      { port: 3000, pid: 1234 },
    ];
    const result = filterPortsForPid(allPorts, 1234, new Set());
    expect(result).toEqual([3000]);
  });
});
