import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertEncryptionKeyConfigured,
  decryptField,
  encryptField,
  looksEncrypted,
  FieldDecryptError,
  FIELD_CRYPTO_SALT_ID,
} from './fieldCrypto';

test('the legacy key-derivation salt is immutable across product renames', () => {
  assert.equal(FIELD_CRYPTO_SALT_ID, 'volley-application-profile');
});

// R-021: a missing or rotated ENCRYPTION_KEY made RoleQuick type base64 ciphertext into a real job
// application, silently. These pin the three parts of the fix: the boot gate, a decrypt failure
// that throws instead of returning garbage, and the shape test that tells a legacy plaintext row
// apart from a value the key can no longer read.

function withKey<T>(key: string | undefined, fn: () => T): T {
  const prev = process.env.ENCRYPTION_KEY;
  if (key === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = key;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = prev;
  }
}

test('a field round-trips under the same key', () => {
  withKey('test-key', () => {
    assert.equal(decryptField(encryptField('2026-07-18')), '2026-07-18');
    assert.equal(decryptField(encryptField('+971 50 123 4567')), '+971 50 123 4567');
  });
});

test('the boot gate refuses to start without ENCRYPTION_KEY', () => {
  withKey(undefined, () => {
    assert.throws(() => assertEncryptionKeyConfigured(), /ENCRYPTION_KEY not configured/);
  });
  withKey('test-key', () => {
    assert.doesNotThrow(() => assertEncryptionKeyConfigured());
  });
});

test('a rotated key throws rather than yielding garbage', () => {
  // The scenario fieldCrypto used to advertise as safe ("key rotation only means changing one env
  // var"). It is not safe, and the point of the fix is that it now fails loudly.
  const stored = withKey('original-key', () => encryptField('2026-07-18'));
  withKey('rotated-key', () => {
    assert.throws(() => decryptField(stored), FieldDecryptError);
  });
});

test('the real R-021 ciphertext reads as encrypted, not as legacy plaintext', () => {
  // Verbatim from the register: what RoleQuick actually typed into Proxima Fusion's required
  // "When are you available to start?" field. Reading this as plaintext is what shipped it.
  assert.equal(looksEncrypted('JralgwdTrv/2HCp1wcfOJFB9D8q4aNkP19peworH2yqNeSnKaYjP'), true);
});

test('every real stored plaintext reads as plaintext, so legacy rows still pass through', () => {
  // The passthrough for genuinely pre-encryption rows has to keep working. These are the actual
  // shapes of the encrypted columns (phone, city, country, citizenship, availability, salary, DOB).
  for (const plain of [
    '2026-07-18',
    '18/07/2026',
    '25/09/2005',
    '+971 50 123 4567',
    'Dubai',
    'United Arab Emirates',
    'Indian',
    'Negotiable, open to your standard intern rate',
    'Immediately',
    'EUR 18,000/yr',
    '14 weeks',
  ]) {
    assert.equal(looksEncrypted(plain), false, `"${plain}" must read as plaintext`);
  }
});

test('a short base64-alphabet plaintext is not mistaken for an envelope', () => {
  // 'Pune' is pure base64 charset and a clean multiple of 4, so only the length floor separates it
  // from ciphertext: it decodes to 3 bytes against a 28-byte iv+tag minimum.
  assert.equal(looksEncrypted('Pune'), false);
  assert.equal(looksEncrypted('Oslo'), false);
});

test('anything encryptField produces reads as encrypted', () => {
  withKey('test-key', () => {
    for (const plain of ['a', 'Dubai', '2026-07-18', 'Negotiable, open to your standard intern rate']) {
      assert.equal(looksEncrypted(encryptField(plain)), true, `ciphertext of "${plain}"`);
    }
  });
});

// Regression guard for the key cache, and the reason it must exist: per-call scrypt derivation
// produces BYTE-IDENTICAL output, so every correctness test above passes while throughput
// collapses ~90x (26 req/s and a p50 of 1898ms on GET /profile/application, against a local
// Postgres where the queries cost under a millisecond). Only timing catches it.
//
// The threshold is deliberately loose. One uncached scryptSync costs tens of ms at Node's
// defaults, so 200 operations uncached is multiple SECONDS - measured at 7546ms with the cache
// removed. Anything under a second proves the key is being reused; the exact figure is
// machine-dependent and not the point.
test('derives the key once, not per call (pins a 90x throughput regression)', () => {
  process.env.ENCRYPTION_KEY = 'perf-guard-key';
  encryptField('warm the cache'); // exclude the one legitimate derivation from the timing
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) decryptField(encryptField('Dubai'));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(
    ms < 1000,
    `200 crypto ops took ${ms.toFixed(0)}ms. That is the signature of scrypt running per call ` +
      `instead of once - check getKey()'s cache in fieldCrypto.ts.`,
  );
});
