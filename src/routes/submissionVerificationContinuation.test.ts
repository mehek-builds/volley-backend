import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('managed submission records an exact searching projection before mailbox polling', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const firstSubmit = runner.indexOf('buildManagedPortalActions(portal, packet, true, applicationUrl)');
  const verificationGate = runner.indexOf('managedResultNeedsEmailVerification(result)', firstSubmit);
  const searchingWrite = runner.indexOf('recordManagedSecurityCodeContinuationSearch(', verificationGate);
  const mailboxPoll = runner.indexOf('prepareManagedEmailVerification({', searchingWrite);
  assert.ok(firstSubmit > 0);
  assert.ok(verificationGate > firstSubmit && searchingWrite > verificationGate && mailboxPoll > searchingWrite);
  const searchProjection = runner.slice(searchingWrite, mailboxPoll);
  assert.match(searchProjection, /securityCode: initialSecurityCodeState/);
  assert.match(searchProjection, /status: 'searching'/);
  assert.match(searchProjection, /requested_at: requestedAt/);
  assert.match(searchProjection, /retry_count: 0/);
  assert.match(searchProjection, /\.\.\.continuationEvidence/);
  assert.match(searchProjection, /if \(!searchingProjection\) return/);
  assert.match(searchProjection, /const searchingReview = searchingProjection\.review/);
  assert.doesNotMatch(searchProjection, /runManagedBrowser\(result\.url/);
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
  assert.match(managed, /managedApplicationSubmitOptions\(\s*SECURITY_CODE_CONTINUATION_TTL_SECONDS,\s*managedSubmissionAttempt!,\s*\)/);
  assert.match(managed, /timeoutMs: managedInitialCallTimeoutMs\(authorization\)/);
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
  assert.equal((managed.match(/continueManagedBrowser\(/g) ?? []).length, 2);
  assert.equal((managed.match(/continueManagedBrowser\(continuationToken, codeActions, \{/g) ?? []).length, 1);
  assert.equal((managed.match(/continueManagedBrowser\(continuationToken, \[\], \{\s*screenshot: true,/g) ?? []).length, 1);
  assert.match(
    managed,
    /continueManagedBrowser\(continuationToken, \[\], \{\s*screenshot: true,\s*submissionAttempt: successfulSubmissionAttempt,[\s\S]*?timeoutMs: MANAGED_SECURITY_CODE_CONTINUATION_CALL_TIMEOUT_MS,/,
  );
  // The supplied code is fingerprinted as superseded and never handed to an action list.
  assert.match(managed, /outcome: 'superseded'/);
  assert.doesNotMatch(managed, /securityCodeContinuationActions\([^)]*options\.securityCode/);
  assert.match(managed, /if \(initialChallenge && managedResultNeedsEmailVerification\(result\)\) \{/);
  assert.doesNotMatch(managed, /runManagedBrowser\(result\.url/);
  assert.match(managed, /await assertManagedSecurityCodeContinuationBoundaryClear\([\s\S]*?successfulSubmissionAttempt,/);
  const providerBudget = managed.indexOf('startManagedBrowserRequestBudget(');
  const continuationGate = managed.indexOf('await assertManagedSecurityCodeContinuationBoundaryClear(', providerBudget);
  const providerCall = managed.indexOf('receiptResult = await continueManagedBrowser(continuationToken, codeActions, {', continuationGate);
  assert.ok(providerBudget > 0 && continuationGate > providerBudget && providerCall > continuationGate,
    'the one provider budget must start before the locked gate and survive through dispatch');
  const continuationDispatch = managed.slice(providerCall, managed.indexOf('if (readManagedSubmitOutcome', providerCall));
  assert.match(continuationDispatch, /requestBudget: continuationRequestBudget/);
  assert.match(continuationDispatch, /providerDeadlineAt: continuationAuthorization\.providerDeadlineAt/);
  assert.match(continuationDispatch, /minimumDispatchBudgetMs: MANAGED_SECURITY_CODE_CONTINUATION_REMOTE_BUDGET_MS/);
  assert.doesNotMatch(continuationDispatch, /timeoutMs:/);
  assert.match(managed, /readManagedReceipt\(receiptResult\)/);
  const terminalVerification = managed.slice(managed.indexOf("verification = {\n        status: 'completed'"));
  assert.doesNotMatch(terminalVerification, /continuation_token:/);
});

test('retained continuation carries its pre-gate signal through OIDC and fetch without restarting it', async () => {
  const browser = await readFile('src/lib/browserbase.ts', 'utf8');
  const start = browser.indexOf('export async function continueManagedBrowser(');
  const end = browser.indexOf('export async function createBrowserContext(', start);
  const continuation = browser.slice(start, end);
  const signal = continuation.indexOf('options.requestBudget?.signal');
  const credential = continuation.indexOf('acquireManagedStratusOidcAuthorization(signal)');
  const fetch = continuation.indexOf("fetch(`${baseUrl}/api/run`");
  assert.ok(signal > 0 && credential > signal && fetch > credential,
    'one pre-gate signal must cover the gate delay, OIDC acquisition, dispatch, and retained request');
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
  const continuation = runner.indexOf('await assertManagedSecurityCodeContinuationBoundaryClear(', firstSubmit);
  assert.ok(firstSubmit > 0 && continuation > firstSubmit);
  const managed = runner.slice(firstSubmit, continuation);
  assert.match(managed, /standingChallenge: initialSubmitOutcome\?\.pressed === false/);
  assert.match(managed, /const codeWasAlreadyAttempted = prepared\.status === 'ready'/);
  assert.match(managed, /findSecurityCodeAttempt\([\s\S]*securityCodeFingerprint\(row\.id, prepared\.code\)/);
  assert.match(managed, /prepared\.status === 'ready' && !codeWasAlreadyAttempted/);
  assert.match(
    managed,
    /recordManagedSecurityCodeContinuationSearch\([\s\S]*?securityCode: initialSecurityCodeState,[\s\S]*?status: 'searching',[\s\S]*?\.\.\.continuationEvidence/,
  );
  assert.match(managed, /enteredSecurityCodeState = withSecurityCodeAttempts\(initialSecurityCodeState/);
  const remoteCall = runner.indexOf('receiptResult = await continueManagedBrowser(continuationToken, codeActions, {', continuation);
  const gate = runner.slice(continuation, remoteCall);
  assert.match(gate, /continuationExpiresAt,[\s\S]*?enteredSecurityCodeState,[\s\S]*?\);/);
  assert.ok(
    remoteCall > continuation,
    'the atomic gate must spend the exact code evidence before the one-shot continuation is called',
  );
});

test('a post-authorization recipient mismatch records the mutable exit before mailbox or continuation work', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const start = runner.indexOf('if (initialChallengeCandidate && initialSubmitOutcome?.pressed === false && !initialChallenge)');
  const end = runner.indexOf('if (managedApplicationProofIsRequired(', start);
  const mismatch = runner.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(mismatch, /preClickSecurityRecipientMismatchReview\(\s*claimedReview,\s*initialChallengeCandidate/);
  assert.match(
    mismatch,
    /recordManagedAuthorizedAttemptUnverified\(row, attemptBinding, \{[\s\S]*?securityCode: mismatch\.security_code,[\s\S]*?verification: mismatch\.verification,[\s\S]*?\}\);/,
  );
  assert.match(mismatch, /return;/);
  assert.doesNotMatch(mismatch, /prepareManagedEmailVerification|continueManagedBrowser|findComposioVerificationCode/);
});

test('consent and the exact email route are revalidated after polling and before spending the code', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const ready = runner.indexOf("if (prepared.status === 'ready' && !codeWasAlreadyAttempted");
  const entered = runner.indexOf('enteredCode = prepared.code', ready);
  const continuation = runner.indexOf('continueManagedBrowser(continuationToken, codeActions, {', entered);
  const actionGate = runner.slice(ready, entered);
  assert.ok(ready > 0 && entered > ready && continuation > entered);
  assert.match(actionGate, /await authorizationValidAtClick\(row, claimedReview\)/);
  assert.match(actionGate, /await resolveVerificationEmailRoute\(\{[\s\S]*applicationId: row\.id,[\s\S]*expectedRecipient: packet\.email/);
  assert.match(actionGate, /verificationRoute === 'application_alias'[\s\S]*actionVerificationRoute === 'application_alias'/);
  assert.match(actionGate, /verificationRoute === 'personal_address'[\s\S]*db\.select\(\{ enabled: users\.automatic_verification_enabled \}\)[\s\S]*actionPersonalVerificationEnabled/);
  assert.match(
    actionGate,
    /preClickVerificationContinuationBlockedReview\([\s\S]*?recordManagedAuthorizedAttemptUnverified\(row, attemptBinding, \{[\s\S]*?securityCode: blocked\.security_code,[\s\S]*?verification: blocked\.verification,[\s\S]*?\}\);[\s\S]*?return;/,
  );
  assert.doesNotMatch(actionGate, /securityCodeFingerprint\(row\.id, prepared\.code\)|continueManagedBrowser/);
});

test('uncertain continuation outcome is handed off without a retry or URL reopen', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const call = runner.indexOf('await assertManagedSecurityCodeContinuationBoundaryClear(');
  const receiptObservation = runner.indexOf('let receiptEvidenceResult = receiptResult', call);
  const continuation = runner.slice(call, receiptObservation);
  assert.match(continuation, /catch \(error\)/);
  assert.match(continuation, /recordManagedSecurityCodeContinuationUnverified\(/);
  assert.equal((continuation.match(/continueManagedBrowser\(/g) ?? []).length, 1);
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
  assert.match(initialRun, /managedApplicationSubmitOptions\(\s*SECURITY_CODE_CONTINUATION_TTL_SECONDS,\s*managedSubmissionAttempt!,\s*\)/);
  assert.doesNotMatch(initialRun, /continuationCheckpoint: true/);
  const observation = runner.slice(start, end);
  assert.match(observation, /if \(!initialChallenge\)/);
  assert.equal((observation.match(/continueManagedBrowser\(/g) ?? []).length, 1);
  assert.match(observation, /expectedApplicationUrl: applicationUrl/);
  assert.match(observation, /continueManagedBrowser\(continuationToken, \[\], \{\s*screenshot: true,[\s\S]{0,100}submissionAttempt: successfulSubmissionAttempt/);
  assert.doesNotMatch(observation, /runManagedBrowser|result\.url|codeActions|confirmAndSubmit|type: 'click'/);
});

test('typed confirmation is locked before screenshot storage and enriched only afterward', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const managedStart = runner.indexOf('let receiptEvidenceResult = receiptResult');
  const typedVerdict = runner.indexOf('const typedConfirmationVerdict = managedSubmitVerdict(receiptResult)', managedStart);
  const earlyConfirmation = runner.indexOf(
    'await recordManagedSubmissionConfirmed(row, attemptBinding, {',
    typedVerdict,
  );
  const screenshotStore = runner.indexOf('blob = await storeReceiptScreenshot(', earlyConfirmation);
  const enrichedConfirmation = runner.indexOf(
    'await recordManagedSubmissionConfirmed(row, attemptBinding, {',
    screenshotStore,
  );
  assert.ok(managedStart > 0
    && typedVerdict > managedStart
    && earlyConfirmation > typedVerdict
    && screenshotStore > earlyConfirmation
    && enrichedConfirmation > screenshotStore,
  'typed confirmation and its submitted projection must linearize before optional receipt storage');
  const early = runner.slice(typedVerdict, screenshotStore);
  assert.match(early, /typedConfirmationVerdict\.kind === 'confirmed'/);
  assert.match(early, /typedConfirmationHasAcceptedCode/);
  assert.match(early, /verification,[\s\S]*?receipt: typedConfirmationReceipt/);
  assert.doesNotMatch(early, /screenshot_url:/);
  const enrichment = runner.slice(screenshotStore, enrichedConfirmation + 900);
  assert.match(enrichment, /if \(!typedConfirmationReceipt\) throw error;[\s\S]*?return;/,
    'a confirmed projection must survive screenshot storage failure without entering outer failure handling');
  assert.match(enrichment, /receipt: typedConfirmationReceipt \? \{[\s\S]*?screenshot_url: blob\.url/);
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
  assert.match(
    challengeBranch,
    /recordManagedAuthorizedAttemptUnverified\(row, attemptBinding, \{[\s\S]*?securityCode,[\s\S]*?verification,[\s\S]*?previewUrl: blob\.url,[\s\S]*?\}\);/,
  );
  assert.doesNotMatch(challengeBranch, /continueManagedBrowser|runManagedBrowser/);
  assert.match(challengeBranch, /return;/);
});
