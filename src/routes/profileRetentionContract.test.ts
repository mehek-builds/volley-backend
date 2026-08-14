import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const routeSource = (name: string) => readFile(path.join(__dirname, name), 'utf8');

// These routes carry long comments that quote the very code shapes asserted against below - the
// unscoped UPDATE this file forbids is spelled out verbatim in the comment explaining why it was
// removed. Searching raw source finds the prose first and reads the wrong statement, so anything
// locating code by position strips line comments first.
const codeOf = async (name: string) => (await routeSource(name)).replace(/^\s*\/\/.*$/gm, '');

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

// A source-text ordering check, and only that. It cannot tell a real ordering from a sweep wrapped
// in a catch that swallows the error and clears pointers anyway; the behaviour is asserted in
// resumeRetention.test.ts ('a failing sweep is a 500 and leaves legacy pointers untouched'), which
// is the guard that actually holds this invariant. Matched without the closing paren so that
// changing either call's arguments does not silently turn this into indexOf returning -1.
test('retention cleanup clears legacy database pointers only after blob deletion succeeds', async () => {
  const source = await codeOf('resumeRetention.ts');
  const sweep = source.indexOf('await dependencies.sweepExpiredResumeBlobs(');
  const clear = source.indexOf('await dependencies.clearLegacyPointers(');
  assert.ok(sweep >= 0, 'the sweep call was renamed or removed');
  assert.ok(clear > sweep, 'pointers must be cleared after the sweep, not before');
});

// The production clearLegacyPointers body is replaced by a stub in every route test, so no
// behavioural test can see this: it is the one place an unscoped UPDATE could come back unnoticed.
// It was unscoped until 2026-08-11 - `db.update(profiles).set({...: null})` with no WHERE, nulling
// both columns for every profile on every successful sweep. Harmless against today's data and a
// standing trap for any future feature that legitimately populates them. A bare
// `.where(isNotNull(...))` does NOT close it either, since a future non-null value matches that
// filter and still gets nulled, so this asserts scoping by user id specifically.
test('the retention pointer clear is scoped to named user ids, never the whole table', async () => {
  const source = await codeOf('resumeRetention.ts');
  const update = source.indexOf('.update(profiles)');
  assert.ok(update >= 0, 'the pointer clear was renamed or removed');
  const statement = source.slice(update, source.indexOf(';', update));
  assert.match(
    statement,
    /\.where\(inArray\(profiles\.user_id,/,
    'profiles must be updated only for the owners whose blobs were actually deleted',
  );
  assert.doesNotMatch(statement, /isNotNull/, 'isNotNull still nulls a future legitimate value');
});

test('account export exposes only expiring wrappers for generated files', async () => {
  const source = await routeSource('account.ts');
  assert.match(source, /download_url:.*mintDownloadToken/);
  assert.doesNotMatch(source, /profile\.resume_url/);
});

test('account deletion removes the complete user blob prefix before deleting the user row', async () => {
  const source = await routeSource('account.ts');
  const deleteBlobs = source.indexOf('deletedFiles = await deleteBlobsForUser(userId)');
  const deleteUser = source.indexOf('await tx.delete(users)');
  assert.ok(deleteBlobs >= 0 && deleteUser > deleteBlobs);
});
