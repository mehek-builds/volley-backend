import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';

const SOURCE_ID = '10000000-0000-4000-8000-000000000001';
const GENERATION_ONE = '20000000-0000-4000-8000-000000000001';
const GENERATION_TWO = '20000000-0000-4000-8000-000000000002';
const JOB_IDS = [
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003',
];
const COMPANY = 'Projection Route Fixture';

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  JWT_SIGNING_SECRET: process.env.JWT_SIGNING_SECRET,
  JOB_BOARD_CURSOR_SECRET: process.env.JOB_BOARD_CURSOR_SECRET,
  JOB_BOARD_VERIFIED_EVIDENCE_GATE: process.env.JOB_BOARD_VERIFIED_EVIDENCE_GATE,
};

let socketDir: string;
let pglite: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let db: typeof import('../db/index')['db'];
let pool: typeof import('../db/index')['pool'];
let schema: typeof import('../db/schema');
let projectionAsOf: Date;

before(async () => {
  process.env.ENCRYPTION_KEY = 'group-projection-test-encryption-key';
  process.env.JWT_SIGNING_SECRET = 'group-projection-test-jwt-secret';
  process.env.JOB_BOARD_CURSOR_SECRET = 'group-projection-test-cursor-secret-with-entropy';
  process.env.JOB_BOARD_VERIFIED_EVIDENCE_GATE = 'enabled';

  socketDir = mkdtempSync(join(tmpdir(), 'litos-group-projection-'));
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({
    db: pglite,
    path: join(socketDir, '.s.PGSQL.5432'),
    maxConnections: 10,
  });
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

  projectionAsOf = new Date();
  await db.insert(schema.career_page_sources).values({
    id: SOURCE_ID,
    company_name: COMPANY,
    ats_name: 'greenhouse',
    board_token: 'projection-route-fixture',
    career_url: 'https://careers.projection.example',
    company_domain: 'projection.example',
    company_logo_url: 'https://assets.projection.example/logo.png',
    logo_verification_status: 'verified',
    logo_verification_method: 'first_party_ats_employer_logo',
    logo_verified_at: projectionAsOf,
    portal_company_name: COMPANY,
    portal_name_mismatch: false,
    enabled: true,
  });
  await db.insert(schema.monitored_jobs).values([
    {
      id: JOB_IDS[0],
      source_id: SOURCE_ID,
      external_id: 'projection-one',
      company_name: COMPANY,
      title: 'Platform Engineer',
      location: 'New York, NY',
      description: 'A complete verified platform role with concrete responsibilities, requirements, qualifications, and delivery outcomes.'.repeat(2),
      ingest_eligible: true,
      apply_url: 'https://apply.example/projection-one',
      posting_url: 'https://jobs.example/projection-one',
      posted_at: new Date(projectionAsOf.getTime() - 1_000),
      first_seen_at: new Date(projectionAsOf.getTime() - 10_000),
      last_seen_at: projectionAsOf,
      sponsorship_status: 'offers',
      sponsorship_scope: 'job_country',
      job_country: 'us',
      is_active: true,
    },
    {
      id: JOB_IDS[1],
      source_id: SOURCE_ID,
      external_id: 'projection-two',
      company_name: COMPANY,
      title: 'Platform Engineer',
      location: 'London, UK',
      description: 'A complete verified platform role with concrete responsibilities, requirements, qualifications, and delivery outcomes.'.repeat(2),
      ingest_eligible: true,
      apply_url: 'https://apply.example/projection-two',
      posting_url: 'https://jobs.example/projection-two',
      posted_at: new Date(projectionAsOf.getTime() - 2_000),
      first_seen_at: new Date(projectionAsOf.getTime() - 20_000),
      last_seen_at: projectionAsOf,
      sponsorship_status: 'unstated',
      sponsorship_scope: null,
      job_country: 'non_us',
      is_active: true,
    },
    {
      id: JOB_IDS[2],
      source_id: SOURCE_ID,
      external_id: 'projection-three',
      company_name: COMPANY,
      title: 'Data Analyst',
      location: 'Toronto, Canada',
      description: 'A complete verified data role with concrete responsibilities, requirements, qualifications, and delivery outcomes.'.repeat(2),
      ingest_eligible: true,
      apply_url: 'https://apply.example/projection-three',
      posting_url: 'https://jobs.example/projection-three',
      posted_at: new Date(projectionAsOf.getTime() - 3_000),
      first_seen_at: new Date(projectionAsOf.getTime() - 30_000),
      last_seen_at: projectionAsOf,
      sponsorship_status: 'unstated',
      sponsorship_scope: null,
      job_country: 'non_us',
      is_active: true,
    },
  ]);
  await db.insert(schema.job_board_group_projection).values([
    {
      generation: GENERATION_ONE,
      id: JOB_IDS[0],
      cursor_tie_id: JOB_IDS[0],
      company_name: COMPANY,
      title: 'Platform Engineer',
      locations: ['London, UK', 'New York, NY'],
      openings: 2,
      apply_url: 'https://apply.example/projection-one',
      remote: false,
      posted_at: new Date(projectionAsOf.getTime() - 1_000),
      first_seen_at: new Date(projectionAsOf.getTime() - 20_000),
      ats_name: 'greenhouse',
      career_url: 'https://careers.projection.example',
      company_domain: 'projection.example',
      company_logo_url: 'https://assets.projection.example/logo.png',
      logo_verification_status: 'verified',
      logo_verification_method: 'first_party_ats_employer_logo',
      logo_verified_at: projectionAsOf,
      posting_offers: [{
        sponsorship_scope: 'job_country',
        job_country: 'us',
        location: 'New York, NY',
        raw_json: null,
      }],
      employer_sponsors: false,
    },
    {
      generation: GENERATION_ONE,
      id: JOB_IDS[2],
      cursor_tie_id: JOB_IDS[2],
      company_name: COMPANY,
      title: 'Data Analyst',
      locations: ['Toronto, Canada'],
      openings: 1,
      apply_url: 'https://apply.example/projection-three',
      remote: false,
      posted_at: new Date(projectionAsOf.getTime() - 3_000),
      first_seen_at: new Date(projectionAsOf.getTime() - 30_000),
      ats_name: 'greenhouse',
      career_url: 'https://careers.projection.example',
      company_domain: 'projection.example',
      company_logo_url: 'https://assets.projection.example/logo.png',
      logo_verification_status: 'verified',
      logo_verification_method: 'first_party_ats_employer_logo',
      logo_verified_at: projectionAsOf,
      posting_offers: [],
      employer_sponsors: false,
    },
  ]);
  await db.insert(schema.job_board_group_projection_state).values({
    singleton: true,
    generation: GENERATION_ONE,
    projection_as_of: projectionAsOf,
    certification_started_at: projectionAsOf,
    surfaced_postings: 3,
    surfaced_grouped_roles: 2,
    surfaced_sponsor_only_jobs: 1,
    surfaced_internships: 0,
    certified_unique_jobs: 3,
    certified_unique_grouped_roles: 2,
    certified_unique_sponsor_jobs: 1,
    certified_unique_internships: 0,
  });

  const { jobMonitorRoutes } = await import('./jobMonitor');
  app = Fastify({ logger: false });
  await app.register(jobMonitorRoutes);
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

type GroupRow = { title: string; openings: number; company_logo_url: string | null };

function normalizedGroups(body: { jobs: GroupRow[] }) {
  return body.jobs
    .map(({ title, openings, company_logo_url }) => ({ title, openings, company_logo_url }))
    .sort((left, right) => left.title.localeCompare(right.title));
}

test('unfiltered projection and filtered grouped fallback return the same groups', async () => {
  const projected = await app.inject({
    method: 'GET',
    url: '/jobs/grouped?cursor=start&limit=10',
  });
  assert.equal(projected.statusCode, 200, projected.body);
  const projectedBody = projected.json();
  assert.equal(projectedBody.total, 2);
  assert.equal(projectedBody.postings_total, 3);

  const fallback = await app.inject({
    method: 'GET',
    url: `/jobs/grouped?cursor=start&limit=10&company=${encodeURIComponent(COMPANY)}`,
  });
  assert.equal(fallback.statusCode, 200, fallback.body);
  const fallbackBody = fallback.json();
  assert.deepEqual(normalizedGroups(projectedBody), normalizedGroups(fallbackBody));
  assert.ok(projectedBody.jobs.every((row: GroupRow) => row.company_logo_url));
});

test('a projection generation change rejects the signed continuation cursor', async () => {
  const first = await app.inject({
    method: 'GET',
    url: '/jobs/grouped?cursor=start&limit=1',
  });
  assert.equal(first.statusCode, 200, first.body);
  const nextCursor = first.json().next_cursor;
  assert.equal(typeof nextCursor, 'string');

  await db.update(schema.job_board_group_projection_state).set({
    previous_generation: GENERATION_ONE,
    generation: GENERATION_TWO,
    projection_as_of: new Date(projectionAsOf.getTime() + 1_000),
  }).where(eq(schema.job_board_group_projection_state.singleton, true));

  const later = await app.inject({
    method: 'GET',
    url: `/jobs/grouped?cursor=${encodeURIComponent(nextCursor)}`,
  });
  assert.equal(later.statusCode, 400, later.body);
  assert.equal(later.json().code, 'job_board_cursor_mismatch');
  assert.match(later.json().error, /projection refreshed/i);
});
