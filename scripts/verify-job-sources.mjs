#!/usr/bin/env node
/**
 * IS EVERY BOARD ON THE LIST ACTUALLY THE COMPANY WE CALL IT?
 *
 *   npm run sources:verify              # every source in src/lib/jobSources.ts
 *   npm run sources:verify -- --only stripe,notion   # just these tokens
 *   npm run sources:verify -- --json    # machine-readable
 *
 * THE ROOT CAUSE THIS EXISTS TO CLOSE.
 *
 * A source is three hand-written strings: a display name, an ATS, and a board token. The only gate
 * that ever ran on a new one was `seed-job-sources.mts --check`, which asks "does this token return
 * postings?" - a question every wrong token answers yes to. So a typo, a guess, or a plausible
 * abbreviation became a company on the board, under a name that was not theirs, and stayed there:
 *
 *   sas    -> Superior Alarm Systems, a security-systems integrator, not SAS Institute
 *   bcg    -> Bohen Consulting Group, not Boston Consulting Group
 *   tcs    -> Thornbury Community Services, UK care work, not Tata Consultancy
 *   disney -> a board named "Sgt. Pepper's Lonely Hearts Club Band" with two test postings
 *   latch  -> LatchBio, not Latch Systems
 *   crisp  -> the Dutch grocer, not the US company of the same name
 *
 * Every one of those was found by hand, weeks apart, by somebody chasing a different bug. This
 * asks the question the old check never did, on every source, in CI.
 *
 * HOW IDENTITY IS ESTABLISHED, in the order the boards make it available:
 *   1. Greenhouse publishes `company_name` on every posting. That is the employer naming itself,
 *      and it is decisive - 163 of the current sources get this.
 *   2. Lever and Ashby publish no company name at all, so the postings' own prose is read instead:
 *      the brand as a whole word, or the company's domain on an off-ATS link.
 *   3. Neither -> `cannot-tell`, which is NOT a pass. It is a board somebody has to open.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? new Set(args[onlyIndex + 1].split(',')) : null;

const { JOB_SOURCES } = await import('../src/lib/jobSources.ts');
const { fetchSourceJobs } = await import('../src/lib/jobMonitor.ts');
const { identityCheck, portalNameAgrees } = await import('../src/lib/sponsorIdentity.ts');
const { pollSourcesWithinBudget } = await import('../src/lib/jobPollScheduler.ts');

/* Boards where no name is published and the postings name a BRAND rather than the company, checked
   by hand. The evidence is here so the judgement can be re-checked or overturned, and so a run that
   finds nothing new stays quiet enough to be worth reading. */
const CLEARED_BY_HAND = {
  'Match Group': 'Lever publishes no company name. The postings are for Hinge ("the dating app '
    + 'designed to be deleted") and Azar, both Match Group brands, and every apply link is on '
    + 'jobs.lever.co/matchgroup. Checked 2026-07-29.',
};

/**
 * One verdict per source.
 *
 * `named-mismatch` is the failure this file exists for, and it is the only one that can be stated
 * with certainty: the employer published a name and it is not ours.
 */
async function verify(source) {
  let jobs;
  try {
    jobs = await fetchSourceJobs(source);
  } catch (error) {
    return { verdict: 'dead', detail: error instanceof Error ? error.message : String(error) };
  }
  if (jobs.length === 0) return { verdict: 'empty', detail: 'the board returned no postings' };

  const portalName = jobs.map((job) => job.portal_company_name).find(Boolean) ?? null;
  const agrees = portalNameAgrees(source.company_name, portalName);
  if (agrees === true) return { verdict: 'named-ok', detail: portalName };
  if (agrees === false) return { verdict: 'named-mismatch', detail: portalName };

  /* No published name (Lever, Ashby). Fall back to what the postings say about themselves - the
     same check that caught `latch` and `crisp`, neither of which publishes a name. */
  const evidence = identityCheck(source.company_name, { legal_names: [] }, {
    displayName: null,
    count: jobs.length,
    locations: jobs.map((job) => job.location ?? ''),
    samples: jobs.slice(0, 3).map((job) => ({
      title: job.title,
      location: job.location,
      url: job.posting_url,
      text: job.description,
    })),
  });
  if (evidence.brandInText || evidence.domainMatch) {
    return { verdict: 'prose-ok', detail: evidence.domainMatch ? 'own domain on the apply link' : 'named in the posting' };
  }
  if (CLEARED_BY_HAND[source.company_name]) {
    return { verdict: 'cleared-by-hand', detail: CLEARED_BY_HAND[source.company_name] };
  }
  return {
    verdict: 'cannot-tell',
    detail: `${jobs.length} postings, none naming us: ${jobs[0].title} @ ${jobs[0].location ?? '?'}`,
  };
}

const selected = JOB_SOURCES.filter((source) => !only || only.has(source.board_token));
const results = [];
async function record(source) {
  const outcome = await verify(source);
  results.push({ ...source, ...outcome });
  process.stderr.write(outcome.verdict === 'named-mismatch' ? 'X' : outcome.verdict.endsWith('ok') ? '.' : '?');
}

/* Use the same tested queue as production so provider pacing cannot drift between ingestion and
   its CI gate. The verifier has no serverless deadline, so every selected source is attempted. */
await pollSourcesWithinBudget(selected, record, {
  concurrency: 6,
  timeBudgetMs: Number.MAX_SAFE_INTEGER,
  startReserveMs: 0,
});
process.stderr.write('\n');

results.sort((a, b) => a.company_name.localeCompare(b.company_name));
const bucket = (name) => results.filter((row) => row.verdict === name);

for (const row of bucket('named-mismatch')) {
  console.log(`MISLABELLED  ${row.company_name}  (${row.ats_name}/${row.board_token})`);
  console.log(`             the portal says: ${JSON.stringify(row.detail)}`);
}
for (const name of ['cannot-tell', 'empty', 'dead']) {
  for (const row of bucket(name)) {
    console.log(`${name.toUpperCase().padEnd(12)} ${row.company_name}  (${row.ats_name}/${row.board_token})`);
    console.log(`             ${row.detail}`);
  }
}

if (asJson) {
  const path = join(HERE, '..', 'source-verification.json');
  writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\nWrote ${path}`);
}

const counts = ['named-ok', 'prose-ok', 'cleared-by-hand', 'named-mismatch', 'cannot-tell', 'empty', 'dead']
  .map((name) => `${bucket(name).length} ${name}`);
console.log(`\n${results.length} sources: ${counts.join(', ')}.`);

/* A mismatch fails the build. So does a dead board, which was already true of the old check.
   `cannot-tell` and `empty` do NOT fail: Lever and Ashby publish no name, and a board that says
   nothing about itself in three postings is common and is not evidence of anything wrong. They are
   printed so a human can work through them, which is what the sponsor-match audit is for. */
process.exit(bucket('named-mismatch').length + bucket('dead').length > 0 ? 1 : 0);
