import { Router } from 'express';
import { resolve, extname, basename } from 'node:path';
import { stat, realpath, readFile } from 'node:fs/promises';
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

async function validateFilePath(rawPath, allowedRoots) {
  // Resolve the input path WITHOUT following symlinks.
  // This is the "link path" — if it lives in allowedRoots, user has
  // legitimate access to click it, even if the symlink target is elsewhere.
  const linkPath = resolve(rawPath);

  const inAllowedRoot = allowedRoots.some(
    (root) => linkPath === root || linkPath.startsWith(root + '/')
  );
  if (!inAllowedRoot) {
    return { error: 'Access denied', status: 403 };
  }

  // Resolve symlinks for the actual file access. The target may live outside
  // allowedRoots (that's the point of symlink support). Sensitive path
  // blacklist still applies to both the link path and the real target.
  let realPath;
  try {
    realPath = await realpath(linkPath);
  } catch {
    return { error: 'File not found', status: 404 };
  }

  if (SENSITIVE_PATTERNS.some((p) => p.test(linkPath) || p.test(realPath))) {
    return { error: 'Access denied', status: 403 };
  }

  let fileStat;
  try {
    fileStat = await stat(realPath);
  } catch {
    return { error: 'File not found', status: 404 };
  }
  if (!fileStat.isFile()) {
    return { error: 'Not a regular file', status: 400 };
  }

  const info = getFileInfo(realPath);
  const limit = getSizeLimit(info);
  if (fileStat.size > limit) {
    return {
      error: `File too large (${(fileStat.size / 1024 / 1024).toFixed(1)}MB, max ${limit / 1024 / 1024}MB)`,
      status: 413,
      info: { ...info, absPath: linkPath, size: fileStat.size },
    };
  }

  // Return the link path (not realPath) as absPath so subsequent calls
  // (content/raw endpoints) use the same identifier. realpath is resolved
  // again inside those endpoints.
  return { ok: true, absPath: linkPath, size: fileStat.size, info };
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

      let absPath = rawPath;
      if (rawPath.startsWith('~')) {
        // ~/foo → $HOME/foo, ~user/foo → /home/user/foo (basic support)
        if (rawPath === '~' || rawPath.startsWith('~/')) {
          absPath = homedir() + rawPath.slice(1);
        }
        // ~user/... not supported, leave as-is (will fail validation)
      } else if (!rawPath.startsWith('/')) {
        const cwd = await getPaneCwd(paneId || '');
        absPath = resolve(cwd, rawPath);
      }

      const result = await validateFilePath(absPath, roots);
      if (result.error) {
        const data = result.info || null;
        return res.status(result.status).json({ success: false, data, error: result.error });
      }

      res.json({
        success: true,
        data: {
          absPath: result.absPath,
          size: result.size,
          ...result.info,
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
