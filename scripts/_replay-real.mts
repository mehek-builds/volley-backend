#!/usr/bin/env tsx
/* Replay the Roblox blocker labels (and their near neighbours) through resolveKnownAnswer against
 * the REAL stored profile. Read-only: SELECT only, and the encrypted columns are deliberately not
 * decrypted here (the production ENCRYPTION_KEY is not on this machine) - the fields this exercise
 * is about (full_name, legal_first_name, preferred_first_name, date_of_birth) are read from the
 * plaintext columns and from profiles.parsed_json. date_of_birth is encrypted, and it is NULL, so
 * there is nothing to decrypt.
 */
import fs from 'node:fs';
import pg from 'pg';
import { resolveKnownAnswer, isRefusedQuestion, type ApplicationProfileLike } from '../src/lib/questionDiscovery';

const envPath = '/Users/Mehek1/Documents/student-outreach-backend/.env.local';
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const USER = process.argv[2] ?? 'a18f774b-a306-4804-93f3-cd6020c27fb3';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows: [app] } = await client.query(
  `select legal_first_name, preferred_first_name, date_of_birth from application_profile where user_id = $1`, [USER]);
const { rows: [prof] } = await client.query(
  `select parsed_json, base_resume_json from profiles where user_id = $1`, [USER]);
await client.end();

const fullName = (prof?.parsed_json?.full_name ?? prof?.base_resume_json?.full_name) as string | undefined;
const ap: ApplicationProfileLike = {
  full_name: fullName,
  legal_first_name: app?.legal_first_name ?? undefined,
  preferred_first_name: app?.preferred_first_name ?? undefined,
  // encrypted column; NULL in the row means never asked, and that is what we replay
  date_of_birth: undefined,
};
console.log('user                 =', USER);
console.log('full_name            =', JSON.stringify(ap.full_name));
console.log('legal_first_name     =', JSON.stringify(ap.legal_first_name));
console.log('preferred_first_name =', JSON.stringify(ap.preferred_first_name));
console.log('date_of_birth (raw)  =', JSON.stringify(app?.date_of_birth ?? null), '\n');

const LABELS = [
  'Legal Name',
  'full legal name type here... _systemfield_name _systemfield_name',
  'legal first name',
  'legal last name',
  'what is your legal first name? (please also ensure that you input your legal first name in the *first name* field above)',
  'legal first name (if different from preferred name)',
  'do you have a preferred name, other than the name indicated above? if yes, please indicate that name below',
  'At the time of application, are you 18+ years of age?',
  'Are you at least 18 years of age?',
  'Are you 18 years or older?',
  'Are you 18 or older?',
  'Are you under 18 years of age?',
  'have you applied to this role or another role @imc within the last 12-18 months?',
  'Date of birth',
];
function show(p: ApplicationProfileLike, label: string): string {
  const r = resolveKnownAnswer(label, 'text', p, undefined);
  return r === null ? 'null' : ('value' in r ? `VALUE ${JSON.stringify(r.value)}` : `SKIP  ${r.skipReason}`);
}
for (const label of LABELS) {
  console.log(`refused=${String(isRefusedQuestion(label)).padEnd(5)} ${show(ap, label).slice(0, 100).padEnd(102)} :: ${label.slice(0, 78)}`);
}

console.log('\n--- same profile, date_of_birth = "25 Sep 2005" ---');
const withDob = { ...ap, date_of_birth: '25 Sep 2005' };
for (const label of LABELS.filter((l) => /18|birth/i.test(l))) {
  console.log(`${show(withDob, label).slice(0, 100).padEnd(102)} :: ${label.slice(0, 78)}`);
}

console.log('\n--- full_name="Robert Smith", legal_first_name="Roberta" ---');
const differing: ApplicationProfileLike = { full_name: 'Robert Smith', legal_first_name: 'Roberta', preferred_first_name: 'Bobbie' };
for (const label of LABELS.filter((l) => /name/i.test(l))) {
  console.log(`${show(differing, label).slice(0, 100).padEnd(102)} :: ${label.slice(0, 78)}`);
}
