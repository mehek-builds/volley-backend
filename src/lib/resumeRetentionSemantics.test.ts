import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deleteUploadedResumeThenClear,
  isUploadedResumeBlob,
  resumeBlobsDueForDeletion,
  userBlobPrefix,
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
