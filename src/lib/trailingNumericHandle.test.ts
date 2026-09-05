/* A NUMBER THE EMPLOYER WROTE IS PART OF THE QUESTION, and what says otherwise is that the question
 * had already ended before the digits started.
 *
 * GREENHOUSE_TRAILING_NUMERIC_HANDLE_RE removes a short trailing digit run so a Greenhouse
 * demographic id ("what is your gender? 245") stops being read to the applicant as part of the
 * question. It used to accept that run wherever it sat, on nothing but position, and tidyLabel's
 * job is to remove exactly the trailing `*`. The strip runs first, so:
 *
 *   raw     "Question 10*"    the `*` sits behind the digits, so the strip does not fire
 *   mint    "Question 10"     tidyLabel removes the `*` that was shielding them
 *   re-read "Question"        now the digits are trailing, and the strip takes them
 *
 * normalizeStoredPortalQuestions re-normalizes the stored label on EVERY read, so the number came
 * off permanently on the read after the mint. That is the identity drift #902 closed for the
 * repeat-collapse, arriving through the handle strip instead: the packet becomes a permanent
 * SUPERSET of the approval, the fill reports questions the approval never covered, she answers and
 * re-approves, and the next run says exactly the same thing.
 *
 * AND IT COLLAPSES DISTINCT QUESTIONS, which is the worse half and the reason a stability
 * assertion alone is not enough. "Question" is a perfect fixpoint of the old normalizer, so
 * comparing normalize(normalize(x)) to normalize(x) passes on the collapsed value while sixteen of
 * twenty-five employer questions have already been merged into it. The count is the test that
 * catches it, and both are below.
 *
 * MEASURED against production on 2026-09-03: 847 distinct stored question labels over 601 packets
 * and 4,022 rows. The rule fired on none of them, before or after this change. Every
 * whitespace-separated trailing numeric run in that corpus is 7 digits (Workable option ids) or 10
 * (Greenhouse demographic ids, owned by GREENHOUSE_TRAILING_LONG_NUMERIC_HANDLE_RE). The
 * two-to-five digit window matched nothing live, while it did reach ordinary sentences that end in
 * a number.
 *
 * THE FIRST ATTEMPT AT THIS FIX WAS WRONG, and the record is worth keeping. Requiring the required
 * marker in front of the digits looked like the discriminator, because #252's two cases both carry
 * one. It is not: the four Hudson River Trading comboboxes measured in prod on 2026-09-02 are
 * "what is your gender? 245" with no marker anywhere, and demanding one broke the join in
 * greenhouseDemographicQuestions.ts that gives those four their options. The marker is one way a
 * label ends; the sentence-final punctuation before it is the general one.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { tidyLabel } from './fieldLabel';
import {
  PROVIDER_HANDLE_ONLY_SCRIPT,
  normalizeDiscoveredLabel,
  normalizeReviewQuestionLabel,
  normalizeStoredPortalQuestions,
} from './questionDiscovery';

/** The read every stored question goes through, as the runner and the audit route both take it. */
function storedRead(label: string): string | undefined {
  const [row] = normalizeStoredPortalQuestions(
    [{ question: label, answer: '', portal_selector: '#q' }],
    'greenhouse',
  );
  return row?.question;
}

/** Discovery mints once, then the row is read back N times. What is the label left standing? */
function afterReads(raw: string, reads: number): string {
  let label = normalizeReviewQuestionLabel(raw);
  for (let read = 0; read < reads; read += 1) label = storedRead(label) ?? '';
  return label;
}

/* THE RULE STILL DOES ITS JOB, which is the assertion that says this is a narrowing and not a
 * removal: delete the rule outright and every other test in this file still passes.
 *
 * The first four are the Hudson River Trading comboboxes measured in prod on 2026-09-02 (packet
 * 4a79eec1), whose ids the board publishes and which greenhouseDemographicQuestions.ts joins by the
 * label with the id removed - so a label that keeps its id loses its options and parks. The last two
 * are the cases #252 was opened for. None of them carries a marker in front of the digits on its
 * own, so the required marker cannot be what identifies a handle; the closed question is. */
test('a Greenhouse demographic id after a finished question is still stripped', () => {
  const handles: [string, string][] = [
    ['what is your gender? 245', 'what is your gender?'],
    ['are you a veteran? 248', 'are you a veteran?'],
    ['do you have a disability? 249', 'do you have a disability?'],
    ['what is your race/ethnicity? 250', 'what is your race/ethnicity?'],
    ['what gender identity do you most closely identify with? * 430', 'what gender identity do you most closely identify with?'],
    ['are you a person of transgender experience? * 431', 'are you a person of transgender experience?'],
  ];
  for (const [raw, expected] of handles) {
    assert.equal(normalizeReviewQuestionLabel(raw), expected, `the mint kept a handle on ${JSON.stringify(raw)}`);
    // And it stays off across the reads that follow, which is where the old rule did its damage.
    assert.equal(afterReads(raw, 4), expected, `four reads moved ${JSON.stringify(raw)}`);
  }
});

test('a number the employer wrote is kept, however many times the row is read', () => {
  /* Each of these ends in a two-to-five digit run with no marker in front of it. The old rule took
   * the run off the second read onwards; a denominator is not plumbing. */
  const written: [string, string][] = [
    ['Question 10', 'Question 10'],
    ['Rate your proficiency from 1 to 10', 'Rate your proficiency from 1 to 10'],
    ['What was your SAT score out of 1600', 'What was your SAT score out of 1600'],
    ['How many years, 1 to 5', 'How many years, 1 to 5'],
    ['On a scale of 1 to 100', 'On a scale of 1 to 100'],
  ];
  for (const [raw, expected] of written) {
    assert.equal(normalizeDiscoveredLabel(raw), expected, `mint moved ${JSON.stringify(raw)}`);
    assert.equal(afterReads(raw, 5), expected, `five reads moved ${JSON.stringify(raw)}`);
  }
});

test('the label discovery mints is the label every later read produces', () => {
  /* The property, not a list of shapes: one application of the normalizer has to land where every
   * later one lands, or the mint and the read are two different questions to every comparison
   * keyed on the employer's words. */
  const shapes = [
    'Question 10*',
    'Question 10',
    'Question 1*',
    'Question 25*',
    'what gender identity do you most closely identify with? * 430',
    'are you a person of transgender experience? * 431',
    'What was your SAT score out of 1600',
    'What was your SAT score out of 1600*',
    'Rate your proficiency from 1 to 10*',
    'do you consider yourself a member of the lgbtqia+ community? * 4000362002',
    'are you a person living with a disability? 4000995002',
    /* An id that is itself followed by a marker, and an id repeated the way a name-and-attribute
     * join repeats one. Both settle in a single pass or the mint and the read disagree again. */
    'what gender identity do you most closely identify with? * 430*',
    'what gender identity do you most closely identify with? * 430 * 431',
  ];
  for (const raw of shapes) {
    const once = normalizeDiscoveredLabel(raw);
    assert.equal(
      normalizeDiscoveredLabel(once),
      once,
      `normalizeDiscoveredLabel moved a label it had already produced: ${JSON.stringify(raw)}`,
    );
    assert.equal(
      normalizeReviewQuestionLabel(normalizeReviewQuestionLabel(raw)),
      normalizeReviewQuestionLabel(raw),
      `normalizeReviewQuestionLabel moved a label it had already produced: ${JSON.stringify(raw)}`,
    );
    // And through the real stored read, which is the one that runs on every packet build.
    const minted = normalizeReviewQuestionLabel(raw);
    if (minted) {
      assert.equal(storedRead(minted), minted, `the stored read renamed ${JSON.stringify(raw)}`);
    }
  }
});

test('the normalizer settles whichever side tidyLabel is applied from', () => {
  /* tidyLabel is inside normalizeDiscoveredLabel, and it is also reached on its own by
   * humanFieldLabel. Composing the two in either order has to land on the same label, or the value
   * a caller holds depends on which door it came through. */
  const shapes = [
    'Question 10*',
    'Question 10',
    'Question 25*',
    'what gender identity do you most closely identify with? * 430',
    'What was your SAT score out of 1600*',
    'Rate your proficiency from 1 to 10',
  ];
  for (const raw of shapes) {
    const normalizeThenTidy = tidyLabel(normalizeDiscoveredLabel(raw));
    const tidyThenNormalize = normalizeDiscoveredLabel(tidyLabel(raw));
    assert.equal(
      normalizeThenTidy,
      normalizeDiscoveredLabel(raw),
      `tidyLabel moved a label the normalizer had settled: ${JSON.stringify(raw)}`,
    );
    assert.equal(
      tidyThenNormalize,
      normalizeDiscoveredLabel(raw),
      `the order of tidyLabel and the normalizer changed the label: ${JSON.stringify(raw)}`,
    );
  }
});

/* THE COUNT, WHICH IS THE ASSERTION A STABILITY TEST CANNOT MAKE.
 *
 * "Question" is its own fixpoint, so a build that has already merged sixteen questions into it
 * passes every idempotence check above. Only counting the survivors says whether the employer's
 * questions are still there. Measured on this fixture during the #900 round: an iterated stripper
 * produced 10 distinct labels out of 25. */
test('twenty-five numbered controls stay twenty-five questions, read after read', () => {
  const raw = Array.from({ length: 25 }, (_, index) => `Question ${index + 1}*`);

  const minted = raw.map((label) => normalizeReviewQuestionLabel(label));
  assert.equal(new Set(minted).size, 25, `discovery minted ${new Set(minted).size} distinct questions from 25 controls`);

  /* The collapse on main did not happen in one pass - it happened on the read AFTER the mint, and
   * again on the read after that. So the count has to survive repeated reads, not just the mint. */
  for (const reads of [1, 2, 3, 8]) {
    const survivors = raw.map((label) => afterReads(label, reads));
    assert.equal(
      new Set(survivors).size,
      25,
      `after ${reads} read(s), 25 controls collapsed onto ${new Set(survivors).size} questions`
      + ` (e.g. ${JSON.stringify([...new Set(survivors)].slice(0, 4))})`,
    );
    assert.ok(
      !survivors.includes('Question'),
      `after ${reads} read(s) a numbered question was reduced to the bare word "Question"`,
    );
  }

  // The numbers themselves are what distinguishes them, so spot-check the ends of the range.
  assert.equal(afterReads('Question 1*', 8), 'Question 1');
  assert.equal(afterReads('Question 10*', 8), 'Question 10');
  assert.equal(afterReads('Question 25*', 8), 'Question 25');
});

test('one numbered control is one row, and the packet does not grow on re-reads', () => {
  /* The superset half of the same defect, driven through the real stored read: a form of three
   * numbered questions has to still be three questions on every later read, or the approval can
   * never cover the packet. */
  const questions = [
    { question: normalizeReviewQuestionLabel('Question 8*'), answer: 'a', portal_selector: '#q8' },
    { question: normalizeReviewQuestionLabel('Question 10*'), answer: 'b', portal_selector: '#q10' },
    { question: normalizeReviewQuestionLabel('Question 12*'), answer: 'c', portal_selector: '#q12' },
  ];
  let rows = questions;
  for (let read = 0; read < 6; read += 1) {
    rows = normalizeStoredPortalQuestions(rows, 'greenhouse');
    assert.equal(rows.length, 3, `read ${read + 1} left ${rows.length} rows for a three-question form`);
  }
  assert.deepEqual(rows.map((row) => row.question), ['Question 8', 'Question 10', 'Question 12']);
  assert.deepEqual(rows.map((row) => row.answer), ['a', 'b', 'c'], 'a read must not move answers between questions');
});

test('the page script recompiles this rule, so it stays inside what a page engine accepts', () => {
  /* PROVIDER_HANDLE_STRIPPERS is serialised into PROVIDER_HANDLE_ONLY_SCRIPT as `source` plus
   * `flags` and rebuilt there with `new RegExp(...)`, because the page cannot import this module.
   * A regex feature the backend accepts and the page engine does not would throw INSIDE the page,
   * where the failure is a silent fall-through rather than a red test. Compiling the script here is
   * what turns that into a build-time failure. Lookbehind is ES2018 and has been in V8 since Chrome
   * 62, which is the floor for both the extension and stratus-browser-cloud. */
  const compiled = new Function(`${PROVIDER_HANDLE_ONLY_SCRIPT} return isProviderHandleOnly;`)() as (value: string) => boolean;

  // A label with words in it is never handle-only, whichever side of the rule it falls.
  for (const label of ['Question 10*', 'what is your gender? 245', 'What was your SAT score out of 1600']) {
    assert.equal(compiled(label), false, `the page script called ${JSON.stringify(label)} handle-only`);
  }
  // And the twin still agrees with the module on the thing it exists to decide.
  assert.equal(compiled('question_66274349'), true);
  assert.equal(compiled(''), true);
});
