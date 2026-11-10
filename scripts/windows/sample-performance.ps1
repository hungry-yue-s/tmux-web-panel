# One bounded diagnostic child, never a service or a tmux client. The caller
# owns stdout/log storage and stopping this process. No command lines are read.
param(
  [ValidateRange(1, 14400)][int]$DurationSeconds = 7200,
  [ValidateRange(3, 2147483647)][int]$IntervalSeconds = 5,
  [ValidateRange(0, 2147483647)][int]$ParentProcessId = 0
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$mutex = $null
$ownsLock = $false
try {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $mutex = New-Object Threading.Mutex($false, "Global\AnymuxWindowsSampler-$sid")
  try { $ownsLock = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsLock = $true }
  if (-not $ownsLock) {
    [Console]::Error.WriteLine('windows_sampler_already_running')
    exit 2
  }

  $parentStarted = $null
  if ($ParentProcessId -gt 0) {
    $parent = $null
    try {
      $parent = [Diagnostics.Process]::GetProcessById($ParentProcessId)
      $parentStarted = $parent.StartTime.ToUniversalTime().Ticks
    } catch {
      [Console]::Error.WriteLine('windows_sampler_parent_unavailable')
      exit 2
    } finally { if ($parent) { $parent.Dispose() } }
  }

  $names = @('node', 'tmux', 'conhost', 'ssh', 'sshd', 'claude', 'codex', 'git', 'bash', 'powershell', 'pwsh')
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $durationMs = [double]$DurationSeconds * 1000
  $intervalMs = [double]$IntervalSeconds * 1000
  $nextAtMs = 0
  $cpuCount = [Environment]::ProcessorCount
  $haveCpuSample = $false
  $previousProcesses = @{}
  $previousInterfaces = @{}

  while ($clock.Elapsed.TotalMilliseconds -lt $durationMs) {
    if ($ParentProcessId -gt 0) {
      $parent = $null
      try {
        $parent = [Diagnostics.Process]::GetProcessById($ParentProcessId)
        if ($parent.HasExited -or $parent.StartTime.ToUniversalTime().Ticks -ne $parentStarted) { break }
      } catch { break } finally { if ($parent) { $parent.Dispose() } }
    }

    $sampleStart = $clock.Elapsed.TotalMilliseconds
    $at = [DateTime]::UtcNow.ToString('o')
    $errors = New-Object 'Collections.Generic.List[string]'
    $cpuPercent = $null
    $memTotal = $null
    $memFree = $null
    try {
      $processors = @(Get-CimInstance Win32_Processor -Property LoadPercentage, NumberOfLogicalProcessors -OperationTimeoutSec 2 -ErrorAction Stop)
      $weight = 0
      $load = 0.0
      if (-not $processors.Count) { throw 'unavailable' }
      foreach ($processor in $processors) {
        if ($null -eq $processor.LoadPercentage) { throw 'unavailable' }
        $cores = [Math]::Max(1, [int]$processor.NumberOfLogicalProcessors)
        $weight += $cores
        $load += [double]$processor.LoadPercentage * $cores
      }
      $cpuCount = $weight
      if ($haveCpuSample) { $cpuPercent = [Math]::Round($load / $weight, 2) }
      $haveCpuSample = $true
    } catch { $errors.Add('cpu_unavailable') }
    try {
      $memory = Get-CimInstance Win32_OperatingSystem -Property TotalVisibleMemorySize, FreePhysicalMemory -OperationTimeoutSec 2 -ErrorAction Stop
      if ($null -eq $memory.TotalVisibleMemorySize -or $null -eq $memory.FreePhysicalMemory) { throw 'unavailable' }
      $memTotal = [long]$memory.TotalVisibleMemorySize * 1024
      $memFree = [long]$memory.FreePhysicalMemory * 1024
    } catch { $errors.Add('memory_unavailable') }

    $processRows = New-Object 'Collections.Generic.List[object]'
    $groups = @{}
    $nextProcesses = @{}
    try {
      foreach ($process in [Diagnostics.Process]::GetProcesses()) {
        try {
          $name = $process.ProcessName.ToLowerInvariant()
          if ($names -notcontains $name) { continue }
          $startedAt = $null
          $identity = $null
          $cpuSeconds = $null
          $rss = $null
          $processCpu = $null
          try {
            $started = $process.StartTime.ToUniversalTime()
            $startedAt = $started.ToString('o')
            $identity = '{0}:{1}' -f $process.Id, $started.Ticks
          } catch { $errors.Add('process_details_unavailable') }
          try { $cpuSeconds = $process.TotalProcessorTime.TotalSeconds } catch { $errors.Add('process_details_unavailable') }
          try { $rss = $process.WorkingSet64 } catch { $errors.Add('process_details_unavailable') }
          $measuredAt = $clock.Elapsed.TotalMilliseconds
          if ($identity -and $null -ne $cpuSeconds) {
            $old = $previousProcesses[$identity]
            if ($old -and $measuredAt -gt $old.at -and $cpuSeconds -ge $old.cpu) {
              $processCpu = [Math]::Round([Math]::Min([double]100, 100000 * ($cpuSeconds - $old.cpu) / (($measuredAt - $old.at) * $cpuCount)), 2)
            }
            $nextProcesses[$identity] = @{ cpu = $cpuSeconds; at = $measuredAt }
          }
          $processRows.Add([pscustomobject]@{
            pid = $process.Id; name = $name; startedAt = $startedAt
            cpuPercent = $processCpu; cpuSeconds = $cpuSeconds; rssBytes = $rss
          })
          if (-not $groups.ContainsKey($name)) { $groups[$name] = [pscustomobject]@{ name = $name; count = 0; rssBytes = 0L; cpuPercent = 0.0 } }
          $group = $groups[$name]
          $group.count++
          if ($null -eq $rss) { $group.rssBytes = $null } elseif ($null -ne $group.rssBytes) { $group.rssBytes += $rss }
          if ($null -eq $processCpu) { $group.cpuPercent = $null } elseif ($null -ne $group.cpuPercent) { $group.cpuPercent += $processCpu }
        } catch { $errors.Add('process_details_unavailable') } finally { $process.Dispose() }
      }
    } catch { $errors.Add('processes_unavailable') }
    $previousProcesses = $nextProcesses

    $interfaces = New-Object 'Collections.Generic.List[object]'
    $nextInterfaces = @{}
    try {
      foreach ($adapter in @(Get-NetAdapterStatistics -ErrorAction Stop)) {
        $rx = $null
        $tx = $null
        $rxBps = $null
        $txBps = $null
        $measuredAt = $clock.Elapsed.TotalMilliseconds
        if ($null -ne $adapter.ReceivedBytes) { $rx = [long]$adapter.ReceivedBytes }
        if ($null -ne $adapter.SentBytes) { $tx = [long]$adapter.SentBytes }
        $old = $previousInterfaces[$adapter.Name]
        if ($old -and $measuredAt -gt $old.at) {
          $seconds = ($measuredAt - $old.at) / 1000
          if ($null -ne $rx -and $null -ne $old.rx -and $rx -ge $old.rx) { $rxBps = [Math]::Round(($rx - $old.rx) / $seconds, 2) }
          if ($null -ne $tx -and $null -ne $old.tx -and $tx -ge $old.tx) { $txBps = [Math]::Round(($tx - $old.tx) / $seconds, 2) }
        }
        if ($null -eq $rx -or $null -eq $tx) { $errors.Add('network_counters_unavailable') }
        $nextInterfaces[$adapter.Name] = @{ rx = $rx; tx = $tx; at = $measuredAt }
        $interfaces.Add([pscustomobject]@{ name = $adapter.Name; receivedBytes = $rx; sentBytes = $tx; rxBps = $rxBps; txBps = $txBps })
      }
    } catch { $errors.Add('network_unavailable') }
    $previousInterfaces = $nextInterfaces

    $topProcesses = @($processRows.ToArray() | Sort-Object -Property @{ Expression = { if ($null -eq $_.cpuPercent) { -1 } else { $_.cpuPercent } }; Descending = $true }, @{ Expression = { $_.rssBytes }; Descending = $true } | Select-Object -First 60)
    $processGroups = @($groups.Values | Sort-Object name)
    $sampleErrors = @($errors | Select-Object -Unique)
    $elapsed = $clock.Elapsed.TotalMilliseconds
    $sample = [ordered]@{
      type = 'windows_sample'; at = $at
      sampleMs = [Math]::Round($elapsed - $sampleStart, 2)
      elapsedMs = [Math]::Round($elapsed, 2)
      loopLagMs = [Math]::Round([Math]::Max([double]0, $sampleStart - $nextAtMs), 2)
      cpuPercent = $cpuPercent; memTotalBytes = $memTotal; memFreeBytes = $memFree
      processes = $topProcesses; processGroups = $processGroups
      totalMatchingProcesses = $processRows.Count; truncated = $processRows.Count -gt 60
      interfaces = $interfaces.ToArray()
      errors = $sampleErrors
    }
    [Console]::Out.WriteLine(($sample | ConvertTo-Json -Depth 5 -Compress))
    # Skip missed ticks instead of overlapping samples or trying to catch up.
    $elapsed = $clock.Elapsed.TotalMilliseconds
    $nextAtMs = ([Math]::Floor($elapsed / $intervalMs) + 1) * $intervalMs
    $wait = [Math]::Min($nextAtMs - $elapsed, $durationMs - $elapsed)
    if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]$wait) }
  }
} catch {
  [Console]::Error.WriteLine('windows_sampler_failed')
  exit 1
} finally {
  if ($ownsLock) { $mutex.ReleaseMutex() }
  if ($mutex) { $mutex.Dispose() }
}
