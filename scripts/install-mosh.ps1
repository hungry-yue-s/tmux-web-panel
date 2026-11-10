# Prepare only the optional Mosh server component. Never manages Node/tmux services.
param(
  [ValidateSet('server', 'client')][string]$Role = 'server',
  [string]$Msys2Root = $env:MSYS2_ROOT,
  [switch]$SkipMosh
)

$ErrorActionPreference = 'Stop'

function Mosh-Result([string]$State, [string]$Reason = '') {
  return [pscustomobject]@{ State = $State; Reason = $Reason }
}

function Get-MoshRoot([string]$RequestedRoot) {
  $config = Join-Path $env:USERPROFILE '.config\anymux\windows-service.json'
  if (Test-Path -LiteralPath $config) {
    $saved = Get-Content -Raw -Encoding UTF8 -LiteralPath $config | ConvertFrom-Json
    if ($saved.msys2Root) { return [IO.Path]::GetFullPath([string]$saved.msys2Root) }
  }
  if ($RequestedRoot) { return [IO.Path]::GetFullPath($RequestedRoot) }
  if ($env:MSYS2_ROOT) { return [IO.Path]::GetFullPath($env:MSYS2_ROOT) }
  return 'C:\msys64'
}

# Native stderr is data here, not a terminating PowerShell error. Never echo raw diagnostics.
function Invoke-MoshNative([string]$File, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lines = @(& $File @Arguments 2>&1 | ForEach-Object { "$_" })
    return [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($lines -join "`n") }
  } finally { $ErrorActionPreference = $previous }
}

function Mosh-NativeFailure([string]$Text, [string]$Fallback) {
  if ($Text -match '(?i)unable to lock database|could not lock database|database is locked') { return Mosh-Result 'failed' 'package_manager_busy' }
  if ($Text -match '(?i)permission denied|access is denied|access denied|not have.*permission|insufficient privileges|requires.*administrat') { return Mosh-Result 'maintenance_required' 'windows_admin_required' }
  if ($Text -match '(?i)signature|unknown trust|invalid or corrupted package|keyring|PGP') { return Mosh-Result 'failed' 'package_verification_failed' }
  return Mosh-Result 'failed' $Fallback
}

function Install-Mosh([string]$RequestedRoot, [string]$RequestedRole = 'server', [bool]$Skip = $false) {
  # Pre-rename names count only while ANYMUX_SKIP_MOSH is unset, so a panel's explicit '0' wins.
  $skipSetting = if ($env:ANYMUX_SKIP_MOSH) { $env:ANYMUX_SKIP_MOSH } elseif ($env:TMUX_PANEL_SKIP_MOSH) { $env:TMUX_PANEL_SKIP_MOSH } else { $env:TWP_SKIP_MOSH }
  if ($Skip -or $skipSetting -eq '1') { return Mosh-Result 'skipped' 'user_skipped' }
  if ($RequestedRole -ne 'server') { return Mosh-Result 'unsupported' 'client_platform' }
  $root = Get-MoshRoot $RequestedRoot
  $bin = Join-Path $root 'usr\bin'
  $server = Join-Path $bin 'mosh-server.exe'
  $pacman = Join-Path $bin 'pacman.exe'
  $conf = Join-Path $bin 'pacman-conf.exe'
  $lock = Join-Path $root 'var\lib\pacman\db.lck'
  $oldPath = $env:PATH
  $oldMsys = $env:MSYS
  $env:PATH = "$bin;$oldPath"
  $env:MSYS = (@($oldMsys -split '\s+' | Where-Object { $_ -and $_ -ne 'glob' -and $_ -notlike 'glob:*' -and $_ -ne 'noglob' }) + @('noglob')) -join ' '
  try {
    if (Test-Path -LiteralPath $server) {
      $version = Invoke-MoshNative $server @('--version')
      if ($version.Code -eq 0 -and $version.Text -match 'mosh-server \(mosh [0-9][0-9A-Za-z.\-]*\)') { return Mosh-Result 'ready' }
      return Mosh-Result 'failed' 'component_unusable'
    }
    if (-not (Test-Path -LiteralPath $pacman)) { return Mosh-Result 'unsupported' 'package_manager_missing' }
    if (Test-Path -LiteralPath $lock) { return Mosh-Result 'failed' 'package_manager_busy' }
    if (-not (Test-Path -LiteralPath $conf)) { return Mosh-Result 'failed' 'signature_policy_unavailable' }
    Write-Host '>> Check the official Mosh package and existing MSYS2 components'
    $policy = Invoke-MoshNative $conf @('--repo', 'msys', 'SigLevel')
    if ($policy.Code -ne 0) { return Mosh-NativeFailure $policy.Text 'signature_policy_unavailable' }
    $levels = @($policy.Text -split '\s+' | Where-Object { $_ })
    if ($levels -notcontains 'PackageRequired' -or $levels -contains 'PackageOptional' -or $levels -contains 'PackageNever' -or $levels -contains 'PackageTrustAll') {
      return Mosh-Result 'failed' 'signature_policy_unsafe'
    }
    $installed = Invoke-MoshNative $pacman @('-Qq')
    if ($installed.Code -ne 0) { return Mosh-NativeFailure $installed.Text 'package_inventory_failed' }
    $names = @($installed.Text -split '\r?\n' | Where-Object { $_ })
    if (-not $names.Count -or @($names | Where-Object { $_ -notmatch '^[a-zA-Z0-9][a-zA-Z0-9@+_.-]*$' }).Count) { return Mosh-Result 'failed' 'package_inventory_failed' }
    if ($names -contains 'mosh') { return Mosh-Result 'failed' 'component_unusable' }
    $plan = Invoke-MoshNative $pacman @('-Sp', '--needed', '--noconfirm', '--print-format', '%n|%v|%r|%H|%R', 'msys/mosh')
    if ($plan.Code -ne 0) { return Mosh-NativeFailure $plan.Text 'package_plan_failed' }
    $planned = @()
    foreach ($line in @($plan.Text -split '\r?\n' | Where-Object { $_ })) {
      if ($line -notmatch '^([a-zA-Z0-9][a-zA-Z0-9@+_.-]*)\|([^|\s]+)\|msys\|([^|]*)\|([^|]*)$') { return Mosh-Result 'failed' 'package_plan_unrecognized' }
      $name = $Matches[1]
      $relations = ($Matches[3] + ' ' + $Matches[4]) -split '\s+' | Where-Object { $_ }
      if ($names -contains $name -or $name -in @('msys2-runtime', 'tmux')) { return Mosh-Result 'maintenance_required' 'shared_runtime_upgrade_required' }
      foreach ($relation in $relations) {
        if ($names -contains ($relation -replace '[<>=].*$', '')) { return Mosh-Result 'maintenance_required' 'shared_runtime_upgrade_required' }
      }
      $planned += $name
    }
    if ($planned -notcontains 'mosh') { return Mosh-Result 'failed' 'package_plan_unrecognized' }
    # Recheck immediately before pacman's own atomic database lock. Never remove someone else's lock.
    if (Test-Path -LiteralPath $lock) { return Mosh-Result 'failed' 'package_manager_busy' }
    Write-Host '>> Install the optional Mosh server; existing MSYS2 packages will not be upgraded'
    $install = Invoke-MoshNative $pacman @('-S', '--needed', '--noconfirm', 'msys/mosh')
    if ($install.Code -ne 0) { return Mosh-NativeFailure $install.Text 'package_install_failed' }
    $verify = Invoke-MoshNative $pacman @('-Qkk', 'mosh')
    if ($verify.Code -ne 0) { return Mosh-Result 'failed' 'component_integrity_failed' }
    if (-not (Test-Path -LiteralPath $server)) { return Mosh-Result 'failed' 'component_unusable' }
    $version = Invoke-MoshNative $server @('--version')
    if ($version.Code -ne 0 -or $version.Text -notmatch 'mosh-server \(mosh [0-9][0-9A-Za-z.\-]*\)') { return Mosh-Result 'failed' 'component_unusable' }
    Write-Host '>> Mosh server is ready; terminal transport settings are unchanged'
    return Mosh-Result 'ready'
  } finally { $env:PATH = $oldPath; $env:MSYS = $oldMsys }
}

try { $result = Install-Mosh -RequestedRoot $Msys2Root -RequestedRole $Role -Skip ([bool]$SkipMosh) }
catch [System.UnauthorizedAccessException] { $result = Mosh-Result 'maintenance_required' 'windows_admin_required' }
catch { $result = Mosh-Result 'failed' 'component_check_failed' }
Write-Output "ANYMUX_COMPONENT_RESULT=$($result.State)"
if ($result.Reason) { Write-Output "ANYMUX_COMPONENT_REASON=$($result.Reason)" }
if ($result.State -in @('ready', 'skipped')) { exit 0 }
exit 1
