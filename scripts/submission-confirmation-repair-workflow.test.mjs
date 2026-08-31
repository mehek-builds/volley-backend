import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/submission-confirmation-repair.yml', import.meta.url),
  'utf8',
);

test('confirmation repair workflow is exact, frozen, dry-run-first, and replay verified', () => {
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /SCHEMA_CHECK_DATABASE_URL/u);
  assert.match(workflow, /\.revision == \$revision/u);
  assert.match(workflow, /\.submission_cutover\.mode == "freeze"/u);
  assert.match(workflow, /\.submission_cutover\.config_valid == true/u);
  assert.match(workflow, /--user-id "\$REPAIR_USER_ID"/u);
  assert.match(workflow, /--application-id "\$REPAIR_APPLICATION_ID"/u);
  assert.match(workflow, /if: inputs\.apply/u);
  assert.match(workflow, /\.status == "eligible" or \.status == "already_applied"/u);
  assert.match(workflow, /\.status == "applied" or \.status == "already_applied"/u);
  assert.match(workflow, /\.status == "already_applied"/u);

  const dryRun = workflow.indexOf('- name: Dry run the exact repair');
  const apply = workflow.indexOf('- name: Apply the exact repair');
  const verify = workflow.indexOf('- name: Verify the repair is now immutable');
  assert.ok(dryRun >= 0 && dryRun < apply && apply < verify);
});
