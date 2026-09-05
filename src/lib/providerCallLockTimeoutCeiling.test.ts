/* The drift this file exists to prevent, and this exact repo has already been burned by once.
 *
 * src/routes/resume.deadline.test.ts records the incident: a maxDuration-derived constant
 * (REQUEST_DEADLINE_FOR_TEST) was sized against vercel.json's maxDuration of 60, the config later
 * moved to 300, and the constant did not - for eleven days /resume/generate gave itself 46s of
 * budget out of an available 300, because the coupling between the config and the code existed only
 * in a comment. PROVIDER_CALL_LOCK_TIMEOUT_MS's own comment (submissionAttemptLedger.ts) is derived
 * from the identical relationship - vercel.json's `api/index.ts` maxDuration minus a reserve for
 * the timeout to surface and for recordSubmissionRunnerFailure to close the ledger attempt - and had
 * no test tying the two together. This repo's other two sibling budget constants already learned
 * this lesson: MANAGED_PREPARE_FILL_DEADLINE_MS is pinned against MAX_RUN_TIMEOUT_MS in
 * browserbase.test.ts, and SUBMISSION_BOUNDARY_AUTHORIZATION_TTL_MS is pinned against the table's own
 * CHECK constraint in db/boundaryLeaseCeiling.test.ts. Both of those constants have moved more than
 * once since being introduced; this one should be expected to as well.
 *
 * These tests read vercel.json directly, so the next maxDuration change either updates
 * PROVIDER_CALL_LOCK_TIMEOUT_MS or goes red here, instead of silently drifting the way
 * REQUEST_DEADLINE_MS did.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { PROVIDER_CALL_LOCK_TIMEOUT_MS } from './submissionAttemptLedger';

function vercelMaxDurationSeconds(): number {
  const config = JSON.parse(readFileSync(join(__dirname, '../../vercel.json'), 'utf8'));
  const seconds = config?.functions?.['api/index.ts']?.maxDuration;
  assert.equal(typeof seconds, 'number', 'vercel.json must declare functions["api/index.ts"].maxDuration');
  return seconds;
}

describe('PROVIDER_CALL_LOCK_TIMEOUT_MS tracks the platform ceiling it is derived from', () => {
  test('leaves the platform room to kill the function after the timeout would have surfaced', () => {
    const vercelMaxDurationMs = vercelMaxDurationSeconds() * 1000;
    assert.ok(
      PROVIDER_CALL_LOCK_TIMEOUT_MS < vercelMaxDurationMs,
      'PROVIDER_CALL_LOCK_TIMEOUT_MS must fire before Vercel kills the request, or the whole point of ' +
      'bounding the wait - a clean, catchable error instead of a silent platform kill - never has a ' +
      'chance to happen',
    );
    // The comment's own promise is 60s of slack: enough for the SubmissionProviderCallLockTimeoutError
    // to surface, for recordSubmissionRunnerFailure's own transaction to close the ledger attempt, and
    // for a response to reach the caller.
    assert.ok(
      vercelMaxDurationMs - PROVIDER_CALL_LOCK_TIMEOUT_MS >= 60_000,
      'leave at least 60s between PROVIDER_CALL_LOCK_TIMEOUT_MS and the platform ceiling for cleanup to run',
    );
  });

  test('does not silently shrink to something a normal call could spuriously trip', () => {
    // Not a tight bound on the "right" value - only a guard against an accidental unit slip (seconds
    // mistaken for milliseconds would land here) landing under a duration a real fill can legitimately
    // still be using. A future deliberate change to a smaller number should update this floor with it.
    assert.ok(
      PROVIDER_CALL_LOCK_TIMEOUT_MS >= 120_000,
      'PROVIDER_CALL_LOCK_TIMEOUT_MS dropped below two minutes - confirm this is deliberate, not a unit mistake',
    );
  });
});
