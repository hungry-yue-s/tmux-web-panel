import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateSecret,
  totpCode,
  verifyTotp,
  otpauthUri,
  loadTotpSecret,
  enrollTotp,
} from '../server/totp.js';

// RFC 6238 Appendix B secret ("12345678901234567890" in base32).
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totpCode', () => {
  it('matches the RFC 6238 SHA-1 vector at T=59s', () => {
    // RFC gives 94287082 at 8 digits; the 6-digit form is mod 1e6 of the same
    // truncated integer.
    expect(totpCode(RFC_SECRET, 1)).toBe('287082');
  });

  it('is deterministic per step and zero-padded to 6 digits', () => {
    const code = totpCode(RFC_SECRET, 1111111109);
    expect(code).toMatch(/^\d{6}$/);
    expect(code).toBe(totpCode(RFC_SECRET, 1111111109));
  });
});

describe('verifyTotp', () => {
  it('accepts the current code', () => {
    const secret = generateSecret();
    expect(verifyTotp(secret, totpCode(secret))).toBe(true);
  });

  it('accepts a code from one step ago (clock skew window)', () => {
    const secret = generateSecret();
    const previous = totpCode(secret, Math.floor(Date.now() / 1000 / 30) - 1);
    expect(verifyTotp(secret, previous)).toBe(true);
  });

  it('rejects a wrong code', () => {
    const secret = generateSecret();
    const code = totpCode(secret);
    const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
    expect(verifyTotp(secret, wrong)).toBe(false);
  });

  it.each(['', '12345', '1234567', 'abcdef', '12ab56'])(
    'rejects malformed input %j',
    (bad) => {
      expect(verifyTotp(generateSecret(), bad)).toBe(false);
    },
  );
});

describe('generateSecret / otpauthUri', () => {
  it('produces distinct base32 secrets', () => {
    expect(generateSecret()).not.toBe(generateSecret());
    expect(generateSecret()).toMatch(/^[A-Z2-7]+$/);
  });

  it('builds a scannable otpauth URI carrying the secret', () => {
    const secret = generateSecret();
    const uri = otpauthUri(secret, 'me@example.com');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('enrolment file', () => {
  it('writes the secret owner-only and reads it back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'totp-'));
    const path = join(dir, 'totp.json');
    try {
      const secret = enrollTotp(path);
      expect(loadTotpSecret(path)).toBe(secret);
      // 0600: no group/other bits at all.
      expect(statSync(path).mode & 0o077).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no secret is enrolled', () => {
    expect(loadTotpSecret(join(tmpdir(), 'definitely-missing-totp.json'))).toBeNull();
  });
});
