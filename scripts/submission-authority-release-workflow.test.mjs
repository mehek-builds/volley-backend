import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/submission-attempt-ledger-migration.yml', import.meta.url),
  'utf8',
);

test('submission authority migrations stay on protected main under an exact frozen revision', () => {
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /SCHEMA_CHECK_DATABASE_URL/u);
  assert.match(workflow, /\.revision == \$revision/u);
  assert.match(workflow, /\.submission_cutover\.mode == "freeze"/u);
  assert.match(workflow, /\.submission_cutover\.config_valid == true/u);

  const drain = workflow.indexOf('- name: Drain every old backend instance');
  const ledger = workflow.indexOf('- name: Apply and verify production submission attempt ledger');
  const revision = workflow.indexOf('- name: Apply and verify production submission authority revision');
  const readiness = workflow.indexOf('- name: Require freeze remained active through migration');
  assert.ok(drain >= 0 && drain < ledger && ledger < revision && revision < readiness);
});

test('the post-migration gate proves both public readiness signals before evidence is recorded', () => {
  assert.match(workflow, /\.submission_authority\.ready == true/u);
  assert.match(workflow, /\.submission_authority\.attempt_ledger\.ready == true/u);
  assert.match(workflow, /\.submission_authority\.revision\.ready == true/u);

  const readiness = workflow.indexOf('- name: Require freeze remained active through migration');
  const evidence = workflow.indexOf('- name: Record frozen migration evidence');
  assert.ok(readiness >= 0 && readiness < evidence);
});
