import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/routes/applications.ts', 'utf8');

test('extension submission routes keep auth, ownership, quota, and claims server-side', () => {
  assert.match(source, /submission\/extension-start'[\s\S]*?preHandler: requireAuth/);
  assert.match(source, /submission\/extension-outcome'[\s\S]*?preHandler: requireAuth/);
  assert.match(source, /pg_advisory_xact_lock\(hashtext/);
  assert.match(source, /eq\(generated_resumes\.user_id, userId\)/);
  assert.match(source, /submission_claimed_at' is null/);
  assert.match(source, /submission_claim_id' = \$\{parsed\.data\.claim_id\}/);
  assert.match(source, /submission_claim_id'->|submission_claim_id/);
});

test('extension outcomes only mark confirmed claims applied', () => {
  assert.match(source, /parsed\.data\.outcome === 'confirmed'[\s\S]*?pipeline_stage: 'applied'/);
  assert.match(source, /current\.submission_claim_id !== parsed\.data\.claim_id/);
  assert.match(source, /extensionReceiptUrlSchema/);
});

test('attended handoff can record a user-confirmed submission without an ATS key', () => {
  assert.match(source, /handoffCompleteBodySchema/);
  assert.match(source, /submission\/handoff-complete'[\s\S]*?preHandler: requireAuth/);
  assert.match(source, /parsed\.data\.outcome === 'submitted'/);
  assert.match(source, /!current\.browser_session_id/);
  assert.match(source, /source: 'attended_handoff'/);
  assert.match(source, /pipeline_stage: 'applied'/);
  assert.match(source, /Submitted by the applicant in the live company page/);
  const handler = source.slice(source.indexOf("'/applications/:id/submission/handoff-complete'"));
  assert.ok(
    handler.indexOf('handoff_expires_at') < handler.indexOf("parsed.data.outcome === 'submitted'"),
    'expired handoffs must be rejected before either completion outcome mutates state',
  );
});
