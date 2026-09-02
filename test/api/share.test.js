import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createShareRouter } from '../../server/api/share.js';

const stubStore = {
  list: () => [],
  create: async () => ({ id: 'x', filename: 'f', createdAt: 0, expiresAt: 0 }),
  delete: async () => true,
};

describe('share lan-host endpoint', () => {
  it('reports the machine LAN address so share links are not loopback', async () => {
    const app = express();
    app.use('/api/share', createShareRouter(stubStore));

    const res = await request(app).get('/api/share/lan-host');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const host = res.body.data.host;
    if (host !== null) {
      expect(host).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(host.startsWith('127.')).toBe(false);
    }
  });
});
