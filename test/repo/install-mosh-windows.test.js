import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dirname, '../../scripts/install-mosh.ps1'), 'utf8');
const service = readFileSync(resolve(import.meta.dirname, '../../scripts/install-service.ps1'), 'utf8');
const remote = readFileSync(resolve(import.meta.dirname, '../../scripts/remote/install-node.ps1'), 'utf8');

// Execute only AST-extracted functions. Replace native/filesystem operations first;
// the real installer entry point, package manager and services can never execute.
export const WINDOWS_HARNESS = String.raw`
$ErrorActionPreference = 'Stop'
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TWP_MOSH_TEST_SOURCE))
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'INSTALLER_PARSE_FAILED' }
$functions = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)
foreach ($definition in $functions) { Invoke-Expression $definition.Extent.Text }
$originalRoot = (Get-Item -LiteralPath 'Function:Get-MoshRoot').ScriptBlock
function Get-MoshRoot([string]$RequestedRoot) { return 'C:\twp-isolated-mosh-test' }
function Get-Content { param([switch]$Raw, [string]$Encoding, [string]$LiteralPath) if ($script:RootFixture -eq 'saved') { if ($Encoding -ne 'UTF8') { throw 'CONFIG_ENCODING_REQUIRED' }; return '{"msys2Root":"C:\\fixture-saved-msys"}' }; throw 'UNMOCKED_CONTENT_READ' }
function Test-Path {
  param([string]$LiteralPath)
  if ($script:RootFixture) { return $script:RootFixture -eq 'saved' }
  if ($LiteralPath -like '*\db.lck') {
    $script:Case.LockChecks++
    return ($script:Case.Locked -or ($script:Case.LateLock -and $script:Case.LockChecks -ge 2))
  }
  switch (Split-Path -Leaf $LiteralPath) {
    'mosh-server.exe' { return [bool]($script:Case.Existing -or $script:Case.Installed) }
    'pacman.exe' { return -not $script:Case.NoManager }
    'pacman-conf.exe' { return -not $script:Case.NoPolicyTool }
    default { throw 'UNMOCKED_FILESYSTEM_LOOKUP' }
  }
}
function Invoke-MoshNative([string]$File, [string[]]$Arguments) {
  $script:Case.Calls += ,@((Split-Path -Leaf $File), ($Arguments -join ' '))
  $text = ''; $code = 0
  switch (Split-Path -Leaf $File) {
    'mosh-server.exe' {
      $script:Case.RuntimePathCorrect = $env:PATH.StartsWith('C:\twp-isolated-mosh-test\usr\bin;') -and $env:MSYS -eq 'winsymlinks:nativestrict noglob'
      if ($script:Case.Broken) { $code = 1 } else { $text = 'mosh-server (mosh 1.4.0)' }
    }
    'pacman-conf.exe' { $text = if ($script:Case.WeakPolicy) { 'PackageOptional DatabaseOptional' } else { 'PackageRequired PackageTrustedOnly DatabaseOptional' } }
    'pacman.exe' {
      switch ($Arguments[0]) {
        '-Qq' {
          $text = @('msys2-runtime','tmux','openssl','ncurses') -join [char]10
          if ($script:Case.BrokenMissing) { $text += [char]10 + 'mosh' }
          if ($script:Case.InventoryError) { $code = 1; $text = 'database could not be read' }
        }
        '-Sp' {
          $text = @('mosh|1.4.0-6|msys||','protobuf|21.12-3|msys||') -join [char]10
          if ($script:Case.Upgrade) { $text += [char]10 + 'openssl|3.7.0-1|msys||' }
          if ($script:Case.Runtime) { $text += [char]10 + 'msys2-runtime|3.7.0-1|msys||' }
          if ($script:Case.Replace) { $text = 'mosh|1.4.0-6|msys||openssl<4' }
          if ($script:Case.Conflict) { $text = 'mosh|1.4.0-6|msys|ncurses|' }
          if ($script:Case.BadPlan) { $text = 'unexpected package-manager output' }
          if ($script:Case.ForeignRepo) { $text = 'mosh|1.4.0-6|custom||' }
        }
        '-S' {
          $script:Case.InstallCalls++
          if ($script:Case.NoPermission) { $code = 1; $text = 'Permission denied' }
          elseif ($script:Case.SignatureError) { $code = 1; $text = 'invalid or corrupted package (PGP signature)' }
          elseif ($script:Case.DownloadError) { $code = 1; $text = 'failed retrieving file' }
          else { $script:Case.Installed = $true }
        }
        '-Qkk' { if ($script:Case.IntegrityError) { $code = 1 } else { $text = 'mosh: 14 total files, 0 altered files' } }
        default { throw 'UNMOCKED_NATIVE_OPERATION' }
      }
    }
    default { throw 'UNMOCKED_NATIVE_PROGRAM' }
  }
  return [pscustomobject]@{ Code = $code; Text = $text }
}
$cases = @(
  @{Name='ready';Existing=$true}, @{Name='install'}, @{Name='skip';Skip=$true}, @{Name='external_skip';ExternalSkip=$true}, @{Name='internal_skip';InternalSkip=$true},
  @{Name='client';Role='client'}, @{Name='no_manager';NoManager=$true}, @{Name='locked';Locked=$true}, @{Name='late_lock';LateLock=$true},
  @{Name='weak_policy';WeakPolicy=$true}, @{Name='no_policy_tool';NoPolicyTool=$true}, @{Name='inventory_error';InventoryError=$true},
  @{Name='upgrade';Upgrade=$true}, @{Name='runtime';Runtime=$true}, @{Name='replace';Replace=$true}, @{Name='conflict';Conflict=$true}, @{Name='bad_plan';BadPlan=$true}, @{Name='foreign_repo';ForeignRepo=$true},
  @{Name='broken';Existing=$true;Broken=$true}, @{Name='broken_missing';BrokenMissing=$true}, @{Name='permission';NoPermission=$true},
  @{Name='signature';SignatureError=$true}, @{Name='download';DownloadError=$true}, @{Name='integrity';IntegrityError=$true}
)
$rows = @()
foreach ($item in $cases) {
  $script:Case = $item; $script:Case.Calls=@(); $script:Case.InstallCalls=0; $script:Case.LockChecks=0
  $env:PATH='TWP_TEST_ORIGINAL_PATH'; $env:MSYS='glob winsymlinks:nativestrict'
  $env:TWP_SKIP_MOSH=$(if($item.InternalSkip){'1'}else{''}); $env:TMUX_PANEL_SKIP_MOSH=$(if($item.ExternalSkip){'1'}else{''})
  $role=$(if($item.Role){$item.Role}else{'server'})
  $result=Install-Mosh -RequestedRoot 'C:\ignored-test-root' -RequestedRole $role -Skip ([bool]$item.Skip)
  $rows += [pscustomobject]@{name=$item.Name;state=$result.State;reason=$result.Reason;installCalls=$item.InstallCalls;calls=$item.Calls;
    runtimePathCorrect=[bool]$item.RuntimePathCorrect;envRestored=($env:PATH -eq 'TWP_TEST_ORIGINAL_PATH' -and $env:MSYS -eq 'glob winsymlinks:nativestrict')}
}
$oldRoot=$env:MSYS2_ROOT
try {
  $env:MSYS2_ROOT='C:\fixture-env-msys'; $script:RootFixture='saved'
  $rows += [pscustomobject]@{name='root_saved';root=(& $originalRoot 'C:\fixture-explicit-msys')}
  $script:RootFixture='missing'
  $rows += [pscustomobject]@{name='root_explicit';root=(& $originalRoot 'C:\fixture-explicit-msys')}
  $rows += [pscustomobject]@{name='root_env';root=(& $originalRoot '')}
  $env:MSYS2_ROOT=''
  $rows += [pscustomobject]@{name='root_default';root=(& $originalRoot '')}
} finally { $env:MSYS2_ROOT=$oldRoot }
[Console]::Out.WriteLine(($rows | ConvertTo-Json -Depth 6 -Compress))
`;

describe('Windows Mosh integration contract', () => {
  it('keeps component installation independent of all service and terminal operations', () => {
    expect(source).not.toMatch(/Stop-Process|Stop-ScheduledTask|Start-ScheduledTask|kill-server|attach-session|New-NetFirewallRule/);
    expect(source).not.toMatch(/'-Sy'|'-Syu'|Remove-Item|Set-Content|WriteAllText/);
    expect(source).toContain("'-Sp', '--needed', '--noconfirm'");
    expect(source).toContain('TWP_COMPONENT_RESULT=$($result.State)');
    expect(source).toContain("if ($result.State -in @('ready', 'skipped')) { exit 0 }");
  });

  it('runs the optional component once after the base service and forwards both skip conventions', () => {
    expect(service.indexOf("$component = Join-Path $PSScriptRoot 'install-mosh.ps1'"))
      .toBeGreaterThan(service.indexOf('Start-Task $PanelTask'));
    expect(service).toContain('[switch]$SkipMosh');
    expect(remote).toContain("$env:TWP_SKIP_MOSH -eq '1' -or $env:TMUX_PANEL_SKIP_MOSH -eq '1'");
    expect(remote).toContain('-NodeBin $node @optional');
    expect(remote).not.toContain("Join-Path $App 'scripts\\install-mosh.ps1'");
    expect(service).toContain('the panel remains installed');
  });
});

const powershell = process.platform === 'win32' ? 'powershell.exe' : process.env.TWP_TEST_PWSH;
describe.skipIf(!powershell)('isolated PowerShell Mosh policy (all native/filesystem operations mocked)', () => {
  let rows;
  beforeAll(() => {
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_HARNESS, 'utf16le').toString('base64')], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 256_000,
      env: { ...process.env, TWP_MOSH_TEST_SOURCE: Buffer.from(source).toString('base64') },
    });
    expect(result.status, result.stderr).toBe(0);
    rows = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  });

  it.each([
    ['ready', 'ready', '', 0], ['install', 'ready', '', 1], ['skip', 'skipped', 'user_skipped', 0],
    ['external_skip', 'skipped', 'user_skipped', 0], ['internal_skip', 'skipped', 'user_skipped', 0], ['client', 'unsupported', 'client_platform', 0],
    ['no_manager', 'unsupported', 'package_manager_missing', 0], ['locked', 'failed', 'package_manager_busy', 0],
    ['late_lock', 'failed', 'package_manager_busy', 0], ['weak_policy', 'failed', 'signature_policy_unsafe', 0],
    ['no_policy_tool', 'failed', 'signature_policy_unavailable', 0], ['inventory_error', 'failed', 'package_inventory_failed', 0],
    ['upgrade', 'maintenance_required', 'shared_runtime_upgrade_required', 0], ['runtime', 'maintenance_required', 'shared_runtime_upgrade_required', 0],
    ['replace', 'maintenance_required', 'shared_runtime_upgrade_required', 0], ['conflict', 'maintenance_required', 'shared_runtime_upgrade_required', 0],
    ['bad_plan', 'failed', 'package_plan_unrecognized', 0], ['foreign_repo', 'failed', 'package_plan_unrecognized', 0],
    ['broken', 'failed', 'component_unusable', 0], ['broken_missing', 'failed', 'component_unusable', 0],
    ['permission', 'maintenance_required', 'windows_admin_required', 1], ['signature', 'failed', 'package_verification_failed', 1],
    ['download', 'failed', 'package_install_failed', 1], ['integrity', 'failed', 'component_integrity_failed', 1],
  ])('%s yields %s without an unintended package transaction', (name, state, reason, installCalls) => {
    expect(rows.find((r) => r.name === name)).toMatchObject({ state, reason, installCalls, envRestored: true });
  });

  it('sets runtime lookup only for its own invocation and never uses upgrade/sync flags', () => {
    expect(rows.filter((row) => ['ready', 'install'].includes(row.name)).every((row) => row.runtimePathCorrect)).toBe(true);
    for (const row of rows) for (const [, args] of row.calls || []) expect(args).not.toMatch(/(?:^| )-S(?:y|yu)(?: |$)/);
  });

  it('uses the installed service MSYS root before explicit/environment/default roots', () => {
    expect(rows.find((row) => row.name === 'root_saved').root).toBe('C:\\fixture-saved-msys');
    expect(rows.find((row) => row.name === 'root_explicit').root).toBe('C:\\fixture-explicit-msys');
    expect(rows.find((row) => row.name === 'root_env').root).toBe('C:\\fixture-env-msys');
    expect(rows.find((row) => row.name === 'root_default').root).toBe('C:\\msys64');
  });
});
