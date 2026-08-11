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

// How long a filled-form preview screenshot is kept. These are full-page PNGs of a completed
// application, so one image carries the student's name, address, phone, work history and every
// free-text answer at once - the same PII class as a generated resume, at roughly twenty times
// the bytes (465 KB mean against 23 KB, measured over the whole store on 2026-08-11).
//
// The number is NOT a guess at how long the file is useful. A preview's functional lifetime is
// 55 MINUTES. submissionRunner stamps handoff_expires_at = now + HANDOFF_WINDOW_MS on every
// prepared packet, and that window is BROWSER_SESSION_TIMEOUT_SECONDS minus five minutes of
// slack, so it expires just before the Browserbase session the submit path needs in order to
// click anything. The dashboard folds handoffExpired straight into finalApprovalBlocked, so Send
// is already disabled by then. Measured against prod on 2026-08-11, all 295 packets holding a
// preview URL were past that expiry, so not one preview in the store could still be sent from.
//
// The window is set instead by the one surface that still reads a preview after expiry: the
// dashboard's "What the form looked like after we filled it in" card on a needs_attention
// packet, which is how a student sees why an application stalled. That card carries no Send
// button and degrades to a plain sentence when the image 404s, so an expired preview costs an
// explanation, not a flow. Seven days keeps that explanation across a normal week - 258 of the
// 265 stalled packets in prod were already older than a day, so a 24-hour window would blank
// essentially the whole queue - while holding the bulk PII to a quarter of the resume window.
export const SUBMISSION_PREVIEW_RETENTION_DAYS = 7;

// Every key shape this codebase writes under `users/`. The old policy was an allowlist of things
// to DELETE, which meant any new key shape defaulted to "keep forever, silently" - that default,
// not an oversight about screenshots specifically, is why 281.8 MB of form previews accumulated
// untouched. Classification is now total: a path this function does not recognise comes back
// 'unclassified', is still kept (deleting an unknown artifact is the worse mistake), and is
// counted and logged by the sweep so a new category announces itself on the first run after it
// ships rather than in a blob-store audit twenty days later.
export type UserBlobCategory =
  | 'legacy-original'
  | 'generated-resume'
  | 'submission-preview'
  | 'submission-receipt'
  | 'user-document'
  | 'unclassified';

const SUBMISSION_RUN_FILE_RE = /^users\/[^/]+\/submission-runs\/[^/]+\/([^/]+)$/;
const GENERATED_RESUME_RE = /^users\/[^/]+\/resumes\/[^/]+$/;
// Anchored for the same reason GENERATED_RESUME_RE is: putUserDocument builds exactly
// `users/<id>/documents/<uuid>.pdf` (lib/documentStore.ts, plus put()'s random suffix), so one
// segment is every real key and anything deeper is a shape nobody here has decided about.
const USER_DOCUMENT_RE = /^users\/[^/]+\/documents\/[^/]+$/;

export function classifyUserBlob(pathname: string): UserBlobCategory {
  if (isUploadedResumeBlob(pathname)) return 'legacy-original';
  const runFile = SUBMISSION_RUN_FILE_RE.exec(pathname)?.[1];
  if (runFile !== undefined) {
    // Every submission-run write passes addRandomSuffix: true (a retry reuses the run id, so the
    // un-suffixed key would collide and fail the run). The stored name is therefore
    // `filled-<hash>.png`, never the `filled.png` the call site asks for, and matching the bare
    // name would classify nothing that actually exists in the store.
    if (/^filled(?:-[^/]*)?\.png$/i.test(runFile)) return 'submission-preview';
    if (/^receipt(?:-[^/]*)?\.png$/i.test(runFile)) return 'submission-receipt';
    return 'unclassified';
  }
  // Anchored, where the old rule was a bare `pathname.includes('/resumes/')` substring test. That
  // test would classify `users/<id>/anything/resumes/x.png` as a generated resume and delete it at
  // 30 days, which would make the "an unrecognised shape is kept" guarantee above false for any
  // nested path that happens to contain the segment. Every real generated key is exactly one
  // segment under resumes/ (resume.ts, applications.ts and coverLetterService.ts all build
  // `users/<id>/resumes/<name>.pdf`, plus put()'s random suffix), so anchoring loses nothing and
  // sends anything else to 'unclassified', which is kept and logged rather than deleted.
  if (GENERATED_RESUME_RE.test(pathname)) return 'generated-resume';
  /* A FILE THE STUDENT ATTACHED HERSELF, and it is a named category rather than a fall-through.
   *
   * It already survived as 'unclassified', which returns null and keeps it, so this line changes no
   * file's fate today. It changes what the survival RESTS ON. 'unclassified' is an alarm, not a
   * policy: its own comment above says an unrecognised shape is kept and logged so that a new
   * category "announces itself on the first run after it ships", which means the next person to
   * decide what to do about unrecognised artifacts is expected to give that arm a window. Doing that
   * would delete every stored transcript, and the thing it would break is a published sentence -
   * trylitos.com/privacy: an attached file is encrypted and kept "until you remove it or delete your
   * account". A promise that holds only while nobody touches the default is not a promise.
   *
   * It also un-breaks the alarm. Every transcript in the store counted as unclassified, so the
   * sweep's "non-zero means a new key shape needs a decision" signal was permanently non-zero and
   * therefore permanently unreadable, and unclassifiedSample put user-id-bearing object keys into a
   * log line on every run. */
  if (USER_DOCUMENT_RE.test(pathname)) return 'user-document';
  return 'unclassified';
}

/**
 * Days after which a category ages out, or null when it is deliberately exempt from the age
 * sweep and only account deletion removes it.
 */
export function retentionDaysForCategory(
  category: UserBlobCategory,
  retentionDays = RESUME_RETENTION_DAYS,
  previewRetentionDays = SUBMISSION_PREVIEW_RETENTION_DAYS,
): number | null {
  switch (category) {
    // Legacy raw uploads are deleted on sight regardless of age; the approved cleanup already
    // took the last of them on 2026-08-03 and this keeps any straggler from surviving.
    case 'legacy-original': return 0;
    case 'generated-resume': return retentionDays;
    case 'submission-preview': return previewRetentionDays;
    // Deliberately exempt, not forgotten. A receipt is the product's proof-of-submission
    // surface: the dashboard renders it permanently under "Proof it was sent", and it is the
    // only durable visual evidence that Litos did the thing it promised - exactly the record a
    // student would want months later when asking whether an application really went. Ageing it
    // out would delete the answer to that question to reclaim 2.0 MB, 0.7% of the store. It stays
    // for as long as the account is open, which is what the privacy page already promises for
    // account-linked product data, and deleteBlobsForUser removes it on account deletion.
    case 'submission-receipt': return null;
    /* EXEMPT, AND A PUBLISHED SENTENCE DEPENDS ON THIS LINE. trylitos.com/privacy says of a file the
     * student attaches to an application herself: "We encrypt it and keep it until you remove it or
     * delete your account." A number here makes that false for every file older than it, silently,
     * with the student's own copy of the promise still on the page. The two ways out it names are
     * both built and both reach the file: DELETE /documents/:id (routes/documents.ts) removes one,
     * and deleteBlobsForUser takes the whole `users/<id>/` prefix on account deletion.
     *
     * This is NOT the receipt's argument reused. A receipt is exempt because Litos wants to keep
     * showing it; this one is exempt because Litos said it would. The difference matters if the
     * storage bill ever argues for a window: the receipt's exemption is a product call that could be
     * revisited, and this one cannot be revisited without changing the privacy page first. */
    case 'user-document': return null;
    case 'unclassified': return null;
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
 * Original uploads are deleted regardless of age. Every other category ages out on the window
 * retentionDaysForCategory gives it, and a null window means only account deletion reaches it.
 */
export function resumeBlobsDueForDeletion(
  blobs: StoredResumeBlob[],
  now = Date.now(),
  retentionDays = RESUME_RETENTION_DAYS,
  previewRetentionDays = SUBMISSION_PREVIEW_RETENTION_DAYS,
): StoredResumeBlob[] {
  return blobs.filter((blob) => {
    const days = retentionDaysForCategory(
      classifyUserBlob(blob.pathname),
      retentionDays,
      previewRetentionDays,
    );
    if (days === null) return false;
    // Zero means "on sight", which is NOT the same as "older than zero days": a strict age
    // comparison would spare a blob written in the same millisecond as the sweep, or any blob
    // whose uploadedAt is ahead of now under clock skew. Legacy originals are unconditional.
    if (days === 0) return true;
    return blob.uploadedAt.getTime() < now - days * 24 * 60 * 60 * 1000;
  });
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

// The two Blob calls this module makes, as an injectable seam. Narrowed to the surface actually
// consumed rather than restating @vercel/blob's types: `list` is generic over folded/expanded mode
// and its blobs carry size, etag and downloadUrl that nothing here reads, so a fake would have to
// fabricate fields only to satisfy the compiler.
export type BlobListPage = {
  blobs: Array<{ url: string; pathname: string; uploadedAt: Date }>;
  cursor?: string;
  hasMore: boolean;
};

export type ResumeBlobStore = {
  list: (options: { prefix: string; cursor?: string; limit: number }) => Promise<BlobListPage>;
  del: (urls: string[]) => Promise<void>;
};

const productionBlobStore: ResumeBlobStore = {
  list: (options) => list(options),
  del: (urls) => del(urls),
};

// @vercel/blob's del() rejects a batch above this size outright, so an oversized call deletes
// nothing and throws. It matters most on the run that carries a backlog, which is precisely the
// run that follows an outage like the one that stopped this sweep between 3 and 11 August.
const DELETE_BATCH_SIZE = 1000;

// del() takes at most DELETE_BATCH_SIZE URLs per call and rejects the whole batch
// above that, so EVERY caller has to chunk, not just the sweep. Account deletion is the one that
// matters most: it is the only thing that reaches an exempt receipt, so a single oversized call
// there would throw, leave the user's PII in the store, and break the promise the exemption rests
// on. Deleting per user is unbounded by age, so a long-lived heavy account is exactly where the
// limit gets hit first.
//
// The store is threaded through rather than closed over so that a test exercising the batching can
// count the calls: chunking is the kind of arithmetic that is only ever wrong at a boundary.
async function delInBatches(
  urls: string[],
  store: ResumeBlobStore = productionBlobStore,
): Promise<void> {
  for (let i = 0; i < urls.length; i += DELETE_BATCH_SIZE) {
    await store.del(urls.slice(i, i + DELETE_BATCH_SIZE));
  }
}

async function listAll(
  prefix: string,
  store: ResumeBlobStore = productionBlobStore,
): Promise<StoredResumeBlob[]> {
  const out: StoredResumeBlob[] = [];
  let cursor: string | undefined;
  do {
    const res = await store.list({ prefix, cursor, limit: 1000 });
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
  await delInBatches(blobs.map((b) => b.url));
  return blobs.length;
}

/** Delete legacy raw uploads for one user without touching generated application artifacts. */
export async function deleteUploadedResumeBlobsForUser(userId: string): Promise<number> {
  const blobs = (await listAll(userBlobPrefix(userId))).filter((blob) =>
    isUploadedResumeBlob(blob.pathname),
  );
  if (blobs.length === 0) return 0;
  await delInBatches(blobs.map((blob) => blob.url));
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

/**
 * Owner ids for the legacy originals among a set of deleted pathnames, deduplicated.
 *
 * Only legacy originals matter here. profiles.resume_object_key / resume_url point at the raw
 * upload under the user root; generated files under resumes/ are tracked in generated_resumes and
 * clearing a profile pointer for one of those would be scoping by coincidence.
 */
export function legacyOriginalOwnerIds(pathnames: string[]): string[] {
  const ids = new Set<string>();
  for (const pathname of pathnames) {
    if (!isUploadedResumeBlob(pathname)) continue;
    // isUploadedResumeBlob has already pinned the shape to users/<id>/resume*.pdf|docx.
    const userId = pathname.split('/')[1];
    if (userId) ids.add(userId);
  }
  return [...ids];
}

export interface BlobSweepResult {
  scanned: number;
  deleted: number;
  /** Deleted count per category, so a window change is visible in the logs the day it ships. */
  deletedByCategory: Record<UserBlobCategory, number>;
  /** Retained because nothing classified them. Non-zero means a new key shape needs a decision. */
  unclassified: number;
  /** A few offending paths, enough to identify the writer without dumping the store into a log. */
  unclassifiedSample: string[];
  /**
   * Pathnames actually handed to del(), so a caller can scope follow-up work to the owners whose
   * files really went. Deliberately not surfaced in the HTTP response: these keys embed user ids.
   */
  deletedPathnames: string[];
}

// Deletes legacy original uploads on sight, generated files after RESUME_RETENTION_DAYS, and
// filled-form previews after SUBMISSION_PREVIEW_RETENTION_DAYS. Receipts are exempt by decision, and
// files the student attached herself are exempt by published promise.
//
// blobStore exists because this is the only function in this file that permanently destroys user
// files, and it was the only one with no test: every retention test stubbed it out at the route
// boundary, so the cursor loop in listAll and the batching in delInBatches ran unexercised in CI
// and were first exercised in production. Overriding is partial, so a test can replace del alone
// and still page through a real listing fake.
export async function sweepExpiredResumeBlobs(
  opts: {
    now?: number;
    retentionDays?: number;
    previewRetentionDays?: number;
    blobStore?: Partial<ResumeBlobStore>;
  } = {},
): Promise<BlobSweepResult> {
  const now = opts.now ?? Date.now();
  const retentionDays = opts.retentionDays ?? RESUME_RETENTION_DAYS;
  const previewRetentionDays = opts.previewRetentionDays ?? SUBMISSION_PREVIEW_RETENTION_DAYS;
  const store: ResumeBlobStore = { ...productionBlobStore, ...opts.blobStore };
  const blobs = await listAll('users/', store);
  const due = resumeBlobsDueForDeletion(blobs, now, retentionDays, previewRetentionDays);
  await delInBatches(due.map((blob) => blob.url), store);
  const deletedByCategory: Record<UserBlobCategory, number> = {
    'legacy-original': 0,
    'generated-resume': 0,
    'submission-preview': 0,
    'submission-receipt': 0,
    'user-document': 0,
    unclassified: 0,
  };
  for (const blob of due) deletedByCategory[classifyUserBlob(blob.pathname)] += 1;
  const unclassified = blobs.filter((blob) => classifyUserBlob(blob.pathname) === 'unclassified');
  return {
    scanned: blobs.length,
    deleted: due.length,
    deletedByCategory,
    unclassified: unclassified.length,
    unclassifiedSample: unclassified.slice(0, 5).map((blob) => blob.pathname),
    deletedPathnames: due.map((blob) => blob.pathname),
  };
}
