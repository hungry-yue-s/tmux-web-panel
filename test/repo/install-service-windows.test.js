import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = readFileSync(resolve(import.meta.dirname, '../../scripts/install-service.ps1'), 'utf8');

// Runs only the named functions, parsed out of the script: nothing the script
// would do on its own (tasks, services, files) can run.
function runFunction(name, prelude, defined = ['Resolve-Node', 'Resolve-ServiceNode']) {
  const harness = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$source =[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ANYMUX_SERVICE_SOURCE))
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'SCRIPT_PARSE_FAILED' }
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  if (@($env:ANYMUX_SERVICE_FUNCTIONS -split ',') -contains $definition.Name) { Invoke-Expression $definition.Extent.Text }
}
${prelude}
${name}
`;
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', harness], {
    encoding: 'utf8',
    env: { ...process.env, ANYMUX_SERVICE_SOURCE: Buffer.from(script).toString('base64'), ANYMUX_SERVICE_FUNCTIONS: defined.join(',') },
    timeout: 60_000,
  });
}

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe.runIf(process.platform === 'win32')('install-service.ps1 on Windows', () => {
  it('checks dependencies with the node the installed task runs, unless -NodeBin names one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anymux-service-'));
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

  it('replaces the tmux-web-panel tasks with anymux ones, moving the settings and leaving tmux running', () => {
    const home = mkdtempSync(join(tmpdir(), 'anymux-migrate-'));
    dirs.push(home);
    const legacy = join(home, '.config', 'tmux-web-panel');
    mkdirSync(join(legacy, 'tls'), { recursive: true });
    mkdirSync(join(legacy, 'logs'));
    writeFileSync(join(legacy, 'tls', 'cert.pem'), 'cert');
    writeFileSync(join(legacy, 'tls', 'key.pem'), 'key');
    writeFileSync(join(legacy, 'logs', 'tmux-server.log'), 'tmux writes here');
    writeFileSync(join(legacy, 'windows-service.json'), JSON.stringify({
      nodeBin: process.execPath, port: 7681, auth: 'user:secret',
      logDir: join(legacy, 'logs'), tlsCert: join(legacy, 'tls', 'cert.pem'), tlsKey: join(legacy, 'tls', 'key.pem'),
    }));
    const scripts = resolve(import.meta.dirname, '../../scripts');
    // Every scheduled-task, process and firewall call is a stand-in that only records itself.
    const prelude = String.raw`
$env:USERPROFILE = '${home}'
$ScriptsDir = '${scripts}'
$NodeBin = ''
$TaskPath = '\anymux\'; $PanelTask = 'anymux'; $TmuxTask = 'tmux-server'; $FirewallRule = 'anymux'
$ConfigDir = Join-Path $env:USERPROFILE '.config\anymux'; $ConfigFile = Join-Path $ConfigDir 'windows-service.json'
$LegacyName = 'tmux-web-panel'; $LegacyTaskPath = '\tmux-web-panel\'
$LegacyConfigDir = Join-Path $env:USERPROFILE '.config\tmux-web-panel'; $LegacyConfigFile = Join-Path $LegacyConfigDir 'windows-service.json'
$global:calls = New-Object System.Collections.ArrayList
function Get-ScheduledTask { param($TaskPath, $TaskName)
  if ($TaskPath -eq '\tmux-web-panel\') {
    foreach ($n in 'tmux-web-panel', 'tmux-server') { [pscustomobject]@{ TaskName = $n; State = 'Running'; Principal = [pscustomobject]@{ LogonType = 'S4U' } } }
  }
}
function Stop-ScheduledTask { param($TaskPath, $TaskName) [void]$global:calls.Add("stop $TaskPath$TaskName") }
function Start-ScheduledTask { param($TaskPath, $TaskName) [void]$global:calls.Add("start $TaskPath$TaskName") }
function Unregister-ScheduledTask { param($TaskPath, $TaskName, $Confirm) [void]$global:calls.Add("unregister $TaskPath$TaskName") }
function Register-PanelTask { param($Name, $Script, $Description, $Mode) [void]$global:calls.Add("register $Name $Mode $(Split-Path -Leaf $Script)") }
function Get-TaskOrNull { param($Name) [pscustomobject]@{ TaskName = $Name } }
function Get-CimInstance { @() }
function Get-NetFirewallRule { $null }
function Assert-Dependencies { param($Node) [void]$global:calls.Add('check dependencies') }
function Test-Elevated { $true }
function New-Object { param([string]$ComObject)
  $folder = [pscustomobject]@{} | Add-Member -MemberType ScriptMethod -Name DeleteFolder -Value { [void]$global:calls.Add('delete task folder') } -PassThru
  [pscustomobject]@{ Folder = $folder } | Add-Member -MemberType ScriptMethod -Name Connect -Value {} -PassThru |
    Add-Member -MemberType ScriptMethod -Name GetFolder -Value { $this.Folder } -PassThru
}
# The running tmux server holds its log open, without sharing delete.
$held = [IO.File]::Open((Join-Path $LegacyConfigDir 'logs\tmux-server.log'), 'Open', 'ReadWrite', 'ReadWrite')
`;
    const run = runFunction(
      '$migrated = Move-LegacyInstallation | Select-Object -Last 1; $held.Close(); "MIGRATED=$migrated"; $global:calls | ForEach-Object { "CALL $_" }',
      prelude,
      ['Move-LegacyInstallation', 'Get-LegacyTasks', 'Test-RealDirectory', 'Stop-WrapperTree', 'Start-Task',
        'Invoke-Native', 'Write-Ok', 'Write-Warn', 'Resolve-Node'],
    );
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('MIGRATED=True');
    const calls = run.stdout.split(/\r?\n/).filter((line) => line.startsWith('CALL ')).map((line) => line.slice(5));
    // The new tasks are registered before anything stops. The old panel stops;
    // the old tmux task loses only its wrapper (never a kill-server).
    expect(calls).toEqual([
      'check dependencies',
      'register tmux-server Startup run-tmux-server.ps1',
      'register anymux Startup run-panel.ps1',
      'stop \\tmux-web-panel\\tmux-web-panel',
      'stop \\tmux-web-panel\\tmux-server',
      'unregister \\tmux-web-panel\\tmux-web-panel',
      'unregister \\tmux-web-panel\\tmux-server',
      'delete task folder',
      'start \\anymux\\tmux-server',
      'start \\anymux\\anymux',
    ]);
    const current = join(home, '.config', 'anymux');
    const saved = JSON.parse(readFileSync(join(current, 'windows-service.json'), 'utf8'));
    expect(saved).toMatchObject({
      auth: 'user:secret', logDir: join(current, 'logs'),
      tlsCert: join(current, 'tls', 'cert.pem'), tlsKey: join(current, 'tls', 'key.pem'),
    });
    expect(readFileSync(join(current, 'tls', 'key.pem'), 'utf8')).toBe('key');
    // Only the log the server holds stays behind; a later run moves it.
    expect(readFileSync(join(legacy, 'logs', 'tmux-server.log'), 'utf8')).toBe('tmux writes here');
    expect(existsSync(join(legacy, 'windows-service.json'))).toBe(false);
  });
});
