/**
 * Run with: npm run test:e2e
 * Requires a local Postgres. See e2e/README.md; it is NOT part of `npm test`, which stays
 * dependency-free so CI needs no database.
 *
 * End-to-end proof that the "Applied" badge marks the posting the student applied to and not its
 * siblings.
 *
 * WHY THIS EXISTS AS AN E2E RATHER THAN TWO UNIT SUITES. The bug lived in the seam between the
 * repos, not inside either one: the board stored `{company, role}`, the jobs list matched on
 * `{company, role}`, and each side was individually correct. Unit tests on either side pass both
 * before and after the fix. Only running the real projection over a real row and feeding the real
 * response into the real frontend decision can show the sibling going dark.
 *
 * WHAT IS REAL HERE, so the claim can be audited:
 *  - a real Postgres (litos_e2e_jobid), schema pushed from src/db/schema.ts
 *  - the real Fastify app from buildApp(), driven over HTTP via inject(), through real requireAuth
 *  - the real GET /applications/board handler and its real projection
 *  - the real deployed frontend logic: frontend-job-rows.main.ts is `git show origin/main:
 *    lib/job-rows.ts` with ONLY its type-only import line stubbed (verified byte-identical below
 *    line 1), so this is not a reimplementation
 *
 * WHAT IS NOT EXERCISED, stated plainly: POST /resume/generate is not called. Reaching the line
 * that writes job_context requires a live Anthropic call, a PDF render and a blob upload, none of
 * which belong in a local test. The rows here are inserted in the exact shape that route builds.
 * The request-schema half of the write path is covered by src/routes/resumeRequestSchema.test.ts.
 */
// src/index.ts calls start() on import unless VERCEL is set, and static imports hoist above any
// assignment here, so every env var the app reads at import time must be set before the DYNAMIC
// imports below. Same reasoning as src/index.test.ts, which documents this trap.
process.env.VERCEL = '1';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL = `postgresql://${process.env.USER}@localhost:5432/litos_e2e_jobid`;
process.env.JWT_SIGNING_SECRET = 'e2e-test-only-signing-secret-at-least-32-chars';
process.env.ENCRYPTION_KEY = 'e2e-test-only-encryption-key-at-least-32-chars';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';

const { db, pool } = await import('../src/db/index.ts');
const { users, career_page_sources, monitored_jobs, generated_resumes } = await import('../src/db/schema.ts');
const { buildApp } = await import('../src/index.ts');
const { buildAppliedIndex, isJobApplied } = await import('./website-job-rows.vendored.ts');
const { packetMatchesJob } = await import('./website-daily-matches.vendored.ts');

const EXPECTED_DB = 'litos_e2e_jobid';
const COMPANY = 'Google';
const TITLE = 'Software Engineer';

const userId = randomUUID();
const sourceId = randomUUID();
const mtvJobId = randomUUID(); // the posting the student applies to
const nycJobId = randomUUID(); // its sibling: same company, same title, different city
const lonJobId = randomUUID(); // a second sibling, to show this is not a two-row coincidence

function posting(id: string, location: string) {
  return {
    id,
    source_id: sourceId,
    external_id: `ext-${location}`,
    company_name: COMPANY,
    title: TITLE, // identical on purpose: this is exactly what company+role cannot tell apart
    location,
    description: 'Build things.',
    apply_url: `https://boards.greenhouse.io/google/${location}`,
    posting_url: `https://boards.greenhouse.io/google/${location}`,
    remote: false,
  };
}

/** The board response, fetched the way the dashboard fetches it: real HTTP, real auth. */
async function fetchBoardAsUser(app: Awaited<ReturnType<typeof buildApp>>) {
  const token = await new SignJWT({ userId, isGuest: false, sessionVersion: 0, authMethod: 'legacy' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SIGNING_SECRET!));

  const res = await app.inject({
    method: 'GET',
    url: '/applications/board',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, `board should authorise and answer, got ${res.statusCode}: ${res.body}`);
  return JSON.parse(res.body).cards as Array<{ id: string; job_id: string | null; company: string; role: string; stage: string }>;
}

/**
 * Refuse to touch anything but the throwaway database.
 *
 * This file truncates four tables on every run, and importing the app pulls in `dotenv/config`
 * (src/index.ts:1), which loads the real `.env`. dotenv does not overwrite a variable that is
 * already set, and DATABASE_URL is assigned at the top of this module before the dynamic imports,
 * so the throwaway URL wins. That is two non-obvious behaviours deep for something whose failure
 * mode is deleting a real table, so this asks the live connection what it is actually attached to
 * rather than trusting the reasoning.
 */
async function assertThrowawayDatabase() {
  const { rows } = await pool.query('select current_database() as db');
  const name = rows[0]?.db;
  if (name !== EXPECTED_DB) {
    throw new Error(
      `REFUSING TO RUN: connected to "${name}", expected "${EXPECTED_DB}". ` +
      `This test truncates tables. Check DATABASE_URL.`,
    );
  }
  console.log(`connected to ${name} (throwaway), safe to truncate`);
}

/** The packet list, fetched the way the dashboard fetches it. A DIFFERENT endpoint from the board:
 *  the badge reads /applications/board, but "does a packet already exist for this posting" reads
 *  /resume/history, and only this one proves job_id survives that projection too. */
async function fetchHistoryAsUser(app: Awaited<ReturnType<typeof buildApp>>) {
  const token = await new SignJWT({ userId, isGuest: false, sessionVersion: 0, authMethod: 'legacy' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SIGNING_SECRET!));
  const res = await app.inject({
    method: 'GET',
    url: '/resume/history',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, `history should answer, got ${res.statusCode}: ${res.body}`);
  return JSON.parse(res.body).resumes as Array<{ job_context: { company?: string; role?: string; job_id?: string | null } }>;
}

async function seedBase() {
  await db.delete(generated_resumes);
  await db.delete(monitored_jobs);
  await db.delete(career_page_sources);
  await db.delete(users);

  await db.insert(users).values({ id: userId, is_guest: false, session_version: 0 });
  await db.insert(career_page_sources).values({
    id: sourceId, company_name: COMPANY, ats_name: 'greenhouse',
    board_token: 'google', career_url: 'https://google.com/careers',
  });
  await db.insert(monitored_jobs).values([
    posting(mtvJobId, 'Mountain View, CA'),
    posting(nycJobId, 'New York, NY'),
    posting(lonJobId, 'London, UK'),
  ]);
}

/** The three postings as the jobs list sees them. */
const rows = [
  { id: mtvJobId, company_name: COMPANY, title: TITLE },
  { id: nycJobId, company_name: COMPANY, title: TITLE },
  { id: lonJobId, company_name: COMPANY, title: TITLE },
];

let failures = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${label}\n       ${(err as Error).message.split('\n')[0]}`);
  }
}

const app = await buildApp();
await assertThrowawayDatabase();

// ── Scenario 1: the fix. An application carrying the posting's id. ───────────────────────────
console.log('\nScenario 1: application records the posting id (the fix)');
await seedBase();
await db.insert(generated_resumes).values({
  user_id: userId,
  // Exactly the shape src/routes/resume.ts builds when the caller sends job_id.
  job_context: { company: COMPANY, role: TITLE, jd_hash: 'abc123', job_id: mtvJobId },
  spec: {},
  resume_object_key: 'resumes/e2e-1.pdf',
  pipeline_stage: 'applied',
});

const cards1 = await fetchBoardAsUser(app);
check('the board returns exactly one card', () => assert.equal(cards1.length, 1));
check('the card carries job_id, projected from the stored jsonb', () => assert.equal(cards1[0].job_id, mtvJobId));
check('the card is in an applied stage', () => assert.equal(cards1[0].stage, 'applied'));

const index1 = buildAppliedIndex(cards1);
check('the id landed in the id set', () => assert.deepEqual([...index1.ids], [mtvJobId]));
check('and contributed NO company+role key (the load-bearing else)', () => assert.equal(index1.keys.size, 0));

check('Mountain View, the one applied to, reads Applied', () => assert.equal(isJobApplied(rows[0], index1), true));
check('New York, same company and title, does NOT read Applied', () => assert.equal(isJobApplied(rows[1], index1), false));
check('London, same company and title, does NOT read Applied', () => assert.equal(isJobApplied(rows[2], index1), false));

// ── Scenario 2: the bug, reproduced. A legacy row with no id. ────────────────────────────────
console.log('\nScenario 2: legacy application with no job_id (pre-fix rows, and the extension)');
await seedBase();
await db.insert(generated_resumes).values({
  user_id: userId,
  job_context: { company: COMPANY, role: TITLE, jd_hash: 'abc123' }, // the old three-key shape
  spec: {},
  resume_object_key: 'resumes/e2e-2.pdf',
  pipeline_stage: 'applied',
});

const cards2 = await fetchBoardAsUser(app);
check('the board returns job_id as null rather than omitting it', () => {
  assert.ok('job_id' in cards2[0], 'job_id key must be present');
  assert.equal(cards2[0].job_id, null);
});

const index2 = buildAppliedIndex(cards2);
check('the fallback key is used instead', () => assert.equal(index2.keys.size, 1));
check('the legacy application still marks its posting (fallback works)', () => assert.equal(isJobApplied(rows[0], index2), true));
check('and it still marks the siblings, which is the OLD bug and is unfixable for these rows', () => {
  assert.equal(isJobApplied(rows[1], index2), true);
  assert.equal(isJobApplied(rows[2], index2), true);
});

// ── Scenario 3: both kinds at once, each matching its own way. ───────────────────────────────
console.log('\nScenario 3: a legacy row and a new row coexisting');
await seedBase();
await db.insert(generated_resumes).values([
  {
    user_id: userId,
    job_context: { company: COMPANY, role: TITLE, jd_hash: 'a', job_id: mtvJobId },
    spec: {}, resume_object_key: 'resumes/e2e-3a.pdf', pipeline_stage: 'applied',
  },
  {
    user_id: userId,
    job_context: { company: 'Stripe', role: 'Data Analyst', jd_hash: 'b' },
    spec: {}, resume_object_key: 'resumes/e2e-3b.pdf', pipeline_stage: 'applied',
  },
]);

const index3 = buildAppliedIndex(await fetchBoardAsUser(app));
check('the id-bearing row still marks only its own posting', () => {
  assert.equal(isJobApplied(rows[0], index3), true);
  assert.equal(isJobApplied(rows[1], index3), false);
});
check('the legacy row still matches by company+role', () =>
  assert.equal(isJobApplied({ id: 'other', company_name: 'Stripe', title: 'Data Analyst' }, index3), true));

// ── Scenario 4: a saved (not applied) row must mark nothing. ─────────────────────────────────
console.log('\nScenario 4: a saved application is not an application');
await seedBase();
await db.insert(generated_resumes).values({
  user_id: userId,
  job_context: { company: COMPANY, role: TITLE, jd_hash: 'c', job_id: mtvJobId },
  spec: {}, resume_object_key: 'resumes/e2e-4.pdf', pipeline_stage: 'saved',
});

const index4 = buildAppliedIndex(await fetchBoardAsUser(app));
check('a saved row marks nothing at all', () => {
  assert.equal(index4.ids.size, 0);
  assert.equal(index4.keys.size, 0);
  assert.equal(isJobApplied(rows[0], index4), false);
});

// ── Scenario 5: the prewarm reality. Many packets, each for its own posting. ─────────────────
// The dashboard prewarms a resume per matched job, so a real account holds packets for several
// postings at once, including siblings. A naive "any id means applied" bug would pass every
// scenario above and still fail here.
console.log('\nScenario 5: applications for two of three siblings');
await seedBase();
await db.insert(generated_resumes).values([
  {
    user_id: userId,
    job_context: { company: COMPANY, role: TITLE, jd_hash: 'd', job_id: mtvJobId },
    spec: {}, resume_object_key: 'resumes/e2e-5a.pdf', pipeline_stage: 'applied',
  },
  {
    user_id: userId,
    job_context: { company: COMPANY, role: TITLE, jd_hash: 'e', job_id: lonJobId },
    spec: {}, resume_object_key: 'resumes/e2e-5b.pdf', pipeline_stage: 'applied',
  },
]);

const index5 = buildAppliedIndex(await fetchBoardAsUser(app));
check('both ids are indexed, and still no fallback key', () => {
  assert.equal(index5.ids.size, 2);
  assert.equal(index5.keys.size, 0);
});
check('Mountain View reads Applied', () => assert.equal(isJobApplied(rows[0], index5), true));
check('London reads Applied', () => assert.equal(isJobApplied(rows[2], index5), true));
check('New York, the one never applied to, still does NOT', () => assert.equal(isJobApplied(rows[1], index5), false));

// ── Scenario 6: packet reuse. Which posting an existing packet belongs to. ───────────────────
// A different question from the badge, on a different endpoint, and the one that decides whether
// "Apply now" reuses a packet or builds a new one. A wrong match here showed the student a resume
// tailored to a different posting AND skipped the build for the one they opened.
console.log('\nScenario 6: an existing packet is claimed by its own posting only');
await seedBase();
await db.insert(generated_resumes).values({
  user_id: userId,
  job_context: { company: COMPANY, role: TITLE, jd_hash: 'f', job_id: mtvJobId },
  spec: {}, resume_object_key: 'resumes/e2e-6.pdf', pipeline_stage: 'saved',
});

const history = await fetchHistoryAsUser(app);
check('/resume/history returns the packet with its job_id intact', () => {
  assert.equal(history.length, 1);
  assert.equal(history[0].job_context.job_id, mtvJobId);
});
check('the packet is claimed by the posting it was built for', () =>
  assert.equal(packetMatchesJob(history[0] as never, rows[0] as never), true));
check('and NOT by the sibling req at the same company with the same title', () => {
  assert.equal(packetMatchesJob(history[0] as never, rows[1] as never), false);
  assert.equal(packetMatchesJob(history[0] as never, rows[2] as never), false);
});

// The legacy half, on this endpoint too.
await seedBase();
await db.insert(generated_resumes).values({
  user_id: userId,
  job_context: { company: COMPANY, role: TITLE, jd_hash: 'g' },
  spec: {}, resume_object_key: 'resumes/e2e-6b.pdf', pipeline_stage: 'saved',
});
const legacyHistory = await fetchHistoryAsUser(app);
check('a packet with no job_id still matches by company and role', () =>
  assert.equal(packetMatchesJob(legacyHistory[0] as never, rows[0] as never), true));

await app.close();
await pool.end();

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
