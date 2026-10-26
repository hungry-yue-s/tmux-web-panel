<#
.SYNOPSIS
  Installs tmux-web-panel as Windows scheduled tasks (the counterpart of
  scripts/install-service.sh on Linux/macOS).

.DESCRIPTION
  Two tasks under \tmux-web-panel\ in Task Scheduler:
    tmux-server     MSYS2 tmux in the foreground (tmux -D); restored sessions
                    are available as soon as the machine starts
    tmux-web-panel  node server/index.js, restarted 3 s after any exit

  Requirements: Node.js for Windows (node-pty uses ConPTY) and MSYS2. The
  MSYS2 tmux package is installed with pacman when it is missing.

  Settings are stored in %USERPROFILE%\.config\tmux-web-panel\windows-service.json
  readable only by the current user, because it holds the AUTH password.

.EXAMPLE
  .\scripts\install-service.ps1 install -Auth user:secret
.EXAMPLE
  .\scripts\install-service.ps1 install -Auth user:secret -TlsAuto -OpenFirewall
.EXAMPLE
  .\scripts\install-service.ps1 restart
.EXAMPLE
  .\scripts\install-service.ps1 ssh-enable
  Lets a tmux-web-panel on another machine add this host over SSH: OpenSSH
  Server answers with an MSYS2 login bash, so the host looks like any POSIX
  tmux server. ssh-disable restores the previous sshd settings.
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs', 'cert', 'ssh-enable', 'ssh-disable')]
  [string]$Action,
  [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 7681 }),
  [string]$ListenHost = $(if ($env:HOST) { $env:HOST } else { '0.0.0.0' }),
  # user:password; without it the panel has NO authentication.
  [string]$Auth = $env:AUTH,
  [string]$TlsCert = $env:TLS_CERT,
  [string]$TlsKey = $env:TLS_KEY,
  # Generate (or reuse) a certificate for localhost, this host name and LAN IPs.
  [switch]$TlsAuto,
  [int]$HttpPort = $(if ($env:HTTP_PORT) { [int]$env:HTTP_PORT } else { 7680 }),
  [string]$NodeBin = $env:NODE_BIN,
  [string]$Msys2Root = $(if ($env:MSYS2_ROOT) { $env:MSYS2_ROOT } else { 'C:\msys64' }),
  # MSYS2 environment for pane shells: UCRT64, MINGW64, CLANG64 or MSYS.
  [string]$Msystem = $(if ($env:MSYSTEM) { $env:MSYSTEM } else { 'UCRT64' }),
  # Startup: run at boot without a logon (needs an elevated prompt).
  # Logon: run when this user signs in.
  [ValidateSet('Auto', 'Startup', 'Logon')]
  [string]$Trigger = 'Auto',
  # Add an inbound Windows Firewall rule for the panel ports (needs elevation).
  [switch]$OpenFirewall,
  # start/stop/restart/status/logs the tmux server task instead of the panel.
  [switch]$Tmux,
  # ssh-enable: MSYS path of the shell for interactive ssh logins (default: the
  # MSYS2 shell sshd used before, else /usr/bin/bash).
  [string]$LoginShell
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$ProjectDir = Split-Path -Parent $PSScriptRoot
$TaskPath = '\tmux-web-panel\'
$PanelTask = 'tmux-web-panel'
$TmuxTask = 'tmux-server'
$ConfigDir = Join-Path $env:USERPROFILE '.config\tmux-web-panel'
$ConfigFile = Join-Path $ConfigDir 'windows-service.json'
$LogDir = Join-Path $ConfigDir 'logs'
$TlsDir = Join-Path $ConfigDir 'tls'
$FirewallRule = 'tmux-web-panel'
$SshdConfig = Join-Path $env:ProgramData 'ssh\sshd_config'
$SshRegistry = 'HKLM:\SOFTWARE\OpenSSH'
$SshStateFile = Join-Path $ConfigDir 'ssh-host.json'
$SshBlockBegin = '# BEGIN tmux-web-panel ssh-enable'
$SshBlockEnd = '# END tmux-web-panel ssh-enable'

function Write-Ok([string]$Message) { Write-Host "OK  $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "!!  $Message" -ForegroundColor Yellow }

# Runs native commands whose stderr is redirected: Windows PowerShell turns that
# stderr into a terminating error under $ErrorActionPreference = 'Stop'.
function Invoke-Native([scriptblock]$Block) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Block } finally { $ErrorActionPreference = $previous }
}

function Test-Elevated {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Protect-File([string]$Path) {
  # Owner-only, like `chmod 600` on the systemd unit and launchd plist.
  & icacls.exe $Path /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls failed for $Path" }
}

function Resolve-Node {
  if ($NodeBin) { return (Resolve-Path -LiteralPath $NodeBin).Path }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $default = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path -LiteralPath $default) { return $default }
  throw 'node.exe not found. Install Node.js for Windows (e.g. winget install OpenJS.NodeJS.LTS) or pass -NodeBin.'
}

function Resolve-Tmux {
  $usrBin = Join-Path $Msys2Root 'usr\bin'
  $tmux = Join-Path $usrBin 'tmux.exe'
  if (Test-Path -LiteralPath $tmux) { return $tmux }
  $pacman = Join-Path $usrBin 'pacman.exe'
  if (-not (Test-Path -LiteralPath $pacman)) {
    throw "MSYS2 not found at $Msys2Root. Install it (winget install MSYS2.MSYS2) or pass -Msys2Root."
  }
  Write-Host 'Installing tmux with MSYS2 pacman...'
  & $pacman -S --needed --noconfirm tmux
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $tmux)) { throw 'pacman could not install tmux.' }
  return $tmux
}

function Get-MsysHome {
  $msysHome = Join-Path $Msys2Root "home\$env:USERNAME"
  New-Item -ItemType Directory -Force -Path $msysHome | Out-Null
  return $msysHome
}

# Same invariant as on Linux/macOS: the server must survive having no sessions
# until tmux-continuum has restored them.
function Set-TmuxExitEmpty {
  $conf = Join-Path (Get-MsysHome) '.tmux.conf'
  $line = 'set -g exit-empty off'
  $comment = '# Added by tmux-web-panel install-service.ps1: keep server alive without sessions'
  if (-not (Test-Path -LiteralPath $conf)) {
    [IO.File]::WriteAllText($conf, "$comment`n$line`n")
    Write-Ok "Created $conf with '$line'"
    return
  }
  if (Select-String -LiteralPath $conf -Pattern '^\s*set\s+-g\s+exit-empty\s+off' -Quiet) { return }
  [IO.File]::AppendAllText($conf, "`n$comment`n$line`n")
  Write-Ok "Appended '$line' to $conf"
}

function Get-LanAddresses {
  try {
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
      ForEach-Object { $_.IPAddress }
  } catch { @() }
}

function New-LocalCertificate {
  $openssl = Join-Path $Msys2Root 'usr\bin\openssl.exe'
  if (-not (Test-Path -LiteralPath $openssl)) {
    throw "TLS auto-generation needs MSYS2 openssl ($openssl): pacman -S openssl"
  }
  New-Item -ItemType Directory -Force -Path $TlsDir | Out-Null
  $cert = Join-Path $TlsDir 'cert.pem'
  $key = Join-Path $TlsDir 'key.pem'
  $hostName = [Environment]::MachineName.ToLower()
  $ips = @('127.0.0.1') + @(Get-LanAddresses)
  if ((Test-Path -LiteralPath $cert) -and (Test-Path -LiteralPath $key)) {
    $details = Invoke-Native { & $openssl x509 -in $cert -noout -text 2>$null | Out-String }
    $fresh = Invoke-Native { & $openssl x509 -in $cert -noout -checkend 2592000 *> $null; $LASTEXITCODE -eq 0 }
    $valid = $fresh -and $details -match 'DNS:localhost' -and $details -match "DNS:$([regex]::Escape($hostName))"
    foreach ($ip in $ips) { if ($details -notmatch "IP Address:$([regex]::Escape($ip))\b") { $valid = $false } }
    if ($valid) {
      Write-Ok "Reusing TLS certificate: $cert"
      return @{ cert = $cert; key = $key }
    }
  }
  $lines = @('[req]', 'distinguished_name = dn', 'x509_extensions = v3_req', 'prompt = no',
    '[dn]', "CN = $hostName",
    '[v3_req]', 'basicConstraints = critical,CA:FALSE', 'keyUsage = critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage = serverAuth', 'subjectAltName = @alt_names',
    '[alt_names]', 'DNS.1 = localhost', "DNS.2 = $hostName")
  for ($i = 0; $i -lt $ips.Count; $i++) { $lines += "IP.$($i + 1) = $($ips[$i])" }
  $config = Join-Path $env:TEMP "tmux-web-panel-openssl-$PID.cnf"
  [IO.File]::WriteAllText($config, ($lines -join "`n") + "`n")
  try {
    $created = Invoke-Native {
      & $openssl req -x509 -nodes -newkey rsa:2048 -sha256 -days 825 -keyout $key -out $cert -config $config *> $null
      $LASTEXITCODE -eq 0
    }
    if (-not $created) { throw 'openssl could not generate the certificate.' }
  } finally {
    Remove-Item -LiteralPath $config -ErrorAction SilentlyContinue
  }
  Protect-File $key
  Write-Ok "Generated TLS certificate: $cert"
  Write-Host "    SAN: localhost, $hostName, $($ips -join ', ')"
  return @{ cert = $cert; key = $key }
}

function Get-TaskOrNull([string]$Name) {
  Get-ScheduledTask -TaskPath $TaskPath -TaskName $Name -ErrorAction SilentlyContinue
}

function Register-PanelTask([string]$Name, [string]$Script, [string]$Description, [string]$Mode) {
  # USERDOMAIN may be a workgroup name that does not resolve to an account.
  $userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`" -ConfigPath `"$ConfigFile`""
  $taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $ProjectDir
  if ($Mode -eq 'Startup') {
    $taskTrigger = New-ScheduledTaskTrigger -AtStartup
    # S4U runs without an interactive logon and without storing a password.
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType S4U -RunLevel Limited
  } else {
    $taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
  }
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskPath $TaskPath -TaskName $Name -Description $Description -Action $taskAction `
    -Trigger $taskTrigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
}

# Stop-ScheduledTask ends the PowerShell wrapper; make sure the process it
# supervises (node or tmux) goes with it.
function Stop-TaskTree([string]$Name) {
  $task = Get-TaskOrNull $Name
  if (-not $task) { return }
  $wrapper = if ($Name -eq $PanelTask) { 'run-panel.ps1' } else { 'run-tmux-server.ps1' }
  $all = @(Get-CimInstance Win32_Process)
  $roots = @($all | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -and $_.CommandLine.Contains($wrapper) -and $_.CommandLine.Contains($ConfigFile) })
  Stop-ScheduledTask -TaskPath $TaskPath -TaskName $Name -ErrorAction SilentlyContinue
  $queue = New-Object System.Collections.Queue
  foreach ($root in $roots) { $queue.Enqueue($root.ProcessId) }
  $tree = @()
  while ($queue.Count -gt 0) {
    $id = $queue.Dequeue()
    $tree += $id
    foreach ($child in ($all | Where-Object { $_.ParentProcessId -eq $id })) { $queue.Enqueue($child.ProcessId) }
  }
  foreach ($id in $tree) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
}

function Start-Task([string]$Name) {
  if (-not (Get-TaskOrNull $Name)) { throw "Task $TaskPath$Name is not installed; run: install-service.ps1 install" }
  Start-ScheduledTask -TaskPath $TaskPath -TaskName $Name -ErrorAction Stop
}

function Install-Service {
  $node = Resolve-Node
  $tmux = Resolve-Tmux
  if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir 'node_modules\node-pty'))) {
    throw "Dependencies are missing. Run 'npm ci' in $ProjectDir first."
  }

  if ($TlsAuto) {
    if ($TlsCert -or $TlsKey) { throw 'Use -TlsAuto or -TlsCert/-TlsKey, not both.' }
    $generated = New-LocalCertificate
    $script:TlsCert = $generated.cert
    $script:TlsKey = $generated.key
  } elseif ($TlsCert -or $TlsKey) {
    if (-not ($TlsCert -and $TlsKey)) { throw 'TlsCert and TlsKey must both be set.' }
    $script:TlsCert = (Resolve-Path -LiteralPath $TlsCert).Path
    $script:TlsKey = (Resolve-Path -LiteralPath $TlsKey).Path
  }

  $mode = $Trigger
  if ($mode -eq 'Auto') { $mode = if (Test-Elevated) { 'Startup' } else { 'Logon' } }
  if ($mode -eq 'Startup' -and -not (Test-Elevated)) { throw '-Trigger Startup needs an elevated PowerShell.' }

  New-Item -ItemType Directory -Force -Path $ConfigDir, $LogDir | Out-Null
  Set-TmuxExitEmpty

  $config = [ordered]@{
    projectDir = $ProjectDir
    nodeBin = $node
    tmuxBin = $tmux
    msys2Root = (Resolve-Path -LiteralPath $Msys2Root).Path
    msystem = $Msystem
    port = $Port
    host = $ListenHost
    auth = $(if ($Auth) { $Auth } else { $null })
    tlsCert = $(if ($TlsCert) { $TlsCert } else { $null })
    tlsKey = $(if ($TlsKey) { $TlsKey } else { $null })
    httpPort = $HttpPort
    logDir = $LogDir
  }
  # Replace the stored settings through a new owner-only file.
  Stop-TaskTree $PanelTask
  if (Test-Path -LiteralPath $ConfigFile) { Remove-Item -LiteralPath $ConfigFile -Force }
  New-Item -ItemType File -Path $ConfigFile | Out-Null
  Protect-File $ConfigFile
  [IO.File]::WriteAllText($ConfigFile, ($config | ConvertTo-Json))

  # Re-registering the tmux task must not end a running server and its sessions.
  $tmuxRunning = (Get-TaskOrNull $TmuxTask) -and (Get-TaskOrNull $TmuxTask).State -eq 'Running'
  Register-PanelTask $TmuxTask (Join-Path $PSScriptRoot 'windows\run-tmux-server.ps1') 'tmux server (keep-alive for tmux-web-panel)' $mode
  Register-PanelTask $PanelTask (Join-Path $PSScriptRoot 'windows\run-panel.ps1') 'tmux web panel' $mode
  if (-not $tmuxRunning) { Start-Task $TmuxTask }
  Start-Task $PanelTask
  Write-Ok "Installed scheduled tasks $TaskPath$TmuxTask and $TaskPath$PanelTask ($mode trigger)"

  if ($OpenFirewall) {
    if (-not (Test-Elevated)) { throw '-OpenFirewall needs an elevated PowerShell.' }
    Remove-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue
    $ports = @("$Port")
    if ($TlsCert) { $ports += "$HttpPort" }
    New-NetFirewallRule -DisplayName $FirewallRule -Direction Inbound -Action Allow -Protocol TCP -LocalPort $ports | Out-Null
    Write-Ok "Opened Windows Firewall for TCP $($ports -join ', ')"
  }

  if (-not $Auth) { Write-Warn 'No -Auth given: the panel has NO authentication.' }
  $scheme = if ($TlsCert) { 'https' } else { 'http' }
  Write-Host ''
  Write-Host "Listening on ${scheme}://${ListenHost}:$Port"
  Write-Host "Settings: $ConfigFile"
  Write-Host "Logs:     $LogDir"
}

function Uninstall-Service {
  Stop-TaskTree $PanelTask
  Stop-TaskTree $TmuxTask
  foreach ($name in @($PanelTask, $TmuxTask)) {
    if (Get-TaskOrNull $name) { Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $name -Confirm:$false }
  }
  if (Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue) {
    Remove-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue
  }
  Write-Ok "Removed scheduled tasks (settings kept in $ConfigFile; .tmux.conf unchanged)"
}

function ConvertTo-MsysPath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetFullPath($Msys2Root).TrimEnd('\') + '\'
  if ($full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { return '/' + $full.Substring($root.Length).Replace('\', '/') }
  return '/' + $full.Substring(0, 1).ToLower() + $full.Substring(2).Replace('\', '/')
}

function Get-SshdService {
  Get-CimInstance Win32_Service -Filter "Name='sshd'" -ErrorAction SilentlyContinue
}

# Rewrites sshd_config without our block, then with it when $Lines is given.
# The old file is restored if sshd rejects the result.
function Set-SshdBlock([string[]]$Lines, [string]$SshdExe) {
  $original = [IO.File]::ReadAllLines($SshdConfig)
  $kept = New-Object System.Collections.Generic.List[string]
  $inside = $false
  foreach ($line in $original) {
    if ($line -eq $SshBlockBegin) { $inside = $true; continue }
    if ($line -eq $SshBlockEnd) { $inside = $false; continue }
    if (-not $inside) { $kept.Add($line) }
  }
  if ($Lines) {
    # Global keywords must come before the first Match block to apply to everyone.
    $at = $kept.Count
    for ($i = 0; $i -lt $kept.Count; $i++) { if ($kept[$i] -match '^\s*Match\s') { $at = $i; break } }
    $kept.InsertRange($at, [string[]](@($SshBlockBegin) + $Lines + @($SshBlockEnd)))
  }
  [IO.File]::WriteAllLines($SshdConfig, $kept)
  $valid = Invoke-Native { & $SshdExe -t *> $null; $LASTEXITCODE -eq 0 }
  if (-not $valid) {
    [IO.File]::WriteAllLines($SshdConfig, $original)
    throw "sshd rejected the new configuration; $SshdConfig was left unchanged."
  }
}

function Enable-SshHost {
  if (-not (Test-Elevated)) { throw 'ssh-enable needs an elevated PowerShell.' }
  Resolve-Tmux | Out-Null
  $service = Get-SshdService
  if (-not $service) {
    Write-Host 'Installing OpenSSH Server...'
    Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null
    $service = Get-SshdService
    if (-not $service) { throw 'OpenSSH Server could not be installed.' }
  }
  Set-Service -Name sshd -StartupType Automatic
  # The first start generates sshd_config and the host keys.
  if (-not (Test-Path -LiteralPath $SshdConfig)) { Start-Service sshd }
  $sshdExe = $service.PathName.Trim('"')
  $sftpServer = ConvertTo-MsysPath (Join-Path (Split-Path -Parent $sshdExe) 'sftp-server.exe')

  # Remember sshd's previous shell once, so ssh-disable can restore it.
  New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
  if (-not (Test-Path -LiteralPath $SshStateFile)) {
    $current = Get-ItemProperty -Path $SshRegistry -ErrorAction SilentlyContinue
    $previous = [ordered]@{ DefaultShell = $null; DefaultShellCommandOption = $null }
    foreach ($name in @($previous.Keys)) {
      if ($current -and $current.PSObject.Properties[$name]) { $previous[$name] = [string]$current.$name }
    }
    [IO.File]::WriteAllText($SshStateFile, ($previous | ConvertTo-Json))
  }
  $state = Get-Content -Raw -LiteralPath $SshStateFile | ConvertFrom-Json

  $shell = $LoginShell
  if (-not $shell) {
    $previousShell = [string]$state.DefaultShell
    $usrBin = Join-Path $Msys2Root 'usr\bin\'
    $shell = '/usr/bin/bash'
    if ($previousShell -and $previousShell.StartsWith($usrBin, [StringComparison]::OrdinalIgnoreCase) -and $previousShell -notmatch '\\bash\.exe$') {
      $shell = '/usr/bin/' + [IO.Path]::GetFileNameWithoutExtension($previousShell)
    }
  }
  if ($shell -notmatch '^/[A-Za-z0-9_./+-]+$') { throw "-LoginShell must be an MSYS path such as /usr/bin/bash: $shell" }
  if ($sftpServer.Contains("'")) { throw "Unsupported sftp-server path: $sftpServer" }

  # The session script is a single word on purpose; see ssh-session.sh.
  $template = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'windows\ssh-session.sh'))
  $session = $template.Replace("`r`n", "`n").Replace('@LOGIN_SHELL@', $shell).Replace('@SFTP_SERVER@', $sftpServer)
  $target = Join-Path $Msys2Root 'usr\local\bin\tmux-web-panel-ssh'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  [IO.File]::WriteAllText($target, $session)

  # A login bash puts /usr/bin first, like any POSIX host the panel connects to.
  New-Item -Path $SshRegistry -Force -ErrorAction SilentlyContinue | Out-Null
  Set-ItemProperty -Path $SshRegistry -Name DefaultShell -Value (Join-Path $Msys2Root 'usr\bin\bash.exe')
  Set-ItemProperty -Path $SshRegistry -Name DefaultShellCommandOption -Value '-lc'
  Set-SshdBlock @('ForceCommand /usr/local/bin/tmux-web-panel-ssh') $sshdExe
  Restart-Service sshd
  Write-Ok "sshd answers with MSYS2 bash; interactive logins start $shell"

  $rule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
  if ($rule) {
    if ($rule.Enabled -ne 'True') { Enable-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' }
  } else {
    New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Direction Inbound `
      -Action Allow -Protocol TCP -LocalPort 22 | Out-Null
  }
  Write-Ok 'Windows Firewall allows TCP 22'
  $keys = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
  Write-Host ''
  Write-Host "Add this host to the other panel as an SSH server ($env:USERNAME@$([Environment]::MachineName.ToLower()))."
  Write-Host "Administrators authenticate with keys from $keys (or the account password)."
}

function Disable-SshHost {
  if (-not (Test-Elevated)) { throw 'ssh-disable needs an elevated PowerShell.' }
  $service = Get-SshdService
  if (-not $service) { Write-Ok 'OpenSSH Server is not installed'; return }
  Set-SshdBlock @() $service.PathName.Trim('"')
  if (Test-Path -LiteralPath $SshStateFile) {
    $state = Get-Content -Raw -LiteralPath $SshStateFile | ConvertFrom-Json
    foreach ($name in @('DefaultShell', 'DefaultShellCommandOption')) {
      if ($state.$name) { Set-ItemProperty -Path $SshRegistry -Name $name -Value $state.$name }
      else { Remove-ItemProperty -Path $SshRegistry -Name $name -ErrorAction SilentlyContinue }
    }
    Remove-Item -LiteralPath $SshStateFile -Force
  }
  Remove-Item -LiteralPath (Join-Path $Msys2Root 'usr\local\bin\tmux-web-panel-ssh') -Force -ErrorAction SilentlyContinue
  Restart-Service sshd
  Write-Ok 'Restored the previous sshd shell settings'
}

function Show-Status {
  foreach ($name in @($TmuxTask, $PanelTask)) {
    $task = Get-TaskOrNull $name
    if (-not $task) { Write-Host "${name}: not installed"; continue }
    $info = Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $name
    Write-Host ("{0}: {1} (last run {2}, result 0x{3:X})" -f $name, $task.State, $info.LastRunTime, $info.LastTaskResult)
  }
  if (Test-Path -LiteralPath $ConfigFile) {
    $cfg = Get-Content -Raw -LiteralPath $ConfigFile | ConvertFrom-Json
    $listening = Get-NetTCPConnection -State Listen -LocalPort $cfg.port -ErrorAction SilentlyContinue
    Write-Host ("port {0}: {1}" -f $cfg.port, $(if ($listening) { 'listening' } else { 'not listening' }))
    Invoke-Native { & $cfg.tmuxBin list-sessions 2>&1 | ForEach-Object { Write-Host "  $_" } }
  }
}

$selected = if ($Tmux) { $TmuxTask } else { $PanelTask }
switch ($Action) {
  'install' { Install-Service }
  'uninstall' { Uninstall-Service }
  'start' { Start-Task $selected; Write-Ok "Started $selected" }
  'stop' { Stop-TaskTree $selected; Write-Ok "Stopped $selected" }
  'restart' { Stop-TaskTree $selected; Start-Task $selected; Write-Ok "Restarted $selected" }
  'status' { Show-Status }
  'logs' {
    $file = Join-Path $LogDir $(if ($Tmux) { 'tmux-server.log' } else { 'panel.log' })
    Get-Content -LiteralPath $file -Tail 50 -Wait -Encoding UTF8
  }
  'cert' { New-LocalCertificate | Out-Null }
  'ssh-enable' { Enable-SshHost }
  'ssh-disable' { Disable-SshHost }
  default { Get-Help $PSCommandPath -Detailed }
}
