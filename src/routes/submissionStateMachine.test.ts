import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('preparation and final submission each have an atomic database claim', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  assert.match(runner, /spec}->'_review'->>'status' = 'submit_requested'/);
  assert.match(runner, /spec}->'_review'->>'status' = 'submitting'/);
  assert.match(runner, /spec}->'_review'->>'submission_claimed_at' is null/);
});

test('post-click failures retain the claimed row and become uncertain attention', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  assert.match(runner, /const latest = await db\.select\(\)\.from\(generated_resumes\)/);
  assert.match(runner, /await fail\(latest\[0\] \?\? activeRow, error\)/);
  /* The intent, not the formatting. This asserted the exact one-line ternary and broke when a
     third stop reason (NoSubmitControlError) was added and the expression wrapped. What matters is
     that an uncertain-after-claim failure still lands on needs_attention rather than failed. */
  assert.match(runner, /uncertainAfterClaim\s*\n?\s*\?\s*'needs_attention'/);
  assert.match(runner, /const uncertainAfterClaim = Boolean\(current\.submission_claimed_at\)/);
});

test('submit-request state transition is conditional so a replay cannot reset submitted state', async () => {
  const route = await readFile('src/routes/applications.ts', 'utf8');
  assert.match(route, /submitRequestDisposition\(current\.status, Boolean\(current\.submission_claimed_at\)\)/);
  assert.match(route, /spec}->'_review'->>'status' = \$\{current\.status\}/);
  assert.match(route, /spec}->'_review'->>'status' = 'ready_for_final_approval'/);
  assert.match(route, /spec}->'_review'->>'status' = 'needs_attention'/);
  assert.match(route, /active or completed submission cannot be replaced by a delayed failure update/);
});
