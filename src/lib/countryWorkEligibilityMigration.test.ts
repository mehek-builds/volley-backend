import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('country eligibility migration is conservative and has a schema-first workflow', () => {
  const migration = readFileSync('scripts/apply-country-work-eligibility-schema.mjs', 'utf8');
  assert.match(migration, /u\.sponsorship_answer = 'needs_future'[\s\S]*ap\.needs_sponsorship is not false/);
  assert.match(migration, /u\.sponsorship_answer = 'no'[\s\S]*ap\.needs_sponsorship is not true/);
  assert.match(migration, /u\.sponsorship_answer is null[\s\S]*ap\.work_authorized is true[\s\S]*ap\.needs_sponsorship is false/);
  assert.doesNotMatch(migration, /'country_code',\s*'(?!US)[A-Z]{2}'/);

  const workflow = readFileSync('.github/workflows/country-work-eligibility-migration.yml', 'utf8');
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /npm run db:country-work-eligibility/);
  assert.match(workflow, /npm run schema:check/);
});
