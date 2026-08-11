/* EVERY STOP LEAVES A DOOR, AND ONLY A PROVEN ONE TAKES THE LOCK OFF.
 *
 * The claim is taken at the top of a send run, so every throw after that point leaves it on the row.
 * fail() removed it for exactly two families - regenerationRequired/packetDocumentExpired, and the
 * chooser stop - which left four that landed at needs_attention wearing the claim and carrying no
 * unverified_submission record:
 *
 *   ManagedActionBudgetError, CaptchaUnresolvedError, a provider session failure, any generic throw.
 *
 * A row in that shape has no exit at all. submitRequestDisposition refuses a claimed needs_attention
 * row and resumeEditDisposition delegates to it, so neither another run nor an edit can move it; the
 * security-code route requires a different status; and the unverified-resolution route requires a
 * record none of those four wrote. lib/submissionSafety.ts names that shape as a defect in its own
 * parameter docs, and unlike the historical rows that were repaired, these are still being created.
 *
 * WHAT IS ASSERTED, and it is deliberately not "the claim is gone". A CAPTCHA can be standing on a
 * page BECAUSE an earlier attempt already submitted, so releasing on the error type alone would be
 * the same false certainty in the opposite direction. The rule is: a stop that provably preceded the
 * click releases; one that cannot be proven keeps the lock AND is handed a door. Each test below
 * names which door.
 *
 * These drive the real function with real error instances. The two tests that used to watch this
 * decision read the file as text and matched regexes against it, and one of them passed for the
 * whole life of the defect it was guarding.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ApplicationReviewState } from '../lib/applicationReview';
import { submissionFailureReview } from './submissionRunner';
import { CaptchaUnresolvedError, ManagedActionBudgetError } from '../lib/portalSubmission';
import { isManagedNoSubmitControl, submissionProvablyNotSent, unwrapThrownErrorMessage } from '../lib/managedSubmitOutcome';
import { submitRequestDisposition } from '../lib/submissionSafety';

const CLAIMED_AT = '2026-08-11T12:00:00.000Z';

/** A packet mid-send: 'submitting', with the claim its run took at the top. */
function claimedRunning(extra: Partial<ApplicationReviewState> = {}): ApplicationReviewState {
  return {
    jd_text: 'Backend engineer at kos',
    status: 'submitting',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: CLAIMED_AT,
    portal_url: 'https://jobs.ashbyhq.com/kos/application',
    ats_name: 'ashby',
    submission_run_id: 'run-1',
    submission_claimed_at: CLAIMED_AT,
    submission_claim_id: 'claim-1',
    submission_authorization: { source: 'standing_consent', authorized_at: CLAIMED_AT },
    ...extra,
  };
}

/** The claim is off, so the ordinary submit route will start this packet again. */
function exitIsAnOrdinaryRerun(persisted: ApplicationReviewState): boolean {
  return persisted.submission_claimed_at === undefined
    && submitRequestDisposition(
      persisted.status,
      Boolean(persisted.submission_claimed_at),
      persisted.unverified_submission?.resolution,
      persisted,
    ) === 'start';
}

/** The claim is on, but POST /applications/:id/submission/unverified can now reach this row. */
function exitIsTheUnverifiedResolutionRoute(persisted: ApplicationReviewState): boolean {
  return persisted.submission_claimed_at !== undefined
    && persisted.status === 'needs_attention'
    && !!persisted.unverified_submission
    && persisted.unverified_submission.resolution === undefined;
}

describe('every post-claim stop leaves the row with a way out', () => {
  test('an action-budget stop exits by ordinary re-run, because the builder threw before the click', () => {
    /* buildManagedPortalActions throws while ASSEMBLING the action list, before runManagedBrowser is
       called at all, and records submitActionAppended false. Nothing reached the employer. */
    const persisted = submissionFailureReview(
      claimedRunning(),
      new ManagedActionBudgetError('ashby', 60, 12),
    );
    assert.equal(persisted.status, 'needs_attention');
    assert.equal(persisted.submission_stop?.reason, 'action_budget');
    assert.equal(persisted.submission_stop?.before_click, true);
    assert.ok(exitIsAnOrdinaryRerun(persisted), 'exit: POST /applications/:id/submit-request');
    assert.equal(persisted.unverified_submission, undefined,
      'a stop with no send must not send her hunting for a receipt that cannot exist');
  });

  test('a captcha stop on a clean row exits by ordinary re-run', () => {
    /* Both throw sites precede any click in this run: the pre-browser probe, and the probe inside
       clickFinalSubmit which runs before the button is pressed. The row agrees - nothing on it
       records an attempt - so the pair is a proof and the lock comes off. */
    const persisted = submissionFailureReview(
      claimedRunning(),
      new CaptchaUnresolvedError('at_submit', 'recaptcha_v2'),
    );
    assert.equal(persisted.status, 'needs_attention');
    assert.equal(persisted.submission_stop?.reason, 'captcha_at_submit');
    assert.ok(exitIsAnOrdinaryRerun(persisted), 'exit: POST /applications/:id/submit-request');
    assert.equal(persisted.stall?.kind, 'human_verification', 'and it still books the stall');
  });

  test('a provider session failure exits by the unverified-resolution route, keeping its lock', () => {
    /* "The sandbox stream was closed" says nothing about WHERE in the run it closed. It may have
       closed after the click, so the claim is right to stay - but the row must still be answerable. */
    const persisted = submissionFailureReview(
      claimedRunning(),
      new Error('The sandbox stream was closed'),
    );
    assert.equal(persisted.submission_stop?.reason, 'provider_session_failure');
    assert.equal(persisted.submission_stop?.before_click, false);
    assert.ok(exitIsTheUnverifiedResolutionRoute(persisted),
      'exit: POST /applications/:id/submission/unverified');
    assert.equal(persisted.unverified_submission?.cause, 'provider_error');
  });

  test('a generic throw exits by the unverified-resolution route, keeping its lock', () => {
    const persisted = submissionFailureReview(
      claimedRunning(),
      new Error('Cannot read properties of undefined (reading ‘value’)'),
    );
    assert.equal(persisted.submission_stop?.reason, 'unclassified');
    assert.equal(persisted.submission_stop?.before_click, false,
      'a stop nobody can classify is never a proof that nothing was sent');
    assert.ok(exitIsTheUnverifiedResolutionRoute(persisted),
      'exit: POST /applications/:id/submission/unverified');
    assert.equal(persisted.unverified_submission?.cause, 'no_confirmation_state');
  });

  /* THE TWO HALVES OF THE RULE, stated directly rather than inferred from the four cases above. */

  test('a stop that cannot be proven pre-click keeps the claim and still gets a door', () => {
    const persisted = submissionFailureReview(claimedRunning(), new Error('The sandbox stream was closed'));
    assert.equal(persisted.submission_claimed_at, CLAIMED_AT, 'the lock stays');
    assert.equal(
      submitRequestDisposition(persisted.status, true, undefined, persisted),
      'reject',
      'and the ordinary send path still refuses it',
    );
    assert.ok(exitIsTheUnverifiedResolutionRoute(persisted), 'but it is no longer a dead end');
  });

  test('a provable pre-click stop releases the claim', () => {
    const persisted = submissionFailureReview(claimedRunning(), new ManagedActionBudgetError('ashby', 60, 12));
    assert.equal(persisted.submission_claimed_at, undefined);
    assert.equal(persisted.submission_claim_id, undefined);
    assert.equal(persisted.submission_authorization, undefined);
  });

  test('a pre-click stop on a row that already carries send evidence does NOT release', () => {
    /* The evidence outranks the stop reason, and this is the case that makes releasing on the error
       type alone wrong: this run pressed nothing, and an earlier one already reached the employer. */
    for (const [name, evidence] of Object.entries({
      'a receipt': { receipt: { confirmation_text: 'Thanks', final_url: 'u', captured_at: CLAIMED_AT } },
      'a standing code wall': { security_code: { digits: 8, sent_to: 'a@b.test', requested_at: CLAIMED_AT, submit_was_authorized: true } },
      'a recorded attempt': { submission_attempted_at: CLAIMED_AT },
    }) as [string, Partial<ApplicationReviewState>][]) {
      const persisted = submissionFailureReview(
        claimedRunning(evidence),
        new CaptchaUnresolvedError('at_submit', 'recaptcha_v2'),
      );
      assert.equal(persisted.submission_claimed_at, CLAIMED_AT, `${name} must keep the lock on`);
      assert.ok(persisted.unverified_submission, `${name} must still leave a door`);
    }
  });

  test('the stop record names the run it describes, so a stale one is legible', () => {
    const persisted = submissionFailureReview(claimedRunning(), new Error('anything'));
    assert.equal(persisted.submission_stop?.submission_run_id, 'run-1');
    assert.equal(typeof persisted.submission_stop?.at, 'string');
  });

  test('an unclaimed run that fails is left alone: no claim to release, no door to add', () => {
    const persisted = submissionFailureReview(
      claimedRunning({ submission_claimed_at: undefined, submission_claim_id: undefined }),
      new Error('Cannot read properties of undefined'),
    );
    assert.equal(persisted.unverified_submission, undefined,
      'nothing was claimed, so nothing was authorized to press Send');
    assert.equal(persisted.status, 'failed');
  });
});

/* THE REOPEN KEY HAS TO FIT THE FORMAT THE LOCK IS WRITTEN IN.
 *
 * kos.ai, production, 2026-08-11, after PR 497 shipped and deployed. Try again still answered "This
 * application cannot start another submission run from its current state". The row cleared all five
 * evidence checks and fell to the last line of submissionProvablyNotSent, which asked
 * isManagedNoSubmitControl about a stored `Error: Atomic submit control was missing or ambiguous`
 * and got false.
 *
 * The wrapper is what String(err) produces, and it is how a Stratus-side throw crosses the HTTP
 * boundary: the runner serializes its own error into `payload.error`, and managedBrowserErrorMessage
 * passes that through verbatim into `new Error(...)`. That is the only re-wrapping on the path - the
 * `; action_audit=` suffix is appended only to messages containing "selector", which this one does
 * not.
 *
 * ONE PREDICATE, TWO FAILURES. It is also what fail() asks before taking the branch that RELEASES
 * the claim, so the wrapped form missed at the writer first (which is why the row was ever stuck)
 * and again at the reader (which is why PR 497 could not lift it).
 */
describe('the pre-click reopen key matches the stored form and nothing looser', () => {
  test('the wrapper a thrown error crosses the Stratus boundary with is stripped', () => {
    assert.equal(unwrapThrownErrorMessage('Error: Atomic submit control was missing or ambiguous'),
      'Atomic submit control was missing or ambiguous');
    // The shape is not hypothesised: this is what the platform actually produces.
    assert.equal(String(new Error('Atomic submit control was missing or ambiguous')),
      'Error: Atomic submit control was missing or ambiguous');
  });

  test('the exact stored form and the clean form both open the lock', () => {
    assert.equal(isManagedNoSubmitControl('Error: Atomic submit control was missing or ambiguous'), true);
    assert.equal(isManagedNoSubmitControl('Atomic submit control was missing or ambiguous'), true);
    // A named subclass stringifies the same way.
    assert.equal(isManagedNoSubmitControl('NoSubmitControlError: Atomic submit control was missing or ambiguous'), true);
  });

  test('every near miss the reviewer probed is still refused', () => {
    for (const nearMiss of [
      'error: atomic submit control was missing or ambiguous',
      'Error: Atomic submit control was missing or ambiguous.',
      'Error: Atomic submit control was missing or ambiguou',
      'Error: Atomic submit control was missing or ambiguous\n    at chooseSubmit (/app/index.js:41:9)',
      'Error: Atomic submit\ncontrol was missing or ambiguous',
      'Atomic submit control was missing or ambiguous; and the page then navigated',
      // Not an Error name, so nothing is stripped and the comparison fails as it must.
      'Stratus: Atomic submit control was missing or ambiguous',
      // Only one layer comes off, so a doubled wrapper is not a key either.
      'Error: Error: Atomic submit control was missing or ambiguous',
      '',
    ]) {
      assert.equal(isManagedNoSubmitControl(nearMiss), false, `must refuse: ${JSON.stringify(nearMiss)}`);
    }
  });

  test('the kos.ai row as production stored it is now re-runnable', () => {
    const stuck: ApplicationReviewState = {
      jd_text: 'Backend engineer at kos',
      status: 'needs_attention',
      edited_terms: [],
      questions: [],
      skipped_reasons: [],
      updated_at: CLAIMED_AT,
      submission_claimed_at: CLAIMED_AT,
      submission_claim_id: 'claim-1',
      submission_error: 'Error: Atomic submit control was missing or ambiguous',
    };
    assert.equal(submissionProvablyNotSent(stuck), true);
    assert.equal(submitRequestDisposition(stuck.status, true, undefined, stuck), 'start',
      'Try again must now start it, which is the whole point of the reopen');
  });

  test('and every must-not-reopen guarantee is unchanged', () => {
    const stuck = (extra: Partial<ApplicationReviewState>): ApplicationReviewState => ({
      jd_text: 'jd',
      status: 'needs_attention',
      edited_terms: [],
      questions: [],
      skipped_reasons: [],
      updated_at: CLAIMED_AT,
      submission_claimed_at: CLAIMED_AT,
      submission_error: 'Error: Atomic submit control was missing or ambiguous',
      ...extra,
    });
    const refuses: [string, Partial<ApplicationReviewState>][] = [
      ['a receipt', { receipt: { confirmation_text: 'Thanks', final_url: 'u', captured_at: CLAIMED_AT } }],
      ['a standing code wall', { security_code: { digits: 8, sent_to: 'a@b.test', requested_at: CLAIMED_AT, submit_was_authorized: true } }],
      ['an unresolved unverified submission', { unverified_submission: { at: CLAIMED_AT, cause: 'no_confirmation_state' } }],
      ['a recorded attempt', { submission_attempted_at: CLAIMED_AT }],
    ];
    for (const [name, evidence] of refuses) {
      const row = stuck(evidence);
      assert.equal(submissionProvablyNotSent(row), false, `${name} must still refuse`);
      assert.equal(submitRequestDisposition(row.status, true, undefined, row), 'reject', `${name} must stay locked`);
    }
    // pressed:true contradicts any pre-click claim the runner makes about the same result.
    assert.equal(submissionProvablyNotSent({
      ...stuck({}),
      submitOutcome: { state: 'not_attempted', pressed: true },
    } as Parameters<typeof submissionProvablyNotSent>[0]), false);
  });

  test('the writer releases the claim on the wrapped form too, so this cannot recur', () => {
    /* The durable half. Even if the sentence is reworded tomorrow, the typed stop record is what the
       reopen reads, and it is written from the error TYPE rather than from its text. */
    const wrapped = submissionFailureReview(
      claimedRunning(),
      new Error('Error: Atomic submit control was missing or ambiguous'),
    );
    assert.equal(wrapped.submission_claimed_at, undefined, 'PR 494 must fire on the stored form');
    assert.equal(wrapped.submission_stop?.reason, 'no_submit_control');
    assert.equal(wrapped.submission_stop?.before_click, true);
  });

  test('the typed record reopens a row whose message nobody recognises', () => {
    /* What retires the string matching. The stop was classified at the moment it happened, so the
       reopen no longer depends on anyone parsing prose. */
    const persisted = submissionFailureReview(claimedRunning(), new ManagedActionBudgetError('ashby', 60, 12));
    assert.equal(isManagedNoSubmitControl(persisted.submission_error ?? ''), false,
      'the sentence is not the chooser sentence, so only the typed record can be doing this');
    assert.equal(submissionProvablyNotSent(persisted), true);
  });
});
