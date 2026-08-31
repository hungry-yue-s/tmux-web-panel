/**
 * Remote metrics collector.
 *
 * A built-in read-only script is piped to a remote POSIX shell over stdin: no
 * agent is installed, nothing is written to the remote filesystem, and the
 * script only reads /proc, sysctl and df. The reply is a single versioned JSON
 * line so a partial or noisy shell cannot be mistaken for data.
 *
 * Fields that could not be read stay null and are reported as unsupported or
 * unavailable. A zero here would be a lie the UI cannot detect.
 *
 * Byte counts are printed with %.0f, never %d: several awk implementations use
 * 32-bit signed integers for %d and would silently cap a large machine's memory
 * or disk at 2147483647.
 */

import { AppError, ErrorCode } from '../servers/errors.js';

export const SCHEMA_VERSION = 1;
const MAX_OUTPUT_BYTES = 64 * 1024;
/** Sanity ceiling: ~16 EiB. Beyond this the value is a parse artefact. */
const MAX_BYTES = 2 ** 63;

/**
 * Linux probe. CPU needs two samples, so it sleeps briefly rather than
 * reporting a since-boot average. Only the first eight cpu fields are summed:
 * guest and guest_nice are already included in user and nice, and idle time is
 * idle plus iowait.
 */
export const LINUX_PROBE = `
read_cpu() {
  awk '/^cpu /{ t=$2+$3+$4+$5+$6+$7+$8+$9; i=$5+$6; printf "%.0f %.0f", t, i; exit }' /proc/stat 2>/dev/null
}
cpu1=$(read_cpu)
sleep 0.2
cpu2=$(read_cpu)
cpu_percent=$(echo "$cpu1 $cpu2" | awk '{ dt=$3-$1; di=$4-$2; if (dt>0) printf "%.1f", (dt-di)*100/dt; else printf "null" }')
[ -z "$cpu_percent" ] && cpu_percent=null
cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo null)
mem=$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} /^Cached:/{c=$2} END{ if (t>0) printf "%.0f %.0f %.0f", t*1024, (t-a)*1024, c*1024; else printf "null null null" }' /proc/meminfo 2>/dev/null)
[ -z "$mem" ] && mem="null null null"
load=$(awk '{printf "%s %s %s", $1, $2, $3}' /proc/loadavg 2>/dev/null)
[ -z "$load" ] && load="null null null"
up=$(awk '{printf "%.0f", $1}' /proc/uptime 2>/dev/null)
[ -z "$up" ] && up=null
disk=$(df -kP / 2>/dev/null | awk 'NR==2{ printf "%.0f %.0f", $2*1024, $3*1024 }')
[ -z "$disk" ] && disk="null null"
printf '{"schema":%d,"platform":"linux","cpuPercent":%s,"cpuCount":%s,"mem":"%s","load":"%s","uptime":%s,"disk":"%s"}\\n' \\
  ${SCHEMA_VERSION} "$cpu_percent" "$cores" "$mem" "$load" "$up" "$disk"
`.trim();

/**
 * Darwin probe: no /proc, so CPU comes from top's one-shot sample and memory
 * from vm_stat page counts.
 */
export const DARWIN_PROBE = `
cpu_percent=$(top -l 1 -n 0 2>/dev/null | awk '/CPU usage/{gsub("%","",$3); gsub("%","",$5); printf "%.1f", $3+$5; exit}')
[ -z "$cpu_percent" ] && cpu_percent=null
cores=$(sysctl -n hw.logicalcpu 2>/dev/null || echo null)
memtotal=$(sysctl -n hw.memsize 2>/dev/null || echo null)
pagesize=$(sysctl -n hw.pagesize 2>/dev/null || echo 4096)
memused=$(vm_stat 2>/dev/null | awk -v ps="$pagesize" '/Pages active/{a=$3} /Pages wired down/{w=$4} /Pages occupied by compressor/{c=$5} END{ gsub("\\\\.","",a); gsub("\\\\.","",w); gsub("\\\\.","",c); if (a!="") printf "%.0f", (a+w+c)*ps; else printf "null" }')
[ -z "$memused" ] && memused=null
memcached=$(vm_stat 2>/dev/null | awk -v ps="$pagesize" '/Pages purgeable/{p=$3} END{ gsub("\\\\.","",p); if (p!="") printf "%.0f", p*ps; else printf "null" }')
[ -z "$memcached" ] && memcached=null
load=$(sysctl -n vm.loadavg 2>/dev/null | awk '{printf "%s %s %s", $2, $3, $4}')
[ -z "$load" ] && load="null null null"
boot=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/.*sec = \\([0-9]*\\).*/\\1/p')
now=$(date +%s)
if [ -n "$boot" ]; then up=$((now-boot)); else up=null; fi
disk=$(df -kP / 2>/dev/null | awk 'NR==2{ printf "%.0f %.0f", $2*1024, $3*1024 }')
[ -z "$disk" ] && disk="null null"
printf '{"schema":%d,"platform":"darwin","cpuPercent":%s,"cpuCount":%s,"mem":"%s %s %s","load":"%s","uptime":%s,"disk":"%s"}\\n' \\
  ${SCHEMA_VERSION} "$cpu_percent" "$cores" "$memtotal" "$memused" "$memcached" "$load" "$up" "$disk"
`.trim();

function numberOrNull(value) {
  if (value === undefined || value === null || value === '' || value === 'null') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** Capacities and durations cannot be negative or absurd; bad input degrades to null. */
function nonNegative(value, { max = MAX_BYTES } = {}) {
  const parsed = numberOrNull(value);
  if (parsed === null || parsed < 0 || parsed > max) return null;
  return parsed;
}

function clampPercent(value) {
  const parsed = numberOrNull(value);
  if (parsed === null) return null;
  return Number(Math.min(100, Math.max(0, parsed)).toFixed(1));
}

function splitFields(value, count) {
  const parts = String(value ?? '').trim().split(/\s+/);
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(parts[i]);
  return out;
}

/**
 * Extracts the probe's JSON line. Login banners and shell noise are common, so
 * the last well-formed line carrying our schema wins.
 */
export function parseProbeOutput(stdout) {
  const text = String(stdout || '');
  if (text.length > MAX_OUTPUT_BYTES) {
    throw new AppError(ErrorCode.INTERNAL, 'Metrics probe returned too much output');
  }
  let found = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.schema === SCHEMA_VERSION) found = parsed;
    } catch {
      // Not our line.
    }
  }
  if (!found) throw new AppError(ErrorCode.INTERNAL, 'Metrics probe returned no usable data');
  return found;
}

/** Normalizes a raw probe payload into the API metrics shape. */
export function normalizeProbe(raw) {
  if (!raw || (raw.platform !== 'linux' && raw.platform !== 'darwin')) {
    throw new AppError(ErrorCode.INTERNAL, 'Metrics probe reported an unknown platform');
  }
  const platform = raw.platform;

  const [rawTotal, rawUsed, rawCached] = splitFields(raw.mem, 3);
  const memTotal = nonNegative(rawTotal);
  let memUsed = nonNegative(rawUsed);
  const memCached = nonNegative(rawCached);
  // Used above total means one of the two was misread; trust neither.
  if (memTotal !== null && memUsed !== null && memUsed > memTotal) memUsed = null;

  const [rawL1, rawL5, rawL15] = splitFields(raw.load, 3);
  const load1 = nonNegative(rawL1, { max: 1e6 });
  const load5 = nonNegative(rawL5, { max: 1e6 });
  const load15 = nonNegative(rawL15, { max: 1e6 });

  const [rawDiskTotal, rawDiskUsed] = splitFields(raw.disk, 2);
  const diskTotal = nonNegative(rawDiskTotal);
  let diskUsed = nonNegative(rawDiskUsed);
  if (diskTotal !== null && diskUsed !== null && diskUsed > diskTotal) diskUsed = null;

  const cpuPercent = clampPercent(raw.cpuPercent);
  const cpuCount = nonNegative(raw.cpuCount, { max: 4096 });
  const uptime = nonNegative(raw.uptime, { max: 1e12 });

  const memPercent = memTotal !== null && memUsed !== null && memTotal > 0
    ? clampPercent((memUsed / memTotal) * 100)
    : null;
  const diskPercent = diskTotal !== null && diskUsed !== null && diskTotal > 0
    ? clampPercent((diskUsed / diskTotal) * 100)
    : null;

  return {
    platform,
    cpuPercent,
    cpuCount,
    memTotal,
    memUsed,
    memCached,
    memPercent,
    load1,
    load5,
    load15,
    uptime,
    disk: diskTotal === null ? null : { total: diskTotal, used: diskUsed, percent: diskPercent },
    diskPercent,
    availability: {
      cpu: cpuPercent === null ? 'unavailable' : 'available',
      memory: memPercent === null ? 'unavailable' : 'available',
      disk: diskPercent === null ? 'unavailable' : 'available',
      load: load1 === null ? 'unavailable' : 'available',
      // Per-process detail over SSH is not in this version.
      processes: 'unsupported',
      diskIo: 'unsupported',
      swap: 'unsupported',
    },
  };
}

/**
 * Runs the read-only probe for a platform. Returns null when the platform is
 * not one we have a probe for, so the caller can report `unsupported` instead of
 * inventing numbers.
 */
export async function collectRemoteMetrics(executor, platform, { timeout = 12_000 } = {}) {
  const script = platform === 'darwin' ? DARWIN_PROBE : platform === 'linux' ? LINUX_PROBE : null;
  if (!script) return null;
  const { stdout } = await executor.runScript(script, { timeout, maxBuffer: MAX_OUTPUT_BYTES });
  return normalizeProbe(parseProbeOutput(stdout));
}
