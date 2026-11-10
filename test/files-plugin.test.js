import { describe, expect, it, vi } from 'vitest';
import { apply } from '../plugins/files/index.js';

function fakeContext() {
  return {
    http: { mount: vi.fn() },
    logger: { warn: vi.fn() },
    provide: vi.fn(),
    inject: vi.fn(),
  };
}

describe('the files plugin', () => {
  it('says where the upload directory went instead of ignoring the old key', () => {
    const ctx = fakeContext();
    apply(ctx, { roots: ['/srv'], uploadDir: '/data/uploads' });
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('upload plugin'));
    expect(ctx.provide).toHaveBeenCalledWith('fileAccess', expect.objectContaining({ roots: ['/srv'] }));

    const quiet = fakeContext();
    apply(quiet, { roots: ['/srv'] });
    expect(quiet.logger.warn).not.toHaveBeenCalled();
  });
});
