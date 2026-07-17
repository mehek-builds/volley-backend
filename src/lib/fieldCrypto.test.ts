import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encryptField, decryptField } from './fieldCrypto';

process.env.ENCRYPTION_KEY ??= 'test-encryption-key-for-unit-tests';

describe('fieldCrypto', () => {
  test('round-trips a value', () => {
    assert.equal(decryptField(encryptField('+971 50 123 4567')), '+971 50 123 4567');
  });

  test('same plaintext encrypts differently each time (random IV), still decrypts', () => {
    const a = encryptField('Dubai');
    const b = encryptField('Dubai');
    assert.notEqual(a, b, 'a fixed IV would leak equality between rows');
    assert.equal(decryptField(a), 'Dubai');
    assert.equal(decryptField(b), 'Dubai');
  });

  test('a tampered ciphertext is rejected, not silently mis-decrypted', () => {
    // AES-GCM is authenticated; this is what makes a corrupt value throw rather than return junk.
    const enc = encryptField('India');
    const raw = Buffer.from(enc, 'base64');
    raw[raw.length - 1] ^= 0xff;
    assert.throws(() => decryptField(raw.toString('base64')));
  });

  test('handles unicode and long values', () => {
    const v = 'Zürich, Švýcarsko — ' + 'x'.repeat(200);
    assert.equal(decryptField(encryptField(v)), v);
  });

  // ---- the performance contract ----
  //
  // This is a REGRESSION GUARD, not a benchmark, and it exists because the bug it pins is
  // invisible to every functional test above: deriving the scrypt key per call produces
  // byte-identical output, so correctness tests all pass while throughput collapses ~90x.
  //
  // getKey() used to run scryptSync on EVERY encrypt and decrypt. scrypt is a password-hashing
  // KDF - deliberately slow and memory-hard - and scryptSync blocks the event loop, so one
  // GET /profile/application (~9 encrypted fields) paid ~9 blocking derivations and stalled every
  // other in-flight request. Measured: 26 req/s and a p50 of 1898ms, against a local Postgres
  // where the queries themselves cost under a millisecond. With the key cached: ~2300 req/s, p50
  // 17ms. Same bytes, 89x the throughput.
  //
  // The threshold is deliberately loose. A single uncached scryptSync at Node's defaults costs
  // tens of milliseconds, so 200 operations uncached is multiple SECONDS. Anything under a second
  // proves the key is being reused; the exact figure is machine-dependent and not the point.
  test('derives the key once, not per call (pins a 90x throughput regression)', () => {
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
});
