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

/* WHY THIS ROUTE IS TESTED AGAINST A REAL DATABASE.
 *
 * `company_counts` exists to replace a measurement that used to page the ENTIRE board through
 * GET /jobs, pulling full rows including 600 characters of description each, to learn two columns'
 * worth of facts. That was ~17 MB per pass, and on 2026-08-04 this project exhausted its Neon data
 * transfer quota and every database-backed route began answering 500, which took the public board
 * down. The replacement has to be right about two things that only a database can demonstrate:
 *
 * 1. It counts the SAME board GET /jobs serves. Counts drawn from a different predicate would make
 *    check-logo-coverage.mjs measure coverage over rows a job seeker never sees, and the number
 *    would drift from reality without ever failing.
 * 2. It counts EVERY company, not the top fifty the dropdown wants. A truncated count silently
 *    understates the denominator, which inflates coverage and hides exactly the drift the check is
 *    there to catch.
 *
 * The fixture is PGlite speaking the real wire protocol over a unix socket, so the production `db`
 * module connects with the production driver, and the DDL is generated from db/schema.ts at run
 * time so it cannot drift from the real schema.
 */

const ENCRYPTION_KEY = 'job-facets-counts-test-key';
const JWT_SIGNING_SECRET = 'job-facets-counts-test-secret';

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  JWT_SIGNING_SECRET: process.env.JWT_SIGNING_SECRET,
};

let socketDir: string;
let pglite: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let db: typeof import('../db/index')['db'];
let pool: typeof import('../db/index')['pool'];
let schema: typeof import('../db/schema');
let upsertSources: typeof import('./jobMonitor')['upsertSources'];
let unverifiedJobId: string;

/** Postings per employer, chosen so a row-weighted count differs sharply from a company count. */
const SEED: Record<string, number> = { Zscaler: 5, Lucid: 3, Huckberry: 1 };

before(async () => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.JWT_SIGNING_SECRET = JWT_SIGNING_SECRET;

  socketDir = mkdtempSync(join(tmpdir(), 'litos-facets-'));
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

  const { career_page_sources, monitored_jobs } = schema;
  const [source] = await db.insert(career_page_sources).values({
    company_name: 'Fixture Source',
    ats_name: 'greenhouse',
    board_token: 'fixture',
    career_url: 'https://job-boards.greenhouse.io/fixture',
    company_domain: 'fixture.example',
    company_logo_url: 'https://assets.example/fixture-logo.png',
    logo_verification_status: 'verified',
    logo_verification_method: 'first_party_ats_employer_logo',
    logo_verified_at: new Date(),
    portal_company_name: 'Fixture Source',
    portal_name_mismatch: false,
    enabled: true,
  }).returning();

  for (const [company, count] of Object.entries(SEED)) {
    for (let i = 0; i < count; i++) {
      await db.insert(monitored_jobs).values({
        source_id: source.id,
        external_id: `${company}-${i}`,
        company_name: company,
        title: `Engineer ${i}`,
        description: 'A complete verified role description with enough detail for an applicant to evaluate the work, requirements, responsibilities, and expected qualifications.'.repeat(2),
        ingest_eligible: true,
        apply_url: `https://example.com/${company}/${i}`,
        posting_url: `https://example.com/${company}/${i}`,
        // Recently verified, so boardConditions surfaces it exactly as GET /jobs would.
        posted_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
        last_seen_at: new Date(),
        is_active: true,
      });
    }
  }

  const [unverifiedSource] = await db.insert(career_page_sources).values({
    company_name: 'No Logo Co',
    ats_name: 'greenhouse',
    board_token: 'no-logo',
    career_url: 'https://job-boards.greenhouse.io/no-logo',
    enabled: true,
  }).returning();
  const [unverifiedJob] = await db.insert(monitored_jobs).values({
    source_id: unverifiedSource.id,
    external_id: 'no-logo-job',
    company_name: 'No Logo Co',
    title: 'Engineer',
    description: 'A complete role description whose source still has no verified logo evidence, with responsibilities, requirements, qualifications, and enough detail for an applicant.'.repeat(2),
    ingest_eligible: true,
    apply_url: 'https://example.com/no-logo/apply',
    posting_url: 'https://example.com/no-logo',
    last_seen_at: new Date(),
    is_active: true,
  }).returning({ id: monitored_jobs.id });
  unverifiedJobId = unverifiedJob.id;

  const monitor = await import('./jobMonitor');
  const { jobMonitorRoutes } = monitor;
  upsertSources = monitor.upsertSources;
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

test('the default response is unchanged, so the website pays nothing for the new field', async () => {
  const res = await app.inject({ method: 'GET', url: '/jobs/facets' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Array.isArray(body.companies), 'the dropdown still gets its companies');
  assert.equal('company_counts' in body, false, 'company_counts must be opt-in');
});

test('counts=true returns every company with its true row count', async () => {
  const res = await app.inject({ method: 'GET', url: '/jobs/facets?counts=true' });
  assert.equal(res.statusCode, 200);
  const counts: { company_name: string; rows: number }[] = res.json().company_counts;

  assert.ok(Array.isArray(counts), 'company_counts must be present when asked for');
  // EVERY company, not a top-N slice: a truncated denominator inflates coverage.
  assert.equal(counts.length, Object.keys(SEED).length);

  const byName = Object.fromEntries(counts.map((c) => [c.company_name, c.rows]));
  assert.deepEqual(byName, SEED);

  // The denominator the coverage check divides by has to be the whole board.
  const total = counts.reduce((sum, c) => sum + c.rows, 0);
  assert.equal(total, Object.values(SEED).reduce((a, b) => a + b, 0));
});

test('counts describe the same board GET /jobs serves', async () => {
  // If these two ever disagree, coverage is being measured over rows nobody can see.
  const [facets, jobs] = await Promise.all([
    app.inject({ method: 'GET', url: '/jobs/facets?counts=true' }),
    app.inject({ method: 'GET', url: '/jobs?limit=100' }),
  ]);
  const counted = facets.json().company_counts.reduce((s: number, c: { rows: number }) => s + c.rows, 0);
  assert.equal(counted, jobs.json().total, 'grouped count must equal the board total');
});

test('every surfaced shape carries persisted, renderable logo evidence', async () => {
  const [list, grouped] = await Promise.all([
    app.inject({ method: 'GET', url: '/jobs?limit=100' }),
    app.inject({ method: 'GET', url: '/jobs/grouped?limit=100' }),
  ]);
  assert.equal(list.statusCode, 200);
  assert.equal(grouped.statusCode, 200);

  for (const job of [...list.json().jobs, ...grouped.json().jobs]) {
    assert.equal(job.company_domain, 'fixture.example');
    assert.equal(job.company_logo_verification_status, 'verified');
    assert.equal(job.company_logo_verification_method, 'first_party_ats_employer_logo');
    assert.ok(job.company_logo_verified_at);
    assert.equal(job.company_logo_url, 'https://assets.example/fixture-logo.png');
  }

  const id = list.json().jobs[0].id;
  const detail = await app.inject({ method: 'GET', url: `/jobs/${id}` });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().job.company_logo_verification_status, 'verified');
  assert.equal(detail.json().job.company_logo_url, 'https://assets.example/fixture-logo.png');
});

test('an otherwise live job without persisted verified logo evidence exists on no public surface', async () => {
  const [list, grouped, facets, detail] = await Promise.all([
    app.inject({ method: 'GET', url: '/jobs?limit=100' }),
    app.inject({ method: 'GET', url: '/jobs/grouped?limit=100' }),
    app.inject({ method: 'GET', url: '/jobs/facets?counts=true' }),
    app.inject({ method: 'GET', url: `/jobs/${unverifiedJobId}` }),
  ]);
  assert.ok(!list.json().jobs.some((job: { company_name: string }) => job.company_name === 'No Logo Co'));
  assert.ok(!grouped.json().jobs.some((job: { company_name: string }) => job.company_name === 'No Logo Co'));
  assert.ok(!facets.json().company_counts.some((row: { company_name: string }) => row.company_name === 'No Logo Co'));
  assert.equal(detail.statusCode, 404, 'a bookmark must not bypass the logo-evidence gate');
});

test('grouped roles aggregate sponsorship countries from affirmative copies only', async () => {
  const { career_page_sources, monitored_jobs } = schema;
  const company = 'Sponsorship Jurisdiction Fixture';
  const [source] = await db.select().from(career_page_sources)
    .where(eq(career_page_sources.board_token, 'fixture'))
    .limit(1);
  const description = 'A complete role description with responsibilities, requirements, qualifications, and enough detail for an applicant to evaluate this verified opening.'.repeat(2);

  await db.insert(monitored_jobs).values([
    {
      source_id: source.id,
      external_id: 'mixed-country-us-offer',
      company_name: company,
      title: 'Mixed Country Engineer',
      location: 'New York, NY',
      description,
      ingest_eligible: true,
      apply_url: 'https://example.com/mixed-country-us-offer/apply',
      posting_url: 'https://example.com/mixed-country-us-offer',
      sponsorship_status: 'offers',
      sponsorship_scope: 'job_country',
      job_country: 'us',
      last_seen_at: new Date(),
      is_active: true,
    },
    {
      source_id: source.id,
      external_id: 'mixed-country-berlin-unstated',
      company_name: company,
      title: 'Mixed Country Engineer',
      location: 'Berlin',
      description,
      ingest_eligible: true,
      apply_url: 'https://example.com/mixed-country-berlin-unstated/apply',
      posting_url: 'https://example.com/mixed-country-berlin-unstated',
      sponsorship_status: 'unstated',
      sponsorship_scope: null,
      job_country: 'non_us',
      raw_json: { portal_country: 'Germany' },
      last_seen_at: new Date(),
      is_active: true,
    },
    {
      source_id: source.id,
      external_id: 'berlin-h1b-only',
      company_name: company,
      title: 'Berlin H1B Engineer',
      location: 'Berlin',
      description,
      ingest_eligible: true,
      apply_url: 'https://example.com/berlin-h1b-only/apply',
      posting_url: 'https://example.com/berlin-h1b-only',
      sponsorship_status: 'offers',
      sponsorship_scope: 'us_h1b',
      job_country: 'non_us',
      raw_json: { portal_country: 'Germany' },
      last_seen_at: new Date(),
      is_active: true,
    },
  ]);

  try {
    const response = await app.inject({
      method: 'GET',
      url: `/jobs/grouped?company=${encodeURIComponent(company)}&limit=100`,
    });
    assert.equal(response.statusCode, 200);
    type GroupedJob = {
      title: string;
      sponsorship_evidence: string | null;
      sponsorship_country_codes: string[];
    };
    const jobs = response.json().jobs as GroupedJob[];
    const byTitle = Object.fromEntries(jobs.map((job) => [job.title, job]));
    assert.equal(byTitle['Mixed Country Engineer'].sponsorship_evidence, 'posting_offers');
    assert.deepEqual(byTitle['Mixed Country Engineer'].sponsorship_country_codes, ['US'],
      'the unstated Berlin copy cannot donate DE to the US offer');
    assert.equal(byTitle['Berlin H1B Engineer'].sponsorship_evidence, null);
    assert.deepEqual(byTitle['Berlin H1B Engineer'].sponsorship_country_codes, [],
      'H-1B text on a Berlin posting is not German visa evidence');
  } finally {
    await db.delete(monitored_jobs).where(eq(monitored_jobs.company_name, company));
  }
});

test('a recent row rejected by the full ingest validator exists on no public surface', async () => {
  const { career_page_sources, monitored_jobs } = schema;
  const [source] = await db.select().from(career_page_sources)
    .where(eq(career_page_sources.board_token, 'fixture'))
    .limit(1);
  const [rejected] = await db.insert(monitored_jobs).values({
    source_id: source.id,
    external_id: 'rejected-description',
    company_name: 'Rejected Description Co',
    title: 'Engineer',
    description: 'Engineer',
    ingest_eligible: false,
    apply_url: 'https://example.com/rejected/apply',
    posting_url: 'https://example.com/rejected',
    last_seen_at: new Date(),
    is_active: true,
  }).returning({ id: monitored_jobs.id });

  const [list, grouped, facets, detail] = await Promise.all([
    app.inject({ method: 'GET', url: '/jobs?limit=100' }),
    app.inject({ method: 'GET', url: '/jobs/grouped?limit=100' }),
    app.inject({ method: 'GET', url: '/jobs/facets?counts=true' }),
    app.inject({ method: 'GET', url: `/jobs/${rejected.id}` }),
  ]);
  assert.ok(!list.json().jobs.some((job: { company_name: string }) => job.company_name === 'Rejected Description Co'));
  assert.ok(!grouped.json().jobs.some((job: { company_name: string }) => job.company_name === 'Rejected Description Co'));
  assert.ok(!facets.json().company_counts.some((row: { company_name: string }) => row.company_name === 'Rejected Description Co'));
  assert.equal(detail.statusCode, 404);
});

test('source sync seeds reviewed domains as candidates and lets fetched ATS evidence replace them', async () => {
  const source = {
    company_name: 'Airbnb',
    ats_name: 'greenhouse' as const,
    board_token: 'logo-upsert-airbnb',
    career_url: 'https://job-boards.greenhouse.io/logo-upsert-airbnb',
    enabled: true,
  };
  await upsertSources([source]);
  let row = (await db.select().from(schema.career_page_sources))
    .find((candidate) => candidate.board_token === source.board_token)!;
  assert.equal(row.company_domain, 'airbnb.com');
  assert.equal(row.company_logo_url, null);
  assert.equal(row.logo_verification_status, 'unverified');
  assert.equal(row.logo_verification_method, 'reviewed_company_domain_candidate');
  assert.equal(row.logo_verified_at, null);

  await upsertSources([source]);
  row = (await db.select().from(schema.career_page_sources))
    .find((candidate) => candidate.board_token === source.board_token)!;
  assert.equal(row.logo_verified_at, null,
    'daily catalog reconciliation must not mint verification proof');

  const atsVerifiedAt = new Date('2026-08-30T12:00:00.000Z');
  await upsertSources([{
    ...source,
    company_domain: null,
    company_logo_url: 'https://assets.example/airbnb-employer-logo.png',
    logo_verification_status: 'verified',
    logo_verification_method: 'first_party_ats_employer_logo',
    logo_verified_at: atsVerifiedAt,
  }]);
  row = (await db.select().from(schema.career_page_sources))
    .find((candidate) => candidate.board_token === source.board_token)!;
  assert.equal(row.company_domain, null);
  assert.equal(row.company_logo_url, 'https://assets.example/airbnb-employer-logo.png');
  assert.equal(row.logo_verification_status, 'verified');
  assert.equal(row.logo_verification_method, 'first_party_ats_employer_logo');
  assert.equal(row.logo_verified_at!.toISOString(), atsVerifiedAt.toISOString());

  await upsertSources([{
    ...source,
    company_name: source.board_token,
    logo_verification_status: 'unverified',
    logo_verification_method: 'cc0_board_identifier_candidate',
    logo_verified_at: null,
  }]);
  row = (await db.select().from(schema.career_page_sources))
    .find((candidate) => candidate.board_token === source.board_token)!;
  assert.equal(row.company_name, 'Airbnb', 'a provisional slug must not overwrite verified identity');
  assert.equal(row.company_logo_url, 'https://assets.example/airbnb-employer-logo.png');
  assert.equal(row.logo_verification_status, 'verified');
  assert.equal(row.logo_verification_method, 'first_party_ats_employer_logo');
  assert.equal(row.logo_verified_at!.toISOString(), atsVerifiedAt.toISOString());
});

test('scheduled discovery preserves an operator disable until an explicit operator restore', async () => {
  const source = {
    company_name: 'Airbnb',
    ats_name: 'greenhouse' as const,
    board_token: 'operator-disabled-airbnb',
    career_url: 'https://job-boards.greenhouse.io/operator-disabled-airbnb',
    enabled: true,
  };
  await upsertSources([source]);
  await db.update(schema.career_page_sources)
    .set({ enabled: false })
    .where(eq(schema.career_page_sources.board_token, source.board_token));

  await upsertSources([source], { preserveExistingDisabled: true });
  let row = (await db.select().from(schema.career_page_sources))
    .find((candidate) => candidate.board_token === source.board_token)!;
  assert.equal(row.enabled, false, 'catalog refresh cannot silently undo an operator decision');

  await upsertSources([source]);
  row = (await db.select().from(schema.career_page_sources))
    .find((candidate) => candidate.board_token === source.board_token)!;
  assert.equal(row.enabled, true, 'the operator write path can deliberately restore the source');
});

test('a posting outside the verification window is counted by neither', async () => {
  // The board hides unverified postings, so a count that included them would overstate the denominator
  // and quietly drag measured coverage down for rows no job seeker is shown.
  const { career_page_sources, monitored_jobs } = schema;
  const [source] = await db.select().from(career_page_sources).limit(1);
  await db.insert(monitored_jobs).values({
    source_id: source.id,
    external_id: 'stale-1',
    company_name: 'Ancient Co',
    title: 'Engineer',
    description: 'x',
    apply_url: 'https://example.com/stale',
    posting_url: 'https://example.com/stale',
    posted_at: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
    last_seen_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    is_active: true,
  });

  const res = await app.inject({ method: 'GET', url: '/jobs/facets?counts=true' });
  const names = res.json().company_counts.map((c: { company_name: string }) => c.company_name);
  assert.ok(!names.includes('Ancient Co'), 'an unverified posting must not enter the denominator');
});

test('an old posting still counts when its employer feed verified it recently', async () => {
  const { career_page_sources, monitored_jobs } = schema;
  const [source] = await db.select().from(career_page_sources).limit(1);
  await db.insert(monitored_jobs).values({
    source_id: source.id,
    external_id: 'old-but-open',
    company_name: 'Long Running Requisition Co',
    title: 'Engineer',
    description: 'A full role description that the employer still publishes on its live careers feed, including responsibilities, requirements, qualifications, and enough detail to evaluate the opening.'.repeat(2),
    ingest_eligible: true,
    apply_url: 'https://example.com/old-but-open',
    posting_url: 'https://example.com/old-but-open',
    posted_at: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
    last_seen_at: new Date(),
    is_active: true,
  });

  const res = await app.inject({ method: 'GET', url: '/jobs/facets?counts=true' });
  const names = res.json().company_counts.map((c: { company_name: string }) => c.company_name);
  assert.ok(names.includes('Long Running Requisition Co'));
});

test('career_url addresses exactly one source, which a colliding company name cannot', async () => {
  /* The company filter is a substring over display names, and display names collide: the live
     board carries several distinct sources literally named "Careers" and two real companies named
     "Crisp", so name-keyed callers (the website logo route resolving one source's verified
     evidence) either page through thousands of strangers or refuse the ambiguity. career_url is
     the source's identity, so this filter must be exact and quiet: the whole board for its one
     URL, nothing for anyone else's. */
  const [filtered, board] = await Promise.all([
    app.inject({
      method: 'GET',
      url: `/jobs?limit=100&career_url=${encodeURIComponent('https://job-boards.greenhouse.io/fixture')}`,
    }),
    app.inject({ method: 'GET', url: '/jobs?limit=100' }),
  ]);
  assert.equal(filtered.statusCode, 200);
  const expected = board.json().jobs
    .filter((job: { career_url: string }) => job.career_url === 'https://job-boards.greenhouse.io/fixture')
    .length;
  assert.ok(expected > 0, 'the fixture source must be on the board for this test to mean anything');
  assert.equal(filtered.json().total, expected);
  for (const job of filtered.json().jobs) {
    assert.equal(job.career_url, 'https://job-boards.greenhouse.io/fixture');
  }

  const stranger = await app.inject({
    method: 'GET',
    url: `/jobs?limit=100&career_url=${encodeURIComponent('https://job-boards.greenhouse.io/someone-else')}`,
  });
  assert.equal(stranger.statusCode, 200);
  assert.equal(stranger.json().total, 0, 'an unknown source matches nothing, never a fuzzy neighbour');

  const grouped = await app.inject({
    method: 'GET',
    url: `/jobs/grouped?limit=100&career_url=${encodeURIComponent('https://job-boards.greenhouse.io/fixture')}`,
  });
  assert.equal(grouped.statusCode, 200);
  assert.ok(grouped.json().jobs.length > 0, 'the grouped surface honours the same source key');

  const insecure = await app.inject({
    method: 'GET',
    url: `/jobs?career_url=${encodeURIComponent('http://job-boards.greenhouse.io/fixture')}`,
  });
  assert.equal(insecure.statusCode, 400, 'the source key is https-only, like every stored career_url');
});
