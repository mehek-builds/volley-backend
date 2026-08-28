import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { and, eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import * as schema from '../db/schema';
import type { ApplicationReviewState } from '../lib/applicationReview';

const JWT_SECRET = 'paused-extension-route-test-secret';
const savedEnv = { ...process.env };

let socketDir = '';
let database: PGlite;
let server: PGLiteSocketServer;
let backendDb: typeof import('../db').db;
let backendPool: typeof import('../db').pool;
let app: FastifyInstance;

before(async () => {
  socketDir = mkdtempSync(join(tmpdir(), 'litos-paused-extension-'));
  database = await PGlite.create();
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await database.exec(statement);

  server = new PGLiteSocketServer({
    db: database,
    path: join(socketDir, '.s.PGSQL.5432'),
    maxConnections: 10,
  });
  await server.start();
  process.env.VERCEL = '1';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  process.env.JWT_SIGNING_SECRET = JWT_SECRET;
  process.env.ENCRYPTION_KEY = 'paused-extension-route-encryption-key';

  ({ db: backendDb, pool: backendPool } = await import('../db'));
  const { applicationRoutes } = await import('./applications');
  app = Fastify({ logger: false });
  await app.register(applicationRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  await backendPool?.end();
  await server?.stop();
  await database?.close();
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

test('paused extension-start returns a typed 409 without opening an attempt or mutating the claim', async () => {
  const userId = randomUUID();
  const email = `paused-extension-${userId}@example.test`;
  await backendDb.insert(schema.users).values({
    id: userId,
    email,
    plan: 'plus',
    manual_access_override: 'plus_paid',
  });

  const review: ApplicationReviewState = {
    jd_text: 'Build reliable systems.',
    role: 'Software Engineer',
    portal_url: 'https://jobs.ashbyhq.com/example/00000000-0000-4000-8000-000000000001/application',
    portal_supported: true,
    ats_name: 'ashby',
    status: 'ready_for_final_approval',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: '2026-08-25T08:00:00.000Z',
  };
  const packetId = randomUUID();
  const originalSpec = { summary: 'A frozen packet', _review: review };
  await backendDb.insert(schema.generated_resumes).values({
    id: packetId,
    user_id: userId,
    job_context: { company: 'Example', role: 'Software Engineer' },
    spec: originalSpec,
    resume_object_key: `users/${userId}/resumes/${randomUUID()}.pdf`,
  });

  const token = await new SignJWT({
    userId,
    email,
    isGuest: false,
    authMethod: 'password',
    sessionVersion: 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));

  const response = await app.inject({
    method: 'POST',
    url: `/applications/${packetId}/submission/extension-start`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      authorization: 'user_initiated',
      handoff_version: 'a'.repeat(64),
      current_url: review.portal_url,
    },
  });

  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'GENERATED_EXTENSION_SUBMISSION_PAUSED');
  assert.deepEqual(response.json().retry_safety, { kind: 'no_evidence' });

  const [stored] = await backendDb.select().from(schema.generated_resumes)
    .where(and(
      eq(schema.generated_resumes.id, packetId),
      eq(schema.generated_resumes.user_id, userId),
    ))
    .limit(1);
  assert.ok(stored);
  assert.deepEqual(stored.spec, originalSpec, 'the paused route must not write a claim or any review projection');

  const events = await backendDb.select().from(schema.application_submission_attempt_events)
    .where(and(
      eq(schema.application_submission_attempt_events.user_id, userId),
      eq(schema.application_submission_attempt_events.packet_id, packetId),
    ));
  assert.equal(events.length, 0, 'the paused route must insert neither attempt_opened nor boundary_authorized');
});
