import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deleteUploadedResumeThenClear,
  isUploadedResumeBlob,
  legacyOriginalOwnerIds,
  resumeBlobsDueForDeletion,
  sweepExpiredResumeBlobs,
  userBlobPrefix,
  type BlobListPage,
  type ResumeBlobStore,
  type StoredResumeBlob,
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
  const screenshot = blob('users/user-1/submission-runs/run-1/filled.png', 31);
  assert.deepEqual(resumeBlobsDueForDeletion([fresh, expired, screenshot], now), [expired]);
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
