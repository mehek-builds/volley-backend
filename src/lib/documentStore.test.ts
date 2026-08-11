import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_USER_DOCUMENT_BYTES,
  attachedDocument,
  documentBytesFromPointer,
  documentSummary,
  listUserDocuments,
  putUserDocument,
  storedDocuments,
  tombstoneUserDocument,
  userDocumentObjectKey,
} from './documentStore';
import { sealDocument } from './documentCrypto';
import { classifyUserBlob, isUploadedResumeBlob, resumeBlobsDueForDeletion, userBlobPrefix } from './resumeAccess';

const ATTACHED = {
  document_id: '1b4d2f6e-0000-4000-8000-000000000001',
  file_name: 'transcript.pdf',
  object_key: 'users/user-1/documents/1b4d2f6e-0000-4000-8000-000000000002.pdf',
  attached_at: '2026-08-11T09:00:00.000Z',
  ordered_at: null,
  employer_label: 'Upload your unofficial transcript',
  official_requested: false,
};

function applicationRow(documents: unknown) {
  return { spec: { _documents: documents } } as never;
}

/** What a real Response hands back: a standalone ArrayBuffer, not a view into a pooled Buffer. */
function asArrayBuffer(buffer: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(out).set(buffer);
  return out;
}

test('an attached transcript reads back with every field the screen shows', () => {
  assert.deepEqual(attachedDocument(applicationRow({ transcript: ATTACHED }), 'transcript'), {
    kind: 'transcript',
    document_id: ATTACHED.document_id,
    file_name: 'transcript.pdf',
    attached_at: '2026-08-11T09:00:00.000Z',
    ordered_at: null,
    employer_label: 'Upload your unofficial transcript',
    official_requested: false,
  });
});

test('neither spec reader ever hands back object_key', () => {
  /* The single most important assertion in this file. A Blob object is written `access: 'public'`
   * because that is the only mode available, so the object key plus the store's stable base URL is
   * permanent unauthenticated access to a student's transcript. The spec holds the key because the
   * packet builder needs it; the response envelope must not, and this is the reader that stands
   * between the two. */
  const one = attachedDocument(applicationRow({ transcript: ATTACHED }), 'transcript');
  const all = storedDocuments(applicationRow({ transcript: ATTACHED }));
  assert.equal(Object.prototype.hasOwnProperty.call(one!, 'object_key'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(all.transcript, 'object_key'), false);
  assert.equal(JSON.stringify({ one, all }).includes('documents/'), false);
});

test('an acknowledged order with no file is a real attachment', () => {
  // Screen 06. "I've ordered it" records that she was asked and answered, with no document_id and
  // no object_key, so the checklist row stops nagging. A reader that insisted on a file here - the
  // shape storedCoverLetter uses - would drop the row and the student would be asked again.
  const ordered = attachedDocument(
    applicationRow({ transcript: { ordered_at: '2026-08-11T09:00:00.000Z', official_requested: true } }),
    'transcript',
  );
  assert.equal(ordered?.ordered_at, '2026-08-11T09:00:00.000Z');
  assert.equal(ordered?.document_id, null);
  assert.equal(ordered?.official_requested, true);
});

test('an attachment carrying neither a file nor an order is nothing', () => {
  // A half-written record must not render a row that offers her a file she never attached.
  for (const empty of [{}, { employer_label: 'Transcript' }, { file_name: 'transcript.pdf' }, null, 'transcript', []]) {
    assert.equal(attachedDocument(applicationRow({ transcript: empty }), 'transcript'), null, JSON.stringify(empty));
  }
});

test('an application with no _documents key reads as no documents, not as a crash', () => {
  assert.deepEqual(storedDocuments({ spec: {} } as never), {});
  assert.deepEqual(storedDocuments({ spec: { _documents: null } } as never), {});
  assert.deepEqual(storedDocuments({ spec: { _documents: ['transcript'] } } as never), {});
  assert.equal(attachedDocument({ spec: {} } as never, 'transcript'), null);
  assert.equal(attachedDocument(applicationRow({ transcript: ATTACHED }), 'cover_letter'), null);
});

test('documents are keyed by kind, so a second type is a new key and not a shape change', () => {
  const all = storedDocuments(applicationRow({
    transcript: ATTACHED,
    portfolio: { ...ATTACHED, file_name: 'portfolio.pdf' },
    writing_sample: { employer_label: 'Writing sample' },
  }));
  assert.deepEqual(Object.keys(all).sort(), ['portfolio', 'transcript']);
  assert.equal(all.portfolio.kind, 'portfolio');
  assert.equal(all.transcript.file_name, 'transcript.pdf');
});

test('a summary carries the plaintext size and ISO timestamps, and no pointers', () => {
  const summary = documentSummary({
    id: 'doc-1',
    kind: 'transcript',
    file_name: 'transcript.pdf',
    byte_size: 182_431,
    reusable: true,
    created_at: new Date('2026-08-11T09:00:00.000Z'),
    last_used_at: null,
    deleted_at: null,
  });
  assert.deepEqual(summary, {
    id: 'doc-1',
    kind: 'transcript',
    file_name: 'transcript.pdf',
    byte_size: 182_431,
    reusable: true,
    created_at: '2026-08-11T09:00:00.000Z',
    last_used_at: null,
    deleted_at: null,
  });
});

test('the object key survives the sweep and is still taken by account deletion', () => {
  /* This is the retention promise, checked against the real predicates in resumeAccess rather than
   * against a reading of them. "We keep it until you remove it" is false the moment the sweep's
   * filter matches this path, and "or delete your account" is false the moment the path escapes the
   * owner-scoped prefix deleteBlobsForUser lists.
   *
   * The KEY SHAPE is what is checked here, because this is the function that builds it. That the
   * shape is exempt on purpose rather than by fall-through is checked in
   * resumeRetentionSemantics.test.ts, next to the classifier that decides it. */
  const key = userDocumentObjectKey('11111111-2222-4333-8444-555555555555');
  assert.match(key, /^users\/11111111-2222-4333-8444-555555555555\/documents\/[0-9a-f-]{36}\.pdf$/);
  assert.equal(isUploadedResumeBlob(key), false);
  assert.equal(key.includes('/resumes/'), false);
  assert.equal(classifyUserBlob(key), 'user-document');
  assert.ok(key.startsWith(userBlobPrefix('11111111-2222-4333-8444-555555555555')));

  const uploadedYearsAgo = new Date('2020-01-01T00:00:00.000Z');
  assert.deepEqual(
    resumeBlobsDueForDeletion([{ url: 'https://blob.example/x', pathname: key, uploadedAt: uploadedYearsAgo }]),
    [],
  );
});

test('every object key is unique, so re-uploading never overwrites the file it replaces', () => {
  const first = userDocumentObjectKey('user-1');
  const second = userDocumentObjectKey('user-1');
  assert.notEqual(first, second);
});

test('the stored URL is used directly, and the eventually-consistent resolver is never consulted', async () => {
  /* H6, and the reason blob_url is a NOT NULL column rather than a lookup. resolveBlobUrl goes
   * through list({ prefix }), which was measured 404ing 54 seconds after a write and took every
   * Ashby fill of 2026-07-18 out with it. A transcript uploaded and attached in one sitting is
   * exactly that window, and the failure is silent: the file reads as deleted, not as an error. */
  const bytes = Buffer.from('%PDF-1.4\ntranscript\n%%EOF\n');
  process.env.ENCRYPTION_KEY = 'test-key';
  const sealed = sealDocument(bytes);
  let resolverCalls = 0;
  const fetched: string[] = [];

  const plaintext = await documentBytesFromPointer(
    { blobUrl: 'https://blob.example/users/user-1/documents/a.pdf', objectKey: 'users/user-1/documents/a.pdf' },
    {
      resolveObjectUrl: async () => {
        resolverCalls += 1;
        return null;
      },
      fetchObject: async (url) => {
        fetched.push(url);
        return { ok: true, arrayBuffer: async () => asArrayBuffer(sealed) };
      },
    },
  );

  assert.equal(resolverCalls, 0);
  assert.deepEqual(fetched, ['https://blob.example/users/user-1/documents/a.pdf']);
  assert.deepEqual(plaintext, bytes);
});

test('a row written without a stored URL falls back to the resolver rather than failing', async () => {
  process.env.ENCRYPTION_KEY = 'test-key';
  const bytes = Buffer.from('%PDF-1.4\n%%EOF\n');
  const sealed = sealDocument(bytes);
  const plaintext = await documentBytesFromPointer(
    { blobUrl: null, objectKey: 'users/user-1/documents/a.pdf' },
    {
      resolveObjectUrl: async () => 'https://blob.example/resolved.pdf',
      fetchObject: async () => ({ ok: true, arrayBuffer: async () => asArrayBuffer(sealed) }),
    },
  );
  assert.deepEqual(plaintext, bytes);
});

test('an unresolvable or unfetchable document throws instead of returning empty bytes', async () => {
  process.env.ENCRYPTION_KEY = 'test-key';
  await assert.rejects(
    documentBytesFromPointer(
      { blobUrl: null, objectKey: 'users/user-1/documents/a.pdf' },
      { resolveObjectUrl: async () => null, fetchObject: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }) },
    ),
    /unavailable/,
  );
  await assert.rejects(
    documentBytesFromPointer(
      { blobUrl: 'https://blob.example/a.pdf', objectKey: 'users/user-1/documents/a.pdf' },
      { resolveObjectUrl: async () => null, fetchObject: async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }) },
    ),
    /could not be downloaded/,
  );
});

test('the size cap is 4 MB and is refused before anything is written to storage', async () => {
  /* The cap is enforced here rather than only in the route because the managed sandbox is what
   * sets it: it carries an upload as base64 and refuses anything over 6,000,000 characters, with
   * no request-body limit in front of that check. A 10 MB promise would hold on direct-Playwright
   * portals and break on managed ones. put() is never reached, so this needs no Blob store. */
  assert.equal(MAX_USER_DOCUMENT_BYTES, 4_000_000);
  await assert.rejects(
    putUserDocument({
      userId: 'user-1',
      kind: 'transcript',
      fileName: 'transcript.pdf',
      contentType: 'application/pdf',
      bytes: Buffer.alloc(MAX_USER_DOCUMENT_BYTES + 1),
      reusable: true,
    }),
    /larger than the 4 MB limit/,
  );
  await assert.rejects(
    putUserDocument({
      userId: 'user-1',
      kind: 'transcript',
      fileName: 'transcript.pdf',
      contentType: 'application/pdf',
      bytes: Buffer.alloc(0),
      reusable: true,
    }),
    /empty/,
  );
  await assert.rejects(
    putUserDocument({
      userId: 'user-1',
      kind: 'diploma' as never,
      fileName: 'diploma.pdf',
      contentType: 'application/pdf',
      bytes: Buffer.from('%PDF-1.4\n'),
      reusable: true,
    }),
    /Unsupported document kind/,
  );
});

test('the store exports the reads the later screens need, so neither needs another migration', () => {
  // Screen 05 (auto-reuse) lists, screen 07 (Profile > Documents) lists and removes. Both endpoints
  // ship in the HTTP work item; this pins that the storage layer already answers them, which is the
  // claim that makes this the last migration for the feature.
  assert.equal(typeof listUserDocuments, 'function');
  assert.equal(typeof tombstoneUserDocument, 'function');
});
