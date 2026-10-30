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

function Write-ServerLog([string]$Message) {
  Add-Content -LiteralPath $log -Encoding UTF8 -Value "[$(Get-Date -Format s)] $Message"
}

# Which server owns the socket, or $null if none answers. A client can hang on a
# stuck server, so the question has a time limit.
function Get-ServerPid {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $tmux
  $info.Arguments = 'display-message -p "#{pid}"'
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $probe = [System.Diagnostics.Process]::Start($info)
  $output = $probe.StandardOutput.ReadToEndAsync()
  $null = $probe.StandardError.ReadToEndAsync()
  if (-not $probe.WaitForExit(8000)) {
    try { $probe.Kill() } catch {}
    return $null
  }
  if ($probe.ExitCode -ne 0) { return $null }
  return $output.Result.Trim()
}

# tmux reports its MSYS pid; only MSYS can say which Windows process that is.
function Get-WindowsPid([string]$MsysPid) {
  $cat = Join-Path (Split-Path -Parent $tmux) 'cat.exe'
  $value = & $cat "/proc/$MsysPid/winpid" 2> $null
  if ($LASTEXITCODE -ne 0 -or -not $value) { return $null }
  return [int]"$value".Trim()
}

# How often the running server must answer, and how many misses in a row end it.
$CheckIntervalMs = 10000
$MaxMissedChecks = 3

# KeepAlive like the launchd agent: a killed server comes back empty and the
# panel's session protection restores the last save into it.
while ($true) {
  # A server may already run from an interactive shell. Do not kill it (and its
  # sessions) to put it under the task; wait for it to exit, then take over.
  while (Get-ServerPid) { Start-Sleep -Seconds 5 }

  Write-ServerLog "starting $tmux -D"
  # -D keeps the server in the foreground so the task owns it, and turns exit-empty off.
  # Its own hidden console keeps a console Ctrl+C away from this loop.
  # setsid -w: in the foreground the server would take that console as its
  # controlling terminal, and a SIGINT the MSYS runtime raised on it (seen when
  # another MSYS program started) ended the server and every session. Without
  # a controlling terminal nothing tty-generated reaches it; -w still waits.
  # WaitForExit, not Start-Process -Wait: -Wait also waits for every
  # descendant, so a program left running from a pane would keep a dead tmux
  # server from ever being restarted.
  $setsid = Join-Path (Split-Path -Parent $tmux) 'setsid.exe'
  $proc = Start-Process -FilePath cmd.exe -ArgumentList "/d /s /c `"`"$setsid`" -w `"$tmux`" -D >> `"$log`" 2>&1`"" `
    -WindowStyle Hidden -PassThru

  # The server can stop serving without exiting: its socket is gone, the process
  # stays (docs/known-issues.md). Only waiting for the exit would then leave
  # every session unrecoverable, so it has to keep answering as itself.
  $serverPid = $null
  $windowsPid = $null
  $missed = 0
  while (-not $proc.WaitForExit($CheckIntervalMs)) {
    $answer = Get-ServerPid
    if ($answer -and -not $serverPid) {
      $serverPid = $answer
      $windowsPid = Get-WindowsPid $answer
    }
    if ($answer -and $answer -eq $serverPid) {
      $missed = 0
      continue
    }
    $missed++
    if ($missed -lt $MaxMissedChecks) { continue }
    $stuck = "tmux server $serverPid (Windows pid $windowsPid) stopped answering, socket answered by '$answer'; ended it"
    if ($windowsPid) { Stop-Process -Id $windowsPid -Force -ErrorAction SilentlyContinue }
    if (-not $proc.WaitForExit(10000)) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    break
  }
  $proc.WaitForExit()
  # Not before this: the server's stderr redirect holds the log open while it runs.
  if ($stuck) { Write-ServerLog $stuck; $stuck = $null }
  Write-ServerLog "tmux server exited with code $($proc.ExitCode); restarting in 3s"
  Start-Sleep -Seconds 3
}
