# Task Scheduler entry point for the web panel (the Windows counterpart of the
# systemd unit / launchd plist). Settings come from the owner-only JSON file
# written by scripts/install-service.ps1, so AUTH never appears on a command line.
param([Parameter(Mandatory = $true)][string]$ConfigPath)

$ErrorActionPreference = 'Stop'
$cfg = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
# The supervision loop must survive anything node or cmd write to stderr.
$ErrorActionPreference = 'Continue'

$env:PORT = [string]$cfg.port
$env:HOST = [string]$cfg.host
$env:TMUX_BIN = $cfg.tmuxBin
$env:MSYS2_ROOT = $cfg.msys2Root
$env:LANG = 'C.UTF-8'
$env:LC_CTYPE = 'C.UTF-8'
if ($cfg.auth) { $env:AUTH = $cfg.auth }
if ($cfg.tlsCert -and $cfg.tlsKey) {
  $env:TLS_CERT = $cfg.tlsCert
  $env:TLS_KEY = $cfg.tlsKey
  $env:HTTP_PORT = [string]$cfg.httpPort
}

New-Item -ItemType Directory -Force -Path $cfg.logDir | Out-Null
$log = Join-Path $cfg.logDir 'panel.log'
Set-Location -LiteralPath $cfg.projectDir

# Restart=always, RestartSec=3: the task itself stays running and owns node.
while ($true) {
  if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 10MB) {
    Move-Item -Force -LiteralPath $log -Destination "$log.1"
  }
  Add-Content -LiteralPath $log -Encoding UTF8 -Value "[$(Get-Date -Format s)] starting node server/index.js"
  # cmd keeps node's UTF-8 output byte-for-byte; PowerShell 5.1 redirection would re-encode it.
  & cmd.exe /d /c "`"$($cfg.nodeBin)`" server\index.js >> `"$log`" 2>&1"
  Add-Content -LiteralPath $log -Encoding UTF8 -Value "[$(Get-Date -Format s)] node exited with code $LASTEXITCODE; restarting in 3s"
  Start-Sleep -Seconds 3
}
