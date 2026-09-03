import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as schema from '../db/schema';

/* REJOINING A BUILD RATHER THAN PAYING FOR IT AGAIN: what GET /applications/onboarding-packet
 * must answer, and what it must never do.
 *
 * WHY THIS EXISTS AT ALL. /start holds its built packet in memory for the sitting, so a reload
 * between the build screen and the send screen dropped it, returned the student to the build step
 * and spent ANOTHER free onboarding build on the SAME posting. Two reloads exhausted the
 * allowance of two and bricked the account: it could not finish setup (the build needs an
 * entitlement it no longer had) and could not reach the dashboard (THE CARD GATE holds it shut
 * until setup completes). Measured on production 2026-09-03: onboarding_builds_used 2,
 * onboarding_completed_at NULL.
 *
 * A DATABASE TEST BECAUSE EVERY ANSWER IS A QUERY OUTCOME. Which row is "the one in progress",
 * whether a removed application still counts, whether the packet on the wire is the one the
 * application actually names, and whether another account's packet can be reached through a
 * dangling column - none of that is visible from a unit test of the handler's shape.
 *
 * THE LAST TEST IS THE POINT OF THE WHOLE ROUTE: reading a packet must not touch the grant
 * counter. If it ever does, the reload is paying again and the bug is back.
 */

const JWT_SECRET = 'onboarding-packet-rejoin-db-test-secret';
const socketDir = mkdtempSync(join(tmpdir(), 'litos-onboarding-packet-'));
const savedEnv = { ...process.env };
const STUDENT = '5f1b2c73-40de-4a5c-9d21-6b8ea3c17d40';
const OTHER_STUDENT = '9a44c8e1-2f0b-4d76-8c53-1e7fa0b94c22';
const JOB = 'c31d7a94-6e0f-4b28-9a7d-2f5c8e13b706';
const OTHER_JOB = 'e70b4c12-8d35-4a09-b6f1-3c92d5a7e814';

let database: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let backendPool: { end(): Promise<void> };
let authorization: string;

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
  process.env.ENCRYPTION_KEY = 'onboarding-packet-rejoin-db-test-encryption-key';

  ({ pool: backendPool } = await import('../db'));
  const { applicationFromJobRoutes } = await import('./applicationFromJob');
  app = Fastify({ logger: false });
  await app.register(applicationFromJobRoutes);
  await app.ready();

  authorization = `Bearer ${await new SignJWT({ userId: STUDENT, isGuest: false, sessionVersion: 0, authMethod: 'password' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(JWT_SECRET))}`;
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

beforeEach(async () => {
  await database.exec('truncate "generated_resumes", "applications", "users" cascade');
});

async function seedStudent({ completed = false, userId = STUDENT, email = 'student@example.com' } = {}) {
  await database.query(
    `insert into "users" ("id", "email", "email_verified", "is_guest", "onboarding_completed_at")
     values ($1, $2, true, false, $3)`,
    [userId, email, completed ? new Date().toISOString() : null],
  );
}

/* A real packet row. resume_object_key is NOT NULL on generated_resumes, so a seed that omits it
   fails on the insert rather than on the assertion it was written for. */
async function seedPacket({ userId = STUDENT, jobId = JOB, spec = { name: 'A Candidate' } as Record<string, unknown> } = {}) {
  const id = randomUUID();
  await database.query(
    `insert into "generated_resumes" ("id", "user_id", "job_context", "spec", "resume_object_key")
     values ($1, $2, $3, $4, $5)`,
    [id, userId, JSON.stringify({ company: 'Verkada', role: 'Backend Intern', job_id: jobId }), JSON.stringify(spec), `resumes/${id}.pdf`],
  );
  return id;
}

async function seedApplication({
  userId = STUDENT,
  jobId = JOB as string | null,
  packetId = null as string | null,
  fingerprint = `job:${JOB}`,
  removed = false,
  updatedAt = null as string | null,
} = {}) {
  const id = randomUUID();
  await database.query(
    `insert into "applications"
       ("id", "user_id", "job_id", "legacy_generated_resume_id", "company_scope_key", "company_name",
        "role", "source_surface", "application_fingerprint", "removed_at"${updatedAt ? ', "updated_at"' : ''})
     values ($1, $2, $3, $4, 'name:verkada', 'Verkada', 'Backend Intern', 'dashboard', $5, $6${updatedAt ? ', $7' : ''})`,
    updatedAt
      ? [id, userId, jobId, packetId, fingerprint, removed ? new Date().toISOString() : null, updatedAt]
      : [id, userId, jobId, packetId, fingerprint, removed ? new Date().toISOString() : null],
  );
  return id;
}

function read(query = '', headers: Record<string, string> = { authorization }) {
  return app.inject({ method: 'GET', url: `/applications/onboarding-packet${query}`, headers });
}

test('refuses an unauthenticated caller', async () => {
  await seedStudent();
  assert.equal((await read('', {})).statusCode, 401);
});

test('refuses a malformed job_id rather than falling back to the no-posting question', async () => {
  await seedStudent();
  const response = await read('?job_id=not-a-uuid');
  assert.equal(response.statusCode, 400);
});

test('an account with nothing built answers null, not 404', async () => {
  /* The build step asks this BEFORE it knows whether anything exists, on every arrival. A 404
     would make the ordinary first build an error path. */
  await seedStudent();
  for (const query of ['', `?job_id=${JOB}`]) {
    const response = await read(query);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { application: null });
  }
});

test('returns the packet the application names, with the two ids kept apart', async () => {
  await seedStudent();
  const packetId = await seedPacket({ spec: { name: 'A Candidate', experience: [{ org: 'Litos' }] } });
  const applicationId = await seedApplication({ packetId });

  const response = await read(`?job_id=${JOB}`);
  assert.equal(response.statusCode, 200);
  const body = response.json() as { application: { application_id: string; job_id: string; packet: { id: string; spec: unknown } } };
  assert.equal(body.application.application_id, applicationId);
  assert.equal(body.application.job_id, JOB);
  assert.equal(body.application.packet.id, packetId);
  /* THE SEND RESOLVES ITS ROW THROUGH generated_resumes, not through the canonical application
     (routes/applications.ts, ownedResume). A caller handed the canonical id under `packet.id`
     would 404 on every send, which is exactly what shipped on 2026-09-01. */
  assert.notEqual(body.application.packet.id, body.application.application_id);
  assert.deepEqual(body.application.packet.spec, { name: 'A Candidate', experience: [{ org: 'Litos' }] });
});

test('finds a row keyed only by the job fingerprint, the shape /resume/generate writes', async () => {
  await seedStudent();
  const packetId = await seedPacket();
  const applicationId = await seedApplication({ packetId, jobId: null, fingerprint: `job:${JOB}` });

  const body = (await read(`?job_id=${JOB}`)).json() as { application: { application_id: string } | null };
  assert.equal(body.application?.application_id, applicationId);
});

test('a removed application is not something to rejoin', async () => {
  /* Removal is a stamp, never a DELETE. Resuming into a row the student already took off their
     tracker would put them back on an application they closed; building a fresh one is right. */
  await seedStudent();
  const packetId = await seedPacket();
  await seedApplication({ packetId, removed: true });

  assert.deepEqual((await read(`?job_id=${JOB}`)).json(), { application: null });
  assert.deepEqual((await read()).json(), { application: null });
});

test('an application with no packet answers with a null packet, so the caller builds', async () => {
  await seedStudent();
  const applicationId = await seedApplication({ packetId: null });
  const body = (await read(`?job_id=${JOB}`)).json() as { application: { application_id: string; packet: unknown } };
  assert.equal(body.application.application_id, applicationId);
  assert.equal(body.application.packet, null);
});

test('a packet belonging to another account is unreachable through the column that names it', async () => {
  await seedStudent();
  await seedStudent({ userId: OTHER_STUDENT, email: 'other@example.com' });
  const foreignPacket = await seedPacket({ userId: OTHER_STUDENT });
  await seedApplication({ packetId: foreignPacket });

  const body = (await read(`?job_id=${JOB}`)).json() as { application: { packet: unknown } };
  assert.equal(body.application.packet, null, "another account's spec must never be served");
});

test('another account\'s application is never returned as this one\'s in-progress work', async () => {
  await seedStudent();
  await seedStudent({ userId: OTHER_STUDENT, email: 'other@example.com' });
  await seedApplication({ userId: OTHER_STUDENT, packetId: await seedPacket({ userId: OTHER_STUDENT }) });

  assert.deepEqual((await read()).json(), { application: null });
  assert.deepEqual((await read(`?job_id=${JOB}`)).json(), { application: null });
});

test('with no posting named it returns the most recently touched application', async () => {
  await seedStudent();
  const oldPacket = await seedPacket({ jobId: OTHER_JOB });
  await seedApplication({ packetId: oldPacket, jobId: OTHER_JOB, fingerprint: `job:${OTHER_JOB}`, updatedAt: '2026-08-01T00:00:00Z' });
  const newPacket = await seedPacket();
  const newest = await seedApplication({ packetId: newPacket, updatedAt: '2026-09-03T00:00:00Z' });

  const body = (await read()).json() as { application: { application_id: string; job_id: string; packet: { id: string } } };
  assert.equal(body.application.application_id, newest);
  assert.equal(body.application.job_id, JOB);
  assert.equal(body.application.packet.id, newPacket);
});

test('a finished account has no in-progress application to rejoin', async () => {
  /* Same restriction the build grant itself carries: this route exists to let a student rejoin
     the sequence they are in, and a finished account is not in one. Its applications are read
     through /applications and the dashboard, which are the routes for that. */
  await seedStudent({ completed: true });
  await seedApplication({ packetId: await seedPacket() });

  assert.deepEqual((await read()).json(), { application: null });
});

test('reading a packet never spends a free build', async () => {
  /* THE WHOLE POINT. The reload used to reach /resume/generate, which claims a grant on a denial;
     two reloads exhausted the allowance of two and left the account unable to finish setup or
     open the dashboard. A read that moved this counter would be the same bug wearing a GET. */
  await seedStudent();
  await seedApplication({ packetId: await seedPacket() });
  const before = await database.query<{ onboarding_builds_used: number }>(
    `select "onboarding_builds_used" from "users" where "id" = '${STUDENT}'`,
  );
  for (let reload = 0; reload < 5; reload++) {
    assert.equal((await read(`?job_id=${JOB}`)).statusCode, 200);
    assert.equal((await read()).statusCode, 200);
  }
  const after = await database.query<{ onboarding_builds_used: number }>(
    `select "onboarding_builds_used" from "users" where "id" = '${STUDENT}'`,
  );
  assert.equal(after.rows[0].onboarding_builds_used, before.rows[0].onboarding_builds_used);
  assert.equal(after.rows[0].onboarding_builds_used, 0);
});
