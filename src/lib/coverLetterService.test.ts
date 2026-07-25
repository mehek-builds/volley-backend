import assert from 'node:assert/strict';
import test from 'node:test';
import { canGenerateCoverLetter } from './coverLetterService';

test('cover letters are not generated before an attachment field is detected', () => {
  assert.equal(canGenerateCoverLetter(undefined), false);
  assert.equal(canGenerateCoverLetter(false), false);
});

test('a detected attachment field triggers generation whether required or optional', () => {
  assert.equal(canGenerateCoverLetter(true), true);
  assert.equal(canGenerateCoverLetter(undefined, true), true);
});
