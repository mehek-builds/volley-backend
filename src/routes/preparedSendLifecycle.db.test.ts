import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';

/* THE FILLED APPLICATION THAT COULD NOT REACH ITS SEND.
 *
 * Measured in prod 2026-09-02 on The Maven Group "Cyber Test Engineer": a managed prepare had
 * filled the employer form and parked the packet at _review.status 'ready_for_final_approval',
 * and the canonical applications row it points at still read
 * (submission_state 'not_started', review_state 'ready') - the pair its generating INSERT gave it.
 * Every surface reading that row concluded the application still needed work, and 83 more sat
 * behind the same demotion.
 *
 * These tests pin both halves of the repair: the write, so a prepare from now on records the hold,
 * and the read heal, so the applications already parked recover without being prepared again.
 */

const JWT_SECRET = 'prepared-send-lifecycle-test-secret-32-chars';
const socketDir = mkdtempSync(join(tmpdir(), 'litos-prepared-send-'));
const savedEnv = { ...process.env };
let database: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let backendPool: { end(): Promise<void> };
let backendDb: any;

const USER_ID = '3d5b8e11-77aa-4c2e-9b31-0a55c1d2e3f4';

async function token(userId: string) {
  return new SignJWT({ userId, isGuest: false, sessionVersion: 0, authMethod: 'password' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(JWT_SECRET));
}

before(async () => {
  database = await PGlite.create();
  const initial = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of initial) await database.exec(statement);
  server = new PGLiteSocketServer({ db: database, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();
  process.env.VERCEL = '1';
  process.env.LOG_LEVEL = 'silent';
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  process.env.JWT_SIGNING_SECRET = JWT_SECRET;
  ({ db: backendDb, pool: backendPool } = await import('../db'));
  const { canonicalApplicationRoutes } = await import('./canonicalApplications');
  app = Fastify({ logger: false });
  await app.register(canonicalApplicationRoutes);
  await app.ready();
  await backendDb.insert(schema.users).values([
    { id: USER_ID, email: 'prepared-send@example.com', password_hash: 'x' },
  ]);
});

after(async () => {
  await app?.close();
  await backendPool?.end();
  await server?.stop();
  await database.close();
  rmSync(socketDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

/* The exact prod shape: an application whose packet is filled and waiting, whose lifecycle columns
 * are the ones src/routes/resume.ts writes at generation and nothing has moved since. */
async function makeMavenShapedRow(input: {
  packetReviewStatus: string;
  submission_state?: string;
  review_state?: string;
  tracker_state?: string;
} = { packetReviewStatus: 'ready_for_final_approval' }) {
  const packetId = randomUUID();
  const applicationId = randomUUID();
  await backendDb.insert(schema.generated_resumes).values({
    id: packetId,
    user_id: USER_ID,
    job_context: { company: 'The Maven Group', role: 'Cyber Test Engineer' },
    spec: { _review: { status: input.packetReviewStatus, portal_url: 'https://example.test/apply' } },
    resume_object_key: `resumes/${packetId}.pdf`,
  });
  await backendDb.insert(schema.applications).values({
    id: applicationId,
    user_id: USER_ID,
    legacy_generated_resume_id: packetId,
    company_scope_key: `name:${applicationId.slice(0, 8)}`,
    company_name: 'The Maven Group',
    role: 'Cyber Test Engineer',
    source_surface: 'dashboard',
    application_fingerprint: `fingerprint:${applicationId}`,
    tracker_state: input.tracker_state ?? 'applying',
    review_state: input.review_state ?? 'ready',
    submission_state: input.submission_state ?? 'not_started',
  });
  return { packetId, applicationId };
}

async function storedRow(applicationId: string) {
  const [row] = await backendDb.select().from(schema.applications)
    .where(eq(schema.applications.id, applicationId)).limit(1);
  return row;
}

async function listedRow(applicationId: string) {
  const response = await app.inject({
    method: 'GET',
    url: '/applications?limit=200',
    headers: { authorization: `Bearer ${await token(USER_ID)}` },
  });
  assert.equal(response.statusCode, 200);
  return response.json().applications.find((row: { id: string }) => row.id === applicationId);
}

test('a prepare parking a packet at ready_for_final_approval records the hold on the canonical row', async () => {
  const { packetId, applicationId } = await makeMavenShapedRow({ packetReviewStatus: 'ready_for_final_approval' });
  const { syncCanonicalApplicationPreparedSend } = await import('../lib/canonicalApplicationSync');
  await syncCanonicalApplicationPreparedSend({ packetId, userId: USER_ID, prepared: true });
  const row = await storedRow(applicationId);
  assert.equal(row.submission_state, 'ready_for_final_approval');
  assert.equal(row.review_state, 'ready_for_final_approval');
  // The hold is not a send. Nothing about the row may say an employer has it.
  assert.equal(row.tracker_state, 'applying');
  assert.notEqual(row.submission_state, 'submitted');
});

test('writeReview is the funnel that records it, for both entering and leaving the hold', async () => {
  const { readFileSync } = await import('node:fs');
  const runner = readFileSync(join(__dirname, 'submissionRunner.ts'), 'utf8');
  const funnel = runner.slice(runner.indexOf('export async function writeReview'));
  assert.match(
    funnel.slice(0, 4000),
    /advanceCanonicalApplicationPreparedSend\(\{[\s\S]*?packetId: row\.id,[\s\S]*?userId: row\.user_id,[\s\S]*?prepared: packetReviewIsPreparedSend\(review\.status\),/,
  );
});

test('leaving the hold returns the row to its resting pair, and never touches a row that was never parked', async () => {
  const { syncCanonicalApplicationPreparedSend } = await import('../lib/canonicalApplicationSync');
  const parked = await makeMavenShapedRow({
    packetReviewStatus: 'needs_attention',
    submission_state: 'ready_for_final_approval',
    review_state: 'ready_for_final_approval',
  });
  await syncCanonicalApplicationPreparedSend({ packetId: parked.packetId, userId: USER_ID, prepared: false });
  const released = await storedRow(parked.applicationId);
  assert.equal(released.submission_state, 'not_started');
  assert.equal(released.review_state, 'ready');

  const untouched = await makeMavenShapedRow({ packetReviewStatus: 'needs_attention' });
  await syncCanonicalApplicationPreparedSend({ packetId: untouched.packetId, userId: USER_ID, prepared: false });
  const after = await storedRow(untouched.applicationId);
  assert.equal(after.submission_state, 'not_started');
  assert.equal(after.review_state, 'ready');
});

test('a confirmed send is never moved backwards by either arm', async () => {
  const { syncCanonicalApplicationPreparedSend } = await import('../lib/canonicalApplicationSync');
  const sent = await makeMavenShapedRow({
    packetReviewStatus: 'ready_for_final_approval',
    submission_state: 'submitted',
    review_state: 'ready',
    tracker_state: 'applied',
  });
  await syncCanonicalApplicationPreparedSend({ packetId: sent.packetId, userId: USER_ID, prepared: true });
  const row = await storedRow(sent.applicationId);
  assert.equal(row.submission_state, 'submitted');
  assert.equal(row.tracker_state, 'applied');
});

test('GET /applications heals a row left behind, without re-preparing and without writing', async () => {
  const { applicationId } = await makeMavenShapedRow({ packetReviewStatus: 'ready_for_final_approval' });
  const listed = await listedRow(applicationId);
  assert.equal(listed.submission_state, 'ready_for_final_approval');
  assert.equal(listed.review_state, 'ready_for_final_approval');
  // A read stays a read: the derivation must not smuggle in an UPDATE.
  const stored = await storedRow(applicationId);
  assert.equal(stored.submission_state, 'not_started');
  assert.equal(stored.review_state, 'ready');
});

test('the read heal is symmetric: a stale-forward row stops advertising a filled form', async () => {
  const { applicationId } = await makeMavenShapedRow({
    packetReviewStatus: 'needs_attention',
    submission_state: 'ready_for_final_approval',
    review_state: 'ready_for_final_approval',
  });
  const listed = await listedRow(applicationId);
  assert.equal(listed.submission_state, 'not_started');
  assert.equal(listed.review_state, 'ready');
});

test('the read heal never overrides a receipt', async () => {
  const { applicationId } = await makeMavenShapedRow({
    packetReviewStatus: 'ready_for_final_approval',
    submission_state: 'submitted',
    tracker_state: 'applied',
  });
  const listed = await listedRow(applicationId);
  assert.equal(listed.submission_state, 'submitted');
  assert.equal(listed.tracker_state, 'applied');
});

test('a packet-less canonical row is unaffected by the join', async () => {
  const applicationId = randomUUID();
  await backendDb.insert(schema.applications).values({
    id: applicationId,
    user_id: USER_ID,
    company_scope_key: `name:${applicationId.slice(0, 8)}`,
    company_name: 'Free Fill Co',
    role: 'Analyst',
    source_surface: 'extension',
    application_fingerprint: `fingerprint:${applicationId}`,
    tracker_state: 'applying',
    review_state: 'filling',
    submission_state: 'not_started',
  });
  const listed = await listedRow(applicationId);
  assert.equal(listed.submission_state, 'not_started');
  assert.equal(listed.review_state, 'filling');
});

test('a filled but unsent application can still be taken off the tracker', async () => {
  const { applicationId } = await makeMavenShapedRow({
    packetReviewStatus: 'ready_for_final_approval',
    submission_state: 'ready_for_final_approval',
    review_state: 'ready_for_final_approval',
  });
  const response = await app.inject({
    method: 'POST',
    url: `/applications/${applicationId}/remove`,
    headers: { authorization: `Bearer ${await token(USER_ID)}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().removed, true);
});

test('a sent application still cannot be taken off the tracker', async () => {
  const { applicationId } = await makeMavenShapedRow({
    packetReviewStatus: 'submitted',
    submission_state: 'submitted',
    tracker_state: 'applied',
  });
  const response = await app.inject({
    method: 'POST',
    url: `/applications/${applicationId}/remove`,
    headers: { authorization: `Bearer ${await token(USER_ID)}` },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'application_not_removable');
});
