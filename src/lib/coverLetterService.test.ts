import assert from 'node:assert/strict';
import test from 'node:test';
import { canGenerateCoverLetter, storedCoverLetter } from './coverLetterService';

test('cover letters are not generated before an attachment field is detected', () => {
  assert.equal(canGenerateCoverLetter(undefined), false);
  assert.equal(canGenerateCoverLetter(false), false);
});

test('a detected attachment field triggers generation whether required or optional', () => {
  assert.equal(canGenerateCoverLetter(true), true);
  assert.equal(canGenerateCoverLetter(undefined, true), true);
});

test('stored cover letter artifacts preserve the saved role-based filename', () => {
  const artifact = {
    body: 'Dear hiring team...',
    word_count: 148,
    warnings: [],
    generated_at: '2026-08-05T00:00:00.000Z',
    approved_at: '2026-08-05T00:00:00.000Z',
    object_key: 'users/user-1/resumes/app-1-cover-letter.pdf',
    file_name: 'Taylor_Applicant_Backend_Engineer_cover_letter.pdf',
  };

  assert.deepEqual(storedCoverLetter({ spec: { _cover_letter: artifact } } as never), artifact);
});

test('stored cover letter artifacts without a filename are ignored', () => {
  assert.equal(
    storedCoverLetter({
      spec: {
        _cover_letter: {
          body: 'Dear hiring team...',
          object_key: 'users/user-1/resumes/app-1-cover-letter.pdf',
        },
      },
    } as never),
    null,
  );
});
