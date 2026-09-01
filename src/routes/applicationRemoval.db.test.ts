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

const JWT_SECRET = 'application-removal-test-secret-32-chars';
const socketDir = mkdtempSync(join(tmpdir(), 'litos-application-removal-'));
const savedEnv = { ...process.env };
let database: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let backendPool: { end(): Promise<void> };
let backendDb: any;

const USER_ID = '5f1a0d1e-2b6c-4a7e-9f00-8a1c2d3e4f50';
const OTHER_USER_ID = '9c2f77aa-1111-4222-8333-444455556666';

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
    { id: USER_ID, email: 'removal@example.com', password_hash: 'x' },
    { id: OTHER_USER_ID, email: 'other@example.com', password_hash: 'x' },
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

async function makeApplication(overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  await backendDb.insert(schema.applications).values({
    id,
    user_id: USER_ID,
    company_scope_key: `name:${id.slice(0, 8)}`,
    company_name: 'Test Co',
    role: 'Test Role',
    source_surface: 'dashboard',
    application_fingerprint: `fingerprint:${id}`,
    ...overrides,
  });
  return id;
}

async function remove(id: string) {
  return app.inject({
    method: 'POST',
    url: `/applications/${id}/remove`,
    headers: { authorization: `Bearer ${await token(USER_ID)}` },
  });
}

async function listCompanies() {
  const res = await app.inject({
    method: 'GET', url: '/applications',
    headers: { authorization: `Bearer ${await token(USER_ID)}` },
  });
  return res.json().applications.map((a: { id: string }) => a.id);
}

test('an unsent application is removed and disappears from the tracker', async () => {
  const id = await makeApplication();
  assert.ok((await listCompanies()).includes(id), 'precondition: it is on the tracker');

  const res = await remove(id);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().removed, true);
  assert.equal(res.json().already_removed, false);

  assert.equal((await listCompanies()).includes(id), false, 'it must leave the tracker');
  const [row] = await backendDb.select().from(schema.applications).where(eq(schema.applications.id, id));
  assert.ok(row, 'the row must still exist: removal is a stamp, not a delete');
  assert.ok(row.removed_at instanceof Date);
});

test('removing twice is not an error', async () => {
  const id = await makeApplication();
  assert.equal((await remove(id)).statusCode, 200);
  const second = await remove(id);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().already_removed, true);
});

test('an application that has been sent cannot be removed', async () => {
  for (const overrides of [
    { submission_state: 'submitted' },
    { submission_state: 'submitting' },
    { submission_state: 'submission_claimed' },
    { tracker_state: 'applied' },
    { tracker_state: 'interview' },
    { tracker_state: 'offer' },
    { tracker_state: 'closed' },
  ]) {
    const id = await makeApplication(overrides);
    const res = await remove(id);
    assert.equal(res.statusCode, 409, `must refuse ${JSON.stringify(overrides)}`);
    assert.equal(res.json().code, 'application_not_removable');
    assert.ok(res.json().blockers.length > 0);
    assert.ok((await listCompanies()).includes(id), 'a refused row stays on the tracker');
  }
});

test('a submission attempt on the ledger blocks removal even when the projection says not_started', async () => {
  /* THE CASE THE STATE COLUMN ALONE WOULD MISS. submission_state is a projection and can lag or be
     rebuilt; the attempt ledger is the durable evidence that Litos tried to send. If removal
     trusted the column, a student could hide a row whose ledger entry is the only thing stopping a
     second send to the same employer. */
  const id = await makeApplication({ submission_state: 'not_started', tracker_state: 'saved' });
  await backendDb.insert(schema.application_submission_attempt_bindings).values({
    user_id: USER_ID,
    attempt_id: randomUUID(),
    application_id: id,
    packet_id: randomUUID(),
    source: 'managed_browser',
    operation: 'initial_submission',
    company_name: 'Test Co',
    role: 'Test Role',
  });
  const res = await remove(id);
  assert.equal(res.statusCode, 409);
  assert.match(res.json().blockers.join(' '), /submission attempt is on record/);
  assert.ok((await listCompanies()).includes(id));
});

test('another user cannot remove an application they do not own', async () => {
  const id = await makeApplication();
  const res = await app.inject({
    method: 'POST',
    url: `/applications/${id}/remove`,
    headers: { authorization: `Bearer ${await token(OTHER_USER_ID)}` },
  });
  assert.equal(res.statusCode, 404);
  const [row] = await backendDb.select().from(schema.applications).where(eq(schema.applications.id, id));
  assert.equal(row.removed_at, null);
});

test('adding the same posting again brings a removed application back', async () => {
  const { upsertCanonicalApplicationForUser } = await import('./canonicalApplications');
  const created = await upsertCanonicalApplicationForUser({
    userId: USER_ID,
    companyScopeKey: 'name:revive-co',
    companyName: 'Revive Co',
    role: 'Revived Role',
    portalUrl: 'https://boards.greenhouse.io/reviveco/jobs/1234567',
    sourceSurface: 'dashboard',
  });
  assert.equal((await remove(created.application.id)).statusCode, 200);
  assert.equal((await listCompanies()).includes(created.application.id), false);

  const again = await upsertCanonicalApplicationForUser({
    userId: USER_ID,
    companyScopeKey: 'name:revive-co',
    companyName: 'Revive Co',
    role: 'Revived Role',
    portalUrl: 'https://boards.greenhouse.io/reviveco/jobs/1234567',
    sourceSurface: 'dashboard',
  });
  assert.equal(again.application.id, created.application.id, 'the same row is reused');
  assert.equal(again.application.removed_at, null, 'and it must come back rather than stay hidden');
  assert.ok((await listCompanies()).includes(created.application.id));
});
