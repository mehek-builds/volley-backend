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
  assert.match(managed, /continuationTtlSeconds: 120/);
  assert.match(managed, /allowSubmit: true/);
  assert.match(managed, /readManagedSecurityCodeChallenge\(receiptResult\)/);
  assert.match(managed, /continuation_token: continuationToken/);
  assert.match(managed, /expectedRecipient: packet\.email/);
  assert.equal((managed.match(/continueManagedBrowser\(/g) ?? []).length, 1);
  assert.doesNotMatch(managed, /runManagedBrowser\(result\.url/);
  assert.doesNotMatch(managed, /continueManagedBrowser\([^,]+,[^)]*\).*continueManagedBrowser/s);
  assert.match(managed, /receiptResult = await continueManagedBrowser\(continuationToken, prepared\.actions\)/);
  assert.match(managed, /const receipt = readManagedReceipt\(receiptResult\)/);
  const terminalVerification = managed.slice(managed.indexOf("verification = {\n        status: 'completed'"));
  assert.doesNotMatch(terminalVerification, /continuation_token:/);
});

test('uncertain continuation outcome is handed off without a retry or URL reopen', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const call = runner.indexOf('receiptResult = await continueManagedBrowser');
  const receipt = runner.indexOf('const receipt = readManagedReceipt', call);
  const continuation = runner.slice(call, receipt);
  assert.match(continuation, /catch \(error\)/);
  assert.match(continuation, /could not prove the final result/);
  assert.equal((continuation.match(/continueManagedBrowser\(/g) ?? []).length, 1);
  assert.doesNotMatch(continuation, /result\.url/);
  assert.doesNotMatch(continuation, /runManagedBrowser\(/);
});
