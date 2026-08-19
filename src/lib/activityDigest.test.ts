import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NEEDS_YOU_STATUSES,
  activityDigestDedupeKey,
  digestIsEmpty,
  digestMessage,
  type ActivityDigest,
} from './activityDigest';

function digest(over: Partial<ActivityDigest> = {}): ActivityDigest {
  const base = { applied: 0, needs_you: 0, employer_replies: 0, applied_companies: [] as string[], ...over };
  return { ...base, empty: digestIsEmpty(base) };
}

test('a quiet day produces no message at all', () => {
  /* THE PROPERTY THAT MAKES A DIGEST WORTH OPENING. A standing-total digest says something every
     day and is therefore worth reading on none of them. This one has to be capable of silence, and
     silence is the return value rather than a caller's convention. */
  const quiet = digest();
  assert.equal(quiet.empty, true);
  assert.equal(digestMessage(quiet), null);
});

test('it never says "applied" for work that was only prepared', () => {
  /* THE SINGLE MOST DAMAGING SENTENCE THIS PRODUCT COULD PRINT. `applied` is fed only by packets
     carrying a real _review.submitted_at, which is written when an employer actually received the
     form. A digest that counted prepared packets would tell a student Litos applied to 22 roles
     when it sent none, and every later claim would be worth nothing. */
  const prepared = digest({ needs_you: 22 });
  const message = digestMessage(prepared);
  assert.ok(message);
  assert.doesNotMatch(`${message.title} ${message.body}`, /applied/i);
  assert.match(message.body, /22 need your input/);
  assert.equal(message.title, 'Your applications moved');
});

test('a real submission is named, and the title says so', () => {
  const message = digestMessage(digest({ applied: 3, applied_companies: ['Ramp', 'Notion', 'Stripe'] }));
  assert.ok(message);
  assert.equal(message.title, 'Litos applied for you');
  assert.match(message.body, /Applied to 3 roles, including Ramp and Notion/);
  // Two names at most: an OS notification body is a couple of lines and a third name truncates it.
  assert.doesNotMatch(message.body, /Stripe/);
});

test('one application reads as one, not as "1 roles"', () => {
  const message = digestMessage(digest({ applied: 1, applied_companies: ['Ramp'] }));
  assert.equal(message?.body, 'Applied to Ramp.');
});

test('singulars and plurals hold across every count', () => {
  assert.match(digestMessage(digest({ employer_replies: 1 }))!.body, /1 employer reply\./);
  assert.match(digestMessage(digest({ employer_replies: 2 }))!.body, /2 employer replies\./);
  assert.match(digestMessage(digest({ needs_you: 1 }))!.body, /1 needs your input\./);
  assert.match(digestMessage(digest({ needs_you: 5 }))!.body, /5 need your input\./);
});

test('the three facts appear in the order that matters, most consequential first', () => {
  const message = digestMessage(digest({ applied: 2, needs_you: 5, employer_replies: 1, applied_companies: ['Ramp'] }));
  assert.ok(message);
  const body = message.body;
  assert.ok(body.indexOf('Applied') < body.indexOf('employer'), 'what Litos did leads');
  assert.ok(body.indexOf('employer') < body.indexOf('need your input'), 'a reply outranks a backlog line');
});

test('ready_to_submit is deliberately not a "needs you" state', () => {
  /* It is the ordinary resting state of a prepared packet. Counting it would put a number in every
     digest forever, which is the standing-total behaviour this whole design exists to avoid. */
  assert.equal((NEEDS_YOU_STATUSES as readonly string[]).includes('ready_to_submit'), false);
  assert.equal((NEEDS_YOU_STATUSES as readonly string[]).includes('submitted'), false);
  // awaiting_security_code IS included: Litos already sent that one and is stuck on eight
  // characters in her mailbox, which is the most time-sensitive thing this product ever says.
  assert.equal((NEEDS_YOU_STATUSES as readonly string[]).includes('awaiting_security_code'), true);
  assert.deepEqual([...NEEDS_YOU_STATUSES], ['needs_attention', 'ready_for_final_approval', 'awaiting_security_code', 'failed']);
});

test('the dedupe key is per account per day', () => {
  const morning = new Date('2026-08-19T06:00:00.000Z');
  const night = new Date('2026-08-19T23:00:00.000Z');
  assert.equal(activityDigestDedupeKey('u1', morning), activityDigestDedupeKey('u1', night));
  assert.notEqual(activityDigestDedupeKey('u1', morning), activityDigestDedupeKey('u2', morning));
  assert.notEqual(
    activityDigestDedupeKey('u1', morning),
    activityDigestDedupeKey('u1', new Date('2026-08-20T06:00:00.000Z')),
  );
});

test('an unnamed employer does not produce a dangling "including"', () => {
  // job_context.company is written by every generation path but its contents are the caller's, so
  // a packet with no company name must still render a whole sentence.
  const message = digestMessage(digest({ applied: 2, applied_companies: [] }));
  assert.equal(message?.body, 'Applied to 2 roles.');
});
