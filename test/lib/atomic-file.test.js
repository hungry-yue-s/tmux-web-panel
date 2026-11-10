import { describe, expect, it, vi } from 'vitest';
import { replaceFile } from '../../lib/atomic-file.js';

function failing(codes) {
  const queue = [...codes];
  return vi.fn(async () => {
    const code = queue.shift();
    if (code) throw Object.assign(new Error(code), { code });
  });
}

describe('replacing a file', () => {
  it('retries on Windows while the destination is briefly held open', async () => {
    const renameFile = failing(['EPERM', 'EBUSY', 'EACCES']);
    await replaceFile('a.tmp', 'a', { platform: 'win32', renameFile });
    expect(renameFile).toHaveBeenCalledTimes(4);
  });

  it('gives up on Windows after the retry window', async () => {
    const renameFile = failing(Array(1000).fill('EPERM'));
    await expect(replaceFile('a.tmp', 'a', { platform: 'win32', retryForMs: 50, renameFile })).rejects.toMatchObject({ code: 'EPERM' });
  });

  it('fails at once for other errors and on other platforms', async () => {
    const missing = failing(['ENOENT']);
    await expect(replaceFile('a.tmp', 'a', { platform: 'win32', renameFile: missing })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(missing).toHaveBeenCalledTimes(1);
    const linux = failing(['EPERM']);
    await expect(replaceFile('a.tmp', 'a', { platform: 'linux', renameFile: linux })).rejects.toMatchObject({ code: 'EPERM' });
    expect(linux).toHaveBeenCalledTimes(1);
  });
});
