/* A SECOND OPINION ON EVERY POSTING ON THE BOARD.
 *
 * Re-fetches every enabled source, re-normalizes through the SAME code the poller runs, and then
 * asks two independent questions of the result:
 *
 *   1. AGREEMENT - does what the classifier computes now match what the database is serving?
 *      A disagreement means the board is showing a stale answer.
 *   2. SUSPICION - for every posting the classifier typed Internship, is there title evidence or
 *      description evidence for it? And for every posting it left untyped, does the text carry an
 *      internship signal the pattern does not know about yet?
 *
 * The second question is the one that matters, because it is not the classifier grading its own
 * homework: it re-derives the evidence separately and prints anything a human should read.
 */
import { config } from 'dotenv';
import { existsSync } from 'node:fs';

/* .env.local FIRST, and refuse to run without it. `import 'dotenv/config'` reads .env, whose
   DATABASE_URL is LOCALHOST - and a gate pointed at localhost is worse than no gate: every
   posting is missing from the local table, so nothing can disagree, and it prints OK having
   compared against nothing. The same trap is documented at the top of seed-job-sources.mts,
   which is where this loader is copied from. */
const args = process.argv.slice(2);
const envFlag = args.indexOf('--env');
const envFile = envFlag >= 0 ? args[envFlag + 1]! : '.env.local';
if (!existsSync(envFile)) {
  console.error(`No ${envFile}. Production credentials live in .env.local; .env is localhost.`);
  process.exit(1);
}
config({ path: envFile });
if (!process.env.DATABASE_URL) {
  console.error(`${envFile} has no DATABASE_URL.`);
  process.exit(1);
}
if (/@(localhost|127\.0\.0\.1)/.test(process.env.DATABASE_URL)) {
  console.error('DATABASE_URL points at localhost. This gate is only meaningful against the '
    + 'database the board is served from.');
  process.exit(1);
}

const { eq } = await import('drizzle-orm');
const { db } = await import('../src/db/index');
const { career_page_sources, monitored_jobs } = await import('../src/db/schema');
const { fetchSourceJobs, isIngestablePosting } = await import('../src/lib/jobMonitor');

type Row = { company: string; title: string; computed?: string; description: string };

/* Employers whose internships are classified from the DESCRIPTION rather than the title, each one
   hand-read. New names appearing here are the signal worth acting on: either the rule widened by
   accident, or a real employer started writing postings this way and should be checked and added. */
const EXPECTED_DESCRIPTION_CLASSIFIED = new Set(['Jane Street', 'AQR', 'Mozilla', 'Palantir', 'SpaceX']);

const INTERN_TITLE =
  /\b(intern|interns|internship|internships)\b|\bco-?op\b|\bsummer\s+(analyst|associate)s?\b|\bestágios?\b|\bestagiári[oa]s?\b|\bstagiaires?\b|\bstagiair\b|\bpraktikums?\b|\bpraktikant(?:in)?\b|\bwerkstudent(?:in)?\b|\bbecari[oa]s?\b|\bpasantías?\b|\bprácticas\b|\btirocini[oa]\b/i;

/* WIDE ON PURPOSE, and much wider than the classifier. This is the recall net: anything it catches
   that the classifier did not is a candidate the pattern may be missing, printed for a human to
   read rather than acted on. Precision is deliberately not a goal here. */
const ANY_INTERN_SIGNAL =
  /\bintern(ship)?s?\b|\bco-?op\b|\bestági|\bstagiair|\bpraktik|\bwerkstudent|\bbecari|\bpasant|\btirocini|\bsummer\s+(analyst|associate|program)\b|\brising\s+(junior|senior)\b|\bcurrently enrolled\b/i;

async function main() {
  const sources = await db.select().from(career_page_sources).where(eq(career_page_sources.enabled, true));
  console.log(`auditing ${sources.length} enabled sources\n`);

  const stored = new Map<string, string | null>();
  for (const row of await db.select({
    id: monitored_jobs.external_id,
    src: monitored_jobs.source_id,
    type: monitored_jobs.employment_type,
    active: monitored_jobs.is_active,
  }).from(monitored_jobs)) {
    if (row.active) stored.set(`${row.src}:${row.id}`, row.type);
  }

  const disagree: (Row & { storedType: string | null })[] = [];
  const typedNoEvidence: Row[] = [];
  const untypedWithSignal: Row[] = [];
  let checked = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const source of sources) {
    let jobs;
    try {
      jobs = await fetchSourceJobs(source);
    } catch (error) {
      failed += 1;
      failures.push(`${source.company_name}: ${(error as Error)?.message ?? 'threw'}`);
      continue;
    }
    if (!jobs) { failed += 1; failures.push(`${source.company_name}: no payload`); continue; }
    for (const job of jobs.filter(isIngestablePosting)) {
      checked += 1;
      const row: Row = {
        company: source.company_name,
        title: job.title,
        computed: job.employment_type,
        description: job.description ?? '',
      };
      const key = `${source.id}:${job.external_id}`;
      if (stored.has(key)) {
        const storedType = stored.get(key) ?? null;
        if ((storedType ?? undefined) !== job.employment_type) disagree.push({ ...row, storedType });
      }
      const titleSays = INTERN_TITLE.test(job.title);
      if (job.employment_type === 'Internship' && !titleSays) typedNoEvidence.push(row);
      if (!job.employment_type && ANY_INTERN_SIGNAL.test(`${job.title} ${row.description}`)) {
        untypedWithSignal.push(row);
      }
    }
  }

  console.log(`checked ${checked} postings across ${sources.length - failed} reachable sources `
    + `(${failed} unreachable)\n`);

  console.log(`=== 1. DISAGREEMENTS with what the board is serving: ${disagree.length} ===`);
  for (const r of disagree.slice(0, 40)) {
    console.log(`  stored=${String(r.storedType)} computed=${String(r.computed)}  ${r.title.slice(0, 58)} (${r.company})`);
  }

  console.log(`\n=== 2. TYPED Internship with NO title evidence: ${typedNoEvidence.length} ===`);
  console.log('    (each must be justified by the description - read every one)');
  const byCompany = new Map<string, number>();
  for (const r of typedNoEvidence) byCompany.set(r.company, (byCompany.get(r.company) ?? 0) + 1);
  for (const [company, n] of [...byCompany].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${company}`);
  }

  console.log(`\n=== 3. UNTYPED but carrying some internship signal: ${untypedWithSignal.length} ===`);
  console.log('    (the recall net - candidates the pattern may be missing)');
  const counts = new Map<string, number>();
  for (const r of untypedWithSignal) {
    const m = r.title.match(ANY_INTERN_SIGNAL);
    counts.set(m ? `TITLE:${m[0].toLowerCase()}` : 'body-only', (counts.get(m ? `TITLE:${m[0].toLowerCase()}` : 'body-only') ?? 0) + 1);
  }
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${k}`);
  console.log('\n    title-signal examples (these would be real misses):');
  for (const r of untypedWithSignal.filter((r) => ANY_INTERN_SIGNAL.test(r.title)).slice(0, 30)) {
    console.log(`      ${r.title.slice(0, 62).padEnd(62)} (${r.company})`);
  }
  /* A GATE, not a report. Exits non-zero so it can block a deploy, and the two conditions are the
     two that mean the board is lying: it is serving a type the classifier no longer computes, or
     it typed something Internship that neither the title, the employer, nor the description
     supports. The recall net is printed but never fails the run - a candidate the pattern misses
     is a thing to read, not a broken board. */
  const unexplained = typedNoEvidence.filter((r) => !EXPECTED_DESCRIPTION_CLASSIFIED.has(r.company));
  /* REACHABILITY IS PART OF THE GATE, or the gate passes hardest exactly when it is least
     entitled to. With every board timing out, checked is 0, nothing can disagree, nothing is
     unexplained, and the old version printed OK. A tenth of the catalog failing is already a
     result nobody should call a pass. */
  const tooManyFailed = failed > sources.length / 10;
  const nothingChecked = checked === 0;
  const broken = disagree.length > 0 || unexplained.length > 0 || tooManyFailed || nothingChecked;
  if (failures.length) {
    console.log(`\n!! ${failed} of ${sources.length} sources did not answer:`);
    for (const f of failures.slice(0, 15)) console.log(`     ${f}`);
    if (tooManyFailed) console.log('   more than a tenth of the catalog - the run is not a pass');
  }
  if (unexplained.length) {
    console.log(`\n!! ${unexplained.length} postings typed Internship from an employer not on the `
      + 'reviewed list. Read each one, then add the employer here or fix the rule:');
    for (const r of unexplained.slice(0, 20)) console.log(`     ${r.title.slice(0, 60)} (${r.company})`);
  }
  console.log(broken
    ? '\nFAILED'
    : `\nOK: all ${checked} postings on the board classify the way the code says they should.`);
  /* exitCode rather than process.exit: the report above is the whole product of this script, and
     process.exit truncates buffered stdout when it is a pipe, which is exactly how it is read in
     CI. Letting the loop drain also closes the pool. */
  process.exitCode = broken ? 1 : 0;
}

main().catch((error) => {
  console.error('verify:classification failed to run:', error);
  process.exitCode = 1;
});
