import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('managed submission records a typed verification handoff before receipt parsing', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const firstSubmit = runner.indexOf('buildManagedPortalActions(portal, packet, true, applicationUrl)');
  const verificationGate = runner.indexOf('managedResultNeedsEmailVerification(result)', firstSubmit);
  const receiptRead = runner.indexOf('const typedConfirmationVerdict = exactManagedSubmitVerdict', firstSubmit);
  assert.ok(firstSubmit > 0);
  assert.ok(verificationGate > firstSubmit && verificationGate < receiptRead);
  const handoff = runner.slice(verificationGate, receiptRead);
  assert.match(handoff, /recordManagedSecurityCodeContinuationSearch/);
  assert.match(handoff, /recordManagedSecurityCodeContinuationUnverified/);
  assert.match(handoff, /status: 'verification_pending'/);
  assert.match(handoff, /requested_at: requestedAt/);
  assert.match(handoff, /retry_count: 0/);
  assert.doesNotMatch(handoff, /runManagedBrowser\(result\.url/);
});

test('a held managed claim retrieves its exact terminal result before any relaunch and acknowledges only after a durable fold', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const processStart = runner.indexOf('export async function processSubmissionApplication(');
  const prepareStart = runner.indexOf("if (review?.status === 'submit_requested')", processStart);
  const heldClaimPath = runner.slice(processStart, prepareStart);
  assert.match(
    heldClaimPath,
    /if \(submissionClaimIsHeld\(review\) \|\| managedSecurityCodeContinuationRecoveryIsHeld\(review\)\)/,
  );
  assert.match(heldClaimPath, /recoverManagedSubmissionTerminalResult\(/);
  assert.match(heldClaimPath, /if \(recovery !== 'not_recoverable'\)/);

  const recoveryStart = runner.indexOf('export async function recoverManagedSubmissionTerminalResult(');
  const claimStart = runner.indexOf('async function claimSubmission(', recoveryStart);
  const recovery = runner.slice(recoveryStart, claimStart);
  const retrieval = recovery.indexOf('getManagedBrowserTerminalResult(submissionAttempt');
  const durableFold = recovery.indexOf('recordManagedSubmissionConfirmed(row, attemptBinding');
  const acknowledgement = recovery.lastIndexOf('acknowledgeManagedTerminalFold(');
  assert.ok(retrieval >= 0 && durableFold > retrieval && acknowledgement > durableFold);
  assert.doesNotMatch(recovery, /runManagedBrowser\(|continueManagedBrowser(?:WithAccountFence)?\(/);
});

/* THE PONY.AI GAP ON THE ASYNC RECOVERY PATH: recoverManagedSubmissionTerminalResult's own
 * persistUnverified used to hardcode "Litos could not prove the final employer result..." for
 * EVERY unverified fold, even once it had read a real ManagedSubmitOutcome (with its `pending` flag)
 * off the recovered result a few lines later. A still-pending Workable "Submitting…" button folded
 * through this path got the wrong, generic sentence the same way the synchronous path's did before
 * its own fix - the honest "still showing Submitting…" sentence never had a way to reach here. */
test('the async recovery fold computes its unverified sentence from the recovered outcome, pending included', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const recoveryStart = runner.indexOf('export async function recoverManagedSubmissionTerminalResult(');
  const claimStart = runner.indexOf('async function claimSubmission(', recoveryStart);
  const recovery = runner.slice(recoveryStart, claimStart);
  assert.ok(recoveryStart > 0 && claimStart > recoveryStart);

  const persistStart = recovery.indexOf('const persistUnverified = async (');
  const persistEnd = recovery.indexOf('let terminal;', persistStart);
  const persist = recovery.slice(persistStart, persistEnd);
  assert.ok(persistStart >= 0 && persistEnd > persistStart);
  // The generic sentence must be reached only when there is no outcome to reason from - never
  // unconditionally, which is exactly the bug: it used to be the ONLY sentence this closure could
  // produce, no matter what readManagedSubmitOutcome(result) below had already read.
  assert.match(persist, /const attentionReason = outcome\s*\n\s*\? unverifiedSubmissionReason\(/);
  assert.match(persist, /pending: outcome\.pending === true/);
  assert.match(persist, /: 'Litos could not prove the final employer result/);

  // Both call sites reached AFTER the outcome is read (readManagedSubmitOutcome(result) below) must
  // actually pass it through, or the fix above is wired to a closure argument nothing ever supplies.
  const afterOutcomeRead = recovery.slice(recovery.indexOf('const outcome = readManagedSubmitOutcome(result);'));
  const proofCatch = afterOutcomeRead.slice(
    afterOutcomeRead.indexOf('} catch (error) {'),
    afterOutcomeRead.indexOf('if (challenge) {'),
  );
  assert.match(proofCatch, /persistUnverified\(\s*\n\s*error instanceof Error[\s\S]*?\n\s*outcome,\s*\n\s*\);/);
  const verdictFold = afterOutcomeRead.slice(afterOutcomeRead.indexOf('const verdict = exactManagedSubmitVerdict('));
  assert.match(verdictFold, /persistUnverified\(\s*\n\s*`The recovered managed result was \$\{verdict\.kind\}`,\s*\n\s*\[\],\s*\n\s*terminal\.resultId,\s*\n\s*outcome,\s*\n\s*\);/);
});

test('a lost initial challenge response enters the durable continuation state before acknowledgement', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const start = runner.indexOf('async function recoverManagedInitialSecurityCodeChallenge(');
  const end = runner.indexOf('export async function recoverManagedSubmissionTerminalResult(', start);
  const recovery = runner.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(recovery, /beginSecurityCodeState\(\{/);
  assert.match(recovery, /continuation_execution_fingerprint: continuationExecutionFingerprint/);
  assert.match(recovery, /continuation_resumed: false/);
  assert.match(recovery, /recordManagedSecurityCodeContinuationSearch\(/);
  const handoff = recovery.slice(
    recovery.indexOf('const persistHandoff = async'),
    recovery.indexOf('const expectedRecipient'),
  );
  assert.ok(
    handoff.indexOf('recordManagedAuthorizedAttemptUnverified')
      < handoff.indexOf('acknowledgeManagedTerminalFold'),
    'the exact challenge handoff must commit before the initial result is acknowledged',
  );
});

test('a crash after continuation search stays scheduler-visible and reuses the same initial result', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const searchStart = runner.indexOf('export async function recordManagedSecurityCodeContinuationSearch(');
  const searchEnd = runner.indexOf('type ManagedSubmissionConfirmedInput', searchStart);
  const search = runner.slice(searchStart, searchEnd);
  assert.match(search, /const sameSearch =/);
  assert.match(search, /continuation_execution_fingerprint/);
  assert.match(search, /return sameSearch \? \{ row: latest, review: latestReview \} : null/);

  const cronStart = runner.indexOf("fastify.get('/internal/application-submission-runner'");
  const cron = runner.slice(cronStart);
  assert.match(cron, /verification'->>'status' = 'searching'/);
  assert.match(cron, /verification'->>'continuation_resumed' = 'false'/);
  assert.match(cron, /managedSecurityCodeContinuationRecoveryIsHeld\(queuedReview\)/);
});

test('continuation recovery is GET-only across pending, success, and deadline handoff', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const start = runner.indexOf('export async function recoverManagedSecurityCodeContinuationTerminalResult(');
  const end = runner.indexOf('async function recoverManagedInitialSecurityCodeChallenge(', start);
  const recovery = runner.slice(start, end);
  assert.match(recovery, /managedSecurityCodeContinuationRecoveryPlan\(review, attemptBinding\)/);
  assert.match(recovery, /getManagedBrowserTerminalResult\(plan\.submissionAttempt\)/);
  assert.match(recovery, /if \(terminalDecision === 'pending'\) return 'pending'/);
  assert.match(recovery, /terminalDecision === 'deadline_expired'/);
  assert.match(recovery, /foldManagedSecurityCodeContinuationResult\(/);
  assert.doesNotMatch(recovery, /continueManagedBrowser(?:WithAccountFence)?\(|runManagedBrowser\(|portalApplicationUrl\(/);
});

test('continuation acknowledgement follows either a confirmed fact or a structured handoff', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const start = runner.indexOf('async function acknowledgeManagedTerminalFold(');
  const end = runner.indexOf('function recoveredSecurityCodeState(', start);
  const acknowledgement = runner.slice(start, end);
  assert.ok(
    acknowledgement.indexOf('managedAttemptHasDurableFold')
      < acknowledgement.indexOf('acknowledgeManagedBrowserTerminalResult'),
  );
  const foldStart = runner.indexOf('async function foldManagedSecurityCodeContinuationResult(');
  const foldEnd = runner.indexOf('export async function recoverManagedSecurityCodeContinuationTerminalResult(', foldStart);
  const fold = runner.slice(foldStart, foldEnd);
  assert.match(fold, /recordManagedSubmissionConfirmed\(/);
  assert.match(fold, /recordManagedSecurityCodeContinuationUnverified\(/);
  assert.match(fold, /acknowledgeManagedTerminalCleanupMarkers\(/);
});

test('every managed acknowledgement carries the exact durable result ID returned by Stratus', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const acknowledgementStart = runner.indexOf('async function acknowledgeManagedTerminalFold(');
  const acknowledgementEnd = runner.indexOf('function recoveredSecurityCodeState(', acknowledgementStart);
  const acknowledgement = runner.slice(acknowledgementStart, acknowledgementEnd);
  assert.match(acknowledgement, /resultId: string/);
  assert.match(
    acknowledgement,
    /acknowledgeManagedBrowserTerminalResult\(submissionAttempt, resultId\)/,
  );

  const recoveryStart = runner.indexOf('export async function recoverManagedSubmissionTerminalResult(');
  const recoveryEnd = runner.indexOf('async function claimSubmission(', recoveryStart);
  const recovery = runner.slice(recoveryStart, recoveryEnd);
  assert.match(recovery, /terminal\.resultId/);
  assert.match(
    recovery,
    /recoverManagedInitialSecurityCodeChallenge\([\s\S]*submissionAttempt,[\s\S]*terminal\.resultId,[\s\S]*result/,
  );

  const managedStart = runner.indexOf('buildManagedPortalActions(portal, packet, true, applicationUrl)');
  const managedEnd = runner.indexOf("if (!claimedReview.browser_session_id)", managedStart);
  const managed = runner.slice(managedStart, managedEnd);
  assert.match(managed, /const initialTerminalResultId = managedBrowserTerminalResultId\(result\)/);
  assert.match(
    managed,
    /securityCodeTerminalResultId = managedBrowserTerminalResultId\(receiptResult\)/,
  );
  assert.match(
    managed,
    /receiptObservationTerminalResultId = managedBrowserTerminalResultId\(observed\)/,
  );
  assert.match(
    managed,
    /successfulSubmissionAttempt,[\s\S]*initialTerminalResultId,[\s\S]*fastify/,
  );
});

test('an initial terminal GET failure folds after database expiry with atomic result retrieval work', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const start = runner.indexOf('export async function recoverManagedSubmissionTerminalResult(');
  const end = runner.indexOf('async function claimSubmission(', start);
  const recovery = runner.slice(start, end);
  const retrieval = recovery.indexOf('terminal = await getManagedBrowserTerminalResult(submissionAttempt');
  const failure = recovery.indexOf('const freshAuthorization = await submissionBoundaryAuthorization(', retrieval);
  const expiry = recovery.indexOf("if (freshAuthorization?.active) return 'pending'", failure);
  const fold = recovery.indexOf('await persistUnverified(', expiry);
  assert.ok(retrieval >= 0 && failure > retrieval && expiry > failure && fold > expiry);
  assert.match(recovery, /pendingManagedTerminalCleanupMarker\(\{ attemptBinding, submissionAttempt \}\)/);
  assert.match(recovery, /recordManagedAuthorizedAttemptUnverified\([\s\S]*cleanupMarkers: \[cleanupMarker\]/);
  assert.doesNotMatch(recovery, /queueManagedTerminalCleanupResultRetrieval/);
});

test('terminal cleanup runs independently before the terminal application selector', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const start = runner.indexOf("fastify.get('/internal/application-submission-runner'");
  const cron = runner.slice(start);
  const cleanup = cron.indexOf('retryManagedTerminalCleanupOutbox(fastify)');
  const selection = cron.indexOf('const rows = await db');
  assert.ok(cleanup >= 0 && selection > cleanup);
  assert.match(runner, /_managed_terminal_cleanup_outbox/);
  assert.match(runner, /managed-terminal-cleanup-outbox-v2/);
  assert.match(runner, /managedTerminalCleanupBatchWindow\([\s\S]*\.offset\(batchWindow\.firstOffset\)/);
  assert.match(runner, /if \(batchWindow\.wrapLimit > 0\)/);
  assert.match(runner, /resultId: string \| null/);
});

test('terminal review and every cleanup obligation share one locked packet update', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const start = runner.indexOf('export async function recordManagedAuthorizedAttemptUnverified(');
  const refusedStart = runner.indexOf('export async function recordManagedAuthorizedAttemptRefused(', start);
  const end = runner.indexOf('/** Persist exact post-call uncertainty', start);
  assert.ok(start > 0 && refusedStart > start && end > refusedStart);

  // recordManagedAuthorizedAttemptUnverified: the review write and every cleanup obligation fold
  // into ONE locked update, never a second write for the cleanup markers.
  const fold = runner.slice(start, refusedStart);
  const lock = fold.indexOf('await lockSubmissionAttemptUser(tx, row.user_id)');
  const outbox = fold.indexOf('specWithManagedTerminalFold', lock);
  const review = fold.indexOf('unresolved,', outbox);
  const update = fold.indexOf('await tx.update(generated_resumes)', review);
  assert.ok(lock >= 0 && outbox > lock && review > outbox && update > review);
  assert.equal((fold.match(/await tx\.update\(generated_resumes\)/g) ?? []).length, 1);
  assert.doesNotMatch(fold, /persistManagedTerminalCleanupMarker|queueManagedTerminalCleanup/);

  // recordManagedAuthorizedAttemptRefused sits immediately after it and makes the exact same
  // promise for its own release write. It is a deliberate hand-mirrored sibling, not a shared
  // helper (see the comment above its declaration), so it is pinned by the same shape check
  // independently rather than by widening the assertion above across both functions.
  const refusedFold = runner.slice(refusedStart, end);
  const refusedLock = refusedFold.indexOf('await lockSubmissionAttemptUser(tx, row.user_id)');
  const refusedOutbox = refusedFold.indexOf('specWithManagedTerminalFold', refusedLock);
  const refusedReview = refusedFold.indexOf('released,', refusedOutbox);
  const refusedUpdate = refusedFold.indexOf('await tx.update(generated_resumes)', refusedReview);
  assert.ok(refusedLock >= 0 && refusedOutbox > refusedLock && refusedReview > refusedOutbox
    && refusedUpdate > refusedReview);
  assert.equal((refusedFold.match(/await tx\.update\(generated_resumes\)/g) ?? []).length, 1);
  assert.doesNotMatch(refusedFold, /persistManagedTerminalCleanupMarker|queueManagedTerminalCleanup/);
});

test('continuation recovery folds initial and continuation cleanup entries together', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const start = runner.indexOf('export async function recoverManagedSecurityCodeContinuationTerminalResult(');
  const end = runner.indexOf('async function recoverManagedInitialSecurityCodeChallenge(', start);
  const recovery = runner.slice(start, end);
  assert.match(recovery, /const initialCleanupMarkers: ManagedTerminalCleanupMarker\[\] = \[\]/);
  assert.match(recovery, /managedTerminalCleanupMarkerAfterRetrieval\([\s\S]*initialSubmissionAttempt/);
  assert.match(recovery, /const cleanupMarkers = \[\.\.\.initialCleanupMarkers, cleanupMarker\]/);
  assert.match(
    recovery,
    /foldManagedSecurityCodeContinuationResult\([\s\S]*fastify,[\s\S]*initialCleanupMarkers/,
  );
  assert.match(recovery, /if \(plan\.kind === 'invalid'\)[\s\S]*pendingManagedTerminalCleanupMarker/);
  assert.match(recovery, /exactManagedTerminalCleanupQuarantine/);
  assert.match(recovery, /cleanupMarkers: \[\.\.\.initialCleanupMarkers, \.\.\.continuationCleanupMarkers\]/);
  assert.match(recovery, /cleanupQuarantines/);
});

test('live terminal branches atomically queue exact cleanup before acknowledgement', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const start = runner.indexOf('const initialTerminalResultId = managedBrowserTerminalResultId(result)');
  const end = runner.indexOf("if (!claimedReview.browser_session_id)", start);
  const managed = runner.slice(start, end);
  assert.match(managed, /cleanupMarkers: \[initialCleanupMarker\]/);
  assert.match(managed, /cleanupMarkers: managedCleanupMarkers\(\)/);
  assert.match(
    managed,
    /receiptObservationStarted \? \[pendingManagedTerminalCleanupMarker\(\{[\s\S]*submissionAttempt: receiptObservationSubmissionAttempt/,
  );
  assert.match(managed, /foldManagedLiveTerminalUnverified\(/);
  assert.match(managed, /await acknowledgeManagedCleanupMarkers\(\)/);
  assert.doesNotMatch(
    managed,
    /did not return a receipt screenshot'\);|if \(!typedConfirmationReceipt\) throw error/,
  );
});

test('managed verification resumes once by token, never by URL, then verifies the receipt', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const firstSubmit = runner.indexOf('buildManagedPortalActions(portal, packet, true, applicationUrl)');
  const end = runner.indexOf("if (!claimedReview.browser_session_id)", firstSubmit);
  const managed = runner.slice(firstSubmit, end);
  // The submit options are one named builder now, asserted for what they do in browserbase.test.ts.
  // No continuationCheckpoint: Stratus already offers a continuation on a pressed-unknown receipt,
  // and setting the flag also made continuationOffered true on confirmed, rejected and not_attempted
  // outcomes, which kept the sandbox alive after every successful submission.
  assert.match(
    managed,
    /managedApplicationSubmitOptions\(\s*SECURITY_CODE_CONTINUATION_TTL_SECONDS,\s*successfulSubmissionAttempt,?\s*\)/,
  );
  assert.doesNotMatch(managed, /continuationCheckpoint: true/);
  assert.match(managed, /readManagedSecurityCodeChallenge\(receiptResult\)/);
  assert.match(managed, /securityCodeChallengeMatchesRecipient\(initialChallengeCandidate, packet\.email\)/);
  assert.match(managed, /securityCodeChallengeMatchesRecipient\(challengeCandidate, packet\.email\)/);
  assert.doesNotMatch(managed, /continuation_token:/);
  assert.doesNotMatch(managed, /continuation_expires_at:/);
  assert.match(managed, /expectedRecipient: packet\.email/);
  /* ONE SUBMITTING RESUME SITE. There used to be two, mutually exclusive: one for a code scraped from the
     mailbox and one for a code the applicant supplied. The second submitting site is gone, because a code that
     arrives from outside a run cannot be typed by that run - Greenhouse issues a new code on every
     send and Litos has to send the form to reach a code field at all, measured as three codes to
     one mailbox on a live Cresta application on 2026-08-09. A second continuation now exists only
     for a zero-action receipt observation after an unknown verdict. The action shapes, rather than
     the raw call count, prove that no second submit has crept back in. */
  assert.equal((managed.match(/continueManagedBrowserWithAccountFence\(/g) ?? []).length, 2);
  assert.equal((managed.match(/continueManagedBrowserWithAccountFence\(row\.user_id, row\.id, continuationToken, codeActions,/g) ?? []).length, 1);
  assert.equal((managed.match(/continueManagedBrowserWithAccountFence\(row\.user_id, row\.id, continuationToken, \[\], \{/g) ?? []).length, 1);
  assert.match(managed, /submissionAttempt: securityCodeSubmissionAttempt/);
  assert.match(managed, /submissionAttempt: receiptObservationSubmissionAttempt/);
  // The supplied code is fingerprinted as superseded and never handed to an action list.
  assert.match(managed, /outcome: 'superseded'/);
  assert.doesNotMatch(managed, /securityCodeContinuationActions\([^)]*options\.securityCode/);
  assert.match(managed, /if \(initialChallenge && managedResultNeedsEmailVerification\(result\)\) \{/);
  assert.doesNotMatch(managed, /runManagedBrowser\(result\.url/);
  assert.match(managed, /receiptResult = await continueManagedBrowserWithAccountFence\(row\.user_id, row\.id, continuationToken, codeActions,/);
  assert.match(managed, /exactManagedSubmitVerdict\(receiptResult, applicationUrl\)/);
  const terminalVerification = managed.slice(managed.indexOf("verification = {\n        status: 'completed'"));
  assert.doesNotMatch(terminalVerification, /continuation_token:/);
});

test('managed alias permission is independent from connected-inbox consent and personal email is not', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const firstSubmit = runner.indexOf('buildManagedPortalActions(portal, packet, true, applicationUrl)');
  const end = runner.indexOf("if (!claimedReview.browser_session_id)", firstSubmit);
  const managed = runner.slice(firstSubmit, end);
  assert.match(managed, /resolveVerificationEmailRoute\(\{[\s\S]*userId: row\.user_id,[\s\S]*applicationId: row\.id,[\s\S]*expectedRecipient: packet\.email/);
  assert.match(
    managed,
    /verificationRoute === 'application_alias'\s*\|\| \(verificationRoute === 'personal_address' && verificationSettings\?\.enabled === true\)/,
  );
  assert.match(managed, /if \(continuationIsLive && verificationAllowed\)/);
});

test('a retained Greenhouse wall may read the exact older alias code once but never spend it twice', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const firstSubmit = runner.indexOf('const initialSubmitOutcome = readManagedSubmitOutcome(result)');
  const continuation = runner.indexOf('receiptResult = await continueManagedBrowserWithAccountFence(row.user_id, row.id, continuationToken, codeActions,', firstSubmit);
  assert.ok(firstSubmit > 0 && continuation > firstSubmit);
  const managed = runner.slice(firstSubmit, continuation);
  assert.match(managed, /standingChallenge: initialSubmitOutcome\?\.pressed === false/);
  assert.match(managed, /const codeWasAlreadyAttempted = prepared\.status === 'ready'/);
  assert.match(managed, /findSecurityCodeAttempt\([\s\S]*securityCodeFingerprint\(row\.id, prepared\.code\)/);
  assert.match(managed, /prepared\.status === 'ready' && !codeWasAlreadyAttempted/);
  assert.match(managed, /assertManagedSecurityCodeContinuationBoundaryClear\([\s\S]*enteredSecurityCodeState/);
  const durableFingerprintWrite = runner.indexOf('assertManagedSecurityCodeContinuationBoundaryClear(', firstSubmit);
  assert.ok(
    durableFingerprintWrite > firstSubmit && durableFingerprintWrite < continuation,
    'the fingerprint must be durable before the one-shot continuation is called',
  );
});

test('a standing code wall for another recipient exits before mailbox or continuation work', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const start = runner.indexOf('if (initialChallengeCandidate && initialSubmitOutcome?.pressed === false && !initialChallenge)');
  const end = runner.indexOf('if (managedApplicationProofIsRequired(', start);
  const mismatch = runner.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(mismatch, /preClickSecurityRecipientMismatchReview\(\s*claimedReview,\s*initialChallengeCandidate/);
  assert.match(mismatch, /return;/);
  assert.doesNotMatch(mismatch, /prepareManagedEmailVerification|continueManagedBrowser|findComposioVerificationCode/);
});

test('consent and the exact email route are revalidated after polling and before spending the code', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const ready = runner.indexOf("if (prepared.status === 'ready' && !codeWasAlreadyAttempted");
  const entered = runner.indexOf('enteredCode = prepared.code', ready);
  const continuation = runner.indexOf('continueManagedBrowserWithAccountFence(row.user_id, row.id, continuationToken, codeActions,', entered);
  const actionGate = runner.slice(ready, entered);
  assert.ok(ready > 0 && entered > ready && continuation > entered);
  assert.match(actionGate, /await authorizationValidAtClick\(row, claimedReview\)/);
  assert.match(actionGate, /await resolveVerificationEmailRoute\(\{[\s\S]*applicationId: row\.id,[\s\S]*expectedRecipient: packet\.email/);
  assert.match(actionGate, /verificationRoute === 'application_alias'[\s\S]*actionVerificationRoute === 'application_alias'/);
  assert.match(actionGate, /verificationRoute === 'personal_address'[\s\S]*db\.select\(\{ enabled: users\.automatic_verification_enabled \}\)[\s\S]*actionPersonalVerificationEnabled/);
  assert.match(actionGate, /preClickVerificationContinuationBlockedReview\([\s\S]*return;/);
  assert.doesNotMatch(actionGate, /securityCodeFingerprint\(row\.id, prepared\.code\)|continueManagedBrowser/);
});

test('the locked continuation CAS rechecks consent version and entitlement immediately before resume', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const start = runner.indexOf('export async function assertManagedSecurityCodeContinuationBoundaryClear(');
  const end = runner.indexOf('function mergeManagedSecurityCodeEvidence(', start);
  const boundary = runner.slice(start, end);
  const lock = boundary.indexOf('await lockSubmissionAttemptUser(tx, row.user_id)');
  const user = boundary.indexOf('consentVersion: users.automatic_submission_consent_version');
  const entitlement = boundary.indexOf('await getEntitlementSnapshot(', user);
  const authorization = boundary.indexOf('if (!finalBoundaryAuthorizationMatches(', entitlement);
  const resume = boundary.indexOf('continuation_resumed: true', authorization);
  const write = boundary.indexOf('await tx.update(generated_resumes)', resume);
  assert.ok(lock >= 0 && user > lock && entitlement > user && authorization > entitlement
    && resume > authorization && write > resume);
});

test('uncertain continuation outcome is handed off without a retry or URL reopen', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const call = runner.indexOf('receiptResult = await continueManagedBrowserWithAccountFence(row.user_id, row.id, continuationToken, codeActions,');
  const receiptObservation = runner.indexOf('let receiptEvidenceResult = receiptResult', call);
  const continuation = runner.slice(call, receiptObservation);
  assert.match(continuation, /catch \(error\)/);
  assert.match(continuation, /recordManagedSecurityCodeContinuationUnverified/);
  assert.equal((continuation.match(/continueManagedBrowserWithAccountFence\(/g) ?? []).length, 1);
  assert.doesNotMatch(continuation, /result\.url/);
  assert.doesNotMatch(continuation, /runManagedBrowser\(/);
});

test('unknown receipt observation is one empty-action continuation with no URL or submit action', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const firstSubmit = runner.indexOf('buildManagedPortalActions(portal, packet, true, applicationUrl)');
  const start = runner.indexOf('let receiptEvidenceResult = receiptResult');
  const end = runner.indexOf("if (!receiptEvidenceResult.screenshot)", start);
  assert.ok(firstSubmit > 0 && start > firstSubmit && end > start);
  const initialRun = runner.slice(firstSubmit, start);
  assert.match(
    initialRun,
    /managedApplicationSubmitOptions\(\s*SECURITY_CODE_CONTINUATION_TTL_SECONDS,\s*successfulSubmissionAttempt,?\s*\)/,
  );
  assert.doesNotMatch(initialRun, /continuationCheckpoint: true/);
  const observation = runner.slice(start, end);
  assert.match(observation, /if \(!initialChallenge\)/);
  assert.equal((observation.match(/continueManagedBrowserWithAccountFence\(/g) ?? []).length, 1);
  assert.match(observation, /expectedApplicationUrl: applicationUrl/);
  assert.match(observation, /continueManagedBrowserWithAccountFence\(row\.user_id, row\.id, continuationToken, \[\], \{[\s\S]*screenshot: true,[\s\S]*submissionAttempt: receiptObservationSubmissionAttempt/);
  assert.doesNotMatch(observation, /runManagedBrowser|result\.url|codeActions|confirmAndSubmit|type: 'click'/);
});

test('a delayed typed code wall fails closed after its one observation capability is consumed', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const start = runner.indexOf('let receiptEvidenceResult = receiptResult');
  const handoff = runner.indexOf('if (delayedObservedChallenge)', start);
  const handoffEnd = runner.indexOf('/* THE SUBMIT LANDED AND THE EMPLOYER ASKED FOR A CODE', handoff);
  const unverified = runner.indexOf('const verdict = exactManagedSubmitVerdict(receiptResult, applicationUrl)', handoff);
  assert.ok(start > 0 && handoff > start && handoffEnd > handoff && unverified > handoffEnd);
  const observation = runner.slice(start, handoff);
  assert.match(observation, /readManagedSecurityCodeChallenge\(observation\.observedResult\)/);
  assert.match(observation, /securityCodeChallengeMatchesRecipient\(delayedChallengeCandidate, packet\.email\)/);
  assert.match(observation, /receiptResult = observation\.observedResult/);
  assert.match(observation, /status: 'verification_pending'/);
  const challengeBranch = runner.slice(handoff, handoffEnd);
  assert.match(challengeBranch, /delayedSecurityCodeHandoffReview\(claimedReview/);
  assert.match(challengeBranch, /screenshotUrl: blob\.url/);
  assert.doesNotMatch(challengeBranch, /submission_claimed_at: undefined/);
  assert.doesNotMatch(challengeBranch, /submission_claim_id: undefined/);
  assert.doesNotMatch(challengeBranch, /submission_authorization: undefined/);
  assert.doesNotMatch(challengeBranch, /continueManagedBrowser|runManagedBrowser/);
  assert.match(challengeBranch, /return;/);
});

test('a failure after polling starts cannot leave verification searching forever', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const searchingWrite = runner.indexOf("status: 'searching'");
  const failStart = runner.indexOf('async function fail(');
  const failEnd = runner.indexOf('export type SecurityCodeSubmissionOutcome', failStart);
  assert.ok(searchingWrite > 0, 'managed verification must record when polling starts');
  assert.ok(failStart > searchingWrite && failEnd > failStart, 'the shared failure writer must follow the managed run');
  const failureWrite = runner.slice(failStart, failEnd);
  assert.match(failureWrite, /current\.verification\?\.status === 'searching'/);
  assert.match(failureWrite, /verification: \{\s*\.\.\.current\.verification,\s*status: 'verification_pending' as const/s);
  assert.doesNotMatch(
    failureWrite,
    /verification:\s*\{\s*status: 'verification_pending'/,
    'the request time, provider, and retry count must survive the terminal transition',
  );
});

test('a failure after verification search begins cannot strand the searching state', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const failStart = runner.indexOf('async function fail(');
  const failEnd = runner.indexOf('export type SecurityCodeSubmissionOutcome', failStart);
  assert.ok(failStart > 0 && failEnd > failStart);
  const failureHandler = runner.slice(failStart, failEnd);
  assert.match(failureHandler, /current\.verification\?\.status === 'searching'/);
  assert.match(failureHandler, /status: 'verification_pending' as const/);
  assert.doesNotMatch(failureHandler, /continuation_token|continuation_expires_at/);
});
