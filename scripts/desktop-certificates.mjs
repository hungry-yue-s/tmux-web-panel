import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { isIP } from 'node:net';
import { createPrivateKey, createPublicKey, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const RENEW_BEFORE = 30 * 24 * 60 * 60 * 1000;

function failure(code, message, action, cause) {
  return Object.assign(new Error(message, { cause }), { code, action });
}
function normalizeIPs(ips = []) {
  const normalized = ['127.0.0.1', ...ips].map(ip => {
    if (typeof ip !== 'string' || !isIP(ip)) throw failure('TLS_ADDRESS_INVALID', '本地证书的 IP 地址格式不正确。', '请检查网络地址后重试。');
    return isIP(ip) === 6 ? new URL('http://[' + ip + ']').hostname.slice(1, -1) : ip;
  });
  return [...new Set(normalized)].sort();
}
function matchesKey(certificate, key) {
  return certificate.publicKey.export({ type: 'spki', format: 'der' }).equals(createPublicKey(createPrivateKey(key)).export({ type: 'spki', format: 'der' }));
}
function lifetime(certificate) {
  return Date.parse(certificate.validFrom) <= Date.now() && Date.parse(certificate.validTo) > Date.now() + RENEW_BEFORE;
}
function validAuthority(certificate) {
  return certificate.ca && certificate.checkIssued(certificate) && certificate.verify(certificate.publicKey) && lifetime(certificate);
}

// Polling status must never spawn OpenSSL, write files, or change the trust store.
export async function inspectDesktopCertificates(tls, ips = []) {
  let expiresAt, addressesCurrent = false;
  try {
    if (!tls?.cert || !tls?.key || !tls?.ca) return { valid: false, addressesCurrent, message: '尚未生成本地 HTTPS 证书。' };
    const expected = normalizeIPs(ips);
    const [certPEM, keyPEM, caPEM] = await Promise.all([readFile(tls.cert), readFile(tls.key), readFile(tls.ca)]);
    const certificate = new X509Certificate(certPEM), authority = new X509Certificate(caPEM);
    expiresAt = new Date(certificate.validTo).toISOString();
    const actual = normalizeIPs([...certificate.subjectAltName.matchAll(/(?:^|, )IP Address:([^,]+)/g)].map(match => match[1]));
    addressesCurrent = !!certificate.checkHost('localhost', { subject: 'never' }) &&
      expected.every(ip => certificate.checkIP(ip)) && JSON.stringify(actual) === JSON.stringify(expected);
    let message;
    if (!matchesKey(certificate, keyPEM)) message = 'HTTPS 证书与私钥不匹配。';
    else if (!validAuthority(authority)) message = '本地 CA 无效、已到期或将在 30 天内到期。';
    else if (certificate.ca || !certificate.checkIssued(authority) || !certificate.verify(authority.publicKey)) message = 'HTTPS 证书不是由当前本地 CA 签发的。';
    else if (!lifetime(certificate)) message = 'HTTPS 证书无效、已到期或将在 30 天内到期。';
    return { valid: !message, addressesCurrent, expiresAt, ...(message ? { message } : {}) };
  } catch (error) {
    return { valid: false, addressesCurrent, ...(expiresAt ? { expiresAt } : {}), message: error.code === 'TLS_ADDRESS_INVALID' ? error.message : 'HTTPS 证书或私钥缺失、无法读取或格式不正确。' };
  }
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function atomicJSON(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
async function openssl(run, args) {
  try { await run('/usr/bin/openssl', args, { timeout: 30000 }); }
  catch (cause) { throw failure('TLS_GENERATION_FAILED', '本地 HTTPS 证书签发失败，现有证书未被替换。', '请检查系统 OpenSSL、磁盘空间和目录权限后重试。', cause); }
}
async function authorityPair(tlsRoot, run) {
  const directory = join(tlsRoot, 'authority');
  const pair = { ca: join(directory, 'ca.crt'), key: join(directory, 'ca.key') };
  if (!await exists(directory)) {
    // A missing authority after initialization must not silently invalidate a trusted CA.
    if ((await Promise.all(['current.json', 'leaves', 'ca.crt', 'ca.key', 'cert.pem', 'key.pem'].map(name => exists(join(tlsRoot, name))))).some(Boolean)) {
      throw failure('TLS_AUTHORITY_INVALID', '原本地 CA 丢失或仍使用旧证书布局，未自动创建新 CA。', '请从备份恢复原 CA；保留现有证书，不要直接删除证书目录。');
    }
    const stage = join(tlsRoot, '.authority-' + randomUUID());
    await mkdir(stage, { mode: 0o700 });
    try {
      const config = join(stage, 'ca.cnf');
      await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Tmux Panel local CA\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n', { mode: 0o600 });
      await openssl(run, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650', '-keyout', join(stage, 'ca.key'), '-out', join(stage, 'ca.crt'), '-config', config]);
      await chmod(join(stage, 'ca.key'), 0o600);
      await chmod(join(stage, 'ca.crt'), 0o600);
      const certificate = new X509Certificate(await readFile(join(stage, 'ca.crt')));
      if (!validAuthority(certificate) || !matchesKey(certificate, await readFile(join(stage, 'ca.key')))) {
        throw failure('TLS_AUTHORITY_INVALID', '新生成的本地 CA 未通过验证。', '请检查系统时间与 OpenSSL 后重试。');
      }
      await rm(config);
      try { await rename(stage, directory); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  try {
    const info = await lstat(directory);
    const [ca, key] = await Promise.all([readFile(pair.ca), readFile(pair.key)]);
    const certificate = new X509Certificate(ca);
    if (!info.isDirectory() || info.isSymbolicLink() || !validAuthority(certificate) || !matchesKey(certificate, key)) throw new Error('invalid authority');
  } catch (cause) {
    throw failure('TLS_AUTHORITY_INVALID', '本地 CA 或其私钥缺失、损坏、不匹配或即将到期，未自动更换 CA。', '请从备份恢复原 CA，并检查系统时间；更换 CA 需要重新信任，不能静默完成。', cause);
  }
  return pair;
}

export async function ensureDesktopCertificates(root, { run = exec, ips = [] } = {}) {
  const expected = normalizeIPs(ips);
  const tlsRoot = join(resolve(root), 'tls'), leaves = join(tlsRoot, 'leaves');
  await mkdir(tlsRoot, { recursive: true, mode: 0o700 });
  await chmod(tlsRoot, 0o700);
  const authority = await authorityPair(tlsRoot, run);
  const pointer = join(tlsRoot, 'current.json');
  let current;
  try { current = JSON.parse(await readFile(pointer, 'utf8')); }
  catch (error) { if (error.code && error.code !== 'ENOENT') throw error; }
  if (current?.ca === authority.ca && typeof current.cert === 'string' && typeof current.key === 'string' && dirname(current.cert) === dirname(current.key) && dirname(dirname(current.cert)) === leaves) {
    const inspected = await inspectDesktopCertificates(current, expected);
    if (inspected.valid && inspected.addressesCurrent) return { cert: current.cert, key: current.key, ca: current.ca };
  }
  await mkdir(leaves, { recursive: true, mode: 0o700 });
  const id = randomUUID(), stage = join(leaves, '.issue-' + id), destination = join(leaves, id);
  await mkdir(stage, { mode: 0o700 });
  try {
    const config = join(stage, 'leaf.cnf'), csr = join(stage, 'leaf.csr');
    const staged = { cert: join(stage, 'cert.pem'), key: join(stage, 'key.pem'), ca: authority.ca };
    await writeFile(config, '[req]\ndistinguished_name=dn\nreq_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=@names\n[names]\nDNS.1=localhost\n' + expected.map((ip, i) => 'IP.' + (i + 1) + '=' + ip).join('\n') + '\n', { mode: 0o600 });
    await openssl(run, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', staged.key, '-out', csr, '-config', config]);
    await openssl(run, ['x509', '-req', '-in', csr, '-CA', authority.ca, '-CAkey', authority.key, '-set_serial', '0x' + randomBytes(16).toString('hex'), '-out', staged.cert, '-days', '365', '-sha256', '-extfile', config, '-extensions', 'ext']);
    await chmod(staged.key, 0o600);
    await chmod(staged.cert, 0o600);
    const inspected = await inspectDesktopCertificates(staged, expected);
    if (!inspected.valid || !inspected.addressesCurrent) throw failure('TLS_GENERATION_FAILED', '新签发的 HTTPS 证书未通过验证，现有证书未被替换。', '请检查系统时间与网络地址后重试。');
    await Promise.all([rm(config), rm(csr)]);
    await rename(stage, destination);
    const next = { cert: join(destination, 'cert.pem'), key: join(destination, 'key.pem'), ca: authority.ca };
    await atomicJSON(pointer, next);
    return next;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
