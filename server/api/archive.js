import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';

const execFileAsync = promisify(execFile);

export const MAX_ENTRIES = 2000;
// Cap how much of an archive we buffer when listing. Previews are for casual
// inspection; huge archives would otherwise pin too much memory per request.
export const ARCHIVE_READ_LIMIT = 64 * 1024 * 1024;

const EXT_TYPE = {
  '.zip': 'zip', '.jar': 'zip', '.apk': 'zip', '.aar': 'zip',
  '.epub': 'zip', '.docx': 'zip', '.pptx': 'zip',
  '.tar': 'tar',
  '.tgz': 'targz', '.gz': 'gz',
  '.bz2': 'bz2', '.xz': 'xz', '.zst': 'zst', '.lz4': 'unsupported',
  '.rar': 'unsupported', '.7z': 'unsupported',
};

// Compound extensions that extname() alone cannot capture.
const COMPOUND = [
  ['.tar.gz', 'targz'], ['.tar.bz2', 'tarbz2'], ['.tar.xz', 'tarxz'],
  ['.tar.zst', 'tarzst'], ['.tbz2', 'tarbz2'], ['.tbz', 'tarbz2'],
  ['.txz', 'tarxz'], ['.tzst', 'tarzst'],
];

export function getArchiveType(filePath) {
  const lower = filePath.toLowerCase();
  for (const [ext, type] of COMPOUND) {
    if (lower.endsWith(ext)) return type;
  }
  const ext = lower.slice(lower.lastIndexOf('.'));
  return EXT_TYPE[ext] || null;
}

export function isArchivePath(filePath) {
  const t = getArchiveType(filePath);
  return t !== null && t !== undefined;
}

function dosDateTimeToDate(time, date) {
  const sec = (time & 0x1f) * 2;
  const min = (time >> 5) & 0x3f;
  const hour = (time >> 11) & 0x1f;
  const day = date & 0x1f;
  const month = ((date >> 5) & 0x0f) - 1;
  const year = ((date >> 9) & 0x7f) + 1980;
  if (year <= 1980 && month <= 0 && day <= 1) return 0;
  return Date.UTC(year, month, day, hour, min, sec);
}

function readZipEntries(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  // Locate the End Of Central Directory record scanning from the tail.
  const scanStart = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= scanStart; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Not a valid zip archive');

  let count = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);

  // Zip64: fall back to the Zip64 EOCD record when fields are saturated.
  if (count === 0xffff || cdOffset === 0xffffffff) {
    if (eocd >= 20 && view.getUint32(eocd - 20, true) === 0x07064b50) {
      const z64 = eocd - 20;
      count = Number(view.getBigUint64(z64 + 32, true));
      cdOffset = Number(view.getBigUint64(z64 + 48, true));
    }
  }

  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < count && p + 46 <= buffer.length; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const compMethod = view.getUint16(p + 10, true);
    const time = view.getUint16(p + 12, true);
    const date = view.getUint16(p + 14, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    const isDir = name.endsWith('/');
    entries.push({
      name: name.replace(/\/+$/, ''),
      size: isDir ? 0 : size,
      isDir,
      mtime: dosDateTimeToDate(time, date),
      compressed: compMethod !== 0,
    });
    p += 46 + nameLen + extraLen + commentLen;
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
}

function parseOctal(buffer, start, len) {
  const s = buffer.toString('latin1', start, start + len).replace(/\0.*$/, '').trim();
  if (!s) return 0;
  const v = parseInt(s, 8);
  return Number.isFinite(v) ? v : 0;
}

function readTarEntries(buffer) {
  const entries = [];
  let offset = 0;
  let pendingLongName = null;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    // A block of zeros marks the end of the archive.
    if (header.every((b) => b === 0)) break;

    let name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const size = parseOctal(header, 124, 12);
    const mtime = parseOctal(header, 136, 12) * 1000;
    const type = String.fromCharCode(header[156] || 48);
    const magic = header.toString('latin1', 257, 263);

    offset += 512;
    const dataBlocks = Math.ceil(size / 512) * 512;

    if (type === 'L' || type === 'K') {
      const long = buffer.toString('utf8', offset, offset + size).replace(/\0.*$/, '');
      if (type === 'L') pendingLongName = long;
      offset += dataBlocks;
      continue;
    }
    if (type === 'x' || type === 'g') { offset += dataBlocks; continue; }

    if (pendingLongName) { name = pendingLongName; pendingLongName = null; }
    else if (magic.startsWith('ustar') && prefix) name = prefix + '/' + name;

    const isDir = type === '5' || name.endsWith('/');
    const clean = name.replace(/^\.?\//, '').replace(/\/+$/, '');
    if (clean) {
      entries.push({
        name: clean,
        size: isDir ? 0 : size,
        isDir,
        mtime,
        compressed: false,
      });
    }
    offset += dataBlocks;
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
}

async function listViaSystemTar(absPath) {
  const { stdout } = await execFileAsync('tar', ['-tf', absPath], {
    timeout: 8000, maxBuffer: 8 * 1024 * 1024,
  });
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    const isDir = line.endsWith('/');
    const name = line.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!name || name === '.') continue;
    entries.push({ name, size: 0, isDir, mtime: 0, compressed: false });
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
}

export async function listArchive(absPath, type) {
  if (type === 'unsupported') {
    const err = new Error('该压缩格式暂不支持预览');
    err.code = 'UNSUPPORTED_ARCHIVE';
    throw err;
  }

  if (type === 'tarbz2' || type === 'tarxz' || type === 'tarzst') {
    return listViaSystemTar(absPath);
  }

  const buffer = await readFile(absPath);
  if (buffer.length > ARCHIVE_READ_LIMIT) {
    const err = new Error('压缩包过大，无法预览');
    err.code = 'ARCHIVE_TOO_LARGE';
    throw err;
  }

  if (type === 'zip') return readZipEntries(buffer);

  if (type === 'tar') return readTarEntries(buffer);

  if (type === 'targz') {
    const raw = gunzipSync(buffer);
    return readTarEntries(raw);
  }

  if (type === 'gz') {
    const raw = gunzipSync(buffer);
    return [{
      name: basename(absPath).replace(/\.gz$/i, '') || 'uncompressed',
      size: raw.length,
      isDir: false,
      mtime: 0,
      compressed: true,
    }];
  }

  if (type === 'bz2' || type === 'xz' || type === 'zst') {
    return listViaSystemTar(absPath);
  }

  const err = new Error('该压缩格式暂不支持预览');
  err.code = 'UNSUPPORTED_ARCHIVE';
  throw err;
}
