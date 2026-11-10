import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrateLegacyDirs } from '../../lib/legacy-names.js';

// PowerShell Core can execute these isolated settings/default expressions on
// macOS too. No task, process, package manager or service function is executed.
const powershell = process.env.ANYMUX_TEST_POWERSHELL || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
const available = spawnSync(powershell, ['-NoProfile', '-Command', 'exit 0']).status === 0;
const updateMigratedSettings = String.raw`
$ConfigDir = Join-Path $env:USERPROFILE '.config\anymux'
$LegacyName = 'tmux-web-panel'
$LegacyConfigDir = Join-Path $env:USERPROFILE '.config\tmux-web-panel'
$ConfigFile = Join-Path $ConfigDir 'windows-service.json'
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Move-LegacyInstallation' }, $true)
$settings = $function.Body.Find({ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.StartsWith('if (Test-Path -LiteralPath $ConfigFile)') }, $true)
Invoke-Expression $settings.Extent.Text
`;
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function write(path, value) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, value); }
function evaluate(file, body, testHome) {
  const source = readFileSync(resolve(import.meta.dirname, '../../scripts', file), 'utf8');
  return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ANYMUX_TEST_PS_SOURCE))
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'SCRIPT_PARSE_FAILED' }
${body}
`], { encoding: 'utf8', env: { ...process.env, USERPROFILE: testHome, ANYMUX_TEST_PS_SOURCE: Buffer.from(source).toString('base64') }, timeout: 10000 });
}

describe.runIf(available)('Windows managed tmux paths (isolated PowerShell expressions)', () => {
  it('retargets migrated tmuxBin when conflicting app copies leave the legacy data directory behind', () => {
    const testHome = mkdtempSync(join(tmpdir(), 'anymux-tmux-migration-')); dirs.push(testHome);
    const legacy = join(testHome, '.local', 'share', 'tmux-web-panel');
    const current = join(testHome, '.local', 'share', 'anymux');
    const executable = join(legacy, 'tmux', 'existing-hash', 'tmux.exe');
    write(executable, 'existing immutable binary');
    write(join(legacy, 'app', 'package.json'), 'legacy app');
    write(join(current, 'app', 'package.json'), 'new app');
    write(join(testHome, '.config', 'tmux-web-panel', 'windows-service.json'), JSON.stringify({ tmuxBin: executable, projectDir: join(legacy, 'app'), auth: 'fixture-only' }));
    migrateLegacyDirs({ home: testHome, windows: true, warn: () => {} });
    expect(existsSync(executable)).toBe(false);
    const run = evaluate('install-service.ps1', updateMigratedSettings, testHome);
    expect(run.status, run.stderr).toBe(0);
    const saved = JSON.parse(readFileSync(join(testHome, '.config', 'anymux', 'windows-service.json'), 'utf8'));
    expect(saved).toEqual({ tmuxBin: join(current, 'tmux', 'existing-hash', 'tmux.exe'), projectDir: join(current, 'app'), auth: 'fixture-only' });
    expect(readFileSync(saved.tmuxBin, 'utf8')).toBe('existing immutable binary');
    expect(readFileSync(join(legacy, 'app', 'package.json'), 'utf8')).toBe('legacy app');
  });

  it('keeps an executable left in the legacy directory and preserves custom project paths', () => {
    const testHome = mkdtempSync(join(tmpdir(), 'anymux-tmux-retained-')); dirs.push(testHome);
    const executable = join(testHome, '.local', 'share', 'tmux-web-panel', 'tmux', 'held-hash', 'tmux.exe');
    const settings = { tmuxBin: executable, projectDir: join(testHome, 'custom-checkout') };
    write(executable, 'binary still in use');
    const config = join(testHome, '.config', 'anymux', 'windows-service.json');
    write(config, JSON.stringify(settings));
    const run = evaluate('install-service.ps1', updateMigratedSettings, testHome);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual(settings);
    expect(readFileSync(executable, 'utf8')).toBe('binary still in use');
  });

  it('puts new immutable builds in the Anymux data directory', () => {
    const testHome = mkdtempSync(join(tmpdir(), 'anymux-tmux-default-')); dirs.push(testHome);
    const run = evaluate('build-tmux-windows.ps1', String.raw`
$parameter = $ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'InstallRoot' }
Invoke-Expression $parameter.DefaultValue.Extent.Text
`, testHome);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(join(testHome, '.local', 'share', 'anymux', 'tmux'));
  });
});
