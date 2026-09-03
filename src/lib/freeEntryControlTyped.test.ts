import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FREE_ENTRY_INPUT_TYPE,
  optionsBindTheAnswer,
  resolveProfileField,
} from './profileFieldResolution';
import {
  discoveredQuestionControlType,
  discoveredQuestionNeedsExactOptionsBeforeResolution,
} from './questionMetadata';
import type { ApplicationProfileLike } from './questionDiscovery';

/* A NUMBER IS TYPED. IT IS NOT PICKED OFF A MENU, AND IT IS NOT "NOT ON THE LIST".
 *
 * Measured live 2026-09-03 on Hudson River Trading packet 4a79eec1 (greenhouse, application
 * account mehekmandal05@gmail.com). The managed run parked with all 26 of its answers bound, on one
 * line:
 *
 *   gpa: no option matched "3.89" (the list offered: "No options")
 *
 * "3.89" is her stored GPA, on `gpa_scale` "4.0". "No options" is react-select's own empty-menu
 * message, read back as though it were the employer's list. The sentence is a category error twice
 * over: there was no list to be absent from, and a GPA is a number that only ever needed typing.
 *
 * THE SAME ERROR ARRIVES FROM THE OTHER SIDE ON PINPOINT, which attaches `["Yes","No"]` to its
 * `number` fields. There a numeric answer - years of Python, a salary - genuinely IS ranked against
 * a two-row menu it can never be a member of.
 *
 * ONE FAULT, TWO FACES, which is why one file pins both: the control's own input type and its
 * option list were each allowed to declare "this is a menu" on their own, and neither was ever
 * checked against the other.
 *
 * THE SAFETY INVARIANT THAT MUST SURVIVE ALL OF IT: when an option list is genuinely empty, a
 * stored answer is returned exactly as stored and never judged against the empty list. 160 required
 * choice questions on this account carry an empty list. reviewedComboboxOptionKept.test.ts owns
 * that invariant on the refresh path; the last two tests here own it on the resolution path.
 */

const STORED_PROFILE: ApplicationProfileLike = {
  full_name: 'Mehek Mandal',
  school: 'University of Southern California, Viterbi School of Engineering',
  degree: 'Bachelor of Science in Computer Science',
  major: 'Computer Science',
  gpa: '3.89',
  gpa_scale: '4.0',
  grad_date: 'May 2028',
  grad_year: 2028,
  currently_enrolled: true,
  work_authorized: true,
  needs_sponsorship: true,
};

/** The discovered-field shape questionMetadata judges, with only the fields these rules read. */
function discovered(inputType: string, role: string | null, options: string[] | null) {
  return {
    label: 'What is your overall college/university GPA?',
    selector: '#gpa',
    durableSelector: '#gpa',
    inputType,
    role,
    options,
    required: true,
  };
}

test('a menu-shaped control with no options is not a closed choice, so the GPA is typed as stored', () => {
  /* THE HRT SHAPE. A control carrying combobox evidence whose menu, when opened, offered nothing.
   * The answer must come back as the stored number, verbatim, and must NOT claim to have been
   * chosen from a list - `matchedOption: false` is what the fill layer reads as "type this". */
  const resolved = resolveProfileField(
    { label: 'What is your overall college/university GPA?', inputType: 'combobox', options: [] },
    STORED_PROFILE,
  );
  assert.equal(resolved?.value, '3.89', 'her stored GPA, exactly as stored');
  assert.equal(resolved?.matchedOption, false, 'nothing was offered, so nothing was chosen');

  // The same, with react-select's empty-menu placeholder actually present as a row. usableOptions
  // already strips "Select...", and the runner now strips "No options" before it can be quoted
  // back as an offer; neither may turn an empty menu into a list this answer is judged against.
  const withPlaceholder = resolveProfileField(
    { label: 'What is your overall college/university GPA?', inputType: 'combobox', options: ['Select...'] },
    STORED_PROFILE,
  );
  assert.equal(withPlaceholder?.value, '3.89');
  assert.equal(withPlaceholder?.matchedOption, false);
});

test('a real GPA band list still binds the answer, because that list is a menu', () => {
  /* The converse, and the reason the fix is a predicate rather than "stop matching GPAs". When the
   * employer really does offer bands - the thirteen HRT offers, of which 3.76-4.0 is hers - the
   * answer is still snapped onto the employer's own row. Losing this would be a worse bug than the
   * one being fixed. */
  const resolved = resolveProfileField(
    {
      label: 'What is your overall college/university GPA?',
      inputType: 'combobox',
      options: ['< 3.0', '3.01 - 3.25', '3.26 - 3.50', '3.51 - 3.75', '3.76 - 4.0'],
    },
    STORED_PROFILE,
  );
  assert.equal(resolved?.value, '3.76 - 4.0');
  assert.equal(resolved?.matchedOption, true);
});

test('Pinpoint: a Yes/No list hung on a number field can never capture the number', () => {
  /* THE OTHER FACE. Pinpoint attaches ["Yes","No"] to `number` controls, so before this the
   * resolver was asked to rank a numeric answer against a two-row menu. Whatever it answered was
   * wrong: a GPA is not "Yes". The list is evidence about some other control and is discarded. */
  const resolved = resolveProfileField(
    { label: 'What is your GPA?', inputType: 'number', options: ['Yes', 'No'] },
    STORED_PROFILE,
  );
  assert.equal(resolved?.value, '3.89', 'the stored number, not a menu row');
  assert.equal(resolved?.matchedOption, false, 'a number field has no menu to have matched');
  assert.equal(
    ['Yes', 'No'].includes(resolved?.value ?? ''),
    false,
    'a numeric answer must never come back as a Yes/No row',
  );
});

test('Pinpoint: a foreign list on a number field no longer mints a false option provenance', () => {
  /* THE MEASURABLE HALF OF THE PINPOINT DIRECTION, and the reason it is worth fixing at the
   * resolver as well as at the mint.
   *
   * `matchedOption: true` is a claim with teeth: routes/submissionRunner.ts calls it "THE TRUST
   * ANCHOR ... the value really did come off the control's own list", writes optionSnapClaim from
   * it, and the acknowledged-answer gate then trusts that provenance without re-verifying list
   * membership. On a `number` control carrying a Yes/No pair that never belonged to it, the claim
   * is simply false.
   *
   * Measured against pristine origin/main with this exact input: `matchedOption` came back TRUE,
   * so a control that can only hold a typed number was recorded as having offered "Yes" and been
   * picked from. The value is unchanged either way; what changes is that Litos no longer vouches
   * for a list it should never have been reading. */
  const resolved = resolveProfileField(
    { label: 'Are you currently enrolled?', inputType: 'number', options: ['Yes', 'No'] },
    STORED_PROFILE,
  );
  assert.equal(
    resolved?.matchedOption,
    false,
    'a number control cannot have offered a Yes/No row, so nothing may be vouched for',
  );

  // The same question on a control that really IS a Yes/No chooser keeps its provenance.
  const realChooser = resolveProfileField(
    { label: 'Are you currently enrolled?', inputType: 'radio', options: ['Yes', 'No'] },
    STORED_PROFILE,
  );
  assert.equal(realChooser?.value, 'Yes');
  assert.equal(realChooser?.matchedOption, true);
});

test('the free-entry set is positive DOM evidence only, and never claims `text`', () => {
  /* WHY `text` IS ABSENT, and it is the single most load-bearing exclusion here. Managed discovery
   * reports inputType `text` for every control it walks, react-selects included, so profileField
   * Resolution.ts's own header warns that nothing may depend on inputType being accurate. Nothing
   * does: every type on this list is one the DOM states outright AND one a searchable combobox
   * never renders - react-select's search box is always <input type="text">. */
  for (const type of ['number', 'tel', 'email', 'url', 'date', 'range', 'search', 'password']) {
    assert.ok(FREE_ENTRY_INPUT_TYPE.test(type), `${type} can only ever be typed`);
  }
  for (const type of ['text', 'textarea', 'select', 'select-one', 'radio', 'checkbox', 'combobox', 'listbox']) {
    assert.ok(!FREE_ENTRY_INPUT_TYPE.test(type), `${type} must stay outside the free-entry set`);
  }
});

test('optionsBindTheAnswer needs BOTH a real list and a control that can hold one', () => {
  const bands = ['3.51 - 3.75', '3.76 - 4.0'];
  // Both facts present.
  assert.equal(optionsBindTheAnswer('combobox', bands), true);
  assert.equal(optionsBindTheAnswer('select', bands), true);
  // A list, on a control that cannot hold one. The Pinpoint direction.
  assert.equal(optionsBindTheAnswer('number', ['Yes', 'No']), false);
  assert.equal(optionsBindTheAnswer('date', ['Yes', 'No']), false);
  // A control that can hold one, with no list. The HRT direction.
  assert.equal(optionsBindTheAnswer('combobox', []), false);
  assert.equal(optionsBindTheAnswer('select', null), false);
  assert.equal(optionsBindTheAnswer('radio', undefined), false);
  // A list of nothing but the placeholder is not a list.
  assert.equal(optionsBindTheAnswer('select', ['Select...']), false);
});

test('a bare role no longer overrules a control type that cannot be a menu', () => {
  /* discoveredQuestionControlType mints portal_input_type, which is the one value every downstream
   * typed-versus-picked decision reads. Its two rules could each mint a menu from half the
   * evidence, and neither checked the other half. */
  assert.equal(
    discoveredQuestionControlType(discovered('number', 'combobox', null)),
    'number',
    'a number box with a stray combobox role is still a number box',
  );
  assert.equal(
    discoveredQuestionControlType(discovered('number', null, ['Yes', 'No'])),
    'number',
    'and options attached to it do not promote it either',
  );
  // Everything that was a menu before still is. A real searchable Greenhouse react-select reports
  // `text` plus a role, and a text input whose probe read a usable list is still a combobox.
  assert.equal(discoveredQuestionControlType(discovered('text', 'combobox', null)), 'combobox');
  assert.equal(discoveredQuestionControlType(discovered('text', 'listbox', null)), 'listbox');
  assert.equal(discoveredQuestionControlType(discovered('text', null, ['Woman', 'Man'])), 'combobox');
  assert.equal(discoveredQuestionControlType(discovered('select', null, ['Woman', 'Man'])), 'select');
  assert.equal(discoveredQuestionControlType(discovered('text', null, null)), 'text');
});

test('a free-entry control never waits for an option inventory that is not coming', () => {
  // The same rule at the one other place a bare role could speak for a control over its own type.
  // Holding a numeric control's resolution until its list arrives waits forever.
  assert.equal(
    discoveredQuestionNeedsExactOptionsBeforeResolution({ inputType: 'number', role: 'listbox' }),
    false,
  );
  // And the controls that genuinely cannot be resolved blind still are held.
  assert.equal(discoveredQuestionNeedsExactOptionsBeforeResolution({ inputType: 'select', role: null }), true);
  assert.equal(discoveredQuestionNeedsExactOptionsBeforeResolution({ inputType: 'radio', role: null }), true);
  assert.equal(discoveredQuestionNeedsExactOptionsBeforeResolution({ inputType: 'text', role: 'listbox' }), true);
  // A searchable combobox is still deliberately excluded, as it was before.
  assert.equal(discoveredQuestionNeedsExactOptionsBeforeResolution({ inputType: 'text', role: 'combobox' }), false);
});

test('THE SAFETY INVARIANT: an empty option list is never judged against, on any control', () => {
  /* The 160-question class, on the resolution path. An empty list means there is nothing to test
   * membership against, so the answer is whatever the profile says and `matchedOption` is false -
   * which is what the fill layer reads as "left for you" rather than "Litos chose this". This must
   * hold for the menu shapes as much as for the free-entry ones, and the fix must not have started
   * judging any of them. */
  for (const inputType of ['select', 'radio', 'listbox', 'combobox', 'text', 'number']) {
    for (const options of [[], null, undefined, ['Select...']] as const) {
      const resolved = resolveProfileField(
        { label: 'What is your GPA?', inputType, options },
        STORED_PROFILE,
      );
      assert.equal(resolved?.value, '3.89', `${inputType} with no usable options returns the stored GPA`);
      assert.equal(resolved?.matchedOption, false, `${inputType} claims no option was chosen`);
    }
  }
});

test('a genuinely closed control with a real list is still snapped onto the employer wording', () => {
  // The whole point of the resolver, unchanged. Her stored degree is a full sentence and the
  // employer offers three words; the answer must still be the employer's row.
  const resolved = resolveProfileField(
    { label: 'Degree', inputType: 'select', options: ['High School', "Bachelor's Degree", "Master's Degree"] },
    STORED_PROFILE,
  );
  assert.equal(resolved?.value, "Bachelor's Degree");
  assert.equal(resolved?.matchedOption, true);
});
