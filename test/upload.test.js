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
