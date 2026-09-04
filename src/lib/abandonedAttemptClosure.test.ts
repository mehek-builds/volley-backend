/* THE DATABRICKS BLOCK, AND WHY IT NEEDED NEITHER A CLOCK NOR THE APPLICANT.
 *
 * MEASURED 2026-09-03. Databricks "Software Engineering Intern (2027 Start) - Winter", canonical
 * application 1d4c8113. The send was refused because an earlier attempt on the same posting folds
 * to blocked_unverified/'opened', and the refusal told the applicant to open that attempt in her
 * Tracker, check the employer's page, and report back. The Tracker had been removed, so the remedy
 * named a surface that did not exist; but the deeper defect is that the errand was never real. The
 * attempt carries `attempt_opened` and nothing else, which is the ledger PROVING no application
 * reached that employer. There was nothing on the page to find.
 *
 * WHAT THESE TESTS REFUSE TO ASSERT. They do not assert that an old block comes off. A boundary
 * authorization is durable employer risk and must keep blocking at any age, and an attempt that is
 * still the packet's live claim belongs to stalledSubmittingClaimIsReleasable, which pays a
 * wall-clock bound for its certainty. Both are pinned here beside the closable cases so a later
 * change cannot widen one without breaking the other.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  abandonedPreBoundaryAttemptIsClosable,
  type AbandonedAttemptClosurePacketReview,
} from './abandonedAttemptClosure';
import {
  attemptNeverReachedEmployer,
  type SubmissionAttemptEventKind,
  type SubmissionAttemptEventRecord,
} from './submissionAttemptLedger';

const ATTEMPT = '7b3c1e88-4a2d-4f19-9c50-2e6a7d41b0c3';
const OTHER_ATTEMPT = 'e2f4a900-1c6b-4d83-8a17-5b0c93de7f24';
const PACKET = '1d4c8113-6d99-4df8-9fcb-d6ae638e90bc';

function event(
  kind: SubmissionAttemptEventKind,
  over: Partial<SubmissionAttemptEventRecord> = {},
): SubmissionAttemptEventRecord {
  return {
    event_kind: kind,
    attempt_id: ATTEMPT,
    packet_id: PACKET,
    ...over,
  } as unknown as SubmissionAttemptEventRecord;
}

const OPENED_ONLY = [event('attempt_opened')];
const OPENED_AND_AUTHORIZED = [event('attempt_opened'), event('boundary_authorized')];
const OPENED_AND_PRESSED = [
  event('attempt_opened'),
  event('boundary_authorized'),
  event('press_observed'),
];

/* A review with no status opinion of its own and no send evidence at all - the shape that must
 * never be the thing standing between a provably-dead attempt and closing it. */
const BENIGN_REVIEW: AbandonedAttemptClosurePacketReview = { status: 'needs_attention' };
const SUBMITTED_REVIEW: AbandonedAttemptClosurePacketReview = { status: 'submitted' };

const NO_CLAIM = { claimId: null, review: BENIGN_REVIEW };
const MOVED_TO_OTHER_ATTEMPT = { claimId: OTHER_ATTEMPT, review: BENIGN_REVIEW };
const STILL_THIS_ATTEMPT = { claimId: ATTEMPT, review: BENIGN_REVIEW };

describe('the Databricks class closes with no applicant and no clock', () => {
  test('an opened-only attempt whose packet has dropped the claim is closable', () => {
    assert.equal(attemptNeverReachedEmployer(OPENED_ONLY), true);
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({ attemptEvents: OPENED_ONLY, packet: NO_CLAIM }),
      true,
    );
  });

  test('an opened-only attempt whose packet has moved on to a different claim is closable', () => {
    /* The run that opened this one ended when the packet took a new claim. Nothing is executing it,
     * and nothing ever will, so the block it casts over the posting is pure residue. */
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: OPENED_ONLY,
        packet: MOVED_TO_OTHER_ATTEMPT,
      }),
      true,
    );
  });
});

describe('an unknown packet refuses, and is never read as "no claim"', () => {
  test('a packet row that could not be read - deleted, or its spec unparseable - is refused', () => {
    /* Review round 1: the first cut of this predicate took `packetClaimId: string | null | undefined`
     * and folded a missing or unreadable row down to `null`, which read exactly like a packet that
     * was read fine and simply holds no claim. Those are not the same fact. A row this function
     * could not read says nothing about whether some other run still holds it, so `packet: null` has
     * to refuse - the opposite of what a dropped claim proves - or a deleted packet row would close
     * an attempt that may still be live. */
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({ attemptEvents: OPENED_ONLY, packet: null }),
      false,
    );
  });
});

describe('a legacy_backfill opening needs the packet review to prove it too', () => {
  /* attemptNeverReachedEmployer is arithmetic over event kinds: one attempt_opened, nothing else.
   * That is true of every legacy_backfill row by CONSTRUCTION of the 2026-08-27T14:11:35.408Z
   * migration that wrote them, whether or not the run it describes ever crossed the boundary. The
   * packet's own current review is the second, independent proof. */
  const LEGACY_OPENED_ONLY = [event('attempt_opened', { source: 'legacy_backfill' })];

  test('a legacy_backfill opening on a packet whose review says submitted is not closable', () => {
    assert.equal(attemptNeverReachedEmployer(LEGACY_OPENED_ONLY), true, 'the event vocabulary alone still reads as pre-boundary');
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: LEGACY_OPENED_ONLY,
        packet: { claimId: null, review: SUBMITTED_REVIEW },
      }),
      false,
    );
  });

  test('a legacy_backfill opening on a packet whose review is needs_attention with no attempted_at is closable', () => {
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: LEGACY_OPENED_ONLY,
        packet: { claimId: null, review: BENIGN_REVIEW },
      }),
      true,
    );
  });

  test('a standing submission_attempted_at refuses even when unverified_submission resolves not_sent', () => {
    /* employerMayHoldApplication alone would read this as safe - her own look neutralises the
     * unverified record and its sibling attempted_at together. This closure is not her look, so it
     * asks submission_attempted_at again on its own and refuses regardless of the resolution. */
    const review: AbandonedAttemptClosurePacketReview = {
      status: 'needs_attention',
      submission_attempted_at: '2026-08-20T10:00:00.000Z',
      unverified_submission: {
        resolution: 'not_sent',
      } as unknown as AbandonedAttemptClosurePacketReview['unverified_submission'],
    };
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: LEGACY_OPENED_ONLY,
        packet: { claimId: null, review },
      }),
      false,
    );
  });

  test('a security_code wall refuses, even though it never touched this run', () => {
    const review: AbandonedAttemptClosurePacketReview = {
      status: 'needs_attention',
      security_code: {} as unknown as AbandonedAttemptClosurePacketReview['security_code'],
    };
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: LEGACY_OPENED_ONLY,
        packet: { claimId: null, review },
      }),
      false,
    );
  });
});

describe('the live claim is left to the predicate that pays a clock for it', () => {
  test('an attempt that is still the packet claim is never closed here', () => {
    /* claimSubmission writes submission_claim_id and appends attempt_opened in one transaction, so
     * a matching claim means a run may still be executing this attempt. Closing it here would be
     * the poll-kills-the-send defect, arrived at from a different direction. */
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({ attemptEvents: OPENED_ONLY, packet: STILL_THIS_ATTEMPT }),
      false,
    );
  });
});

describe('the ledger proof is never relaxed', () => {
  test('a boundary authorization keeps blocking however abandoned the attempt is', () => {
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: OPENED_AND_AUTHORIZED,
        packet: NO_CLAIM,
      }),
      false,
    );
  });

  test('an observed press keeps blocking', () => {
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({ attemptEvents: OPENED_AND_PRESSED, packet: NO_CLAIM }),
      false,
    );
  });

  test('a confirmed attempt is not this closure to touch', () => {
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: [event('attempt_opened'), event('submission_confirmed')],
        packet: NO_CLAIM,
      }),
      false,
    );
  });

  test('an already closed attempt is a no-op, which is what makes the heal idempotent', () => {
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: [event('attempt_opened'), event('not_sent_proven')],
        packet: NO_CLAIM,
      }),
      false,
    );
  });

  test('an empty ledger and a malformed attempt are both refused', () => {
    assert.equal(abandonedPreBoundaryAttemptIsClosable({ attemptEvents: [], packet: NO_CLAIM }), false);
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: [event('attempt_opened'), event('attempt_opened')],
        packet: NO_CLAIM,
      }),
      false,
    );
  });

  test('events from two attempts are never folded into one closure', () => {
    /* Refused, though not by the coherence check itself: two openings already fail
     * attemptNeverReachedEmployer. Asserted anyway because the OUTCOME is the contract, and the
     * belt-and-braces check in the predicate is declared as a mutation survivor rather than
     * pretended to be load-bearing. */
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: [event('attempt_opened'), event('attempt_opened', { attempt_id: OTHER_ATTEMPT })],
        packet: NO_CLAIM,
      }),
      false,
    );
  });
});
