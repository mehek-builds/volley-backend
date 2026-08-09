#!/usr/bin/env tsx
/* INSTRUMENTATION, not a code read: for every distinct work-eligibility label Litos has ever
 * stored, print which branch of workEligibilityAnswer it takes and what it returns, against the
 * real profile and against an empty one.
 *
 * The branch names below are the literal early-returns in workEligibilityAnswer, in order. If that
 * function is edited, this list has to be edited with it; it is a mirror, deliberately, so the
 * mirror going stale is visible as a wrong branch name next to a right verdict.
 *
 * Read-only. SELECT only.
 */
import fs from 'node:fs';
import pg from 'pg';
import { resolveKnownAnswer, isRefusedQuestion, type ApplicationProfileLike } from '../src/lib/questionDiscovery';

const envPath = '/Users/Mehek1/Documents/student-outreach-backend/.env.local';
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

// Copies of the module-private patterns, so the branch can be named without exporting them.
const WORK_ELIGIBILITY_QUESTION =
  /(?:eligible|eligibility)\s+(?:to\s+)?(?:legally\s+)?work|authori[sz](?:ed|ation)\s+to\s+work|legally\s+authori[sz]ed|right\s+to\s+work|work\s+authori[sz]|(?:requir\w*|need\w*|visa|immigration|without|employment)\s+(?:\w+\s+){0,3}sponsor|sponsor\w*\s+(?:\w+\s+){0,3}(?:requir\w*|need\w*)/i;
const WORK_AUTHORIZATION_QUESTION =
  /(?:eligible|eligibility)\s+(?:to\s+)?(?:legally\s+)?work|authori[sz](?:ed|ation)\s+to\s+work|legally\s+authori[sz]ed|right\s+to\s+work|work\s+authori[sz]/i;
const SPONSORSHIP_QUESTION =
  /(?:requir\w*|need\w*|visa|immigration|without|employment)\s+(?:\w+\s+){0,3}sponsor|sponsor\w*\s+(?:\w+\s+){0,3}(?:requir\w*|need\w*)/i;
const SPONSORSHIP_WORK_AUTHORIZATION_SUPPORT_QUESTION =
  /\b(?:do|will|would|can|could)?\s*(?:you\s+)?(?:now\s+or\s+in\s+the\s+future\s+)?(?:requir\w*|need\w*)\b[^?]{0,80}\b(?:sponsor\w*|visa)\b[^?]{0,50}\bwork\s+authori[sz]ation\b/i;
const NON_US_WORK_SCOPE =
  /\b(canada|canadian|united kingdom|uk|britain|british|england|european union|eu|australia|australian|india|indian|united arab emirates|uae|dubai|singapore|germany|france|ireland|netherlands|hungary|hungarian|japan|korea|china)\b/i;
const US_WORK_SCOPE = /\b(?:united states|usa|america(?:n)?)\b|\bu\.s\.(?=\s|$|[?,;:)])/i;
const US_ABBREVIATION_SCOPE =
  /\b(?:in|within|throughout|across)\s+(?:the\s+)?US\b|\bUS\s+(?:work|employment|visa|immigration|authori[sz]ation)\b/;
const US_ABBREVIATION_SCOPE_CASE_FOLDED =
  /\b(?:in|within|throughout|across)\s+the\s+us\b|\bus\s+(?:work|employment|visa|immigration|authori[sz]ation)\b/i;
const RESIDENCE_CLAUSE_JOINED_TO_ELIGIBILITY =
  /\b(?:currently\s+)?(?:located|residing|living)\s+in\b[^?]{0,60}\bor\b/i;
function selfContradictory(ap: ApplicationProfileLike): boolean {
  return ap.work_authorized === false && ap.needs_sponsorship === false;
}
const JOB_LOCATION_SCOPE = /country\s+(?:where|in which)\s+the\s+job\s+is\s+located|country\s+where\s+the\s+role\s+is\s+located|where\s+the\s+job\s+is\s+located/i;
const WORK_AUTHORIZATION_DETAIL_QUESTION =
  /\b(?:current\s+immigration\s+status|basis\s+of\s+your\s+current\s+work\s+authorization|when\s+does\s+it\s+expire|extension\s+options?|additional\s+detail\s+about\s+your\s+sponsorship\s+need)\b/i;
const UNRESTRICTED_WORK_AUTHORIZATION_QUESTION =
  /\ball\s+employers?\b|\bany\s+employer\b|\bwithout\s+(?:the\s+need\s+for\s+)?(?:visa\s+)?sponsorship\b|\bwithout\s+restriction\b|\bwithout\s+(?:any\s+)?(?:current\s+or\s+future\s+)?need\s+for\s+sponsorship\b/i;

function branch(label: string, ap: ApplicationProfileLike): string {
  const explicitlyUsScoped = US_WORK_SCOPE.test(label) || US_ABBREVIATION_SCOPE.test(label)
    || US_ABBREVIATION_SCOPE_CASE_FOLDED.test(label);
  if (WORK_AUTHORIZATION_DETAIL_QUESTION.test(label)) return 'A detail-question -> SKIP';
  const asksAuthorization = WORK_AUTHORIZATION_QUESTION.test(label);
  const asksSponsorship = SPONSORSHIP_QUESTION.test(label);
  if (asksAuthorization || asksSponsorship) {
    if (selfContradictory(ap)) return 'A2 stored pair self-contradictory -> SKIP';
    if (RESIDENCE_CLAUSE_JOINED_TO_ELIGIBILITY.test(label)) return 'A3 compound residence-OR-eligibility -> SKIP';
  }
  if (asksAuthorization && asksSponsorship && SPONSORSHIP_WORK_AUTHORIZATION_SUPPORT_QUESTION.test(label)) {
    if (!explicitlyUsScoped) return 'B combined+support, no US scope -> SKIP';
    if (NON_US_WORK_SCOPE.test(label)) return 'B combined+support, non-US words -> SKIP';
    if (JOB_LOCATION_SCOPE.test(label)) return 'B combined+support, job-location scope -> SKIP';
    if (typeof ap.needs_sponsorship === 'boolean') return 'C combined+support, US-scoped -> needs_sponsorship';
    return 'C combined+support, US-scoped, nothing stored -> SKIP';
  }
  if (!asksAuthorization && !asksSponsorship) return 'D not a work-eligibility label -> null (falls through)';
  if (asksAuthorization && asksSponsorship) return 'E asks BOTH, no support wording -> SKIP';
  const which = asksAuthorization ? 'authorization' : 'sponsorship';
  if (!explicitlyUsScoped) return `F ${which}-only, no US scope -> SKIP`;
  if (NON_US_WORK_SCOPE.test(label)) return `F ${which}-only, non-US words -> SKIP`;
  if (JOB_LOCATION_SCOPE.test(label)) return `F ${which}-only, job-location scope -> SKIP`;
  if (asksAuthorization && UNRESTRICTED_WORK_AUTHORIZATION_QUESTION.test(label) && ap.needs_sponsorship === true) {
    return 'G authorization, "any employer", needs_sponsorship=true -> SKIP';
  }
  if (asksAuthorization && typeof ap.work_authorized === 'boolean') return 'H authorization, US-scoped -> work_authorized';
  if (asksSponsorship && typeof ap.needs_sponsorship === 'boolean') return 'I sponsorship, US-scoped -> needs_sponsorship';
  return 'J US-scoped but nothing stored -> SKIP';
}

const USER = process.argv[2] ?? 'a18f774b-a306-4804-93f3-cd6020c27fb3';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows: [app] } = await client.query(
  `select work_authorized, needs_sponsorship from application_profile where user_id = $1`, [USER]);
const { rows: [user] } = await client.query(`select sponsorship_answer from users where id = $1`, [USER]);

const packets = await client.query(`
  select q->>'question' as label from generated_resumes,
         lateral jsonb_array_elements(spec->'_review'->'questions') q
   where jsonb_typeof(spec->'_review'->'questions') = 'array'`);
const posting = await client.query(`
  select q->>'label' as label from posting_questions,
         lateral jsonb_array_elements(questions) q
   where jsonb_typeof(questions) = 'array'`);
const saved = await client.query(`select question as label from saved_application_answers`);
await client.end();

const REAL: ApplicationProfileLike = {
  work_authorized: app?.work_authorized ?? undefined,
  needs_sponsorship: app?.needs_sponsorship ?? undefined,
};
const EMPTY: ApplicationProfileLike = {};

console.log(`user ${USER}`);
console.log(`application_profile.work_authorized   = ${JSON.stringify(app?.work_authorized ?? null)}`);
console.log(`application_profile.needs_sponsorship = ${JSON.stringify(app?.needs_sponsorship ?? null)}`);
console.log(`users.sponsorship_answer              = ${JSON.stringify(user?.sponsorship_answer ?? null)}\n`);

const counts = new Map<string, number>();
for (const set of [packets.rows, posting.rows, saved.rows]) {
  for (const r of set) {
    const label = (r.label ?? '').trim();
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
}
const EXTRA = process.argv.slice(3);
for (const label of EXTRA) if (!counts.has(label)) counts.set(label, 0);

function verdict(label: string, ap: ApplicationProfileLike): string {
  const r = resolveKnownAnswer(label, 'text', ap, undefined);
  if (r === null) return 'null';
  return 'value' in r ? `VALUE ${JSON.stringify(r.value)}` : 'SKIP';
}

const hits = [...counts].filter(([label]) => WORK_ELIGIBILITY_QUESTION.test(label)).sort((a, b) => b[1] - a[1]);
console.log(`${counts.size} distinct stored labels, ${hits.length} match WORK_ELIGIBILITY_QUESTION\n`);
let answered = 0;
for (const [label, count] of hits) {
  const real = verdict(label, REAL);
  const empty = verdict(label, EMPTY);
  if (real.startsWith('VALUE')) answered += 1;
  console.log(
    `[${String(count).padStart(2)}x] real=${real.padEnd(12)} empty=${empty.padEnd(12)} refused=${String(isRefusedQuestion(label)).padEnd(5)} `
    + `${branch(label, REAL).padEnd(52)} :: ${label.replace(/\s+/g, ' ').slice(0, 130)}`,
  );
}
console.log(`\nANSWERED against the real profile: ${answered} / ${hits.length}`);
