import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/* THE REGRESSION THAT BLOCKED EVERY MANAGED FILL OF THE 25-BOARD CAMPAIGN.
 *
 * First live post-cutover managed fill, 2026-09-01, application e4b0420c (OpenAI, Ashby), run
 * f3e612b4: the dashboard approve path queued the packet, the runner launched the prepare fill with
 * no correlation of any kind, and stratus's correlation-required mode (the default) refused it with
 * "A durable submissionAttempt is required for every submit-capable or continuable run". Zero
 * attempt-ledger rows existed for the application because none SHOULD exist yet: claimSubmission
 * opens the durable attempt only when a submit-capable run is about to launch, and a prepare run
 * cannot submit. The missing piece was the EPHEMERAL scan correlation that the posting-questions
 * pre-scan already carried for exactly this policy.
 *
 * These assertions pin the shape: every prepare-path managed run that mutates the employer page
 * carries scanCorrelation, the two big runs (discovery and fill) carry the widened deadline that
 * covers stratus's own run budget, and the real submit still derives its correlation from the
 * durable attempt claimed before launch. runManagedBrowser's own guard refuses any future
 * uncorrelated mutating launch at runtime; this test names the call sites so the guard never fires.
 */
test('every prepare-path managed mutation carries an ephemeral scan correlation', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');

  const prepareStart = runner.indexOf('async function prepareManaged(');
  assert.ok(prepareStart > 0);
  const discoveryCall = runner.indexOf(
    'managedActionsWithExactPageUrl(buildManagedDiscoveryActions(portal, packet), applicationUrl),',
    prepareStart,
  );
  assert.ok(discoveryCall > prepareStart, 'the discovery pass call site must exist');
  assert.match(
    runner.slice(discoveryCall, discoveryCall + 250),
    /\{ scanCorrelation: true, scanDeadlineMs: MANAGED_PREPARE_FILL_DEADLINE_MS \},/,
    'the discovery pass fills fixed fields, so it must carry the widened scan correlation',
  );

  const fillCall = runner.indexOf(
    'managedActionsWithExactPageUrl(fillActions, applicationUrl),',
    prepareStart,
  );
  assert.ok(fillCall > discoveryCall, 'the fill call site must exist after the discovery pass');
  assert.match(
    runner.slice(fillCall, fillCall + 250),
    /\{ scanCorrelation: true, scanDeadlineMs: MANAGED_PREPARE_FILL_DEADLINE_MS \},/,
    'the prepare fill mutates the form without submitting, so it must carry the widened scan correlation',
  );

  const optionProbeCall = runner.indexOf('const result = await runManagedBrowserWithAccountFence(', prepareStart);
  assert.ok(optionProbeCall > 0 && optionProbeCall < fillCall, 'the option-probe call site must exist');
  assert.match(
    runner.slice(optionProbeCall, optionProbeCall + 250),
    /\{ screenshot: false, scanCorrelation: true \},/,
    'option-probe clicks classify as mutations, so the probe batches must carry the scan correlation',
  );

  const evidenceCall = runner.indexOf('buildWorkablePhoneEvidenceActions(),');
  assert.ok(evidenceCall > 0, 'the Workable phone evidence call site must exist');
  assert.match(
    runner.slice(evidenceCall, evidenceCall + 250),
    /\{ screenshot: false, scanCorrelation: true \},/,
    'the evidence run clicks the cookie decline, so it must carry the scan correlation',
  );

  // The real submit is the one launch that must NOT use the ephemeral pair: it derives its
  // correlation from the durable attempt binding claimed before launch, which is what makes the
  // employer-facing press auditable in the attempt ledger.
  const submitCall = runner.indexOf('...managedApplicationSubmitOptions(');
  assert.ok(submitCall > 0, 'the managed submit must keep its durable-attempt submit options');
  const submitWindow = runner.slice(submitCall - 2_000, submitCall + 400);
  assert.match(submitWindow, /managedInitialSubmissionAttempt\(\s*attemptBinding,/);
  assert.doesNotMatch(
    runner.slice(submitCall, submitCall + 400),
    /scanCorrelation/,
    'a submit-capable run must never be correlated as a scan',
  );

  // The account-gate probe and the CAPTCHA probe are extract-only reads and must stay
  // uncorrelated: minting throwaway attempts for reads would blur what a correlation means.
  const accountGateCall = runner.indexOf('buildManagedAttendedAccountProbeActions(portal),');
  assert.ok(accountGateCall > 0);
  assert.doesNotMatch(runner.slice(accountGateCall, accountGateCall + 120), /scanCorrelation/);
  const captchaProbeCall = runner.indexOf('buildManagedCaptchaProbeActions(),');
  assert.ok(captchaProbeCall > 0);
  assert.doesNotMatch(runner.slice(captchaProbeCall, captchaProbeCall + 120), /scanCorrelation/);
});
