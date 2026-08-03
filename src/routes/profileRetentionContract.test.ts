import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const routeSource = (name: string) => readFile(path.join(__dirname, name), 'utf8');

test('profile upload parses but never writes the raw file to Blob storage', async () => {
  const source = await routeSource('profile.ts');
  assert.doesNotMatch(source, /from '@vercel\/blob'/);
  assert.doesNotMatch(source, /await put\s*\(/);
  assert.match(source, /resume_object_key: null/);
  assert.match(source, /resume_url: null/);
});

test('replacement clears legacy pointers and schedules legacy blob cleanup', async () => {
  const source = await routeSource('profile.ts');
  assert.match(source, /deleteUploadedResumeBlobsForUser\(userId\)/);
  assert.match(source, /deleteUploadedResumeThenClear/);
  const conflictUpdate = source.slice(source.indexOf('.onConflictDoUpdate'), source.indexOf('// Replacement must not strand'));
  assert.doesNotMatch(conflictUpdate, /resume_object_key: null/);
  assert.doesNotMatch(conflictUpdate, /resume_url: null/);
  const deletion = source.indexOf('() => deleteUploadedResumeBlobsForUser(userId)');
  const pointerClear = source.indexOf('.set({ resume_object_key: null, resume_url: null })');
  assert.ok(deletion >= 0 && pointerClear > deletion);
});

test('onboarding never exposes a persistent original-upload URL', async () => {
  const source = await routeSource('onboarding.ts');
  assert.match(source, /source_resume_url: null/);
  assert.doesNotMatch(source, /source_resume_url: profile\?\.resume_url/);
});

test('retention cleanup clears legacy database pointers only after blob deletion succeeds', async () => {
  const source = await routeSource('resumeRetention.ts');
  const sweep = source.indexOf('await dependencies.sweepExpiredResumeBlobs()');
  const clear = source.indexOf('await dependencies.clearLegacyPointers()');
  assert.ok(sweep >= 0 && clear > sweep);
});

test('account export exposes only expiring wrappers for generated files', async () => {
  const source = await routeSource('account.ts');
  assert.match(source, /download_url:.*mintDownloadToken/);
  assert.doesNotMatch(source, /profile\.resume_url/);
});

test('account deletion removes the complete user blob prefix before deleting the user row', async () => {
  const source = await routeSource('account.ts');
  const deleteBlobs = source.indexOf('deletedFiles = await deleteBlobsForUser(userId)');
  const deleteUser = source.indexOf('await db.delete(users)');
  assert.ok(deleteBlobs >= 0 && deleteUser > deleteBlobs);
});
