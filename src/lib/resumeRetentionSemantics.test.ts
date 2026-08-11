import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  classifyUserBlob,
  deleteUploadedResumeThenClear,
  isUploadedResumeBlob,
  resumeBlobsDueForDeletion,
  retentionDaysForCategory,
  userBlobPrefix,
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

// The count is the point, not the names: adding a fifth blob write fails this until whoever added
// it decides what retention the new key gets. That decision never being forced is the actual root
// cause here, and it is not specific to screenshots.
test('every blob this codebase writes has a retention decision recorded', async () => {
  const roots = [
    'lib/receiptScreenshot.ts',
    'lib/coverLetterService.ts',
    'routes/applications.ts',
    'routes/resume.ts',
  ];
  let writes = 0;
  for (const file of roots) {
    const source = await readFile(path.join(__dirname, '..', file), 'utf8');
    writes += source.match(/await (?:put|blobPut)\(/g)?.length ?? 0;
  }
  assert.equal(
    writes,
    4,
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
  ];
  for (const [pathname, expected] of written) {
    assert.equal(classifyUserBlob(pathname), expected, pathname);
    assert.notEqual(classifyUserBlob(pathname), 'unclassified', pathname);
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
