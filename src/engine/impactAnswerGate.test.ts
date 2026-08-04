import assert from 'node:assert/strict';
import test from 'node:test';
import { applyImpactAnswers, bulletKey } from './recentExperience';
import { STRONG_VERBS, firstWordOf, startsWithStrongVerb } from './resumeValidate';

/* The /start impact step's escape hatch, "Continue with what you found.", and the leading-blank
 * case that used to 400 it.
 *
 * Every fixture below leans on one fact, so it is asserted rather than assumed: the parsed bullet
 * "Responsible for ..." fails the strong-verb rule. If "responsible" is ever added to the
 * whitelist these tests would still pass while testing nothing, which is the failure this first
 * case exists to prevent. Banks are two bullets wherever an index is under test, so that
 * `existing[0]` cannot be confused with `existing[index]` or with the last bullet. */

const PARSED_WEAK_BULLET = 'Responsible for the front desk schedule.';
const SECOND_BANK_BULLET = 'Trained four hires.';

test('the fixture is genuinely weak, or nothing below is being tested', () => {
  assert.equal(STRONG_VERBS.has('responsible'), false);
  assert.equal(startsWithStrongVerb(PARSED_WEAK_BULLET), false);
  assert.equal(startsWithStrongVerb(SECOND_BANK_BULLET), true);
});

test('a blank first answer set never reaches the verb rule, so the escape hatch survives it', () => {
  const result = applyImpactAnswers(
    [PARSED_WEAK_BULLET, SECOND_BANK_BULLET],
    [{}, { action: 'Built', noun: 'a shift tracker' }],
  );
  assert.ok(!('error' in result), 'a leading blank must not 400 on the student untouched bullet');
  assert.deepEqual(result.additions, ['Built a shift tracker.']);
  assert.deepEqual(result.bullets, [PARSED_WEAK_BULLET, SECOND_BANK_BULLET, 'Built a shift tracker.']);
});

test('an all-blank set adds nothing and leaves the bank exactly as it was', () => {
  const result = applyImpactAnswers([PARSED_WEAK_BULLET, SECOND_BANK_BULLET], [{}, {}, {}]);
  assert.ok(!('error' in result));
  assert.deepEqual(result.additions, []);
  assert.deepEqual(result.bullets, [PARSED_WEAK_BULLET, SECOND_BANK_BULLET]);
});

test('an empty answers array adds nothing', () => {
  const result = applyImpactAnswers([PARSED_WEAK_BULLET], []);
  assert.ok(!('error' in result));
  assert.deepEqual(result.additions, []);
  assert.deepEqual(result.bullets, [PARSED_WEAK_BULLET]);
});

/* The rule is not relaxed by recognising echoes first. A bullet that is not an echo is by
 * construction absent from the bank, so it is new, and every new bullet is still judged. */

test('a new bullet the student types without a strong verb is still rejected', () => {
  const result = applyImpactAnswers(
    ['Built a reporting dashboard.'],
    [{ action: 'Responsible for', noun: 'the front desk schedule' }],
  );
  assert.deepEqual(result, { error: 'verb', bullet: 'Responsible for the front desk schedule.' });
});

test('a weak bullet at a later index is rejected even when the first set is blank', () => {
  const result = applyImpactAnswers(
    [PARSED_WEAK_BULLET, SECOND_BANK_BULLET],
    [{}, { action: 'Responsible for', noun: 'closing counts' }],
  );
  assert.deepEqual(result, { error: 'verb', bullet: 'Responsible for closing counts.' });
});

test('nothing weak can enter the bank on any accepted path', () => {
  const result = applyImpactAnswers(
    [PARSED_WEAK_BULLET],
    [{}, { action: 'Built', noun: 'a shift tracker' }, { action: 'Trained', noun: 'four hires' }],
  );
  assert.ok(!('error' in result));
  for (const bullet of result.additions) {
    assert.equal(startsWithStrongVerb(bullet), true, `${bullet} entered the bank ungated`);
  }
});

/* Positions are load-bearing. Index 0 is the "Strengthen this accomplishment" fieldset and is the
 * only one composed against the entry's existing first bullet; every later index composes from the
 * student's own words alone. Compacting the array away would move an answer between the two. */

test('index 0 composes against the FIRST bank bullet, and that edit is gated', () => {
  const result = applyImpactAnswers(
    [PARSED_WEAK_BULLET, SECOND_BANK_BULLET],
    [{ metric_or_scope: 'across three shifts' }],
  );
  assert.deepEqual(result, {
    error: 'verb',
    bullet: 'Responsible for the front desk schedule across three shifts.',
  });
});

test('a later index is composed from the student words alone, never folded onto a bank bullet', () => {
  const result = applyImpactAnswers(
    [PARSED_WEAK_BULLET, SECOND_BANK_BULLET],
    [{}, { action: 'Built', metric_or_scope: 'across three shifts' }],
  );
  assert.ok(!('error' in result));
  assert.deepEqual(result.additions, ['Built across three shifts.']);
});

test('a blank slot is not closed up, even when closing it up would produce a valid bullet', () => {
  /* The decisive case for the no-compaction rule, because here compaction SUCCEEDS and produces a
   * bullet that reads well. Sliding the second fieldset's answer onto index 0 would compose it
   * against "Built a reporting dashboard", and composing it against the LAST bank bullet would
   * pick up "Trained four hires"; either yields a strong-verb bullet the gate happily accepts and
   * the bank keeps, carrying a result the student wrote about one accomplishment onto another.
   * Held positionally the same answer composes from nothing and is refused, which is the correct
   * outcome even though it is the less pleasant one. */
  const bank = ['Built a reporting dashboard.', SECOND_BANK_BULLET];
  const result = applyImpactAnswers(bank, [{}, { outcome: 'cutting review time by 30%' }]);
  assert.ok('error' in result, 'an outcome with no verb of its own is not a bullet');
  for (const existing of bank) {
    assert.equal(
      result.bullet.includes(existing.replace(/\.$/, '')),
      false,
      `the second fieldset answer was composed onto ${existing}`,
    );
  }
  assert.deepEqual(result, { error: 'verb', bullet: ', cutting review time by 30%.' });
});

/* Recognising echoes before judging is what makes the verb message ("Each NEW bullet ...") true.
 * An echo of something already in the bank is not new, whatever it opens with. */

test('a re-typed existing bullet is dropped, not rejected, however it is punctuated', () => {
  /* Deliberately NOT character-identical to the bank bullet: different case, a hyphen the bank
   * bullet does not have, and a doubled space. Identity has to survive all three, or this passes
   * against a plain === and pins nothing about the fold. */
  const typed = { action: 'RESPONSIBLE FOR', noun: 'the  front-desk  schedule' };
  const composed = 'RESPONSIBLE FOR the front-desk schedule.';
  assert.notEqual(composed, PARSED_WEAK_BULLET, 'the fixture must differ as a string');
  const result = applyImpactAnswers([PARSED_WEAK_BULLET], [typed]);
  assert.ok(!('error' in result));
  assert.deepEqual(result.additions, []);
  assert.deepEqual(result.bullets, [PARSED_WEAK_BULLET]);
});

test('two identical new answer sets add the bullet once', () => {
  const answer = { action: 'Built', noun: 'a shift tracker' };
  const result = applyImpactAnswers(['Trained four hires.'], [answer, answer]);
  assert.ok(!('error' in result));
  assert.deepEqual(result.additions, ['Built a shift tracker.']);
});

test('an entry with no bullets at all composes index 0 from the answers alone', () => {
  const result = applyImpactAnswers([], [{ action: 'Built', noun: 'a shift tracker' }]);
  assert.ok(!('error' in result));
  assert.deepEqual(result.bullets, ['Built a shift tracker.']);
});

/* ── The unreadable class ────────────────────────────────────────────────────────────────────
 * A composed bullet can fold down to a key with no letters or digits in it at all. The commonest
 * way for a real student to get there is answering in a non-Latin script, and Litos serves
 * international students, so this is a product decision and not only a dedupe detail.
 *
 * The trigger is SCRIPT, not language: no Latin letter and no digit survives the fold. A
 * Latin-script answer in another language keys fine and still gets the older, misleading verb
 * message, which this branch deliberately does not touch.
 *
 * It is REJECTED, with its own message. Accepting it is not available: `firstWordOf` matches
 * `[a-zA-Z]+`, so such a bullet can never satisfy the strong-verb rule that every other writer in
 * this product enforces, and admitting it would put an unjudged claim in the bank that every
 * downstream generator assumes has been judged. Dropping it silently is worse still: on the
 * escape hatch the step completes and the student's typing is gone with nothing said. So the only
 * honest option left is to refuse and say why, in words that name the actual problem.
 * ─────────────────────────────────────────────────────────────────────────────────────────── */

const CJK_ANSWER = { action: '管理', noun: '前台排班' };

test('an answer with no Latin letters could never have been accepted anyway', () => {
  // The premise of rejecting rather than accepting. If this ever becomes true, revisit the class.
  assert.equal(firstWordOf('管理 前台排班.'), '');
  assert.equal(startsWithStrongVerb('管理 前台排班.'), false);
  assert.equal(bulletKey('管理 前台排班.'), '');
});

test('a non-Latin answer is refused, and not with the verb message', () => {
  const result = applyImpactAnswers([PARSED_WEAK_BULLET], [CJK_ANSWER]);
  assert.deepEqual(result, { error: 'unreadable', bullet: '管理 前台排班.' });
});

test('a non-Latin answer is never silently swallowed', () => {
  // The regression this class exists to prevent: a 200 that quietly kept nothing the student typed.
  const result = applyImpactAnswers([PARSED_WEAK_BULLET], [{}, CJK_ANSWER]);
  assert.ok('error' in result, 'text the student typed must not vanish without a word');
});

test('a padded non-Latin bank bullet still has a working escape hatch', () => {
  /* The echo comparison has to trim BOTH sides. The route filters `existing` on
   * `value.trim().length > 0` and never trims the value, so a bullet carrying stray padding out of
   * the parse or a JSONB round-trip reaches this function as-is. `composeImpactBullet` returns
   * `current.trim()`, so the composed side is already trimmed; if the bank side is not, the two
   * never match, the empty key takes over, and the blank first fieldset is refused as unreadable.
   * That is the original bug again, for a bank one parser quirk away from the ordinary one. */
  const result = applyImpactAnswers(['  管理前台排班  '], [{}]);
  assert.ok(!('error' in result), 'padding on a bank bullet must not 400 the escape hatch');
  assert.deepEqual(result.additions, []);
});

test('a bank written in a non-Latin script still has a working escape hatch', () => {
  /* The reason echoes are matched on exact text as well as on the key. This bank bullet's key is
   * empty, so the key alone cannot recognise index 0's echo of it, and without the text arm the
   * blank first fieldset would be refused as unreadable: the original bug, for a different bank. */
  const bank = ['管理前台排班。'];
  assert.equal(bulletKey(bank[0]), '', 'the fixture must actually have an empty key');
  const result = applyImpactAnswers(bank, [{}, { action: 'Built', noun: 'a shift tracker' }]);
  assert.ok(!('error' in result), 'a blank index 0 must not 400 on a non-Latin bank bullet');
  assert.deepEqual(result.additions, ['Built a shift tracker.']);
});

/* ── bulletKey, pinned in both directions ────────────────────────────────────────────────────
 * The whole safety argument rests on which bullets this function calls the same bullet. Too
 * coarse and a distinct accomplishment is swallowed as a duplicate; too fine and a re-typed
 * bullet enters the bank twice. Neither direction was constrained before.
 * ─────────────────────────────────────────────────────────────────────────────────────────── */

test('the key ignores case, punctuation and repeated spaces', () => {
  const canonical = bulletKey('Built a front desk tracker');
  assert.equal(bulletKey('BUILT a front desk tracker.'), canonical);
  assert.equal(bulletKey('built, a front-desk  tracker!'), canonical);
  assert.equal(bulletKey('  "Built a front desk tracker."  '), canonical);
});

test('the key has no leading or trailing padding of its own', () => {
  // Pins the trim: the fold turns the full stop into a space, and it must not survive.
  assert.equal(bulletKey('Built a tracker.'), 'built a tracker');
  assert.equal(bulletKey('...Built a tracker...'), 'built a tracker');
});

test('the key keeps word boundaries, so unlike bullets stay unlike', () => {
  // Folding the runs to nothing instead of to a space would make these one bullet.
  assert.notEqual(bulletKey('Led a review'), bulletKey('Leda review'));
  assert.notEqual(bulletKey('Built a shift tracker.'), bulletKey('Built a staff roster.'));
  assert.notEqual(bulletKey('Trained four hires.'), bulletKey('Trained fourteen hires.'));
});

test('digits are part of a bullet identity', () => {
  assert.notEqual(bulletKey('Cut review time by 30%.'), bulletKey('Cut review time by 80%.'));
});

test('a Latin-script answer in another language is NOT the unreadable class', () => {
  /* Pins the scope of the change honestly. This student is still told to pick a stronger verb,
   * which is still the wrong advice for them. Documented as a gap, not fixed here. */
  const result = applyImpactAnswers([PARSED_WEAK_BULLET], [{}, { action: 'Dirigi', noun: 'el equipo' }]);
  assert.deepEqual(result, { error: 'verb', bullet: 'Dirigi el equipo.' });
});
