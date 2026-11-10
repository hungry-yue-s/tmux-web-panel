<#
.SYNOPSIS
  Installs anymux as Windows scheduled tasks (the counterpart of
  scripts/install-service.sh on Linux/macOS).

.DESCRIPTION
  Two tasks under \anymux\ in Task Scheduler:
    tmux-server     MSYS2 tmux in the foreground (tmux -D); restored sessions
                    are available as soon as the machine starts
    anymux  node bin/panel.js, restarted 3 s after any exit

  Requirements: Node.js for Windows (node-pty uses ConPTY) and MSYS2. The
  MSYS2 tmux package is installed with pacman when it is missing.

  Settings are stored in %USERPROFILE%\.config\anymux\windows-service.json
  readable only by the current user, because it holds the AUTH password.

.EXAMPLE
  .\scripts\install-service.ps1 install -Auth user:secret
.EXAMPLE
  .\scripts\install-service.ps1 install -Auth user:secret -TlsAuto -OpenFirewall
.EXAMPLE
  .\scripts\install-service.ps1 restart
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('install', 'uninstall', 'start', 'stop', 'restart', 'reload', 'status', 'logs', 'cert')]
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
  # Serve only the panel that manages this machine over SSH (node token
  # required for the API); set when another panel installs itself here.
  [switch]$NodeOnly,
  # Prepare the optional server component by default; never changes terminal transport.
  [switch]$SkipMosh
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$ProjectDir = Split-Path -Parent $PSScriptRoot
$ScriptsDir = $PSScriptRoot
$TaskPath = '\anymux\'
$PanelTask = 'anymux'
$TmuxTask = 'tmux-server'
$ConfigDir = Join-Path $env:USERPROFILE '.config\anymux'
$ConfigFile = Join-Path $ConfigDir 'windows-service.json'
$LogDir = Join-Path $ConfigDir 'logs'
$TlsDir = Join-Path $ConfigDir 'tls'
$FirewallRule = 'anymux'

# Anymux was installed as tmux-web-panel before the rename: tasks under
# \tmux-web-panel\, settings in .config\tmux-web-panel. Every action except
# status, logs and cert first replaces such an installation (Move-LegacyInstallation).
$LegacyName = 'tmux-web-panel'
$LegacyTaskPath = "\$LegacyName\"
$LegacyConfigDir = Join-Path $env:USERPROFILE ".config\$LegacyName"
$LegacyConfigFile = Join-Path $LegacyConfigDir 'windows-service.json'

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

# The panel imports package.json's dependencies. A checkout updated without
# `npm install` lacks any newly added one, and the panel would not start.
# The node the installed task runs (run-panel.ps1 reads nodeBin from the
# config), so start/restart check with the same one; -NodeBin still wins.
function Resolve-ServiceNode {
  if (-not $NodeBin -and (Test-Path -LiteralPath $ConfigFile)) {
    $saved = (Get-Content -Raw -Encoding UTF8 -LiteralPath $ConfigFile | ConvertFrom-Json).nodeBin
    if ($saved -and (Test-Path -LiteralPath $saved)) { return $saved }
  }
  return Resolve-Node
}

function Assert-Dependencies([string]$Node) {
  & $Node (Join-Path $ProjectDir 'bin\panel.js') --check-dependencies
  if ($LASTEXITCODE -ne 0) { throw "Dependencies are missing. Run 'npm install' in $ProjectDir first." }
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
# until the panel's session protection has restored them.
function Set-TmuxExitEmpty {
  $conf = Join-Path (Get-MsysHome) '.tmux.conf'
  $line = 'set -g exit-empty off'
  $comment = '# Added by anymux install-service.ps1: keep server alive without sessions'
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
  $config = Join-Path $env:TEMP "anymux-openssl-$PID.cnf"
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

# Ends the wrapper processes started with $Config and everything below them.
# The snapshot is taken before $Stop runs (it ends the wrapper), so the
# children of a wrapper that is already gone are still found.
function Stop-WrapperTree([string]$Wrapper, [string]$Config, [scriptblock]$Stop) {
  $all = @(Get-CimInstance Win32_Process)
  $roots = @($all | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -and $_.CommandLine.Contains($Wrapper) -and $_.CommandLine.Contains($Config) })
  & $Stop
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

# Stop-ScheduledTask ends the PowerShell wrapper; make sure the process it
# supervises (node or tmux) goes with it.
function Stop-TaskTree([string]$Name) {
  $task = Get-TaskOrNull $Name
  if (-not $task) { return }
  $wrapper = if ($Name -eq $PanelTask) { 'run-panel.ps1' } else { 'run-tmux-server.ps1' }
  Stop-WrapperTree $wrapper $ConfigFile { Stop-ScheduledTask -TaskPath $TaskPath -TaskName $Name -ErrorAction SilentlyContinue }
  # The wrapper starts tmux through setsid, and MSYS2's fork+exec leaves
  # tmux.exe without a live Windows parent, so the walk above cannot find it.
  # Ask the server itself to exit; the wrapper is gone and will not respawn it.
  if ($Name -eq $TmuxTask) {
    $tmux = Join-Path $Msys2Root 'usr\bin\tmux.exe'
    if (Test-Path -LiteralPath $tmux) {
      $previous = $env:MSYS
      $env:MSYS = 'noglob'
      $ErrorActionPreference = 'Continue'
      & $tmux kill-server *> $null
      $env:MSYS = $previous
    }
  }
}

function Start-Task([string]$Name) {
  if (-not (Get-TaskOrNull $Name)) { throw "Task $TaskPath$Name is not installed; run: install-service.ps1 install" }
  Start-ScheduledTask -TaskPath $TaskPath -TaskName $Name -ErrorAction Stop
}

function Get-LegacyTasks {
  @(Get-ScheduledTask -TaskPath $LegacyTaskPath -ErrorAction SilentlyContinue)
}

function Test-RealDirectory([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  return [bool]($item -and $item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))
}

# Replaces an installation made before the rename with the same one under the
# new names, keeping its settings. The panel restarts; the tmux server and its
# sessions keep running, as with `reload`: only the old tmux wrapper ends, and
# the new one finds the server and waits. The settings directory moves through
# scripts/migrate-legacy-dirs.mjs; a log the running tmux server holds open
# cannot move and stays behind until a later run (the panel then also writes
# its pairing file there for Hubs of the old version).
function Move-LegacyInstallation {
  $legacyTasks = @(Get-LegacyTasks)
  $legacyDir = Test-RealDirectory $LegacyConfigDir
  if ($legacyTasks.Count -eq 0 -and -not $legacyDir) { return $false }

  $saved = if (Test-Path -LiteralPath $LegacyConfigFile) { (Get-Content -Raw -Encoding UTF8 -LiteralPath $LegacyConfigFile | ConvertFrom-Json).nodeBin } else { $null }
  $node = if ($NodeBin) { Resolve-Node } elseif ($saved -and (Test-Path -LiteralPath $saved)) { $saved } else { Resolve-Node }
  # As for restart: a panel that cannot start must keep running.
  Assert-Dependencies $node

  # Not $panel or $tmuxTask: PowerShell names ignore case, and $TmuxTask is the script's.
  $legacyPanel = $legacyTasks | Where-Object { $_.TaskName -eq $LegacyName }
  $legacyTmux = $legacyTasks | Where-Object { $_.TaskName -eq $TmuxTask }
  $mode = $null
  foreach ($task in $legacyTasks) { $mode = if ($task.Principal.LogonType -eq 'S4U') { 'Startup' } else { 'Logon' } }

  if ($legacyTasks.Count -gt 0) {
    if (-not $mode) { $mode = 'Logon' }
    if ($mode -eq 'Startup' -and -not (Test-Elevated)) {
      throw 'Replacing the tmux-web-panel tasks (Startup trigger) needs an elevated PowerShell; nothing was changed.'
    }
    # Registered before anything stops: if this fails, the old tasks keep running untouched.
    Register-PanelTask $TmuxTask (Join-Path $ScriptsDir 'windows\run-tmux-server.ps1') 'tmux server (keep-alive for Anymux)' $mode
    Register-PanelTask $PanelTask (Join-Path $ScriptsDir 'windows\run-panel.ps1') 'Anymux' $mode
  }

  if ($legacyPanel) {
    Stop-WrapperTree 'run-panel.ps1' $LegacyConfigFile { Stop-ScheduledTask -TaskPath $LegacyTaskPath -TaskName $LegacyName -ErrorAction SilentlyContinue }
  }
  # Only the wrapper: tmux runs detached (setsid) and keeps its sessions.
  if ($legacyTmux) { Stop-ScheduledTask -TaskPath $LegacyTaskPath -TaskName $TmuxTask -ErrorAction SilentlyContinue }

  if ($legacyDir) {
    Invoke-Native { & $node (Join-Path $ScriptsDir 'migrate-legacy-dirs.mjs') 2>&1 | ForEach-Object { Write-Host "    $_" } }
  }
  if ($legacyTasks.Count -gt 0 -and -not (Test-Path -LiteralPath $ConfigFile)) {
    # Settings did not move: put the old tasks back rather than leave nothing running.
    foreach ($name in @($TmuxTask, $PanelTask)) { Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue }
    foreach ($task in $legacyTasks) { Start-ScheduledTask -TaskPath $LegacyTaskPath -TaskName $task.TaskName -ErrorAction SilentlyContinue }
    throw "Could not move $LegacyConfigFile to $ConfigFile; the tmux-web-panel tasks were restarted unchanged."
  }

  # Saved paths under the old directory now live under the new one.
  if (Test-Path -LiteralPath $ConfigFile) {
    $cfg = Get-Content -Raw -Encoding UTF8 -LiteralPath $ConfigFile | ConvertFrom-Json
    $changed = $false
    foreach ($key in @('logDir', 'tlsCert', 'tlsKey')) {
      $value = if ($cfg.PSObject.Properties[$key]) { [string]$cfg.$key } else { '' }
      if ($value -and $value.StartsWith($LegacyConfigDir, [StringComparison]::OrdinalIgnoreCase)) {
        $moved = $ConfigDir + $value.Substring($LegacyConfigDir.Length)
        if ($key -eq 'logDir' -or (Test-Path -LiteralPath $moved)) { $cfg.$key = $moved; $changed = $true }
      }
    }
    # Same file, so it keeps its owner-only ACL.
    if ($changed) { [IO.File]::WriteAllText($ConfigFile, ($cfg | ConvertTo-Json)) }
  }

  if ($legacyTasks.Count -gt 0) {
    foreach ($task in $legacyTasks) { Unregister-ScheduledTask -TaskPath $LegacyTaskPath -TaskName $task.TaskName -Confirm:$false }
    try {
      $scheduler = New-Object -ComObject Schedule.Service
      $scheduler.Connect()
      $scheduler.GetFolder('\').DeleteFolder($LegacyName, 0)
    } catch { Write-Warn "Could not remove the empty task folder $LegacyTaskPath" }
    Start-Task $TmuxTask
    Start-Task $PanelTask
    Write-Ok "Replaced $LegacyTaskPath tasks with $TaskPath$TmuxTask and $TaskPath$PanelTask ($mode trigger); tmux kept running"
  }

  if (Get-NetFirewallRule -DisplayName $LegacyName -ErrorAction SilentlyContinue) {
    if (Test-Elevated) {
      Get-NetFirewallRule -DisplayName $LegacyName | Set-NetFirewallRule -NewDisplayName $FirewallRule
      Write-Ok "Renamed firewall rule $LegacyName to $FirewallRule"
    } else {
      Write-Warn "Firewall rule '$LegacyName' keeps its name; rename it from an elevated prompt."
    }
  }
  return ($legacyTasks.Count -gt 0)
}

function Install-Service {
  $node = Resolve-Node
  $tmux = Resolve-Tmux
  Assert-Dependencies $node

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
    nodeOnly = [bool]$NodeOnly
  }
  # Replace the stored settings through a new owner-only file.
  Stop-TaskTree $PanelTask
  if (Test-Path -LiteralPath $ConfigFile) { Remove-Item -LiteralPath $ConfigFile -Force }
  New-Item -ItemType File -Path $ConfigFile | Out-Null
  Protect-File $ConfigFile
  [IO.File]::WriteAllText($ConfigFile, ($config | ConvertTo-Json))

  # Re-registering the tmux task must not end a running server and its sessions.
  $tmuxRunning = (Get-TaskOrNull $TmuxTask) -and (Get-TaskOrNull $TmuxTask).State -eq 'Running'
  Register-PanelTask $TmuxTask (Join-Path $PSScriptRoot 'windows\run-tmux-server.ps1') 'tmux server (keep-alive for Anymux)' $mode
  Register-PanelTask $PanelTask (Join-Path $PSScriptRoot 'windows\run-panel.ps1') 'Anymux' $mode
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

  # The base service is installed first. Optional component failure must not undo it.
  $component = Join-Path $PSScriptRoot 'install-mosh.ps1'
  if (Test-Path -LiteralPath $component) {
    $componentArgs = @('-NoProfile', '-NonInteractive', '-File', $component, '-Role', 'server', '-Msys2Root', $Msys2Root)
    if ($SkipMosh) { $componentArgs += '-SkipMosh' }
    try {
      Invoke-Native { & powershell.exe @componentArgs | ForEach-Object { Write-Host "$_" }; $script:MoshComponentExit = $LASTEXITCODE }
      if ($script:MoshComponentExit -ne 0) { Write-Warn 'Mosh preparation did not finish; the panel remains installed. Retry from component maintenance.' }
    } catch {
      Write-Host 'ANYMUX_COMPONENT_RESULT=failed'
      Write-Host 'ANYMUX_COMPONENT_REASON=component_check_failed'
      Write-Warn 'Mosh preparation failed; the panel remains installed. Retry scripts/install-mosh.ps1.'
    }
  } else {
    Write-Host 'ANYMUX_COMPONENT_RESULT=failed'
    Write-Host 'ANYMUX_COMPONENT_REASON=component_script_missing'
    Write-Warn 'Mosh installer is missing; the panel remains installed.'
  }
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

function Show-Status {
  foreach ($task in @(Get-LegacyTasks)) {
    Write-Host ("{0}{1}: {2} (installed before the rename; any other action replaces it)" -f $LegacyTaskPath, $task.TaskName, $task.State)
  }
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
# Replacing the old tasks starts the new ones; start/restart/reload then have nothing left to do.
$migrated = $false
if ($Action -in @('install', 'uninstall', 'start', 'stop', 'restart', 'reload')) { $migrated = [bool](Move-LegacyInstallation | Select-Object -Last 1) }
if ($migrated -and $Action -in @('start', 'restart', 'reload')) {
  Write-Ok "Both tasks were started under their new names; nothing else to $Action."
  exit 0
}
switch ($Action) {
  'install' { Install-Service }
  'uninstall' { Uninstall-Service }
  'start' {
    if (-not $Tmux) { Assert-Dependencies (Resolve-ServiceNode) }
    Start-Task $selected; Write-Ok "Started $selected"
  }
  'stop' { Stop-TaskTree $selected; Write-Ok "Stopped $selected" }
  'restart' {
    # Checked before stopping: a panel that cannot start must keep running.
    if (-not $Tmux) { Assert-Dependencies (Resolve-ServiceNode) }
    Stop-TaskTree $selected; Start-Task $selected; Write-Ok "Restarted $selected"
  }
  # A new run-tmux-server.ps1 without touching tmux: restart -Tmux would end the
  # server and every session. The new wrapper finds the server running and waits.
  'reload' {
    Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TmuxTask -ErrorAction SilentlyContinue
    Start-Task $TmuxTask
    Write-Ok "Reloaded the $TmuxTask wrapper; tmux was left running"
  }
  'status' { Show-Status }
  'logs' {
    $file = Join-Path $LogDir $(if ($Tmux) { 'tmux-server.log' } else { 'panel.log' })
    Get-Content -LiteralPath $file -Tail 50 -Wait -Encoding UTF8
  }
  'cert' { New-LocalCertificate | Out-Null }
  default { Get-Help $PSCommandPath -Detailed }
}
