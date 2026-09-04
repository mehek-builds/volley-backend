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
 *
 * WHAT IS RED AND WHAT IS ONLY REPORTED.
 *
 * Two unrelated things can go wrong here: a board can belong to a company that is not the one we
 * filed it under (ours), or a board can have no postings this week and a token that stopped
 * resolving (theirs). They shared an exit code until 2026-09-03, and the cost was that the check
 * spent whole days red over one third-party 404 while sitting green through a run where 196
 * Greenhouse boards, Airbnb among them, returned nothing at all.
 *
 * `named-mismatch` decides the exit code now, plus a source THIS change added whose board does not
 * resolve, plus any bucket so far over its ceiling that the run is a non-result rather than a
 * verdict. Everything else prints and annotates. The reasoning, the measurements behind the
 * ceilings, and the rule itself live in src/lib/sourceIdentityVerdict.ts.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
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
const { pollSourcesWithinBudget, retryTransient } = await import('../src/lib/jobPollScheduler.ts');
const { judgeSourceIdentity } = await import('../src/lib/sourceIdentityVerdict.ts');

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
    /* Public ATS endpoints occasionally exceed their single-request timeout in GitHub Actions.
       Retry before reading anything into a failure; what the last one says is then classified. */
    jobs = await retryTransient(() => fetchSourceJobs(source));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    /* Only the board saying the token does not exist is fatal. A 5xx, a 429 or a timeout is the
       network having a bad minute, and failing the build on it means a red pull request that says
       nothing about the pull request. Those are reported as `unreachable` and looked at by hand. */
    const status = Number(/HTTP (\d{3})/.exec(detail)?.[1]);
    return { verdict: status === 404 || status === 410 ? 'dead' : 'unreachable', detail };
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

/**
 * WHICH SOURCES DID THIS CHANGE INTRODUCE?
 *
 * A board that has been on the list for weeks and starts returning 404 is the company moving. A
 * token that has never been polled by anything and does not resolve is a typo in a hand-written
 * string, and it is ours. Telling those apart needs the catalog as it stood before this change,
 * which is what SOURCE_IDENTITY_BASE_SHA points at (the workflow passes the pull request's base,
 * and checks out with fetch-depth 0 so the object is actually present).
 *
 * Membership is tested by asking whether the token STRING appears anywhere in the base catalog,
 * not by parsing it: the two files that hold sources use different shapes (tuples here, generated
 * JSON objects in the discovery file) and a parser for both is a second thing to keep correct.
 * The failure mode of the substring test is calling a new token old, which loses a check nobody
 * had before rather than inventing one.
 *
 * Returns null when the base cannot be read at all, which the report states outright. A missing
 * diff must never manufacture a failure.
 */
function addedSourceKeys() {
  const base = process.env.SOURCE_IDENTITY_BASE_SHA?.trim();
  if (!base) return null;
  const root = join(HERE, '..');
  try {
    const baseCatalog = ['src/lib/jobSources.ts', 'src/data/jobSources100k.ts']
      .map((file) => execFileSync('git', ['show', `${base}:${file}`], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        /* Capture git's stderr instead of letting it through, so a missing base object is reported
           once, by the message below, rather than twice in two different voices. */
        stdio: ['ignore', 'pipe', 'pipe'],
      }))
      .join('\n');
    return new Set(
      selected
        .filter((source) => !baseCatalog.includes(`'${source.board_token}'`)
          && !baseCatalog.includes(`"${source.board_token}"`))
        .map((source) => `${source.ats_name}/${source.board_token}`),
    );
  } catch (error) {
    console.log(`Could not read the catalog at ${base}, so newly added sources were not identified: `
      + `${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

results.sort((a, b) => a.company_name.localeCompare(b.company_name));
const judgement = judgeSourceIdentity(results, selected.length, addedSourceKeys());
const bucket = (name) => results.filter((row) => row.verdict === name);

for (const row of bucket('named-mismatch')) {
  console.log(`MISLABELLED  ${row.company_name}  (${row.ats_name}/${row.board_token})`);
  console.log(`             the portal says: ${JSON.stringify(row.detail)}`);
}
for (const name of ['cannot-tell', 'empty', 'unreachable', 'dead']) {
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

/* Annotations put the liveness list on the pull request itself rather than 1000 lines into a log,
   which is the whole reason it is safe for those verdicts to stop failing the build: they became
   more visible, not less. Only inside Actions, where the syntax means something. */
if (process.env.GITHUB_ACTIONS === 'true') {
  for (const annotation of judgement.annotations) console.log(annotation);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, judgement.stepSummary);
    } catch (error) {
      console.log(`Could not write the step summary: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

console.log(`\n${judgement.report.join('\n')}`);

if (judgement.failures.length > 0) {
  console.log('\nWHY THIS RUN IS RED:');
  for (const failure of judgement.failures) console.log(`  - ${failure}`);
}

process.exit(judgement.exitCode);
