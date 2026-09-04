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
import { abandonedPreBoundaryAttemptIsClosable } from './abandonedAttemptClosure';
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

describe('the Databricks class closes with no applicant and no clock', () => {
  test('an opened-only attempt whose packet has dropped the claim is closable', () => {
    assert.equal(attemptNeverReachedEmployer(OPENED_ONLY), true);
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({ attemptEvents: OPENED_ONLY, packetClaimId: null }),
      true,
    );
  });

  test('an opened-only attempt whose packet has moved on to a different claim is closable', () => {
    /* The run that opened this one ended when the packet took a new claim. Nothing is executing it,
     * and nothing ever will, so the block it casts over the posting is pure residue. */
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: OPENED_ONLY,
        packetClaimId: OTHER_ATTEMPT,
      }),
      true,
    );
  });

  test('an undefined claim reads the same as an absent one', () => {
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({ attemptEvents: OPENED_ONLY, packetClaimId: undefined }),
      true,
    );
  });
});

describe('the live claim is left to the predicate that pays a clock for it', () => {
  test('an attempt that is still the packet claim is never closed here', () => {
    /* claimSubmission writes submission_claim_id and appends attempt_opened in one transaction, so
     * a matching claim means a run may still be executing this attempt. Closing it here would be
     * the poll-kills-the-send defect, arrived at from a different direction. */
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({ attemptEvents: OPENED_ONLY, packetClaimId: ATTEMPT }),
      false,
    );
  });
});

describe('the ledger proof is never relaxed', () => {
  test('a boundary authorization keeps blocking however abandoned the attempt is', () => {
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: OPENED_AND_AUTHORIZED,
        packetClaimId: null,
      }),
      false,
    );
  });

  test('an observed press keeps blocking', () => {
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({ attemptEvents: OPENED_AND_PRESSED, packetClaimId: null }),
      false,
    );
  });

  test('a confirmed attempt is not this closure to touch', () => {
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: [event('attempt_opened'), event('submission_confirmed')],
        packetClaimId: null,
      }),
      false,
    );
  });

  test('an already closed attempt is a no-op, which is what makes the heal idempotent', () => {
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: [event('attempt_opened'), event('not_sent_proven')],
        packetClaimId: null,
      }),
      false,
    );
  });

  test('an empty ledger and a malformed attempt are both refused', () => {
    assert.equal(abandonedPreBoundaryAttemptIsClosable({ attemptEvents: [], packetClaimId: null }), false);
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: [event('attempt_opened'), event('attempt_opened')],
        packetClaimId: null,
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
        packetClaimId: null,
      }),
      false,
    );
  });
});
