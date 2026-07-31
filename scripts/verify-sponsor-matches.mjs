#!/usr/bin/env node
/**
 * OPEN A REAL JOB POSTING AND CHECK WE HAVE THE RIGHT COMPANY.
 *
 *   npm run sponsors:verify              # every confirmed employer
 *   npm run sponsors:verify -- --all     # include the unconfirmed ones
 *   npm run sponsors:verify -- --json    # machine-readable, for diffing between runs
 *
 * WHY THIS READS THE POSTING RATHER THAN THE LABEL.
 *
 * The ingest matches a brand on our board to a legal entity in a federal filing. Every input to
 * that match is a NAME, and names lie in both directions:
 *
 *   - the Greenhouse token `sas` is Superior Alarm Systems, not SAS Institute
 *   - `bcg` is Bohen Consulting Group, not Boston Consulting Group
 *   - `tcs` is Thornbury Community Services, a UK care provider, not Tata Consultancy
 *   - `latch` on Lever is LatchBio, not the smart-lock company
 *   - `crisp` on Ashby is a Dutch grocer whose postings are all in Amsterdam
 *   - and in the other direction, `purestorage` DISPLAYS the stale name "Everpure" while its
 *     postings are unmistakably Pure Storage's
 *
 * A display name is not evidence and a token is not a company. The posting is: it says who wrote
 * it, in prose, with the company's own domain in its links. An earlier version of this file
 * compared only the Greenhouse display name and had NO OPINION on the 46 employers whose boards
 * are on Lever or Ashby, which publish no company name at all. That is the gap this closes.
 *
 * WHAT IT PROVES AND WHAT IT DOES NOT. A hit proves the board we poll belongs to the company we
 * named. It does not prove that company filed the petition - that is the alias list's job.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const includeUnconfirmed = args.includes('--all');
const asJson = args.includes('--json');

const { H1B_SPONSOR_FILE } = await import('../src/data/h1bSponsors.ts');
const { JOB_SOURCES } = await import('../src/lib/jobSources.ts');
/* The judgement lives in src/lib/sponsorIdentity.ts, typechecked and unit-tested against the real
   text of the boards that fooled the first version of this audit. This file is only the I/O. */
const { identityCheck, verdictFor } = await import('../src/lib/sponsorIdentity.ts');

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * Real postings from this employer's board, with their prose.
 *
 * Every branch asks for the DESCRIPTION, not just the title: a job title is the one part of a
 * posting that never says who wrote it. Three postings rather than one, because a single posting
 * can be a contractor's or a subsidiary's while the company's own name shows up across the set.
 */
async function fetchIdentity(source) {
  if (source.ats_name === 'greenhouse') {
    const [board, jobs] = await Promise.all([
      json(`https://boards-api.greenhouse.io/v1/boards/${source.board_token}`).catch(() => null),
      json(`https://boards-api.greenhouse.io/v1/boards/${source.board_token}/jobs?content=true`),
    ]);
    const list = jobs.jobs ?? [];
    return {
      displayName: board?.name ?? null,
      count: list.length,
      /* EVERY location, not just the sampled postings'. One short string each, and sampling three
         of four hundred wrongly reported Cloudflare and Twilio as hiring nobody in the US. */
      locations: list.map((job) => job.location?.name ?? '').filter(Boolean),
      samples: list.slice(0, 3).map((job) => ({
        title: job.title,
        location: job.location?.name ?? null,
        url: job.absolute_url ?? null,
        text: String(job.content ?? '').replace(/<[^>]+>/g, ' '),
      })),
    };
  }
  if (source.ats_name === 'lever') {
    const list = await json(`https://api.lever.co/v0/postings/${source.board_token}?mode=json`);
    return {
      displayName: null,
      count: list.length,
      locations: list.map((job) => job.categories?.location ?? '').filter(Boolean),
      samples: list.slice(0, 3).map((job) => ({
        title: job.text,
        location: job.categories?.location ?? null,
        url: job.hostedUrl ?? job.applyUrl ?? null,
        text: `${job.descriptionPlain ?? ''} ${job.additionalPlain ?? ''}`,
      })),
    };
  }
  if (source.ats_name === 'workable') {
    const body = await json(`https://www.workable.com/api/accounts/${source.board_token}?details=true`);
    const list = body.jobs ?? [];
    return {
      displayName: body.name ?? null,
      count: list.length,
      locations: list.map((job) => [job.city, job.state, job.country].filter(Boolean).join(', ')),
      samples: list.slice(0, 3).map((job) => ({
        title: job.title,
        location: [job.city, job.state, job.country].filter(Boolean).join(', ') || null,
        url: job.application_url ?? job.url ?? job.shortlink ?? null,
        text: String(job.description ?? '').replace(/<[^>]+>/g, ' '),
      })),
    };
  }
  const body = await json(`https://api.ashbyhq.com/posting-api/job-board/${source.board_token}`);
  const list = body.jobs ?? [];
  return {
    displayName: null,
    count: list.length,
    locations: list.map((job) => job.location ?? '').filter(Boolean),
    samples: list.slice(0, 3).map((job) => ({
      title: job.title,
      location: job.location ?? null,
      url: job.jobUrl ?? job.applyUrl ?? null,
      text: String(job.descriptionPlain ?? job.descriptionHtml ?? '').replace(/<[^>]+>/g, ' '),
    })),
  };
}

/* Employers a human opened, read, and cleared, with WHAT THEY READ.
 *
 * The automated checks cannot corroborate every match: an alias is only ever confirmed by the
 * filing entity's own words, the company's domain, a d/b/a, or a shared filing city, and a dozen
 * real companies offer none of those. Each of these was settled by opening the board and reading
 * what the employer says about itself, on 2026-07-29. The quote is here so the next person can
 * check the judgement rather than repeat the work - or overturn it. */
const CLEARED_BY_HAND = {
  Abridge: 'board: "ABOUT ABRIDGE ... powering deeper understanding in healthcare"; ABRIDGE AI INC filed from Pittsburgh and Philadelphia, PA, where Abridge is based',
  anomalo: 'board: "Anomalo is the AI-powered data quality platform"; Anomalo, Inc. filed from Palo Alto, CA',
  Blend: 'board: "Blend ... our cloud banking platform"; blend.com/terms-of-use names Blend Labs, and BLEND LABS INC filed from San Francisco and Novato, CA',
  cleo: 'the Greenhouse board is titled "Cleo (US)"; CLEO AI INC filed from New York, which is Cleo the money app\'s US entity',
  Fireworks: 'board: "Fireworks is the platform for specialized intelligence"; Fireworks.ai, Inc. filed from Redwood City, CA, and the board posts in San Mateo',
  fullstory: 'board: "Fullstory is a remote first company"; FULLSTORY INC filed from Atlanta, GA, where Fullstory is headquartered',
  'Marshall Wace': 'board: "Marshall Wace is a leading global alternatives investment manager"; MARSHALL WACE NORTH AMERICA LP is its US arm, filed from New York',
  N26: 'board titled "N26", postings for the French MLRO function; N26 INC filed from New York. NOTE: N26 closed its US business, so its US filings are historical - it stays confirmed but its board carries no US roles, which the job_country rule now handles',
  Netlify: 'board: "Netlify\'s self-serve funnel"; NETLIFY INC filed from San Francisco',
  phonepe: 'the posting itself says "About PhonePe Limited: Headquartered in India", which is the matched entity verbatim',
  science37: 'board: "Science 37\'s mission is to accelerate clinical research"; SCIENCE 37 INC filed from Culver City and Los Angeles, CA',
  tebra: 'the posting lists tebra.com, patientpop.com and kareo.com as its own domains; TEBRA TECHNOLOGIES INC is the Kareo/PatientPop merger, filed from Corona del Mar, CA',
};

const byCompany = new Map(JOB_SOURCES.map((source) => [source.company_name, source]));
const queue = H1B_SPONSOR_FILE.employers.filter((employer) => includeUnconfirmed || employer.sponsors);
const results = [];

for (const employer of queue) {
  const source = byCompany.get(employer.company);
  if (!source) continue;
  let identity = null;
  let error = null;
  try {
    identity = await fetchIdentity(source);
  } catch (reason) {
    error = reason instanceof Error ? reason.message : String(reason);
  }
  const check = identity ? identityCheck(employer.company, employer, identity) : null;
  const verdict = verdictFor(identity, check, error);
  results.push({ company: employer.company, source, employer, identity, check, verdict, error });
  process.stderr.write(verdict === 'verified' ? '.' : verdict === 'SUSPECT' ? 'X' : '?');
  await new Promise((resolve) => setTimeout(resolve, 100));
}
process.stderr.write('\n');

if (asJson) {
  const path = join(HERE, '..', 'sponsor-verification.json');
  writeFileSync(path, `${JSON.stringify(results.map((row) => ({
    company: row.company,
    verdict: row.verdict,
    evidence: row.check,
    display_name: row.identity?.displayName ?? null,
    postings: row.identity?.count ?? 0,
    sample: row.identity?.samples?.[0]
      ? `${row.identity.samples[0].title} @ ${row.identity.samples[0].location}`
      : null,
    legal_names: row.employer.legal_names,
    evidence_source: row.employer.evidence,
  })), null, 2)}\n`);
  console.log(`Wrote ${path}`);
}

/* A hand-cleared employer is reported separately rather than silently promoted: the reader should
   see that a human, not the checker, is what stands behind it. */
for (const row of results) {
  if (row.verdict !== 'verified' && CLEARED_BY_HAND[row.company]) row.verdict = 'cleared-by-hand';
}

const bucket = (name) => results.filter((row) => row.verdict === name);
if (bucket('cleared-by-hand').length) {
  console.log(`\nCleared by hand (the checker had no corroboration; a person read the board):`);
  for (const row of bucket('cleared-by-hand')) {
    console.log(`  ${row.company}: ${CLEARED_BY_HAND[row.company]}`);
  }
}
for (const row of [...bucket('SUSPECT'), ...bucket('REVIEW'), ...bucket('weak'), ...bucket('empty-board'), ...bucket('error')]) {
  console.log(`\n${row.verdict.toUpperCase()}  ${row.company}  (${row.source.ats_name}:${row.source.board_token})`);
  console.log(`   matched   : ${row.employer.legal_names.join(' | ') || '(none)'}  [${row.employer.evidence}]`);
  if (row.error) console.log(`   error     : ${row.error}`);
  if (row.identity) {
    console.log(`   board name: ${row.identity.displayName ?? '(none published)'}   postings: ${row.identity.count}`);
    console.log(`   evidence  : brand=${row.check?.brandInText} legal=${row.check?.legalHit ?? '-'} domain=${row.check?.domainMatch} us=${row.check?.usPresence} geo=${row.check?.geoOverlap ?? '-'} kind=${row.check?.matchKind}`);
    console.log(`   filed from: ${(row.employer.filing_cities ?? []).slice(0, 4).join(', ') || '(no city)'}  [${(row.employer.filing_states ?? []).join(' ')}]`);
    console.log(`   locations : ${[...new Set(row.identity.locations)].slice(0, 5).join(' / ')}`);
    for (const sample of row.identity.samples.slice(0, 2)) {
      console.log(`   posting   : ${sample.title} @ ${sample.location ?? '?'}`);
      console.log(`               ${sample.text.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
    }
  }
}

const counts = ['verified', 'cleared-by-hand', 'REVIEW', 'weak', 'SUSPECT', 'empty-board', 'error']
  .map((name) => `${bucket(name).length} ${name}`);
console.log(`\n${results.length} employers checked: ${counts.join(', ')}.`);
console.log("verified = the employer's own posting names the company or the filing entity we matched.");
process.exit(
  bucket('SUSPECT').length + bucket('REVIEW').length + bucket('weak').length
    + bucket('empty-board').length + bucket('error').length > 0 ? 1 : 0,
);
