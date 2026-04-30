import { Router } from 'express';
import { resolve, extname, basename } from 'node:path';
import { stat, lstat, realpath, readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { createReadStream } from 'node:fs';

const execFileAsync = promisify(execFile);

const SIZE_LIMITS = {
  text: 2 * 1024 * 1024,
  image: 10 * 1024 * 1024,
  pdf: 10 * 1024 * 1024,
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
  '.md': 'text/markdown', '.markdown': 'text/markdown',
};

function getFileInfo(filePath) {
  const ext = extname(filePath).toLowerCase();
  const base = basename(filePath);
  const mimeType = MIME_MAP[ext] || 'text/plain';
  const isImage = mimeType.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';
  const isMarkdown = mimeType === 'text/markdown';
  const isText = !isImage && !isPdf;
  const language = LANG_MAP[ext] || BASENAME_MAP[base] || null;
  return { mimeType, isText, isImage, isPdf, isMarkdown, language };
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
  return SIZE_LIMITS.text;
}

// Resolve a raw path to its link/real form and run shared access checks
// (allowedRoots + sensitive patterns). Returns { linkPath, realPath, stat }
// on success, or an error shape the callers forward verbatim.
async function resolveTarget(rawPath, allowedRoots) {
  const linkPath = resolve(rawPath);

  const inAllowedRoot = allowedRoots.some(
    (root) => linkPath === root || linkPath.startsWith(root + '/')
  );
  if (!inAllowedRoot) {
    return { error: 'Access denied', status: 403 };
  }

  let realPath;
  try {
    realPath = await realpath(linkPath);
  } catch {
    return { error: 'Path not found', status: 404 };
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

async function validateFilePath(rawPath, allowedRoots) {
  const t = await resolveTarget(rawPath, allowedRoots);
  if (t.error) return t;
  if (!t.stat.isFile()) {
    return { error: 'Not a regular file', status: 400 };
  }

  const info = getFileInfo(t.realPath);
  const limit = getSizeLimit(info);
  if (t.stat.size > limit) {
    return {
      error: `File too large (${(t.stat.size / 1024 / 1024).toFixed(1)}MB, max ${limit / 1024 / 1024}MB)`,
      status: 413,
      info: { ...info, absPath: t.linkPath, size: t.stat.size },
    };
  }

  // Return the link path (not realPath) as absPath so subsequent calls
  // (content/raw endpoints) use the same identifier. realpath is resolved
  // again inside those endpoints.
  return { ok: true, absPath: t.linkPath, size: t.stat.size, info };
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
          data: { absPath: target.linkPath, isDirectory: true },
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
          data: { ...info, absPath: target.linkPath, size: target.stat.size },
          error: `File too large (${(target.stat.size / 1024 / 1024).toFixed(1)}MB, max ${limit / 1024 / 1024}MB)`,
        });
      }

      res.json({
        success: true,
        data: {
          absPath: target.linkPath,
          size: target.stat.size,
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

      const content = await readFile(result.absPath, 'utf-8');
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

  router.get('/raw', async (req, res) => {
    try {
      const { path: rawPath } = req.query;
      if (!rawPath) {
        return res.status(400).json({ success: false, data: null, error: 'Missing path parameter' });
      }

      const result = await validateFilePath(rawPath, roots);
      if (result.error) {
        return res.status(result.status).json({ success: false, data: null, error: result.error });
      }

      const filename = basename(result.absPath);
      res.setHeader('Content-Type', result.info.mimeType);
      res.setHeader('Content-Length', result.size);
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      if (result.info.mimeType === 'image/svg+xml') {
        res.setHeader('Content-Security-Policy', 'sandbox');
      }
      createReadStream(result.absPath).pipe(res);
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
