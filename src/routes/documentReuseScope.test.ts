import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';

/* THE CHECKBOX IS A SERVER RULE, OR IT IS NOTHING.
 *
 * The upload modal ships "Reuse this for future applications that ask" ticked, and unticking it is
 * read back to the student as: "Attached to this application only. Litos will ask again the next
 * time an employer wants one." POST /applications/:id/documents/attach is the only way a stored file
 * reaches a SECOND application from outside this service, so that sentence is a promise about this
 * endpoint's WHERE clause and about nothing else.
 *
 * WHY A REAL DATABASE, when a grep for the predicate would be a tenth of the lines. The predicate is
 * one term inside a drizzle `and(...)` that also carries the ownership check, so a source-text test
 * asserting it is present passes just as happily whether the statement is an UPDATE that enforces it
 * or a SELECT that reads it and forgets. What matters is the number of rows the database changes,
 * and the only way to count those is to run them. documentPacketScope.test.ts makes the same
 * argument for the same table, after a source-text fence passed over a real scoping hole.
 *
 * THREE OUTCOMES ARE ASSERTED FOR EVERY REFUSAL, because a 404 alone would also be produced by a
 * route that did the write and then lied about it: the status, the application's stored spec, and
 * last_used_at. A refusal that stamped last_used_at would move the file to the top of her library's
 * "last used" order for an application it was never attached to.
 *
 * The fixture is PGlite over a unix socket with the production `db` module, the production route and
 * the production auth middleware, and the DDL is generated from db/schema.ts at run time so it
 * cannot drift from the real schema.
 */

const JWT_SIGNING_SECRET = 'document-reuse-scope-test-secret';
const ENCRYPTION_KEY = 'document-reuse-scope-test-key';

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  JWT_SIGNING_SECRET: process.env.JWT_SIGNING_SECRET,
};

let socketDir: string;
let pglite: PGlite;
let server: PGLiteSocketServer;
let pool: typeof import('../db/index')['pool'];
let app: FastifyInstance;
let schema: typeof import('../db/schema');
let db: typeof import('../db/index')['db'];

let userId = '';
let token = '';
/** The application the files were uploaded against. Every later one is minted per test. */
let firstApplicationId = '';
/** Ticked: she said future applications may use it. */
let reusableDocumentId = '';
/** Unticked: she said this one was for the first employer. */
let oneApplicationDocumentId = '';
/** Ticked once, then removed. The blob is gone; only the tombstone is left. */
let removedDocumentId = '';

const documentValues = (objectKey: string) => ({
  user_id: userId,
  kind: 'transcript',
  file_name: 'transcript.pdf',
  content_type: 'application/pdf',
  byte_size: 182_431,
  object_key: objectKey,
  blob_url: `https://blob.example.test/${objectKey}`,
  encryption_scheme: 'aes-256-gcm.v1',
});

/* A NEW APPLICATION PER TEST, and it is not tidiness.
 *
 * Every refusal below asserts that the target application carries no transcript afterwards. Sharing
 * one row between them means the FIRST test to attach something poisons that assertion for the rest,
 * so a run against the unfixed route reported three failures where only one was real - and, worse,
 * the two spurious ones would have read as evidence the other predicates were broken too. Each test
 * gets a row nothing else has touched, so each failure names its own defect. */
async function freshApplication(): Promise<string> {
  const [row] = await db.insert(schema.generated_resumes).values({
    user_id: userId,
    job_context: {},
    spec: {},
    resume_object_key: `users/${userId}/resumes/${crypto.randomUUID()}.pdf`,
  }).returning({ id: schema.generated_resumes.id });
  return row.id;
}

async function attach(applicationId: string, documentId: string) {
  return app.inject({
    method: 'POST',
    url: `/applications/${applicationId}/documents/attach`,
    headers: { authorization: `Bearer ${token}` },
    payload: { document_id: documentId, kind: 'transcript' },
  });
}

/** What the application actually carries now, read back from the column the route writes. */
async function storedTranscript(applicationId: string): Promise<Record<string, unknown> | null> {
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select({ spec: schema.generated_resumes.spec })
    .from(schema.generated_resumes)
    .where(eq(schema.generated_resumes.id, applicationId))
    .limit(1);
  const documents = (row?.spec as Record<string, unknown> | null)?._documents as Record<string, unknown> | undefined;
  return (documents?.transcript as Record<string, unknown> | undefined) ?? null;
}

async function lastUsedAt(documentId: string): Promise<Date | null> {
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select({ last_used_at: schema.user_documents.last_used_at })
    .from(schema.user_documents)
    .where(eq(schema.user_documents.id, documentId))
    .limit(1);
  return row?.last_used_at ?? null;
}

before(async () => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.JWT_SIGNING_SECRET = JWT_SIGNING_SECRET;

  socketDir = mkdtempSync(join(tmpdir(), 'litos-doc-reuse-'));
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({ db: pglite, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;

  schema = await import('../db/schema');
  const dbModule = await import('../db/index');
  db = dbModule.db;
  pool = dbModule.pool;

  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await pglite.exec(statement);

  const { users, generated_resumes, user_documents } = schema;
  const [account] = await db.insert(users).values({ email: 'reuse@example.test' }).returning();
  userId = account.id;

  const [first] = await db.insert(generated_resumes).values({
    user_id: userId,
    job_context: {},
    spec: {},
    resume_object_key: `users/${userId}/resumes/first.pdf`,
  }).returning({ id: generated_resumes.id });
  firstApplicationId = first.id;

  const documents = await db.insert(user_documents).values([
    {
      ...documentValues(`users/${userId}/documents/11111111-1111-4111-8111-111111111111.pdf`),
      reusable: true,
      first_application_id: firstApplicationId,
    },
    {
      ...documentValues(`users/${userId}/documents/22222222-2222-4222-8222-222222222222.pdf`),
      reusable: false,
      first_application_id: firstApplicationId,
    },
    {
      ...documentValues(`users/${userId}/documents/33333333-3333-4333-8333-333333333333.pdf`),
      // tombstoneUserDocument clears reusable alongside deleted_at, so a removed row looks like
      // this and not like a live non-reusable one.
      reusable: false,
      deleted_at: new Date('2026-08-10T09:00:00.000Z'),
      first_application_id: firstApplicationId,
    },
  ]).returning({ id: user_documents.id });
  reusableDocumentId = documents[0].id;
  oneApplicationDocumentId = documents[1].id;
  removedDocumentId = documents[2].id;

  token = await new SignJWT({
    userId,
    email: 'reuse@example.test',
    isGuest: false,
    authMethod: 'password',
    sessionVersion: 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SIGNING_SECRET));

  const { documentRoutes } = await import('./documents');
  app = Fastify({ logger: false });
  await app.register(documentRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  await pool?.end();
  await server?.stop();
  await pglite?.close();
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('a file she said was for one application cannot be attached to the next one', async () => {
  const laterApplicationId = await freshApplication();
  const before = await lastUsedAt(oneApplicationDocumentId);
  const response = await attach(laterApplicationId, oneApplicationDocumentId);
  assert.equal(response.statusCode, 404, response.body);
  /* The message says the document was not found and deliberately does not distinguish which of the
     four terms missed. A caller told "that file is not reusable" learns which ids exist. */
  assert.deepEqual(response.json(), { error: 'Document not found' });
  assert.equal(await storedTranscript(laterApplicationId), null,
    'a refused attach must not leave the application carrying the file anyway');
  assert.deepEqual(await lastUsedAt(oneApplicationDocumentId), before,
    'a refused attach must not stamp the file as used');
});

test('a removed file cannot be attached, so no application points at a deleted blob', async () => {
  const laterApplicationId = await freshApplication();
  const response = await attach(laterApplicationId, removedDocumentId);
  assert.equal(response.statusCode, 404, response.body);
  assert.equal(await storedTranscript(laterApplicationId), null);
  assert.equal(await lastUsedAt(removedDocumentId), null);
});

test('another account cannot attach this account\'s file', async () => {
  const laterApplicationId = await freshApplication();
  const { users } = schema;
  const [stranger] = await db.insert(users).values({ email: 'stranger@example.test' }).returning();
  const strangerToken = await new SignJWT({
    userId: stranger.id,
    email: 'stranger@example.test',
    isGuest: false,
    authMethod: 'password',
    sessionVersion: 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SIGNING_SECRET));

  const response = await app.inject({
    method: 'POST',
    url: `/applications/${laterApplicationId}/documents/attach`,
    headers: { authorization: `Bearer ${strangerToken}` },
    payload: { document_id: reusableDocumentId, kind: 'transcript' },
  });
  // Refused on the application before the document is ever looked up, which is the outer of the two
  // scopes. Asserted here so the reusable case below cannot be read as the only thing standing
  // between one account and another's transcript.
  assert.equal(response.statusCode, 404, response.body);
  assert.equal(await storedTranscript(laterApplicationId), null);
  assert.equal(await lastUsedAt(reusableDocumentId), null);
});

test('a file she said to reuse is attached, and stamped as used', async () => {
  const laterApplicationId = await freshApplication();
  const response = await attach(laterApplicationId, reusableDocumentId);
  assert.equal(response.statusCode, 200, response.body);

  const attachment = await storedTranscript(laterApplicationId);
  assert.equal(attachment?.document_id, reusableDocumentId);
  assert.equal(attachment?.file_name, 'transcript.pdf');
  assert.equal(
    attachment?.object_key,
    `users/${userId}/documents/11111111-1111-4111-8111-111111111111.pdf`,
    'the packet builder fetches by this key, so the spec has to carry the real one',
  );
  assert.ok(typeof attachment?.attached_at === 'string');

  const stamped = await lastUsedAt(reusableDocumentId);
  assert.ok(stamped instanceof Date, 'last used drives the account card and the auto-reuse pick order');

  // The response body is the client's copy of the same attachment, and it may not carry the pointer.
  // A Vercel Blob object is public-read forever to anyone holding its URL.
  const body = response.json() as { attachment: Record<string, unknown> };
  assert.equal(body.attachment.document_id, reusableDocumentId);
  assert.equal('object_key' in body.attachment, false);
  assert.equal('blob_url' in body.attachment, false);
});
