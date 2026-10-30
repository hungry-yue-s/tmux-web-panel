import { Router } from 'express';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { IS_WINDOWS, toPosixPath } from '../msys.js';
import { requireSameOrigin } from './same-origin.js';

// The git block: status, diffs, line staging, history and commits for the
// repository that contains a path the panel can already preview. Every git
// call runs on this machine; other machines get the same API through /n/.

const READ_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 32 * 1024 * 1024;
const MAX_DIFF_FOR_MESSAGE = 60 * 1024;
const LOG_LIMIT_MAX = 1000;

class GitError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Runs git and resolves its stdout; `allowExit` lists non-zero codes that still count as success. */
export function runGit(cwd, args, { input = null, allowExit = [], timeout = READ_TIMEOUT_MS, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--literal-pathspecs', '-c', 'core.quotepath=off', ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', ...env },
      windowsHide: true,
    });
    const out = [];
    const err = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) child.kill();
      else out.push(chunk);
    });
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new GitError(error.code === 'ENOENT' ? 'git_not_installed' : error.message, 500));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      if (code === 0 || allowExit.includes(code)) return resolve(stdout);
      const message = Buffer.concat(err).toString('utf8').trim() || `git exited with ${code}`;
      reject(new GitError(message, 400));
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Parses `git status --porcelain=v1 -b -z`. */
export function parseStatus(output) {
  const parts = output.split('\0');
  const result = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false, files: [] };
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    if (entry.startsWith('## ')) {
      const head = entry.slice(3);
      const track = /\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]/.exec(head);
      if (track) {
        result.ahead = Number(track[1] || 0);
        result.behind = Number(track[2] || 0);
      }
      const names = head.replace(/\s*\[.*\]$/, '');
      if (names.startsWith('No commits yet on ')) result.branch = names.slice('No commits yet on '.length);
      else if (names.startsWith('HEAD (no branch)')) result.detached = true;
      else {
        const [branch, upstream] = names.split('...');
        result.branch = branch;
        result.upstream = upstream || null;
      }
      continue;
    }
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    let from = null;
    // A rename or copy is followed by its source path.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') from = parts[++i] || null;
    const untracked = x === '?' && y === '?';
    const conflicted = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
    result.files.push({
      path,
      from,
      index: x,
      worktree: y,
      staged: !untracked && x !== ' ' && x !== '!',
      unstaged: untracked || (y !== ' ' && y !== '!'),
      untracked,
      conflicted,
    });
  }
  return result;
}

/** Changed line ranges of a working file against HEAD, from `git diff -U0`. */
export function parseLineChanges(diff) {
  const changes = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let match;
  while ((match = re.exec(diff))) {
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    if (newCount === 0) {
      // Pure deletion: mark the line after which lines disappeared.
      changes.push({ type: 'deleted', start: Math.max(newStart, 1), end: Math.max(newStart, 1) });
    } else {
      changes.push({ type: oldCount === 0 ? 'added' : 'modified', start: newStart, end: newStart + newCount - 1 });
    }
  }
  return changes;
}

/** Parses `git log --graph` rows written with the RECORD format below. */
export function parseLog(output) {
  return output.split('\n').filter((line) => line.length > 0).map((line) => {
    const at = line.indexOf('\x1f');
    if (at === -1) return { graph: line, commit: null };
    const [hash, short, author, date, refs, subject] = line.slice(at + 1).split('\x1f');
    return {
      graph: line.slice(0, at),
      commit: { hash, short, author, date, refs: refs ? refs.split(', ').filter(Boolean) : [], subject },
    };
  });
}

const RECORD = '%x1f%H%x1f%h%x1f%an%x1f%ar%x1f%D%x1f%s';

/** Parses `for-each-ref` rows written with the format in GET /branches. */
export function parseBranches(output) {
  return output.split('\n').filter(Boolean).map((line) => {
    const [head, ref, name, upstream, track, date, subject] = line.split('\x1f');
    const ahead = /ahead (\d+)/.exec(track || '');
    const behind = /behind (\d+)/.exec(track || '');
    return {
      name,
      remote: ref.startsWith('refs/remotes/'),
      current: head === '*',
      upstream: upstream || null,
      gone: (track || '').includes('gone'),
      ahead: ahead ? Number(ahead[1]) : 0,
      behind: behind ? Number(behind[1]) : 0,
      date,
      subject,
    };
  }).filter((branch) => !(branch.remote && branch.name.endsWith('/HEAD')) && branch.name !== 'origin');
}

/** Rejects names git would refuse or read as an option. */
export function validBranchName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 250 && !name.startsWith('-')
    && !/[\s~^:?*[\\\0]|\.\.|@\{|\/\/|\.lock$|\/$|\.$/.test(name);
}

function fileList(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2000) throw new GitError('invalid_files');
  for (const file of value) {
    if (typeof file !== 'string' || !file || file.includes('\0')) throw new GitError('invalid_files');
  }
  return value;
}

/** A short subject from the staged diff when no agent CLI is available. */
export function fallbackCommitMessage(nameStatus) {
  const rows = nameStatus.split('\n').map((line) => line.split('\t')).filter((row) => row.length >= 2);
  if (rows.length === 0) return '';
  const verbs = { A: 'add', D: 'remove', M: 'update', R: 'rename' };
  const kinds = new Set(rows.map((row) => row[0][0]));
  const verb = kinds.size === 1 ? (verbs[[...kinds][0]] || 'update') : 'update';
  const names = rows.map((row) => row[row.length - 1].split('/').pop());
  const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
  return `chore: ${verb} ${shown}`;
}

function generateWithClaude(diff, cwd) {
  const prompt = 'Write a git commit message for the staged diff below. Use a conventional-commit style subject '
    + 'line under 72 characters, then optionally a blank line and a short body. Output only the message.\n\n' + diff;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('claude', ['-p'], { cwd, windowsHide: true, env: process.env });
    } catch {
      resolve(null);
      return;
    }
    const out = [];
    const timer = setTimeout(() => child.kill(), 90_000);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString('utf8').trim();
      resolve(code === 0 && text ? text : null);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

export function createGitRouter({ pathGuard, generateMessage = generateWithClaude }) {
  const router = Router();
  router.use(requireSameOrigin);

  async function repo(req) {
    const source = req.method === 'GET' ? req.query : (req.body || {});
    const target = await pathGuard.resolve(source.path, source.paneId);
    if (target.error) throw new GitError(target.error, target.status);
    const dir = target.stat.isDirectory() ? target.nativePath : dirname(target.nativePath);
    let root;
    try {
      root = (await runGit(dir, ['rev-parse', '--show-toplevel'])).trim();
    } catch (error) {
      if (error.message === 'git_not_installed') throw error;
      throw new GitError('not_a_git_repository', 404);
    }
    return { root, display: IS_WINDOWS ? toPosixPath(root) : root, target };
  }

  const route = (fn) => async (req, res) => {
    try {
      res.json({ success: true, data: await fn(req), error: null });
    } catch (error) {
      res.status(error.status || 500).json({ success: false, data: null, error: error.message });
    }
  };

  router.get('/status', route(async (req) => {
    const { root, display } = await repo(req);
    const status = parseStatus(await runGit(root, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'], {
      env: { GIT_OPTIONAL_LOCKS: '0' },
    }));
    let head = null;
    try {
      const [hash, subject] = (await runGit(root, ['log', '-1', '--format=%h%x1f%s'])).trim().split('\x1f');
      head = { hash, subject };
    } catch {
      // No commits yet.
    }
    return { root: display, head, ...status };
  }));

  router.get('/diff', route(async (req) => {
    const { root } = await repo(req);
    const file = req.query.file;
    if (typeof file !== 'string' || !file) throw new GitError('invalid_files');
    const context = ['-U3', '--no-color', '--no-ext-diff'];
    if (req.query.untracked === '1') {
      // Untracked files have no index entry; diff them against nothing.
      return { diff: await runGit(root, ['diff', '--no-index', ...context, '--', IS_WINDOWS ? 'NUL' : '/dev/null', file], { allowExit: [1] }) };
    }
    const args = req.query.staged === '1' ? ['diff', '--cached', ...context, '--', file] : ['diff', ...context, '--', file];
    return { diff: await runGit(root, args) };
  }));

  router.get('/line-changes', route(async (req) => {
    const { root, target } = await repo(req);
    if (!target.stat.isFile()) throw new GitError('Not a regular file');
    const file = target.nativePath;
    const tracked = await runGit(root, ['ls-files', '--error-unmatch', '--', file], { allowExit: [1] });
    if (!tracked.trim()) {
      const ignored = await runGit(root, ['check-ignore', '-q', '--', file], { allowExit: [1] }).then(() => true, () => false);
      return { tracked: false, changes: [] , untracked: !ignored };
    }
    const diff = await runGit(root, ['diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD', '--', file], { allowExit: [128] })
      .catch(() => runGit(root, ['diff', '-U0', '--no-color', '--no-ext-diff', '--', file]));
    return { tracked: true, changes: parseLineChanges(diff) };
  }));

  router.get('/log', route(async (req) => {
    const { root } = await repo(req);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 200, 1), LOG_LIMIT_MAX);
    const args = ['log', '--graph', '--date-order', `--format=${RECORD}`, '-n', String(limit)];
    if (req.query.all !== '0') args.push('--all');
    try {
      return { rows: parseLog(await runGit(root, args)) };
    } catch {
      return { rows: [] };
    }
  }));

  router.get('/show', route(async (req) => {
    const { root } = await repo(req);
    const commit = String(req.query.commit || '');
    if (!/^[0-9a-f]{4,64}$/i.test(commit)) throw new GitError('invalid_commit');
    const diff = await runGit(root, ['show', '--no-color', '--no-ext-diff', '--format=%H%n%an <%ae>%n%ad%n%n%B', commit]);
    return { diff };
  }));

  router.post('/stage', route(async (req) => {
    const { root } = await repo(req);
    await runGit(root, ['add', '-A', '--', ...fileList(req.body.files)]);
    return {};
  }));

  router.post('/unstage', route(async (req) => {
    const { root } = await repo(req);
    const files = fileList(req.body.files);
    // `restore --staged` needs a HEAD; before the first commit, drop from the index.
    await runGit(root, ['restore', '--staged', '--', ...files])
      .catch(() => runGit(root, ['rm', '--cached', '-r', '-q', '--', ...files]));
    return {};
  }));

  router.post('/discard', route(async (req) => {
    const { root } = await repo(req);
    const files = fileList(req.body.files);
    const untracked = Array.isArray(req.body.untracked) ? fileList(req.body.untracked) : [];
    const tracked = files.filter((file) => !untracked.includes(file));
    if (tracked.length) await runGit(root, ['restore', '--worktree', '--', ...tracked]);
    if (untracked.length) await runGit(root, ['clean', '-f', '-q', '--', ...untracked]);
    return {};
  }));

  // Hunk and line staging: the browser builds a patch from the selected lines.
  router.post('/apply', route(async (req) => {
    const { root } = await repo(req);
    const { patch, cached = true, reverse = false } = req.body;
    if (typeof patch !== 'string' || !patch.startsWith('diff --git ') || patch.length > 8 * 1024 * 1024) {
      throw new GitError('invalid_patch');
    }
    const args = ['apply', '--whitespace=nowarn', '--recount', '--unidiff-zero'];
    if (cached) args.push('--cached');
    if (reverse) args.push('--reverse');
    await runGit(root, [...args, '-'], { input: patch.endsWith('\n') ? patch : patch + '\n' });
    return {};
  }));

  router.post('/commit', route(async (req) => {
    const { root } = await repo(req);
    const { message, amend = false } = req.body;
    if (typeof message !== 'string' || !message.trim()) throw new GitError('empty_commit_message');
    const args = ['commit', '-F', '-'];
    if (amend) args.push('--amend');
    await runGit(root, args, { input: message, timeout: 120_000 });
    const [hash, subject] = (await runGit(root, ['log', '-1', '--format=%h%x1f%s'])).trim().split('\x1f');
    return { hash, subject };
  }));

  // Undo the last commit but keep its changes staged, and hand its message
  // back so the commit box can offer it again.
  router.post('/undo-commit', route(async (req) => {
    const { root } = await repo(req);
    const message = await runGit(root, ['log', '-1', '--format=%B']);
    try {
      await runGit(root, ['rev-parse', '--verify', '-q', 'HEAD~1']);
    } catch {
      throw new GitError('no_parent_commit');
    }
    await runGit(root, ['reset', '--soft', 'HEAD~1']);
    return { message: message.trim() };
  }));

  router.get('/branches', route(async (req) => {
    const { root } = await repo(req);
    const format = '%(HEAD)%1f%(refname)%1f%(refname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(committerdate:relative)%1f%(contents:subject)';
    const out = await runGit(root, ['for-each-ref', '--sort=-committerdate', `--format=${format}`, 'refs/heads', 'refs/remotes'], {
      env: { GIT_OPTIONAL_LOCKS: '0' },
    });
    return { branches: parseBranches(out) };
  }));

  router.post('/checkout', route(async (req) => {
    const { root } = await repo(req);
    const { branch, create = false, from = null } = req.body;
    if (!validBranchName(branch)) throw new GitError('invalid_branch');
    if (create) {
      const args = ['switch', '-c', branch];
      if (from != null) {
        if (!validBranchName(from)) throw new GitError('invalid_branch');
        args.push(from);
      }
      await runGit(root, args);
    } else if (/^[^/]+\/.+/.test(branch) && req.body.remote === true) {
      // A remote branch checks out as a local tracking branch.
      await runGit(root, ['switch', '--track', branch]);
    } else {
      await runGit(root, ['switch', branch]);
    }
    return {};
  }));

  // Fetch, pull (fast-forward only) or push. A branch without an upstream is
  // pushed to origin and starts tracking it.
  router.post('/sync', route(async (req) => {
    const { root } = await repo(req);
    const action = req.body.action;
    // No terminal is attached, so a credential prompt fails instead of hanging.
    const options = { timeout: 120_000 };
    let output;
    if (action === 'fetch') output = await runGit(root, ['fetch', '--all', '--prune'], options);
    else if (action === 'pull') output = await runGit(root, ['pull', '--ff-only'], options);
    else if (action === 'push') {
      const upstream = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowExit: [128] });
      if (upstream.trim()) output = await runGit(root, ['push'], options);
      else {
        const branch = (await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        if (!branch || branch === 'HEAD') throw new GitError('detached_head');
        output = await runGit(root, ['push', '-u', 'origin', branch], options);
      }
    } else throw new GitError('invalid_action');
    return { output: output.trim() };
  }));

  router.post('/commit-message', route(async (req) => {
    const { root } = await repo(req);
    let diff = await runGit(root, ['diff', '--cached', '--no-color', '--no-ext-diff', '--stat', '--patch']);
    if (!diff.trim()) throw new GitError('nothing_staged');
    if (diff.length > MAX_DIFF_FOR_MESSAGE) diff = diff.slice(0, MAX_DIFF_FOR_MESSAGE) + '\n[diff truncated]\n';
    const generated = await generateMessage(diff, root);
    if (generated) return { message: generated, source: 'claude' };
    const nameStatus = await runGit(root, ['diff', '--cached', '--name-status']);
    return { message: fallbackCommitMessage(nameStatus), source: 'summary' };
  }));

  return router;
}
