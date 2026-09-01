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
 * WHY A SOURCE TEST RATHER THAN AN EXECUTED ONE. runManagedBrowser's own guard already refuses an
 * uncorrelated mutating launch at runtime, so that half needs no pinning here. What the guard
 * cannot see is a call site that correlates but drops the widened deadline, which silently reverts
 * the two big runs to the 240s read-scan window and aborts fills stratus is still finishing. That
 * is what these assertions hold, and prepareManaged has no executed-path coverage through the
 * provider to hold it instead.
 */

/** The whole call expression at an anchor, so an assertion can never pass on a truncated window. */
function callSiteAt(source: string, anchor: string, occurrence = 0): string {
  let index = -1;
  for (let found = 0; found <= occurrence; found += 1) {
    index = source.indexOf(anchor, index + 1);
    assert.ok(index > 0, `call site not found: ${anchor} (occurrence ${occurrence})`);
  }
  const start = source.lastIndexOf('await runManagedBrowserWithAccountFence(', index);
  assert.ok(start > 0, `no fenced managed launch encloses: ${anchor}`);
  const end = source.indexOf('\n  );', start);
  const nestedEnd = source.indexOf('\n    );', start);
  const close = Math.min(end < 0 ? Number.MAX_SAFE_INTEGER : end, nestedEnd < 0 ? Number.MAX_SAFE_INTEGER : nestedEnd);
  assert.ok(close < Number.MAX_SAFE_INTEGER, `unterminated managed launch at: ${anchor}`);
  return source.slice(start, close);
}

test('every prepare-path managed mutation carries an ephemeral scan correlation', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');

  // The two big runs share one named options constant, so the correlation policy for a prepare run
  // has a single definition rather than a literal per call site.
  const discovery = callSiteAt(runner, 'buildManagedDiscoveryActions(portal, packet)');
  assert.match(
    discovery,
    /MANAGED_PREPARE_SCAN_OPTIONS/,
    'the discovery pass fills fixed fields, so it must launch with the prepare scan options',
  );
  const fill = callSiteAt(runner, 'managedActionsWithExactPageUrl(fillActions, applicationUrl)');
  assert.match(
    fill,
    /MANAGED_PREPARE_SCAN_OPTIONS/,
    'the prepare fill mutates the form without submitting, so it must launch with the prepare scan options',
  );

  // Probe-sized mutations keep the standard read-scan window; they only need the correlation.
  const optionProbe = callSiteAt(runner, 'optionProbeBatchFailures.push({ controlIds, reason })');
  assert.match(
    optionProbe,
    /scanCorrelation: true/,
    'option-probe clicks classify as mutations, so the probe batches must carry the scan correlation',
  );
  const evidence = callSiteAt(runner, 'buildWorkablePhoneEvidenceActions()');
  assert.match(
    evidence,
    /scanCorrelation: true/,
    'the evidence run clicks the cookie decline, so it must carry the scan correlation',
  );

  // The real submit is the one launch that must NOT use the ephemeral pair: it derives its
  // correlation from the durable attempt binding claimed before launch, which is what makes the
  // employer-facing press auditable in the attempt ledger.
  const submitCall = runner.indexOf('...managedApplicationSubmitOptions(');
  assert.ok(submitCall > 0, 'the managed submit must keep its durable-attempt submit options');
  assert.match(
    runner.slice(submitCall - 2_000, submitCall + 400),
    /managedInitialSubmissionAttempt\(\s*attemptBinding,/,
  );
  assert.doesNotMatch(
    runner.slice(submitCall, submitCall + 400),
    /scanCorrelation/,
    'a submit-capable run must never be correlated as a scan',
  );

  // The account-gate probe and the CAPTCHA probe are extract-only reads and must stay
  // uncorrelated: minting throwaway attempts for reads would blur what a correlation means.
  assert.doesNotMatch(
    callSiteAt(runner, 'buildManagedAttendedAccountProbeActions(portal)'),
    /scanCorrelation/,
  );
  assert.doesNotMatch(
    callSiteAt(runner, 'buildManagedCaptchaProbeActions()'),
    /scanCorrelation/,
  );
});
