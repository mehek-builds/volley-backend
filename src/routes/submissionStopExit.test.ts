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
import {
  assertManagedRequiredFieldsConfirmed,
  CaptchaUnresolvedError,
  ManagedActionBudgetError,
  ManagedConfirmationUnprovenError,
  NoSubmitControlError,
} from '../lib/portalSubmission';
import { isManagedNoSubmitControl, submissionProvablyNotSent, unwrapThrownErrorMessage } from '../lib/managedSubmitOutcome';
import { ManagedBrowserAssertionFailureError, ManagedBrowserPreSubmitCrashError } from '../lib/browserbase';
import { submitRequestDisposition } from '../lib/submissionSafety';
import { SubmissionAccountDeletionDrainError } from '../lib/submissionAttemptLedger';

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
  test('an account-deletion fence releases a pre-boundary claim without remote uncertainty', () => {
    const persisted = submissionFailureReview(
      claimedRunning(),
      new SubmissionAccountDeletionDrainError(),
    );
    assert.equal(persisted.status, 'needs_attention');
    assert.equal(persisted.submission_claimed_at, undefined);
    assert.equal(persisted.submission_claim_id, undefined);
    assert.equal(persisted.unverified_submission, undefined);
    assert.match(persisted.attention_reason ?? '', /Account deletion paused/);
  });

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

  test('durable chooser-v4 pre-submit crash progress releases the claim for a safe retry', () => {
    const persisted = submissionFailureReview(
      claimedRunning(),
      new ManagedBrowserPreSubmitCrashError('Sandbox browser run failed', {
        version: 1,
        phase: 0,
        stage: 'phase_started',
        submitPressed: false,
        applicationSubmitPressed: false,
        verificationSubmitPressed: false,
        submitKind: 'application',
        policyVersion: 4,
      }),
    );
    assert.equal(persisted.status, 'needs_attention');
    assert.equal(persisted.submission_stop?.reason, 'provider_session_failure_before_submit');
    assert.equal(persisted.submission_stop?.before_click, true);
    assert.ok(exitIsAnOrdinaryRerun(persisted), 'exit: POST /applications/:id/submit-request');
    assert.equal(persisted.unverified_submission, undefined);
    assert.match(persisted.attention_reason || '', /Nothing was sent/);
  });

  test('a deterministic proof refusal releases like a pre-submit stop but never claims to be temporary', () => {
    /* The runner refused its own required readback proof, under the same durable containment
       progress the crash release leans on. Five consecutive live Workable phone attempts proved
       this reproduces identically, so the one sentence it must never wear is the provider-session
       one: "a temporary secure-browser error ... try this one again in a few minutes". */
    const persisted = submissionFailureReview(
      claimedRunning(),
      new ManagedBrowserAssertionFailureError(
        'filled_field:phone: expected exactly one match for .iti input[type="tel"], found 0; '
          + 'workable_phone_readback_evidence={"observed":"fresh_page_load"}',
        {
          version: 1,
          phase: 0,
          stage: 'phase_started',
          submitPressed: false,
          applicationSubmitPressed: false,
          verificationSubmitPressed: false,
          submitKind: 'application',
          policyVersion: 4,
        },
        'filled_field:phone',
      ),
    );
    assert.equal(persisted.status, 'needs_attention');
    assert.equal(persisted.submission_stop?.reason, 'field_proof_failed_before_submit');
    assert.equal(persisted.submission_stop?.before_click, true);
    assert.ok(exitIsAnOrdinaryRerun(persisted), 'exit: POST /applications/:id/submit-request');
    assert.equal(persisted.unverified_submission, undefined);
    assert.doesNotMatch(persisted.attention_reason || '', /temporary secure-browser/);
    assert.doesNotMatch(persisted.attention_reason || '', /again in a few minutes/);
    assert.match(persisted.attention_reason || '', /nothing has gone to the employer/i);
    // Names the exact field the runner's own label pointed at, generically derived rather than
    // hardcoded - see assertionAppliesField.
    assert.match(persisted.attention_reason || '', /re-filling the phone field/);
    assert.doesNotMatch(persisted.attention_reason || '', /pressed Send/i);
    // The exact failed proof, evidence included, is what the row records for whoever debugs it.
    assert.match(persisted.submission_error || '', /expected exactly one match/);
    assert.match(persisted.submission_error || '', /workable_phone_readback_evidence=/);
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

  test('malformed managed chooser evidence keeps the claim for unverified resolution', () => {
    const persisted = submissionFailureReview(
      claimedRunning(),
      new ManagedConfirmationUnprovenError(
        'Litos could not prove the managed final-submit chooser stopped before the click',
      ),
    );
    assert.equal(persisted.submission_stop?.before_click, false);
    assert.equal(persisted.submission_claimed_at, CLAIMED_AT);
    assert.ok(exitIsTheUnverifiedResolutionRoute(persisted));
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
 * The predicate remains only as a compatibility reader for rows written before typed stop records.
 * A current writer cannot use this prose as no-click proof and is pinned separately below.
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

  test('a new legacy ambiguity string stays unverified without the typed v4 proof', () => {
    const wrapped = submissionFailureReview(
      claimedRunning(),
      new Error('Error: Atomic submit control was missing or ambiguous'),
    );
    assert.equal(wrapped.submission_claimed_at, CLAIMED_AT);
    assert.equal(wrapped.submission_stop?.reason, 'unclassified');
    assert.equal(wrapped.submission_stop?.before_click, false);
    assert.ok(exitIsTheUnverifiedResolutionRoute(wrapped));
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

/* AN ORDINARY BLOCKED SUBMISSION IS NOT AN UNCERTAIN ONE, AND MUST NOT LOCK THE PACKET.
 *
 * The mirror image of everything above. That rule says a stop that cannot be proven pre-click keeps
 * its claim and takes the unverified exit, which is right, and the cost of applying it to a stop
 * that CAN be proven pre-click is a packet nobody can move.
 *
 * WHAT WAS MEASURED on origin/main @ 8b8efcd. A run against a form with one required field left
 * blank: the runner withheld the click (submitOutcome.pressed false, submissionOutcome 'blocked')
 * and named the field in pass.unresolved using its own sentence, stratus-browser-cloud@4748871
 * managed-browser.js:2928. The backend's unresolved allowlist admits only selectors and labels, so
 * that sentence made the whole proof unreadable, and since PR 506 an unreadable proof means "the
 * click state is unknown". The row came out as:
 *
 *     attention_reason  "Litos pressed Send and the page never showed a confirmation it could read"
 *     submission_attempted_at  set
 *     unverified_submission    written, unresolved
 *     claim                    kept
 *
 * Litos had not pressed Send. The applicant is sent to check an employer portal for an application
 * that was never submitted, the claim locks the ordinary re-run path, and the unresolved unverified
 * record blocks a fresh application to the same posting. This fires on any blocked submission.
 */
describe('a blocked submission releases, and is never dressed up as a possible send', () => {
  function blockedRun(unresolved: string[]) {
    return {
      submitOutcome: {
        pressed: false, state: 'not_attempted', source: null, evidence: null, message: null, formStillPresent: true,
      },
      requiredFieldConfirmation: {
        version: 2,
        status: 'blocked',
        passes: [{
          submitKind: 'application',
          scope: {
            scopeKind: 'form',
            formFingerprint: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            submitFingerprint: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
            formMatchCount: 1,
            submitMatchCount: 1,
            requiredControlCount: 1,
            sameNode: true,
          },
          requiredControls: [{
            selector: 'input[name="start_date"]', label: 'Start date', fieldType: 'text', matchCount: 1,
          }],
          attempts: [{
            selector: 'input[name="start_date"]',
            label: 'Start date',
            fieldType: 'text',
            outcome: 'failed',
            attemptCount: 2,
            reason: 'This requires an answer',
          }],
          retries: 1,
          unresolved,
          submissionOutcome: 'blocked',
        }],
      },
    };
  }

  /** The error the real validator throws. Nothing here hand-builds the error it asserts on. */
  function refusalFor(result: unknown): unknown {
    try {
      assertManagedRequiredFieldsConfirmed(result, 'application');
    } catch (error) {
      return error;
    }
    return assert.fail('a blocked proof must never be accepted');
  }

  /* The exact claim that must not be made about a run that withheld the click. */
  const CLAIMS_A_SEND = /Litos pressed Send/;

  test('the runner naming a blank field in its own words releases the packet', () => {
    const persisted = submissionFailureReview(
      claimedRunning(),
      refusalFor(blockedRun(['"Start date" is required and is still empty'])),
    );

    assert.doesNotMatch(persisted.attention_reason ?? '', CLAIMS_A_SEND,
      'the runner reported withholding the click, so nothing reached the employer');
    assert.equal(persisted.submission_attempted_at, undefined);
    assert.equal(persisted.unverified_submission, undefined,
      'there is no application to go and look for, so she must not be asked to look');
    assert.equal(persisted.submission_stop?.before_click, true);
    assert.ok(exitIsAnOrdinaryRerun(persisted),
      'exit: POST /applications/:id/submit-request, once she answers the question');
  });

  test('it writes the same row the bare label already wrote, so runner wording cannot change it', () => {
    const sentence = submissionFailureReview(
      claimedRunning(), refusalFor(blockedRun(['"Start date" is required and is still empty'])),
    );
    const bare = submissionFailureReview(claimedRunning(), refusalFor(blockedRun(['Start date'])));

    assert.equal(sentence.status, bare.status);
    assert.equal(sentence.submission_stop?.reason, bare.submission_stop?.reason);
    assert.equal(sentence.submission_stop?.before_click, bare.submission_stop?.before_click);
    assert.equal(sentence.submission_claimed_at, bare.submission_claimed_at);
    assert.equal(sentence.unverified_submission, bare.unverified_submission);
    assert.equal(sentence.submission_error, bare.submission_error,
      'the field is named either way, so the applicant is told the same thing');
  });

  test('every other sentence the runner can emit releases the same way', () => {
    for (const sentence of [
      'A required field on the form has no label Litos can read, and is still empty',
      'Required-field readiness scan failed',
      'Selectorless required field',
      'Bound submit control or application form was replaced before submission',
      'Bound application form or submit identity changed during confirmation',
      'The bound application form still shows an unmatched validation error: Please complete this field. ',
    ]) {
      const persisted = submissionFailureReview(claimedRunning(), refusalFor(blockedRun([sentence])));
      assert.doesNotMatch(persisted.attention_reason ?? '', CLAIMS_A_SEND, sentence);
      assert.equal(persisted.unverified_submission, undefined, sentence);
      assert.ok(exitIsAnOrdinaryRerun(persisted), sentence);
    }
  });

  /* THE HALF THAT MUST NOT MOVE. PR 506 exists because a proof this service cannot read on a run
     that DID press is a genuine unknown, and calling it "nothing was sent" costs a duplicate
     application. That reading is untouched. */
  test('an unreadable proof on a run that pressed submit is still an uncertain send', () => {
    const pressed = blockedRun(['Start date']);
    pressed.submitOutcome.pressed = true;
    (pressed.requiredFieldConfirmation.passes[0]!.scope as Record<string, unknown>).somethingNew = true;
    const persisted = submissionFailureReview(claimedRunning(), refusalFor(pressed));

    assert.equal(persisted.submission_stop?.reason, 'confirmation_unproven');
    assert.equal(persisted.submission_stop?.before_click, false);
    assert.match(persisted.attention_reason ?? '', CLAIMS_A_SEND);
    assert.ok(exitIsTheUnverifiedResolutionRoute(persisted),
      'exit: POST /applications/:id/submission/unverified');
    assert.equal(persisted.submission_claimed_at, CLAIMED_AT, 'and the lock stays on');
  });

  test('a runner that says nothing about the press is still an uncertain send', () => {
    const silent = blockedRun(['Start date']) as Record<string, unknown>;
    delete silent.submitOutcome;
    ((silent.requiredFieldConfirmation as { passes: Array<{ scope: Record<string, unknown> }> })
      .passes[0]!.scope).somethingNew = true;
    const persisted = submissionFailureReview(claimedRunning(), refusalFor(silent));

    assert.equal(persisted.submission_stop?.reason, 'confirmation_unproven');
    assert.ok(exitIsTheUnverifiedResolutionRoute(persisted),
      'exit: POST /applications/:id/submission/unverified');
  });

  /* THE SENTENCE THE INHERITANCE WAS WRITING, AND WHY IT HAD TO STOP.
   *
   * ManagedRequiredFieldConfirmationError extends NoSubmitControlError so that fail() reads it as a
   * stop that provably preceded the click. It does, and that half is right. What it also inherited
   * was the applicant-facing sentence, which is about a page where no send control could be found -
   * and the scope proof carried by the very run above says the opposite in its own fields:
   * submitMatchCount 1, sameNode true. The button was found, bound, and deliberately not pressed.
   *
   * Told "Litos could not find the button that sends this application" about a form whose Submit
   * button is plainly on screen, the honest reading is that the message is wrong, and the next one
   * is believed a little less. This is the stop she can most often actually act on, so it is the
   * worst one to spend that trust on.
   */
  test('a stop over a required answer says so, and does not blame a missing button', () => {
    const persisted = submissionFailureReview(
      claimedRunning(),
      refusalFor(blockedRun(['"Start date" is required and is still empty'])),
    );

    assert.doesNotMatch(persisted.attention_reason ?? '', /could not find the button/i,
      'the run bound the submit control uniquely and withheld the press, which is not the same event');
    assert.match(persisted.attention_reason ?? '', /found the button that sends it/i);
    assert.match(persisted.attention_reason ?? '', /could not confirm one of the required answers/i);
    assert.match(persisted.attention_reason ?? '', /nothing has been sent/i);
    assert.doesNotMatch(persisted.attention_reason ?? '', CLAIMS_A_SEND);
  });

  test('and everything else about the stop is exactly as it was', () => {
    /* The wording is the only thing that moves. The pre-click classification, the release, and the
       route out are what make this stop safe, and all three are inherited on purpose. */
    const persisted = submissionFailureReview(claimedRunning(), refusalFor(blockedRun(['Start date'])));

    assert.equal(persisted.status, 'needs_attention');
    assert.equal(persisted.submission_stop?.reason, 'no_submit_control');
    assert.equal(persisted.submission_stop?.before_click, true);
    assert.equal(persisted.submission_claimed_at, undefined);
    assert.equal(persisted.submission_attempted_at, undefined);
    assert.equal(persisted.unverified_submission, undefined);
    assert.ok(exitIsAnOrdinaryRerun(persisted));
  });

  /* A GENUINELY MISSING BUTTON KEEPS ITS OWN SENTENCE. The arm above outranks noSubmitControl, so
     the one thing that must be checked is that it did not swallow it: a plain NoSubmitControlError
     is the routine outcome on every multi-step first page and it is still described as one. */
  test('a run that really found no submit control still says exactly that', () => {
    const persisted = submissionFailureReview(
      claimedRunning(),
      new NoSubmitControlError('Atomic submit control was missing or ambiguous'),
    );

    assert.match(persisted.attention_reason ?? '', /could not find the button that sends this application/i);
    assert.doesNotMatch(persisted.attention_reason ?? '', /required answers/i);
  });
});

/* THE TWO REFUSALS THAT COULD NOT SAY WHY, AND THE ROW THEY WROTE INSTEAD.
 *
 * stratus builds two passes at points where it has bound nothing: managed-browser.js:15390, when
 * the caller-bound application form is unusable, and :15458, when the security-code controls do not
 * retain the exact code. Both refuse before any submit handle exists and report it with null
 * fingerprints, and until the unbound-scope branch the backend rejected both as malformed —
 * discarding six real refusal causes and naming an internal check in their place.
 *
 * WHAT THAT COST DEPENDED ON ONE FIELD. With submitOutcome.pressed === false present, the escape in
 * observedManagedSubmitWithheld still reached the right row by a second route, so the damage was
 * confined to the sentence. Without it — an older runner, a truncated retained result — the same
 * provably-unsent run wrote the full false-send row above: "Litos pressed Send", an unresolved
 * unverified_submission, and the claim kept. These tests hold the row for BOTH payloads, which is
 * the point of proving the no-send from the pass itself rather than from a sibling field.
 */
describe('a refusal that never bound a scope releases on its own proof', () => {
  /** The error the real validator throws. Nothing here hand-builds the error it asserts on. */
  function refusalFor(result: unknown, kind: 'application' | 'verification' = 'application'): unknown {
    try {
      assertManagedRequiredFieldsConfirmed(result, kind);
    } catch (error) {
      return error;
    }
    return assert.fail('a blocked proof must never be accepted');
  }

  /* The exact claim that must not be made about a run that never reached a submit control. */
  const CLAIMS_A_SEND = /Litos pressed Send/;

  function unboundRun(pass: unknown, submitOutcome?: unknown) {
    const result: Record<string, unknown> = {
      requiredFieldConfirmation: { version: 2, status: 'blocked', passes: [pass] },
    };
    if (submitOutcome !== undefined) result.submitOutcome = submitOutcome;
    return result;
  }

  /** managed-browser.js:15390, field for field. */
  const applicationScopeFailure = (blockerReason: string) => ({
    submitKind: 'application',
    scope: {
      scopeKind: null,
      formFingerprint: null,
      submitFingerprint: null,
      formMatchCount: 0,
      submitMatchCount: 0,
      requiredControlCount: 0,
      sameNode: false,
    },
    requiredControls: [],
    attempts: [],
    retries: 0,
    unresolved: ['The caller-bound application form was unavailable at submit time'],
    blockerReason,
    submissionOutcome: 'blocked',
  });

  /** managed-browser.js:15458, field for field. */
  const securityCodeUnretained = () => ({
    submitKind: 'verification',
    scope: {
      scopeKind: 'form',
      formFingerprint: null,
      submitFingerprint: null,
      formMatchCount: 1,
      submitMatchCount: 0,
      requiredControlCount: 0,
      sameNode: false,
    },
    requiredControls: [],
    attempts: [],
    retries: 0,
    unresolved: ['The security code controls did not retain the exact caller-supplied code'],
    blockerReason: 'successful_address_changed',
    submissionOutcome: 'blocked',
  });

  const WITHHELD = {
    pressed: false, state: 'not_attempted', source: null, evidence: null, message: null, formStillPresent: true,
  };

  test('an unusable application scope releases the packet, with or without a press report', () => {
    for (const reason of [
      'application_scope_missing',
      'application_scope_ambiguous',
      'application_scope_not_form',
      'application_scope_detached',
      'application_scope_unavailable',
    ]) {
      for (const [label, outcome] of [['reported', WITHHELD], ['silent', undefined]] as const) {
        const where = `${reason} (${label})`;
        const persisted = submissionFailureReview(
          claimedRunning(), refusalFor(unboundRun(applicationScopeFailure(reason), outcome)),
        );

        assert.doesNotMatch(persisted.attention_reason ?? '', CLAIMS_A_SEND,
          `${where}: the run never reached a submit control, so nothing was sent`);
        assert.equal(persisted.submission_attempted_at, undefined, where);
        assert.equal(persisted.unverified_submission, undefined,
          `${where}: there is no application to go and look for`);
        assert.equal(persisted.submission_stop?.before_click, true, where);
        assert.ok(exitIsAnOrdinaryRerun(persisted),
          `${where}: exit: POST /applications/:id/submit-request`);
      }
    }
  });

  test('a security code the controls did not retain releases the same way', () => {
    /* ONLY on a reported withholding, unlike the application shape above. A verification phase
       exists because an application phase preceded it, so "this phase bound nothing" cannot speak
       for whether the application was already sent. WITHHELD is strong enough because
       finalSubmitPressed is run-scoped in managed-browser.js: `pressed: false` on a continuation
       denies the press for the whole run. Silence is not, and is asserted below. */
    for (const [label, outcome] of [['reported', WITHHELD]] as const) {
      const persisted = submissionFailureReview(
        claimedRunning(), refusalFor(unboundRun(securityCodeUnretained(), outcome), 'verification'),
      );

      assert.doesNotMatch(persisted.attention_reason ?? '', CLAIMS_A_SEND, label);
      assert.equal(persisted.unverified_submission, undefined, label);
      assert.equal(persisted.submission_stop?.before_click, true, label);
      assert.ok(exitIsAnOrdinaryRerun(persisted), label);
    }
    /* With no press report at all a phase-0 press is unobservable, and releasing here re-applies to
       an employer that already holds the application. The row keeps its claim instead. */
    const silent = submissionFailureReview(
      claimedRunning(), refusalFor(unboundRun(securityCodeUnretained()), 'verification'),
    );
    assert.notEqual(silent.unverified_submission, undefined,
      'silence about the press cannot release a verification phase');
  });

  /* THE SAME CAUSE HAS TO REACH HER, NOT JUST THE SAME ROW. The row above was already correct
     whenever submitOutcome survived; what the branch adds is that the refusal can say what it was.
     A row that releases but still reports a contract violation has not fixed the reported half. */
  test('the released row names the refusal instead of an internal check', () => {
    const persisted = submissionFailureReview(
      claimedRunning(), refusalFor(unboundRun(applicationScopeFailure('application_scope_detached'), WITHHELD)),
    );
    const reported = `${persisted.submission_error ?? ''} ${persisted.attention_reason ?? ''}`;

    assert.match(reported, /application form was unavailable at submit time/,
      'the runner said why it stopped; the applicant is told that');
    assert.doesNotMatch(reported, /scope kind|scope identity|could not be read/,
      'the name of a backend check is not a reason a form could not be reached');
  });

  /* THE HALF THAT MUST NOT MOVE, restated for this shape. A pass describing no press, on a run that
     reports pressing, is a contradiction — and a contradiction stays unknown. */
  test('a claimed press still outranks a proof that describes no press', () => {
    const persisted = submissionFailureReview(
      claimedRunning(),
      refusalFor(unboundRun(applicationScopeFailure('application_scope_missing'), { ...WITHHELD, pressed: true })),
    );

    assert.equal(persisted.submission_stop?.reason, 'confirmation_unproven');
    assert.equal(persisted.submission_stop?.before_click, false);
    assert.ok(exitIsTheUnverifiedResolutionRoute(persisted),
      'exit: POST /applications/:id/submission/unverified');
    assert.equal(persisted.submission_claimed_at, CLAIMED_AT, 'and the lock stays on');
  });
});
