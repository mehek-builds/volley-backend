/**
 * LIVE PROOF THAT THE SPONSOR-ONLY BOARD FILTERS, END TO END.
 *
 *   DATABASE_URL=postgresql://localhost:5432/student_outreach \
 *     node --import tsx scripts/qa-sponsor-board.mts
 *
 * Not a unit test, and not a substitute for one: this boots the real Fastify app, writes real rows,
 * signs a real JWT and reads the real GET /jobs. It exists because every part of this feature that
 * can actually fail lives in the seams the unit tests cannot reach - the SQL predicate, the ranking
 * cache key, the repeated filter on the by-id re-read, and the one-way settings toggle.
 *
 * It is destructive to the rows it creates and cleans them up on the way out, so it must only ever
 * be pointed at a scratch database. It refuses to run against anything that looks like production.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { db } from '../src/db/index';
import { career_page_sources, monitored_jobs, sponsor_employers, users } from '../src/db/schema';

const url = process.env.DATABASE_URL ?? '';
if (!/localhost|127\.0\.0\.1/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}

/* src/index.ts starts a listener on import unless it thinks it is serverless, and this script has
   no use for a bound port - every request below goes through app.inject(). Set before the dynamic
   import, which is why buildApp is not a static one. */
process.env.VERCEL ||= '1';
process.env.ENCRYPTION_KEY ||= 'qa-local-encryption-key-32-chars-min';
process.env.JWT_SIGNING_SECRET ||= 'qa-local-jwt-signing-secret-32-chars';
const { buildApp } = await import('../src/index');

const SPONSOR_TOKEN = 'qa-sponsor-yes';
const NO_SPONSOR_TOKEN = 'qa-sponsor-no';
let failures = 0;

/* Key order is a property of the ROW ORDER the board returned, not of the answer being checked, so
   objects are compared with their keys sorted. Without this the evidence check fails whenever the
   ranking puts two equally-good postings in a different order, which is not a defect. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner);
}

function check(name: string, actual: unknown, expected: unknown) {
  const ok = stable(actual) === stable(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`}`);
}

async function cleanup() {
  const sources = await db
    .select({ id: career_page_sources.id })
    .from(career_page_sources)
    .where(inArray(career_page_sources.board_token, [SPONSOR_TOKEN, NO_SPONSOR_TOKEN]));
  if (sources.length) {
    await db.delete(monitored_jobs).where(inArray(monitored_jobs.source_id, sources.map((s) => s.id)));
    await db.delete(career_page_sources).where(inArray(career_page_sources.id, sources.map((s) => s.id)));
  }
  await db.delete(users).where(inArray(users.email, ['qa-sponsor@litos.test', 'qa-sponsor-2@litos.test']));
}

await cleanup();

/* An employer with filings, and one without. Both get one posting that says nothing, one that
   refuses, and one that offers - nine of the twelve combinations do not need writing down because
   the rule only has three inputs, but all six rows are needed to prove the OR in the predicate. */
const [employer] = await db
  .insert(sponsor_employers)
  .values({
    normalized_name: 'QA SPONSORING EMPLOYER',
    company_name: 'QA Sponsoring Employer',
    legal_names: ['QA SPONSORING EMPLOYER INC'],
    evidence_source: 'uscis_h1b',
    approvals: 12,
    denials: 0,
    fiscal_years: [2023],
  })
  .onConflictDoUpdate({
    target: sponsor_employers.normalized_name,
    set: { approvals: 12 },
  })
  .returning({ id: sponsor_employers.id });

const [sponsoring] = await db.insert(career_page_sources).values({
  company_name: 'QA Sponsoring Employer',
  ats_name: 'greenhouse',
  board_token: SPONSOR_TOKEN,
  career_url: 'https://job-boards.greenhouse.io/qa-sponsor-yes',
  sponsor_employer_id: employer.id,
}).returning({ id: career_page_sources.id });

const [notSponsoring] = await db.insert(career_page_sources).values({
  company_name: 'QA Unconfirmed Employer',
  ats_name: 'greenhouse',
  board_token: NO_SPONSOR_TOKEN,
  career_url: 'https://job-boards.greenhouse.io/qa-sponsor-no',
  sponsor_employer_id: null,
}).returning({ id: career_page_sources.id });

const rows = [
  { source: sponsoring.id, company: 'QA Sponsoring Employer', title: 'QA Sponsored Unstated', status: 'unstated', surfaced: true },
  { source: sponsoring.id, company: 'QA Sponsoring Employer', title: 'QA Sponsored Refused', status: 'refuses', surfaced: false },
  { source: sponsoring.id, company: 'QA Sponsoring Employer', title: 'QA Sponsored Offered', status: 'offers', surfaced: true },
  { source: notSponsoring.id, company: 'QA Unconfirmed Employer', title: 'QA Unconfirmed Unstated', status: 'unstated', surfaced: false },
  { source: notSponsoring.id, company: 'QA Unconfirmed Employer', title: 'QA Unconfirmed Refused', status: 'refuses', surfaced: false },
  { source: notSponsoring.id, company: 'QA Unconfirmed Employer', title: 'QA Unconfirmed Offered', status: 'offers', surfaced: true },
];

await db.insert(monitored_jobs).values(rows.map((row, index) => ({
  source_id: row.source,
  external_id: `qa-sponsor-${index}`,
  company_name: row.company,
  title: row.title,
  description: 'QA fixture posting.',
  apply_url: `https://example.test/apply/${index}`,
  posting_url: `https://example.test/job/${index}`,
  sponsorship_status: row.status,
})));

const [account] = await db.insert(users).values({
  email: 'qa-sponsor@litos.test',
  email_verified: true,
}).returning({ id: users.id });

const secret = new TextEncoder().encode(process.env.JWT_SIGNING_SECRET!);
const token = await new SignJWT({ userId: account.id, email: 'qa-sponsor@litos.test' })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(secret);

const app = await buildApp({ logger: false });
const auth = { authorization: `Bearer ${token}` };

async function boardTitles(headers: Record<string, string> = {}, query = '') {
  const response = await app.inject({ method: 'GET', url: `/jobs?company=QA${query}`, headers });
  const body = response.json();
  return {
    titles: (body.jobs as { title: string }[]).map((job) => job.title).sort(),
    total: body.total,
    sponsorOnly: body.sponsor_only,
    evidence: Object.fromEntries((body.jobs as { title: string; sponsorship_evidence: string | null }[])
      .map((job) => [job.title, job.sponsorship_evidence])),
  };
}

const everything = [
  'QA Sponsored Offered', 'QA Sponsored Refused', 'QA Sponsored Unstated',
  'QA Unconfirmed Offered', 'QA Unconfirmed Refused', 'QA Unconfirmed Unstated',
].sort();
const sponsorOnlyTitles = ['QA Sponsored Offered', 'QA Sponsored Unstated', 'QA Unconfirmed Offered'].sort();

// 1. Signed out, and signed in without a declaration: the whole board.
check('signed out sees every posting', (await boardTitles()).titles, everything);
check('undeclared account sees every posting', (await boardTitles(auth)).titles, everything);

// 2. The public checkbox filters for anyone.
const anonymousFiltered = await boardTitles({}, '&sponsor_only=true');
check('sponsor_only=true filters signed out', anonymousFiltered.titles, sponsorOnlyTitles);
check('...and reports which rule it applied', anonymousFiltered.sponsorOnly, true);
check('...and the count matches the list', anonymousFiltered.total, sponsorOnlyTitles.length);
check('...and each row says what confirmed it', anonymousFiltered.evidence, {
  'QA Sponsored Offered': 'posting_offers',
  'QA Sponsored Unstated': 'employer_h1b_filings',
  'QA Unconfirmed Offered': 'posting_offers',
});

// 3. The declaration.
const declared = await app.inject({
  method: 'POST', url: '/onboarding/sponsorship', headers: auth, payload: { answer: 'needs_future' },
});
check('declaring returns a filtered board', declared.json().sponsor_only_board, true);
check('...and locks the toggle', declared.json().locked, true);
check('declared account sees only confirmed employers', (await boardTitles(auth)).titles, sponsorOnlyTitles);
check(
  'the filter survives sponsor_only=false in the query string',
  (await boardTitles(auth, '&sponsor_only=false')).titles,
  sponsorOnlyTitles,
);

// 4. The declaration is permanent.
const changed = await app.inject({
  method: 'POST', url: '/onboarding/sponsorship', headers: auth, payload: { answer: 'no' },
});
check('changing the answer is refused', changed.statusCode, 409);
check('...and the board stays filtered', (await boardTitles(auth)).titles, sponsorOnlyTitles);
const repeated = await app.inject({
  method: 'POST', url: '/onboarding/sponsorship', headers: auth, payload: { answer: 'needs_future' },
});
check('repeating the same answer is not an error', repeated.statusCode, 200);

// 5. The settings toggle cannot turn it off for someone who declared.
const off = await app.inject({ method: 'PUT', url: '/sponsorship/filter', headers: auth, payload: { enabled: false } });
check('turning the filter off is refused', off.statusCode, 409);
check('...and the board is unchanged', (await boardTitles(auth)).titles, sponsorOnlyTitles);

// 6. A detail page cannot be reached by id either.
const hidden = await db
  .select({ id: monitored_jobs.id })
  .from(monitored_jobs)
  .where(and(eq(monitored_jobs.source_id, sponsoring.id), eq(monitored_jobs.sponsorship_status, 'refuses')))
  .limit(1);
const byId = await app.inject({ method: 'GET', url: `/jobs/${hidden[0].id}`, headers: auth });
check('a refused posting 404s by id for a declared account', byId.statusCode, 404);
const byIdAnon = await app.inject({ method: 'GET', url: `/jobs/${hidden[0].id}` });
check('...and is still readable signed out', byIdAnon.statusCode, 200);

// 7. Someone who did NOT declare can switch it on and off freely.
const [second] = await db.insert(users).values({ email: 'qa-sponsor-2@litos.test' }).returning({ id: users.id });
const secondToken = await new SignJWT({ userId: second.id, email: 'qa-sponsor-2@litos.test' })
  .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(secret);
const secondAuth = { authorization: `Bearer ${secondToken}` };
const on = await app.inject({ method: 'PUT', url: '/sponsorship/filter', headers: secondAuth, payload: { enabled: true } });
check('an undeclared account may turn the filter on', on.json().sponsor_only_board, true);
check('...and their board filters', (await boardTitles(secondAuth)).titles, sponsorOnlyTitles);
const backOff = await app.inject({ method: 'PUT', url: '/sponsorship/filter', headers: secondAuth, payload: { enabled: false } });
check('...and may turn it back off', backOff.json().sponsor_only_board, false);
check('...restoring the whole board', (await boardTitles(secondAuth)).titles, everything);

await app.close();
await cleanup();
await db.delete(sponsor_employers).where(eq(sponsor_employers.normalized_name, 'QA SPONSORING EMPLOYER'));

console.log(failures === 0 ? '\nAll sponsor-board checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
