import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('managed submission records a typed verification handoff before receipt parsing', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const firstSubmit = runner.indexOf('buildManagedPortalActions(portal, packet, true)');
  const verificationGate = runner.indexOf('managedResultNeedsEmailVerification(result)', firstSubmit);
  const receiptRead = runner.indexOf('readManagedReceipt(receiptResult)', firstSubmit);
  assert.ok(firstSubmit > 0);
  assert.ok(verificationGate > firstSubmit && verificationGate < receiptRead);
  const handoff = runner.slice(verificationGate, receiptRead);
  assert.match(handoff, /status: 'needs_attention'/);
  assert.match(handoff, /status: 'verification_pending'/);
  assert.match(handoff, /requested_at: requestedAt/);
  assert.match(handoff, /retry_count: 0/);
  assert.doesNotMatch(handoff, /runManagedBrowser\(result\.url/);
});

test('managed verification resumes once by token, never by URL, then verifies the receipt', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const firstSubmit = runner.indexOf('buildManagedPortalActions(portal, packet, true)');
  const end = runner.indexOf("if (!claimedReview.browser_session_id)", firstSubmit);
  const managed = runner.slice(firstSubmit, end);
  assert.match(managed, /requestContinuation: true/);
  assert.match(managed, /continuationCheckpoint: true/);
  assert.match(managed, /continuationTtlSeconds: SECURITY_CODE_CONTINUATION_TTL_SECONDS/);
  assert.match(managed, /allowSubmit: true/);
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
  assert.equal((managed.match(/continueManagedBrowser\(/g) ?? []).length, 2);
  assert.equal((managed.match(/continueManagedBrowser\(continuationToken, codeActions\)/g) ?? []).length, 1);
  assert.equal((managed.match(/continueManagedBrowser\(continuationToken, \[\], \{ screenshot: true \}\)/g) ?? []).length, 1);
  // The supplied code is fingerprinted as superseded and never handed to an action list.
  assert.match(managed, /outcome: 'superseded'/);
  assert.doesNotMatch(managed, /securityCodeContinuationActions\([^)]*options\.securityCode/);
  assert.match(managed, /if \(initialChallenge && managedResultNeedsEmailVerification\(result\)\) \{/);
  assert.doesNotMatch(managed, /runManagedBrowser\(result\.url/);
  assert.match(managed, /receiptResult = await continueManagedBrowser\(continuationToken, codeActions\)/);
  assert.match(managed, /readManagedReceipt\(receiptResult\)/);
  const terminalVerification = managed.slice(managed.indexOf("verification = {\n        status: 'completed'"));
  assert.doesNotMatch(terminalVerification, /continuation_token:/);
});

test('managed alias permission is independent from connected-inbox consent and personal email is not', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const firstSubmit = runner.indexOf('buildManagedPortalActions(portal, packet, true)');
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
  const continuation = runner.indexOf('receiptResult = await continueManagedBrowser(continuationToken, codeActions)', firstSubmit);
  assert.ok(firstSubmit > 0 && continuation > firstSubmit);
  const managed = runner.slice(firstSubmit, continuation);
  assert.match(managed, /standingChallenge: initialSubmitOutcome\?\.pressed === false/);
  assert.match(managed, /const codeWasAlreadyAttempted = prepared\.status === 'ready'/);
  assert.match(managed, /findSecurityCodeAttempt\([\s\S]*securityCodeFingerprint\(row\.id, prepared\.code\)/);
  assert.match(managed, /prepared\.status === 'ready' && !codeWasAlreadyAttempted/);
  assert.match(managed, /await writeReview\(row, nextReview\(claimedReview, \{ security_code: enteredSecurityCodeState \}\)\)/);
  const durableFingerprintWrite = runner.indexOf('security_code: enteredSecurityCodeState', firstSubmit);
  assert.ok(
    durableFingerprintWrite > firstSubmit && durableFingerprintWrite < continuation,
    'the fingerprint must be durable before the one-shot continuation is called',
  );
});

test('a standing code wall for another recipient exits before mailbox or continuation work', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const start = runner.indexOf('if (initialChallengeCandidate && initialSubmitOutcome?.pressed === false && !initialChallenge)');
  const end = runner.indexOf('if (!initialChallenge) assertManagedRequiredFieldsConfirmed', start);
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
  const continuation = runner.indexOf('continueManagedBrowser(continuationToken, codeActions)', entered);
  const actionGate = runner.slice(ready, entered);
  assert.ok(ready > 0 && entered > ready && continuation > entered);
  assert.match(actionGate, /await authorizationValidAtClick\(row, claimedReview\)/);
  assert.match(actionGate, /await resolveVerificationEmailRoute\(\{[\s\S]*applicationId: row\.id,[\s\S]*expectedRecipient: packet\.email/);
  assert.match(actionGate, /verificationRoute === 'application_alias'[\s\S]*actionVerificationRoute === 'application_alias'/);
  assert.match(actionGate, /verificationRoute === 'personal_address'[\s\S]*db\.select\(\{ enabled: users\.automatic_verification_enabled \}\)[\s\S]*actionPersonalVerificationEnabled/);
  assert.match(actionGate, /preClickVerificationContinuationBlockedReview\([\s\S]*return;/);
  assert.doesNotMatch(actionGate, /securityCodeFingerprint\(row\.id, prepared\.code\)|continueManagedBrowser/);
});

test('uncertain continuation outcome is handed off without a retry or URL reopen', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const call = runner.indexOf('receiptResult = await continueManagedBrowser(continuationToken, codeActions)');
  const receiptObservation = runner.indexOf('let receiptEvidenceResult = receiptResult', call);
  const continuation = runner.slice(call, receiptObservation);
  assert.match(continuation, /catch \(error\)/);
  assert.match(continuation, /could not prove the final result/);
  assert.equal((continuation.match(/continueManagedBrowser\(/g) ?? []).length, 1);
  assert.doesNotMatch(continuation, /result\.url/);
  assert.doesNotMatch(continuation, /runManagedBrowser\(/);
});

test('unknown receipt observation is one empty-action continuation with no URL or submit action', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const firstSubmit = runner.indexOf('buildManagedPortalActions(portal, packet, true)');
  const start = runner.indexOf('let receiptEvidenceResult = receiptResult');
  const end = runner.indexOf("if (!receiptEvidenceResult.screenshot)", start);
  assert.ok(firstSubmit > 0 && start > firstSubmit && end > start);
  const initialRun = runner.slice(firstSubmit, start);
  assert.match(initialRun, /requestContinuation: true/);
  assert.match(initialRun, /continuationCheckpoint: true/);
  const observation = runner.slice(start, end);
  assert.match(observation, /if \(!initialChallenge\)/);
  assert.equal((observation.match(/continueManagedBrowser\(/g) ?? []).length, 1);
  assert.match(observation, /expectedApplicationUrl: applicationUrl/);
  assert.match(observation, /continueManagedBrowser\(continuationToken, \[\], \{ screenshot: true \}\)/);
  assert.doesNotMatch(observation, /runManagedBrowser|result\.url|codeActions|confirmAndSubmit|type: 'click'/);
});

test('a delayed typed code wall fails closed after its one observation capability is consumed', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const start = runner.indexOf('let receiptEvidenceResult = receiptResult');
  const handoff = runner.indexOf('if (delayedObservedChallenge)', start);
  const handoffEnd = runner.indexOf('/* THE SUBMIT LANDED AND THE EMPLOYER ASKED FOR A CODE', handoff);
  const unverified = runner.indexOf('const verdict = managedSubmitVerdict(receiptResult)', handoff);
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
