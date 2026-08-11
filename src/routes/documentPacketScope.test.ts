import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';

/* ONE STUDENT'S SPEC MAY NOT REACH ANOTHER STUDENT'S FILE.
 *
 * WHY THIS ONE IS TESTED AGAINST A REAL DATABASE, when everything else about the transcript is a
 * unit test or a source-text fence. The defect this file exists for was invisible to both of those
 * and had been reviewed past by both. documentBytesForPacket scoped its lookup by user_id from the
 * first line it was written, its comment said so, and transcriptAttachment.test.ts asserted the
 * predicate was in the source. All of that was true. What was also true is that a miss returned
 * `blob_url: null` into documentBytesFromPointer, whose fall-back is resolveBlobUrl - a resolver
 * that takes an object key alone and resolves any key in the store. So the scoped query ran, missed,
 * and the unscoped resolver then fetched the other account's file anyway.
 *
 * A source-text test cannot catch that, because every line it would grep for was present and
 * correct. An injected-lookup unit test cannot catch it either, because the lookup was never what
 * was wrong. The only assertion with power is the one made here: two real users, two real rows, one
 * real SQL predicate, and the resolver counted.
 *
 * Encryption is not a fallback for any of this. lib/documentCrypto.ts derives one key from one
 * server secret and one fixed salt, so bytes that resolve are bytes that decrypt: the scope check is
 * the entire control, and it has to hold on its own.
 *
 * The fixture is PGlite over a unix socket with the production `db` module and the production
 * driver, and the DDL is generated from db/schema.ts at run time so it cannot drift from the real
 * schema. Same pattern, and same reasoning, as routes/jobFacetsCounts.test.ts.
 */

const ENCRYPTION_KEY = 'document-packet-scope-test-key';
const JWT_SIGNING_SECRET = 'document-packet-scope-test-secret';

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  JWT_SIGNING_SECRET: process.env.JWT_SIGNING_SECRET,
  LITOS_ENABLE_TEST_PORTAL: process.env.LITOS_ENABLE_TEST_PORTAL,
};

let socketDir: string;
let pglite: PGlite;
let server: PGLiteSocketServer;
let pool: typeof import('../db/index')['pool'];
let documentBytesForPacket: typeof import('./submissionRunner')['documentBytesForPacket'];
let ForeignDocumentPointerError: typeof import('../lib/documentStore')['ForeignDocumentPointerError'];

type DocumentFixture = {
  userId: string;
  objectKey: string;
  blobUrl: string;
  plaintext: Buffer;
  // Filled in before(), once ENCRYPTION_KEY is set. Declared rather than inferred: Buffer.alloc
  // narrows to Buffer<ArrayBuffer> and sealDocument returns Buffer<ArrayBufferLike>.
  sealed: Buffer;
};

/** Her file, and the file belonging to the account next to hers. */
const HERS: DocumentFixture = {
  userId: '',
  objectKey: 'users/hers/documents/1f0c7a5e-4b33-4d9e-9d2a-0f2a9c1e6b1d.pdf',
  blobUrl: 'https://blob.example.test/users/hers/documents/1f0c7a5e.pdf',
  plaintext: Buffer.from('%PDF-1.4\nHER TRANSCRIPT\n%%EOF\n'),
  sealed: Buffer.alloc(0),
};
const THEIRS: DocumentFixture = {
  userId: '',
  objectKey: 'users/theirs/documents/2b6a1d8e-7c40-4f3a-9c2f-5d3f0b6a9a71.pdf',
  blobUrl: 'https://blob.example.test/users/theirs/documents/2b6a1d8e.pdf',
  plaintext: Buffer.from('%PDF-1.4\nSOMEBODY ELSE ENTIRELY\n%%EOF\n'),
  sealed: Buffer.alloc(0),
};

/* The injected pair, counted. `resolveObjectUrl` IS the unscoped resolver in production
 * (lib/resumeAccess.ts resolveBlobUrl), so a call to it on a refused pointer is the bug reproducing,
 * not a stylistic complaint. It is wired to return a real-looking URL rather than null so that a
 * regression fails on the assertion below rather than accidentally passing on a dead resolver. */
function countedBlobAccess() {
  const calls = { resolve: 0, fetch: 0, fetchedUrls: [] as string[] };
  const byUrl = new Map([
    [HERS.blobUrl, () => HERS.sealed],
    [THEIRS.blobUrl, () => THEIRS.sealed],
  ]);
  return {
    calls,
    dependencies: {
      resolveObjectUrl: async (objectKey: string) => {
        calls.resolve += 1;
        if (objectKey === HERS.objectKey) return HERS.blobUrl;
        if (objectKey === THEIRS.objectKey) return THEIRS.blobUrl;
        return null;
      },
      fetchObject: async (url: string) => {
        calls.fetch += 1;
        calls.fetchedUrls.push(url);
        const bytes = byUrl.get(url);
        if (!bytes) return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
        const buffer = bytes();
        return {
          ok: true,
          arrayBuffer: async () =>
            buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
        };
      },
    },
  };
}

before(async () => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.JWT_SIGNING_SECRET = JWT_SIGNING_SECRET;
  // The fixture branch would answer both cases with the same canned bytes and prove nothing about
  // either. This has to be the ordinary path.
  delete process.env.LITOS_ENABLE_TEST_PORTAL;

  socketDir = mkdtempSync(join(tmpdir(), 'litos-doc-scope-'));
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({ db: pglite, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;

  const schema = await import('../db/schema');
  const dbModule = await import('../db/index');
  const db = dbModule.db;
  pool = dbModule.pool;

  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await pglite.exec(statement);

  const { sealDocument, DOCUMENT_ENCRYPTION_SCHEME } = await import('../lib/documentCrypto');
  HERS.sealed = sealDocument(HERS.plaintext);
  THEIRS.sealed = sealDocument(THEIRS.plaintext);

  const { users, user_documents } = schema;
  const [her] = await db.insert(users).values({ email: 'hers@example.test' }).returning();
  const [them] = await db.insert(users).values({ email: 'theirs@example.test' }).returning();
  HERS.userId = her.id;
  THEIRS.userId = them.id;

  for (const document of [HERS, THEIRS]) {
    await db.insert(user_documents).values({
      user_id: document.userId,
      kind: 'transcript',
      file_name: 'transcript.pdf',
      content_type: 'application/pdf',
      byte_size: document.plaintext.length,
      object_key: document.objectKey,
      blob_url: document.blobUrl,
      encryption_scheme: DOCUMENT_ENCRYPTION_SCHEME,
      reusable: true,
    });
  }

  ({ documentBytesForPacket } = await import('./submissionRunner'));
  ({ ForeignDocumentPointerError } = await import('../lib/documentStore'));
});

after(async () => {
  await pool?.end();
  await server?.stop();
  await pglite?.close();
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('her own transcript loads from the URL the write returned, with no resolver call at all', async () => {
  const { calls, dependencies } = countedBlobAccess();
  const bytes = await documentBytesForPacket(HERS.userId, HERS.objectKey, false, dependencies);

  assert.deepEqual(bytes, HERS.plaintext, 'the packet carries the plaintext, not the sealed object');
  assert.deepEqual(calls.fetchedUrls, [HERS.blobUrl]);
  // H6: the stored URL is read first precisely so the eventually-consistent list is never on the
  // critical path. If this ever goes above zero, a transcript uploaded and attached in one sitting
  // starts reading as deleted again, which is what R-040 was.
  assert.equal(calls.resolve, 0, 'blob_url is on the row, so the resolver must not be reached');
});

test('a spec naming another account\'s object key is refused, and no resolver is asked', async () => {
  const { calls, dependencies } = countedBlobAccess();

  await assert.rejects(
    () => documentBytesForPacket(HERS.userId, THEIRS.objectKey, false, dependencies),
    (error: unknown) => {
      assert.ok(error instanceof ForeignDocumentPointerError, `refusal must be named, got ${String(error)}`);
      return true;
    },
  );

  /* THE COUNT IS THE TEST. Before the fix this same call resolved THEIRS.objectKey through the
   * unscoped resolver and fetched their file, so `resolve` was 1, `fetch` was 1, and the function
   * returned the other student's transcript as a Buffer. Asserting on the throw alone would not
   * distinguish the fix from a refusal that still made the request first. */
  assert.equal(calls.resolve, 0, 'the unscoped resolver must never see a key the scope check refused');
  assert.equal(calls.fetch, 0, 'nothing may be fetched for a pointer this account does not own');
});

test('the refusal never reaches the other account\'s bytes by any route', async () => {
  /* Belt and braces on the assertion above, stated as the thing that actually matters rather than
   * as a call count: whatever this path does, THEIRS.plaintext must not come back out of it. */
  const { dependencies } = countedBlobAccess();
  let returned: Buffer | null = null;
  try {
    returned = await documentBytesForPacket(HERS.userId, THEIRS.objectKey, false, dependencies);
  } catch {
    returned = null;
  }
  assert.equal(returned, null);
});

test('an object key belonging to nobody is the same refusal, not a store-wide lookup', async () => {
  const { calls, dependencies } = countedBlobAccess();
  await assert.rejects(
    () => documentBytesForPacket(HERS.userId, 'users/hers/documents/never-written.pdf', false, dependencies),
    ForeignDocumentPointerError,
  );
  assert.equal(calls.resolve, 0);
  assert.equal(calls.fetch, 0);
});

test('the refusal names no object key, because its message is logged verbatim', () => {
  /* Both prepare paths write this string into a warn line as `reason`. An object key plus the
   * store's stable base URL is permanent unauthenticated access to whoever's file it is, so putting
   * the key in the message would leak a pointer to report a leaked pointer. */
  const message = new ForeignDocumentPointerError().message;
  assert.doesNotMatch(message, /users\//);
  assert.doesNotMatch(message, /\.pdf/);
  assert.ok(message.length > 0);
});
