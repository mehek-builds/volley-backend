import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const route = readFileSync(join(process.cwd(), 'src/routes/postingIdentityDistinctions.ts'), 'utf8');

test('posting distinction requires authentication and an explicit exact-pair attestation', () => {
  assert.match(route, /posting-distinctions'[\s\S]*?preHandler: requireAuth/);
  assert.match(route, /confirmed_distinct_postings: z\.literal\(true\)/);
  assert.match(route, /candidate_identity_version: z\.literal\(POSTING_DISTINCTION_CANDIDATE_IDENTITY_VERSION\)/);
  assert.match(route, /candidate_identity_digest: z\.string\(\)\.regex\(\/\^\[0-9a-f\]\{64\}\$\//);
});

test('resolution appends evidence, reruns the guard, and never submits or retries', () => {
  const appendAt = route.indexOf('await appendPostingDistinction');
  const guardAt = route.indexOf('await duplicateApplicationVerdict');
  assert.ok(appendAt > 0);
  assert.ok(guardAt > appendAt);
  assert.doesNotMatch(route, /submissionRunner|submit-request|submission\/approve|extension-start/);
  assert.match(route, /remaining_risk: remainingRisk/);
});

test('candidate drift and immutable relation conflicts stay typed and fail closed', () => {
  assert.match(route, /error instanceof PostingDistinctionError/);
  assert.match(route, /posting_distinction_\$\{error\.code\}/);
  assert.match(route, /Cache-Control', 'private, no-store/);
});
