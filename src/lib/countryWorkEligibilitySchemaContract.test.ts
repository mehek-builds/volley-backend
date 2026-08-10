import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('country eligibility storage is declared after its main-first migration', () => {
  const schema = readFileSync('src/db/schema.ts', 'utf8');
  const migration = readFileSync('scripts/apply-country-work-eligibility-schema.mjs', 'utf8');
  const workflow = readFileSync('.github/workflows/country-work-eligibility-migration.yml', 'utf8');

  assert.match(schema, /work_eligibility_by_country: text\('work_eligibility_by_country'\)/);
  assert.match(migration, /add column if not exists work_eligibility_by_country text/);
  assert.match(migration, /data_type[^]*!== 'text'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /npm run db:country-work-eligibility/);
  assert.doesNotMatch(workflow, /npm run schema:check/);
});
