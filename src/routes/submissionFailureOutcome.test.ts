import test from 'node:test';
import assert from 'node:assert/strict';
import {
  delayedSecurityCodeHandoffReview,
  preClickNoSubmitReview,
  preClickSecurityRecipientMismatchReview,
  preClickVerificationContinuationBlockedReview,
  submissionFailureOutcome,
} from './submissionRunner';
import { resumeEditDisposition, submitRequestDisposition } from '../lib/submissionSafety';

const base = {
  captchaStop: null as 'before_fill' | 'at_submit' | null,
  noSubmitControl: false,
  /* TRUE ON EVERY CASE HERE, deliberately. The claim is taken at the top of a run, so by the time
     anything fails this is always true - which is exactly why every other stop reason has to
     outrank it. A branch that does not inherits "the submission was attempted and we could not
     verify it", and sends someone hunting for a receipt that cannot exist. */
  uncertainAfterClaim: true,
  externalGate: false,
  providerSessionFailure: false,
  currentAttentionReason: undefined as string | undefined,
};

test('a run that found no submit control says nothing was sent', () => {
  const out = submissionFailureOutcome({ ...base, noSubmitControl: true });
  assert.equal(out.status, 'needs_attention');
  assert.match(out.attentionReason!, /nothing has been sent/);
  assert.doesNotMatch(out.attentionReason!, /check the portal or your email/i,
    'the one sentence this branch exists to avoid');
});

test('the pre-click route transition is retryable and stores no attempted or submitted residue', () => {
  const current = {
    status: 'submission_claimed',
    submission_claimed_at: '2026-08-11T12:00:00.000Z',
    submission_claim_id: 'claim-id',
    submission_authorization: { source: 'standing_consent' },
    submission_attempted_at: '2026-08-11T12:00:01.000Z',
    unverified_submission: {
      attempted_at: '2026-08-11T12:00:01.000Z',
      cause: 'no_confirmation_state',
      portal_url: 'https://jobs.ashbyhq.com/kos/job/application',
    },
    submitted_at: '2026-08-11T12:00:02.000Z',
    receipt: {
      confirmation_text: 'stale confirmation',
      final_url: 'https://jobs.ashbyhq.com/kos/job/application',
      captured_at: '2026-08-11T12:00:02.000Z',
    },
    attention_reason: 'stale reason',
    updated_at: '2026-08-11T12:00:00.000Z',
  } as unknown as Parameters<typeof preClickNoSubmitReview>[0];
  const persisted = preClickNoSubmitReview(current, 'Atomic submit control was missing or ambiguous');
  assert.equal(persisted.status, 'needs_attention');
  assert.equal(persisted.submission_claimed_at, undefined);
  assert.equal(persisted.submission_claim_id, undefined);
  assert.equal(persisted.submission_authorization, undefined);
  assert.equal(persisted.submission_attempted_at, undefined);
  assert.equal(persisted.unverified_submission, undefined);
  assert.equal(persisted.submitted_at, undefined);
  assert.equal(persisted.receipt, undefined);
  assert.match(persisted.attention_reason!, /could not find the button that sends this application/);
  assert.match(persisted.attention_reason!, /nothing has been sent/);
  assert.doesNotMatch(persisted.attention_reason!, /could not verify the employer confirmation/);
});

test('a standing code wall for another alias stays non-restartable and preserves the challenge', () => {
  const current = {
    status: 'submission_claimed',
    submission_claimed_at: '2026-08-11T12:00:00.000Z',
    submission_claim_id: 'claim-id',
    submission_authorization: { source: 'standing_consent' },
    submission_attempted_at: '2026-08-11T12:00:01.000Z',
    unverified_submission: {
      attempted_at: '2026-08-11T12:00:01.000Z',
      cause: 'no_confirmation_state',
      portal_url: 'https://job-boards.greenhouse.io/embed/job_app?for=haizelabs&token=4685944008',
    },
    submitted_at: '2026-08-11T12:00:02.000Z',
    receipt: { confirmation_text: 'stale', final_url: 'stale', captured_at: 'stale' },
    security_code: { digits: 8, sent_to: 'packet@example.com', requested_at: 'stale', submit_was_authorized: true },
    verification: { status: 'searching' },
    updated_at: '2026-08-11T12:00:00.000Z',
  } as unknown as Parameters<typeof preClickSecurityRecipientMismatchReview>[0];
  const persisted = preClickSecurityRecipientMismatchReview(current, {
    digits: 8,
    sentTo: 'other@example.com',
  }, '2026-08-11T12:00:03.000Z');
  assert.equal(persisted.status, 'awaiting_security_code');
  assert.equal(persisted.submission_claimed_at, undefined);
  assert.equal(persisted.submission_claim_id, undefined);
  assert.equal(persisted.submission_authorization, undefined);
  assert.equal(persisted.submission_attempted_at, '2026-08-11T12:00:01.000Z',
    'the standing wall must not invent a current-run attempt or erase known prior evidence');
  assert.equal(persisted.security_code?.sent_to, 'other@example.com');
  assert.equal(persisted.security_code?.submit_was_authorized, false,
    'a wall for another recipient cannot inherit authorization from the packet recipient');
  assert.equal(persisted.security_code?.attempts, undefined);
  assert.equal(persisted.unverified_submission, undefined);
  assert.equal(persisted.submitted_at, undefined);
  assert.equal(persisted.receipt, undefined);
  assert.equal(persisted.verification?.status, 'verification_pending');
  assert.match(persisted.attention_reason!, /different application email/i);
  assert.match(persisted.attention_reason!, /already waiting/i);
  assert.equal(submitRequestDisposition(persisted.status), 'reject');
});

/* THE LOCK HAS TO HAVE A KEY, AND THIS TEST USED TO ASSERT THE TRAP INTO PLACE.
 *
 * It checked that the claim was retained and that submitRequestDisposition said 'reject', and never
 * asked the next question: what, then, can ever move this packet? The answer was nothing. Three
 * exits exist in this system and the shape it wrote closed all three at once - the ordinary submit
 * and resume-edit routes both go through submitRequestDisposition, the security-code endpoint needs
 * status 'awaiting_security_code' AND a null claim, and the unverified-resolution endpoint needs an
 * unverified_submission record that this branch deliberately clears.
 *
 * So the assertions below are the pair, not the half: still non-restartable through the ordinary
 * path, and provably finishable through the one route that is safe from a standing code wall.
 */
test('a delayed post-click code wall stays non-restartable and keeps the code route open', () => {
  const current = {
    status: 'submitting',
    submission_claimed_at: '2026-08-11T12:00:00.000Z',
    submission_claim_id: 'claim-id',
    submission_authorization: {
      source: 'standing_consent',
      authorized_at: '2026-08-11T11:59:59.000Z',
    },
    unverified_submission: {
      at: '2026-08-11T12:00:01.000Z',
      cause: 'no_confirmation_state',
    },
    updated_at: '2026-08-11T12:00:00.000Z',
  } as unknown as Parameters<typeof delayedSecurityCodeHandoffReview>[0];
  const persisted = delayedSecurityCodeHandoffReview(current, {
    securityCode: {
      digits: 8,
      sent_to: 'app-exact@apply.trylitos.com',
      requested_at: '2026-08-11T12:00:03.000Z',
      submit_was_authorized: true,
    },
    verification: {
      status: 'verification_pending',
      requested_at: '2026-08-11T12:00:03.000Z',
      retry_count: 0,
    },
    attemptedAt: '2026-08-11T12:00:03.000Z',
    screenshotUrl: 'https://proof.example/receipt.png',
  });
  assert.equal(persisted.submission_attempted_at, '2026-08-11T12:00:03.000Z');
  assert.equal(persisted.preview_screenshot_url, 'https://proof.example/receipt.png');
  assert.equal(persisted.security_code?.sent_to, 'app-exact@apply.trylitos.com');
  assert.equal(persisted.verification?.status, 'verification_pending');
  assert.equal(persisted.unverified_submission, undefined);
  assert.equal(persisted.submission_error, undefined);
  assert.deepEqual(persisted.attention_categories, ['security_code', 'evidence_gap']);
  assert.match(persisted.attention_reason!, /will not open a fresh form or send this application again on its own/);

  // THE LOCK. Neither another submit run nor a resume edit can move this packet, and the reason is
  // the status itself rather than the claim, so releasing the claim below does not weaken it.
  assert.equal(submitRequestDisposition(persisted.status, Boolean(persisted.submission_claimed_at)), 'reject');
  assert.equal(submitRequestDisposition(persisted.status, false), 'reject',
    'the status alone must refuse a re-run, with or without a claim on the row');
  assert.equal(resumeEditDisposition(persisted.status, Boolean(persisted.submission_claimed_at)), 'reject');

  /* THE KEY. POST /applications/:id/security-code is the one route that is safe from a standing
   * code wall, and it has two preconditions, both of which this state has to satisfy:
   * finishSecurityCodeSubmission requires status 'awaiting_security_code' with a security_code on
   * the row, and claimSecurityCodeSubmission then updates only WHERE submission_claimed_at is null.
   * Assert both, because satisfying either one alone still leaves the packet with no way out. */
  assert.equal(persisted.status, 'awaiting_security_code',
    'finishSecurityCodeSubmission answers not_awaiting on any other status');
  assert.ok(persisted.security_code, 'finishSecurityCodeSubmission needs the challenge it is finishing');
  assert.equal(persisted.submission_claimed_at, undefined,
    'claimSecurityCodeSubmission only claims a row whose submission_claimed_at is null');
  assert.equal(persisted.submission_claim_id, undefined);
  assert.equal(persisted.submission_authorization, undefined,
    'the code the applicant supplies is its own per-application approval, taken at claim time');
});

for (const cause of ['authorization_revoked', 'email_route_changed', 'email_permission_revoked'] as const) {
  for (const pressed of [true, false]) {
    test(`a ${cause} race after pressed=${pressed} preserves the challenge and cannot restart`, () => {
      const knownAttempt = undefined;
      const currentAttempt = pressed ? '2026-08-11T12:00:02.000Z' : undefined;
      const current = {
        status: 'submission_claimed',
        submission_claimed_at: '2026-08-11T12:00:00.000Z',
        submission_claim_id: 'claim-id',
        submission_authorization: { source: 'standing_consent' },
        submission_attempted_at: knownAttempt,
        unverified_submission: { attempted_at: 'stale', cause: 'no_confirmation_state', portal_url: 'stale' },
        submitted_at: 'stale',
        receipt: { confirmation_text: 'stale', final_url: 'stale', captured_at: 'stale' },
        updated_at: '2026-08-11T12:00:00.000Z',
      } as unknown as Parameters<typeof preClickVerificationContinuationBlockedReview>[0];
      const challenge = {
        digits: 8,
        sent_to: 'app-exact@apply.trylitos.com',
        requested_at: '2026-08-11T11:59:00.000Z',
        submit_was_authorized: true,
        attempts: undefined,
      };
      const persisted = preClickVerificationContinuationBlockedReview(current, challenge, cause, currentAttempt);
      assert.equal(persisted.status, 'awaiting_security_code');
      assert.equal(persisted.security_code, challenge);
      assert.equal(persisted.security_code?.attempts, undefined, 'the matched code is not fingerprinted before authorization');
      assert.equal(persisted.submission_claimed_at, undefined);
      assert.equal(persisted.submission_claim_id, undefined);
      assert.equal(persisted.submission_authorization, undefined);
      assert.equal(persisted.submission_attempted_at, currentAttempt,
        'pressed=false must not invent a current-run attempt marker');
      assert.equal(persisted.unverified_submission, undefined);
      assert.equal(persisted.submitted_at, undefined);
      assert.equal(persisted.receipt, undefined);
      assert.match(persisted.attention_reason!, /already waiting/i);
      assert.match(persisted.attention_reason!, /without clicking the verification button/i);
      assert.equal(submitRequestDisposition(persisted.status), 'reject');
    });
  }
}

test('action-time blocking preserves a genuine prior attempted marker on a retained wall', () => {
  const current = {
    status: 'submission_claimed',
    submission_attempted_at: '2026-08-11T11:58:00.000Z',
    updated_at: '2026-08-11T12:00:00.000Z',
  } as unknown as Parameters<typeof preClickVerificationContinuationBlockedReview>[0];
  const challenge = {
    digits: 8,
    requested_at: '2026-08-11T11:59:00.000Z',
    submit_was_authorized: true,
  };
  const persisted = preClickVerificationContinuationBlockedReview(current, challenge, 'authorization_revoked');
  assert.equal(persisted.submission_attempted_at, '2026-08-11T11:58:00.000Z');
});

test('no-submit-control outranks uncertainty, and captcha outranks both', () => {
  assert.match(
    submissionFailureOutcome({ ...base, noSubmitControl: true }).attentionReason!,
    /could not find the button/,
  );
  assert.match(
    submissionFailureOutcome({ ...base, noSubmitControl: true, captchaStop: 'at_submit' }).attentionReason!,
    /prove you are human/,
    'a challenge is the more actionable explanation when both are true',
  );
});

/* THE TWO STAGES ARE THE WHOLE POINT of carrying a stage at all, and neither sentence had a test.
   That gap is how prepareManaged shipped writing 'before_fill' on a path that fills the form first:
   nothing in the suite ever tied a stage to the words it produces, so a wrong stage read as a
   silent relabel rather than as a promise to an applicant. These pin the promise, not the prose. */
test('the two captcha stages promise different things about the form', () => {
  const atSubmit = submissionFailureOutcome({ ...base, captchaStop: 'at_submit' }).attentionReason!;
  const beforeFill = submissionFailureOutcome({ ...base, captchaStop: 'before_fill' }).attentionReason!;

  assert.match(atSubmit, /filled everything in/, 'the form is filled and one check remains');
  assert.doesNotMatch(atSubmit, /will fill it in for you/,
    'never offer to do work that is already done');

  assert.match(beforeFill, /will fill it in for you/, 'nothing was filled, so Litos still owes it');
  assert.doesNotMatch(beforeFill, /filled everything in/,
    'the sentence a filled-form stage must never inherit: the page it sends her to is blank');

  assert.equal(submissionFailureOutcome({ ...base, captchaStop: 'before_fill' }).status, 'needs_attention');
});

test('an uncertain run still says so, because there it is the truth', () => {
  const out = submissionFailureOutcome(base);
  assert.equal(out.status, 'needs_attention');
  assert.match(out.attentionReason!, /could not verify the employer confirmation/);
});

test('an email-route migration requires regeneration before uncertainty and says no request was sent', () => {
  const out = submissionFailureOutcome({ ...base, regenerationRequired: true });
  assert.equal(out.status, 'needs_attention');
  assert.match(out.attentionReason, /must be regenerated/i);
  assert.match(out.attentionReason, /nothing was sent to the employer/i);
  assert.doesNotMatch(out.attentionReason, /could not verify/i);
});

/* THE ONE THIS EXISTS FOR. buildPacket throws before a browser session is opened, but the submit()
   call site runs after claimSubmission, so before this arm existed an expired packet inherited
   uncertainAfterClaim and told the applicant to go and check her email for the confirmation of an
   application that was never filled in. Measured 2026-08-11: the first live packet crosses the
   30-day line around 2026-08-21. */
test('an expired packet says nothing was sent, and never sends anyone looking for a receipt', () => {
  const out = submissionFailureOutcome({ ...base, packetDocumentExpired: true });
  assert.equal(out.status, 'needs_attention');
  assert.match(out.attentionReason, /nothing was sent to the employer/i);
  assert.doesNotMatch(out.attentionReason, /check the portal or your email/i,
    'the sentence this arm exists to outrank');
  assert.doesNotMatch(out.attentionReason, /could not verify/i);
});

test('the expired-packet sentence names the retention window and asks for a regenerate, not a retry', () => {
  /* The recovery has to be the one that works. Retrying re-reads the same missing object, so a
     sentence that invited one would loop the applicant through an identical failure. */
  const reason = submissionFailureOutcome({ ...base, packetDocumentExpired: true }).attentionReason!;
  assert.match(reason, /30 days/, 'the promise on the privacy page is the explanation, so say it');
  assert.match(reason, /regenerate/i);
  assert.doesNotMatch(reason, /try again in a few minutes|something went wrong/i,
    'this is the retention policy working, not an outage to wait out');
});

test('a stop reason outranks an expired packet, because both are true and only one is the stop', () => {
  /* An expired packet is discovered while ASSEMBLING, so it cannot coexist with a captcha in a real
     run. Pinned anyway: the precedence chain is edited often, and this fixes where the new arm sits
     rather than leaving the next edit to rediscover it. */
  assert.match(
    submissionFailureOutcome({ ...base, packetDocumentExpired: true, captchaStop: 'at_submit' }).attentionReason!,
    /prove you are human/,
  );
  assert.match(
    submissionFailureOutcome({ ...base, packetDocumentExpired: true, regenerationRequired: true }).attentionReason!,
    /must be regenerated/i,
  );
});

test('the no-submit-control message names no cause, because it has four', () => {
  /* Multi-step first page, a page that renders nothing headless, a control relabelled mid-run, and
     a click that timed out before dispatching. Naming one would be false most of the time. */
  const reason = submissionFailureOutcome({ ...base, noSubmitControl: true }).attentionReason!;
  for (const cause of [/more than one page/i, /multi-?step/i, /timed out/i, /renders/i]) {
    assert.doesNotMatch(reason, cause);
  }
});

test('a provider outage is still reported as a provider outage', () => {
  const out = submissionFailureOutcome({
    ...base, uncertainAfterClaim: false, externalGate: true,
  });
  assert.equal(out.status, 'submit_requested');
});
