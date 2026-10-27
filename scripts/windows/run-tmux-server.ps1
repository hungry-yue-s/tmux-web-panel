# Task Scheduler entry point for the MSYS2 tmux server (the Windows counterpart
# of tmux-server.service / scripts/run-tmux-server.sh).
param([Parameter(Mandatory = $true)][string]$ConfigPath)

$ErrorActionPreference = 'Stop'
$cfg = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
$tmux = $cfg.tmuxBin
# Windows PowerShell turns redirected native stderr into a terminating error
# under 'Stop'; the probe below expects "no server running" on stderr.
$ErrorActionPreference = 'Continue'

# Panes are MSYS2 login shells: MSYSTEM picks the environment /etc/profile sets
# up, CHERE_INVOKING keeps `tmux -c <dir>` instead of jumping to $HOME, and the
# MSYS2 bin directory comes first so plugins and run-shell find tmux and bash.
# noglob stops MSYS from brace-expanding tmux formats passed as arguments.
# MSYS2_PATH_TYPE=inherit keeps the Windows PATH through /etc/profile, whose
# default ("minimal") would drop Git, Node, claude and the rest from panes.
$env:MSYSTEM = $cfg.msystem
$env:MSYS2_PATH_TYPE = 'inherit'
$env:CHERE_INVOKING = '1'
$env:SHELL = '/usr/bin/bash'
$env:MSYS = 'noglob'
$env:LANG = 'C.UTF-8'
$env:LC_CTYPE = 'C.UTF-8'
$env:PATH = (Split-Path -Parent $tmux) + ';' + $env:PATH

New-Item -ItemType Directory -Force -Path $cfg.logDir | Out-Null
$log = Join-Path $cfg.logDir 'tmux-server.log'

# KeepAlive like the launchd agent: a killed server comes back empty (continuum
# only auto-restores on the first start; restore manually with prefix + Ctrl-r).
while ($true) {
  # A server may already run from an interactive shell. Do not kill it (and its
  # sessions) to put it under the task; wait for it to exit, then take over.
  while ($true) {
    & $tmux show-options -gqv exit-empty *> $null
    if ($LASTEXITCODE -ne 0) { break }
    Start-Sleep -Seconds 5
  }

  Add-Content -LiteralPath $log -Encoding UTF8 -Value "[$(Get-Date -Format s)] starting $tmux -D"
  # -D keeps the server in the foreground so the task owns it, and turns exit-empty off.
  # Its own hidden console keeps a console Ctrl+C away from this loop.
  # WaitForExit, not Start-Process -Wait: -Wait also waits for every
  # descendant, so a program left running from a pane would keep a dead tmux
  # server from ever being restarted.
  $proc = Start-Process -FilePath cmd.exe -ArgumentList "/d /s /c `"`"$tmux`" -D >> `"$log`" 2>&1`"" `
    -WindowStyle Hidden -PassThru
  $proc.WaitForExit()
  Add-Content -LiteralPath $log -Encoding UTF8 -Value "[$(Get-Date -Format s)] tmux server exited with code $($proc.ExitCode); restarting in 3s"
  Start-Sleep -Seconds 3
}
