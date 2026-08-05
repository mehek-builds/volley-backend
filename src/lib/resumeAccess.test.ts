import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mintDownloadToken, readDownloadToken, resumePrefix, DOWNLOAD_TOKEN_TTL_MS } from './resumeAccess';

// getKey() reads this when a token is minted or read, not at import time, so setting it here
// is enough.
process.env.ENCRYPTION_KEY = 'test-encryption-key-at-least-32-chars-long';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const KEY = `${resumePrefix(USER)}abc123-1700000000000.pdf`;

test('a fresh token round-trips to the key and user it was minted for', () => {
  const payload = readDownloadToken(mintDownloadToken(USER, KEY));
  assert.ok(payload);
  assert.equal(payload.k, KEY);
  assert.equal(payload.u, USER);
});

test('the token is opaque: the object key never appears in it', () => {
  // The whole reason this is encrypted rather than signed. A readable payload would leak the
  // object key, and key + the blob store's stable base URL is permanent unauthenticated access
  // to the PDF - exactly the hole /resume/download exists to close.
  const token = mintDownloadToken(USER, KEY);
  assert.ok(!token.includes(USER));
  assert.ok(!token.includes('resumes'));
  assert.ok(!Buffer.from(token, 'base64url').toString('utf8').includes(USER));
});

test('a token past its expiry is refused', () => {
  const mintedAt = 1_700_000_000_000;
  const token = mintDownloadToken(USER, KEY, { now: mintedAt });
  assert.ok(readDownloadToken(token, mintedAt + DOWNLOAD_TOKEN_TTL_MS - 1000));
  assert.equal(readDownloadToken(token, mintedAt + DOWNLOAD_TOKEN_TTL_MS + 1000), null);
});

test('a token still works after a long hover-then-click pause', () => {
  // The token is minted on card `mouseenter` (the pre-warm) and not read until the student
  // clicks "Yes, fill it", and content.ts caches the generation promise per job, so this gap is
  // however long they take to read the posting. A window that expires here fails silently: the
  // fetch throws, the catch skips the file, and the application goes out with no resume. This
  // is the regression a 5-minute TTL shipped, so it is pinned.
  const hoveredAt = 1_700_000_000_000;
  const token = mintDownloadToken(USER, KEY, { now: hoveredAt });
  assert.ok(readDownloadToken(token, hoveredAt + 30 * 60 * 1000), '30 minutes after hover must still fill');
  assert.ok(readDownloadToken(token, hoveredAt + 55 * 60 * 1000), '55 minutes after hover must still fill');
});

test('an explicit ttl overrides the default window', () => {
  const mintedAt = 1_700_000_000_000;
  const token = mintDownloadToken(USER, KEY, { now: mintedAt, ttlMs: 10 * 60 * 1000 });
  // Alive inside its own shorter window, dead after it, while the default would still be live.
  assert.ok(readDownloadToken(token, mintedAt + 9 * 60 * 1000));
  assert.equal(readDownloadToken(token, mintedAt + 11 * 60 * 1000), null);
});

test('a tampered token is refused rather than trusted', () => {
  const token = mintDownloadToken(USER, KEY);
  const raw = Buffer.from(token, 'base64url');
  // Flip a ciphertext bit. GCM authenticates, so this must fail the tag check, not decrypt to
  // something attacker-chosen.
  raw[raw.length - 1] ^= 0x01;
  assert.equal(readDownloadToken(raw.toString('base64url')), null);
});

test('truncated, empty and garbage tokens are refused, not crashed on', () => {
  const token = mintDownloadToken(USER, KEY);
  assert.equal(readDownloadToken(''), null);
  assert.equal(readDownloadToken('not-a-token'), null);
  // iv + tag with no ciphertext: subarray would happily return empty buffers here.
  assert.equal(readDownloadToken(Buffer.alloc(28).toString('base64url')), null);
  assert.equal(readDownloadToken(token.slice(0, 20)), null);
});

test('a token minted under a different key is refused', () => {
  const token = mintDownloadToken(USER, KEY);
  const original = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = 'a-completely-different-key-32-chars-min';
  try {
    assert.equal(readDownloadToken(token), null);
  } finally {
    process.env.ENCRYPTION_KEY = original;
  }
});

test('a token whose key sits outside its own user prefix is refused', () => {
  // Defence in depth: mint never produces this, so a payload claiming one user and another
  // user's file means something upstream is wrong. Serve nothing rather than the wrong resume.
  const crossUserKey = `${resumePrefix(OTHER_USER)}abc123-1700000000000.pdf`;
  const token = mintDownloadToken(USER, crossUserKey);
  assert.equal(readDownloadToken(token), null);
});

test('resumePrefix is scoped per user and cannot collide across users', () => {
  assert.equal(resumePrefix(USER), `users/${USER}/resumes/`);
  assert.ok(!resumePrefix(USER).startsWith(resumePrefix(OTHER_USER)));
});

test('R-040: a token carries the blob URL through the seal and back', () => {
  const blobUrl = 'https://abc123xyz.public.blob.vercel-storage.com/users/x/resumes/abc-1-r4nd0m.pdf';
  const payload = readDownloadToken(mintDownloadToken(USER, KEY, { blobUrl }));
  assert.ok(payload);
  assert.equal(payload.b, blobUrl);
  // Still opaque: the URL must not be readable off the wire form.
  const token = mintDownloadToken(USER, KEY, { blobUrl });
  assert.ok(!Buffer.from(token, 'base64url').toString('utf8').includes('vercel-storage'));
});

test('R-040: tokens minted without a blob URL (pre-fix) still read cleanly', () => {
  const payload = readDownloadToken(mintDownloadToken(USER, KEY));
  assert.ok(payload);
  assert.equal(payload.b, undefined);
});

test('download tokens carry the intended resume filename through the seal', () => {
  const fileName = 'Mehek_Mandal_Product_Management_Intern_Resume.pdf';
  const payload = readDownloadToken(mintDownloadToken(USER, KEY, { fileName }));
  assert.ok(payload);
  assert.equal(payload.n, fileName);
  assert.ok(!Buffer.from(mintDownloadToken(USER, KEY, { fileName }), 'base64url').toString('utf8').includes(fileName));
});

test('R-040: a b that is not a Vercel Blob store URL is refused outright', () => {
  // The AEAD seal makes forgery a non-concern; this guards the mint path itself ever being
  // handed a foreign URL - the download route proxies b, so b must never name another host.
  const evil = mintDownloadToken(USER, KEY, { blobUrl: 'https://attacker.example.com/x.pdf' });
  assert.equal(readDownloadToken(evil), null);
  const notAUrl = mintDownloadToken(USER, KEY, { blobUrl: 'not a url' });
  assert.equal(readDownloadToken(notAUrl), null);
});
