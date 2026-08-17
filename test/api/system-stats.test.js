import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import systemStatsRouter, { getNetworkAddresses, getPrimaryAddress } from '../../server/api/system-stats.js';

describe('system network addresses', () => {
  it('keeps external addresses, preferring IPv4 order', () => {
    const result = getNetworkAddresses({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en1: [{ address: 'fe80::1', family: 'IPv6', internal: false }],
      en0: [{ address: '30.166.3.252', family: 'IPv4', internal: false }],
    });

    expect(result).toEqual([
      { interface: 'en0', address: '30.166.3.252', family: 'IPv4' },
      { interface: 'en1', address: 'fe80::1', family: 'IPv6' },
    ]);
  });

  it('prefers a physical IPv4 interface over bridges and tunnels', () => {
    const primary = getPrimaryAddress([
      { interface: 'bridge100', address: '192.168.64.1', family: 'IPv4' },
      { interface: 'en0', address: '30.166.3.252', family: 'IPv4' },
      { interface: 'utun4', address: '30.43.181.196', family: 'IPv4' },
    ]);

    expect(primary).toEqual({
      interface: 'en0', address: '30.166.3.252', family: 'IPv4',
    });
  });

  it('exposes the machine IP and interface list', async () => {
    const app = express();
    app.use('/api/system-stats', systemStatsRouter);
    const res = await request(app).get('/api/system-stats');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('ip');
    expect(res.body.data).toHaveProperty('ipInterface');
    expect(res.body.data.memUsed).toBeLessThanOrEqual(res.body.data.memTotal);
    expect(res.body.data).toHaveProperty('memCached');
    expect(res.body.data).toHaveProperty('memMetric');
    expect(Array.isArray(res.body.data.networkAddresses)).toBe(true);
    for (const item of res.body.data.networkAddresses) {
      expect(item).toEqual(expect.objectContaining({
        interface: expect.any(String),
        address: expect.any(String),
        family: expect.stringMatching(/^IPv[46]$/),
      }));
    }
  });
});
