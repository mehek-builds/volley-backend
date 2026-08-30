import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  classifyUserBlob,
  deleteUploadedResumeThenClear,
  isUploadedResumeBlob,
  legacyOriginalOwnerIds,
  resumeBlobsDueForDeletion,
  retentionDaysForCategory,
  sweepExpiredResumeBlobs,
  userBlobPrefix,
  type BlobListPage,
  type ResumeBlobStore,
  type StoredResumeBlob,
  type UserBlobCategory,
} from './resumeAccess';

const now = Date.parse('2026-08-03T12:00:00Z');
const blob = (pathname: string, ageDays: number): StoredResumeBlob => ({
  pathname,
  url: `https://store.public.blob.vercel-storage.com/${pathname}`,
  uploadedAt: new Date(now - ageDays * 24 * 60 * 60 * 1000),
});

test('raw PDF and DOCX uploads are deletion candidates immediately', () => {
  for (const pathname of [
    'users/user-1/resume.pdf',
    'users/user-1/resume.docx',
    'users/user-1/resume-random-token.pdf',
    'users/user-1/resume-random-token.docx',
  ]) {
    assert.equal(isUploadedResumeBlob(pathname), true, pathname);
    assert.deepEqual(resumeBlobsDueForDeletion([blob(pathname, 0)], now), [blob(pathname, 0)]);
  }
});

test('fresh generated files survive while expired generated files are deleted', () => {
  const fresh = blob('users/user-1/resumes/application.pdf', 2);
  const expired = blob('users/user-1/resumes/old-application.pdf', 31);
  assert.deepEqual(resumeBlobsDueForDeletion([fresh, expired], now), [expired]);
});

// This test previously asserted the opposite - that a 31-day-old filled-form preview survives -
// which is how 279.7 MB of screenshots carrying names, addresses and work histories came to sit
// in the store untouched with a passing suite. The assertion documented the gap instead of
// catching it.
test('filled-form previews age out on their own shorter window', () => {
  const fresh = blob('users/user-1/submission-runs/run-1/filled-abc123.png', 6);
  const expired = blob('users/user-1/submission-runs/run-2/filled-def456.png', 8);
  assert.deepEqual(resumeBlobsDueForDeletion([fresh, expired], now), [expired]);
});

// addRandomSuffix: true on every submission-run write, so the un-suffixed name the call site
// asks for is not what lands in the store. A rule written against `filled.png` would match
// nothing real, which is the one way this fix could ship and still delete nothing.
test('preview classification survives the random suffix that Blob actually assigns', () => {
  assert.equal(classifyUserBlob('users/u/submission-runs/r/filled-abc123.png'), 'submission-preview');
  assert.equal(classifyUserBlob('users/u/submission-runs/r/filled.png'), 'submission-preview');
  assert.equal(classifyUserBlob('users/u/submission-runs/r/receipt-abc123.png'), 'submission-receipt');
  assert.equal(classifyUserBlob('users/u/submission-runs/r/receipt.png'), 'submission-receipt');
});

// Deleting a receipt to save 2.0 MB would destroy the dashboard's permanent "Proof it was sent"
// image, which is the only durable evidence the product did what it promised. Exempt on purpose.
test('submission receipts are never aged out by the sweep', () => {
  const ancient = blob('users/user-1/submission-runs/run-1/receipt-abc123.png', 400);
  assert.deepEqual(resumeBlobsDueForDeletion([ancient], now), []);
  assert.equal(retentionDaysForCategory('submission-receipt'), null);
});

// The old policy was an allowlist of things to delete, so a new key shape defaulted to "kept
// forever, and nobody finds out". Unknown paths are still kept - deleting an unclassified
// artifact is the worse mistake - but the sweep now counts and logs them.
test('an unrecognised key shape is kept and reported rather than silently retained', () => {
  const mystery = blob('users/user-1/submission-runs/run-1/transcript-abc.json', 400);
  assert.equal(classifyUserBlob(mystery.pathname), 'unclassified');
  assert.deepEqual(resumeBlobsDueForDeletion([mystery], now), []);
  assert.equal(retentionDaysForCategory('unclassified'), null);
});

// Review finding: the rule was `pathname.includes('/resumes/')`, so a nested path that merely
// CONTAINED the segment aged out at 30 days, which quietly contradicted the guarantee that an
// unrecognised shape is kept. Anchoring keeps every real key deletable and sends the rest to
// 'unclassified'. Both directions are asserted so a future loosening fails here.
test('only a real generated-resume key ages out, not any path containing /resumes/', () => {
  for (const real of [
    'users/user-1/resumes/42-cover-letter-1754900000000-abc.pdf',
    'users/user-1/resumes/42-edited-uuid-abc.pdf',
    'users/user-1/resumes/jdhash-1754900000000-abc.pdf',
  ]) {
    assert.equal(classifyUserBlob(real), 'generated-resume', real);
    assert.deepEqual(resumeBlobsDueForDeletion([blob(real, 31)], now), [blob(real, 31)], real);
  }
  for (const nested of [
    'users/user-1/audit/resumes/evidence.png',
    'users/user-1/submission-runs/run-1/resumes/receipt.png',
    'users/user-1/resumes/nested/deeper.pdf',
  ]) {
    assert.equal(classifyUserBlob(nested), 'unclassified', nested);
    assert.deepEqual(resumeBlobsDueForDeletion([blob(nested, 400)], now), [], nested);
  }
});

// Review finding: the sweep chunked its del() but account deletion did not, and account deletion
// is the ONLY thing that reaches an exempt receipt. An oversized call there throws, leaves the
// user's PII in the store, and breaks the promise the receipt exemption rests on. Every delete
// path must go through the batching helper, so no bare del() may survive in this module.
test('every blob delete path chunks, so account deletion cannot exceed the batch limit', async () => {
  const source = await readFile(path.join(__dirname, 'resumeAccess.ts'), 'utf8');
  // Everything except the helper's own call, which is the one place del() is allowed to appear.
  const helperStart = source.indexOf('async function delInBatches');
  assert.ok(helperStart > 0, 'delInBatches is missing');
  const helperEnd = source.indexOf('\n}', helperStart);
  const outsideHelper = source.slice(0, helperStart) + source.slice(helperEnd);
  const bare = outsideHelper.match(/await del\(/g)?.length ?? 0;
  assert.equal(
    bare,
    0,
    'A delete path calls del() directly. Route it through delInBatches so a user with more than '
    + 'DELETE_BATCH_SIZE blobs is still fully deleted.',
  );
  assert.match(source, /async function delInBatches/);
  for (const caller of ['deleteBlobsForUser', 'deleteUploadedResumeBlobsForUser', 'sweepExpiredResumeBlobs']) {
    const body = source.slice(source.indexOf(`function ${caller}`));
    assert.match(body.slice(0, body.indexOf('\n}')), /delInBatches\(/, caller);
  }
});

// The count is the point, not the names: adding a fifth blob write fails this until whoever added
// it decides what retention the new key gets. That decision never being forced is the actual root
// cause here, and it is not specific to screenshots.
test('every blob this codebase writes has a retention decision recorded', async () => {
  const roots = [
    'lib/receiptScreenshot.ts',
    'lib/coverLetterService.ts',
    'routes/applications.ts',
    'routes/resume.ts',
    // The fifth writer, and the census is why it is listed. It shipped on a branch that never
    // touched this file, so the count stayed at four and passed: a write that is not in `roots` is
    // invisible to the guard that exists to make a new write force a retention decision.
    'lib/documentStore.ts',
  ];
  let writes = 0;
  for (const file of roots) {
    const source = await readFile(path.join(__dirname, '..', file), 'utf8');
    writes += source.match(/await (?:putObject|blobPut)\(/g)?.length ?? 0;
  }
  assert.equal(
    writes,
    5,
    'A blob write was added or removed. Classify its key in classifyUserBlob and give it a window '
    + 'in retentionDaysForCategory, then update this count. Unclassified keys are kept forever.',
  );
});

// Every submission-run artifact goes through storeSubmissionScreenshot, so its kind union is the
// complete list of screenshots the product can write. A third kind must not reach the store before
// somebody has decided how long it lives: that is precisely how previews got a window of "never".
test('every submission screenshot kind has a retention window', async () => {
  const source = await readFile(path.join(__dirname, 'receiptScreenshot.ts'), 'utf8');
  const union = /export type SubmissionScreenshotKind =([^;]+);/.exec(source)?.[1] ?? '';
  const kinds = (union.match(/'[a-z_]+'/g) ?? []).map((kind) => kind.replaceAll("'", '')).sort();
  assert.deepEqual(
    kinds,
    ['filled_preview', 'submission_receipt'],
    'A submission screenshot kind was added or renamed. Give its key shape a case in '
    + 'classifyUserBlob and a window in retentionDaysForCategory before it can be written.',
  );
  // The filenames those kinds map to are what the classifier actually sees, suffix included.
  assert.equal(classifyUserBlob('users/u/submission-runs/r/filled-x.png'), 'submission-preview');
  assert.equal(classifyUserBlob('users/u/submission-runs/r/receipt-x.png'), 'submission-receipt');
});

test('every category a write can produce classifies, and every classification has a window', () => {
  const written: Array<[string, UserBlobCategory]> = [
    // coverLetterService.ts, applications.ts (edited PDF), resume.ts (generated PDF)
    ['users/u/resumes/1-cover-letter-123.pdf', 'generated-resume'],
    ['users/u/resumes/1-edited-uuid.pdf', 'generated-resume'],
    ['users/u/resumes/hash-123.pdf', 'generated-resume'],
    // receiptScreenshot.ts, via storeFilledPreviewScreenshot
    ['users/u/submission-runs/r/filled-abc.png', 'submission-preview'],
    // receiptScreenshot.ts, via storeReceiptScreenshot
    ['users/u/submission-runs/r/receipt-abc.png', 'submission-receipt'],
    // Legacy originals, no longer written but swept on sight if one reappears.
    ['users/u/resume.pdf', 'legacy-original'],
    // documentStore.ts, via putUserDocument
    ['users/u/documents/5d3f0b6a-9a71-4f3a-9c2f-2b6a1d8e7c40.pdf', 'user-document'],
  ];
  for (const [pathname, expected] of written) {
    assert.equal(classifyUserBlob(pathname), expected, pathname);
    assert.notEqual(classifyUserBlob(pathname), 'unclassified', pathname);
  }
});

/* THE PUBLISHED SENTENCE, AND THE DIFFERENCE BETWEEN SURVIVING AND BEING EXEMPT.
 *
 * trylitos.com/privacy says of a file the student attaches herself: "We encrypt it and keep it until
 * you remove it or delete your account." That was verified once against a classifier that no longer
 * exists - main replaced resumeBlobsDueForDeletion's two-arm filter with classifyUserBlob plus
 * retentionDaysForCategory while the branch was out - and under the replacement the key survived
 * only by reaching the catch-all.
 *
 * The catch-all is an ALARM, not a policy. Its own comment says an unrecognised shape is kept and
 * logged so a new category "announces itself on the first run after it ships", which is an
 * invitation for the next person to give that arm a window. A window on 'unclassified' would delete
 * every stored transcript and make the sentence on the page false, with nothing failing anywhere.
 * So the first assertion here is the load-bearing one: the exemption has a NAME.
 */
test('a file the student attached herself is exempt by name, not by falling through', () => {
  const key = 'users/user-1/documents/5d3f0b6a-9a71-4f3a-9c2f-2b6a1d8e7c40.pdf';
  assert.equal(
    classifyUserBlob(key),
    'user-document',
    'The privacy page promises this file is kept until she removes it. Reclassifying it, or letting '
    + 'it fall to the catch-all, makes a published sentence false the first time that arm gets a '
    + 'window. Change the page before changing this.',
  );
  assert.notEqual(classifyUserBlob(key), 'unclassified', key);
  assert.equal(retentionDaysForCategory('user-document'), null);
  // Four years old and not due, so the exemption is asserted through the filter and not only
  // through the two functions it is built from.
  assert.deepEqual(resumeBlobsDueForDeletion([blob(key, 1460)], now), []);
  // The other half of the same sentence: "or delete your account" is true only while the key sits
  // inside the prefix deleteBlobsForUser lists.
  assert.ok(key.startsWith(userBlobPrefix('user-1')));

  /* Anchored like the generated-resume rule, and for the same reason: one segment under documents/
     is every key putUserDocument can build, so anything deeper is a shape nobody has decided about
     and belongs in the alarm rather than under this exemption. */
  for (const nested of [
    'users/user-1/documents/nested/deeper.pdf',
    'users/user-1/audit/documents/evidence.pdf',
  ]) {
    assert.equal(classifyUserBlob(nested), 'unclassified', nested);
  }
});

test('replacement cleanup cannot classify generated or unrelated user artifacts as originals', () => {
  for (const pathname of [
    'users/user-1/resumes/application.pdf',
    'users/user-1/submission-runs/run-1/filled.png',
    'users/user-1/resume.txt',
    'users/user-1/archive/resume.pdf',
  ]) {
    assert.equal(isUploadedResumeBlob(pathname), false, pathname);
  }
});

test('account deletion remains scoped to every blob owned by exactly one user', () => {
  assert.equal(userBlobPrefix('user-1'), 'users/user-1/');
});

// Everything above tests the pure filter. The sweep itself - the one function here that
// permanently destroys user files - had no test at all: every route test stubbed it out, so the
// cursor loop and the bulk del() below were only ever exercised against the live store.

/** A paging fake for the two Blob calls the sweep makes. Records what it was asked for. */
function blobStoreFake(pages: BlobListPage[]) {
  const seen = { listCalls: [] as Array<string | undefined>, deleted: null as string[] | null };
  const store: ResumeBlobStore = {
    list: async ({ cursor }) => {
      seen.listCalls.push(cursor);
      const page = pages[seen.listCalls.length - 1];
      assert.ok(page, `list() paged past the end of the fake (cursor ${String(cursor)})`);
      return page;
    },
    del: async (urls) => {
      seen.deleted = urls;
    },
  };
  return { seen, store };
}

const listed = (pathname: string, ageDays: number) => ({
  pathname,
  url: `https://store.public.blob.vercel-storage.com/${pathname}`,
  uploadedAt: new Date(now - ageDays * 24 * 60 * 60 * 1000),
});

test('the sweep follows the list cursor instead of deleting only the first page', async () => {
  const { seen, store } = blobStoreFake([
    {
      blobs: [listed('users/user-1/resume.pdf', 0), listed('users/user-1/resumes/fresh.pdf', 2)],
      cursor: 'page-2',
      hasMore: true,
    },
    {
      blobs: [listed('users/user-2/resumes/expired.pdf', 31)],
      hasMore: false,
    },
  ]);

  const result = await sweepExpiredResumeBlobs({ now, blobStore: store });

  // Two calls, the second carrying the cursor the first returned. A loop that stopped after one
  // page would leave user-2's expired file in the store forever while still reporting success -
  // and with 1282 objects against a 1000 limit, production is already past one page.
  assert.deepEqual(seen.listCalls, [undefined, 'page-2']);
  assert.equal(result.scanned, 3);
  assert.equal(result.deleted, 2);
  assert.deepEqual(result.deletedPathnames, [
    'users/user-1/resume.pdf',
    'users/user-2/resumes/expired.pdf',
  ]);
  assert.deepEqual(seen.deleted, [
    'https://store.public.blob.vercel-storage.com/users/user-1/resume.pdf',
    'https://store.public.blob.vercel-storage.com/users/user-2/resumes/expired.pdf',
  ]);
});

// hasMore false with a cursor still present is the shape that would spin forever if the loop
// trusted the cursor rather than the flag.
test('the sweep stops paging when hasMore is false even if a cursor is returned', async () => {
  const { seen, store } = blobStoreFake([
    { blobs: [listed('users/user-1/resumes/fresh.pdf', 1)], cursor: 'page-2', hasMore: false },
  ]);

  const result = await sweepExpiredResumeBlobs({ now, blobStore: store });

  assert.deepEqual(seen.listCalls, [undefined]);
  assert.equal(result.scanned, 1);
  assert.equal(result.deleted, 0);
});

test('nothing due means del is never called', async () => {
  const { seen, store } = blobStoreFake([
    { blobs: [listed('users/user-1/resumes/fresh.pdf', 1)], hasMore: false },
  ]);

  const result = await sweepExpiredResumeBlobs({ now, blobStore: store });

  assert.equal(seen.deleted, null, 'an empty del([]) is a pointless round trip');
  assert.deepEqual(result.deletedPathnames, []);
});

// The chunking added alongside the preview window is guarded by a source-text test asserting every
// delete path routes through delInBatches, but the arithmetic itself was never run. Off-by-one in
// a batch loop is the classic way a "chunked" call still sends an oversized final batch, and the
// run that carries a backlog is exactly the one after an outage.
test('the sweep deletes in batches of at most 1000, covering every url exactly once', async () => {
  const due = Array.from({ length: 2500 }, (_, i) => listed(`users/user-${i}/resume.pdf`, 0));
  const batches: string[][] = [];
  const store: ResumeBlobStore = {
    list: async () => ({ blobs: due, hasMore: false }),
    del: async (urls) => {
      batches.push(urls);
    },
  };

  const result = await sweepExpiredResumeBlobs({ now, blobStore: store });

  assert.deepEqual(batches.map((b) => b.length), [1000, 1000, 500]);
  assert.ok(batches.every((b) => b.length <= 1000), 'a batch exceeded the limit del() rejects');
  assert.deepEqual(batches.flat(), due.map((b) => b.url), 'every url sent exactly once, in order');
  assert.equal(result.deleted, 2500);
});

// A del that rejects must propagate. The route turns that into a 500 and skips the pointer clear;
// swallowing it here would report deleted counts for files still in the store, and the privacy
// page states the window as fact.
test('a rejecting del fails the sweep rather than reporting a false deletion', async () => {
  const store: ResumeBlobStore = {
    list: async () => ({ blobs: [listed('users/user-1/resume.pdf', 0)], hasMore: false }),
    del: async () => {
      throw new Error('Blob store rate limited');
    },
  };

  await assert.rejects(
    sweepExpiredResumeBlobs({ now, blobStore: store }),
    /Blob store rate limited/,
  );
});

test('a rejecting list fails the sweep before anything is deleted', async () => {
  let deleteCalls = 0;
  const store: ResumeBlobStore = {
    list: async () => {
      throw new Error('Blob list unavailable');
    },
    del: async () => {
      deleteCalls += 1;
    },
  };

  await assert.rejects(sweepExpiredResumeBlobs({ now, blobStore: store }), /Blob list unavailable/);
  assert.equal(deleteCalls, 0);
});

test('the retention window is honoured to the day boundary', async () => {
  const { store } = blobStoreFake([
    {
      blobs: [
        listed('users/user-1/resumes/just-inside.pdf', 29.9),
        listed('users/user-1/resumes/just-outside.pdf', 30.1),
      ],
      hasMore: false,
    },
  ]);

  const result = await sweepExpiredResumeBlobs({ now, blobStore: store });

  assert.deepEqual(result.deletedPathnames, ['users/user-1/resumes/just-outside.pdf']);
});

test('legacy original owners are extracted and deduplicated, generated files ignored', () => {
  assert.deepEqual(
    legacyOriginalOwnerIds([
      'users/user-1/resume.pdf',
      'users/user-1/resume-abc123.docx',
      'users/user-2/resumes/application.pdf',
      'users/user-3/submission-runs/run-1/filled.png',
      'users/user-4/resume.docx',
    ]),
    ['user-1', 'user-4'],
  );
});

test('no legacy originals deleted means no profile is implicated', () => {
  assert.deepEqual(legacyOriginalOwnerIds([]), []);
  assert.deepEqual(legacyOriginalOwnerIds(['users/user-2/resumes/application.pdf']), []);
});

test('a deletion failure preserves legacy pointers and a successful retry clears them', async () => {
  let attempts = 0;
  let clearCalls = 0;
  const deleteUploadedResume = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary Blob outage');
  };
  const clearLegacyPointers = async () => {
    clearCalls += 1;
  };

  await assert.rejects(
    deleteUploadedResumeThenClear(deleteUploadedResume, clearLegacyPointers),
    /temporary Blob outage/,
  );
  assert.equal(clearCalls, 0);

  await deleteUploadedResumeThenClear(deleteUploadedResume, clearLegacyPointers);
  assert.equal(attempts, 2);
  assert.equal(clearCalls, 1);
});
