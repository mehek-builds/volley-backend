import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  blockingSubmissionAttemptsFromEvents,
  submissionLedgerReadiness,
  confirmedOrphanAttributionForParent,
  confirmedWeakPostingIdentityOpening,
  freezePostingIdentity,
  ORPHAN_ATTRIBUTION_CONFIRMATION_EVIDENCE,
  ORPHAN_ATTRIBUTION_OPENING_EVIDENCE,
  SUBMISSION_NOT_SENT_PROOF_KINDS,
  submissionAttemptEventId,
  submissionAttemptRetrySafety,
  submissionAttemptRetrySafetyForPacketEvents,
  type SubmissionAttemptEventKind,
  type SubmissionAttemptEventRecord,
  type SubmissionNotSentProofKind,
} from './submissionAttemptLedger';

const USER_ID = 'cb071b9b-6d53-44ec-89f5-19a06dc64a01';
const PACKET_ID = 'cb071b9b-6d53-44ec-89f5-19a06dc64a02';
const ATTEMPT_ONE = 'cb071b9b-6d53-44ec-89f5-19a06dc64a03';
const ATTEMPT_TWO = 'cb071b9b-6d53-44ec-89f5-19a06dc64a04';
const APPLICATION_ID = 'cb071b9b-6d53-44ec-89f5-19a06dc64a05';

function fact(
  attemptId: string,
  eventKind: SubmissionAttemptEventKind,
  second: number,
  input: {
    proofKind?: SubmissionNotSentProofKind;
    packetId?: string;
    postingKey?: string | null;
    role?: string;
    source?: string;
  } = {},
): SubmissionAttemptEventRecord {
  const at = new Date(`2026-08-24T12:00:${String(second).padStart(2, '0')}.000Z`);
  return {
    id: `cb071b9b-6d53-44ec-89f5-${String(100 + second).padStart(12, '0')}`,
    user_id: USER_ID,
    application_id: null,
    packet_id: input.packetId ?? PACKET_ID,
    event_id: `cb071b9b-6d53-44ec-89f5-${String(200 + second).padStart(12, '0')}`,
    attempt_id: attemptId,
    parent_attempt_id: null,
    event_kind: eventKind,
    source: input.source ?? 'managed_browser',
    operation: 'initial_submission',
    submission_run_id: 'run-one',
    submission_claim_id: 'claim-one',
    packet_version: 'packet-version-one',
    posting_key: input.postingKey === undefined ? 'greenhouse:example:123' : input.postingKey,
    job_id: 'job-one',
    company_role: 'example|engineer',
    company_name: 'Example',
    role: input.role ?? 'Engineer',
    portal_url: 'https://job-boards.greenhouse.io/example/jobs/123',
    portal_identity: 'https://job-boards.greenhouse.io',
    proof_kind: input.proofKind ?? null,
    evidence_code: null,
    boundary_activation_id: eventKind === 'boundary_authorized' ? ATTEMPT_TWO : null,
    boundary_expires_at: eventKind === 'boundary_authorized'
      ? new Date(at.getTime() + 3 * 60_000)
      : null,
    observed_at: at,
    created_at: at,
  };
}

function weakParentFact(
  eventKind: SubmissionAttemptEventKind,
  second: number,
  evidenceCode: string,
): SubmissionAttemptEventRecord {
  return {
    ...fact(ATTEMPT_ONE, eventKind, second, { postingKey: null }),
    application_id: APPLICATION_ID,
    job_id: null,
    portal_url: 'https://careers.example.com/jobs',
    portal_identity: 'https://careers.example.com',
    evidence_code: evidenceCode,
  };
}

function attributionChildFact(
  eventKind: Extract<SubmissionAttemptEventKind, 'attempt_opened' | 'submission_confirmed'>,
  second: number,
): SubmissionAttemptEventRecord {
  const identity = freezePostingIdentity(
    { company: 'Example', role: 'Engineer' },
    'https://apply.workable.com/example/j/EXACTPOST1/apply/',
  );
  return {
    ...fact(ATTEMPT_TWO, eventKind, second, { source: 'attended_handoff' }),
    application_id: APPLICATION_ID,
    parent_attempt_id: ATTEMPT_ONE,
    submission_run_id: null,
    submission_claim_id: null,
    packet_version: null,
    posting_key: identity.postingKey,
    job_id: identity.jobId,
    company_role: identity.companyRole,
    company_name: identity.company,
    role: identity.role,
    portal_url: identity.portalUrl,
    portal_identity: identity.portalIdentity,
    evidence_code: eventKind === 'attempt_opened'
      ? ORPHAN_ATTRIBUTION_OPENING_EVIDENCE
      : ORPHAN_ATTRIBUTION_CONFIRMATION_EVIDENCE,
  };
}

test('freezes the employer posting key across equivalent Greenhouse URL shapes', () => {
  const direct = freezePostingIdentity(
    { company: 'Akuna', role: 'Engineering Intern', job_id: 'ABC-123' },
    'https://job-boards.greenhouse.io/akunacapital/jobs/8018893',
  );
  const embedded = freezePostingIdentity(
    { company: 'akuna ', role: 'Engineering   Intern', job_id: 'abc-123' },
    'https://job-boards.greenhouse.io/embed/job_app?for=akunacapital&token=8018893',
  );
  assert.equal(direct.postingKey, 'greenhouse:akunacapital:8018893');
  assert.equal(embedded.postingKey, direct.postingKey);
  assert.equal(embedded.jobId, direct.jobId);
  assert.equal(embedded.companyRole, direct.companyRole);
  assert.equal(direct.portalIdentity, 'https://job-boards.greenhouse.io');
});

test('derives deterministic distinct UUID event ids for retry-safe facts', () => {
  const opened = submissionAttemptEventId(ATTEMPT_ONE, 'attempt_opened', 'dispatch');
  assert.equal(opened, submissionAttemptEventId(ATTEMPT_ONE, 'attempt_opened', 'dispatch'));
  assert.notEqual(opened, submissionAttemptEventId(ATTEMPT_ONE, 'press_observed', 'dispatch'));
  assert.notEqual(opened, submissionAttemptEventId(ATTEMPT_ONE, 'attempt_opened', 'other-dispatch'));
  assert.match(opened, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

describe('one-attempt retry safety', () => {
  test('every allowlisted not-sent proof closes an otherwise unopened-risk attempt', () => {
    for (const proofKind of SUBMISSION_NOT_SENT_PROOF_KINDS) {
      const safety = submissionAttemptRetrySafety([
        fact(ATTEMPT_ONE, 'attempt_opened', 1),
        fact(ATTEMPT_ONE, 'not_sent_proven', 2, { proofKind }),
      ]);
      assert.equal(safety.kind, 'safe_not_sent', proofKind);
      assert.equal(safety.kind === 'safe_not_sent' && safety.proofKind, proofKind);
    }
  });

  test('an opening fact blocks before any outcome exists', () => {
    assert.deepEqual(submissionAttemptRetrySafety([
      fact(ATTEMPT_ONE, 'attempt_opened', 1),
    ]), {
      kind: 'blocked_unverified',
      attemptId: ATTEMPT_ONE,
      at: '2026-08-24T12:00:01.000Z',
      reason: 'opened',
    });
  });

  test('a boundary authorization remains risk without pretending a press occurred', () => {
    assert.deepEqual(submissionAttemptRetrySafety([
      fact(ATTEMPT_ONE, 'attempt_opened', 1),
      fact(ATTEMPT_ONE, 'boundary_authorized', 2),
    ]), {
      kind: 'blocked_unverified',
      attemptId: ATTEMPT_ONE,
      at: '2026-08-24T12:00:02.000Z',
      reason: 'boundary_authorized',
      leaseId: 'cb071b9b-6d53-44ec-89f5-000000000202',
      expiresAt: '2026-08-24T12:03:02.000Z',
    });
  });

  test('a machine pre-click proof cannot close an authorized boundary', () => {
    assert.deepEqual(submissionAttemptRetrySafety([
      fact(ATTEMPT_ONE, 'attempt_opened', 1),
      fact(ATTEMPT_ONE, 'boundary_authorized', 2),
      fact(ATTEMPT_ONE, 'not_sent_proven', 3, { proofKind: 'extension_cancelled_before_press' }),
    ]), {
      kind: 'blocked_unverified',
      attemptId: ATTEMPT_ONE,
      at: '2026-08-24T12:00:02.000Z',
      reason: 'invalid_sequence',
    });
  });

  test('an applicant check may close an expired authorized boundary', () => {
    assert.deepEqual(submissionAttemptRetrySafety([
      fact(ATTEMPT_ONE, 'attempt_opened', 1),
      fact(ATTEMPT_ONE, 'boundary_authorized', 2),
      fact(ATTEMPT_ONE, 'not_sent_proven', 3, { proofKind: 'applicant_checked_not_sent' }),
    ]), {
      kind: 'safe_not_sent',
      attemptId: ATTEMPT_ONE,
      proofKind: 'applicant_checked_not_sent',
      resolvedAt: '2026-08-24T12:00:03.000Z',
    });
  });

  test('authorization after a not-sent fact fails closed as a contradictory sequence', () => {
    assert.deepEqual(submissionAttemptRetrySafety([
      fact(ATTEMPT_ONE, 'attempt_opened', 1),
      fact(ATTEMPT_ONE, 'not_sent_proven', 2, { proofKind: 'extension_cancelled_before_press' }),
      fact(ATTEMPT_ONE, 'boundary_authorized', 3),
    ]), {
      kind: 'blocked_unverified',
      attemptId: ATTEMPT_ONE,
      at: '2026-08-24T12:00:03.000Z',
      reason: 'invalid_sequence',
    });
  });

  test('typed pre-click proof closes an opened attempt', () => {
    assert.deepEqual(submissionAttemptRetrySafety([
      fact(ATTEMPT_ONE, 'attempt_opened', 1),
      fact(ATTEMPT_ONE, 'not_sent_proven', 2, { proofKind: 'typed_pre_click_stop' }),
    ]), {
      kind: 'safe_not_sent',
      attemptId: ATTEMPT_ONE,
      proofKind: 'typed_pre_click_stop',
      resolvedAt: '2026-08-24T12:00:02.000Z',
    });
  });

  test('a press contradicts pre-click proof and fails closed', () => {
    assert.deepEqual(submissionAttemptRetrySafety([
      fact(ATTEMPT_ONE, 'attempt_opened', 1),
      fact(ATTEMPT_ONE, 'press_observed', 2),
      fact(ATTEMPT_ONE, 'not_sent_proven', 3, { proofKind: 'typed_pre_click_stop' }),
    ]), {
      kind: 'blocked_unverified',
      attemptId: ATTEMPT_ONE,
      at: '2026-08-24T12:00:02.000Z',
      reason: 'invalid_sequence',
    });
  });

  test('the applicant can resolve the exact pressed attempt as not sent', () => {
    assert.deepEqual(submissionAttemptRetrySafety([
      fact(ATTEMPT_ONE, 'attempt_opened', 1),
      fact(ATTEMPT_ONE, 'press_observed', 2),
      fact(ATTEMPT_ONE, 'not_sent_proven', 3, { proofKind: 'applicant_checked_not_sent' }),
    ]), {
      kind: 'safe_not_sent',
      attemptId: ATTEMPT_ONE,
      proofKind: 'applicant_checked_not_sent',
      resolvedAt: '2026-08-24T12:00:03.000Z',
    });
  });

  test('an employer verification challenge proves the pressed form was not filed yet', () => {
    assert.deepEqual(submissionAttemptRetrySafety([
      fact(ATTEMPT_ONE, 'attempt_opened', 1),
      fact(ATTEMPT_ONE, 'press_observed', 2),
      fact(ATTEMPT_ONE, 'not_sent_proven', 3, {
        proofKind: 'employer_verification_pending_not_filed',
      }),
    ]), {
      kind: 'safe_not_sent',
      attemptId: ATTEMPT_ONE,
      proofKind: 'employer_verification_pending_not_filed',
      resolvedAt: '2026-08-24T12:00:03.000Z',
    });
  });

  test('confirmation wins over a contradictory not-sent fact', () => {
    assert.deepEqual(submissionAttemptRetrySafety([
      fact(ATTEMPT_ONE, 'attempt_opened', 1),
      fact(ATTEMPT_ONE, 'press_observed', 2),
      fact(ATTEMPT_ONE, 'not_sent_proven', 3, { proofKind: 'applicant_checked_not_sent' }),
      fact(ATTEMPT_ONE, 'submission_confirmed', 4),
    ]), {
      kind: 'blocked_confirmed',
      attemptId: ATTEMPT_ONE,
      confirmedAt: '2026-08-24T12:00:04.000Z',
    });
  });

  test('a changed frozen binding is invalid rather than a different posting', () => {
    assert.equal(submissionAttemptRetrySafety([
      fact(ATTEMPT_ONE, 'attempt_opened', 1),
      fact(ATTEMPT_ONE, 'press_observed', 2, { role: 'Different role' }),
    ]).kind, 'blocked_unverified');
    assert.equal(
      (submissionAttemptRetrySafety([
        fact(ATTEMPT_ONE, 'attempt_opened', 1),
        fact(ATTEMPT_ONE, 'press_observed', 2, { role: 'Different role' }),
      ]) as { reason: string }).reason,
      'invalid_sequence',
    );
  });

  test('a confirmation on a conflicting binding never overrides invalid attribution', () => {
    const events = [
      fact(ATTEMPT_ONE, 'attempt_opened', 1),
      fact(ATTEMPT_ONE, 'submission_confirmed', 2, {
        packetId: 'cb071b9b-6d53-44ec-89f5-19a06dc64aff',
        postingKey: 'greenhouse:other:999',
        role: 'Different role',
      }),
    ];
    assert.deepEqual(submissionAttemptRetrySafety(events), {
      kind: 'blocked_unverified',
      attemptId: ATTEMPT_ONE,
      at: '2026-08-24T12:00:01.000Z',
      reason: 'invalid_sequence',
    });
    const [blocked] = blockingSubmissionAttemptsFromEvents(events);
    assert.ok(blocked);
    assert.deepEqual(blocked.postingIdentity, {
      postingKey: null,
      jobId: null,
      companyRole: null,
      company: '',
      role: '',
      portalUrl: null,
      portalIdentity: null,
    }, 'a corrupt attempt must become unidentifiable instead of borrowing its first posting');
  });
});

describe('packet retry safety across attempts', () => {
  test('a later safe attempt cannot erase an older unresolved press', () => {
    const safety = submissionAttemptRetrySafetyForPacketEvents([
      fact(ATTEMPT_ONE, 'attempt_opened', 1),
      fact(ATTEMPT_ONE, 'press_observed', 2),
      fact(ATTEMPT_TWO, 'attempt_opened', 3),
      fact(ATTEMPT_TWO, 'not_sent_proven', 4, { proofKind: 'typed_pre_click_stop' }),
    ]);
    assert.deepEqual(safety, {
      kind: 'blocked_unverified',
      attemptId: ATTEMPT_ONE,
      at: '2026-08-24T12:00:02.000Z',
      reason: 'pressed',
    });
  });

  test('a newer unresolved attempt blocks after an older attempt was safely resolved', () => {
    const safety = submissionAttemptRetrySafetyForPacketEvents([
      fact(ATTEMPT_ONE, 'attempt_opened', 1),
      fact(ATTEMPT_ONE, 'not_sent_proven', 2, { proofKind: 'typed_pre_click_stop' }),
      fact(ATTEMPT_TWO, 'attempt_opened', 3),
    ]);
    assert.deepEqual(safety, {
      kind: 'blocked_unverified',
      attemptId: ATTEMPT_TWO,
      at: '2026-08-24T12:00:03.000Z',
      reason: 'opened',
    });
  });

  test('any confirmed attempt outranks unresolved and safe attempts', () => {
    const safety = submissionAttemptRetrySafetyForPacketEvents([
      fact(ATTEMPT_ONE, 'attempt_opened', 1),
      fact(ATTEMPT_ONE, 'submission_confirmed', 2),
      fact(ATTEMPT_TWO, 'attempt_opened', 3),
    ]);
    assert.equal(safety.kind, 'blocked_confirmed');
    assert.equal(safety.kind === 'blocked_confirmed' && safety.attemptId, ATTEMPT_ONE);
  });
});

describe('confirmed weak posting attribution eligibility', () => {
  test('a managed verification attempt with two coherent presses can still be narrowed', () => {
    const parent = [
      weakParentFact('attempt_opened', 1, 'managed_browser_attempt_opened'),
      weakParentFact('press_observed', 2, 'stratus_application_press_echoed'),
      weakParentFact('press_observed', 3, 'stratus_verification_press_echoed'),
      weakParentFact('submission_confirmed', 4, 'managed_receipt_verified'),
    ];
    const child = [
      attributionChildFact('attempt_opened', 5),
      attributionChildFact('submission_confirmed', 6),
    ];

    assert.equal(confirmedWeakPostingIdentityOpening(parent)?.attempt_id, ATTEMPT_ONE);
    assert.equal(
      confirmedOrphanAttributionForParent([...parent, ...child], ATTEMPT_ONE)?.attemptId,
      ATTEMPT_TWO,
    );
    assert.deepEqual(
      blockingSubmissionAttemptsFromEvents([...parent, ...child]).map((attempt) => attempt.attemptId),
      [ATTEMPT_TWO],
      'the exact confirmed child must keep blocking while the weak parent stops blocking every posting',
    );
  });

  test('a later independent confirmation does not resurrect an already attributed global hold', () => {
    const parent = [
      weakParentFact('attempt_opened', 1, 'managed_browser_attempt_opened'),
      weakParentFact('submission_confirmed', 2, 'managed_receipt_verified'),
      weakParentFact('submission_confirmed', 3, 'employer_confirmation_email_received'),
    ];
    const child = [
      attributionChildFact('attempt_opened', 4),
      attributionChildFact('submission_confirmed', 5),
    ];

    assert.equal(confirmedWeakPostingIdentityOpening(parent)?.attempt_id, ATTEMPT_ONE);
    assert.equal(
      confirmedOrphanAttributionForParent([...parent, ...child], ATTEMPT_ONE)?.attemptId,
      ATTEMPT_TWO,
    );
    assert.deepEqual(
      blockingSubmissionAttemptsFromEvents([...parent, ...child]).map((attempt) => attempt.attemptId),
      [ATTEMPT_TWO],
    );
  });

  test('extra openings and conflicting immutable bindings remain ineligible', () => {
    const extraOpening = [
      weakParentFact('attempt_opened', 1, 'first-opening'),
      weakParentFact('attempt_opened', 2, 'second-opening'),
      weakParentFact('submission_confirmed', 3, 'confirmation'),
    ];
    assert.equal(confirmedWeakPostingIdentityOpening(extraOpening), null);

    const conflictingBinding = [
      weakParentFact('attempt_opened', 1, 'opening'),
      {
        ...weakParentFact('submission_confirmed', 2, 'confirmation'),
        packet_id: 'cb071b9b-6d53-44ec-89f5-19a06dc64aff',
      },
    ];
    assert.equal(confirmedWeakPostingIdentityOpening(conflictingBinding), null);
  });
});


/* A HEALTH PROBE THAT CAN HANG IS THE OUTAGE IT EXISTS TO REPORT.
 *
 * This probe reads a ledger table through the same pool every request uses, and on Vercel that pool
 * is a single client with no connectionTimeoutMillis, so it queues behind any open transaction.
 * Unbounded, it would reproduce on /health the exact pool-exhaustion hang that was just removed
 * from the submission path, on the one page an incident needs working. It must always answer, and
 * a stray timer must not keep a serverless invocation billable after the response is sent. */
describe('submission ledger readiness probe', () => {
  test('a hanging pool still answers, and answers unready', async () => {
    const started = Date.now();
    const hangs = { select: () => ({ from: () => ({ limit: () => new Promise(() => {}) }) }) };
    const readiness = await submissionLedgerReadiness(hangs as never, 40);
    assert.deepEqual(readiness, { ready: false, reason: 'unreadable' });
    assert.ok(Date.now() - started < 2_000, 'the probe must time out rather than wait on the pool');
  });

  test('a missing relation reads as unready, never as a thrown health endpoint', async () => {
    const missing = {
      select: () => ({
        from: () => ({
          limit: () => Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' })),
        }),
      }),
    };
    assert.deepEqual(await submissionLedgerReadiness(missing as never, 5_000), {
      ready: false,
      reason: 'unreadable',
    });
  });

  test('the migration marker is what makes it ready', async () => {
    const migrated = { select: () => ({ from: () => ({ limit: () => Promise.resolve([{ cutover_key: 'legacy_backfill_v1' }]) }) }) };
    assert.deepEqual(await submissionLedgerReadiness(migrated as never, 5_000), {
      ready: true,
      reason: 'cutover_recorded',
    });
    const empty = { select: () => ({ from: () => ({ limit: () => Promise.resolve([]) }) }) };
    assert.deepEqual(await submissionLedgerReadiness(empty as never, 5_000), {
      ready: false,
      reason: 'not_migrated',
    });
  });
});
