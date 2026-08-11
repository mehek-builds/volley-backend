import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { multipartFailureMessage } from './documents';
import { MAX_USER_DOCUMENT_BYTES, UserDocumentError, putUserDocument } from '../lib/documentStore';

/* ONE CAP, FOUR PLACES IT IS ENFORCED OR SAID, AND A FIFTH NUMBER THAT IS NOT IT.
 *
 * The document cap is 4,000,000 bytes. It is enforced in the store (documentStore.ts, so no future
 * caller can route around it by not being the upload route), counted in the upload route while the
 * body streams (so a large body costs 4 MB of memory rather than its own size), and checked again on
 * the packet (submissionRunner.ts, because the managed sandbox refuses an upload over 6,000,000
 * base64 characters before a browser opens). The website states the same 4,000,000 in
 * MAX_APPLICATION_DOCUMENT_BYTES and prints it as "4 MB" on the modal, decimal rather than binary so
 * the number matches what her own file manager reports.
 *
 * THE FIFTH NUMBER IS THE GLOBAL MULTIPART `fileSize`, which is 10 MiB, is set once in index.ts, and
 * is shared with the resume upload, so it is not this surface's to lower. It is an outer backstop
 * and never the cap. What it must not be is the number the student is told about, and for a while it
 * effectively was: a file over it throws from inside the parts iterator, so it landed in the same
 * catch as a genuinely broken form and was answered "Failed to parse multipart form data". A 4.5 MB
 * transcript got a sentence naming the limit; a 12 MB one got a sentence naming nothing, which is
 * the wrong way round.
 *
 * The tests below pin the agreement rather than describing it, because these numbers live in four
 * files and two repositories and the only thing that keeps them equal is somebody noticing.
 */

const routeSource = readFileSync(join(__dirname, 'documents.ts'), 'utf8');
const indexSource = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');

test('a body over the global multipart limit is refused as an oversized file, not as a broken form', async () => {
  /* The two sentences are compared rather than both matched against a pattern, so that changing one
     of them is a failure here rather than a difference a student finds. The store's copy is reached
     by calling it: the size check runs before put(), so this touches no blob and no database. */
  const refused = await putUserDocument({
    userId: '00000000-0000-4000-8000-000000000000',
    kind: 'transcript',
    fileName: 'transcript.pdf',
    contentType: 'application/pdf',
    bytes: Buffer.alloc(MAX_USER_DOCUMENT_BYTES + 1),
    reusable: true,
  }).then(() => null, (error: unknown) => error);

  assert.ok(refused instanceof UserDocumentError, 'an oversized file is a refusal, not a failure');
  assert.equal(
    multipartFailureMessage({ code: 'FST_REQ_FILE_TOO_LARGE' }),
    refused.message,
    'the plugin-limit refusal and the store refusal are the same sentence about the same cap',
  );
  assert.match(refused.message, /4 MB/, 'the sentence names the limit the modal states');
});

test('a form the plugin could not read is still answered as a form the plugin could not read', () => {
  /* The widening above is narrow on purpose. FST_FILES_LIMIT is a client that built the request
     wrong, not a student with a big scan, and telling her about a size cap she has not hit sends her
     off to shrink a file that was never the problem. */
  assert.equal(multipartFailureMessage(new Error('boom')), 'Failed to parse multipart form data');
  assert.equal(multipartFailureMessage({ code: 'FST_FILES_LIMIT' }), 'Failed to parse multipart form data');
  assert.equal(multipartFailureMessage(undefined), 'Failed to parse multipart form data');
  assert.equal(multipartFailureMessage(null), 'Failed to parse multipart form data');
});

test('the global multipart limit is the outer backstop and the document cap is what binds', () => {
  const limit = indexSource.match(/fileSize:\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/);
  assert.ok(limit, 'the global multipart fileSize limit must still be findable in index.ts');
  const fileSize = Number(limit[1]) * Number(limit[2]) * Number(limit[3]);

  assert.ok(
    fileSize > MAX_USER_DOCUMENT_BYTES,
    `the plugin limit (${fileSize}) has to stay above the document cap (${MAX_USER_DOCUMENT_BYTES}), or the `
    + 'upload route stops being the thing that decides, and the sentence about 4 MB stops being the reason files are refused',
  );

  /* Counted in the route, not delegated to the plugin. Two things depend on this and neither is
     obvious: an over-cap upload costs 4 MB of held memory instead of 10, and the stream is still
     drained to the end, because an unconsumed part leaves busboy waiting on backpressure and the
     request hangs, which reads to a student as a frozen upload rather than as the refusal it is. */
  assert.match(routeSource, /if \(size > MAX_USER_DOCUMENT_BYTES\)/);
  assert.match(routeSource, /overCap = true;\n\s*continue;/);
});

test('no number other than the cap is ever quoted to a student by this route', () => {
  /* The refusals are the strings in send bodies, and the only size any of them may name is 4 MB.
     10 MB appears in this file in prose, explaining that it is NOT the cap, and prose is not what
     the student reads. */
  const sends = routeSource.match(/error: '[^']*'/g) ?? [];
  assert.ok(sends.length >= 8, `expected the route's refusals to be found, got ${sends.length}`);
  for (const sentence of sends) {
    const size = sentence.match(/(\d+(?:\.\d+)?)\s*(MB|MiB|KB|GB)/);
    if (!size) continue;
    assert.equal(`${size[1]} ${size[2]}`, '4 MB', `${sentence} quotes a size that is not the cap`);
  }
});
