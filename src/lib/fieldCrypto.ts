import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// Column-level encryption for application_profile (Section 4 of PRD-v2: phone/address/
// work-authorization status is more sensitive than the outreach profile and must be
// encrypted at rest).
//
// ENCRYPTION_KEY IS NOT ROTATABLE ON ITS OWN. This comment used to promise the opposite ("key
// rotation only means changing one env var"), and that promise is what made R-021 look safe:
// scrypt derives the AES key from the secret deterministically, so changing the secret makes every
// existing row undecryptable. Worse, a lost key did not fail loudly, it put base64 ciphertext into
// a real job application. Real rotation needs a key-version tag stored per value plus a
// re-encryption pass. Until that exists, this secret is permanent and losing it is data loss.

const KEY_SALT = 'volley-application-profile';
const IV_BYTES = 12;
const TAG_BYTES = 16;

// A stored value that looks like our envelope but will not decrypt under the configured key.
// Distinct from a generic Error so the route layer can answer with a config error of its own
// wording rather than let the global error handler echo `error.message` back to the client.
export class FieldDecryptError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Stored value could not be decrypted with the configured ENCRYPTION_KEY');
    this.name = 'FieldDecryptError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error('ENCRYPTION_KEY not configured');
  return scryptSync(secret, KEY_SALT, 32);
}

// Boot gate (R-021). A missing key is a CONFIG error and must surface at startup, never later as a
// decrypt failure that a catch downstream mistakes for legacy data. That mistake is exactly how
// ciphertext reached a real employer.
//
// Called from buildApp(), which is the one path every entrypoint shares. A gate in start() would
// not protect prod at all: on Vercel `start()` is skipped and the app is built per-invocation from
// api/index.ts.
export function assertEncryptionKeyConfigured(): void {
  getKey();
}

// Does this value look like OUR envelope (iv + authTag + ciphertext, base64), rather than a legacy
// plaintext row written before encryption existed?
//
// This is the discriminator R-021 turned on. `decryptField` throwing cannot by itself tell "this is
// old plaintext, pass it through" from "the key is wrong and this is ciphertext" - and passing the
// second case through is how base64 garbage gets typed into an application. The test is strict on
// purpose, and the real stored values miss it by a wide margin: "2026-07-18" and "+971 50 123 4567"
// fail on charset (no `-`, `:` or space in base64), "Dubai" decodes to 3 bytes against a 28-byte
// floor, and "Negotiable, open to your standard intern rate" fails on both. A value that wrongly
// looked encrypted would now 500 rather than emit garbage, which is the direction this bug says to
// fail in.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function looksEncrypted(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (!BASE64_RE.test(value)) return false;
  // Must carry a full iv and auth tag plus at least one byte of ciphertext.
  return Buffer.from(value, 'base64').length > IV_BYTES + TAG_BYTES;
}

// Format: iv(12) + authTag(16) + ciphertext, all base64.
export function encryptField(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

// Throws FieldDecryptError when the value will not decrypt under the configured key. Callers must
// NOT treat that as "legacy plaintext" and pass the value through: gate on looksEncrypted() first,
// and treat a failure after that as the config error it is.
export function decryptField(encoded: string): string {
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, IV_BYTES);
  const authTag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new FieldDecryptError({ cause: err });
  }
}
