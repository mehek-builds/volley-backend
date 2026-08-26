import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extensionAttemptBindingMatches,
  exactAttemptPermanentlyBlocksNegativeResolution,
  ledgerBlockedUnverifiedProjection,
  mergeSubmissionRetrySafety,
  resolvedUnverifiedAttemptReplayMatches,
  unverifiedLedgerRecoveryClaimIsStale,
} from './applications';
import type { ApplicationReviewState } from '../lib/applicationReview';
import {
  freezePostingIdentity,
  type SubmissionAttemptBinding,
  type SubmissionAttemptEventRecord,
} from '../lib/submissionAttemptLedger';

const ATTEMPT_ID = 'e9e7c7e0-d0ae-4e65-93d4-620e27eac030';
const RESOLVED_AT = '2026-08-24T10:00:00.000Z';

test('every live employer boundary permanently vetoes retry B while legacy backfill remains resolvable', () => {
  const liveSources = [
    'managed_browser',
    'direct_browser',
    'unsupported_email',
    'ats_api',
    'chrome_extension',
    'attended_handoff',
  ];
  const boundaryEvents = (source: string) => ([
    { attempt_id: ATTEMPT_ID, event_kind: 'attempt_opened', source },
    { attempt_id: ATTEMPT_ID, event_kind: 'boundary_authorized', source },
  ] as SubmissionAttemptEventRecord[]);
  for (const source of liveSources) {
    assert.equal(
      exactAttemptPermanentlyBlocksNegativeResolution(boundaryEvents(source), ATTEMPT_ID),
      true,
      `${source} must never expose a second employer-capable attempt after response loss`,
    );
    assert.equal(
      exactAttemptPermanentlyBlocksNegativeResolution([
        { attempt_id: ATTEMPT_ID, event_kind: 'attempt_opened', source },
        { attempt_id: ATTEMPT_ID, event_kind: 'press_observed', source },
      ] as SubmissionAttemptEventRecord[], ATTEMPT_ID),
      true,
      `${source} press evidence must permanently preserve duplicate risk`,
    );
  }
  assert.equal(
    exactAttemptPermanentlyBlocksNegativeResolution(boundaryEvents('legacy_backfill'), ATTEMPT_ID),
    false,
  );
  assert.equal(
    exactAttemptPermanentlyBlocksNegativeResolution([
      { attempt_id: ATTEMPT_ID, event_kind: 'attempt_opened', source: 'legacy_backfill' },
      { attempt_id: ATTEMPT_ID, event_kind: 'press_observed', source: 'legacy_backfill' },
    ] as SubmissionAttemptEventRecord[], ATTEMPT_ID),
    false,
    'a drained historical press must have an applicant-controlled not-sent resolution',
  );
  assert.equal(
    exactAttemptPermanentlyBlocksNegativeResolution([
      { attempt_id: ATTEMPT_ID, event_kind: 'attempt_opened', source: 'legacy_backfill' },
      { attempt_id: ATTEMPT_ID, event_kind: 'submission_confirmed', source: 'legacy_backfill' },
    ] as SubmissionAttemptEventRecord[], ATTEMPT_ID),
    true,
    'positive historical evidence must remain permanent despite the legacy exception',
  );
});

function event(input: {
  attemptId?: string;
  kind: 'submission_confirmed' | 'not_sent_proven';
  evidence: string;
  at?: string;
}) {
  return {
    attempt_id: input.attemptId ?? ATTEMPT_ID,
    event_kind: input.kind,
    evidence_code: input.evidence,
    observed_at: new Date(input.at ?? RESOLVED_AT),
  };
}

test('a lost found-false response replays against the same immutable attempt', () => {
  const pending = {
    at: '2026-08-24T09:55:00.000Z',
    cause: 'no_confirmation_state' as const,
    resolution: 'not_sent' as const,
    resolved_at: RESOLVED_AT,
  };
  assert.equal(resolvedUnverifiedAttemptReplayMatches(pending, ATTEMPT_ID, [event({
    kind: 'not_sent_proven',
    evidence: 'applicant_checked_not_sent',
  })]), true);
});

test('a replay cannot borrow another attempt or a different resolution fact', () => {
  const pending = {
    at: '2026-08-24T09:55:00.000Z',
    cause: 'no_confirmation_state' as const,
    resolution: 'not_sent' as const,
    resolved_at: RESOLVED_AT,
  };
  assert.equal(resolvedUnverifiedAttemptReplayMatches(pending, ATTEMPT_ID, [event({
    attemptId: '693bbb03-3b50-425e-a651-b3f929112c60',
    kind: 'not_sent_proven',
    evidence: 'applicant_checked_not_sent',
  })]), false);
  assert.equal(resolvedUnverifiedAttemptReplayMatches(pending, ATTEMPT_ID, [event({
    kind: 'submission_confirmed',
    evidence: 'applicant_found_submission',
  })]), false);
  assert.equal(resolvedUnverifiedAttemptReplayMatches(pending, ATTEMPT_ID, [event({
    kind: 'not_sent_proven',
    evidence: 'applicant_checked_not_sent',
    at: '2026-08-24T10:00:01.000Z',
  })]), false);
});

test('a safe ledger fact cannot mask a later mutable submitted or unverified state', () => {
  const safe = {
    kind: 'safe_not_sent' as const,
    attemptId: ATTEMPT_ID,
    proofKind: 'applicant_checked_not_sent' as const,
    resolvedAt: RESOLVED_AT,
  };
  const submitted = {
    kind: 'blocked_confirmed' as const,
    attemptId: '838bc722-670c-4a5c-9342-871d59b80f45',
    confirmedAt: '2026-08-24T10:01:00.000Z',
  };
  const unverified = {
    kind: 'blocked_unverified' as const,
    attemptId: '9c962c4d-cee7-4e42-9355-e0c529e25b00',
    at: '2026-08-24T10:02:00.000Z',
    reason: 'pressed' as const,
  };
  assert.deepEqual(mergeSubmissionRetrySafety(safe, submitted), submitted);
  assert.deepEqual(mergeSubmissionRetrySafety(safe, unverified), unverified);
});

for (const reason of ['opened', 'pressed'] as const) {
  test(`an attempt killed after ${reason} remains directly resolvable from its ledger fact`, () => {
    const at = reason === 'opened' ? '2026-08-24T10:03:00.000Z' : '2026-08-24T10:03:01.000Z';
    assert.deepEqual(ledgerBlockedUnverifiedProjection(
      { portal_url: 'https://jobs.example.test/posting/123' },
      { kind: 'blocked_unverified', attemptId: ATTEMPT_ID, at, reason },
      ATTEMPT_ID,
      {
        attempt_id: ATTEMPT_ID,
        event_kind: 'attempt_opened',
        observed_at: new Date('2026-08-24T10:03:00.000Z'),
        submission_run_id: 'run-a',
      },
    ), {
      at,
      cause: 'provider_error',
      portal_url: 'https://jobs.example.test/posting/123',
      submission_run_id: 'run-a',
    });
  });
}

test('a managed-browser attempt id cannot be used as a generated extension outcome', () => {
  const row = {
    id: '327291f1-a491-48a4-aa8b-df4233e07f77',
    user_id: '2394efc6-d9e1-46cd-a88c-08f12ea4b809',
    job_context: { job_id: 'job-1', company: 'Max Borges Agency', role: 'Account Manager' },
  } as Parameters<typeof extensionAttemptBindingMatches>[0];
  const review: ApplicationReviewState = {
    jd_text: 'Account Manager',
    status: 'submitting',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: RESOLVED_AT,
    portal_url: 'https://apply.workable.com/max-borges-agency/j/ABC123/',
    submission_run_id: '90e23250-035e-4c52-96b7-d7a9548713b3',
    submission_claim_id: ATTEMPT_ID,
    submission_packet_version: 'packet-v1',
  };
  const extensionBinding: SubmissionAttemptBinding = {
    attemptId: ATTEMPT_ID,
    userId: row.user_id,
    packetId: row.id,
    source: 'chrome_extension',
    operation: 'initial_submission',
    postingIdentity: freezePostingIdentity(row.job_context, review.portal_url),
    submissionRunId: review.submission_run_id,
    submissionClaimId: ATTEMPT_ID,
    packetVersion: review.submission_packet_version,
  };
  assert.equal(extensionAttemptBindingMatches(row, review, ATTEMPT_ID, extensionBinding), true);
  assert.equal(extensionAttemptBindingMatches(row, review, ATTEMPT_ID, {
    ...extensionBinding,
    source: 'managed_browser',
  }), false);
  assert.equal(extensionAttemptBindingMatches(row, review, ATTEMPT_ID, {
    ...extensionBinding,
    operation: 'security_code_continuation',
  }), false);
  assert.equal(extensionAttemptBindingMatches(row, review, ATTEMPT_ID, {
    ...extensionBinding,
    packetId: '72f4a6e3-1ea2-4f3d-a71e-ee3d928df42b',
  }), false);
});

test('ledger-only recovery refuses a live claim and admits only a bounded stale claim', () => {
  const now = new Date('2026-08-24T10:30:00.000Z');
  assert.equal(unverifiedLedgerRecoveryClaimIsStale({
    status: 'submitting',
    submission_claimed_at: '2026-08-24T10:20:00.000Z',
  }, now), false);
  assert.equal(unverifiedLedgerRecoveryClaimIsStale({
    status: 'submitting',
    submission_claimed_at: '2026-08-24T10:15:00.000Z',
  }, now), true);
  assert.equal(unverifiedLedgerRecoveryClaimIsStale({ status: 'submitting' }, now), false);
  assert.equal(unverifiedLedgerRecoveryClaimIsStale({ status: 'needs_attention' }, now), true);
});
