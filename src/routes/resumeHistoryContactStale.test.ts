/* THE PACKET REVIEW SCREEN NEVER SEES resume_contact_stale, BECAUSE IT NEVER FETCHES THE ROUTE THAT
 * CARRIED IT.
 *
 * MEASURED live on trylitos.com 2026-09-04, on a fresh load of the packet review screen for a
 * stale packet (Pony.ai fdcf4ccb, Mercari 8b3d8b2d - both stored "Dubai, Dubai" / +971 while
 * application_profile now reads "Los Angeles, California" / +1): the dashboard's own network log
 * for that load never called GET /applications/:id/submission at all. role-quick-website PR #546
 * shipped `resumeContactStaleNotice(selectedSubmission)` correctly, and volley-backend PR #945
 * shipped `resume_contact_stale` on GET /applications/:id/submission correctly - but the client
 * state that screen actually reads on a fresh load (app/dashboard/applications/page.tsx's
 * `selectPacket`, ~line 1621) is seeded from the board row GET /resume/history returned, and that
 * row never carried the field. Two correct halves, wired to different data.
 *
 * THIS FILE PINS THE FIX: /resume/history rows now carry resume_contact_stale, computed by the same
 * resumeContactStaleness (lib/resumeContactOfRecord.ts) GET /applications/:id/submission already
 * uses, off the SAME per-request profile read (loadApplicationProfileLike, called once above the
 * row loop in routes/resume.ts, never per row). The fixture values are the exact measured pair
 * pinned in resumeContactOfRecord.test.ts and exercised against the submission route in
 * resumeContactRefresh.test.ts, so a reader can compare this file's assertions against those
 * directly rather than trust two differently-worded descriptions of the same drift.
 */

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
import type { ApplicationReviewState } from '../lib/applicationReview';

const JWT_SIGNING_SECRET = 'resume-history-contact-stale-secret';
const ENCRYPTION_KEY = 'resume-history-contact-stale-key';

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

/* THE MEASURED FIXTURE, byte for byte off resumeContactOfRecord.test.ts and
 * resumeContactRefresh.test.ts: a packet built while the account read Dubai/+971, an
 * application_profile row that reads Los Angeles/+1 - the applicant's actual move. */
const STALE_CONTACT = {
  full_name: 'Test Applicant',
  email: 'resume@example.test',
  phone: '+971 567417451',
  location: 'Dubai, Dubai',
};

/** What resumeContactStaleness computes off the profile seeded in before() below. */
const REFRESHED_CONTACT = {
  full_name: 'Test Applicant',
  email: 'resume@example.test',
  phone: '+1 213 574 6270',
  location: 'Los Angeles, California',
};

function baseReview(overrides: Partial<ApplicationReviewState> = {}): ApplicationReviewState {
  return {
    jd_text: 'Software Engineer at Northwind Labs',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: '2026-08-16T10:00:00.000Z',
    ...overrides,
  } as ApplicationReviewState;
}

async function applicationWith(
  contact: Record<string, unknown> | undefined,
  review: ApplicationReviewState,
): Promise<string> {
  const [row] = await db.insert(schema.generated_resumes).values({
    user_id: userId,
    job_context: { company: 'Northwind Labs', role: 'Software Engineer' },
    spec: { ...(contact ? { _contact: contact } : {}), _review: review },
    resume_object_key: `users/${userId}/resumes/${crypto.randomUUID()}.pdf`,
  }).returning({ id: schema.generated_resumes.id });
  return row.id;
}

type HistoryRow = { id: string; resume_contact_stale?: { stored: unknown; current: unknown } };

async function history(query?: string): Promise<HistoryRow[]> {
  const response = await app.inject({
    method: 'GET',
    url: query ? `/resume/history?${query}` : '/resume/history',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { resumes: HistoryRow[] }).resumes;
}

async function submission(applicationId: string): Promise<{ resume_contact_stale?: unknown }> {
  const response = await app.inject({
    method: 'GET',
    url: `/applications/${applicationId}/submission`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

before(async () => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.JWT_SIGNING_SECRET = JWT_SIGNING_SECRET;

  socketDir = mkdtempSync(join(tmpdir(), 'litos-resume-history-stale-'));
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

  const [account] = await db.insert(schema.users).values({ email: 'resume-history-stale@example.test' }).returning();
  userId = account.id;

  await db.insert(schema.profiles).values({ user_id: userId, parsed_json: {} });
  /* THE MOVE. Same three columns resumeContactRefresh.test.ts seeds for the identical fixture pair,
   * so REFRESHED_CONTACT is what loadApplicationProfileLike + resumeContactStaleness actually
   * produce here, not a hand-typed guess at what they should produce. */
  await db.insert(schema.application_profile).values({
    user_id: userId,
    phone: REFRESHED_CONTACT.phone,
    address_city: 'Los Angeles',
    address_state: 'California',
  });

  token = await new SignJWT({
    userId,
    email: 'resume-history-stale@example.test',
    isGuest: false,
    authMethod: 'password',
    sessionVersion: 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SIGNING_SECRET));

  const { applicationRoutes } = await import('./applications');
  const { resumeRoutes } = await import('./resume');
  app = Fastify({ logger: false });
  await app.register(applicationRoutes);
  await app.register(resumeRoutes);
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

test('a stale packet carries resume_contact_stale on its /resume/history row, and a current one omits it', async () => {
  const staleId = await applicationWith(STALE_CONTACT, baseReview());
  const currentId = await applicationWith(REFRESHED_CONTACT, baseReview());

  const rows = await history();
  const staleRow = rows.find((row) => row.id === staleId);
  const currentRow = rows.find((row) => row.id === currentId);
  assert.ok(staleRow, 'the stale packet must be in the history list at all');
  assert.ok(currentRow, 'the matching packet must be in the history list at all');

  assert.deepEqual(staleRow!.resume_contact_stale, { stored: STALE_CONTACT, current: REFRESHED_CONTACT },
    'the board row must carry the exact before/after pair the packet review screen renders');
  assert.equal(currentRow!.resume_contact_stale, undefined,
    'no drift means no signal, exactly like GET /applications/:id/submission');

  /* THE EXACT REQUEST THE DASHBOARD ISSUES ON A DIRECT PACKET LINK (page.tsx's historyPath, built
   * from requestedApplicationId) - not only the bare list. */
  const linked = await history(`application=${encodeURIComponent(staleId)}`);
  assert.deepEqual(linked.find((row) => row.id === staleId)?.resume_contact_stale,
    { stored: STALE_CONTACT, current: REFRESHED_CONTACT },
    'the single-packet lookup the dashboard actually calls must carry the field too');
});

test('the field GET /resume/history publishes is identical to GET /applications/:id/submission for the same packet', async () => {
  const staleId = await applicationWith(STALE_CONTACT, baseReview());

  /* Sequential, not Promise.all: PGlite is one WASM backend behind a socket server, and a second
   * connection racing a query against the first here does not merely queue - see
   * submissionProviderCallFence.db.test.ts's header for the measured concurrency ceiling this
   * fixture already ran into. Nothing about the claim under test needs these concurrent anyway. */
  const rows = await history();
  const direct = await submission(staleId);
  const historyRow = rows.find((row) => row.id === staleId);
  assert.ok(historyRow, 'the packet must be in the history list at all');

  assert.deepEqual(historyRow!.resume_contact_stale, direct.resume_contact_stale,
    'one comparison, one profile read, shared by both routes - a client cannot see one say stale '
    + 'and the other say nothing for the same packet');
});

test('a packet with no stored contact header at all reads exactly like a current one: no signal, no throw', async () => {
  /* Predates the header even existing in `spec._contact` - the same shape an applicant's oldest
   * packets are in today. resumeContactStaleness requires a `full_name` to compare against; the
   * route's own guard (mirroring GET /applications/:id/submission's) must read this as "nothing to
   * show her", never crash the whole history list over one old row. */
  const noHeaderId = await applicationWith(undefined, baseReview());

  const rows = await history();
  const row = rows.find((entry) => entry.id === noHeaderId);
  assert.ok(row, 'a packet with no contact header must still be listed');
  assert.equal(row!.resume_contact_stale, undefined);
});
