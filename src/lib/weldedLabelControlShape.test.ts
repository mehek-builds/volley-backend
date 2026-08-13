/* A TEXT BOX HAS NO TICK, SO IT CANNOT ACCEPT A DOCUMENT.
 *
 * The welded-label refusal (PR 507) exists for a measured harm stated as "one control, one tick,
 * two statements": a label that welds an employer document to a claim about the applicant gets
 * answered by the declaration branch, accepting the document as a side effect.
 *
 * It ignored control shape, so it also refused ordinary factual fields carrying a boilerplate
 * consent footer. Measured on main after 507 landed:
 *
 *   'Expected graduation date. By submitting you accept our Terms and Conditions.'   2027-05 -> skip
 *   'Which university do you attend? Read our privacy policy for how we use this.'   USC     -> skip
 *
 * Typing a date into a text input accepts nothing, so those refusals bought no safety at all. This
 * file pins both halves: the refusal still covers every control a tick or a choice can be made on,
 * and text-shaped controls answer again.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  controlCanAcceptADocument,
  frozenJobEmployerContext,
  refreshKnownQuestionAnswers,
  resolveKnownAnswer,
  type ApplicationProfileLike,
} from './questionDiscovery';
import { resolveProfileField } from './profileFieldResolution';
import { postingCountryFromJobContext } from './jobLocation';

process.env.ENCRYPTION_KEY ??= 'test-encryption-key-at-least-32-chars-long';

/* A populated profile, so a refusal below is never "nothing on file". Each of these is the fact the
 * footer-bearing field is actually asking for. */
const STORED: ApplicationProfileLike = {
  work_authorized: true,
  needs_sponsorship: true,
  school: 'University of Southern California',
  grad_date: '2027-05',
  grad_year: 2027,
  date_of_birth: '2005-06-01',
  work_eligibility_by_country: [
    { country_code: 'US', authorized_now: true, needs_sponsorship_now: false, needs_sponsorship_future: true },
  ],
};

const JD = frozenJobEmployerContext('Acme');
const COUNTRY = postingCountryFromJobContext({ location: 'New York, NY, United States', country: 'United States' });

function resolve(label: string, inputType: string, options?: string[]) {
  return resolveKnownAnswer(
    label, inputType, STORED, JD, COUNTRY, 'US', controlCanAcceptADocument(inputType, options),
  );
}
function answer(label: string, inputType: string, options?: string[]): string | null {
  const r = resolve(label, inputType, options);
  return r && 'value' in r ? r.value : null;
}
function held(label: string, inputType: string, options?: string[]): string | null {
  const r = resolve(label, inputType, options);
  return r && 'skipReason' in r ? r.skipReason : null;
}

/* Both welded shapes, including the SECOND instance found in review, which the original write-up
 * did not name. Both resolve "Yes" on a pre-507 tree with nothing granted. */
const WELDED = [
  ['work authorization', 'I acknowledge the Privacy Statement and confirm I am legally authorized to work in the United States.'],
  ['age', 'I have read the Candidate Privacy Notice and confirm I am over 18.'],
  ['background authorization', 'I accept the Applicant Terms and authorize a background check.'],
] as const;

/* An ordinary factual field with a consent footer. The document is mentioned, but the control is a
 * box you type into, so there is nothing on it that could accept anything. */
const FOOTERED: Array<[string, string, string]> = [
  ['graduation date', 'Expected graduation date. By submitting you accept our Terms and Conditions.', '2027-05'],
  ['university', 'Which university do you attend? Read our privacy policy for how we use this.', 'University of Southern California'],
];

describe('the refusal still covers everything a tick can accept with', () => {
  test('every welded label is refused on a checkbox', () => {
    for (const [what, label] of WELDED) {
      assert.equal(answer(label, 'checkbox'), null, `${what} must not be answered: ${label}`);
      assert.ok(held(label, 'checkbox'), `${what} must say why it is left`);
    }
  });

  test('and on every other shape a choice can be made on', () => {
    for (const shape of ['radio', 'select', 'combobox', 'listbox', 'select-one']) {
      for (const [what, label] of WELDED) {
        assert.equal(answer(label, shape), null, `${what} must not be answered on a ${shape}`);
      }
    }
  });

  test('an option list overrides the input type, whatever the type claims', () => {
    /* A control reporting itself as "text" while offering choices is one a choice can be made on.
     * Discovery does report that shape, so the list wins outright. */
    for (const [what, label] of WELDED) {
      assert.equal(answer(label, 'text', ['I agree', 'I do not agree']), null, `${what} with a list`);
      assert.equal(
        resolveProfileField({ label, inputType: 'text', options: ['I agree', 'I do not agree'] }, STORED, JD, COUNTRY, 'US'),
        null,
      );
    }
  });

  test('an unknown or missing shape fails closed', () => {
    // The direction that matters: a caller that does not know what it is looking at keeps the
    // refusal rather than inheriting the relaxation.
    assert.equal(controlCanAcceptADocument(undefined), true);
    assert.equal(controlCanAcceptADocument(''), true);
    assert.equal(controlCanAcceptADocument('some-future-widget'), true);
    for (const [, label] of WELDED) assert.equal(answer(label, 'some-future-widget'), null);
  });
});

describe('a text-shaped control answers again', () => {
  test('a factual field wearing a consent footer resolves its fact', () => {
    for (const [what, label, expected] of FOOTERED) {
      assert.equal(answer(label, 'text'), expected, `${what} must answer again: ${label}`);
    }
  });

  test('every text-like shape is treated the same way', () => {
    for (const shape of ['text', 'textarea', 'email', 'tel', 'url', 'number', 'date', 'search']) {
      assert.equal(controlCanAcceptADocument(shape), false, `${shape} cannot accept a document`);
    }
  });

  test('the same label on a checkbox is still refused, so the shape is doing the work', () => {
    /* The control that proves this is a SHAPE rule and not a relaxation of the weld grammar: one
     * label, two shapes, two outcomes. */
    const [, label] = FOOTERED[0];
    assert.equal(answer(label, 'text'), '2027-05');
    assert.equal(answer(label, 'checkbox'), null);
  });
});

describe('the refresh path cannot be used to slip one through', () => {
  test('a welded label stored against a checkbox is still wiped', () => {
    /* THE HAZARD THIS DESIGN EXISTS FOR. refreshKnownQuestionAnswers passes a hardcoded 'text',
     * because that literal is about how the ANSWER is parsed and not about the control. A rule
     * reading the shape straight off that parameter would relax the refusal for every welded
     * CHECKBOX on this path and quietly put "Yes" back on it. */
    const question = {
      question: WELDED[0][1],
      answer: 'Yes',
      portal_input_type: 'checkbox',
    };
    assert.equal(refreshKnownQuestionAnswers([question], STORED, JD)[0].answer, '');
  });

  test('and so is one whose stored shape is missing entirely', () => {
    const question = { question: WELDED[1][1], answer: 'Yes' };
    assert.equal(refreshKnownQuestionAnswers([question], STORED, JD)[0].answer, '');
  });

  test('but a footered text field keeps its answer across a refresh', () => {
    // The recovery has to survive the packet rebuild too, or it is not a recovery.
    const [, label, expected] = FOOTERED[0];
    const question = { question: label, answer: expected, portal_input_type: 'text' };
    assert.equal(refreshKnownQuestionAnswers([question], STORED, JD)[0].answer, expected);
  });
});
