import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Response as LightMyRequestResponse } from 'light-my-request';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';

const COMPANY = 'Cursor Inventory Fixture';
const CURSOR_SECRET = 'cursor-database-test-secret-with-enough-entropy';
const JOB_IDS = Array.from(
  { length: 8 },
  (_, index) => `30000000-0000-4000-8000-00000000000${index + 1}`,
);

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  JWT_SIGNING_SECRET: process.env.JWT_SIGNING_SECRET,
  JOB_BOARD_CURSOR_SECRET: process.env.JOB_BOARD_CURSOR_SECRET,
};

let socketDir: string;
let pglite: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let db: typeof import('../db/index')['db'];
let pool: typeof import('../db/index')['pool'];
let schema: typeof import('../db/schema');

before(async () => {
  process.env.ENCRYPTION_KEY = 'cursor-database-test-encryption-key';
  process.env.JWT_SIGNING_SECRET = 'cursor-database-test-jwt-secret';
  process.env.JOB_BOARD_CURSOR_SECRET = CURSOR_SECRET;

  socketDir = mkdtempSync(join(tmpdir(), 'litos-job-cursor-'));
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

  const now = Date.now();
  const [source] = await db.insert(schema.career_page_sources).values({
    company_name: COMPANY,
    ats_name: 'greenhouse',
    board_token: 'cursor-inventory-fixture',
    career_url: 'https://job-boards.greenhouse.io/cursor-inventory-fixture',
    company_domain: 'cursor.example',
    company_logo_url: 'https://assets.cursor.example/logo.png',
    logo_verification_status: 'verified',
    logo_verification_method: 'first_party_ats_employer_logo',
    logo_verified_at: new Date(now),
    portal_company_name: COMPANY,
    portal_name_mismatch: false,
    enabled: true,
  }).returning();
  const titles = [
    'Needle Platform Engineer',
    'Needle Platform Engineer',
    'Needle Data Engineer',
    'Needle Product Engineer',
    'Backend Engineer',
    'Security Engineer',
    'Operations Analyst',
    'Product Designer',
  ];
  await db.insert(schema.monitored_jobs).values(titles.map((title, index) => ({
    id: JOB_IDS[index],
    source_id: source.id,
    external_id: `cursor-job-${index + 1}`,
    company_name: COMPANY,
    title,
    location: index % 2 === 0 ? 'New York, NY' : 'London, UK',
    description: `Needle appears in this complete verified description with responsibilities, requirements, qualifications, and enough concrete detail to evaluate posting ${index + 1}.`.repeat(2),
    ingest_eligible: true,
    apply_url: `https://example.com/cursor-job-${index + 1}/apply`,
    posting_url: `https://example.com/cursor-job-${index + 1}`,
    posted_at: index >= 6 ? null : new Date(now - Math.floor(index / 2) * 60 * 60 * 1000),
    first_seen_at: new Date(now - Math.floor(index / 2) * 60 * 1000 - 10 * 60 * 1000),
    last_seen_at: new Date(now),
    is_active: true,
  })));

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

function cursorUrl(route: '/jobs' | '/jobs/grouped', cursor: string, extra = {}) {
  const query = new URLSearchParams({
    cursor,
    company: COMPANY,
    q: 'Needle',
    limit: '2',
    ...extra,
  });
  return `${route}?${query.toString()}`;
}

type CursorPage<T> = {
  jobs: T[];
  total: number;
  postings_total?: number;
  offset: number;
  has_more: boolean;
  next_cursor: string | null;
  pagination_mode: string;
};

test('/jobs cursor walks every verified row once and holds its first-page boundary', async () => {
  const first = await app.inject({ method: 'GET', url: cursorUrl('/jobs', 'start') });
  assert.equal(first.statusCode, 200, first.body);
  const firstBody = first.json() as CursorPage<{ id: string }>;
  assert.equal(firstBody.pagination_mode, 'cursor');
  assert.equal(firstBody.offset, 0);
  assert.equal(firstBody.total, JOB_IDS.length);
  assert.equal(firstBody.jobs.length, 2);
  assert.equal(firstBody.has_more, true);
  assert.equal(typeof firstBody.next_cursor, 'string');
  const firstNext = firstBody.next_cursor;
  assert.ok(firstNext);

  const [source] = await db.select().from(schema.career_page_sources)
    .where(eq(schema.career_page_sources.board_token, 'cursor-inventory-fixture'))
    .limit(1);
  const [late] = await db.insert(schema.monitored_jobs).values({
    id: '30000000-0000-4000-8000-000000000009',
    source_id: source.id,
    external_id: 'cursor-job-late',
    company_name: COMPANY,
    title: 'Needle Late Engineer',
    description: 'Needle appears in a complete role posted after the traversal began, with detailed responsibilities, requirements, and qualifications.'.repeat(2),
    ingest_eligible: true,
    apply_url: 'https://example.com/cursor-job-late/apply',
    posting_url: 'https://example.com/cursor-job-late',
    posted_at: new Date(),
    first_seen_at: new Date(Date.now() + 60_000),
    last_seen_at: new Date(),
    is_active: true,
  }).returning({ id: schema.monitored_jobs.id });

  try {
    const seen = firstBody.jobs.map((job: { id: string }) => job.id);
    let next: string | null = firstNext;
    let pages = 1;
    while (next) {
      const currentCursor: string = next;
      const response = await app.inject({
        method: 'GET',
        url: cursorUrl('/jobs', currentCursor),
      });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json() as CursorPage<{ id: string }>;
      assert.equal(body.pagination_mode, 'cursor');
      assert.equal(body.total, JOB_IDS.length);
      seen.push(...body.jobs.map((job: { id: string }) => job.id));
      next = body.next_cursor;
      assert.equal(body.has_more, Boolean(next));
      pages += 1;
      assert.ok(pages <= JOB_IDS.length, 'cursor traversal must make forward progress');
    }
    assert.deepEqual([...seen].sort(), [...JOB_IDS].sort());
    assert.equal(new Set(seen).size, JOB_IDS.length);
    assert.ok(!seen.includes(late.id), 'a row first seen after page one cannot enter the walk');

    const changedFilter = await app.inject({
      method: 'GET',
      url: cursorUrl('/jobs', firstNext, { q: 'Changed' }),
    });
    assert.equal(changedFilter.statusCode, 400);
    assert.equal(changedFilter.json().code, 'job_board_cursor_mismatch');

    const wrongRoute = await app.inject({
      method: 'GET',
      url: cursorUrl('/jobs/grouped', firstNext),
    });
    assert.equal(wrongRoute.statusCode, 400);
    assert.equal(wrongRoute.json().code, 'job_board_cursor_mismatch');

    const previousGate = process.env.JOB_BOARD_VERIFIED_EVIDENCE_GATE;
    process.env.JOB_BOARD_VERIFIED_EVIDENCE_GATE = 'disabled';
    try {
      const changedGate = await app.inject({
        method: 'GET',
        url: cursorUrl('/jobs', firstNext),
      });
      assert.equal(changedGate.statusCode, 400);
      assert.equal(changedGate.json().code, 'job_board_cursor_mismatch');
    } finally {
      if (previousGate === undefined) delete process.env.JOB_BOARD_VERIFIED_EVIDENCE_GATE;
      else process.env.JOB_BOARD_VERIFIED_EVIDENCE_GATE = previousGate;
    }
  } finally {
    await db.delete(schema.monitored_jobs).where(eq(schema.monitored_jobs.id, late.id));
  }
});

test('cursor pages keep rendering logo proof at the first-page snapshot boundary', async () => {
  const originalDateNow = Date.now;
  const proofWindowMs = 30 * 24 * 60 * 60 * 1000;
  const proofUrl = 'https://assets.cursor.example/logo.png';
  const proofVerifiedAt = new Date(originalDateNow() - proofWindowMs + 60 * 60 * 1000);
  await db.update(schema.career_page_sources).set({
    logo_verified_at: proofVerifiedAt,
  }).where(eq(schema.career_page_sources.board_token, 'cursor-inventory-fixture'));

  try {
    for (const route of ['/jobs', '/jobs/grouped'] as const) {
      Date.now = originalDateNow;
      const first = await app.inject({ method: 'GET', url: cursorUrl(route, 'start') });
      assert.equal(first.statusCode, 200, first.body);
      const firstBody = first.json() as CursorPage<{ company_logo_url: string | null }>;
      assert.ok(firstBody.next_cursor);
      assert.ok(firstBody.jobs.every((job) => job.company_logo_url === proofUrl));

      Date.now = () => originalDateNow() + 2 * 60 * 60 * 1000;
      let next: string | null = firstBody.next_cursor;
      let laterRows = 0;
      while (next) {
        const response: LightMyRequestResponse = await app.inject({
          method: 'GET',
          url: cursorUrl(route, next),
        });
        assert.equal(response.statusCode, 200, response.body);
        const body = response.json() as CursorPage<{ company_logo_url: string | null }>;
        laterRows += body.jobs.length;
        assert.ok(
          body.jobs.every((job) => job.company_logo_url === proofUrl),
          `${route} must render proof that was fresh at the cursor snapshot`,
        );
        next = body.next_cursor;
      }
      assert.ok(laterRows > 0);
    }
  } finally {
    Date.now = originalDateNow;
    await db.update(schema.career_page_sources).set({
      logo_verified_at: new Date(originalDateNow()),
    }).where(eq(schema.career_page_sources.board_token, 'cursor-inventory-fixture'));
  }
});

test('/jobs/grouped cursor walks every role group once and preserves openings', async () => {
  const jobs: Array<{ id: string; title: string; openings: number }> = [];
  let next: string | null = 'start';
  let pages = 0;
  while (next) {
    const currentCursor: string = next;
    const response = await app.inject({
      method: 'GET',
      url: cursorUrl('/jobs/grouped', currentCursor),
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as CursorPage<{ id: string; title: string; openings: number }>;
    assert.equal(body.pagination_mode, 'cursor');
    assert.equal(body.total, 7);
    assert.equal(body.postings_total, JOB_IDS.length);
    jobs.push(...body.jobs);
    next = body.next_cursor;
    assert.equal(body.has_more, Boolean(next));
    pages += 1;
    assert.ok(pages <= JOB_IDS.length, 'group cursor traversal must make forward progress');
  }

  assert.equal(jobs.length, 7);
  assert.equal(new Set(jobs.map((job) => job.id)).size, 7);
  assert.equal(new Set(jobs.map((job) => job.title)).size, 7);
  assert.equal(jobs.find((job) => job.title === 'Needle Platform Engineer')?.openings, 2);
});

test('cursor validation is strict while legacy numeric offsets keep their response contract', async () => {
  const mixed = await app.inject({
    method: 'GET',
    url: cursorUrl('/jobs', 'start', { offset: '1' }),
  });
  assert.equal(mixed.statusCode, 400);

  for (const route of ['/jobs', '/jobs/grouped'] as const) {
    const response = await app.inject({
      method: 'GET',
      url: `${route}?company=${encodeURIComponent(COMPANY)}&limit=2&offset=1`,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.offset, 1);
    assert.equal('next_cursor' in body, false);
    assert.equal('pagination_mode' in body, false);
  }
});
