import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import Fastify, { type FastifyInstance } from 'fastify';

/* THE FILE SHE ALREADY GAVE US, ATTACHED WITHOUT ASKING HER AGAIN.
 *
 * /privacy publishes "so a later application can use the same file without us asking you for it
 * again", the upload modal's checkbox says "Reuse this for future applications that ask" and ships
 * ticked, and its confirmation tells her the next application gets it. `user_documents.reusable` was
 * written by the upload route and read as a filter by NOTHING, so every one of those sentences
 * described behaviour the build did not have and every second application asked her for the same
 * file.
 *
 * documentReuseScope.test.ts covers the endpoint a CLIENT calls to reuse a file. This covers the
 * path with no client at all: the prepare run measures a document ask off the employer's own form
 * and attaches the stored file itself, which is the half of the promise a screen cannot keep -
 * standing consent sends without anyone opening the dashboard.
 *
 * WHY A REAL DATABASE. The whole feature is one WHERE clause. A source-text test asserting
 * `reusable` appears in an `and(...)` passes just as happily whether the statement enforces it or
 * merely mentions it, and what matters is which row comes back. The tests below assert what the
 * database actually did: which document was picked, whether last_used_at moved, and what the
 * application's spec holds afterwards. documentPacketScope.test.ts makes the same argument for the
 * same table after a source-text fence passed over a real scoping hole.
 *
 * Every refusal asserts BOTH the pick and the stamp, because a reuse that returned null and still
 * stamped last_used_at would move a file to the top of her library's "last used" order for an
 * application it was never attached to.
 */

const ENCRYPTION_KEY = 'document-auto-reuse-test-key';

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
};

let socketDir: string;
let pglite: PGlite;
let server: PGLiteSocketServer;
let pool: typeof import('../db/index')['pool'];
let schema: typeof import('../db/schema');
let db: typeof import('../db/index')['db'];
let app: FastifyInstance;
let claimReusableDocument: typeof import('../lib/documentStore')['claimReusableDocument'];
let reuseStoredDocuments: typeof import('./submissionRunner')['reuseStoredDocuments'];

/** Ticked the box, used most recently. The one every reuse below should land on. */
let recentReusableId = '';
/** Ticked the box, older. Present so "newest use first" is a claim with a loser. */
let olderReusableId = '';

/* The employer's ask, as requiredDocumentAsks derives it off their own label. A review with no
   `required_documents` has been measured by nothing, and nothing may be attached to it. */
const TRANSCRIPT_ASK = {
  kind: 'transcript' as const,
  label: 'Unofficial transcript (PDF)',
  official_requested: false,
};

/** The minimum review shape reuseStoredDocuments reads. Everything else on the state is irrelevant. */
function review(patch: Record<string, unknown> = {}) {
  return {
    status: 'ready_for_final_approval',
    questions: [],
    skipped_reasons: [],
    edited_terms: [],
    updated_at: '2026-08-11T09:00:00.000Z',
    required_documents: [TRANSCRIPT_ASK],
    ...patch,
  } as unknown as Parameters<typeof reuseStoredDocuments>[1];
}

const documentValues = (userId: string, objectKey: string) => ({
  user_id: userId,
  kind: 'transcript',
  file_name: 'spring-2026-transcript.pdf',
  content_type: 'application/pdf',
  byte_size: 182_431,
  object_key: objectKey,
  blob_url: `https://blob.example.test/${objectKey}`,
  encryption_scheme: 'aes-256-gcm.v1',
});

async function newAccount(email: string): Promise<string> {
  const [account] = await db.insert(schema.users).values({ email }).returning();
  return account.id;
}

/* A NEW APPLICATION PER TEST. Every refusal asserts the application carries nothing afterwards, and
   sharing one row means the first test to attach something poisons that assertion for the rest. */
async function freshApplication(userId: string, spec: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db.insert(schema.generated_resumes).values({
    user_id: userId,
    job_context: {},
    spec,
    resume_object_key: `users/${userId}/resumes/${crypto.randomUUID()}.pdf`,
  }).returning({ id: schema.generated_resumes.id });
  return row.id;
}

async function applicationRow(applicationId: string) {
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select().from(schema.generated_resumes)
    .where(eq(schema.generated_resumes.id, applicationId)).limit(1);
  return row;
}

async function storedDocumentMarks(applicationId: string): Promise<Record<string, Record<string, unknown>>> {
  const row = await applicationRow(applicationId);
  return ((row?.spec as Record<string, unknown> | null)?._documents ?? {}) as Record<string, Record<string, unknown>>;
}

async function lastUsedAt(documentId: string): Promise<Date | null> {
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select({ last_used_at: schema.user_documents.last_used_at })
    .from(schema.user_documents).where(eq(schema.user_documents.id, documentId)).limit(1);
  return row?.last_used_at ?? null;
}

let ownerId = '';

before(async () => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;

  socketDir = mkdtempSync(join(tmpdir(), 'litos-auto-reuse-'));
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

  ({ claimReusableDocument } = await import('../lib/documentStore'));
  ({ reuseStoredDocuments } = await import('./submissionRunner'));

  // Only its logger is read. A real instance rather than a stub, so a future line that reaches for
  // anything else on it fails here instead of in production.
  app = Fastify({ logger: false });

  ownerId = await newAccount('auto-reuse@example.test');
  const stored = await db.insert(schema.user_documents).values([
    {
      ...documentValues(ownerId, `users/${ownerId}/documents/11111111-1111-4111-8111-111111111111.pdf`),
      reusable: true,
      last_used_at: new Date('2026-08-10T09:00:00.000Z'),
    },
    {
      ...documentValues(ownerId, `users/${ownerId}/documents/22222222-2222-4222-8222-222222222222.pdf`),
      reusable: true,
      last_used_at: new Date('2026-07-01T09:00:00.000Z'),
    },
  ]).returning({ id: schema.user_documents.id });
  recentReusableId = stored[0].id;
  olderReusableId = stored[1].id;
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

/* ---- the pick ---- */

test('the newest-used reusable file is the one picked, and using it stamps that fact', async () => {
  /* Newest use first is the same order Profile > Documents shows. Two orders would mean the file at
     the top of the list she is looking at is not the file the next application picks. */
  const claimed = await claimReusableDocument(ownerId, 'transcript');
  assert.equal(claimed?.id, recentReusableId);
  assert.equal(claimed?.file_name, 'spring-2026-transcript.pdf');
  assert.equal(
    claimed?.object_key,
    `users/${ownerId}/documents/11111111-1111-4111-8111-111111111111.pdf`,
    'the packet builder fetches by this key, so the claim has to carry the real one',
  );

  const stamped = await lastUsedAt(recentReusableId);
  assert.ok(stamped instanceof Date && stamped.getTime() > Date.parse('2026-08-10T09:00:00.000Z'),
    'a reuse that did not stamp last_used_at would tell her the file had never been used');
  assert.deepEqual(await lastUsedAt(olderReusableId), new Date('2026-07-01T09:00:00.000Z'),
    'the file that was not picked must not be stamped as though it had been');
});

test('a file she said was for one application only is never picked', async () => {
  /* THE ONE THE WHOLE COLUMN EXISTS FOR. She unticked the box to say that file was for one employer.
     A fallback to "take it anyway if nothing else matches" would be the checkbox doing nothing, and
     there is no screen anywhere that would show her it had happened. */
  const soloUser = await newAccount('one-application@example.test');
  const [solo] = await db.insert(schema.user_documents).values({
    ...documentValues(soloUser, `users/${soloUser}/documents/33333333-3333-4333-8333-333333333333.pdf`),
    reusable: false,
  }).returning({ id: schema.user_documents.id });

  assert.equal(await claimReusableDocument(soloUser, 'transcript'), null,
    'no reusable file means no reuse, and she is asked');
  assert.equal(await lastUsedAt(solo.id), null, 'a refused pick must not stamp the file as used');
});

test('a removed file is never picked, so no application points at a deleted blob', async () => {
  const removedUser = await newAccount('removed@example.test');
  // tombstoneUserDocument clears reusable alongside deleted_at, so a removed row looks like this.
  // deleted_at is asserted separately below because it is the term that has to hold on its own.
  const [removed] = await db.insert(schema.user_documents).values({
    ...documentValues(removedUser, `users/${removedUser}/documents/44444444-4444-4444-8444-444444444444.pdf`),
    reusable: true,
    deleted_at: new Date('2026-08-09T09:00:00.000Z'),
  }).returning({ id: schema.user_documents.id });

  assert.equal(await claimReusableDocument(removedUser, 'transcript'), null);
  assert.equal(await lastUsedAt(removed.id), null);
});

test('a kind nobody has stored is not answered with a file of another kind', async () => {
  assert.equal(await claimReusableDocument(ownerId, 'writing_sample'), null);
});

test('another account\'s file is not reachable through the pick', async () => {
  const stranger = await newAccount('stranger-reuse@example.test');
  assert.equal(await claimReusableDocument(stranger, 'transcript'), null);
});

/* ---- what the prepare run writes ---- */

test('a measured ask on an application carrying nothing gets the stored file, without asking her', async () => {
  const applicationId = await freshApplication(ownerId);
  const row = await applicationRow(applicationId);
  await reuseStoredDocuments(row, review(), app);

  const marks = await storedDocumentMarks(applicationId);
  assert.equal(marks.transcript?.document_id, recentReusableId);
  assert.equal(marks.transcript?.file_name, 'spring-2026-transcript.pdf');
  assert.equal(
    marks.transcript?.object_key,
    `users/${ownerId}/documents/11111111-1111-4111-8111-111111111111.pdf`,
  );
  assert.ok(typeof marks.transcript?.attached_at === 'string',
    'attached_at is what the send gate reads, and what the review screen lists');
  assert.equal(marks.transcript?.ordered_at, null);
  assert.equal(marks.transcript?.employer_label, 'Unofficial transcript (PDF)',
    'the modal shows her their wording when she reopens it');
});

test('an application nothing has measured gets nothing attached to it', async () => {
  /* The tri-state. `required_documents` absent means no run on this build has looked at the form,
     and a file attached on the strength of that would be a guess sent to an employer. */
  const applicationId = await freshApplication(ownerId);
  await reuseStoredDocuments(await applicationRow(applicationId), review({ required_documents: undefined }), app);
  assert.deepEqual(await storedDocumentMarks(applicationId), {});

  const measuredEmpty = await freshApplication(ownerId);
  await reuseStoredDocuments(await applicationRow(measuredEmpty), review({ required_documents: [] }), app);
  assert.deepEqual(await storedDocumentMarks(measuredEmpty), {});
});

test('a form the run found no control on is not reused into', async () => {
  /* Recording an attachment here would write down that this employer is getting the transcript when
     nothing on either send path can deliver it. The ask stays outstanding, the screen says why, and
     the send stays blocked - which is the honest state and the one the student can act on. */
  const applicationId = await freshApplication(ownerId);
  await reuseStoredDocuments(await applicationRow(applicationId), review({ transcript_supported: false }), app);
  assert.deepEqual(await storedDocumentMarks(applicationId), {});
});

test('an unmeasured capability still reuses, because unknown is not no', async () => {
  const applicationId = await freshApplication(ownerId);
  await reuseStoredDocuments(await applicationRow(applicationId), review({ transcript_supported: true }), app);
  assert.equal((await storedDocumentMarks(applicationId)).transcript?.document_id, recentReusableId);
});

test('reuse never overwrites a file she chose herself', async () => {
  const applicationId = await freshApplication(ownerId, {
    _documents: {
      transcript: {
        document_id: olderReusableId,
        file_name: 'the one she picked.pdf',
        object_key: `users/${ownerId}/documents/22222222-2222-4222-8222-222222222222.pdf`,
        attached_at: '2026-08-11T08:00:00.000Z',
        ordered_at: null,
        employer_label: null,
        official_requested: false,
      },
    },
  });
  await reuseStoredDocuments(await applicationRow(applicationId), review(), app);

  const marks = await storedDocumentMarks(applicationId);
  assert.equal(marks.transcript?.document_id, olderReusableId);
  assert.equal(marks.transcript?.file_name, 'the one she picked.pdf');
});

test('reuse never answers over "I have ordered it"', async () => {
  /* A mark exists only because she did something, and this one is the answer that decides whether
     the application is Litos's to finish at all. Attaching on top of it would quietly replace a
     decision she had already made. */
  const applicationId = await freshApplication(ownerId, {
    _documents: {
      transcript: {
        document_id: null,
        file_name: null,
        object_key: null,
        attached_at: null,
        ordered_at: '2026-08-11T08:00:00.000Z',
        employer_label: 'Official transcript',
        official_requested: true,
      },
    },
  });
  await reuseStoredDocuments(await applicationRow(applicationId), review(), app);

  const marks = await storedDocumentMarks(applicationId);
  assert.equal(marks.transcript?.document_id, null);
  assert.equal(marks.transcript?.ordered_at, '2026-08-11T08:00:00.000Z');
});

test('the write merges into _documents rather than replacing the spec around it', async () => {
  /* jsonb_set with create_missing only creates the LAST element of the path, so the nested form is a
     silent no-op on a spec that has never held a document - which is every application. The `||`
     merge is what keeps a second document kind, and the surrounding spec is what the resume is. */
  const applicationId = await freshApplication(ownerId, {
    summary: 'the packet itself',
    _documents: { writing_sample: { document_id: null, ordered_at: '2026-08-01T09:00:00.000Z' } },
  });
  await reuseStoredDocuments(await applicationRow(applicationId), review(), app);

  const row = await applicationRow(applicationId);
  const spec = row.spec as Record<string, unknown>;
  assert.equal(spec.summary, 'the packet itself', 'the reuse must not rewrite the packet it rides on');
  const marks = spec._documents as Record<string, Record<string, unknown>>;
  assert.equal(marks.transcript?.document_id, recentReusableId);
  assert.equal(marks.writing_sample?.ordered_at, '2026-08-01T09:00:00.000Z', 'another kind is another key');
});

test('an account with nothing stored is left alone, and the run is not disturbed', async () => {
  const emptyUser = await newAccount('nothing-stored@example.test');
  const applicationId = await freshApplication(emptyUser);
  await reuseStoredDocuments(await applicationRow(applicationId), review(), app);
  assert.deepEqual(await storedDocumentMarks(applicationId), {},
    'no reusable file means the ask stays outstanding and she is asked, which is the state before this feature');
});
