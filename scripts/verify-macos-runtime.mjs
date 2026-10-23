#!/usr/bin/env node
// Only component version checks and a short PTY child process, never a server.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const root = path.resolve(process.argv[2] || '');
assert(process.argv[2], 'Pass a runtime directory');
const write = process.argv.includes('--write-manifest');
const manifestPath = path.join(root, 'manifest.json');
const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
const arch = process.env.TMUX_PANEL_ARCH || previous.arch || process.arch;
const minimumMacOS = process.env.TMUX_PANEL_MINIMUM_MACOS || previous.minimumMacOS || '13.5';
assert(['arm64', 'x64'].includes(arch), 'Unsupported runtime architecture');
const machine = arch === 'arm64' ? 'arm64' : 'x86_64';
const binaryFiles = [];
const files = [];
function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(name);
    else if (entry.isFile() && name !== manifestPath) {
      files.push(name);
      const fd = fs.openSync(name, 'r');
      const header = Buffer.alloc(4); fs.readSync(fd, header); fs.closeSync(fd);
      if (['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(header.toString('hex'))) binaryFiles.push(name);
    }
  }
}
visit(root);
assert(binaryFiles.length >= 4, 'Node, tmux, PTY addon and spawn helper must be bundled');
for (const name of binaryFiles) {
  const architectures = execFileSync('/usr/bin/lipo', ['-archs', name], { encoding: 'utf8' }).trim().split(/\s+/);
  assert(architectures.includes(machine), `Wrong architecture: ${name}`);
  const commands = execFileSync('/usr/bin/otool', ['-l', name], { encoding: 'utf8' });
  // LC_VERSION_MIN_MACOSX has "version"; LC_BUILD_VERSION has "minos".
  const deployment = /cmd LC_BUILD_VERSION[\s\S]*?\bminos\s+([\d.]+)/.exec(commands)
    || /cmd LC_VERSION_MIN_MACOSX[\s\S]*?\bversion\s+([\d.]+)/.exec(commands);
  assert(deployment, `Missing macOS deployment metadata: ${name}`);
  const numeric = value => value.split('.').reduce((sum, part, i) => sum + Number(part) * (10000 / 100 ** i), 0);
  assert(numeric(deployment[1]) <= numeric(minimumMacOS), `Requires macOS ${deployment[1]}, above advertised ${minimumMacOS}: ${name}`);
  const dependencies = execFileSync('/usr/bin/otool', ['-L', name], { encoding: 'utf8' }).split('\n').slice(1).map(line => line.trim().split(' (')[0]).filter(Boolean);
  for (const dependency of dependencies) {
    assert(dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/'), `Non-system dynamic dependency: ${name} → ${dependency}`);
  }
}
for (const relative of ['bin/node', 'bin/tmux', 'app/server/index.js', 'app/public/index.html', 'app/public/fonts/LICENSE-SymbolsNerdFont.txt', 'licenses/THIRD-PARTY-NOTICES.md', 'app/scripts/desktop-runtime.mjs', 'app/scripts/desktop-certificates.mjs', 'app/relay/index.template.html', 'app/plugins/tmux-agent/panel-plugin.json', 'app/skills/tmux-panel/SKILL.md']) {
  assert(fs.existsSync(path.join(root, relative)), `Missing bundled component: ${relative}`);
}
assert(!fs.existsSync(path.join(root, 'app/public/js/relay-config.js')), 'Personal generated relay config must not be distributed');
const nodeVersion = execFileSync(path.join(root, 'bin/node'), ['--version'], { encoding: 'utf8' }).trim();
const actualArch = execFileSync(path.join(root, 'bin/node'), ['-p', 'process.arch'], { encoding: 'utf8' }).trim();
assert.equal(actualArch, arch);
const tmuxVersion = execFileSync(path.join(root, 'bin/tmux'), ['-V'], { encoding: 'utf8' }).trim();
execFileSync(path.join(root, 'bin/node'), ['--check', path.join(root, 'app/server/index.js')]);
const require = createRequire(path.join(root, 'app/package.json'));
const pty = require('node-pty');
await new Promise((resolve, reject) => {
  const terminal = pty.spawn('/usr/bin/printf', ['tmux-panel-pty-ok'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: root, env: { PATH: '/usr/bin:/bin' } });
  let output = '';
  const timer = setTimeout(() => { terminal.kill(); reject(new Error('Bundled PTY smoke test timed out')); }, 5000);
  terminal.onData(value => { output += value; });
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timer);
    if (exitCode === 0 && output.includes('tmux-panel-pty-ok')) resolve();
    else reject(new Error('Bundled PTY smoke test failed'));
  });
});
if (write) {
  const hashes = {};
  const digest = crypto.createHash('sha256');
  for (const name of files.sort()) {
    const relative = path.relative(root, name);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(name)).digest('hex');
    hashes[relative] = hash; digest.update(relative + '\0' + hash + '\n');
  }
  const buildId = `desktop-${arch}-${digest.digest('hex').slice(0, 20)}`;
  fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, buildId, arch, nodeVersion, tmuxVersion, minimumMacOS,
    nodeSource: process.env.TMUX_PANEL_NODE_SOURCE || previous.nodeSource,
    tmuxSourceCommit: process.env.TMUX_PANEL_TMUX_SOURCE_COMMIT ?? previous.tmuxSourceCommit ?? '',
    machO: binaryFiles.map(name => path.relative(root, name)), files: hashes }, null, 2) + '\n');
}
console.log(`Runtime verified: ${arch}; ${nodeVersion}; ${tmuxVersion}; minimum macOS ${minimumMacOS}; PTY passed`);
