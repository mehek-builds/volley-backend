import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionFailureOutcome } from './submissionRunner';

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
