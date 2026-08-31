import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { ApplicationReviewState } from '../lib/applicationReview';
import type { SubmissionAttemptEventRecord } from '../lib/submissionAttemptLedger';
import {
  expiredAlternateSubmissionReview,
  extensionOutcomeBodySchema,
  extensionStartBodySchema,
  manualHandoffAvailable,
  reviewWithoutPassiveHandoffUrl,
} from './applications';

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
    "kind: 'started' as const",
  ]);
  assert.match(transaction, /sql`\$\{generated_resumes\.spec\} = \$\{JSON\.stringify\(precheckRow\.spec\)\}::jsonb`/);
});

test('extension activation schemas fail closed for clients that do not enforce the server lease', () => {
  const currentUrl = 'https://jobs.example.test/apply/42';
  const handoffVersion = 'f'.repeat(64);
  assert.equal(extensionStartBodySchema.safeParse({
    authorization: 'user_initiated',
    current_url: currentUrl,
    handoff_version: handoffVersion,
  }).success, false);
  assert.equal(extensionStartBodySchema.safeParse({
    authorization: 'user_initiated',
    activation_contract: 'server-lease-v1',
    current_url: currentUrl,
    handoff_version: handoffVersion,
  }).success, true);

  const legacyOutcome = {
    claim_id: 'b02dbb51-d173-476c-95dc-4abc8f1b1f96',
    outcome: 'unknown',
    final_url: currentUrl,
  };
  assert.equal(extensionOutcomeBodySchema.safeParse(legacyOutcome).success, false);
  assert.equal(extensionOutcomeBodySchema.safeParse({
    ...legacyOutcome,
    activation_contract: 'server-lease-v1',
    activation_id: '92332083-2e38-4805-a2bd-2335cd14fea4',
    activation_lease_id: '20efaf9e-506c-4fd3-9484-e16513ddc92e',
    activation_expires_at: '2026-08-31T10:05:00.000Z',
  }).success, true);
});

test('every alternate activation response includes the authoritative server clock', () => {
  const manual = routeSlice(
    "'/applications/:id/submission/manual-handoff'",
    "'/applications/:id/submission/extension-packet'",
  );
  const extension = routeSlice(
    "'/applications/:id/submission/extension-start'",
    "'/applications/:id/submission/extension-outcome'",
  );
  assert.match(manual, /activation_server_now: result\.authorization\.serverNow/);
  assert.match(extension, /activationServerNow: authorization\.authorization\.serverNow/);
  assert.match(extension, /activation_server_now: result\.activationServerNow/);
});

test('a retained session is exposed only after a fresh exact manual boundary and never during filling', () => {
  const manual = routeSlice(
    "'/applications/:id/submission/manual-handoff'",
    "'/applications/:id/submission/extension-packet'",
  );
  ordered(manual, [
    'await lockSubmissionAttemptUser(tx, userId)',
    "current.status === 'filling' && current.browser_session_id",
    'duplicateApplicationVerdict({',
    'canonicalApplicationForNewPacketAttempt(tx, {',
    'tx.update(generated_resumes)',
    "eventKind: 'attempt_opened'",
    'authorizeFinalSubmissionBoundary(binding',
    'retainedSessionUrl = await getLiveViewUrl(retainedSessionId)',
    "kind: 'authorized' as const",
    "result.kind === 'authorized' && result.retainedSessionId",
  ]);
  assert.match(manual, /code: 'MANUAL_HANDOFF_FILL_ACTIVE'/);
  assert.doesNotMatch(
    manual.slice(
      manual.indexOf('const result = await db.transaction'),
      manual.indexOf('authorizeFinalSubmissionBoundary(binding'),
    ),
    /getLiveViewUrl\(/,
  );
});

test('passive reviews never disclose employer handoff URLs', () => {
  const review = {
    jd_text: 'Role',
    status: 'needs_attention',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: '2026-08-31T10:00:00.000Z',
    extension_handoff_url: 'https://jobs.example.test/apply/42',
    extension_handoff_binding: {
      version: 'dashboard_handoff_v1',
      sha256: 'f'.repeat(64),
    },
  } as ApplicationReviewState;
  assert.equal(manualHandoffAvailable(review), true);
  const safe = reviewWithoutPassiveHandoffUrl(review);
  assert.equal(safe.extension_handoff_url, undefined);
  assert.equal(safe.extension_handoff_binding, undefined);
});

test('an expired alternate lease becomes one simple question and keeps its claim', () => {
  const attemptId = 'b02dbb51-d173-476c-95dc-4abc8f1b1f96';
  const observedAt = new Date('2026-08-31T10:00:00.000Z');
  const baseEvent = {
    id: '8fa6a1a4-f043-416f-b6bc-d62373f669af',
    user_id: 'cf48e921-8543-466c-b51f-1598fd723235',
    application_id: 'fd3a3c21-e8c2-4677-80e4-429d96a40cb9',
    packet_id: '0cf0dcee-b030-4dd8-aaf4-84df811da7c3',
    event_id: '8fa6a1a4-f043-416f-b6bc-d62373f669af',
    attempt_id: attemptId,
    parent_attempt_id: null,
    event_kind: 'attempt_opened',
    source: 'chrome_extension',
    operation: 'initial_submission',
    submission_run_id: null,
    submission_claim_id: attemptId,
    packet_version: 'f'.repeat(64),
    posting_key: null,
    job_id: null,
    company_role: 'example::engineer',
    company_name: 'Example',
    role: 'Engineer',
    portal_url: 'https://jobs.example.test/apply/42',
    portal_identity: null,
    proof_kind: null,
    evidence_code: 'atomic_extension_claim_reserved',
    boundary_activation_id: null,
    boundary_expires_at: null,
    observed_at: observedAt,
    created_at: observedAt,
  } as SubmissionAttemptEventRecord;
  const boundary = {
    ...baseEvent,
    id: '20efaf9e-506c-4fd3-9484-e16513ddc92e',
    event_id: '20efaf9e-506c-4fd3-9484-e16513ddc92e',
    event_kind: 'boundary_authorized',
    evidence_code: 'chrome_extension_employer_boundary_authorized',
    boundary_activation_id: '92332083-2e38-4805-a2bd-2335cd14fea4',
    boundary_expires_at: new Date('2026-08-31T10:05:00.000Z'),
    observed_at: new Date('2026-08-31T10:00:01.000Z'),
    created_at: new Date('2026-08-31T10:00:01.000Z'),
  } as SubmissionAttemptEventRecord;
  const press = {
    ...baseEvent,
    id: 'fb730938-b9a4-4809-b0ea-3526cf72ebcb',
    event_id: 'fb730938-b9a4-4809-b0ea-3526cf72ebcb',
    event_kind: 'press_observed',
    evidence_code: 'extension_submit_may_have_been_pressed',
    observed_at: new Date('2026-08-31T10:00:02.000Z'),
    created_at: new Date('2026-08-31T10:00:02.000Z'),
  } as SubmissionAttemptEventRecord;
  const review = {
    jd_text: 'Role',
    status: 'submitting',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: observedAt.toISOString(),
    portal_url: baseEvent.portal_url!,
    submission_claimed_at: observedAt.toISOString(),
    submission_claim_id: attemptId,
    submission_packet_version: baseEvent.packet_version!,
  } as ApplicationReviewState;

  assert.equal(expiredAlternateSubmissionReview(
    review,
    [baseEvent, boundary, press],
    new Date('2026-08-31T10:04:59.000Z'),
  ), null);
  const reconciled = expiredAlternateSubmissionReview(
    review,
    [baseEvent, boundary, press],
    new Date('2026-08-31T10:05:01.000Z'),
  );
  assert.ok(reconciled);
  assert.equal(reconciled.status, 'needs_attention');
  assert.equal(reconciled.submission_claim_id, attemptId);
  assert.equal(reconciled.attention_reason,
    'Did this application reach the employer? Choose Yes or No before Litos does anything else.');
  assert.deepEqual(reconciled.attention_categories, ['unverified_submission']);
  assert.equal(reconciled.unverified_submission?.resolution, undefined);
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
