import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { isProviderSessionFailureMessage } from './submissionRunner';
import { classifySubmissionStop, stopReasonPrecedesClick } from '../lib/submissionStop';

const stopLib = readFileSync('src/lib/submissionStop.ts', 'utf8');

/* Run 35a497e0 (DSI Innovations, Recruitee, 2026-09-02) stopped 270_000ms after its last progress
 * stamp - exactly Stratus' MANAGED_RUN_TIMEOUT_MS - and recorded reason 'unclassified' because the
 * provider's teardown surfaces as Playwright's sentence, not as either Stratus phrase. */
const OBSERVED = 'page.waitForTimeout: Target page, context or browser has been closed';

const classifyWith = (message: string) => classifySubmissionStop({
  captchaStop: null,
  noSubmitControl: false,
  regenerationRequired: false,
  packetDocumentExpired: false,
  actionBudget: false,
  confirmationUnproven: false,
  providerSessionFailureBeforeSubmit: false,
  fieldProofFailedBeforeSubmit: false,
  providerSessionFailure: isProviderSessionFailureMessage(message),
  runTimedOut: false,
  providerUnconfigured: false,
});

test('the measured provider teardown is recognised as a provider session failure', () => {
  assert.equal(isProviderSessionFailureMessage(OBSERVED), true);
  assert.equal(classifyWith(OBSERVED), 'provider_session_failure');
});

test('the two Stratus phrases it already matched still match', () => {
  assert.equal(isProviderSessionFailureMessage('sandbox stream was closed'), true);
  assert.equal(isProviderSessionFailureMessage('session is not accepting commands'), true);
});

test('an ordinary failure is still not a provider session failure', () => {
  assert.equal(isProviderSessionFailureMessage('2 required field confirmations failed'), false);
  assert.equal(isProviderSessionFailureMessage('the employer-bound packet changed after approval'), false);
  assert.equal(classifyWith('some unrelated failure'), 'unclassified');
});

/* THE SAFETY PROPERTY. Naming the stop must not make the row re-runnable: a browser that vanished
 * cannot prove where in the run it vanished, so this reason stays outside PRECEDES_CLICK exactly as
 * 'unclassified' is, and the row keeps its claim. */
test('naming this stop grants nothing - it is still not a pre-click stop', () => {
  assert.equal(stopReasonPrecedesClick('provider_session_failure'), false);
  assert.equal(stopReasonPrecedesClick('unclassified'), false);
  assert.doesNotMatch(
    stopLib.slice(stopLib.indexOf('const PRECEDES_CLICK'), stopLib.indexOf('export function stopReasonPrecedesClick')),
    /'provider_session_failure'/,
  );
  // Only the before-submit variant, proved by throw site rather than message, releases a claim.
  assert.equal(stopReasonPrecedesClick('provider_session_failure_before_submit'), true);
});

/* A packet_stale that names no binding cannot be diagnosed.
 *
 * Measured 2026-09-02 on Flow Traders 761e0add: stored audit, acknowledgement and a freshly
 * recomputed audit all carried packet_version 0385e268 and audit_digest 873801, the fresh audit
 * answered 'passed', and the run still parked on packet_stale. The verdict knew which binding
 * moved - bindingMismatchKeys is built for exactly this - and the log line dropped it. */
test('a withheld packet audit logs the reason and which bindings moved', () => {
  const runner = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  const call = runner.slice(
    runner.indexOf('Application preparation withheld because the exact packet audit') - 900,
    runner.indexOf('Application preparation withheld because the exact packet audit'),
  );
  assert.match(call, /reason: packetAudit\.reason/);
  assert.match(call, /bindingMismatchKeys: packetAudit\.bindingMismatchKeys/);
  // The token must still never reach the applicant's sentence.
  assert.match(runner, /attention_reason: packetAuditClientError\(packetAudit\)\.error/);
});
