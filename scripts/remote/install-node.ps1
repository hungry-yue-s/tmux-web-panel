# Installs tmux-web-panel on a Windows machine another panel manages over SSH.
#
# Not run directly: the managing panel uploads the source archive over SFTP,
# then runs this script with `powershell -EncodedCommand` (plain words in any
# login shell), with these variables prepended:
#   $TwpArchive  archive path relative to the profile (.cache/tmux-web-panel/panel.tgz)
#   $TwpPorts    ports to try for the panel, first free wins
#
# Result: scheduled tasks run the panel on 127.0.0.1 in node-only mode,
# reachable only through the managing panel's SSH tunnel. Lines starting with
# ">> " are progress steps; "TWP_RESULT=" is the final status.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Log([string]$Message) { Write-Output ">> $Message" }
function Done([string]$State) { Write-Output "TWP_RESULT=$State" }
function Fail([string]$Message) { Write-Output "!! $Message"; Done 'failed'; exit 1 }

# Native tools write progress to stderr; that must not abort the script. Their
# output goes to the host so the function's only result is the exit code.
function Native([scriptblock]$Block) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Block 2>&1 | ForEach-Object { Write-Host "$_" } } finally { $ErrorActionPreference = $previous }
  return $LASTEXITCODE
}

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

$Prefix = Join-Path $env:USERPROFILE '.local\share\tmux-web-panel'
$App = Join-Path $Prefix 'app'
$Archive = Join-Path $env:USERPROFILE $TwpArchive
if (-not (Test-Path -LiteralPath $Archive)) { Fail "archive missing: $TwpArchive" }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

function Ensure-Package([string]$Command, [string]$TestPath, [string]$WingetId) {
  if ($Command -and (Get-Command $Command -ErrorAction SilentlyContinue)) { return }
  if ($TestPath -and (Test-Path -LiteralPath $TestPath)) { return }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Fail "$WingetId is missing and winget is not available" }
  Log "winget install $WingetId"
  $scope = if ($elevated) { 'machine' } else { 'user' }
  $code = Native { winget install --id $WingetId -e --silent --scope $scope --accept-source-agreements --accept-package-agreements }
  Refresh-Path
  if ($Command -and -not (Get-Command $Command -ErrorAction SilentlyContinue) -and $code -ne 0) { Fail "could not install $WingetId" }
}

Refresh-Path
Ensure-Package 'node' $null 'OpenJS.NodeJS.LTS'
Ensure-Package $null 'C:\msys64\usr\bin\bash.exe' 'MSYS2.MSYS2'
$node = (Get-Command node).Source
$npm = Join-Path (Split-Path -Parent $node) 'npm.cmd'
Log ("node " + (& $node -v))

Log 'unpack panel'
New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
$next = "$App.new"
if (Test-Path -LiteralPath $next) { Remove-Item -Recurse -Force -LiteralPath $next }
New-Item -ItemType Directory -Force -Path $next | Out-Null
if ((Native { tar -xzf $Archive -C $next }) -ne 0) { Fail 'could not unpack the archive' }
if (Test-Path -LiteralPath $App) {
  # A running panel holds files open; stop it through its own installer first.
  $installer = Join-Path $App 'scripts\install-service.ps1'
  if (Test-Path -LiteralPath $installer) { Native { & powershell -NoProfile -ExecutionPolicy Bypass -File $installer stop } | Out-Null }
  Remove-Item -Recurse -Force -LiteralPath $App
}
Move-Item -LiteralPath $next -Destination $App

Log 'npm ci'
Push-Location $App
try {
  if ((Native { & $npm ci --omit=dev --no-audit --no-fund }) -ne 0) { Fail 'npm ci failed' }
} finally { Pop-Location }

$busy = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalPort })
$port = $null
foreach ($candidate in ($TwpPorts -split ' ')) {
  if ($candidate -and -not ($busy -contains [int]$candidate)) { $port = [int]$candidate; break }
}
if (-not $port) { Fail "no free port among: $TwpPorts" }

Log "install service on 127.0.0.1:$port"
$code = Native { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $App 'scripts\install-service.ps1') install -ListenHost 127.0.0.1 -Port $port -NodeOnly -NodeBin $node }
if ($code -ne 0) { Fail 'install-service.ps1 failed' }

Log 'wait for the pairing file'
$pairing = Join-Path $env:USERPROFILE '.config\tmux-web-panel\node.json'
for ($i = 0; $i -lt 30; $i++) {
  if (Test-Path -LiteralPath $pairing) { Done 'succeeded'; exit 0 }
  Start-Sleep -Seconds 1
}
Fail 'the panel service did not start (no pairing file)'
