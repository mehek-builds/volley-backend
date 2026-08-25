import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canGenerateCoverLetter, storedCoverLetter, storedCoverLetterReuseDisposition } from './coverLetterService';

test('legacy persistence proves the transaction writable before Blob work and retries read-only backends', () => {
  const source = readFileSync('src/lib/coverLetterService.ts', 'utf8');
  const persistence = source.slice(
    source.indexOf('async function persistCoverLetter('),
    source.indexOf('export async function generateStoredCoverLetter('),
  );
  const render = persistence.indexOf('const pdf = await renderCoverLetterPdf(');
  const runner = persistence.indexOf('const runPersistTransaction = (database: typeof db) => database.transaction(async (tx) => {');
  const packetLock = persistence.indexOf('const [currentPacket] = await tx.select()');
  const applicationLock = persistence.indexOf('const [canonicalApplication] = await tx.select()');
  const upload = persistence.indexOf('const storedBlob = await put(');
  const firstMutation = persistence.indexOf('const [storedArtifact] = await tx.insert(artifacts)');
  const retry = persistence.indexOf('const persisted = await withReadOnlyRetry(');
  const directFallback = persistence.indexOf('onExhausted: () => withDedicatedDatabase');
  const cleanup = persistence.indexOf('if (blobState.current) await del(');

  assert.ok(render >= 0 && render < runner);
  assert.ok(runner >= 0 && runner < packetLock);
  assert.ok(packetLock >= 0 && packetLock < applicationLock);
  assert.ok(applicationLock >= 0 && applicationLock < upload);
  assert.ok(upload >= 0 && upload < firstMutation);
  assert.ok(firstMutation >= 0 && firstMutation < retry);
  assert.ok(retry >= 0 && retry < directFallback);
  assert.ok(directFallback >= 0 && directFallback < cleanup);
  assert.match(persistence, /\.limit\(1\)\.for\('update'\);[\s\S]*\.limit\(1\)\.for\('update'\);[\s\S]*const storedBlob = await put\(/);
  assert.match(persistence, /withReadOnlyRetry\(\s*\(\) => runPersistTransaction\(db\)/);
  assert.match(persistence, /onExhausted: \(\) => withDedicatedDatabase\(\(directDb\) =>/);
});

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

const groundedBody = [
  'I am applying for the Software Engineer role at Quandela.',
  ...Array.from({ length: 215 }, () => 'software'),
].join(' ');

const historicalArtifact = (body: string, approved = false) => ({
  body,
  word_count: body.split(/\s+/).length,
  warnings: [],
  generated_at: '2026-08-20T00:00:00.000Z',
  ...(approved ? { approved_at: '2026-08-20T00:00:00.000Z' } : {}),
  object_key: 'users/user-1/resumes/app-1-cover-letter.pdf',
  file_name: 'Taylor_Applicant_Software_Engineer_Cover_Letter.pdf',
});

const context = {
  source: JSON.stringify({ degree: 'Bachelor of Science in Computer Science', skills: ['software'] }),
  contested: { labels: [], signatures: new Set<string>() },
};

test('a historical AI letter is reused only when it passes today\'s quality gate', () => {
  assert.deepEqual(
    storedCoverLetterReuseDisposition(historicalArtifact(groundedBody), 'Quandela', 'Software Engineer', context),
    { action: 'reuse', issues: [] },
  );
});

test('a historical AI letter with an invented academic program is regenerated', () => {
  const disposition = storedCoverLetterReuseDisposition(
    historicalArtifact(`${groundedBody} I am a Computer Science and Business Administration student.`),
    'Quandela',
    'Software Engineer',
    context,
  );
  assert.equal(disposition.action, 'regenerate');
  assert.ok(disposition.issues.some((issue) => issue.includes('Business Administration')));
});

test('a historical applicant-edited letter is stopped, never silently replaced', () => {
  const disposition = storedCoverLetterReuseDisposition(
    historicalArtifact(`${groundedBody} I am a Computer Science and Business Administration student.`, true),
    'Quandela',
    'Software Engineer',
    context,
  );
  assert.equal(disposition.action, 'reject');
});
