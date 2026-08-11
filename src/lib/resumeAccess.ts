import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { list, del } from '@vercel/blob';

// Generated resumes carry the student's full name, phone, address and work history, and
// @vercel/blob@0.27.3 can only write `access: 'public'` (the type is that one literal - there
// is no private-read or signed-URL API to upgrade to without changing infra). So the object
// itself is unavoidably readable by anyone holding its URL, forever. The mitigation is to
// never hand that URL out: the API mints a short-lived capability token instead, and
// /resume/download resolves it server-side. Combined with the retention sweep below, a blob
// URL that does leak is only reachable for as long as the file is meant to exist at all.
//
// The token is what authenticates the download, so it must not leak the underlying object key
// (key + the store's stable base URL = permanent unauthenticated access, which is exactly the
// hole we are closing). A signed-but-readable JWT would do precisely that, so the payload is
// AES-256-GCM encrypted rather than signed: GCM is authenticated, so this also serves as the
// signature, and the ciphertext is opaque to the holder.
//
// TTL is one hour, and the binding constraint is NOT how long a fill takes. The extension
// pre-warms /resume/generate on card `mouseenter` and caches the promise per job
// (`resumeGenByJob`, content.ts), so the token is minted when the student HOVERS the card and
// is not read until they click "Yes, fill it". That gap is unbounded in principle: hover, read
// the posting, take a call, come back and click. An earlier 5-minute window looked generous
// against a ~55s fill and was wrong for exactly this reason.
//
// Getting this too short fails SILENTLY and expensively: the content script's `fetch` throws,
// the catch skips the file, and the application submits with no resume attached and no error
// anyone sees. Getting it too long only widens the window on a link that was never written
// down anywhere. Those costs are wildly asymmetric, so this errs long. An hour also suits an
// export file the student saves and opens later, so both paths share it rather than keeping
// two constants that would drift.
export const DOWNLOAD_TOKEN_TTL_MS = 60 * 60 * 1000;

// How long a generated resume file is kept before the retention sweep deletes it. This is the
// only control that reaches blobs whose URL was already handed to a client before this change
// (and possibly into a browser history, a proxy log, or an ATS), since those URLs cannot be
// revoked. The spec row in generated_resumes is kept for audit; only the file goes.
export const RESUME_RETENTION_DAYS = 30;

/**
 * A packet's stored document is no longer in Blob storage, so the packet cannot be assembled.
 *
 * IT IS A TYPE RATHER THAN A BARE Error FOR ONE REASON. fail() reads its typed error family as "the
 * click provably did not happen" and ranks those above uncertainAfterClaim; anything untyped
 * inherits "the final submission was attempted, but Litos could not verify the employer
 * confirmation. Check the portal or your email", which sends someone hunting for a receipt that
 * cannot exist. That inheritance was not theoretical: buildPacket is called inside submit() as well
 * as inside prepare(), and the submit() call runs AFTER claimSubmission has set
 * submission_claimed_at. A packet whose file vanished between a successful prepare and its submit
 * therefore told the applicant to go looking for a confirmation of an application that was never
 * filled in, because the packet could not be built at all.
 *
 * THE USUAL CAUSE IS THIS MODULE'S OWN SWEEP, which is why the type lives here beside the constant
 * that causes it rather than beside the runner that throws it. RESUME_RETENTION_DAYS is 30, the
 * privacy page promises deletion at 30 days, and nothing re-derives a document at send time
 * (see submissionEducationGuard on the freeze). So a packet approved more than 30 days after it was
 * built has no file left to send, by design, and that is not a malfunction to apologise for.
 *
 * Measured against the prod Neon DB and the Blob store on 2026-08-11: no live packet was affected
 * yet, and the oldest approvable packet's resume blob was 20.1 days old, which puts the first real
 * occurrence around 2026-08-21. The sentence this error produces is what the applicant sees then.
 *
 * The message text is unchanged from the two bare throws this replaced, so existing logs and any
 * operator grep for it keep working.
 */
export class PacketDocumentExpiredError extends Error {
  /* Which document went missing. The resume is fatal to the packet; a cover letter is not, because
     packetForCoverLetterCapability degrades and sends the application without it. The runner needs
     to tell those two apart, and a single type with a discriminant keeps the retention reasoning in
     one place instead of splitting it across two near-identical classes. */
  readonly document: 'resume' | 'cover_letter';

  constructor(document: 'resume' | 'cover_letter') {
    super(`Generated ${document === 'resume' ? 'resume' : 'cover letter'} file is unavailable`);
    this.name = 'PacketDocumentExpiredError';
    this.document = document;
  }
}

export function resumePrefix(userId: string): string {
  return `users/${userId}/resumes/`;
}

export function userBlobPrefix(userId: string): string {
  return `users/${userId}/`;
}

export interface StoredResumeBlob {
  url: string;
  pathname: string;
  uploadedAt: Date;
}

/** Raw profile uploads used the user root. Generated files live below resumes/. */
export function isUploadedResumeBlob(pathname: string): boolean {
  return /^users\/[^/]+\/resume(?:-[^/]*)?\.(?:pdf|docx)$/i.test(pathname);
}

/**
 * Original uploads are deleted regardless of age. Generated files retain their approved window.
 */
export function resumeBlobsDueForDeletion(
  blobs: StoredResumeBlob[],
  now = Date.now(),
  retentionDays = RESUME_RETENTION_DAYS,
): StoredResumeBlob[] {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  return blobs.filter((blob) =>
    isUploadedResumeBlob(blob.pathname)
    || (blob.pathname.includes('/resumes/') && blob.uploadedAt.getTime() < cutoff),
  );
}

// Domain-separated from fieldCrypto's application_profile key: same ENCRYPTION_KEY env var,
// different scrypt salt, so a download token can never be confused with (or decrypt) an
// encrypted profile column.
function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error('ENCRYPTION_KEY not configured');
  return scryptSync(secret, 'rolequick-resume-download-token', 32);
}

export interface DownloadToken {
  /** Blob object key. */
  k: string;
  /** Owning user id. */
  u: string;
  /** Absolute expiry, ms since epoch. */
  exp: number;
  /**
   * Blob URL as assigned by put(), carried so the download route can do a direct point-read.
   * R-040: resolving the key via list({prefix}) is EVENTUALLY consistent with no bound - under
   * list lag a fresh resume 404s as "deleted" and the application ships resume-less (live-hit on
   * every Ashby fill of 2026-07-18, reproduced server-side at 54s after put). The URL exists at
   * mint time for free; the AEAD-sealed token is a safe place for it (never client-readable).
   * Optional so tokens minted by older code keep working through their 5-minute TTL.
   */
  b?: string;
  /** Download filename presented to the user. */
  n?: string;
}

// Format mirrors fieldCrypto: iv(12) + authTag(16) + ciphertext. base64url because this
// travels in a query string.
export function mintDownloadToken(
  userId: string,
  objectKey: string,
  opts: { ttlMs?: number; now?: number; blobUrl?: string; fileName?: string } = {},
): string {
  const now = opts.now ?? Date.now();
  const payload: DownloadToken = { k: objectKey, u: userId, exp: now + (opts.ttlMs ?? DOWNLOAD_TOKEN_TTL_MS) };
  if (opts.blobUrl) payload.b = opts.blobUrl;
  if (opts.fileName) payload.n = opts.fileName;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

// Returns null for anything that isn't a live token we minted: tampered, truncated, expired,
// or encrypted under a rotated key. Callers must treat null as 403 and never distinguish the
// cases to the caller - "why" is a probing oracle.
export function readDownloadToken(token: string, now = Date.now()): DownloadToken | null {
  try {
    const raw = Buffer.from(token, 'base64url');
    // iv + tag with no ciphertext is not a token; subarray would silently return empties.
    if (raw.length <= 28) return null;
    const iv = raw.subarray(0, 12);
    const authTag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(authTag);
    const json = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const payload = JSON.parse(json) as DownloadToken;
    if (typeof payload.k !== 'string' || typeof payload.u !== 'string' || typeof payload.exp !== 'number') {
      return null;
    }
    // The AEAD seal already makes b unforgeable, but a proxy target is exactly where belt and
    // suspenders is right: if b is present it must be a Vercel Blob store URL and nothing else.
    if (payload.b !== undefined) {
      if (typeof payload.b !== 'string') return null;
      try {
        const host = new URL(payload.b).hostname;
        if (!host.endsWith('.public.blob.vercel-storage.com')) return null;
      } catch {
        return null;
      }
    }
    if (payload.n !== undefined && typeof payload.n !== 'string') return null;
    if (now > payload.exp) return null;
    // Defence in depth: a token is only ever minted for a key inside its own user's prefix, so
    // a payload claiming otherwise means the key derivation or the mint path is compromised.
    // Refuse rather than serve one user's file under another's token.
    if (!payload.k.startsWith(resumePrefix(payload.u))) return null;
    return payload;
  } catch {
    return null;
  }
}

// The DB stores only the object key (generated_resumes.resume_object_key), not the blob URL, and
// @vercel/blob's head()/del() both want a URL. list({ prefix }) is the one way to get from key to
// URL without a schema migration, which is why this lookup exists at all.
//
// This only works because resume.ts stores the pathname `put()` ACTUALLY assigned rather than the
// one it asked for. `addRandomSuffix` defaults to true, so those differ, and storing the requested
// key made this return null for every resume ever generated - a 404 on every download, swallowed
// by the extension's catch, shipping applications with no resume and logging nothing.
export async function resolveBlobUrl(objectKey: string): Promise<string | null> {
  const { blobs } = await list({ prefix: objectKey, limit: 5 });
  return blobs.find((b) => b.pathname === objectKey)?.url ?? null;
}

async function listAll(prefix: string): Promise<StoredResumeBlob[]> {
  const out: StoredResumeBlob[] = [];
  let cursor: string | undefined;
  do {
    const res = await list({ prefix, cursor, limit: 1000 });
    out.push(...res.blobs.map((b) => ({ url: b.url, pathname: b.pathname, uploadedAt: b.uploadedAt })));
    cursor = res.hasMore ? res.cursor : undefined;
  } while (cursor);
  return out;
}

// Deletes every blob belonging to one user. MUST run before the user row is deleted:
// generated_resumes cascades on users.id, so dropping the user first destroys resume_object_key -
// the only pointer to these blobs - and orphans public PII files with no way left to find them.
//
// Scoped to the whole `users/<id>/` prefix rather than just `users/<id>/resumes/`, so that
// anything else ever written under a user is deleted with them by default. Older profile uploads
// were stored at `users/<id>/resume.pdf` or `.docx`, and the retention sweep removes those legacy
// originals. Keeping account deletion owner-scoped prevents any future category from being missed.
export async function deleteBlobsForUser(userId: string): Promise<number> {
  const blobs = await listAll(userBlobPrefix(userId));
  if (blobs.length === 0) return 0;
  await del(blobs.map((b) => b.url));
  return blobs.length;
}

/** Delete legacy raw uploads for one user without touching generated application artifacts. */
export async function deleteUploadedResumeBlobsForUser(userId: string): Promise<number> {
  const blobs = (await listAll(userBlobPrefix(userId))).filter((blob) =>
    isUploadedResumeBlob(blob.pathname),
  );
  if (blobs.length === 0) return 0;
  await del(blobs.map((blob) => blob.url));
  return blobs.length;
}

/**
 * Preserve the recovery pointer unless storage deletion succeeds. The callback boundary also
 * makes failure and retry ordering testable without a live Blob store or database.
 */
export async function deleteUploadedResumeThenClear(
  deleteUploadedResume: () => Promise<unknown>,
  clearLegacyPointers: () => Promise<unknown>,
): Promise<void> {
  await deleteUploadedResume();
  await clearLegacyPointers();
}

// Deletes legacy original uploads immediately and generated files after RESUME_RETENTION_DAYS.
export async function sweepExpiredResumeBlobs(
  now = Date.now(),
  retentionDays = RESUME_RETENTION_DAYS,
): Promise<{ scanned: number; deleted: number }> {
  const blobs = await listAll('users/');
  const due = resumeBlobsDueForDeletion(blobs, now, retentionDays);
  if (due.length > 0) await del(due.map((blob) => blob.url));
  return { scanned: blobs.length, deleted: due.length };
}
