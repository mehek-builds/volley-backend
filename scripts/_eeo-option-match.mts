#!/usr/bin/env tsx
/* MEASUREMENT, not a code read: for every EEO label Litos has ever stored, replay it through
 * resolveProfileField with the OWNER'S REAL eeo_prefs and report whether an option was matched.
 *
 * Companion to _corpus-labels.mts and _sweep-untraceable.mts. Those two ask what the resolver
 * SAYS; this one asks whether what it says can be left on a closed list, which is the whole of
 * the EEO defect: the answer was resolved and then matched nothing.
 *
 * THE OPTION LISTS. The corpus stores no `options` key anywhere: posting_questions is empty and
 * spec._review.questions carries only question/answer/kind/required/portal_*. The only option
 * vocabularies Litos has ever recorded are the two below, and they are recorded by accident, in
 * the CONCATENATED LABEL BLOB that managed discovery builds out of label + aria-label + name + id
 * on a Greenhouse EEO block. Both are printed verbatim by
 *   npx tsx scripts/_corpus-labels.mts 'select \.\.\.'
 * The federal race list is the eighth vocabulary: it is not in the corpus and is not measured, it
 * is the OFCCP/EEO-1 self-identification enum, and it is here because a race question cannot be
 * exercised at all without one.
 *
 * Read-only. SELECT only.
 */
import pg from 'pg';
import fs from 'node:fs';
import { EEO_QUESTION, type ApplicationProfileLike } from '../src/lib/questionDiscovery';
import { resolveProfileField, usableOptions } from '../src/lib/profileFieldResolution';

const envPath = '/Users/Mehek1/Documents/student-outreach-backend/.env.local';
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const prefsRow = await client.query(
  `select eeo_prefs from application_profile where eeo_prefs is not null order by updated_at desc limit 1`,
);
const eeo_prefs = prefsRow.rows[0]?.eeo_prefs ?? {};

const labelRows = await client.query(`
  select label, count(*)::int as n from (
    select q->>'question' as label
      from generated_resumes, lateral jsonb_array_elements(spec->'_review'->'questions') q
     where jsonb_typeof(spec->'_review'->'questions') = 'array'
    union all
    select q->>'label' from posting_questions, lateral jsonb_array_elements(questions) q
     where jsonb_typeof(questions) = 'array'
    union all
    select question from saved_application_answers
  ) t
  where label is not null and length(trim(label)) > 0
  group by label order by n desc`);
await client.end();

const eeoLabels = labelRows.rows
  .map((r) => ({ label: String(r.label).trim(), n: r.n as number }))
  .filter((r) => EEO_QUESTION.test(r.label));

// ---- the option vocabularies, exactly as measured (see the header) ----
const MEASURED: Array<{ from: string; match: RegExp; options: string[] }> = [
  {
    from: 'veteran statusselect ...i identify as one or more of the classifications of protected '
      + 'veteran listed abovei am not a protected veterani decline to self-identify for protected '
      + 'veteran status eeo[veteran]',
    match: /veteran|military|armed\s+forces/i,
    options: [
      'Select ...',
      'I identify as one or more of the classifications of protected veteran listed above',
      'I am not a protected veteran',
      'I decline to self-identify for protected veteran status',
    ],
  },
  {
    from: 'disability statusselect ...yes, i have a disability, or have had one in the pastno, i do '
      + 'not have a disability and have not had one in the pasti do not want to answer '
      + 'eeo[disability] disabilityselectelement',
    match: /disab/i,
    options: [
      'Select ...',
      'Yes, I have a disability, or have had one in the past',
      'No, I do not have a disability and have not had one in the past',
      'I do not want to answer',
    ],
  },
];
// NOT measured. The federal self-identification enum, so the race labels can be exercised at all.
const FEDERAL_RACE = {
  from: 'OFCCP / EEO-1 self-identification enum (not from the corpus)',
  match: /\brace\b|racial|ethnicit|ethnic\b/i,
  options: [
    'Hispanic or Latino',
    'White',
    'Black or African American',
    'Native Hawaiian or Other Pacific Islander',
    'Asian',
    'American Indian or Alaska Native',
    'Two or More Races',
    'Decline to self-identify',
  ],
};

const profile: ApplicationProfileLike = { eeo_prefs };

function report(title: string, vocab: { options: string[]; match: RegExp }, labels: typeof eeoLabels) {
  const applicable = labels.filter((l) => vocab.match.test(l.label));
  let answerable = 0;
  const lines: string[] = [];
  for (const item of applicable) {
    const resolved = resolveProfileField({ label: item.label, options: vocab.options }, profile);
    const ok = Boolean(resolved?.matchedOption);
    if (ok) answerable += 1;
    lines.push(`  ${ok ? 'MATCH ' : 'BLANK '} ${JSON.stringify(resolved?.value ?? null)}  <-  ${item.label.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
  console.log(`\n## ${title}`);
  console.log(`   options (${usableOptions(vocab.options).length}): ${JSON.stringify(usableOptions(vocab.options))}`);
  console.log(`   answerable: ${answerable} of ${applicable.length}`);
  for (const line of lines) console.log(line);
  return { answerable, total: applicable.length };
}

console.log(`stored eeo_prefs: ${JSON.stringify(eeo_prefs)}`);
console.log(`distinct stored labels: ${labelRows.rows.length}; matching EEO_QUESTION: ${eeoLabels.length}`);

let answerable = 0;
let total = 0;
for (const vocab of MEASURED) {
  const r = report(`MEASURED vocabulary from: ${vocab.from.slice(0, 60)}...`, vocab, eeoLabels);
  answerable += r.answerable;
  total += r.total;
}
const race = report(`UNMEASURED vocabulary: ${FEDERAL_RACE.from}`, FEDERAL_RACE, eeoLabels);

console.log(`\nMEASURED vocabularies: ${answerable} of ${total} EEO labels answerable`);
console.log(`FEDERAL race vocabulary: ${race.answerable} of ${race.total} race labels answerable`);
