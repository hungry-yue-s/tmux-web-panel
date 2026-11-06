import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = 'https://auth-alilang.alibaba-inc.com';
const APP_CODE = 'bc8a17bbfb2c386b7dedbbe24e4c9290';
const LIMIT = 32 * 1024 * 1024;
const QUERIES = [
  ['enterprise', 'auth/api/v1/tokenhub/packs.json'],
  ['qoder-ide', 'auth/api/v1/sm/qoder/quota/usage.json'],
];

function runCommand(file, args, { input, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
      timeout: 5000, killSignal: 'SIGKILL', ...options }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function varint(buffer, cursor) {
  let value = 0;
  for (let shift = 0; shift <= 49 && cursor.pos < buffer.length; shift += 7) {
    const byte = buffer[cursor.pos++];
    value += (byte & 127) * 2 ** shift;
    if (byte < 128 && Number.isSafeInteger(value)) return value;
  }
  throw new Error('Invalid LevelDB integer');
}

function snappy(buffer) {
  const cursor = { pos: 0 };
  const size = varint(buffer, cursor);
  if (size > LIMIT) throw new Error('LevelDB block exceeds limit');
  const output = Buffer.alloc(size);
  let written = 0;
  while (cursor.pos < buffer.length) {
    const tag = buffer[cursor.pos++];
    const kind = tag & 3;
    let length = tag >> 2;
    if (kind === 0) {
      if (length < 60) length++;
      else {
        const bytes = length - 59;
        length = buffer.readUIntLE(cursor.pos, bytes) + 1;
        cursor.pos += bytes;
      }
      if (cursor.pos + length > buffer.length || written + length > size) throw new Error('Invalid literal');
      buffer.copy(output, written, cursor.pos, cursor.pos + length);
      cursor.pos += length;
      written += length;
    } else {
      const bytes = kind === 1 ? 1 : kind === 2 ? 2 : 4;
      const offset = kind === 1 ? ((tag & 224) << 3) | buffer[cursor.pos]
        : buffer.readUIntLE(cursor.pos, bytes);
      length = kind === 1 ? 4 + ((tag >> 2) & 7) : length + 1;
      cursor.pos += bytes;
      if (offset <= 0 || offset > written || written + length > size) throw new Error('Invalid copy');
      for (let index = 0; index < length; index++) { output[written] = output[written - offset]; written++; }
    }
  }
  if (written !== size) throw new Error('Invalid block length');
  return output;
}

function block(buffer, offset, size) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0
    || offset + size + 5 > buffer.length) throw new Error('Invalid block range');
  const bytes = buffer.subarray(offset, offset + size);
  if (buffer[offset + size] === 0) return bytes;
  if (buffer[offset + size] === 1) return snappy(bytes);
  throw new Error('Unsupported block compression');
}

function* entries(buffer) {
  const end = buffer.length - 4 - 4 * buffer.readUInt32LE(buffer.length - 4);
  if (end < 0) throw new Error('Invalid block restarts');
  const cursor = { pos: 0 };
  let previous = Buffer.alloc(0);
  while (cursor.pos < end) {
    const shared = varint(buffer, cursor), extra = varint(buffer, cursor), size = varint(buffer, cursor);
    if (shared > previous.length || cursor.pos + extra + size > end) throw new Error('Invalid block entry');
    const key = Buffer.concat([previous.subarray(0, shared), buffer.subarray(cursor.pos, cursor.pos + extra)]);
    cursor.pos += extra;
    const value = buffer.subarray(cursor.pos, cursor.pos + size);
    cursor.pos += size;
    previous = key;
    yield [key, value];
  }
}

// Read only the two file-origin session fields. Never open or repair LevelDB.
async function localSession(home) {
  const directory = join(home, 'Library', 'Application Support', 'AliLang', 'Local Storage', 'leveldb');
  const values = new Map();
  const accept = (key, value, sequence, present = true) => {
    const separator = key.indexOf(0);
    if (key.subarray(0, separator).toString() !== '_file://') return;
    const name = key.subarray(separator + 2).toString('latin1');
    if (!['KEY_ACCESS_TOKEN', 'KEY_WORK_ID'].includes(name) || sequence <= (values.get(name)?.sequence ?? -1n)) return;
    values.set(name, { sequence, value: present && value.length
      ? value.subarray(1).toString(value[0] === 0 ? 'utf16le' : 'latin1') : null });
  };
  for (const file of await readdir(directory)) {
    if (!/^\d+\.(?:ldb|log)$/.test(file)) continue;
    try {
      const buffer = await readFile(join(directory, file));
      if (buffer.length > LIMIT) continue;
      if (file.endsWith('.ldb')) {
        if (buffer.length < 48 || buffer.readBigUInt64LE(buffer.length - 8) !== 0xdb4775248b80fb57n) continue;
        const footer = buffer.subarray(-48), cursor = { pos: 0 };
        varint(footer, cursor); varint(footer, cursor);
        const offset = varint(footer, cursor), size = varint(footer, cursor);
        for (const [, handle] of entries(block(buffer, offset, size))) {
          const at = { pos: 0 }, start = varint(handle, at), length = varint(handle, at);
          for (const [key, value] of entries(block(buffer, start, length))) {
            if (key.length < 8) continue;
            const tag = key.readBigUInt64LE(key.length - 8);
            accept(key.subarray(0, -8), value, tag >> 8n, (tag & 255n) === 1n);
          }
        }
      } else {
        let fragments = [];
        for (let base = 0; base < buffer.length; base += 32768) {
          const end = Math.min(base + 32768, buffer.length);
          for (let pos = base; pos + 7 <= end;) {
            const length = buffer.readUInt16LE(pos + 4), kind = buffer[pos + 6];
            pos += 7;
            if (pos + length > end) break;
            const data = buffer.subarray(pos, pos + length);
            pos += length;
            let record;
            if (kind === 1) record = data;
            else if ([2, 3, 4].includes(kind)) {
              if (kind === 2) fragments = [];
              fragments.push(data);
              if (kind !== 4) continue;
              record = Buffer.concat(fragments);
              fragments = [];
            } else continue;
            if (record.length < 12) continue;
            const sequence = record.readBigUInt64LE(0), count = record.readUInt32LE(8), at = { pos: 12 };
            for (let index = 0; index < count; index++) {
              const kind = record[at.pos++], keyLength = varint(record, at);
              const key = record.subarray(at.pos, at.pos + keyLength);
              at.pos += keyLength;
              const valueLength = kind === 1 ? varint(record, at) : 0;
              if (at.pos + valueLength > record.length || ![0, 1].includes(kind)) throw new Error('Invalid log entry');
              accept(key, record.subarray(at.pos, at.pos + valueLength), sequence + BigInt(index), kind === 1);
              at.pos += valueLength;
            }
          }
        }
      }
    } catch { /* A concurrently written or damaged file is not a reason to repair the application store. */ }
  }
  return { token: values.get('KEY_ACCESS_TOKEN')?.value, ownerId: values.get('KEY_WORK_ID')?.value };
}

function period(now) {
  const china = new Date(now + 8 * 3600_000);
  const year = china.getUTCFullYear(), month = china.getUTCMonth() - (china.getUTCDate() < 23 ? 1 : 0);
  const start = new Date(Date.UTC(year, month, 23)), end = new Date(Date.UTC(year, month + 1, 22));
  return { periodStart: start.toISOString().slice(0, 10), periodEnd: end.toISOString().slice(0, 10),
    resetsAt: (Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1) - 8 * 3600_000) / 1000,
    periodSource: 'interface-rule' };
}

function apiPeriod(data, fallback) {
  const valid = (date) => {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const parsed = Date.parse(`${date}T00:00:00Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date;
  };
  if (!valid(data?.cycleStartDate) || !valid(data?.cycleEndDate) || data.cycleStartDate > data.cycleEndDate) return fallback;
  return { periodStart: data.cycleStartDate, periodEnd: data.cycleEndDate,
    resetsAt: Date.parse(`${data.cycleEndDate}T00:00:00+08:00`) / 1000 + 86400, periodSource: 'api' };
}

const text = (value) => typeof value === 'string' && value.length <= 200 ? value : null;
const strings = (value) => Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))].slice(0, 100) : [];
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function usage(used, total, cycle) {
  return { unit: 'credits', usedCredits: used, totalCredits: total,
    remainingCredits: Math.max(0, total - used), usedPercent: total > 0 ? used / total * 100 : null, ...cycle };
}

function unwrap(body) {
  if (!body || body.success === false || (typeof body.code === 'number' && body.code !== 0)) throw new Error('Invalid quota response');
  const data = body.object ?? body.data;
  return data?.data && typeof data.data === 'object' ? data.data : data;
}

function enterprisePool(body, cycle) {
  const data = unwrap(body);
  if (!Array.isArray(data?.items) || data.items.length > 500) throw new Error('Invalid package list');
  cycle = apiPeriod(data, cycle);
  const packages = data.items.filter((entry) => entry && typeof entry === 'object').map((entry) => {
    const category = text(entry.category) || (entry.chargeType === 'wallet' ? 'activity' : 'default');
    const measured = number(entry.cycleUsedAmount) && number(entry.cycleAmountLimit);
    return { name: text(entry.teamName) || '集团资源包', category, chargeType: text(entry.chargeType),
      applications: strings(entry.appNames?.length ? entry.appNames : entry.appCodes),
      models: strings(entry.modeConfigList?.map((mode) => mode?.modeName)),
      usage: measured ? usage(entry.cycleUsedAmount, entry.cycleAmountLimit, apiPeriod(entry, cycle)) : null };
  });
  const measured = packages.filter((entry) => entry.usage && entry.chargeType !== 'free' && entry.category === 'default');
  const total = measured.reduce((sum, entry) => sum + entry.usage.totalCredits, 0);
  const used = measured.reduce((sum, entry) => sum + entry.usage.usedCredits, 0);
  if (!number(total) || !number(used)) throw new Error('Invalid aggregate quota');
  if (measured.length) {
    const first = measured[0].usage;
    cycle = measured.every((entry) => entry.usage.periodStart === first.periodStart && entry.usage.periodEnd === first.periodEnd)
      ? { periodStart: first.periodStart, periodEnd: first.periodEnd, resetsAt: first.resetsAt,
        periodSource: measured.every((entry) => entry.usage.periodSource === 'api') ? 'api' : 'interface-rule' }
      : { periodStart: null, periodEnd: null, resetsAt: null, periodSource: 'mixed' };
  }
  return { id: 'enterprise', name: '集团 AI 资源包', source: 'alilang-tokenhub', status: 'available',
    applications: strings(packages.flatMap((entry) => entry.applications)), packages,
    usage: measured.length ? usage(used, total, cycle) : null };
}

function qoderPool(body, cycle) {
  const data = unwrap(body);
  if (!number(data?.qoderUsedQuota) || !number(data?.qoderTotalQuota)) throw new Error('Invalid Qoder quota');
  return { id: 'qoder-ide', name: 'Qoder IDE 月额度', source: 'alilang-software', status: 'available',
    applications: ['Qoder IDE'], usage: usage(data.qoderUsedQuota, data.qoderTotalQuota, apiPeriod(data, cycle)) };
}

function curlValue(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function certificateTitle(metadata) {
  const hex = String(metadata).match(/"subj"<blob>=0x([a-f0-9]+)/i)?.[1];
  if (!hex || hex.length > 65536 || hex.length % 2) return null;
  const subject = Buffer.from(hex, 'hex');
  // Subject Title (OID 2.5.4.12), not Common Name. AliLang binds the title
  // to both employId and MDMSERVER + IOPlatformUUID before using an identity.
  let offset = subject.indexOf(Buffer.from('060355040c', 'hex'));
  if (offset < 0) return null;
  offset += 5;
  const tag = subject[offset++];
  let size = subject[offset++];
  if (size > 127) {
    const bytes = size & 127;
    if (!bytes || bytes > 3 || offset + bytes > subject.length) return null;
    size = subject.readUIntBE(offset, bytes);
    offset += bytes;
  }
  if (!Number.isInteger(size) || offset + size > subject.length || ![12, 19, 20, 22, 30].includes(tag)) return null;
  const value = subject.subarray(offset, offset + size);
  if (tag === 30 && size % 2) return null;
  return tag === 30 ? Buffer.from(value).swap16().toString('utf16le') : value.toString('utf8');
}

function transportFailure(result, metrics = {}) {
  const code = Number(metrics.exitCode ?? result.code) || null;
  const stderr = String(result.stderr || '');
  const connected = metrics.tcp > 0 || /Connected to /.test(stderr);
  const negotiated = metrics.tls > 0 || /SSL connection using/.test(stderr);
  if (code === 6) return { status: 'unavailable', stage: 'dns', reason: '无法解析阿里郎额度服务地址，请检查网络' };
  if (code === 7) return { status: 'unavailable', stage: 'connect', reason: '无法连接阿里郎额度服务，请检查网络' };
  if ([58, 77].includes(code)) return { status: 'needs-authorization', stage: 'client-certificate',
    reason: '无法使用现有集团客户端身份，请检查系统证书访问授权' };
  if (code === 60) return { status: 'unavailable', stage: 'server-certificate', reason: '阿里郎服务端证书验证失败，请检查系统信任与网络' };
  if (code === 28 || result.killed || result.signal || ['ETIMEDOUT', 'ECANCELED'].includes(result.code)) {
    if (connected && !negotiated) return { status: 'unavailable', stage: 'tls', manualRetryRequired: true,
      reason: '已连接阿里郎，但使用客户端证书建立 TLS 连接超时；如有系统证书访问提示，请处理后重试' };
    if (negotiated) return { status: 'unavailable', stage: 'response', reason: '阿里郎 TLS 连接已建立，但额度接口响应超时' };
    return { status: 'unavailable', stage: 'connect', manualRetryRequired: Boolean(result.killed || result.signal),
      reason: '额度查询进程超时，尚未获得完整连接诊断，请手动重试' };
  }
  return { status: 'unavailable', stage: 'tls', reason: '阿里郎额度连接失败，请检查客户端证书与网络' };
}

export function createAliLangUsageReader(options = {}) {
  const home = options.home || homedir(), platform = options.platform || process.platform;
  const appPath = options.appPath || '/Applications/AliLang.app';
  const run = options.runCommand || runCommand, readSession = options.readSession || (() => localSession(home));
  const now = options.now || Date.now, timeout = options.timeoutMs || 15_000;
  let paused = null, pending = null;

  async function read() {
    let version;
    try {
      const plist = await readFile(join(appPath, 'Contents', 'Info.plist'), 'utf8');
      version = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] || null;
    } catch { return { installed: false, version: null, status: 'unavailable', pools: [], reason: '未检测到本机阿里郎' }; }
    const fail = (status, reason, details = {}) => ({ installed: true, version, status, reason, pools: [], ...details });
    if (platform !== 'darwin') return fail('unavailable', '阿里郎额度读取需要本机 macOS 钥匙串身份');
    let session;
    try { session = await readSession(); } catch { return fail('login-required', '无法只读加载阿里郎登录态'); }
    if (![session?.token, session?.ownerId].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\r\n\0]/.test(value))) {
      return fail('login-required', '未读取到阿里郎当前用户的完整登录态');
    }
    let stage = 'identity';
    try {
      // Native SecItemCopyMatching does not apply ssl-client policy. That
      // policy filters out the actual AliLang identities on this machine.
      const identities = await run('/usr/bin/security', ['find-identity', '-p', 'basic']);
      const labels = [...new Set([...String(identities.stdout).matchAll(/^\s*\d+\)\s+[A-Fa-f0-9]{40}\s+"([^"\r\n]+)"/gm)]
        .map((match) => match[1]))].slice(0, 32);
      if (!labels.length) return fail('identity-unavailable', '未找到本机客户端身份，请在阿里郎刷新登录及证书后重试', { stage, manualRetryRequired: true });
      const hardware = await run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
      const uuid = String(hardware.stdout).match(/"IOPlatformUUID"\s*=\s*"([a-f0-9-]+)"/i)?.[1];
      if (!uuid) return fail('identity-unavailable', '无法确认本机设备标识，未选择客户端证书', { stage, manualRetryRequired: true });
      const eligible = [];
      for (const label of labels) {
        // Public certificate attributes only; never request PEM, P12, keys, ACL changes, or a private socket.
        const certificate = await run('/usr/bin/security', ['find-certificate', '-c', label]);
        const issuer = String(certificate.stdout).match(/"issu"<blob>=(.*)/)?.[1] || '';
        const hex = issuer.match(/0x([A-Fa-f0-9]+)/)?.[1];
        const parts = certificateTitle(certificate.stdout)?.split('|') || [];
        if (parts.length > 2 && parts[0] && session.ownerId.startsWith(parts[0]) && parts[1].startsWith(`MDMSERVER${uuid}`)
          && /alibaba|alipay|alilang/i.test(`${issuer} ${hex ? Buffer.from(hex, 'hex').toString() : ''}`)) {
          // As in the native selector, stop at the first employee/device-bound
          // identity. Multiple valid identities for this pair are normal.
          eligible.push(label);
          break;
        }
      }
      if (!eligible.length) return fail('identity-unavailable',
        '未找到与当前员工及本机设备匹配的阿里郎客户端身份，请在阿里郎刷新登录及证书后重试', { stage, manualRetryRequired: true });
      const config = QUERIES.map(([id, path], index) => {
        const params = id === 'enterprise'
          ? { tenantCode: '10000', accessToken: session.token, ownerId: session.ownerId,
            appCode: APP_CODE, osType: 'osx', language: 'zh', page_no: '1', page_size: '50' }
          : { tenantCode: '10000', accessToken: session.token, employee_no: session.ownerId,
            osType: 'osx', osPlatform: process.arch, visibilityLang: 'zh' };
        const url = `${ORIGIN}/${path}?${new URLSearchParams(params)}`;
        return [index ? 'next' : '', `url = ${curlValue(url)}`, `cert = ${curlValue(eligible[0].replaceAll(':', '\\:'))}`,
          'request = "GET"', 'silent', 'show-error', 'proto = "=https"', `connect-timeout = ${Math.ceil(timeout / 1000)}`,
          `max-time = ${Math.ceil(timeout / 1000)}`,
          `write-out = "\\nTMUX_ALILANG_RESULT:${id}:%{http_code}:%{exitcode}:%{time_namelookup}:%{time_connect}:%{time_appconnect}:%{time_starttransfer}:%{time_total}\\n"`].filter(Boolean).join('\n');
      }).join('\n');
      stage = 'request';
      // Each transfer has its own budget; leave time for curl to emit metrics
      // and retain a completed first response if the second transfer fails.
      const result = await run('/usr/bin/curl', ['-q', '--verbose', '--config', '-'], {
        input: config, timeout: timeout * QUERIES.length + 5000,
        env: { ...process.env, CURL_SSL_BACKEND: 'secure-transport' },
      }).catch((error) => error);
      const records = new Map();
      const marker = /\nTMUX_ALILANG_RESULT:(enterprise|qoder-ide):(\d{3})(?::(\d+):([\d.]+):([\d.]+):([\d.]+):([\d.]+):([\d.]+))?\n/g;
      let offset = 0;
      for (const match of String(result.stdout || '').matchAll(marker)) {
        const [id, httpStatus] = [match[1], Number(match[2])];
        const timings = Object.fromEntries(['dns', 'tcp', 'tls', 'firstByte', 'total'].map((key, index) => [key, Number(match[index + 4]) || 0]));
        records.set(id, { body: result.stdout.slice(offset, match.index), httpStatus,
          metrics: { exitCode: Number(match[3]) || 0, ...timings } });
        offset = match.index + match[0].length;
      }
      const pools = [];
      const diagnostics = [];
      let incomplete = false;
      for (const [id] of QUERIES) {
        const record = records.get(id);
        const { body = '', httpStatus = 0, metrics = {} } = record || {};
        let failure;
        if (httpStatus === 200) {
          try {
            pools.push((id === 'enterprise' ? enterprisePool : qoderPool)(JSON.parse(body), period(now())));
            diagnostics.push({ id, stage: 'complete', httpStatus, ...metrics });
            continue;
          } catch { failure = { status: 'unavailable', stage: 'response', reason: '阿里郎额度接口返回了无法识别的数据' }; }
        } else if (/No required SSL certificate was sent|SSL certificate error/i.test(body)) {
          failure = { status: 'needs-authorization', stage: 'client-certificate', reason: '额度服务未接受客户端证书，请检查现有集团身份及系统访问授权' };
        } else if (httpStatus === 401) failure = { status: 'login-required', stage: 'response', reason: '阿里郎额度登录态已失效，请重新登录阿里郎' };
        else if (httpStatus) failure = { status: 'unavailable', stage: 'response', reason: `阿里郎额度接口返回 HTTP ${httpStatus}` };
        else if (!record && incomplete) failure = { status: 'unavailable', stage: 'not-started', reason: '上一笔额度查询未完成，本次尚未查询' };
        else failure = transportFailure(result, metrics);
        if (!record) incomplete = true;
        diagnostics.push({ id, stage: failure.stage, httpStatus, ...metrics });
        pools.push({ id, name: id === 'enterprise' ? '集团 AI 资源包' : 'Qoder IDE 月额度', ...failure, usage: null });
      }
      const failure = pools.find((pool) => pool.status !== 'available');
      return { installed: true, version, status: pools.some((pool) => pool.status === 'available') ? 'available' : failure.status,
        reason: failure?.reason, manualRetryRequired: pools.some((pool) => pool.status === 'needs-authorization' || pool.manualRetryRequired),
        pools, diagnostics };
    } catch (error) {
      return fail('unavailable', stage === 'identity' ? '系统客户端身份查询未完成，请检查钥匙串状态后手动重试' : '额度查询未完成，请手动重试',
        { stage, manualRetryRequired: true });
    }
  }

  function reader() {
    if (paused) return Promise.resolve(paused);
    if (!pending) pending = read().then((result) => {
      if (result.status === 'needs-authorization' || result.manualRetryRequired) paused = result;
      return result;
    }).finally(() => { pending = null; });
    return pending;
  }
  reader.retry = () => { paused = null; return reader(); };
  return reader;
}
