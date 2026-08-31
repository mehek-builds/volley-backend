import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as schema from '../db/schema';

const socketDir = mkdtempSync(join(tmpdir(), 'litos-action-job-auth-'));
const savedEnv = { ...process.env };
const USER_ONE = 'f610b519-08f9-4c8b-a1c1-92dcda9e01ec';
const USER_TWO = 'aa91cf7a-d02f-4be7-a41e-449b2767258c';
const SOURCE = 'c294dc0d-33f8-49c0-beaa-091284f0be2b';
const JOB = 'f92dc227-946e-4e91-991e-8a2fe1ce72d9';

let database: PGlite;
let server: PGLiteSocketServer;
let backendPool: { end(): Promise<void> };
let currentActionPostingRow: typeof import('./jdMatch')['currentActionPostingRow'];
let actionPostingRowForUser: typeof import('./jdMatch')['actionPostingRowForUser'];

before(async () => {
  database = await PGlite.create();
  const initial = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of initial) await database.exec(statement);
  server = new PGLiteSocketServer({ db: database, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();

  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  process.env.ENCRYPTION_KEY = 'action-job-authorization-test-key';
  process.env.JWT_SIGNING_SECRET = 'action-job-authorization-test-secret';
  process.env.JOB_BOARD_VERIFIED_EVIDENCE_GATE = 'enabled';

  ({ pool: backendPool } = await import('../db'));
  ({ currentActionPostingRow, actionPostingRowForUser } = await import('./jdMatch'));

  await database.query(
    'insert into "users" ("id", "email", "email_verified", "is_guest") values ($1, $2, true, false), ($3, $4, true, false)',
    [USER_ONE, 'one@example.com', USER_TWO, 'two@example.com'],
  );
  await database.query(
    `insert into "career_page_sources"
       ("id", "company_name", "ats_name", "board_token", "career_url", "enabled",
        "portal_company_name", "portal_name_mismatch", "company_logo_url",
        "logo_verification_status", "logo_verification_method", "logo_verified_at")
     values ($1, 'Verified Company', 'greenhouse', 'verified-company',
             'https://job-boards.greenhouse.io/verified-company', true,
             'Verified Company', false, 'https://assets.example/verified-company.png',
             'verified', 'first_party_ats_employer_logo', now())`,
    [SOURCE],
  );
  await database.query(
    `insert into "monitored_jobs"
       ("id", "source_id", "external_id", "company_name", "title", "location",
        "description", "ingest_eligible", "apply_url", "posting_url", "is_active",
        "last_seen_at", "job_country")
     values ($1, $2, 'external-1', 'Verified Company', 'Software Engineer', 'Berlin, Germany',
             $3, true, 'https://job-boards.greenhouse.io/verified-company/jobs/1',
             'https://job-boards.greenhouse.io/verified-company/jobs/1', true, now(), 'non_us')`,
    [JOB, SOURCE, 'A complete role description with responsibilities, qualifications, requirements, and enough detail for an applicant to evaluate the opportunity.'.repeat(2)],
  );
});

after(async () => {
  await backendPool?.end();
  await server?.stop();
  await database?.close();
  rmSync(socketDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

test('a raw job id resolves only while it satisfies the exact verified board predicate', async () => {
  const current = await currentActionPostingRow(JOB);
  assert.equal(current?.company_name, 'Verified Company');
  assert.equal(current?.job_country, 'non_us');

  await database.query('update "monitored_jobs" set "ingest_eligible" = false where "id" = $1', [JOB]);
  assert.equal(await currentActionPostingRow(JOB), null);
  assert.equal(await actionPostingRowForUser(JOB, USER_ONE), null);
});

test('an owned canonical application permits the closed historical row only for its owner', async () => {
  await database.query(
    `insert into "applications"
       ("id", "user_id", "job_id", "company_scope_key", "company_name", "role",
        "source_surface", "application_fingerprint")
     values ($1, $2, $3, 'name:verified company', 'Verified Company', 'Software Engineer',
             'dashboard', $4)`,
    ['9862ed5e-6b1d-46ed-864c-f58ff19b5a9f', USER_ONE, JOB, `legacy:${JOB}`],
  );
  await database.query('update "monitored_jobs" set "is_active" = false where "id" = $1', [JOB]);

  assert.equal((await actionPostingRowForUser(JOB, USER_ONE))?.location, 'Berlin, Germany');
  assert.equal(await actionPostingRowForUser(JOB, USER_TWO), null);
});

test('an owned generated packet is also sufficient historical binding', async () => {
  await database.query('delete from "applications"');
  await database.query(
    `insert into "generated_resumes"
       ("id", "user_id", "job_context", "spec", "resume_object_key")
     values ($1, $2, $3, '{}', 'resumes/owned.pdf')`,
    [
      '63cc30b5-e2a8-4e60-89bd-3d51db73a182',
      USER_TWO,
      JSON.stringify({ company: 'Verified Company', role: 'Software Engineer', job_id: JOB }),
    ],
  );

  assert.equal((await actionPostingRowForUser(JOB, USER_TWO))?.description?.includes('complete role'), true);
  assert.equal(await actionPostingRowForUser(JOB, USER_ONE), null);
});
