import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureDesktopCertificates, inspectDesktopCertificates } from '../scripts/desktop-certificates.mjs';

const run = promisify(execFile);
const ips = ['10.0.0.42'];
let temporary, seed, seedTLS;

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'tmux-panel-certificates-'));
  seed = join(temporary, 'seed');
  seedTLS = await ensureDesktopCertificates(seed, { run, ips });
}, 30000);
afterAll(async () => { await rm(temporary, { recursive: true, force: true }); });

async function fixture(name) {
  const root = join(temporary, name);
  await cp(seed, root, { recursive: true });
  const tls = Object.fromEntries(Object.entries(seedTLS).map(([key, path]) => [key, path.replace(seed, root)]));
  await writeFile(join(root, 'tls/current.json'), JSON.stringify(tls), { mode: 0o600 });
  return { root, tls };
}
async function contents(tls) {
  return Promise.all([readFile(tls.cert, 'utf8'), readFile(tls.key, 'utf8'), readFile(tls.ca, 'utf8')]);
}

// These checks use real RSA signing; allow slower developer machines and CI.
describe('desktop certificate lifecycle', { timeout: 30000 }, () => {
  it('creates verified certificates in private versioned directories', async () => {
    expect(await inspectDesktopCertificates(seedTLS, ips)).toMatchObject({ valid: true, addressesCurrent: true });
    expect(seedTLS.cert).toMatch(/\/tls\/leaves\/[^/]+\/cert\.pem$/);
    expect(seedTLS.ca).toBe(join(seed, 'tls/authority/ca.crt'));
    expect(JSON.parse(await readFile(join(seed, 'tls/current.json'), 'utf8'))).toEqual(seedTLS);
    expect((await stat(seedTLS.key)).mode & 0o777).toBe(0o600);
    expect((await stat(join(seed, 'tls/authority/ca.key'))).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(seedTLS.cert))).mode & 0o777).toBe(0o700);
    const certificate = new X509Certificate(await readFile(seedTLS.cert));
    expect(certificate.checkHost('localhost')).toBe('localhost');
    expect(certificate.checkIP('127.0.0.1')).toBe('127.0.0.1');
  });

  it('reuses a matching certificate without spawning OpenSSL', async () => {
    const { root, tls } = await fixture('reuse');
    const unused = vi.fn(() => { throw new Error('must not spawn'); });
    expect(await ensureDesktopCertificates(root, { run: unused, ips: [...ips, '127.0.0.1', ...ips] })).toEqual(tls);
    expect(unused).not.toHaveBeenCalled();
  });

  it('renews changed addresses without overwriting the old pair or CA', async () => {
    const { root, tls } = await fixture('changed-address');
    const before = await contents(tls);
    const next = await ensureDesktopCertificates(root, { run, ips: ['10.0.0.99'] });
    expect(next.cert).not.toBe(tls.cert);
    expect(next.ca).toBe(tls.ca);
    expect(await contents(tls)).toEqual(before);
    expect(await inspectDesktopCertificates(next, ['10.0.0.99'])).toMatchObject({ valid: true, addressesCurrent: true });
    expect(await inspectDesktopCertificates(next, ips)).toMatchObject({ valid: true, addressesCurrent: false });
  });

  it('leaves the current pair and pointer intact when signing fails, then permits retry', async () => {
    const { root, tls } = await fixture('failed-signing');
    const pointer = join(root, 'tls/current.json'), beforePointer = await readFile(pointer, 'utf8'), before = await contents(tls);
    const failedRun = async (file, args, options) => {
      if (args[0] === 'x509') throw new Error('simulated signing failure');
      return run(file, args, options);
    };
    await expect(ensureDesktopCertificates(root, { run: failedRun, ips: ['10.0.0.99'] })).rejects.toMatchObject({ code: 'TLS_GENERATION_FAILED' });
    expect(await readFile(pointer, 'utf8')).toBe(beforePointer);
    expect(await contents(tls)).toEqual(before);
    expect((await readdir(join(root, 'tls/leaves'))).filter(name => name.startsWith('.issue-'))).toEqual([]);
    expect(await inspectDesktopCertificates(tls, ips)).toMatchObject({ valid: true, addressesCurrent: true });
    expect(await inspectDesktopCertificates(await ensureDesktopCertificates(root, { run, ips: ['10.0.0.99'] }), ['10.0.0.99'])).toMatchObject({ valid: true, addressesCurrent: true });
  });

  it.each(['missing-key', 'missing-cert', 'broken-key', 'mismatched-key', 'missing-authority'])('rejects %s without replacing a previously trusted CA', async kind => {
    const { root, tls } = await fixture(kind);
    const authority = join(root, 'tls/authority'), key = join(authority, 'ca.key');
    const original = await readFile(tls.ca, 'utf8'), pointer = await readFile(join(root, 'tls/current.json'), 'utf8');
    if (kind === 'missing-key') await rm(key);
    if (kind === 'missing-cert') await rm(tls.ca);
    if (kind === 'missing-authority') await rm(authority, { recursive: true });
    if (kind === 'broken-key') await writeFile(key, 'broken key');
    if (kind === 'mismatched-key') await writeFile(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const unused = vi.fn();
    await expect(ensureDesktopCertificates(root, { run: unused, ips })).rejects.toMatchObject({ code: 'TLS_AUTHORITY_INVALID' });
    expect(unused).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'tls/current.json'), 'utf8')).toBe(pointer);
    if (!['missing-cert', 'missing-authority'].includes(kind)) expect(await readFile(tls.ca, 'utf8')).toBe(original);
  });

  it('does not silently rotate certificates from the earlier fixed-path layout', async () => {
    const root = join(temporary, 'legacy-layout');
    await cp(join(seed, 'tls/authority'), join(root, 'tls'), { recursive: true });
    const original = await readFile(join(root, 'tls/ca.crt'), 'utf8');
    await expect(ensureDesktopCertificates(root, { run, ips })).rejects.toMatchObject({ code: 'TLS_AUTHORITY_INVALID' });
    expect(await readFile(join(root, 'tls/ca.crt'), 'utf8')).toBe(original);
  });

  it('cleans an interrupted first CA generation and permits a fresh retry', async () => {
    const root = join(temporary, 'failed-authority');
    await expect(ensureDesktopCertificates(root, { run: async (_file, args) => {
      await writeFile(args[args.indexOf('-keyout') + 1], 'partially written key');
      throw new Error('failure');
    }, ips })).rejects.toMatchObject({ code: 'TLS_GENERATION_FAILED' });
    expect(await readdir(join(root, 'tls'))).toEqual([]);
    expect(await inspectDesktopCertificates(await ensureDesktopCertificates(root, { run, ips }), ips)).toMatchObject({ valid: true, addressesCurrent: true });
  });

  it('reports a mismatched private key using only read operations', async () => {
    const { root, tls } = await fixture('bad-leaf-key');
    await writeFile(tls.key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const before = await contents(tls), beforeStat = await stat(tls.key);
    expect(await inspectDesktopCertificates(tls, ips)).toMatchObject({ valid: false, addressesCurrent: true, message: 'HTTPS 证书与私钥不匹配。' });
    expect(await contents(tls)).toEqual(before);
    expect((await stat(tls.key)).mtimeMs).toBe(beforeStat.mtimeMs);
    const repaired = await ensureDesktopCertificates(root, { run, ips });
    expect(repaired.cert).not.toBe(tls.cert);
    expect(await inspectDesktopCertificates(repaired, ips)).toMatchObject({ valid: true, addressesCurrent: true });
  });

  it('will not replace a missing authority even if its current pointer is also lost', async () => {
    const { root } = await fixture('lost-authority-and-pointer');
    await rm(join(root, 'tls/authority'), { recursive: true });
    await rm(join(root, 'tls/current.json'));
    const unused = vi.fn();
    await expect(ensureDesktopCertificates(root, { run: unused, ips })).rejects.toMatchObject({ code: 'TLS_AUTHORITY_INVALID' });
    expect(unused).not.toHaveBeenCalled();
  });

  it('rejects a leaf with the wrong CA chain', async () => {
    const { tls } = await fixture('wrong-chain');
    const other = await ensureDesktopCertificates(join(temporary, 'other-ca'), { run, ips });
    expect(await inspectDesktopCertificates({ ...tls, ca: other.ca }, ips)).toMatchObject({ valid: false, addressesCurrent: true, message: 'HTTPS 证书不是由当前本地 CA 签发的。' });
  });

  it('renews a correctly paired certificate that expires within 30 days', async () => {
    const { root, tls } = await fixture('near-expiry');
    const csr = join(root, 'short.csr'), config = join(root, 'short.cnf');
    await writeFile(config, '[ext]\nbasicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost,IP:127.0.0.1,IP:10.0.0.42\n');
    await run('/usr/bin/openssl', ['req', '-new', '-key', tls.key, '-out', csr, '-subj', '/CN=localhost']);
    await run('/usr/bin/openssl', ['x509', '-req', '-in', csr, '-CA', tls.ca, '-CAkey', join(root, 'tls/authority/ca.key'), '-set_serial', '123', '-out', tls.cert, '-days', '1', '-sha256', '-extfile', config, '-extensions', 'ext']);
    expect(await inspectDesktopCertificates(tls, ips)).toMatchObject({ valid: false, addressesCurrent: true, message: 'HTTPS 证书无效、已到期或将在 30 天内到期。' });
    const next = await ensureDesktopCertificates(root, { run, ips });
    expect(next.cert).not.toBe(tls.cert);
    expect(await inspectDesktopCertificates(next, ips)).toMatchObject({ valid: true, addressesCurrent: true });
  });

  it('rejects configuration-injection addresses before creating anything', async () => {
    const root = join(temporary, 'invalid-address');
    await expect(ensureDesktopCertificates(root, { run, ips: ['1.2.3.4\nDNS.2=attacker.test'] })).rejects.toMatchObject({ code: 'TLS_ADDRESS_INVALID' });
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
