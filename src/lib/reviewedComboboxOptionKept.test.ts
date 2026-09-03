import assert from 'node:assert/strict';
import test from 'node:test';

import {
  refreshKnownQuestionAnswers,
  REVIEWED_PICK_EXACT_OPTION_TYPE,
  SINGLE_CHOICE_EXACT_OPTION_TYPE,
} from './questionDiscovery';
import { chooseEeoOption } from './profileFieldResolution';

/* THE COMBOBOX SHE PICKED FROM, AND THE REFRESH THAT PUT HER PROFILE VALUE BACK.
 *
 * Measured live on 2026-09-03, Hudson River Trading packet 4a79eec1 (greenhouse): profile gender
 * "Female", control offering Woman / Man / Non-binary / I don't wish to answer. Picking Woman in
 * the dashboard stored it, the next refresh replaced it with "Female", the question rendered
 * ANSWERED with nothing selected, and it was asked again - a loop with no exit.
 *
 * The resolver was never the problem: chooseEeoOption returns "Woman" for that pair, asserted
 * below so this file fails if that ever regresses. The gate was, and only for combobox.
 *
 * The zero-option case is half this file. 160 required choice questions on this account carry an
 * EMPTY option list, and nothing here may start judging those: no options means no membership
 * test, so the answer must be returned exactly as stored.
 */

const REVIEWED_AT = '2026-09-03T11:00:00.000Z';
const AS_OF = new Date('2026-09-03T12:00:00.000Z');

const PROFILE = {
  eeo_prefs: {
    race: 'South Asian',
    gender: 'Female',
    veteran_status: 'No',
    disability_status: 'No',
    sexual_orientation: 'Heterosexual',
    transgender_status: 'No',
  },
  citizenship: 'India',
  work_authorized: true,
  needs_sponsorship: true,
  gpa: '3.89',
  gpa_scale: '4.0',
  major: 'Computer Science',
  legal_first_name: 'Mehek',
  preferred_first_name: 'Mehek',
} as unknown as Parameters<typeof refreshKnownQuestionAnswers>[1];

const GENDER_OPTIONS = ['Woman', 'Man', 'Non-binary', "I don't wish to answer"];
const VETERAN_OPTIONS = [
  "I don't wish to answer",
  'I identify as one or more of the classifications of a protected veteran',
  'I am not a protected veteran',
];

/** The stored shape the dashboard writes when she reviews and picks an option herself. */
function reviewedPick(question: string, answer: string, portalInputType: string, options: string[]) {
  return {
    question,
    answer,
    portal_input_type: portalInputType,
    options,
    answer_source: 'applicant_review',
    answer_reviewed_at: REVIEWED_AT,
  };
}

function refreshedAnswer(input: ReturnType<typeof reviewedPick>): string {
  const [out] = refreshKnownQuestionAnswers([input], PROFILE, undefined, REVIEWED_AT, undefined, undefined, AS_OF);
  return out!.answer;
}

test('the resolver already binds a stored Female onto a Woman option', () => {
  assert.equal(chooseEeoOption('what is your gender?', 'Female', GENDER_OPTIONS), 'Woman');
});

test('the keep gate admits combobox and the re-open gate still does not', () => {
  /* THE ASYMMETRY IS THE POINT. Keeping an answer that IS among the captured options is safe on a
   * searchable control, because the answer is verifiably fillable whether or not the menu was
   * read in full. Re-opening one that is NOT among them is unsafe for exactly that reason, and
   * questionMetadata.test.ts pins it: "a searchable combobox can land an answer its first-read
   * menu never enumerated". So the two gates must differ on combobox and agree on everything
   * else. */
  for (const controlType of ['radio', 'select', 'select-one', 'listbox']) {
    assert.ok(REVIEWED_PICK_EXACT_OPTION_TYPE.test(controlType), `${controlType} keeps a reviewed pick`);
    assert.ok(SINGLE_CHOICE_EXACT_OPTION_TYPE.test(controlType), `${controlType} re-opens an unfit answer`);
  }
  assert.ok(REVIEWED_PICK_EXACT_OPTION_TYPE.test('combobox'), 'a reviewed combobox pick is kept');
  assert.ok(
    !SINGLE_CHOICE_EXACT_OPTION_TYPE.test('combobox'),
    'but an unfit combobox answer is never blanked, because its menu may be partial',
  );
  // Neither carries exactly one value, so neither can be judged against one stored answer.
  for (const controlType of ['checkbox', 'select-multiple', 'text', 'textarea']) {
    assert.ok(!REVIEWED_PICK_EXACT_OPTION_TYPE.test(controlType), `${controlType} stays out of the keep gate`);
    assert.ok(!SINGLE_CHOICE_EXACT_OPTION_TYPE.test(controlType), `${controlType} stays out of the re-open gate`);
  }
});

test('a reviewed combobox pick survives the refresh, on every control type that offers it', () => {
  // The regression: on `combobox` this returned "Female" before 2026-09-03.
  for (const controlType of ['combobox', 'radio', 'select', 'listbox']) {
    assert.equal(
      refreshedAnswer(reviewedPick('what is your gender?', 'Woman', controlType, GENDER_OPTIONS)),
      'Woman',
      `a reviewed "Woman" must survive on ${controlType}`,
    );
  }
});

test('the self-identification sentence forms survive too, not just the one-word answers', () => {
  assert.equal(
    refreshedAnswer(reviewedPick('veteran status', 'I am not a protected veteran', 'combobox', VETERAN_OPTIONS)),
    'I am not a protected veteran',
  );
});

test('a combobox whose menu was never read is returned exactly as stored', () => {
  /* The 160-question class. An empty option list means there is nothing to test membership
   * against, so widening the gate must not touch these - not to keep them, and not to re-open
   * them. Asserted on both a value the profile could recompute and one it could not. */
  assert.equal(
    refreshedAnswer(reviewedPick('have you applied to this role at akuna previously?', 'Yes', 'combobox', [])),
    'Yes',
  );
  assert.equal(
    refreshedAnswer(reviewedPick('what is your gender?', 'Woman', 'combobox', [])),
    'Female',
    'with no options captured the refresh still recomputes, exactly as it did before',
  );
});
