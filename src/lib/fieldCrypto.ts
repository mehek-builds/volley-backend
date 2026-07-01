import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// Column-level encryption for application_profile (Section 4 of PRD-v2: phone/address/
// work-authorization status is more sensitive than the outreach profile and must be
// encrypted at rest). ENCRYPTION_KEY is any secret string; scrypt derives a fixed-length
// AES key from it so key rotation only means changing one env var.
function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error('ENCRYPTION_KEY not configured');
  return scryptSync(secret, 'volley-application-profile', 32);
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
