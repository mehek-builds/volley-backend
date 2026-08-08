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
