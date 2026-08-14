import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  RECRUITER_VISIBILITY_CONSENT_VERSION,
  RECRUITER_VISIBILITY_FUNCTIONAL,
} from './recruiterVisibility';

test('recruiter visibility stays private until the verified recruiter layer is functional', () => {
  assert.equal(RECRUITER_VISIBILITY_FUNCTIONAL, false);
  assert.equal(RECRUITER_VISIBILITY_CONSENT_VERSION, 'recruiter_visibility_v1');
});

test('visibility routes gate enabling but always allow withdrawal', () => {
  const source = readFileSync('src/routes/recruiterVisibility.ts', 'utf8');
  assert.match(source, /\/account\/recruiter-visibility/);
  assert.match(source, /\/profile\/recruiter-visibility/);
  const withdrawal = source.indexOf('if (!parsed.data.enabled)');
  const entitlement = source.indexOf("requireFeature(userId, 'recruiter_visibility'");
  assert.ok(withdrawal >= 0 && entitlement > withdrawal);
  assert.match(source, /code: 'feature_not_functional'/);
});
