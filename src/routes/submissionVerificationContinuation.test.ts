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
  assert.match(managed, /continuationTtlSeconds: SECURITY_CODE_CONTINUATION_TTL_SECONDS/);
  assert.match(managed, /allowSubmit: true/);
  assert.match(managed, /readManagedSecurityCodeChallenge\(receiptResult\)/);
  assert.doesNotMatch(managed, /continuation_token:/);
  assert.doesNotMatch(managed, /continuation_expires_at:/);
  assert.match(managed, /expectedRecipient: packet\.email/);
  /* ONE RESUME SITE. There used to be two, mutually exclusive: one for a code scraped from the
     mailbox and one for a code the applicant supplied. The second is gone, because a code that
     arrives from outside a run cannot be typed by that run - Greenhouse issues a new code on every
     send and Litos has to send the form to reach a code field at all, measured as three codes to
     one mailbox on a live Cresta application on 2026-08-09. Back to one call site, and the count is
     the assertion again: a second one would mean a second submit had crept back in. */
  assert.equal((managed.match(/continueManagedBrowser\(/g) ?? []).length, 1);
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

test('uncertain continuation outcome is handed off without a retry or URL reopen', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const call = runner.indexOf('receiptResult = await continueManagedBrowser(continuationToken, codeActions)');
  const receipt = runner.indexOf('const receipt = readManagedReceipt', call);
  const continuation = runner.slice(call, receipt);
  assert.match(continuation, /catch \(error\)/);
  assert.match(continuation, /could not prove the final result/);
  assert.equal((continuation.match(/continueManagedBrowser\(/g) ?? []).length, 1);
  assert.doesNotMatch(continuation, /result\.url/);
  assert.doesNotMatch(continuation, /runManagedBrowser\(/);
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
