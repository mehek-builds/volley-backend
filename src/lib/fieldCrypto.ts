import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// Column-level encryption for application_profile (Section 4 of PRD-v2: phone/address/
// work-authorization status is more sensitive than the outreach profile and must be
// encrypted at rest). ENCRYPTION_KEY is any secret string; scrypt derives a fixed-length
// AES key from it so key rotation only means changing one env var.

// The derived key, cached for the life of the process.
//
// This cache is not a micro-optimisation, it is the difference between the service standing up
// and falling over. scrypt is a PASSWORD-HASHING KDF: it is deliberately slow and memory-hard
// (~16MB and tens of ms per call at Node's defaults) because its job is to make brute-forcing a
// password expensive. Deriving inside every encryptField/decryptField call paid that cost
// per FIELD - GET /profile/application decrypts ~9 of them, so ~9 scrypts per request - and
// scryptSync is SYNCHRONOUS, so each one blocks the event loop and stalls every other request
// in flight, not just its own.
//
// Measured on a local Postgres, 400 users, 50-way concurrency:
//   before:  /profile/application  26 req/s,  p50 1898ms
//   after :  /profile/application  ~1450 req/s, p50 ~30ms
// while /me - the one authed route that touches no encrypted column - was 1521 req/s the whole
// time. The database was never the bottleneck; the KDF was.
//
// Caching is SAFE because scrypt is deterministic: the same secret and salt always derive the
// same key, so ciphertext and plaintext are byte-identical before and after. Keyed on the secret
// so a rotated ENCRYPTION_KEY still re-derives rather than serving a stale key.
let cachedKey: Buffer | null = null;
let cachedSecret: string | null = null;

function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error('ENCRYPTION_KEY not configured');
  if (cachedKey && cachedSecret === secret) return cachedKey;
  cachedKey = scryptSync(secret, 'volley-application-profile', 32);
  cachedSecret = secret;
  return cachedKey;
}

// Format: iv(12) + authTag(16) + ciphertext, all base64.
export function encryptField(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decryptField(encoded: string): string {
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
