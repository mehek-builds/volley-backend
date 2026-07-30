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
