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

/* CAN A SIGNED-IN ACCOUNT TURN A MONITORED POSTING INTO ITS APPLICATION, and does the route keep
 * the promises its contract states: one application per posting, the board's own validity rules,
 * and the real packet pipeline behind it.
 *
 * WHY THIS EXISTS AS A DATABASE TEST. The route is three queries and one in-process call to
 * POST /resume/generate, and every failure mode worth catching is a query outcome: a posting the
 * board predicate refuses, an application row that already names the posting, a profile with no
 * name to print. None of that is visible from a unit test of the handler's shape.
 *
 * THE PIPELINE IS STUBBED, DELIBERATELY. The real /resume/generate spends a model call and a PDF
 * render, and its own behaviour has its own suite. What this file proves about the pipeline is
 * the CONTRACT between the two routes: the stub asserts what the injected request carries (the
 * caller's own bearer token, explicit_click initiation, the posting's identity, the parse's
 * name), does what the real pipeline observably does on success (writes the canonical application
 * row keyed to the posting), and answers with the same response key the route reads.
 */

const JWT_SECRET = 'application-from-job-db-test-secret-32';
const socketDir = mkdtempSync(join(tmpdir(), 'litos-app-from-job-'));
const savedEnv = { ...process.env };
const STUDENT = '7a3f42d0-9d1c-4c66-8a3e-5f2b91c4d801';
const SOURCE = 'a2b96c04-1e73-4a2f-bb6a-7f0d34c96521';
const JOB = '28c9a160-ca0a-4cd3-9883-e93b98c9e3ed';

let database: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let backendPool: { end(): Promise<void> };
let authorization: string;

/* What the stubbed pipeline saw and how it should answer. Reset per test. */
let generateCalls: Array<{ authorization: string | undefined; body: Record<string, unknown> }>;
let generateResponse:
  | { statusCode: number; body: Record<string, unknown> }
  | { createApplication: true; omitIdFromResponse?: boolean };

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
  process.env.ENCRYPTION_KEY = 'application-from-job-db-test-encryption-key';

  ({ pool: backendPool } = await import('../db'));
  const { applicationFromJobRoutes } = await import('./applicationFromJob');
  app = Fastify({ logger: false });
  await app.register(applicationFromJobRoutes);
  /* The pipeline's stand-in, registered on the same instance the route injects into. On the
   * createApplication behaviour it does what the real route's persistence transaction observably
   * does for a body with job_id and no application_id: writes the canonical application row with
   * a legacy fingerprint and the posting's id in the job_id column (routes/resume.ts). */
  app.post('/resume/generate', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    generateCalls.push({
      authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
      body,
    });
    if ('statusCode' in generateResponse) {
      return reply.status(generateResponse.statusCode).send(generateResponse.body);
    }
    const applicationId = randomUUID();
    await database.query(
      `insert into "applications"
         ("id", "user_id", "job_id", "company_scope_key", "company_name", "role",
          "source_surface", "tracker_state", "review_state", "application_fingerprint")
       values ($1, $2, $3, $4, $5, $6, 'dashboard', 'applying', 'ready', $7)`,
      [applicationId, STUDENT, body.job_id, 'name:verkada', body.company, body.role, `legacy:${randomUUID()}`],
    );
    return reply.status(200).send({
      resume_url: 'https://example.com/resume.pdf',
      ...(generateResponse.omitIdFromResponse ? {} : { canonical_application_id: applicationId }),
    });
  });
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

const DESCRIPTION = 'Build backend services for cloud-managed physical security systems at scale, own production systems, collaborate across teams, and meet the stated engineering requirements and qualifications.'.repeat(2);

async function seedAttachableWorld(overrides: {
  jobActive?: boolean;
  sourceEnabled?: boolean;
  atsName?: string;
  parsedJson?: Record<string, unknown> | null;
  withProfile?: boolean;
} = {}) {
  await database.query('insert into "users" ("id", "email", "email_verified", "is_guest") values ($1, $2, true, false)', [
    STUDENT,
    'student@example.com',
  ]);
  if (overrides.withProfile !== false) {
    await database.query('insert into "profiles" ("user_id", "parsed_json") values ($1, $2)', [
      STUDENT,
      JSON.stringify(overrides.parsedJson ?? { full_name: 'A Candidate', resume_email: 'candidate@example.com' }),
    ]);
  }
  await database.query(
    `insert into "career_page_sources"
       ("id", "company_name", "ats_name", "board_token", "career_url", "enabled",
        "portal_company_name", "portal_name_mismatch", "company_logo_url",
        "logo_verification_status", "logo_verification_method", "logo_verified_at")
     values ($1, 'Verkada', $2, 'verkada', 'https://job-boards.greenhouse.io/verkada', $3,
             'Verkada', false, 'https://assets.example/verkada-logo.png',
             'verified', 'test_fixture', now())`,
    [SOURCE, overrides.atsName ?? 'greenhouse', overrides.sourceEnabled !== false],
  );
  await database.query(
    `insert into "monitored_jobs"
       ("id", "source_id", "external_id", "company_name", "title", "description", "ingest_eligible", "apply_url", "posting_url", "is_active")
     values ($1, $2, 'gh-1', 'Verkada', 'Backend Software Engineering Intern 2027', $3,
             true, 'https://job-boards.greenhouse.io/verkada/jobs/1', 'https://job-boards.greenhouse.io/verkada/jobs/1', $4)`,
    [JOB, SOURCE, DESCRIPTION, overrides.jobActive !== false],
  );
}

async function seedExistingApplication(fingerprint: string) {
  const id = randomUUID();
  await database.query(
    `insert into "applications"
       ("id", "user_id", "job_id", "company_scope_key", "company_name", "role",
        "source_surface", "application_fingerprint")
     values ($1, $2, $3, 'name:verkada', 'Verkada', 'Backend Software Engineering Intern 2027', 'dashboard', $4)`,
    [id, STUDENT, JOB, fingerprint],
  );
  return id;
}

function attach(body: unknown, headers: Record<string, string> = { authorization }) {
  return app.inject({
    method: 'POST',
    url: '/applications/from-job',
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
}

beforeEach(async () => {
  generateCalls = [];
  generateResponse = { createApplication: true };
  await database.exec('truncate "applications", "monitored_jobs", "career_page_sources", "profiles", "users" cascade');
});

test('refuses an unauthenticated caller before touching anything', async () => {
  await seedAttachableWorld();
  const response = await attach({ job_id: JOB }, {});
  assert.equal(response.statusCode, 401);
  assert.equal(generateCalls.length, 0);
});

test('refuses a body without a valid job_id', async () => {
  await seedAttachableWorld();
  const response = await attach({ job_id: 'not-a-uuid' });
  assert.equal(response.statusCode, 400);
  assert.equal(generateCalls.length, 0);
});

test('404s a job the board has never heard of', async () => {
  await seedAttachableWorld();
  const response = await attach({ job_id: randomUUID() });
  assert.equal(response.statusCode, 404);
  assert.equal(generateCalls.length, 0);
});

test('404s an inactive posting instead of building against it', async () => {
  await seedAttachableWorld({ jobActive: false });
  const response = await attach({ job_id: JOB });
  assert.equal(response.statusCode, 404);
  assert.equal(generateCalls.length, 0);
});

test('404s a posting whose source is disabled or off the autonomous families', async () => {
  await seedAttachableWorld({ sourceEnabled: false });
  assert.equal((await attach({ job_id: JOB })).statusCode, 404);

  await database.exec('truncate "monitored_jobs", "career_page_sources" cascade');
  await database.query(
    `insert into "career_page_sources" ("id", "company_name", "ats_name", "board_token", "career_url", "enabled")
     values ($1, 'Verkada', 'workday', 'verkada', 'https://example.com', true)`,
    [SOURCE],
  );
  await database.query(
    `insert into "monitored_jobs"
       ("id", "source_id", "external_id", "company_name", "title", "description", "apply_url", "posting_url", "is_active")
     values ($1, $2, 'gh-1', 'Verkada', 'Backend Software Engineering Intern 2027', $3,
             'https://example.com/jobs/1', 'https://example.com/jobs/1', true)`,
    [JOB, SOURCE, DESCRIPTION],
  );
  assert.equal((await attach({ job_id: JOB })).statusCode, 404);
  assert.equal(generateCalls.length, 0);
});

test('creates the application through the real pipeline and answers with its id', async () => {
  await seedAttachableWorld();
  const response = await attach({ job_id: JOB });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.created, true);
  assert.equal(body.deduped, false);

  /* The contract with the pipeline: the caller's own session, an explicit click, the posting's
   * identity and full description, and the parse's name. This is exactly the request shape the
   * onboarding build step sends, which is the point of the route. */
  assert.equal(generateCalls.length, 1);
  const call = generateCalls[0];
  assert.equal(call.authorization, authorization);
  assert.equal(call.body.initiation, 'explicit_click');
  assert.equal(call.body.job_id, JOB);
  assert.equal(call.body.company, 'Verkada');
  assert.equal(call.body.role, 'Backend Software Engineering Intern 2027');
  assert.equal(call.body.jd_text, DESCRIPTION);
  assert.deepEqual(call.body.contact, { full_name: 'A Candidate' });

  const rows = await database.query<{ id: string; job_id: string }>(
    'select "id", "job_id" from "applications" where "user_id" = $1',
    [STUDENT],
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].id, body.application_id);
  assert.equal(rows.rows[0].job_id, JOB);
});

test('returns the existing application for the posting instead of creating a second one', async () => {
  await seedAttachableWorld();
  /* One of each fingerprint shape a posting-keyed application can carry: the legacy one
   * /resume/generate writes, and the job one upsertCanonicalApplicationForUser computes. */
  for (const fingerprint of [`legacy:${randomUUID()}`, `job:${JOB}`]) {
    await database.exec('truncate "applications" cascade');
    const existing = await seedExistingApplication(fingerprint);
    const response = await attach({ job_id: JOB });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.application_id, existing);
    assert.equal(body.created, false);
    assert.equal(body.deduped, true);
  }
  assert.equal(generateCalls.length, 0);
  const count = await database.query<{ n: string }>('select count(*) as n from "applications"');
  assert.equal(Number(count.rows[0].n), 1);
});

test('still returns the existing application after the posting itself has closed', async () => {
  await seedAttachableWorld({ jobActive: false });
  const existing = await seedExistingApplication(`legacy:${randomUUID()}`);
  const response = await attach({ job_id: JOB });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().application_id, existing);
  assert.equal(generateCalls.length, 0);
});

test('forwards a pipeline refusal untouched, with nothing created', async () => {
  await seedAttachableWorld();
  generateResponse = {
    statusCode: 402,
    body: { error: 'Upgrade to keep generating tailored resumes.', code: 'upgrade_required' },
  };
  const response = await attach({ job_id: JOB });
  assert.equal(response.statusCode, 402);
  assert.deepEqual(response.json(), {
    error: 'Upgrade to keep generating tailored resumes.',
    code: 'upgrade_required',
  });
  const count = await database.query<{ n: string }>('select count(*) as n from "applications"');
  assert.equal(Number(count.rows[0].n), 0);
});

test('recovers the created row by its posting when the pipeline response omits the id', async () => {
  await seedAttachableWorld();
  generateResponse = { createApplication: true, omitIdFromResponse: true };
  const response = await attach({ job_id: JOB });
  assert.equal(response.statusCode, 201);
  const rows = await database.query<{ id: string }>('select "id" from "applications" where "user_id" = $1', [STUDENT]);
  assert.equal(response.json().application_id, rows.rows[0].id);
});

test('names the missing profile precondition instead of spending a generation on it', async () => {
  await seedAttachableWorld({ withProfile: false });
  const noProfile = await attach({ job_id: JOB });
  assert.equal(noProfile.statusCode, 409);
  assert.equal(noProfile.json().code, 'profile_required');

  await database.exec('truncate "applications", "monitored_jobs", "career_page_sources", "profiles", "users" cascade');
  await seedAttachableWorld({ parsedJson: { resume_email: 'candidate@example.com' } });
  const noName = await attach({ job_id: JOB });
  assert.equal(noName.statusCode, 422);
  assert.equal(noName.json().code, 'full_name_required');
  assert.equal(generateCalls.length, 0);
});
