# Builds the tracked tmux plus project patches. Versioned paths retain running
# executables and servers; this script never starts, stops or replaces a server.
param(
  [string]$Msys2Root = $(if ($env:MSYS2_ROOT) { $env:MSYS2_ROOT } else { 'C:\msys64' }),
  [string]$SourceDirectory,
  [string]$InstallRoot = (Join-Path $env:USERPROFILE '.local\share\tmux-web-panel\tmux'),
  [ValidateRange(1, 32)][int]$Jobs = 2
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$project = Split-Path -Parent $PSScriptRoot
if (-not $SourceDirectory) { $SourceDirectory = Join-Path $project 'vendor\tmux' }
$usrBin = Join-Path $Msys2Root 'usr\bin'
$bash = Join-Path $usrBin 'bash.exe'
$pacman = Join-Path $usrBin 'pacman.exe'
$cygpath = Join-Path $usrBin 'cygpath.exe'
if (-not (Test-Path -LiteralPath $bash) -or -not (Test-Path -LiteralPath $pacman)) { throw "MSYS2 is required at $Msys2Root" }
if (-not (Test-Path -LiteralPath (Join-Path $SourceDirectory 'tmux.c'))) {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'tmux source is missing; initialize vendor/tmux or install a complete source archive.' }
  & git -C $project submodule update --init --recursive -- vendor/tmux
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $SourceDirectory 'tmux.c'))) { throw 'Could not initialize the tmux source.' }
}
$SourceDirectory = (Resolve-Path -LiteralPath $SourceDirectory).Path
$previous = @{}
foreach ($key in @('PATH','MSYS','MSYSTEM','MSYS2_PATH_TYPE')) { $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
$staging = $null
try {
  $env:PATH = "$usrBin;$env:PATH"
  $env:MSYS = 'noglob'
  $env:MSYSTEM = 'MSYS'
  $env:MSYS2_PATH_TYPE = 'inherit'
  $packages = @('autoconf','automake','bison','gcc','make','libevent-devel','ncurses-devel','pkgconf','patch','tar')
  # Native stderr must not become a terminating NativeCommandError on PS 5.
  $preference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $pacman -Q @packages *> $null
    if ($LASTEXITCODE -ne 0) {
      Write-Host 'Installing native tmux build dependencies with MSYS2 pacman...'
      & $pacman -S --needed --noconfirm @packages 2>&1 | ForEach-Object { Write-Host "$_" }
      if ($LASTEXITCODE -ne 0) { throw 'MSYS2 could not install the tmux build dependencies.' }
    }
    $versions = (& $pacman -Q msys2-runtime gcc libevent ncurses 2>$null) -join "`n"
  } finally { $ErrorActionPreference = $preference }
  # An archive need not carry .git. Hash source bytes, patches, build scripts and
  # ABI package versions; old binaries are immutable and never overwritten.
  $inputs = @(Get-ChildItem -LiteralPath $SourceDirectory -Recurse -File | Where-Object { $_.FullName -notmatch '[\\/]\.git([\\/]|$)' })
  $inputs += Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'tmux-patches') -File
  $inputs += Get-Item -LiteralPath (Join-Path $PSScriptRoot 'apply-tmux-patches.sh'), (Join-Path $PSScriptRoot 'build-tmux-windows.sh'), $PSCommandPath
  $parts = @($versions)
  foreach ($file in ($inputs | Sort-Object FullName)) { $parts += $file.Name + ':' + (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash }
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $fingerprint = -join ($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes(($parts -join "`n"))) | ForEach-Object { $_.ToString('x2') }) } finally { $algorithm.Dispose() }
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  $destination = Join-Path $InstallRoot $fingerprint
  $executable = Join-Path $destination 'tmux.exe'
  if (Test-Path -LiteralPath $executable) {
    $version = & $executable -V
    if ($LASTEXITCODE -ne 0 -or "$version" -notmatch '^tmux ') { throw "Cached tmux cannot run: $executable" }
    return $executable
  }
  $staging = Join-Path $InstallRoot ('.staging-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  $builder = (& $cygpath -u (Join-Path $PSScriptRoot 'build-tmux-windows.sh')).Trim()
  $source = (& $cygpath -u $SourceDirectory).Trim()
  $output = (& $cygpath -u $staging).Trim()
  $patcher = (& $cygpath -u (Join-Path $PSScriptRoot 'apply-tmux-patches.sh')).Trim()
  $preference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $bash --noprofile --norc $builder $source $output $patcher $Jobs 2>&1 | ForEach-Object { Write-Host "$_" }
    if ($LASTEXITCODE -ne 0) { throw 'Native tmux build failed.' }
  } finally { $ErrorActionPreference = $preference }
  $built = Join-Path $staging 'tmux.exe'
  if (-not (Test-Path -LiteralPath $built)) { throw 'Native tmux build produced no executable.' }
  $version = & $built -V
  if ($LASTEXITCODE -ne 0 -or "$version" -notmatch '^tmux ') { throw 'The native tmux executable could not run.' }
  if (-not (Test-Path -LiteralPath $destination)) { Move-Item -LiteralPath $staging -Destination $destination; $staging = $null }
  Write-Host "Native tmux ready: $version"
  return $executable
} finally {
  if ($staging -and (Test-Path -LiteralPath $staging)) { Remove-Item -LiteralPath $staging -Recurse -Force }
  foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
}
