import assert from 'node:assert/strict';
import test from 'node:test';
import {
  employerReplyDedupeKey,
  shouldNotifyEmployerReply,
} from './employerReplyNotification';
import {
  applicationEmailForwardingDecision,
  handleStoredEmployerMessage,
  type ApplicationEmailClassification,
  type StoredEmployerMessageDeps,
  type StoredInboundMessage,
} from './applicationEmail';

const CLASSIFICATIONS: ApplicationEmailClassification[] = [
  'submission_confirmation',
  'interview_request',
  'verification_code',
  'recruiter_reply',
  'applicant_reply',
  'other',
];

test('the alert covers exactly the employer mail the forward keeps internal', () => {
  /* THE INVARIANT, stated as a relationship rather than as a list, so it cannot drift when either
     side changes. Anything the forwarding path delivers is already in her inbox and must not be
     announced a second time; anything it keeps internal is mail she would otherwise never hear
     about, minus the two classes that are not an employer replying to her at all. */
  for (const classification of CLASSIFICATIONS) {
    const forwards = applicationEmailForwardingDecision(classification).forward;
    const notifies = shouldNotifyEmployerReply({ classification, forwarded: forwards });
    if (forwards) {
      assert.equal(notifies, false, `${classification} is forwarded, so an alert would be the same event twice`);
    }
  }
});

test('a verification code is never announced, and neither is the applicant to herself', () => {
  /* A code is held internally on purpose so the managed session can read it, and it is a
     credential. An applicant_reply is the STUDENT'S own message on its way out: telling her she
     has replied to herself is the shape of bug that survives review because nobody pictures the
     outbound leg. */
  assert.equal(shouldNotifyEmployerReply({ classification: 'verification_code', forwarded: false }), false);
  assert.equal(shouldNotifyEmployerReply({ classification: 'applicant_reply', forwarded: false }), false);
});

test('a plain human reply that matches no keyword is still announced', () => {
  /* `other` is the important case rather than the leftover. The classifier is regexes over a
     subject line, so "Hi, are you free Thursday?" lands here, and excluding it would mean the
     plainest real replies were the ones this feature missed. */
  assert.equal(shouldNotifyEmployerReply({ classification: 'other', forwarded: false }), true);
  assert.equal(shouldNotifyEmployerReply({ classification: 'recruiter_reply', forwarded: false }), true);
});

test('one inbound message has one dedupe key, whatever the webhook does', () => {
  assert.equal(employerReplyDedupeKey('abc'), 'employer_reply:abc');
  assert.notEqual(employerReplyDedupeKey('abc'), 'strong_match:abc', 'the two kinds cannot collide on a shared uuid');
});

function deps(over: Partial<StoredEmployerMessageDeps> = {}): StoredEmployerMessageDeps {
  return {
    resolveConfirmation: async () => ({ resolved: false, reason: 'not_found' }) as never,
    claimForwarding: async () => true,
    forward: async () => undefined,
    markForwarded: async () => undefined,
    recordForwardFailure: async () => undefined,
    ...over,
  };
}

const aliasRow = {
  alias: 'apply+abc@trylitos.com',
  user_id: '6d58c1f5-e885-41f7-a16a-dac37f98ab17',
  generated_resume_id: null,
  forward_to: 'student@example.edu',
};

const message: StoredInboundMessage = {
  id: '0b84c4eb-5c91-43d0-a5a0-62b508d8ce55',
  from_email: 'recruiter@ramp.com',
  subject: 'Following up',
  text: 'Are you free Thursday?',
  html: null,
  received_at: new Date('2026-08-19T12:00:00.000Z'),
  forwarded_at: null,
};

test('an internal-only employer message fires the alert once', async () => {
  const fired: Array<{ messageId: string; classification: string }> = [];
  const result = await handleStoredEmployerMessage({
    aliasRow,
    message,
    classification: 'recruiter_reply',
    receivedAt: new Date('2026-08-19T12:00:00.000Z'),
  }, deps({
    notifyReply: async (input) => { fired.push({ messageId: input.messageId, classification: input.classification }); },
  }));
  assert.equal(result.forwarded, false);
  assert.deepEqual(fired, [{ messageId: message.id, classification: 'recruiter_reply' }]);
});

test('a forwarded message does not also fire the alert', async () => {
  let fired = 0;
  const result = await handleStoredEmployerMessage({
    aliasRow,
    message,
    classification: 'interview_request',
    receivedAt: new Date('2026-08-19T12:00:00.000Z'),
  }, deps({ notifyReply: async () => { fired += 1; } }));
  assert.equal(result.forwarded, true);
  assert.equal(fired, 0, 'the mail itself landed; an alert beside it announces the same event twice');
});

test('a message that was never stored fires nothing, because there is no key to dedupe on', async () => {
  let fired = 0;
  const result = await handleStoredEmployerMessage({
    aliasRow,
    message: null,
    classification: 'recruiter_reply',
    receivedAt: new Date('2026-08-19T12:00:00.000Z'),
  }, deps({ notifyReply: async () => { fired += 1; } }));
  assert.equal(result.forwarded, false);
  assert.equal(fired, 0, 'without a stored row a redelivery would send a second copy');
});

test('a failing alert cannot make the webhook redeliver the message', async () => {
  /* The webhook reads any throw as "not handled, redeliver", and the forwarding path relies on
     that to retry. A courtesy alert is not worth replaying a message whose storage and packet
     resolution already succeeded. */
  const result = await handleStoredEmployerMessage({
    aliasRow,
    message,
    classification: 'other',
    receivedAt: new Date('2026-08-19T12:00:00.000Z'),
  }, deps({ notifyReply: async () => { throw new Error('Resend is down'); } }));
  assert.equal(result.accepted, true);
  assert.equal(result.forwarded, false);
});

test('deps without a notifier behave exactly as they did before this feature', async () => {
  const result = await handleStoredEmployerMessage({
    aliasRow,
    message,
    classification: 'recruiter_reply',
    receivedAt: new Date('2026-08-19T12:00:00.000Z'),
  }, deps());
  assert.equal(result.accepted, true);
  assert.equal(result.forwarded, false);
  assert.equal(result.reason, 'internal_only');
});
