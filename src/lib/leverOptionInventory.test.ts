/* LEVER'S OPTION LISTS, WHICH DISCOVERY READS AND THE PACKET THREW AWAY.
 *
 * WHAT WAS BELIEVED AND IS NOT TRUE. `has_field_options: false` on every Lever packet was read as
 * "Stratus discovery cannot see Lever's options". It can. Run in a real browser against the
 * transcribed Belvedere DOM (stratus-browser-cloud test/question-label-dom.test.js holds the same
 * markup), `optionsOf` returns all four degree options, because Lever wraps each option in its own
 * <label> and blockOf already knows `li.application-question`.
 *
 * WHERE THEY WERE LOST. Lever names every custom question `cards[<uuid>][field0]`. The inventory-key
 * pattern accepted a bare identifier with at most a TRAILING `[]` - Greenhouse's checkbox shape - so
 * brackets in the middle produced no key at all. managedOptionProbeControlId answered undefined,
 * managedOptionProbeAnalysis hit its `!id` guard, and the list discovery had already read was
 * discarded on the way into the packet.
 *
 * WHY IT MATTERS EVEN THOUGH THE ANSWER RESOLVES ANYWAY. Resolution reads `field.options` off the
 * discovered field, so the degree snaps to the employer's own "Bachelor Degree" with or without this.
 * The packet MAP is what the fill-time rules read, and two of them are inert without it: the gate that
 * stops an alias ladder firing the raw profile value at a control already answered correctly, and the
 * decomposition of a reviewed multi-select answer into exact option texts.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { managedOptionProbeAnalysis, managedOptionProbeControlId } from './portalSubmission';

/** The Belvedere degree control, as discovery reports it. Four options, one shared name. */
const LEVER_DEGREE = {
  label: 'what degree are you currently pursuing?',
  selector: '[data-litos-discovered-7]',
  durableSelector: '[name="cards[9f2b1c7a-0000-4000-8000-000000000001][field0]"]',
  inputType: 'radio',
  role: null,
  required: true,
  options: ['High School Diploma', 'Associate Degree', 'Bachelor Degree', 'Masters/PhD'],
};

describe('a Lever custom question gets an option inventory key', () => {
  test('the bracketed name is a key, so the packet keeps the list discovery read', () => {
    const controlId = managedOptionProbeControlId(LEVER_DEGREE);
    assert.equal(controlId, 'name:cards[9f2b1c7a-0000-4000-8000-000000000001][field0]');

    const { options } = managedOptionProbeAnalysis('lever', [LEVER_DEGREE], {}, [], [], false);
    assert.deepEqual(options[controlId!], LEVER_DEGREE.options,
      'the employer\'s own four options reach packet.fieldOptions');
  });

  /* The exact symptom the ledger recorded, asserted as the thing it measured rather than as a key. */
  test('has_field_options is true for a Lever packet', () => {
    const { options } = managedOptionProbeAnalysis('lever', [LEVER_DEGREE], {}, [], [], false);
    assert.ok(Object.keys(options).length > 0);
  });

  /* A name key must never become a probe selector. These names carry `[` and `]`, which would be a
   * broken CSS selector, and that is why widening the pattern is safe at all. */
  test('a bracketed name is never probed, so it cannot reach a selector', () => {
    const { failures, failedIds } = managedOptionProbeAnalysis('lever', [LEVER_DEGREE], {}, [], [], false);
    assert.deepEqual(failures, []);
    assert.equal(failedIds.size, 0);
  });
});

describe('the shapes that already worked are untouched', () => {
  for (const [durableSelector, expected] of [
    ['[name="degree"]', 'name:degree'],
    // Greenhouse's checkbox group, the one bracket shape the old pattern did allow.
    ['[name="question_67998838[]"]', 'name:question_67998838[]'],
    ['[name="a.b:c-d"]', 'name:a.b:c-d'],
    ['#firstName', 'firstName'],
    ['[id="school--0"]', 'school--0'],
  ] as const) {
    test(`${durableSelector} still keys to ${expected}`, () => {
      assert.equal(managedOptionProbeControlId({ label: 'x', durableSelector }), expected);
    });
  }
});

describe('malformed names are still refused', () => {
  for (const durableSelector of ['[name=""]', '[name="[bad]"]', '[name="a"b"]', 'div', '']) {
    test(`${durableSelector || '(empty)'} yields no key`, () => {
      assert.equal(managedOptionProbeControlId({ label: '', durableSelector }), undefined);
    });
  }
});

/* TWO QUESTIONS ON ONE CARD ARE TWO KEYS. Lever's uuid is the card and fieldN is the question, so a
 * card holding a degree radio group and a graduation dropdown must not collapse into one entry - the
 * count-of-one guard would then drop both lists rather than attach the wrong one. */
test('two questions on the same Lever card keep separate option lists', () => {
  const uuid = '9f2b1c7a-0000-4000-8000-000000000001';
  const graduation = {
    ...LEVER_DEGREE,
    label: 'when do you graduate?',
    selector: '[data-litos-discovered-8]',
    durableSelector: `[name="cards[${uuid}][field1]"]`,
    options: ['December 2026/January 2027', 'May/June 2027'],
  };

  const { options } = managedOptionProbeAnalysis('lever', [LEVER_DEGREE, graduation], {}, [], [], false);

  assert.deepEqual(options[`name:cards[${uuid}][field0]`], LEVER_DEGREE.options);
  assert.deepEqual(options[`name:cards[${uuid}][field1]`], graduation.options);
});
