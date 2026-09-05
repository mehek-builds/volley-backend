/* submissionAttemptRetrySafety's ADMISSIBILITY RULE, PINNED DIRECTLY, FOR THE FIRST TIME.
 *
 * The fold function itself had no direct test anywhere in the repo before this file: every other
 * test either constructs a SubmissionAttemptRetrySafety result as a fixture for some downstream
 * consumer, or exercises the fold indirectly through a route. That was fine while the function's
 * rule was simple ("her own post-expiry look is the only thing that may close an authorized
 * attempt"), and it stopped being fine the moment a SECOND kind of authorized-attempt closure
 * needed the same fold to admit it: employer_rejected_not_filed, written when the submit request's
 * own response - not the applicant, not the page's rendered state - proves the employer refused the
 * request before filing anything. See employerSubmitRefusalProof (managedSubmitOutcome.ts) for what
 * has to be true before that proof kind is ever written, and recordManagedAuthorizedAttemptRefused
 * (routes/submissionRunner.ts) for the one place that writes it.
 *
 * These tests pin the fold's behaviour on both sides of that change: the new proof kind closes an
 * authorized, pressed attempt exactly like her own "it is not there" does, and every OTHER proof
 * kind this PR did not touch keeps failing the same way it always did - a regression here would
 * either reopen the deadlock this PR exists to close, or quietly admit a proof kind nobody meant to
 * trust.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  submissionAttemptRetrySafety,
  type SubmissionAttemptEventKind,
  type SubmissionAttemptEventRecord,
  type SubmissionNotSentProofKind,
} from './submissionAttemptLedger';

const ATTEMPT = '7b3c1e88-4a2d-4f19-9c50-2e6a7d41b0c3';
const PACKET = '1d4c8113-6d99-4df8-9fcb-d6ae638e90bc';
const ACTIVATION = 'a1b2c3d4-e5f6-4789-9abc-def012345678';

const FIXTURE_BASE_MS = new Date('2026-09-04T00:00:00.000Z').getTime();
let fixtureSequence = 0;

/* Mirrors abandonedAttemptClosure.test.ts's own event() fixture builder: every field the fold's
 * vocabulary check reads is set explicitly, because leaving proof_kind/boundary_activation_id/
 * boundary_expires_at unset (rather than null) reads as "not null" and mis-files every fixture as
 * invalid_sequence before the behaviour under test ever runs. */
function event(
  kind: SubmissionAttemptEventKind,
  over: Partial<SubmissionAttemptEventRecord> = {},
): SubmissionAttemptEventRecord {
  fixtureSequence += 1;
  const at = new Date(FIXTURE_BASE_MS + fixtureSequence * 1000);
  return {
    id: `00000000-0000-0000-0000-${String(fixtureSequence).padStart(12, '0')}`,
    user_id: 'test-user',
    application_id: null,
    event_id: `00000000-0000-0000-0001-${String(fixtureSequence).padStart(12, '0')}`,
    event_kind: kind,
    attempt_id: ATTEMPT,
    parent_attempt_id: null,
    packet_id: PACKET,
    source: 'managed_browser',
    operation: 'initial_submission',
    submission_run_id: null,
    submission_claim_id: null,
    packet_version: null,
    posting_key: 'greenhouse:acme:12345',
    job_id: null,
    company_role: null,
    company_name: 'Acme',
    role: 'Software Engineer',
    portal_url: null,
    portal_identity: null,
    proof_kind: null,
    evidence_code: null,
    boundary_activation_id: null,
    boundary_expires_at: null,
    created_at: at,
    observed_at: at,
    ...over,
  } as unknown as SubmissionAttemptEventRecord;
}

/** attempt_opened -> boundary_authorized -> press_observed, the exact shape a real employer-bound
 * press leaves behind before any not_sent_proven fact is appended. */
function pressedAndAuthorized(): SubmissionAttemptEventRecord[] {
  const opened = event('attempt_opened');
  const authorized = event('boundary_authorized', {
    boundary_activation_id: ACTIVATION,
    boundary_expires_at: new Date(FIXTURE_BASE_MS + 999_000),
    evidence_code: 'managed_browser_employer_boundary_authorized',
  });
  const pressed = event('press_observed', { evidence_code: 'stratus_application_press_echoed' });
  return [opened, authorized, pressed];
}

function notSent(proofKind: SubmissionNotSentProofKind, evidenceCode: string): SubmissionAttemptEventRecord {
  return event('not_sent_proven', { proof_kind: proofKind, evidence_code: evidenceCode });
}

/** attempt_opened -> boundary_authorized, no press_observed - the exact shape measured 2026-09-05 on
 * Pony.ai application fdcf4ccb-eca9-44dc-b0cb-d400805ebdeb, ledger attempt b624e034: the send was
 * authorized and then died re-filling Workable's phone widget before confirmAndSubmit was reached. */
function authorizedNotPressed(): SubmissionAttemptEventRecord[] {
  const opened = event('attempt_opened');
  const authorized = event('boundary_authorized', {
    boundary_activation_id: ACTIVATION,
    boundary_expires_at: new Date(FIXTURE_BASE_MS + 999_000),
    evidence_code: 'managed_browser_employer_boundary_authorized',
  });
  return [opened, authorized];
}

describe('employer_rejected_not_filed closes an authorized, pressed attempt', () => {
  test('a proven employer refusal folds to safe_not_sent, exactly like her own look does', () => {
    const events = [
      ...pressedAndAuthorized(),
      notSent('employer_rejected_not_filed', 'employer_refusal_code:captcha-retry'),
    ];
    const safety = submissionAttemptRetrySafety(events);
    assert.equal(safety.kind, 'safe_not_sent',
      'a submit request the employer’s own response proved refused must not need her look too');
    if (safety.kind !== 'safe_not_sent') return;
    assert.equal(safety.proofKind, 'employer_rejected_not_filed');
    assert.equal(safety.attemptId, ATTEMPT);
  });

  test('it closes the attempt even with no press recorded yet (a pre-click refusal is not weaker proof)', () => {
    const opened = event('attempt_opened');
    const events = [opened, notSent('employer_rejected_not_filed', 'employer_refusal_status:428')];
    const safety = submissionAttemptRetrySafety(events);
    assert.equal(safety.kind, 'safe_not_sent');
  });

  test('a banner-only refusal (no code, evidence names the status) folds the same way', () => {
    const events = [
      ...pressedAndAuthorized(),
      notSent('employer_rejected_not_filed', 'employer_refusal_status:428'),
    ];
    const safety = submissionAttemptRetrySafety(events);
    assert.equal(safety.kind, 'safe_not_sent');
  });
});

describe('run_progress_proven_not_pressed closes an authorized attempt this run never pressed', () => {
  test('an authorized-but-unpressed attempt folds to safe_not_sent, like the other two machine witnesses', () => {
    const events = [
      ...authorizedNotPressed(),
      notSent('run_progress_proven_not_pressed', 'run_progress_proven_not_pressed'),
    ];
    const safety = submissionAttemptRetrySafety(events);
    assert.equal(safety.kind, 'safe_not_sent',
      'Stratus\'s own contained-transport proof for this run must not need her look too');
    if (safety.kind !== 'safe_not_sent') return;
    assert.equal(safety.proofKind, 'run_progress_proven_not_pressed');
    assert.equal(safety.attemptId, ATTEMPT);
  });

  test('it closes the attempt even with no authorization at all (proof about a run beats proof about the ledger)', () => {
    const opened = event('attempt_opened');
    const events = [opened, notSent('run_progress_proven_not_pressed', 'run_progress_proven_not_pressed')];
    const safety = submissionAttemptRetrySafety(events);
    assert.equal(safety.kind, 'safe_not_sent');
  });

  test('it cannot close an attempt a press actually happened on - the contradiction folds to invalid_sequence', () => {
    // This proof kind asserts the click never happened, exactly like typed_pre_click_stop and
    // extension_cancelled_before_press. A press event standing beside it on the same attempt is a
    // logical contradiction, not a race to resolve in the machine's favour.
    const events = [
      ...pressedAndAuthorized(),
      notSent('run_progress_proven_not_pressed', 'run_progress_proven_not_pressed'),
    ];
    const safety = submissionAttemptRetrySafety(events);
    assert.equal(safety.kind, 'blocked_unverified');
    if (safety.kind !== 'blocked_unverified') return;
    assert.equal(safety.reason, 'invalid_sequence');
  });
});

describe('the pre-existing rule is unchanged for every proof kind this PR did not touch', () => {
  test('her own post-expiry look still closes an authorized attempt (regression guard)', () => {
    const events = [...pressedAndAuthorized(), notSent('applicant_checked_not_sent', 'applicant_checked_not_sent')];
    const safety = submissionAttemptRetrySafety(events);
    assert.equal(safety.kind, 'safe_not_sent');
    if (safety.kind !== 'safe_not_sent') return;
    assert.equal(safety.proofKind, 'applicant_checked_not_sent');
  });

  test('a typed pre-click stop still cannot close an attempt a press happened on', () => {
    // typed_pre_click_stop is PRE_CLICK_ONLY: a press on the record contradicts it outright, and
    // this must keep failing however employer_rejected_not_filed is admitted.
    const events = [...pressedAndAuthorized(), notSent('typed_pre_click_stop', 'typed_pre_click_stop')];
    const safety = submissionAttemptRetrySafety(events);
    assert.equal(safety.kind, 'blocked_unverified');
    if (safety.kind !== 'blocked_unverified') return;
    assert.equal(safety.reason, 'invalid_sequence');
  });

  test('a proof kind this PR left untouched still cannot close an authorized attempt on its own', () => {
    // provider_definitive_rejection and employer_verification_pending_not_filed exist in the same
    // enum and are deliberately NOT in the authorization-admissible set this PR adds to - widening
    // admission to every not-sent proof kind at once is exactly the mistake this test catches.
    const events = [...pressedAndAuthorized(), notSent('provider_definitive_rejection', 'provider_said_so')];
    const safety = submissionAttemptRetrySafety(events);
    assert.equal(safety.kind, 'blocked_unverified');
    if (safety.kind !== 'blocked_unverified') return;
    assert.equal(safety.reason, 'invalid_sequence',
      'admitting every not-sent proof kind post-authorization would silently widen the rule this PR only means to widen for one named kind');
  });

  test('an attempt with no press or authorization at all still just reads as opened', () => {
    const safety = submissionAttemptRetrySafety([event('attempt_opened')]);
    assert.equal(safety.kind, 'blocked_unverified');
    if (safety.kind !== 'blocked_unverified') return;
    assert.equal(safety.reason, 'opened');
  });
});
