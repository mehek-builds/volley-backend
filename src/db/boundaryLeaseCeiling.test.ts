/**
 * The final-send lease is bounded twice: by SUBMISSION_BOUNDARY_AUTHORIZATION_TTL_MS in code and by
 * submission_attempt_events_boundary_auth_check in the table. When the two disagree in the wrong
 * direction the ledger insert fails with a 500 at the exact moment a send is authorized (measured
 * 2026-09-05 in CI: five .db tests, a seven-minute lease against a five-minute check). This pins the
 * table's ceiling in both places it is written and keeps the code's lease inside it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SUBMISSION_BOUNDARY_AUTHORIZATION_TTL_MS } from '../lib/submissionAttemptLedger.js';

const BOUNDARY_CEILING_MS = 8 * 60 * 1000;
const boundaryCeilingClause = /boundary_expires_at\S* <= \S*observed_at\S* \+ interval '(\d+) minutes'/g;

function ceilingsIn(source: string): number[] {
  return [...source.matchAll(boundaryCeilingClause)].map((match) => Number(match[1]) * 60 * 1000);
}

test('the schema and the apply script state the same eight-minute lease ceiling', () => {
  const schema = ceilingsIn(readFileSync('src/db/schema.ts', 'utf8'));
  const script = ceilingsIn(readFileSync('scripts/apply-submission-attempt-ledger-schema.mjs', 'utf8'));
  assert.deepEqual(schema, [BOUNDARY_CEILING_MS]);
  // The create-table block and the recreate block both carry the constraint.
  assert.deepEqual(script, [BOUNDARY_CEILING_MS, BOUNDARY_CEILING_MS]);
});

test('the lease the code grants fits inside the ceiling the table enforces', () => {
  assert.ok(SUBMISSION_BOUNDARY_AUTHORIZATION_TTL_MS <= BOUNDARY_CEILING_MS);
});
