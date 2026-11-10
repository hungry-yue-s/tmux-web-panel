import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = readFileSync(resolve(import.meta.dirname, '../../scripts/install-service.ps1'), 'utf8');

// Runs only the named functions, parsed out of the script: nothing the script
// would do on its own (tasks, services, files) can run.
function runFunction(name, prelude) {
  const harness = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$source =[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TWP_SERVICE_SOURCE))
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'SCRIPT_PARSE_FAILED' }
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  if (@('Resolve-Node', 'Resolve-ServiceNode') -contains $definition.Name) { Invoke-Expression $definition.Extent.Text }
}
${prelude}
${name}
`;
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', harness], {
    encoding: 'utf8',
    env: { ...process.env, TWP_SERVICE_SOURCE: Buffer.from(script).toString('base64') },
    timeout: 60_000,
  });
}

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe.runIf(process.platform === 'win32')('install-service.ps1 on Windows', () => {
  it('checks dependencies with the node the installed task runs, unless -NodeBin names one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'twp-service-'));
    dirs.push(dir);
    // A non-ASCII path: Windows PowerShell reads files as ANSI unless told UTF-8.
    const saved = join(dir, '节点', 'node.exe');
    const other = join(dir, 'other-node.exe');
    mkdirSync(join(dir, '节点'));
    writeFileSync(saved, '');
    writeFileSync(other, '');
    const config = join(dir, 'windows-service.json');
    writeFileSync(config, JSON.stringify({ nodeBin: saved, port: 7681 }));

    const fromConfig = runFunction('Resolve-ServiceNode', `$ConfigFile = '${config}'; $NodeBin = ''`);
    expect(fromConfig.stderr).toBe('');
    expect(fromConfig.stdout.trim()).toBe(saved);

    const explicit = runFunction('Resolve-ServiceNode', `$ConfigFile = '${config}'; $NodeBin = '${other}'`);
    expect(explicit.stdout.trim()).toBe(other);
  });
});
