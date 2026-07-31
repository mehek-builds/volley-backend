/**
 * Database-backed contract test for Phase 1 inventory reporting.
 *
 * Run with npm run test:e2e after the setup in e2e/README.md. This deliberately uses the same
 * throwaway database as the existing E2E suite and refuses to run against any other database.
 */
process.env.VERCEL = '1';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL = `postgresql://${process.env.USER}@localhost:5432/litos_e2e_jobid`;
process.env.JWT_SIGNING_SECRET = 'e2e-test-only-signing-secret-at-least-32-chars';
process.env.ENCRYPTION_KEY = 'e2e-test-only-encryption-key-at-least-32-chars';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { db, pool } = await import('../src/db/index.ts');
const { career_page_sources, monitored_jobs, sponsor_employers } = await import('../src/db/schema.ts');
const { buildApp } = await import('../src/index.ts');
const {
  boardInventoryMetrics,
  surfacedGroupedRoleCount,
  syncSponsorEmployers,
  upsertSources,
} = await import('../src/routes/jobMonitor.ts');
const { JOB_SOURCES } = await import('../src/lib/jobSources.ts');

const EXPECTED_DB = 'litos_e2e_jobid';
const greenhouseSourceId = randomUUID();
const leverSourceId = randomUUID();
const disabledSourceId = randomUUID();
const unsupportedSourceId = randomUUID();

const current = await pool.query('select current_database() as database');
assert.equal(
  current.rows[0]?.database,
  EXPECTED_DB,
  `REFUSING TO RUN: expected the throwaway ${EXPECTED_DB} database`,
);

await db.delete(monitored_jobs);
await db.delete(career_page_sources);
await db.insert(career_page_sources).values([
  {
    id: greenhouseSourceId,
    company_name: 'Acme',
    ats_name: 'greenhouse',
    board_token: 'acme-greenhouse',
    career_url: 'https://boards.greenhouse.io/acme',
  },
  {
    id: leverSourceId,
    company_name: 'Acme',
    ats_name: 'lever',
    board_token: 'acme-lever',
    career_url: 'https://jobs.lever.co/acme',
  },
  {
    id: disabledSourceId,
    company_name: 'Disabled Co',
    ats_name: 'greenhouse',
    board_token: 'disabled',
    career_url: 'https://boards.greenhouse.io/disabled',
    enabled: false,
  },
  {
    id: unsupportedSourceId,
    company_name: 'Unsupported Co',
    ats_name: 'smartrecruiters',
    board_token: 'unsupported',
    career_url: 'https://careers.smartrecruiters.com/unsupported',
  },
]);

function posting(
  sourceId: string,
  externalId: string,
  location: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    source_id: sourceId,
    external_id: externalId,
    company_name: 'Acme',
    title: 'Software Engineer',
    location,
    description: 'Build reliable systems for customers.',
    apply_url: `https://example.com/apply/${externalId}`,
    posting_url: `https://example.com/jobs/${externalId}`,
    posted_at: new Date(),
    remote: false,
    ...overrides,
  };
}

await db.insert(monitored_jobs).values([
  posting(greenhouseSourceId, 'gh-new-york', 'New York, NY', { sponsorship_status: 'offers' }),
  posting(greenhouseSourceId, 'gh-london', 'London, UK'),
  posting(leverSourceId, 'lever-new-york', 'New York, NY'),
  posting(greenhouseSourceId, 'stale', 'Paris, France', {
    posted_at: new Date(Date.now() - 15 * 86_400_000),
  }),
  posting(greenhouseSourceId, 'inactive', 'Berlin, Germany', { is_active: false }),
  posting(disabledSourceId, 'disabled-source', 'Austin, TX'),
  posting(unsupportedSourceId, 'unsupported-source', 'Toronto, Canada'),
]);

const app = await buildApp();
const response = await app.inject({ method: 'GET', url: '/jobs/grouped' });
assert.equal(response.statusCode, 200, response.body);
const body = JSON.parse(response.body);
assert.equal(body.total, 2, 'ATS family is part of the grouped-role key');
assert.equal(body.postings_total, 3, 'raw openings preserve both location postings');
assert.equal(body.jobs.length, 2, 'the route returns one tile per grouped role');

assert.equal(await surfacedGroupedRoleCount(), 2, 'cron and public API use the same grouping key');
assert.deepEqual(await boardInventoryMetrics(), {
  surfacedPostings: 3,
  surfacedGroupedRoles: 2,
  surfacedSponsorOnly: 1,
});

// The production cron starts from an empty database after deployment. Prove that the checked-in
// sponsor artifact and reviewed source catalog become queryable rows without a manual seed step.
await db.delete(monitored_jobs);
await db.delete(career_page_sources);
await db.delete(sponsor_employers);
await syncSponsorEmployers();
await upsertSources(JOB_SOURCES);
const syncedCounts = await pool.query(`
  select
    (select count(*)::int from sponsor_employers) as sponsors,
    (select count(*)::int from career_page_sources) as sources
`);
assert.ok(syncedCounts.rows[0].sponsors > 0, 'the cron syncs confirmed sponsor employers');
assert.equal(syncedCounts.rows[0].sources, JOB_SOURCES.length, 'the cron syncs every reviewed source');

// A portal-name mismatch is a safety veto. Re-running the catalog sync must never restore the
// sponsor link until a successful poll has cleared the mismatch.
const sponsorSource = JOB_SOURCES.find((source) => source.company_name === 'Abnormal AI');
assert.ok(sponsorSource, 'the reviewed catalog contains a confirmed sponsor source for this check');
await pool.query(`
  update career_page_sources
     set portal_name_mismatch = true, sponsor_employer_id = null
   where ats_name = $1 and board_token = $2
`, [sponsorSource.ats_name, sponsorSource.board_token]);
await upsertSources([sponsorSource]);
const mismatch = await pool.query(`
  select portal_name_mismatch, sponsor_employer_id
    from career_page_sources
   where ats_name = $1 and board_token = $2
`, [sponsorSource.ats_name, sponsorSource.board_token]);
assert.equal(mismatch.rows[0].portal_name_mismatch, true);
assert.equal(mismatch.rows[0].sponsor_employer_id, null, 'catalog sync preserves the identity veto');

await upsertSources([
  { ...sponsorSource, company_name: 'Discarded duplicate' },
  sponsorSource,
]);
const deduplicated = await pool.query(`
  select company_name
    from career_page_sources
   where ats_name = $1 and board_token = $2
`, [sponsorSource.ats_name, sponsorSource.board_token]);
assert.equal(deduplicated.rowCount, 1, 'operator batches may repeat a source key safely');
assert.equal(deduplicated.rows[0].company_name, sponsorSource.company_name, 'the final override wins');

await app.close();
await pool.end();
console.log('GROUPED INVENTORY E2E RESULT: PASS');
