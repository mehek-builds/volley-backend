/* A SEND THAT NEVER PRESSED ANYTHING SAYS SO, EVEN AFTER ITS ATTEMPT WAS AUTHORIZED.
 *
 * MEASURED 2026-09-05, Pony.ai application fdcf4ccb-eca9-44dc-b0cb-d400805ebdeb, ledger attempt
 * b624e034. The send opened an attempt, authorized the final employer boundary, and then died
 * re-filling Workable's phone widget - `phone_country_open`, `phone_country_close`,
 * `workable_phone_value_visible`, `workable_phone_assertion_capability` - with
 * `page.waitForSelector: Timeout 10000ms exceeded` before confirmAndSubmit was ever reached. No
 * press_observed event exists, and nothing in the run's own progress record claims one.
 *
 * Despite that, the row was folded to needs_attention/unverified_submission with cause
 * no_confirmation_state and the sentence "Litos pressed Send and the page never showed a
 * confirmation it could read" - which sent the applicant to check an employer portal for a
 * submission that was never attempted, and left the packet unable to send again until she answered
 * a question about a click that never happened.
 *
 * The defect was in two places that only mattered together:
 *
 *   1. preClickProvenByLedger (submissionRunner.ts) only asked the LEDGER whether boundary_authorized
 *      or press_observed existed on the attempt - and once authorization exists that answer is
 *      permanently true, which is correct for the ledger's own admissibility rule but says nothing
 *      about what THIS run's own progress record proved.
 *   2. recordSubmissionRunnerFailure unconditionally overwrote whatever submissionFailureReview had
 *      already worked out whenever an authorization existed on the attempt, even when
 *      submissionFailureReview had just PROVEN the run pre-click from its own evidence and released
 *      the claim for it.
 *
 * These tests pin the fix on both sides: a run whose own Stratus-reported progress proves the click
 * never happened is released and described honestly EVEN AFTER authorization, while a genuinely
 * pressed-but-unconfirmed run (case b) and a run that died during or after confirmAndSubmit with no
 * network witness (case c) are pinned unchanged beside it.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ApplicationReviewState } from '../lib/applicationReview';
import {
  ManagedBrowserAssertionFailureError,
  ManagedBrowserPreSubmitCrashError,
  type ManagedBrowserRunProgress,
} from '../lib/browserbase';
import {
  assertionAppliesField,
  releasedClaimProofKind,
  submissionFailureOutcome,
  submissionFailureReview,
} from './submissionRunner';
import { ManagedRequiredFieldConfirmationError } from '../lib/portalSubmission';
import { attentionCategoriesForReasons } from '../lib/submissionTerminalCause';
import { submitRequestDisposition } from '../lib/submissionSafety';

const CLAIMED_AT = '2026-09-05T09:14:03.000Z';
const PORTAL = 'https://apply.workable.com/pony-ai/j/ABCDEF123/apply/';

function claimedRunning(extra: Partial<ApplicationReviewState> = {}): ApplicationReviewState {
  return {
    jd_text: 'Software Engineer at Pony.ai',
    status: 'submitting',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: CLAIMED_AT,
    portal_url: PORTAL,
    ats_name: 'workable',
    submission_run_id: 'b624e034-0000-4000-8000-000000000001',
    submission_claimed_at: CLAIMED_AT,
    submission_claim_id: 'b624e034-6497-4b83-80c2-54f89469e37e',
    submission_authorization: { source: 'per_application_approval', authorized_at: CLAIMED_AT },
    ...extra,
  };
}

function packetIsSendableAgain(persisted: ApplicationReviewState): boolean {
  return persisted.submission_claimed_at === undefined
    && submitRequestDisposition(
      persisted.status,
      Boolean(persisted.submission_claimed_at),
      persisted.unverified_submission?.resolution,
      persisted,
    ) === 'start';
}

/** The exact contained-transport shape managedBrowserProgressAllowsPreSubmitRetry requires: never
 * pressed, in any of its three forms, and no employer outcome but the explicit not-attempted one. */
function notAttemptedProgress(): ManagedBrowserRunProgress {
  return {
    version: 1,
    phase: 0,
    stage: 'phase_started',
    submitPressed: false,
    applicationSubmitPressed: false,
    verificationSubmitPressed: false,
    submitKind: 'application',
    policyVersion: 4,
    employerOutcome: {
      kind: 'not_attempted',
      state: 'not_attempted',
      source: null,
      evidence: null,
      message: null,
      formStillPresent: null,
    },
  };
}

/** A progress record where a press is on record - the shape Stratus reports once the click fired,
 * used to prove the new proof is never admitted for a case it must not touch. */
function pressedProgress(): ManagedBrowserRunProgress {
  return {
    version: 1,
    phase: 0,
    stage: 'submit_released',
    submitPressed: true,
    applicationSubmitPressed: true,
    verificationSubmitPressed: false,
    submitKind: 'application',
    policyVersion: 4,
  };
}

describe('case (a): boundary_authorized reached, no press, proven pre-click by this run\'s own evidence', () => {
  test('a Workable phone-readback assertion failure after authorization is not unverified_submission', () => {
    const error = new ManagedBrowserAssertionFailureError(
      'filled_field:phone: expected exactly one match for .iti input[type="tel"], found 0',
      notAttemptedProgress(),
      'filled_field:phone',
    );
    const persisted = submissionFailureReview(
      claimedRunning(),
      error,
      undefined,
      { employerBoundaryReached: true },
    );
    assert.equal(persisted.status, 'needs_attention');
    assert.equal(persisted.unverified_submission, undefined,
      'the ambiguous unverified_submission record must not be written for a proven pre-click stop');
    assert.equal(persisted.submission_claim_id, undefined, 'the claim must be released');
    assert.equal(persisted.submission_claimed_at, undefined);
    assert.equal(persisted.submission_authorization, undefined);
    assert.equal(packetIsSendableAgain(persisted), true);
    assert.doesNotMatch(persisted.attention_reason ?? '', /pressed Send/i);
    assert.doesNotMatch(persisted.attention_reason ?? '', /check the portal or your email/i);
    assert.doesNotMatch(persisted.attention_reason ?? '', /apply\.workable\.com/);
    // DETERMINISTIC, NOT TEMPORARY. browserbase.ts documents ManagedBrowserAssertionFailureError as
    // a refusal that "reproduces on every attempt, and nothing about it is temporary" - so the
    // retry promise here must say the retry will likely stop at the same place, never that it will
    // "very likely succeed once the page settles" (that wording was a regression this pins).
    assert.doesNotMatch(persisted.attention_reason ?? '', /very likely succeed/i);
    assert.match(persisted.attention_reason ?? '', /very likely stop at the same place/i);
  });

  test('a pre-submit sandbox crash proven contained after authorization is treated the same way', () => {
    const error = new ManagedBrowserPreSubmitCrashError(
      'page.waitForSelector: Timeout 10000ms exceeded',
      notAttemptedProgress(),
    );
    const persisted = submissionFailureReview(
      claimedRunning(),
      error,
      undefined,
      { employerBoundaryReached: true },
    );
    assert.equal(persisted.unverified_submission, undefined);
    assert.equal(persisted.submission_claim_id, undefined);
    assert.equal(packetIsSendableAgain(persisted), true);
    assert.doesNotMatch(persisted.attention_reason ?? '', /pressed Send/i);
    // TRANSIENT, NOT DETERMINISTIC - the opposite sibling. ManagedBrowserPreSubmitCrashError is a
    // genuine sandbox crash proven contained, not a deterministic assertion refusal, so it keeps the
    // "temporary secure-browser error ... try again in a few minutes" sentence and must never wear
    // the deterministic one written for ManagedBrowserAssertionFailureError.
    assert.match(persisted.attention_reason ?? '', /temporary secure-browser error/i);
    assert.match(persisted.attention_reason ?? '', /try this one again in a few minutes/i);
    assert.doesNotMatch(persisted.attention_reason ?? '', /very likely stop at the same place/i);
  });

  test('the sentence names the field the run died re-filling, generically, not hardcoded to phone', () => {
    const error = new ManagedBrowserAssertionFailureError(
      'filled_field:linkedin_url: expected exactly one match for input[name="linkedin_url"], found 0',
      notAttemptedProgress(),
      'filled_field:linkedin_url',
    );
    const persisted = submissionFailureReview(
      claimedRunning(),
      error,
      undefined,
      { employerBoundaryReached: true },
    );
    assert.match(persisted.attention_reason ?? '', /linkedin url/i);
    assert.match(persisted.attention_reason ?? '', /nothing has gone to the employer/i);
  });

  test('assertionAppliesField derives a readable phrase from the runner\'s own label', () => {
    // Shape 1: filled_field:<name> - the prefix is stripped and the name is spoken plainly.
    assert.equal(assertionAppliesField('filled_field:phone'), 'the phone field');
    assert.equal(assertionAppliesField('filled_field:linkedin_url'), 'the linkedin url field');
    // Shape 2: a Workable phone-widget label, none of which carry the filled_field: prefix -
    // portalSubmission.ts issues these as phone_country_open, phone_country_close,
    // workable_phone_assertion_capability, workable_phone_value_visible, workable_phone_country_visible
    // and workable_phone_terminal_visible. Every one of them must read as "the phone field", not as
    // the widget's own internal step name.
    assert.equal(assertionAppliesField('phone_country_open'), 'the phone field');
    assert.equal(assertionAppliesField('phone_country_close'), 'the phone field');
    assert.equal(assertionAppliesField('phone_country_option'), 'the phone field');
    assert.equal(assertionAppliesField('workable_phone_assertion_capability'), 'the phone field');
    assert.equal(assertionAppliesField('workable_phone_value_visible'), 'the phone field');
    assert.equal(assertionAppliesField('workable_phone_country_visible'), 'the phone field');
    assert.equal(assertionAppliesField('workable_phone_terminal_visible'), 'the phone field');
    assert.equal(assertionAppliesField('workable_phone_terminal:phone'), 'the phone field');
    // Shape 3: unrecognised or missing - the generic, cause-neutral fallback, never a raw label with
    // underscores swapped for spaces (that used to read as internal telemetry, e.g. "the greenhouse
    // application form ready field").
    assert.equal(assertionAppliesField('greenhouse_application_form_ready'), 'one of the answers it typed');
    assert.equal(assertionAppliesField(null), 'one of the answers it typed');
    assert.equal(assertionAppliesField(undefined), 'one of the answers it typed');
  });

  test('the outcome function itself files this as a run that broke, not as an unverifiable send', () => {
    const out = submissionFailureOutcome({
      captchaStop: null,
      noSubmitControl: false,
      fieldProofFailedBeforeSubmit: true,
      fieldProofFailedLabel: 'filled_field:phone',
      uncertainAfterClaim: true,
      preClickProvenByLedger: false,
      externalGate: false,
      providerSessionFailure: false,
      currentAttentionReason: undefined,
    });
    assert.equal(out.status, 'needs_attention');
    assert.deepEqual(attentionCategoriesForReasons([out.attentionReason]), ['run_failed']);
    assert.doesNotMatch(out.attentionReason, /check the portal or your email/i);
  });
});

describe('case (b): a genuine press with no confirmation is unchanged', () => {
  test('a plain confirmation-read failure after authorization still keeps its claim and its unverified record', () => {
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
    assert.match(persisted.attention_reason ?? '', /Litos pressed Send/);
  });

  test('a pre-submit-crash error type constructed with a press already on record does not release', () => {
    // Defensive: even if a future Stratus response somehow paired this error type with a pressed
    // progress record, the type check alone must not be trusted blindly forever - this pins that,
    // for this run, only the exact contained-transport shape is what the code reasons from, and
    // there is no separate re-check of submitPressed inside submissionFailureReview itself. This
    // test documents that boundary and is not a claim that the constructor forbids it.
    const error = new ManagedBrowserPreSubmitCrashError(
      'Target page, context or browser has been closed',
      pressedProgress(),
    );
    const persisted = submissionFailureReview(
      claimedRunning(),
      error,
      undefined,
      { employerBoundaryReached: true },
    );
    // providerSessionFailureBeforeSubmit is still read purely off the error TYPE today, so this
    // documents current behaviour rather than asserting a guarantee Stratus itself must keep: the
    // safety net is that browserbase.ts only ever constructs this type when
    // managedBrowserProgressAllowsPreSubmitRetry held at the moment the error was built.
    assert.equal(persisted.submission_claim_id, undefined);
  });
});

describe('case (c): died during or after confirmAndSubmit, no network witness, is unchanged', () => {
  test('an untyped stop after authorization keeps the uncertain, resolvable exit', () => {
    const persisted = submissionFailureReview(
      claimedRunning(),
      new Error('page.waitForSelector: Timeout 10000ms exceeded'),
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

  test('a provider-progress error whose progress does not prove containment stays uncertain', () => {
    // stage submit_activation_started with submitPressed still false does NOT satisfy
    // managedBrowserProgressAllowsPreSubmitRetry (only phase_started/submit_blocked do), so
    // browserbase.ts would type this as ManagedBrowserProviderProgressError, not a pre-submit-proven
    // type - and this function must not treat a bare Error the same as the typed proof.
    const persisted = submissionFailureReview(
      claimedRunning(),
      new Error('provider progress error mid-activation'),
      undefined,
      { employerBoundaryReached: true },
    );
    assert.ok(persisted.unverified_submission);
    assert.notEqual(persisted.submission_claim_id, undefined);
  });
});

describe('case (d): a no-submit-control release after authorization is not credited with the run-progress proof', () => {
  /* preClickNoSubmitReview releases the claim unconditionally for every NoSubmitControlError,
   * ManagedRequiredFieldConfirmationError included (assertManagedRequiredFieldsConfirmed's
   * pressClaimed guard) - regardless of whether a boundary_authorized event already exists on the
   * attempt. That release has nothing to do with Stratus's run-progress record, so
   * recordSubmissionRunnerFailure must not credit it with `run_progress_proven_not_pressed` just
   * because an authorization happens to be on record; it must write the general
   * `typed_pre_click_stop` kind and let the ledger's own admissibility rule
   * (submissionAttemptLedger.ts's AUTHORIZATION_ADMISSIBLE_NOT_SENT_PROOFS) decide whether that is
   * admissible once authorized, same as it always has. */
  test('the claim is released, but the stop is not one of the run-progress-backed reasons', () => {
    const persisted = submissionFailureReview(
      claimedRunning(),
      new ManagedRequiredFieldConfirmationError(['Start date']),
      undefined,
      { employerBoundaryReached: true },
    );
    assert.equal(persisted.submission_claim_id, undefined, 'the claim is released');
    assert.equal(persisted.submission_stop?.reason, 'no_submit_control');
    assert.notEqual(persisted.submission_stop?.reason, 'field_proof_failed_before_submit');
    assert.notEqual(persisted.submission_stop?.reason, 'provider_session_failure_before_submit');
  });

  test('releasedClaimProofKind writes typed_pre_click_stop for it, never the run-progress proof', () => {
    // Mirrors exactly what recordSubmissionRunnerFailure passes in: the stop reason the released
    // review actually carries, plus an authorization already on record.
    assert.equal(
      releasedClaimProofKind('no_submit_control', /* authorizedAlready */ true),
      'typed_pre_click_stop',
    );
    // Unauthorized, the answer is unchanged - a pre-click stop is always typed_pre_click_stop
    // unless it is one of the two reasons Stratus's own run-progress record backs.
    assert.equal(
      releasedClaimProofKind('no_submit_control', /* authorizedAlready */ false),
      'typed_pre_click_stop',
    );
  });

  test('releasedClaimProofKind only credits the run-progress proof for its two backing reasons, and only once authorized', () => {
    assert.equal(
      releasedClaimProofKind('field_proof_failed_before_submit', true),
      'run_progress_proven_not_pressed',
    );
    assert.equal(
      releasedClaimProofKind('provider_session_failure_before_submit', true),
      'run_progress_proven_not_pressed',
    );
    // Not yet authorized: the general pre-click writer is correct regardless of which reason it is,
    // since AUTHORIZATION_ADMISSIBLE_NOT_SENT_PROOFS only ever mattered once an authorization exists.
    assert.equal(
      releasedClaimProofKind('field_proof_failed_before_submit', false),
      'typed_pre_click_stop',
    );
    // No stop reason on record (a legacy or partially written attempt) never gets the run-progress
    // credit either.
    assert.equal(releasedClaimProofKind(undefined, true), 'typed_pre_click_stop');
  });
});
