import { Router } from 'express';
import { resolve, extname, basename } from 'node:path';
import { stat, lstat, realpath, readFile, readdir, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { createReadStream } from 'node:fs';
import { getArchiveType, listArchive, MAX_ENTRIES as ARCHIVE_MAX_ENTRIES } from './archive.js';

const execFileAsync = promisify(execFile);
const taskWriteQueues = new Map();
const TASK_MARKER_RE = /^([ \t]*(?:>[ \t]*)*(?:[-+*]|\d+[.)])[ \t]+)\[([ xX])\]/;

function isWithinRoots(target, roots) {
  return roots.some((root) => root === '/' ? target.startsWith('/') : target === root || target.startsWith(root + '/'));
}

function queueTaskWrite(realPath, operation) {
  const queued = (taskWriteQueues.get(realPath) || Promise.resolve())
    .catch(() => {})
    .then(operation);
  taskWriteQueues.set(realPath, queued);
  return queued.finally(() => {
    if (taskWriteQueues.get(realPath) === queued) taskWriteQueues.delete(realPath);
  });
}

function getLineAt(buffer, lineNumber) {
  let start = 0;
  for (let current = 0; current <= lineNumber; current++) {
    const newline = buffer.indexOf(0x0a, start);
    const end = newline === -1 ? buffer.length : newline;
    if (current === lineNumber) {
      const contentEnd = end > start && buffer[end - 1] === 0x0d ? end - 1 : end;
      return { start, line: buffer.subarray(start, contentEnd).toString('utf8') };
    }
    if (newline === -1) return null;
    start = newline + 1;
  }
  return null;
}

const SIZE_LIMITS = {
  text: 2 * 1024 * 1024,
  image: 10 * 1024 * 1024,
  pdf: 10 * 1024 * 1024,
  xlsx: 15 * 1024 * 1024,
  archive: 64 * 1024 * 1024,
};

const SENSITIVE_PATTERNS = [
  /\/\.ssh\//,
  /\/\.gnupg\//,
  /\/\.env$/,
  /\/\.env\./,
  /\/etc\/shadow$/,
  /\/etc\/passwd$/,
  /\/etc\/sudoers/,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
  /id_ed25519/,
];

const LANG_MAP = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.jsx': 'javascript',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.scala': 'scala',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.swift': 'swift', '.m': 'objectivec',
  '.php': 'php', '.lua': 'lua', '.r': 'r', '.R': 'r',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.fish': 'shell',
  '.sql': 'sql', '.graphql': 'graphql',
  '.html': 'html', '.htm': 'html', '.xml': 'xml', '.svg': 'xml',
  '.css': 'css', '.scss': 'scss', '.less': 'less', '.sass': 'scss',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.ini': 'ini', '.cfg': 'ini', '.conf': 'nginx',
  '.md': 'markdown', '.markdown': 'markdown',
  '.dockerfile': 'dockerfile', '.docker': 'dockerfile',
  '.makefile': 'makefile', '.mk': 'makefile',
  '.nginx': 'nginx', '.vim': 'vim', '.el': 'lisp',
  '.zig': 'zig', '.dart': 'dart', '.ex': 'elixir', '.exs': 'elixir',
  '.erl': 'erlang', '.hs': 'haskell', '.ml': 'ocaml',
  '.proto': 'protobuf', '.tf': 'hcl',
};

// Language detection by full filename (for extensionless files)
const BASENAME_MAP = {
  'Makefile': 'makefile', 'makefile': 'makefile', 'GNUmakefile': 'makefile',
  'Dockerfile': 'dockerfile',
  'Vagrantfile': 'ruby', 'Rakefile': 'ruby', 'Gemfile': 'ruby',
  'Jenkinsfile': 'groovy', 'Justfile': 'makefile',
  'CMakeLists.txt': 'cmake',
  '.bashrc': 'bash', '.bash_profile': 'bash', '.bash_aliases': 'bash',
  '.zshrc': 'bash', '.zshenv': 'bash', '.zprofile': 'bash',
  '.profile': 'bash', '.bash_logout': 'bash',
  '.vimrc': 'vim', '.gvimrc': 'vim',
  '.gitconfig': 'ini', '.gitmodules': 'ini',
  '.editorconfig': 'ini', '.npmrc': 'ini',
  '.prettierrc': 'json', '.eslintrc': 'json', '.babelrc': 'json',
};

// Shebang → hljs language
const SHEBANG_MAP = {
  'bash': 'bash', 'sh': 'bash', 'zsh': 'bash', 'fish': 'shell',
  'python': 'python', 'python3': 'python',
  'node': 'javascript', 'nodejs': 'javascript', 'deno': 'typescript',
  'ruby': 'ruby', 'perl': 'perl', 'php': 'php', 'lua': 'lua',
  'Rscript': 'r', 'awk': 'awk', 'sed': 'bash',
};

const MIME_MAP = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.md': 'text/markdown', '.markdown': 'text/markdown',
};

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function getFileInfo(filePath) {
  const ext = extname(filePath).toLowerCase();
  const base = basename(filePath);
  const mimeType = MIME_MAP[ext] || 'text/plain';
  const isImage = mimeType.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';
  const isXlsx = mimeType === XLSX_MIME;
  const isMarkdown = mimeType === 'text/markdown';
  const archiveType = getArchiveType(filePath) || null;
  const isArchive = archiveType !== null;
  const isText = !isImage && !isPdf && !isXlsx && !isArchive;
  const language = LANG_MAP[ext] || BASENAME_MAP[base] || null;
  return { mimeType, isText, isImage, isPdf, isXlsx, isMarkdown, isArchive, archiveType, language };
}

// Detect language from shebang line (e.g. #!/usr/bin/env python3)
function detectShebangLanguage(content) {
  if (!content.startsWith('#!')) return null;
  const firstLine = content.slice(0, content.indexOf('\n'));
  // #!/usr/bin/env python3 → python3
  // #!/bin/bash → bash
  const match = firstLine.match(/(?:\/env\s+|\/)([\w.-]+)\s*$/);
  if (!match) return null;
  const cmd = match[1].replace(/[\d.]+$/, ''); // python3 → python
  return SHEBANG_MAP[cmd] || SHEBANG_MAP[match[1]] || null;
}

function getSizeLimit(info) {
  if (info.isImage) return SIZE_LIMITS.image;
  if (info.isPdf) return SIZE_LIMITS.pdf;
  if (info.isXlsx) return SIZE_LIMITS.xlsx;
  if (info.isArchive) return SIZE_LIMITS.archive;
  return SIZE_LIMITS.text;
}

// Resolve a raw path to its link/real form and run shared access checks
// (allowedRoots + sensitive patterns). Returns { linkPath, realPath, stat }
// on success, or an error shape the callers forward verbatim.
async function resolveTarget(rawPath, allowedRoots) {
  const linkPath = resolve(rawPath);
  const normalizedRoots = allowedRoots.map((root) => resolve(root));

  if (!isWithinRoots(linkPath, normalizedRoots)) {
    return { error: 'Access denied', status: 403 };
  }

  let realPath;
  try {
    realPath = await realpath(linkPath);
  } catch {
    return { error: 'Path not found', status: 404 };
  }

  const realRoots = await Promise.all(normalizedRoots.map(async (root) => {
    try { return await realpath(root); } catch { return root; }
  }));
  if (!isWithinRoots(realPath, realRoots)) {
    return { error: 'Access denied', status: 403 };
  }

  if (SENSITIVE_PATTERNS.some((p) => p.test(linkPath) || p.test(realPath))) {
    return { error: 'Access denied', status: 403 };
  }

  let fileStat;
  try {
    fileStat = await stat(realPath);
  } catch {
    return { error: 'Path not found', status: 404 };
  }
  return { linkPath, realPath, stat: fileStat };
}

async function validateFilePath(rawPath, allowedRoots, { skipSizeLimit = false } = {}) {
  const t = await resolveTarget(rawPath, allowedRoots);
  if (t.error) return t;
  if (!t.stat.isFile()) {
    return { error: 'Not a regular file', status: 400 };
  }

  const info = getFileInfo(t.realPath);
  // The size cap exists to protect endpoints that buffer the file (e.g.
  // /content reads it into a JSON response). /raw streams via createReadStream,
  // so it serves any size — skipping the cap lets downloads of large files work.
  if (!skipSizeLimit) {
    const limit = getSizeLimit(info);
    if (t.stat.size > limit) {
      return {
        error: `File too large (${(t.stat.size / 1024 / 1024).toFixed(1)}MB, max ${limit / 1024 / 1024}MB)`,
        status: 413,
        info: { ...info, absPath: t.linkPath, size: t.stat.size },
      };
    }
  }

  // Keep the link path as the UI identifier while internal I/O uses the
  // canonical path that already passed the real-root validation above.
  return { ok: true, absPath: t.linkPath, realPath: t.realPath, size: t.stat.size, info };
}

async function validateDirPath(rawPath, allowedRoots) {
  const t = await resolveTarget(rawPath, allowedRoots);
  if (t.error) return t;
  if (!t.stat.isDirectory()) {
    return { error: 'Not a directory', status: 400 };
  }
  return { ok: true, absPath: t.linkPath, realPath: t.realPath };
}

function parentWithinRoots(absPath, roots) {
  if (absPath === '/') return null;
  const parent = absPath.replace(/\/[^/]+$/, '') || '/';
  const inRoot = roots.some(
    (root) => parent === root || parent.startsWith(root + '/')
  );
  return inRoot ? parent : null;
}

async function resolveInputPath(rawPath, paneId) {
  if (rawPath.startsWith('~')) {
    if (rawPath === '~' || rawPath.startsWith('~/')) {
      return homedir() + rawPath.slice(1);
    }
    return rawPath;
  }
  if (!rawPath.startsWith('/')) {
    const cwd = await getPaneCwd(paneId || '');
    return resolve(cwd, rawPath);
  }
  return rawPath;
}

async function getPaneCwd(paneId) {
  if (!paneId || !/^%\d+$/.test(paneId)) return homedir();
  try {
    const { stdout } = await execFileAsync('tmux', [
      'display-message', '-p', '-t', paneId, '#{pane_current_path}',
    ]);
    const cwd = stdout.trim();
    if (cwd) return cwd;
  } catch { /* ignore */ }
  return homedir();
}

export function createFilesRouter(allowedRoots) {
  const router = Router();
  const roots = allowedRoots && allowedRoots.length > 0
    ? allowedRoots
    : [homedir()];

  router.get('/info', async (req, res) => {
    try {
      const { path: rawPath, paneId } = req.query;
      if (!rawPath) {
        return res.status(400).json({ success: false, data: null, error: 'Missing path parameter' });
      }

      const absPath = await resolveInputPath(rawPath, paneId);

      const target = await resolveTarget(absPath, roots);
      if (target.error) {
        return res.status(target.status).json({ success: false, data: null, error: target.error });
      }

      if (target.stat.isDirectory()) {
        return res.json({
          success: true,
          data: {
            absPath: target.linkPath,
            isDirectory: true,
            size: target.stat.size,
            mtimeMs: target.stat.mtimeMs,
          },
          error: null,
        });
      }

      if (!target.stat.isFile()) {
        return res.status(400).json({ success: false, data: null, error: 'Not a regular file' });
      }

      const info = getFileInfo(target.realPath);
      const limit = getSizeLimit(info);
      if (target.stat.size > limit) {
        return res.status(413).json({
          success: false,
          data: {
            ...info,
            absPath: target.linkPath,
            size: target.stat.size,
            mtimeMs: target.stat.mtimeMs,
          },
          error: `File too large (${(target.stat.size / 1024 / 1024).toFixed(1)}MB, max ${limit / 1024 / 1024}MB)`,
        });
      }

      res.json({
        success: true,
        data: {
          absPath: target.linkPath,
          size: target.stat.size,
          mtimeMs: target.stat.mtimeMs,
          ...info,
        },
        error: null,
      });
    } catch (err) {
      res.status(500).json({ success: false, data: null, error: err.message });
    }
  });

  router.get('/list', async (req, res) => {
    try {
      const { path: rawPath, paneId } = req.query;
      if (!rawPath) {
        return res.status(400).json({ success: false, data: null, error: 'Missing path parameter' });
      }

      const absPath = await resolveInputPath(rawPath, paneId);
      const result = await validateDirPath(absPath, roots);
      if (result.error) {
        return res.status(result.status).json({ success: false, data: null, error: result.error });
      }

      const MAX_ENTRIES = 2000;
      let names;
      try {
        names = await readdir(result.realPath);
      } catch (err) {
        return res.status(500).json({ success: false, data: null, error: 'Cannot read directory: ' + err.message });
      }
      const truncated = names.length > MAX_ENTRIES;
      const limited = truncated ? names.slice(0, MAX_ENTRIES) : names;

      const entries = await Promise.all(limited.map(async (name) => {
        const entryPath = result.realPath + '/' + name;
        try {
          const ls = await lstat(entryPath);
          let type = 'other';
          let size = 0;
          let targetType = null;
          if (ls.isSymbolicLink()) {
            type = 'symlink';
            try {
              const st = await stat(entryPath);
              if (st.isDirectory()) targetType = 'dir';
              else if (st.isFile()) { targetType = 'file'; size = st.size; }
              else targetType = 'other';
            } catch {
              targetType = 'broken';
            }
          } else if (ls.isDirectory()) {
            type = 'dir';
          } else if (ls.isFile()) {
            type = 'file';
            size = ls.size;
          }
          return {
            name,
            type,
            targetType,
            size,
            mtime: ls.mtimeMs,
            isHidden: name.startsWith('.'),
          };
        } catch {
          return {
            name,
            type: 'other',
            targetType: null,
            size: 0,
            mtime: 0,
            isHidden: name.startsWith('.'),
            unreadable: true,
          };
        }
      }));

      entries.sort((a, b) => {
        const aDir = a.type === 'dir' || a.targetType === 'dir';
        const bDir = b.type === 'dir' || b.targetType === 'dir';
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

      res.json({
        success: true,
        data: {
          absPath: result.absPath,
          parent: parentWithinRoots(result.absPath, roots),
          entries,
          truncated,
          totalCount: names.length,
        },
        error: null,
      });
    } catch (err) {
      res.status(500).json({ success: false, data: null, error: err.message });
    }
  });

  router.get('/archive', async (req, res) => {
    try {
      const { path: rawPath } = req.query;
      if (!rawPath) {
        return res.status(400).json({ success: false, data: null, error: 'Missing path parameter' });
      }

      const result = await validateFilePath(rawPath, roots);
      if (result.error) {
        return res.status(result.status).json({ success: false, data: null, error: result.error });
      }
      if (!result.info.isArchive) {
        return res.status(400).json({ success: false, data: null, error: 'Not an archive' });
      }

      let entries;
      try {
        entries = await listArchive(result.realPath, result.info.archiveType);
      } catch (err) {
        return res.status(415).json({ success: false, data: null, error: err.message });
      }

      const truncated = entries.length >= ARCHIVE_MAX_ENTRIES;
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

      res.json({
        success: true,
        data: {
          absPath: result.absPath,
          archiveType: result.info.archiveType,
          entries,
          truncated,
          totalCount: entries.length,
        },
        error: null,
      });
    } catch (err) {
      res.status(500).json({ success: false, data: null, error: err.message });
    }
  });

  router.get('/content', async (req, res) => {
    try {
      const { path: rawPath } = req.query;
      if (!rawPath) {
        return res.status(400).json({ success: false, data: null, error: 'Missing path parameter' });
      }

      const result = await validateFilePath(rawPath, roots);
      if (result.error) {
        return res.status(result.status).json({ success: false, data: null, error: result.error });
      }

      if (!result.info.isText) {
        return res.status(400).json({ success: false, data: null, error: 'Use /raw endpoint for binary files' });
      }

      const content = await readFile(result.realPath, 'utf-8');
      const language = result.info.language || detectShebangLanguage(content);
      res.json({
        success: true,
        data: {
          content,
          language,
          mimeType: result.info.mimeType,
          isMarkdown: result.info.isMarkdown,
        },
        error: null,
      });
    } catch (err) {
      res.status(500).json({ success: false, data: null, error: err.message });
    }
  });

  router.patch('/markdown-task', async (req, res) => {
    try {
      const {
        path: rawPath,
        line,
        checked,
        expectedLine,
        expectedMtimeMs,
        expectedSize,
      } = req.body || {};
      if (
        typeof rawPath !== 'string' || !rawPath.startsWith('/')
        || !Number.isInteger(line) || line < 0
        || typeof checked !== 'boolean'
        || typeof expectedLine !== 'string' || /[\r\n]/.test(expectedLine)
        || typeof expectedMtimeMs !== 'number' || !Number.isFinite(expectedMtimeMs)
        || !Number.isInteger(expectedSize) || expectedSize < 0
      ) {
        return res.status(400).json({ success: false, data: null, error: 'invalid_markdown_task_request' });
      }

      const result = await validateFilePath(rawPath, roots);
      if (result.error) {
        return res.status(result.status).json({ success: false, data: null, error: result.error });
      }
      if (!result.info.isMarkdown) {
        return res.status(400).json({ success: false, data: null, error: 'not_markdown' });
      }

      const outcome = await queueTaskWrite(result.realPath, async () => {
        let handle;
        try {
          handle = await open(result.realPath, 'r+');
          const current = await handle.stat();
          if (current.size > SIZE_LIMITS.text) return { tooLarge: true };
          if (current.mtimeMs !== expectedMtimeMs || current.size !== expectedSize) return { conflict: true };

          const buffer = Buffer.alloc(current.size);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead !== buffer.length) throw new Error('short_file_read');
          const targetLine = getLineAt(buffer, line);
          if (!targetLine || targetLine.line !== expectedLine) return { conflict: true };

          const marker = TASK_MARKER_RE.exec(targetLine.line);
          if (!marker) return { invalidTask: true };
          const markerIndex = marker[1].length + 1;
          const markerOffset = targetLine.start + Buffer.byteLength(targetLine.line.slice(0, markerIndex), 'utf8');
          const nextMarker = checked ? 0x78 : 0x20;
          if (buffer[markerOffset] !== nextMarker) {
            const { bytesWritten } = await handle.write(Buffer.from([nextMarker]), 0, 1, markerOffset);
            if (bytesWritten !== 1) throw new Error('short_task_write');
            await handle.sync();
          }
          const updated = await handle.stat();
          return { mtimeMs: updated.mtimeMs, size: updated.size };
        } finally {
          if (handle) await handle.close();
        }
      });

      if (outcome.tooLarge) {
        return res.status(413).json({ success: false, data: null, error: 'File too large' });
      }
      if (outcome.conflict) {
        return res.status(409).json({ success: false, data: null, error: 'markdown_task_conflict' });
      }
      if (outcome.invalidTask) {
        return res.status(400).json({ success: false, data: null, error: 'not_markdown_task' });
      }
      return res.json({
        success: true,
        data: { absPath: result.absPath, line, checked, mtimeMs: outcome.mtimeMs, size: outcome.size },
        error: null,
      });
    } catch (err) {
      return res.status(500).json({ success: false, data: null, error: err.message });
    }
  });

  router.get('/raw', async (req, res) => {
    try {
      const { path: rawPath, download } = req.query;
      if (!rawPath) {
        return res.status(400).json({ success: false, data: null, error: 'Missing path parameter' });
      }

      const result = await validateFilePath(rawPath, roots, { skipSizeLimit: true });
      if (result.error) {
        return res.status(result.status).json({ success: false, data: null, error: result.error });
      }

      const filename = basename(result.absPath);
      const disposition = download ? 'attachment' : 'inline';
      // RFC 5987: ASCII-safe filename in `filename=`, full UTF-8 in `filename*=`
      const asciiName = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '\\"');
      const utf8Name = encodeURIComponent(filename);
      res.setHeader('Content-Type', result.info.mimeType);
      res.setHeader('Content-Length', result.size);
      res.setHeader(
        'Content-Disposition',
        `${disposition}; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
      );
      if (result.info.mimeType === 'image/svg+xml') {
        res.setHeader('Content-Security-Policy', 'sandbox');
      }
      createReadStream(result.realPath).pipe(res);
    } catch (err) {
      res.status(500).json({ success: false, data: null, error: err.message });
    }
  });

  // Read tmux paste buffer and clean it into a file path
  router.get('/tmux-buffer', async (_req, res) => {
    try {
      const { stdout } = await execFileAsync('tmux', ['show-buffer'], { timeout: 3000 });
      const raw = stdout.trim();
      if (!raw) {
        return res.json({ success: true, data: { raw: '', path: '' }, error: null });
      }
      // Join lines, trim whitespace per line, strip :line:col suffix
      let path = raw.split('\n').map((l) => l.trim()).filter(Boolean).join('');
      path = path.replace(/:\d+(?::\d+)?$/, '');
      path = path.replace(/\(\d+(?:,\d+)?\)$/, '');
      res.json({ success: true, data: { raw, path }, error: null });
    } catch {
      res.json({ success: true, data: { raw: '', path: '' }, error: null });
    }
  });

  return router;
}
