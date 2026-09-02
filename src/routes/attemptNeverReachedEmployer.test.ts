/* AN ATTEMPT THAT NEVER REACHED THE EMPLOYER, AND THE THREE THINGS THAT USED TO GO WRONG WITH IT.
 *
 * MEASURED IN PRODUCTION 2026-09-02 11:38:20 UTC. The Maven Group "Cyber Test Engineer" (crelate),
 * packet 305dae5e, canonical application aa04b6ce. A packet filled eleven hours earlier sat at
 * ready_for_final_approval. One click on its primary control ran the send path. 456 milliseconds
 * later the ledger held one `attempt_opened`, no `boundary_authorized`, no `press_observed`, and
 * the review said:
 *
 *   "Litos pressed Send and the page never showed a confirmation it could read, so it does not know
 *    whether this application went through. Open https://jobs.crelate.com/... and look."
 *
 * A real press against a live browser cannot complete in half a second, and the ledger's own record
 * says no press event of any kind was made. Three defects, all shared across every board and user:
 *
 *   1. The send opened a ledger attempt before anything knew a press was possible. An opened attempt
 *      folds to blocked_unverified/'opened', which blocks every further send on the packet and every
 *      other application to that employer. A perfectly sendable packet was stuck.
 *   2. The applicant-facing message asserted a press the ledger does not record, and sent her to
 *      inspect an employer portal for a submission that was never attempted.
 *   3. POST /applications/:id/packet-audit then refused with 409, so a fresh page load could not
 *      rebuild the in-session evidence the send gate needs.
 *
 * WHAT THESE TESTS ASSERT, AND WHAT THEY DELIBERATELY DO NOT. They do not assert "the claim always
 * comes off". A genuinely pressed and unconfirmed submission must still fail closed, must still keep
 * its claim, must still block a second send, and must still be described exactly as it is today.
 * Every widening below is gated on the ledger proving the employer boundary was never crossed, and
 * the pressed cases are pinned here beside them so a future change cannot loosen one without
 * breaking the other.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ApplicationReviewState } from '../lib/applicationReview';
import {
  ManagedDestinationUnverifiedError,
  submissionFailureReview,
} from './submissionRunner';
import {
  attemptNeverPressedReason,
  unpressedUnverifiedSubmissionReason,
  unverifiedSubmissionReason,
} from '../lib/managedSubmitOutcome';
import {
  attemptNeverReachedEmployer,
  type SubmissionAttemptEventRecord,
  type SubmissionAttemptEventKind,
} from '../lib/submissionAttemptLedger';
import {
  attemptNeverReachedEmployerIsReleasable,
  releaseAttemptThatNeverReachedEmployer,
} from '../lib/expiredHandoffClaimRelease';
import { attentionCategoriesForReasons } from '../lib/submissionTerminalCause';
import { submitRequestDisposition } from '../lib/submissionSafety';
import { stopReasonPrecedesClick } from '../lib/submissionStop';

const CLAIMED_AT = '2026-09-02T11:38:20.009Z';
const PORTAL = 'https://jobs.crelate.com/portal/themavengroup/job/apply/wtmao1bfqg9te5b5jo5jknskxo';

/** The measured packet: filled hours earlier, claimed by the send that is about to stop. */
function claimedRunning(extra: Partial<ApplicationReviewState> = {}): ApplicationReviewState {
  return {
    jd_text: 'Cyber Test Engineer at The Maven Group',
    status: 'submitting',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: CLAIMED_AT,
    portal_url: PORTAL,
    ats_name: 'crelate',
    submission_run_id: 'b478f200-98a4-45d2-9fc7-d29941bc002d',
    submission_claimed_at: CLAIMED_AT,
    submission_claim_id: '22b9663a-6497-4b83-80c2-54f89469e37e',
    submission_authorization: { source: 'per_application_approval', authorized_at: CLAIMED_AT },
    ...extra,
  };
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

/* The exact four-state predicate POST /applications/:id/packet-audit refuses on. Mirrored rather
 * than imported because it is written inline in the route; if it moves, this mirror is the thing
 * that should be updated to point at it. */
function packetAuditWouldRefuse(review: ApplicationReviewState): boolean {
  return Boolean(review.submission_claimed_at)
    || review.status === 'submitting'
    || review.status === 'submission_claimed'
    || review.status === 'submitted';
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

describe('attemptNeverReachedEmployer', () => {
  test('an attempt carrying only its opening fact never reached the employer', () => {
    assert.equal(attemptNeverReachedEmployer(OPENED_ONLY), true);
  });

  test('a boundary authorization is durable employer risk and refuses the proof', () => {
    assert.equal(attemptNeverReachedEmployer(OPENED_AND_AUTHORIZED), false);
  });

  test('an observed press refuses the proof', () => {
    assert.equal(attemptNeverReachedEmployer(OPENED_AND_PRESSED), false);
  });

  test('an already resolved attempt is not this predicate’s case', () => {
    assert.equal(
      attemptNeverReachedEmployer([ledgerEvent('attempt_opened'), ledgerEvent('not_sent_proven')]),
      false,
    );
    assert.equal(
      attemptNeverReachedEmployer([ledgerEvent('attempt_opened'), ledgerEvent('submission_confirmed')]),
      false,
    );
  });

  test('an unread ledger proves nothing, and a malformed attempt is never closed by this route', () => {
    assert.equal(attemptNeverReachedEmployer([]), false);
    assert.equal(
      attemptNeverReachedEmployer([ledgerEvent('attempt_opened'), ledgerEvent('attempt_opened')]),
      false,
    );
  });
});

describe('defect 1: a send whose filled form is gone leaves the packet sendable', () => {
  test('the destination probe refusal is a typed pre-click stop, not an unclassified one', () => {
    const persisted = submissionFailureReview(
      claimedRunning(),
      new ManagedDestinationUnverifiedError('sandbox stream was closed'),
    );
    assert.equal(persisted.submission_stop?.reason, 'destination_unverified_before_send');
    assert.equal(persisted.submission_stop?.before_click, true);
    assert.equal(stopReasonPrecedesClick('destination_unverified_before_send'), true);
  });

  test('it opens no unverified record, releases the claim, and the packet can be sent again', () => {
    const persisted = submissionFailureReview(
      claimedRunning(),
      new ManagedDestinationUnverifiedError('sandbox stream was closed'),
    );
    assert.equal(persisted.unverified_submission, undefined);
    assert.equal(persisted.submission_attempted_at, undefined);
    assert.equal(persisted.submission_claim_id, undefined);
    assert.equal(packetIsSendableAgain(persisted), true);
  });

  test('and it never tells the applicant a press happened or points her at the employer page', () => {
    const persisted = submissionFailureReview(
      claimedRunning(),
      new ManagedDestinationUnverifiedError('sandbox stream was closed'),
    );
    const reason = persisted.attention_reason ?? '';
    assert.doesNotMatch(reason, /pressed Send/i);
    assert.doesNotMatch(reason, /jobs\.crelate\.com/);
    assert.match(reason, /nothing was submitted|Nothing was submitted/);
  });

  test('the ledger closes every other pre-boundary stop too, including an untyped one', () => {
    /* THE SYSTEMIC HALF. Everything above reasons from the error TYPE, so a stop with no typed arm
     * fell to 'unclassified', which is not pre-click, which meant the claim stayed on and an
     * unverified record was invented. The ledger answers the same question from facts. */
    const persisted = submissionFailureReview(
      claimedRunning(),
      new Error('the provider refused'),
      undefined,
      { employerBoundaryReached: false },
    );
    assert.equal(persisted.unverified_submission, undefined);
    assert.equal(persisted.submission_claimed_at, undefined);
    assert.equal(packetIsSendableAgain(persisted), true);
    assert.doesNotMatch(persisted.attention_reason ?? '', /pressed Send/i);
  });

  test('an unread ledger changes nothing: the uncertain exit is still handed out', () => {
    const persisted = submissionFailureReview(claimedRunning(), new Error('the provider refused'));
    assert.ok(persisted.unverified_submission);
    assert.equal(persisted.submission_claimed_at, CLAIMED_AT);
  });
});

describe('the guard that must not be weakened: a genuinely pressed, unconfirmed send', () => {
  test('keeps its claim, keeps its unverified record, and still blocks a second send', () => {
    const persisted = submissionFailureReview(
      claimedRunning(),
      new Error('the confirmation could not be read'),
      undefined,
      { employerBoundaryReached: true },
    );
    assert.ok(persisted.unverified_submission);
    assert.equal(persisted.unverified_submission?.cause, 'no_confirmation_state');
    assert.equal(persisted.submission_claimed_at, CLAIMED_AT);
    assert.equal(packetIsSendableAgain(persisted), false);
    assert.equal(
      submitRequestDisposition(
        persisted.status,
        Boolean(persisted.submission_claimed_at),
        persisted.unverified_submission?.resolution,
        persisted,
      ),
      'reject',
    );
  });

  test('and it is still described as the press it was', () => {
    const persisted = submissionFailureReview(
      claimedRunning(),
      new Error('the confirmation could not be read'),
      undefined,
      { employerBoundaryReached: true },
    );
    assert.match(persisted.attention_reason ?? '', /Litos pressed Send/);
  });

  test('a boundary authorization alone is enough to keep the uncertain exit', () => {
    /* An authorization with no press is the genuinely uncertain middle. The lease is durable
     * employer risk, so this must fail closed exactly as it did before. */
    assert.equal(attemptNeverReachedEmployer(OPENED_AND_AUTHORIZED), false);
  });
});

describe('round 2: a live send caught mid-flight by a poll is never released', () => {
  /* THE REFUTATION THIS CLOSES. repairExpiredAttendedHandoffClaim runs on every
   * GET /applications/:id/submission, which the dashboard polls every few seconds while a send is in
   * flight. Between claimSubmission and assertFinalRunnerBoundaryClear a live send holds `submitting`
   * with `attempt_opened` alone - no boundary yet - so attemptNeverReachedEmployer answers true of it.
   * The release arm is gated on that predicate AND on attemptNeverReachedEmployerIsReleasable; without
   * a status check the second predicate also answered true, and a poll tore the live claim down, after
   * which the runner died at the boundary. The status guard is the discriminator: the run in flight is
   * `submitting`/`submission_claimed`, the wedge this releases handed control back at `needs_attention`. */
  test('a submitting run with a held claim and only its opening fact is not releasable', () => {
    const liveSend = claimedRunning();
    assert.equal(liveSend.status, 'submitting');
    assert.equal(liveSend.submission_claimed_at, CLAIMED_AT);
    assert.equal(liveSend.unverified_submission, undefined);
    // The ledger fact the live send carries is exactly the one the phantom row carries.
    assert.equal(attemptNeverReachedEmployer(OPENED_ONLY), true);
    // ...and yet the row must not be released, because it is not the parked, human-facing state.
    assert.equal(attemptNeverReachedEmployerIsReleasable(liveSend), false);
  });

  test('a submission_claimed run is equally protected', () => {
    assert.equal(
      attemptNeverReachedEmployerIsReleasable(claimedRunning({ status: 'submission_claimed' })),
      false,
    );
  });

  test('only the parked needs_attention wedge remains releasable', () => {
    /* The contrast, pinned beside the live-send cases so a future change cannot re-open the release
     * to a running status without failing here. */
    const parked = claimedRunning({
      status: 'needs_attention',
      submission_attempted_at: CLAIMED_AT,
      unverified_submission: {
        at: CLAIMED_AT,
        cause: 'no_confirmation_state',
        portal_url: PORTAL,
        submission_run_id: 'b478f200-98a4-45d2-9fc7-d29941bc002d',
      },
    });
    assert.equal(attemptNeverReachedEmployerIsReleasable(parked), true);
  });
});

describe('defect 2: the applicant-facing text never claims a press the ledger does not record', () => {
  test('the never-pressed sentence names no press and no portal', () => {
    const reason = unverifiedSubmissionReason({
      atsName: 'crelate',
      portalUrl: PORTAL,
      cause: 'no_confirmation_state',
      sendEvidence: 'opened',
    });
    assert.equal(reason, unpressedUnverifiedSubmissionReason());
    assert.doesNotMatch(reason, /pressed Send/i);
    assert.doesNotMatch(reason, /jobs\.crelate\.com/);
    assert.doesNotMatch(reason, /Open .* and look/);
  });

  test('and it still files as an unverified submission rather than silently reclassifying', () => {
    /* submissionTerminalCause files this category by regex over the prose. A sentence that drops
     * the clause moves the row into another bucket without anyone noticing. */
    assert.deepEqual(
      attentionCategoriesForReasons([unpressedUnverifiedSubmissionReason()]),
      ['unverified_submission'],
    );
  });

  test('the released-attempt sentence files as a run that broke, which is what happened', () => {
    const reason = attemptNeverPressedReason();
    assert.doesNotMatch(reason, /pressed Send/i);
    assert.doesNotMatch(reason, /does not know whether this application went through/);
    assert.deepEqual(attentionCategoriesForReasons([reason]), ['run_failed']);
  });

  test('an evidence-free call keeps the pressed sentence byte for byte', () => {
    const withoutEvidence = unverifiedSubmissionReason({
      atsName: 'crelate',
      portalUrl: PORTAL,
      cause: 'no_confirmation_state',
    });
    const withPressed = unverifiedSubmissionReason({
      atsName: 'crelate',
      portalUrl: PORTAL,
      cause: 'no_confirmation_state',
      sendEvidence: 'pressed',
    });
    assert.equal(withoutEvidence, withPressed);
    assert.match(withoutEvidence, /Litos pressed Send/);
  });
});

describe('defect 3: the packet audit a fresh load needs works for an unsent packet', () => {
  const stuck = (): ApplicationReviewState => ({
    ...claimedRunning({ status: 'needs_attention' }),
    submission_attempted_at: CLAIMED_AT,
    unverified_submission: {
      at: CLAIMED_AT,
      cause: 'no_confirmation_state',
      portal_url: PORTAL,
      submission_run_id: 'b478f200-98a4-45d2-9fc7-d29941bc002d',
    },
    attention_reason: 'Litos pressed Send and the page never showed a confirmation it could read.',
    attention_categories: ['unverified_submission'],
  });

  test('the measured row is releasable, and the release erases what the failed send invented', () => {
    const current = stuck();
    assert.equal(packetAuditWouldRefuse(current), true);
    assert.equal(attemptNeverReachedEmployerIsReleasable(current), true);
    const released = releaseAttemptThatNeverReachedEmployer(current, attemptNeverPressedReason());
    assert.equal(released.unverified_submission, undefined);
    assert.equal(released.submission_attempted_at, undefined);
    assert.equal(released.submission_claimed_at, undefined);
    assert.equal(released.claim_released?.cause, 'attempt_never_reached_employer');
    assert.equal(released.claim_released?.claim_id, '22b9663a-6497-4b83-80c2-54f89469e37e');
  });

  test('after the release the audit gate passes and the packet is sendable', () => {
    const released = releaseAttemptThatNeverReachedEmployer(stuck(), attemptNeverPressedReason());
    assert.equal(packetAuditWouldRefuse(released), false);
    assert.equal(packetIsSendableAgain(released), true);
  });

  test('a receipt, a submitted row or a standing code wall refuses the release', () => {
    assert.equal(attemptNeverReachedEmployerIsReleasable({
      ...stuck(),
      receipt: { confirmation_text: 'Thanks', final_url: PORTAL, captured_at: CLAIMED_AT },
    }), false);
    assert.equal(attemptNeverReachedEmployerIsReleasable({ ...stuck(), submitted_at: CLAIMED_AT }), false);
    assert.equal(attemptNeverReachedEmployerIsReleasable({
      ...stuck(),
      security_code: { requested_at: CLAIMED_AT, attempts: [], digits: 8, submit_was_authorized: true },
    }), false);
  });

  test('an unverified record left by a different run is not this release’s to erase', () => {
    const current = stuck();
    assert.equal(attemptNeverReachedEmployerIsReleasable({
      ...current,
      unverified_submission: { ...current.unverified_submission!, submission_run_id: 'an-earlier-run' },
    }), false);
    assert.equal(attemptNeverReachedEmployerIsReleasable({
      ...current,
      unverified_submission: { ...current.unverified_submission!, submission_run_id: undefined },
    }), false);
  });

  test('an already answered record is left alone', () => {
    const current = stuck();
    assert.equal(attemptNeverReachedEmployerIsReleasable({
      ...current,
      unverified_submission: { ...current.unverified_submission!, resolution: 'sent' },
    }), false);
  });
});
