import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const applications = readFileSync('src/routes/applications.ts', 'utf8');
const runner = readFileSync('src/routes/submissionRunner.ts', 'utf8');

function routeSlice(from: string, to: string): string {
  const start = applications.indexOf(from);
  assert.ok(start >= 0, `missing route ${from}`);
  const end = applications.indexOf(to, start + from.length);
  assert.ok(end > start, `missing route boundary ${to}`);
  return applications.slice(start, end);
}

function ordered(source: string, needles: readonly string[]) {
  let prior = -1;
  for (const needle of needles) {
    const next = source.indexOf(needle, prior + 1);
    assert.ok(next > prior, `${needle} is missing or out of order`);
    prior = next;
  }
}

test('extension reservation closes the duplicate race under the shared attempt lock', () => {
  const start = routeSlice(
    "'/applications/:id/submission/extension-start'",
    "'/applications/:id/submission/extension-outcome'",
  );
  const transaction = start.slice(start.indexOf('const runExtensionStartTransaction'));
  ordered(transaction, [
    'await lockSubmissionAttemptUser(tx, userId)',
    'duplicateApplicationVerdict({',
    'canonicalApplicationForNewPacketAttempt(tx, {',
    'tx.update(generated_resumes)',
    "eventKind: 'attempt_opened'",
    'authorizeFinalSubmissionBoundary(binding',
    "evidenceCode: 'chrome_extension_employer_boundary_authorized'",
    "return { kind: 'started' as const",
  ]);
  assert.match(transaction, /sql`\$\{generated_resumes\.spec\} = \$\{JSON\.stringify\(precheckRow\.spec\)\}::jsonb`/);
});

test('extension outcome records press or typed uncertainty and confirms only exact receipts', () => {
  const outcome = routeSlice(
    "'/applications/:id/submission/extension-outcome'",
    "'/applications/:id/resume'",
  );
  ordered(outcome, [
    'await lockSubmissionAttemptUser(tx, request.jwtPayload!.userId)',
    "opening.source !== 'chrome_extension'",
    "eventKind: 'press_observed'",
    "evidenceCode: 'extension_submit_may_have_been_pressed'",
  ]);
  assert.match(outcome, /measuredPersistedReceiptMatchesOpening\(/);
  assert.match(outcome, /const safeOutcome = receiptIsAuthoritative \? 'confirmed' as const : 'unknown' as const/);
  assert.match(outcome, /The Chrome send capability was opened, but Litos did not receive proof that it stayed unused/);
  assert.match(outcome, /unverified_submission:/);
  assert.match(outcome, /eventKind: 'submission_confirmed'[\s\S]*?evidenceCode: 'extension_receipt_verified'/);
  assert.match(outcome, /authoritativeConfirmedProjectionMatches/);
  assert.doesNotMatch(outcome, /extension_cancelled_before_press/);
});

test('unsupported email reserves and records dispatch before the employer call', () => {
  const submit = routeSlice(
    "'/applications/:id/submit-request'",
    "'/applications/:id/submission/channels'",
  );
  const unsupported = submit.slice(submit.indexOf(
    'if (current.portal_url && !isPortalSupported(current.portal_url))',
  ));
  ordered(unsupported, [
    'const reservation = await db.transaction',
    'await lockSubmissionAttemptUser(tx, request.jwtPayload!.userId)',
    'duplicateApplicationVerdict({',
    'canonicalApplicationForNewPacketAttempt(tx, {',
    "eventKind: 'attempt_opened'",
    "evidenceCode: 'atomic_email_claim_reserved'",
    'authorizeFinalSubmissionBoundary(binding',
    "evidenceCode: 'unsupported_email_employer_boundary_authorized'",
    'await lockSubmissionAttemptUser(tx, reservation.binding.userId)',
    "eventKind: 'press_observed'",
    "evidenceCode: 'unsupported_email_dispatch_started'",
    'sent = await sendPreparedUnsupportedPortalApplicationEmail(preparedEmail)',
  ]);
  assert.match(unsupported, /latest\.resume_object_key !== row\.resume_object_key/);
  assert.match(unsupported, /!isDeepStrictEqual\(latest\.job_context, row\.job_context\)/);
});

test('a lost email provider response is retained as unresolved boundary risk', () => {
  const submit = routeSlice(
    "'/applications/:id/submit-request'",
    "'/applications/:id/submission/channels'",
  );
  const failureStart = submit.indexOf('} catch (error) {', submit.indexOf(
    'sendPreparedUnsupportedPortalApplicationEmail(preparedEmail)',
  ));
  const failureEnd = submit.indexOf('const submittedAt', failureStart);
  assert.ok(failureStart > 0 && failureEnd > failureStart);
  const failure = submit.slice(failureStart, failureEnd);
  assert.match(failure, /status: 'needs_attention'/);
  assert.match(failure, /submission_attempted_at: failedAt/);
  assert.match(failure, /unverified_submission:[\s\S]*?cause: 'provider_error'/);
  assert.match(failure, /UNSUPPORTED_PORTAL_EMAIL_OUTCOME_UNVERIFIED/);
  assert.doesNotMatch(failure, /submission_claimed_at: undefined|submission_claim_id: undefined/);
  assert.doesNotMatch(failure, /nothing (?:was|has been) sent/i);
  assert.doesNotMatch(failure, /not_sent_proven|status: 'failed'/);
});

test('one shared metadata and applicant-decision gate protects every send capability', () => {
  const extension = routeSlice(
    "'/applications/:id/submission/extension-start'",
    "'/applications/:id/submission/extension-outcome'",
  );
  const submit = routeSlice(
    "'/applications/:id/submit-request'",
    "'/applications/:id/submission/channels'",
  );
  const handoff = routeSlice(
    "'/applications/:id/submission/handoff-complete'",
    "'/applications/:id/submission/self-submitted'",
  );
  const approval = routeSlice(
    "'/applications/:id/submission/approve'",
    "'/applications/:id/security-code'",
  );
  const finalClick = runner.slice(
    runner.indexOf('async function submit(row: ResumeRow'),
    runner.indexOf('export type SecurityCodeSubmissionOutcome'),
  );
  for (const [name, source] of [
    ['extension', extension],
    ['email', submit],
    ['handoff', handoff],
    ['approval', approval],
    ['final click', finalClick],
  ] as const) {
    assert.match(source, /submissionQuestionGate\(/, `${name} does not use the shared gate`);
    assert.match(source, /metadataBlockerCount/, `${name} does not refuse metadata blockers`);
    assert.match(source, /requiredQuestionLabels/, `${name} does not refuse required answers`);
    assert.match(source, /optionalQuestionLabels/, `${name} does not require Answer or Skip`);
  }
});
