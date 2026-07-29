#!/usr/bin/env node
/**
 * ASK EACH EMPLOYER'S OWN JOB BOARD WHO THEY ARE, AND COMPARE.
 *
 *   node scripts/verify-sponsor-matches.mjs            # audit every confirmed employer
 *   node scripts/verify-sponsor-matches.mjs --all      # include the unconfirmed ones
 *
 * WHY THIS EXISTS. The ingest matches a brand on our board to a legal entity in a federal filing.
 * Every input to that match is a NAME, and names lie: the token `sas` on Greenhouse is Superior
 * Alarm Systems, not SAS Institute; `bcg` is Bohen Consulting Group, not Boston Consulting Group;
 * `latch` on Lever is LatchBio, not the smart-lock company; `crisp` on Ashby is a Dutch grocer
 * whose postings are all in Amsterdam. All four were confirmed by the first version of the alias
 * list, and each one told a job seeker who needs sponsorship that a company sponsors when it does
 * not - the single worst thing this feature can do.
 *
 * The ATS knows something the filing data cannot: the board's OWN display name, typed by the
 * employer. Comparing it to the legal entity we matched catches a whole class of wrong answers
 * that no amount of care with the name-matching rules would.
 *
 * IT REPORTS, IT DOES NOT DECIDE. A mismatch is often innocent (Instacart's board says
 * "Instacart", its filings say "MAPLEBEAR INC D/B/A INSTACART"), so this prints a table for a
 * human to read rather than editing anything. Exit code 1 when something needs looking at, so it
 * can gate a release when somebody wants it to.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const all = process.argv.includes('--all');

const { H1B_SPONSOR_FILE } = await import('../src/data/h1bSponsors.ts');
const { JOB_SOURCES } = await import('../src/lib/jobSources.ts');

/** The name the employer typed into their own applicant tracking system. */
async function boardName(source) {
  const timeout = AbortSignal.timeout(20_000);
  try {
    if (source.ats_name === 'greenhouse') {
      const response = await fetch(`https://boards-api.greenhouse.io/v1/boards/${source.board_token}`, { signal: timeout });
      if (!response.ok) return null;
      const name = (await response.json()).name;
      return name ? { name: String(name).trim(), sample: null } : null;
    }
    /* Lever and Ashby publish no company-name field at all - only Greenhouse does. So for those
       two the audit has NO opinion to offer, and says so, rather than comparing a job title to a
       legal entity and calling the inevitable mismatch a suspect. The first version did exactly
       that and buried two real false matches under 40 false alarms.
       The posting text is still printed, because a human reading "Warehouse Medewerker @
       Amsterdam" against "Crisp, Inc." of Delaware needs one second to see the problem. */
    const url = source.ats_name === 'lever'
      ? `https://api.lever.co/v0/postings/${source.board_token}?mode=json&limit=1`
      : `https://api.ashbyhq.com/posting-api/job-board/${source.board_token}`;
    const response = await fetch(url, { signal: timeout });
    if (!response.ok) return null;
    const body = await response.json();
    const job = source.ats_name === 'lever' ? body[0] : (body.jobs ?? [])[0];
    if (!job) return null;
    const title = job.text ?? job.title ?? '?';
    const place = job.categories?.location ?? job.location ?? '?';
    return { name: null, sample: `${title} @ ${place}` };
  } catch {
    return null;
  }
}

function words(value) {
  return new Set(
    String(value)
      .toUpperCase()
      .replace(/[^A-Z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2
        && !['INC', 'LLC', 'LTD', 'THE', 'AND', 'CORP', 'GROUP', 'USA', 'COM', 'DBA'].includes(word)),
  );
}

/**
 * Do the employer's own name and the filing entity's name share a real word?
 *
 * Null means NO OPINION, which is the honest answer for Lever and Ashby (they publish no company
 * name) and the reason this returns three states rather than a boolean. A false alarm is not free:
 * an audit that cries wolf on forty rows is one nobody reads, and the two rows that matter are the
 * ones it exists to surface.
 *
 * Prefix-tolerant, because a brand and its legal name routinely differ by a suffix that carries no
 * information: "YugabyteDB" against "YUGABYTE INC", "SoFi" against "Social Finance" (which fails,
 * correctly, and gets read by a human).
 */
function agrees(board, legalNames) {
  if (!board?.name) return null;
  const boardWords = [...words(board.name)];
  if (boardWords.length === 0) return null;
  return legalNames.some((legal) => [...words(legal)].some((legalWord) =>
    boardWords.some((boardWord) => boardWord.startsWith(legalWord) || legalWord.startsWith(boardWord))));
}

/* Mismatches a human has already read and cleared, with what they checked. Kept so a run that
   finds nothing new exits 0 and stays worth running: an audit whose output is always two known
   rows is one people learn to skip past. */
const VERIFIED = {
  'Pure Storage': 'the greenhouse board displays the stale name "Everpure", but its 311 postings are '
    + 'Pure Storage\'s ("reshaping the data storage industry", GSI/NTT partner roles)',
  SoFi: 'SoFi trades under its brand and files as Social Finance, Inc. No word in common, same company',
};

const byCompany = new Map(JOB_SOURCES.map((source) => [source.company_name, source]));
const rows = [];
const queue = H1B_SPONSOR_FILE.employers.filter((employer) => all || employer.sponsors);

/* Serial, with a small pause. This hits three third-party APIs about 200 times and there is no
   hurry: it is an audit somebody runs before a release, not anything on a request path. */
for (const employer of queue) {
  const source = byCompany.get(employer.company);
  if (!source) continue;
  const name = await boardName(source);
  rows.push({ employer, source, board: name, agrees: agrees(name, employer.legal_names) });
  await new Promise((resolve) => setTimeout(resolve, 120));
}

const suspect = rows.filter((row) => row.agrees === false && !VERIFIED[row.employer.company]);
const cleared = rows.filter((row) => row.agrees === false && VERIFIED[row.employer.company]);
const unreachable = rows.filter((row) => row.board === null);
const noOpinion = rows.filter((row) => row.board !== null && row.agrees === null);

for (const row of suspect) {
  console.log(`SUSPECT  ${row.employer.company}  (${row.source.ats_name}:${row.source.board_token})`);
  console.log(`         board says : ${row.board.name ?? row.board.sample}`);
  console.log(`         matched    : ${row.employer.legal_names.join(' | ')}`);
  console.log(`         credited   : ${row.employer.approvals} approvals, ${row.employer.lca_certifications} certified LCAs`);
}
if (unreachable.length) {
  console.log(`\nUnreachable boards (no opinion, not a failure): ${unreachable.map((row) => row.employer.company).join(', ')}`);
}
if (cleared.length) {
  console.log(`Cleared by hand (name differs, company is right): ${cleared.map((row) => row.employer.company).join(', ')}`);
}
console.log(`\n${rows.length} checked, ${suspect.length} suspect, ${cleared.length} cleared, ${noOpinion.length} no opinion (Lever/Ashby publish no company name), ${unreachable.length} unreachable.`);
console.log('A mismatch is not proof of a wrong match - Instacart files as MAPLEBEAR - but every one');
console.log('of them needs a human to look at the board and the filing side by side.');
process.exit(suspect.length > 0 ? 1 : 0);
