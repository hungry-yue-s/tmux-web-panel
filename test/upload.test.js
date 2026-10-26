import { describe, it, expect } from 'vitest';
import { sanitizeFilename } from '../server/api/upload.js';

describe('sanitizeFilename', () => {
  it('preserves normal filenames', () => {
    expect(sanitizeFilename('photo.png')).toBe('photo.png');
  });

  it('strips path separators', () => {
    expect(sanitizeFilename('../../../etc/passwd')).toBe('etcpasswd');
  });

  it('strips control characters', () => {
    expect(sanitizeFilename('file\x00name.txt')).toBe('filename.txt');
  });

  it('returns fallback for empty result', () => {
    expect(sanitizeFilename('///')).toBe('upload');
  });

  it('handles filenames with spaces', () => {
    expect(sanitizeFilename('my file.png')).toBe('my file.png');
  });

  it('strips backslashes (Windows paths)', () => {
    expect(sanitizeFilename('C:\\Users\\test\\photo.png')).toBe('C:Userstestphoto.png');
  });
});

describe('createUploadRouter', () => {
  it('reports the stored file through displayPath', async () => {
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createUploadRouter } = await import('../server/api/upload.js');

    const dir = mkdtempSync(join(tmpdir(), 'upload-test-'));
    try {
      const app = express();
      app.use('/api/upload', createUploadRouter(dir, { displayPath: (path) => `shown:${path}` }));
      const res = await request(app).post('/api/upload').attach('file', Buffer.from('hello'), 'a.txt');

      expect(res.status).toBe(200);
      expect(res.body.data.path).toMatch(/^shown:/);
      expect(readFileSync(res.body.data.path.slice('shown:'.length), 'utf8')).toBe('hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
