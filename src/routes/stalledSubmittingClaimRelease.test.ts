/* THE SEND THAT STOPPED WITHOUT SAYING SO.
 *
 * MEASURED IN PRODUCTION 2026-09-03. DSI Innovations, packet a34e5ce2-f633-4c77-ad25-214489c02c1a.
 * A managed send claimed the row at 19:25:08.450Z and opened its ledger attempt. Nothing else ever
 * happened: no `boundary_authorized`, no `press_observed`, no receipt. submission_run_id never
 * changed and progress_updated_at was still on the previous day. The process holding the claim was
 * gone, and the row had no way to notice.
 *
 * The row was then unreachable by every exit at once. The runner's cron selects `submitting` rows
 * that are UNCLAIMED, or claimed rows carrying a `boundary_authorized` event, so it matched neither
 * arm. submitRequestDisposition answers `in_flight` for `submitting` unconditionally, so Try again
 * returned 409. preparedRunCanRestart covers ready_for_final_approval only. And
 * repairExpiredAttendedHandoffClaim, which does run on this row on every dashboard poll, declined
 * on all three arms, the middle one because attemptNeverReachedEmployerIsReleasable requires
 * `needs_attention`.
 *
 * WHAT THESE TESTS ASSERT, AND WHAT THEY REFUSE TO. They do not assert "a submitting claim comes
 * off". The whole risk of adding this arm is that a poll tears down a send that is merely slow: a
 * live pre-boundary run carries `attempt_opened` alone for the whole of buildPacket, the drift
 * assert and the captcha probe, which is byte-for-byte the evidence the dead row carries. So every
 * release below is gated on elapsed time AND on the ledger proving the employer boundary was never
 * crossed, and the live-send and crossed-boundary cases are pinned beside them so a future change
 * cannot loosen one without breaking the other.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ApplicationReviewState } from '../lib/applicationReview';
import {
  attemptNeverReachedEmployer,
  type SubmissionAttemptEventRecord,
  type SubmissionAttemptEventKind,
} from '../lib/submissionAttemptLedger';
import {
  STALLED_SUBMITTING_CLAIM_RELEASE_MS,
  attemptNeverReachedEmployerIsReleasable,
  neverReachedEmployerReleaseIsAdmissible,
  releaseAttemptThatNeverReachedEmployer,
  stalledSubmittingClaimIsReleasable,
  stalledSubmittingClaimLastActivityAt,
} from '../lib/expiredHandoffClaimRelease';
import { attemptNeverPressedReason } from '../lib/managedSubmitOutcome';
import { submitRequestDisposition } from '../lib/submissionSafety';

/** The measured DSI claim, and the progress stamp the run never advanced past. */
const DSI_CLAIMED_AT = '2026-09-03T19:25:08.450Z';
const DSI_PROGRESS_AT = '2026-09-02T14:23:41.000Z';
const DSI_CLAIMED_MS = Date.parse(DSI_CLAIMED_AT);
const PORTAL = 'https://dsiinnovations.applytojob.com/apply/engineering';

/** The wedged DSI row exactly as production held it. */
function wedgedSubmitting(extra: Partial<ApplicationReviewState> = {}): ApplicationReviewState {
  return {
    jd_text: 'Software Engineer at DSI Innovations',
    status: 'submitting',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: DSI_CLAIMED_AT,
    portal_url: PORTAL,
    submission_run_id: 'c1d0a5f6-7b2e-4a41-9d33-6f0b8e2a1c47',
    submission_claimed_at: DSI_CLAIMED_AT,
    // The attempt id, which is not the packet id above; only the packet id was measured.
    submission_claim_id: '5b7c9e04-2f18-4a63-8c11-3d95e7a04b2f',
    progress_updated_at: DSI_PROGRESS_AT,
    submission_authorization: { source: 'per_application_approval', authorized_at: DSI_CLAIMED_AT },
    ...extra,
  };
}

function ledgerEvent(kind: SubmissionAttemptEventKind): SubmissionAttemptEventRecord {
  return { event_kind: kind } as unknown as SubmissionAttemptEventRecord;
}

const OPENED_ONLY = [ledgerEvent('attempt_opened')];
const OPENED_AND_AUTHORIZED = [ledgerEvent('attempt_opened'), ledgerEvent('boundary_authorized')];
const OPENED_AND_PRESSED = [
  ledgerEvent('attempt_opened'),
  ledgerEvent('boundary_authorized'),
  ledgerEvent('press_observed'),
];

/* THE ACTUAL GATE THE ROUTE USES, imported rather than mirrored.
 *
 * This started as a local copy of the arm's boolean expression, and a mutation run showed exactly
 * what that is worth: deleting the new arm from the route, and deleting the ledger proof from it,
 * both left every test green. A mirror asserts that a copy of the rule is correct, never that the
 * shipped rule is. The composition was extracted to neverReachedEmployerReleaseIsAdmissible so this
 * file can assert the thing that actually runs. */
function routeWouldRelease(
  review: ApplicationReviewState,
  claimEvents: readonly SubmissionAttemptEventRecord[],
  nowMs: number,
): boolean {
  return neverReachedEmployerReleaseIsAdmissible(review, claimEvents, nowMs);
}

/** The claim is off and the ordinary submit route will start this packet again from a fresh fill. */
function packetIsSendableAgain(persisted: ApplicationReviewState): boolean {
  return persisted.submission_claimed_at === undefined
    && submitRequestDisposition(
      persisted.status,
      Boolean(persisted.submission_claimed_at),
      persisted.unverified_submission?.resolution,
      persisted,
    ) === 'start';
}

describe('the acceptance case: DSI a34e5ce2 becomes actionable again', () => {
  test('the wedged row is released once the bound has passed', () => {
    const row = wedgedSubmitting();
    // The evidence the row carries is exactly the evidence a live send carries.
    assert.equal(attemptNeverReachedEmployer(OPENED_ONLY), true);
    // And before this arm existed, nothing about it was releasable.
    assert.equal(attemptNeverReachedEmployerIsReleasable(row), false);
    assert.equal(
      routeWouldRelease(row, OPENED_ONLY, Date.parse('2026-09-04T08:00:00.000Z')),
      true,
    );
  });

  test('the released row is sendable again, and says nothing was sent', () => {
    const released = releaseAttemptThatNeverReachedEmployer(
      wedgedSubmitting(),
      attemptNeverPressedReason(),
      '2026-09-04T08:00:00.000Z',
    );
    assert.equal(released.status, 'needs_attention');
    assert.equal(released.submission_claimed_at, undefined);
    assert.equal(released.submission_claim_id, undefined);
    assert.equal(released.submitted_at, undefined);
    assert.equal(packetIsSendableAgain(released), true);
  });

  test('a 409 was the only answer before, and the release is what changes it', () => {
    const wedged = wedgedSubmitting();
    assert.equal(
      submitRequestDisposition(wedged.status, Boolean(wedged.submission_claimed_at)),
      'in_flight',
    );
  });
});

describe('a live send caught mid-flight by a poll is never released', () => {
  test('a claim taken thirty seconds ago is not stale', () => {
    const liveSend = wedgedSubmitting({ progress_updated_at: undefined });
    assert.equal(
      routeWouldRelease(liveSend, OPENED_ONLY, DSI_CLAIMED_MS + 30_000),
      false,
    );
  });

  test('a run still inside two full stratus fill windows is not stale', () => {
    /* MANAGED_PREPARE_FILL_DEADLINE_MS is 280s, and a send may legitimately spend one filling and
     * another re-reading before it authorizes the boundary. That is the work the bound has to clear
     * without tearing anything down. */
    const liveSend = wedgedSubmitting({ progress_updated_at: undefined });
    assert.equal(routeWouldRelease(liveSend, OPENED_ONLY, DSI_CLAIMED_MS + 560_000), false);
  });

  test('the bound is exclusive at its own edge, and opens one millisecond later', () => {
    /* POLARITY, asserted rather than assumed to match its sibling. Release happens when the
     * deadline is in the PAST, which is the direction expiredAttendedHandoffClaimIsReleasable
     * reads its own window. A flipped comparison would release everything except the stale rows. */
    const row = wedgedSubmitting({ progress_updated_at: undefined });
    const deadline = DSI_CLAIMED_MS + STALLED_SUBMITTING_CLAIM_RELEASE_MS;
    assert.equal(stalledSubmittingClaimIsReleasable(row, deadline), false);
    assert.equal(stalledSubmittingClaimIsReleasable(row, deadline + 1), true);
  });
});

describe('the ledger proof is required, and it is what refuses a crossed boundary', () => {
  test('a stalled row that authorized the employer boundary is never released', () => {
    /* The lease is durable employer risk. However long this row has been stuck, releasing it would
     * put a second application in front of an employer that may already hold the first. */
    const row = wedgedSubmitting();
    assert.equal(stalledSubmittingClaimIsReleasable(row, Date.parse('2026-10-01T00:00:00.000Z')), true);
    assert.equal(routeWouldRelease(row, OPENED_AND_AUTHORIZED, Date.parse('2026-10-01T00:00:00.000Z')), false);
  });

  test('a stalled row with an observed press is never released', () => {
    const row = wedgedSubmitting();
    assert.equal(routeWouldRelease(row, OPENED_AND_PRESSED, Date.parse('2026-10-01T00:00:00.000Z')), false);
  });

  test('an already confirmed or already closed attempt is not this arm to touch', () => {
    const row = wedgedSubmitting();
    const late = Date.parse('2026-10-01T00:00:00.000Z');
    assert.equal(routeWouldRelease(row, [ledgerEvent('attempt_opened'), ledgerEvent('submission_confirmed')], late), false);
    assert.equal(routeWouldRelease(row, [ledgerEvent('attempt_opened'), ledgerEvent('not_sent_proven')], late), false);
  });

  test('an empty ledger proves nothing and releases nothing', () => {
    assert.equal(routeWouldRelease(wedgedSubmitting(), [], Date.parse('2026-10-01T00:00:00.000Z')), false);
  });
});

describe('staleness is measured from the run, never from updated_at', () => {
  test('a row kept fresh by unrelated writes is still stale', () => {
    /* THE TRAP THIS CLOSES. updated_at moves whenever anything writes the review, including this
     * repair itself and any unrelated edit. Reading it would measure our own activity and call it
     * the run's, and a row could be held "live" forever by writes that say nothing about whether
     * the process still exists. */
    const row = wedgedSubmitting({ updated_at: '2026-09-04T07:59:59.000Z' });
    assert.equal(
      stalledSubmittingClaimIsReleasable(row, Date.parse('2026-09-04T08:00:00.000Z')),
      true,
    );
  });

  test('a progress stamp later than the claim moves the deadline out', () => {
    /* A run that died mid-fill is measured from its last frame, not from when it took the row. */
    const midFill = '2026-09-03T19:50:00.000Z';
    const row = wedgedSubmitting({ progress_updated_at: midFill });
    const deadline = Date.parse(midFill) + STALLED_SUBMITTING_CLAIM_RELEASE_MS;
    assert.equal(stalledSubmittingClaimIsReleasable(row, deadline), false);
    assert.equal(stalledSubmittingClaimIsReleasable(row, deadline + 1), true);
    // ...and the claim alone would have opened it far earlier, which is the bug this avoids.
    assert.ok(DSI_CLAIMED_MS + STALLED_SUBMITTING_CLAIM_RELEASE_MS < deadline);
  });

  test('the last activity is the later of the claim and the progress stamp', () => {
    assert.equal(stalledSubmittingClaimLastActivityAt(wedgedSubmitting()), DSI_CLAIMED_MS);
    assert.equal(
      stalledSubmittingClaimLastActivityAt(wedgedSubmitting({ progress_updated_at: '2026-09-03T20:00:00.000Z' })),
      Date.parse('2026-09-03T20:00:00.000Z'),
    );
  });

  test('a row that cannot say when it was claimed is never released', () => {
    assert.equal(stalledSubmittingClaimLastActivityAt({ submission_claimed_at: undefined }), null);
    assert.equal(stalledSubmittingClaimLastActivityAt({ submission_claimed_at: 'not a date' }), null);
    assert.equal(
      stalledSubmittingClaimIsReleasable(
        wedgedSubmitting({ submission_claimed_at: undefined }),
        Date.parse('2026-10-01T00:00:00.000Z'),
      ),
      false,
    );
  });

  test('an unreadable progress stamp falls back to the claim rather than voiding it', () => {
    const row = wedgedSubmitting({ progress_updated_at: 'not a date' });
    assert.equal(stalledSubmittingClaimLastActivityAt(row), DSI_CLAIMED_MS);
  });
});

describe('the stored evidence gates are unchanged, and both arms ask the same ones', () => {
  const late = Date.parse('2026-10-01T00:00:00.000Z');

  test('a receipt refuses the release', () => {
    const row = wedgedSubmitting({
      receipt: { confirmation_text: 'Thanks for applying', final_url: PORTAL, captured_at: DSI_CLAIMED_AT },
    } as Partial<ApplicationReviewState>);
    assert.equal(stalledSubmittingClaimIsReleasable(row, late), false);
  });

  test('a submitted_at refuses the release', () => {
    assert.equal(
      stalledSubmittingClaimIsReleasable(wedgedSubmitting({ submitted_at: DSI_CLAIMED_AT }), late),
      false,
    );
  });

  test('a standing security code refuses the release', () => {
    const row = wedgedSubmitting({
      security_code: { requested_at: DSI_CLAIMED_AT },
    } as Partial<ApplicationReviewState>);
    assert.equal(stalledSubmittingClaimIsReleasable(row, late), false);
  });

  test('an unverified record from another run is not this release to erase', () => {
    const row = wedgedSubmitting({
      unverified_submission: {
        at: DSI_CLAIMED_AT,
        cause: 'no_confirmation_state',
        submission_run_id: '00000000-0000-4000-8000-000000000000',
      },
    });
    assert.equal(stalledSubmittingClaimIsReleasable(row, late), false);
  });

  test('an already resolved unverified record refuses the release', () => {
    const row = wedgedSubmitting({
      unverified_submission: {
        at: DSI_CLAIMED_AT,
        cause: 'no_confirmation_state',
        submission_run_id: 'c1d0a5f6-7b2e-4a41-9d33-6f0b8e2a1c47',
        resolution: 'sent',
        resolved_at: DSI_CLAIMED_AT,
      },
    });
    assert.equal(stalledSubmittingClaimIsReleasable(row, late), false);
  });

  test('an unclaimed row has nothing to release', () => {
    assert.equal(
      stalledSubmittingClaimIsReleasable(wedgedSubmitting({ submission_claim_id: undefined }), late),
      false,
    );
  });
});

describe('the needs_attention arm is untouched by this widening', () => {
  test('the parked wedge is still releasable with no clock at all', () => {
    const parked = wedgedSubmitting({
      status: 'needs_attention',
      submission_attempted_at: DSI_CLAIMED_AT,
      unverified_submission: {
        at: DSI_CLAIMED_AT,
        cause: 'no_confirmation_state',
        portal_url: PORTAL,
        submission_run_id: 'c1d0a5f6-7b2e-4a41-9d33-6f0b8e2a1c47',
      },
    });
    assert.equal(attemptNeverReachedEmployerIsReleasable(parked), true);
    // Released immediately, without waiting out the stale bound the submitting arm imposes.
    assert.equal(routeWouldRelease(parked, OPENED_ONLY, DSI_CLAIMED_MS + 1), true);
  });

  test('a running status is still refused by the needs_attention arm on its own', () => {
    assert.equal(attemptNeverReachedEmployerIsReleasable(wedgedSubmitting()), false);
    assert.equal(
      attemptNeverReachedEmployerIsReleasable(wedgedSubmitting({ status: 'submission_claimed' })),
      false,
    );
  });

  test('a submission_claimed row is not opened by the new arm either', () => {
    /* The new arm names `submitting` exactly. submission_claimed is the other running status and
     * has no measured wedge behind it, so it stays closed rather than being swept in by a status
     * list nobody re-derived. */
    assert.equal(
      stalledSubmittingClaimIsReleasable(
        wedgedSubmitting({ status: 'submission_claimed' }),
        Date.parse('2026-10-01T00:00:00.000Z'),
      ),
      false,
    );
  });
});
