import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/* Envelope encryption for the files a student attaches to an application herself.
 *
 * WHY THE FILE IS ENCRYPTED AT ALL, when the resume PDFs beside it are not. @vercel/blob can only
 * write `access: 'public'` on the version this repo is on - the type is that one literal, there is
 * no private-read or signed-URL API to upgrade to - so every object is permanently readable by
 * anyone who obtains its URL. The generated resume answers that with a short-lived capability token
 * plus a 30-day retention sweep, which bounds the exposure of a URL that leaks. A transcript can do
 * neither: it is kept until she removes it, deliberately, so the retention sweep never comes for it
 * (lib/resumeAccess.ts:61 excludes users/<id>/documents/ from both of its arms). Encrypting before
 * the write is what replaces that bound, and it is what makes the privacy page's "we encrypt it and
 * keep it until you remove it" a sentence the build actually honours rather than an intention.
 *
 * Litos never reads inside these bytes. No grade, no GPA, no text extraction, no parse of any kind:
 * the file goes to the employer's form exactly as she handed it over. Ciphertext is therefore not a
 * cost here, it is free, because nothing in the product ever wanted to look.
 */

// Frozen key-derivation salt, distinct from fieldCrypto's 'volley-application-profile' and from
// resumeAccess's 'rolequick-resume-download-token'. Same ENCRYPTION_KEY env var, different scrypt
// salt, following the domain-separation convention documented at lib/resumeAccess.ts:73: a document
// blob can never be decrypted by a download token's key, or an encrypted profile column by this
// one. Renaming it is data loss, in the same way FIELD_CRYPTO_SALT_ID is.
export const DOCUMENT_CRYPTO_SALT_ID = 'litos-user-document';

/* The value written to user_documents.encryption_scheme. A version string rather than a boolean, so
 * a future key rotation is a new value on new rows plus a reader that branches on it, rather than
 * another migration. fieldCrypto.ts:7 records what the absence of that versioning cost: with the
 * key baked into the derivation and nothing recording which key wrote a value, ENCRYPTION_KEY is
 * not rotatable at all, and a lost key put base64 ciphertext into a real job application. */
export const DOCUMENT_ENCRYPTION_SCHEME = 'aes-256-gcm.v1';

const IV_BYTES = 12;
const TAG_BYTES = 16;

// Cached for the life of the process, keyed on the secret. Not a micro-optimisation: scrypt is a
// password-hashing KDF, deliberately slow and memory-hard (~37ms and ~16MB per call at Node's
// defaults), and scryptSync BLOCKS THE EVENT LOOP, so it stalls every request in flight and not
// only its own. fieldCrypto.ts:31 has the measurement that established this (26 req/s to 2312
// req/s on one route). Sealing a document is one call per upload rather than nine per read, so the
// stake is smaller here, but a 4 MB upload is exactly the request least able to afford an extra
// synchronous stall. Caching is safe because scrypt is deterministic: same secret, same salt, same
// key. Still compared against the secret, so a rotated env var misses rather than silently serving
// a key it no longer matches.
let cachedKey: Buffer | null = null;
let cachedSecret: string | null = null;

function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error('ENCRYPTION_KEY not configured');
  if (cachedKey && cachedSecret === secret) return cachedKey;
  cachedKey = scryptSync(secret, DOCUMENT_CRYPTO_SALT_ID, 32);
  cachedSecret = secret;
  return cachedKey;
}

// A stored document that will not decrypt under the configured key. Distinct from a generic Error
// so the route layer can answer with a config error in its own wording, exactly as FieldDecryptError
// exists for. The one thing it must never become is "pass the bytes through anyway": that is how
// R-021 got base64 into an employer's form, and here it would attach ciphertext to an application
// under a filename that says transcript.pdf.
export class DocumentDecryptError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Stored document could not be decrypted with the configured ENCRYPTION_KEY');
    this.name = 'DocumentDecryptError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/* Format: iv(12) + authTag(16) + ciphertext, as raw bytes.
 *
 * RAW BYTES, NOT BASE64, unlike fieldCrypto and the download token - both of which encode because
 * they travel in a JSON column or a query string. This travels as a blob body, where an encoding
 * would buy nothing and cost 33% on every write, every fetch, and every buffer held in a serverless
 * function that gets 1 GB of memory and is already holding a resume PDF.
 *
 * WHAT IT IS NOT ABOUT IS THE MANAGED SANDBOX'S CEILING, and that is worth saying because an
 * earlier version of this comment said the opposite and the reasoning is easy to reconstruct
 * wrongly. The sandbox refuses an upload over 6,000,000 base64 characters, but what it encodes is
 * packet.transcript, and that buffer has already been through openDocument by the time any runner
 * sees it. The bytes measured against that ceiling are therefore the PLAINTEXT, and at the
 * 4,000,000-byte cap they encode to 5,333,336 characters - which is what clears it, and which stays
 * exactly 5,333,336 whatever shape this envelope is in at rest. Nothing about this format reaches a
 * runner at all. The at-rest encoding is a storage and transfer decision from end to end.
 */
export function sealDocument(plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

// Throws DocumentDecryptError for anything that is not a sealed document we wrote: truncated,
// tampered, or encrypted under a rotated key. GCM is authenticated, so a single flipped byte
// anywhere in the object fails here rather than producing a corrupt PDF that an employer's uploader
// accepts and a human later cannot open.
export function openDocument(sealed: Buffer): Buffer {
  // An iv and tag with no ciphertext is not a document. subarray would silently return an empty
  // buffer and the decipher would happily "succeed" on zero bytes, which is a 0-byte attachment.
  if (sealed.length <= IV_BYTES + TAG_BYTES) throw new DocumentDecryptError();
  // Derived OUTSIDE the try, unlike decryptField. A missing ENCRYPTION_KEY is a configuration
  // failure, and reporting it as "could not be decrypted with the configured ENCRYPTION_KEY" names
  // a key that does not exist and sends whoever reads it looking for a corrupt file. Conflating
  // those two is the confusion R-021 was made of.
  const key = getKey();
  const iv = sealed.subarray(0, IV_BYTES);
  const authTag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = sealed.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new DocumentDecryptError({ cause: err });
  }
}
