/* THE FOUR EEO COMBOBOXES THAT PARKED HUDSON RIVER TRADING, JOINED TO THE LISTS THE BOARD PUBLISHES.
 *
 * Measured in prod 2026-09-02 (packet 4a79eec1, run d712aa9f): the managed fill completed 41 fields
 * and parked on four `missing_exact_options` blockers - "What is your gender?", "Are you a
 * veteran?", "Do you have a disability?", "What is your race/ethnicity?" - each `combobox`,
 * `portal_selector: null`, required, with NO stored question row. The board API for that posting
 * (boards-api.greenhouse.io/v1/boards/wehrtyou/jobs/8052083?questions=true, read 2026-09-03) has
 * `compliance: null` and publishes the four lists under `demographic_questions.questions[]` with
 * ids 245/248/249/250 - the numeric DOM ids the react-selects carry and the discovery runner
 * declines as durable selectors.
 *
 * The fixture below is that response's exact shape, trimmed to the fields this module reads.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGreenhousePublicApplicationSchema } from './greenhousePublicApplication';
import {
  greenhouseDemographicLabelCounts,
  greenhouseSchemaPublishesAsOpenText,
  joinGreenhouseDemographicQuestion,
  joinGreenhouseDemographicQuestions,
} from './greenhouseDemographicQuestions';
import { questionMetadataBlockerForDiscovered } from './questionMetadata';

const answerOptions = (labels: string[]) => labels.map((label, index) => ({
  id: 1000 + index, label, free_form: false, decline_to_answer: /wish to answer/i.test(label),
}));

export const HRT_SCHEMA = {
  compliance: null,
  data_compliance: [{ type: 'gdpr', requires_consent: false }],
  demographic_questions: {
    header: 'Voluntary Self-Identification',
    description: '<p>HRT is committed to providing equal employment opportunities for all groups.</p>',
    questions: [
      { id: 245, label: 'What is your gender?', required: true, type: 'multi_value_multi_select', answer_options: answerOptions(['Woman', 'Man', 'Non-binary', "I don't wish to answer"]) },
      { id: 248, label: 'Are you a veteran?', required: true, type: 'multi_value_single_select', answer_options: answerOptions(['Yes', 'No', "I don't wish to answer"]) },
      { id: 249, label: 'Do you have a disability?', required: true, type: 'multi_value_single_select', answer_options: answerOptions(['Yes', 'No', "I don't wish to answer"]) },
      { id: 250, label: 'What is your race/ethnicity?', required: true, type: 'multi_value_multi_select', answer_options: answerOptions(['East Asian', 'South Asian', 'White', "I don't wish to answer"]) },
    ],
  },
  questions: [
    { label: 'First Name', required: true, fields: [{ name: 'first_name', type: 'input_text' }] },
    { label: 'Last Name', required: true, fields: [{ name: 'last_name', type: 'input_text' }] },
    { label: 'Email', required: true, fields: [{ name: 'email', type: 'input_text' }] },
    { label: 'Resume/CV', required: true, fields: [{ name: 'resume', type: 'input_file' }] },
    {
      label: 'What is your overall college/university GPA?',
      required: true,
      fields: [{ name: 'question_68000287', type: 'multi_value_single_select', values: [{ label: '3.9 - 4.0', value: 1 }, { label: '3.8 - 3.89', value: 2 }] }],
    },
    {
      label: 'Please represent both completed and in-progress university degrees above. Please also write in your high school/secondary school below.',
      required: true,
      fields: [{ name: 'question_68000291', type: 'input_text' }],
    },
    {
      label: 'Where did you attend high school/secondary school?',
      required: true,
      fields: [{ name: 'question_68000292', type: 'multi_value_single_select', values: [{ label: 'North America', value: 1 }, { label: 'Asia', value: 2 }] }],
    },
  ],
};

/* Exactly as the discovery runner reports a job-boards react-select: the question text with the
 * numeric id concatenated, the temporary marker as `selector`, NO durable selector, a text input
 * carrying role=combobox, and no options because the menu has not been opened. */
const discovered = (label: string, marker: number) => ({
  label,
  selector: `[data-litos-discovered-${marker}]`,
  durableSelector: null as string | null,
  inputType: 'text',
  role: 'combobox',
  maxLength: null,
  options: null as string[] | null,
  optionsComplete: false,
  required: true,
});

const FOUR = [
  discovered('what is your gender? 245', 31),
  discovered('are you a veteran? 248', 32),
  discovered('do you have a disability? 249', 33),
  discovered('what is your race/ethnicity? 250', 34),
];

test('the schema reader publishes the demographic question set keyed by its exact wording, with ids', () => {
  const parsed = parseGreenhousePublicApplicationSchema(HRT_SCHEMA);
  assert.ok(parsed, 'a complete schema with a null compliance block still parses');
  assert.deepEqual(parsed!.complianceOptionsByField, {}, 'compliance is null on this board');
  assert.deepEqual(
    Object.entries(parsed!.demographicQuestionsByLabel).map(([label, q]) => [label, q.id, q.options.length, q.required]),
    [
      ['what is your gender?', '245', 4, true],
      ['are you a veteran?', '248', 3, true],
      ['do you have a disability?', '249', 3, true],
      ['what is your race/ethnicity?', '250', 4, true],
    ],
  );
  assert.deepEqual(parsed!.demographicQuestionsByLabel['are you a veteran?']!.options, ['Yes', 'No', "I don't wish to answer"]);
  // The employer's own open-text controls, so the option probe stops mistaking them for lists.
  assert.deepEqual(parsed!.openTextFieldNames, ['first_name', 'last_name', 'email', 'question_68000291']);
});

test('the raw discovered field is the measured blocker shape, and the joined one is not a blocker at all', () => {
  const schema = parseGreenhousePublicApplicationSchema(HRT_SCHEMA)!;
  for (const field of FOUR) {
    const before = questionMetadataBlockerForDiscovered(field, { closedControlRequiresOptions: true });
    assert.equal(before?.kind, 'missing_exact_options', field.label);
    assert.equal(before?.portal_input_type, 'combobox');
    assert.equal(before?.portal_selector, undefined, 'the runner reported no durable selector');
    assert.equal(before?.control_id, undefined, 'a three-digit id is not a label handle');
  }
  const joined = joinGreenhouseDemographicQuestions(FOUR, schema);
  assert.deepEqual(
    joined.map((field) => [field.durableSelector, field.optionsComplete, field.options?.length]),
    [['[id="245"]', true, 4], ['[id="248"]', true, 3], ['[id="249"]', true, 3], ['[id="250"]', true, 4]],
  );
  for (const field of joined) {
    assert.equal(questionMetadataBlockerForDiscovered(field, { closedControlRequiresOptions: true }), null, field.label);
  }
  // The join is a copy; the runner's own report is never mutated.
  assert.equal(FOUR[1]!.durableSelector, null);
  assert.equal(FOUR[1]!.options, null);
});

test('the numeric selector is minted only when the runner-reported id equals the published id', () => {
  const schema = parseGreenhousePublicApplicationSchema(HRT_SCHEMA)!;
  // Same wording, different trailing number: the list still attaches (it joins by label), but
  // no selector is invented for a DOM id the board did not publish for this question.
  const drifted = joinGreenhouseDemographicQuestions([discovered('are you a veteran? 999', 1)], schema)[0]!;
  assert.deepEqual(drifted.options, ['Yes', 'No', "I don't wish to answer"]);
  assert.equal(drifted.optionsComplete, true);
  assert.equal(drifted.durableSelector, null);
  // No trailing handle at all: same outcome.
  const bare = joinGreenhouseDemographicQuestions([discovered('are you a veteran?', 1)], schema)[0]!;
  assert.equal(bare.durableSelector, null);
  assert.equal(bare.optionsComplete, true);
  // A durable selector the runner DID report is kept in preference to a minted one.
  const reported = joinGreenhouseDemographicQuestions(
    [{ ...discovered('are you a veteran? 248', 1), durableSelector: '[id="248"]' }],
    schema,
  )[0]!;
  assert.equal(reported.durableSelector, '[id="248"]');
});

test('fail-closed: an unpublished label, a duplicated label, or no schema leaves the blocker exactly where it was', () => {
  const schema = parseGreenhousePublicApplicationSchema(HRT_SCHEMA)!;
  const unpublished = discovered('which of these communities do you identify with? 251', 5);
  assert.equal(joinGreenhouseDemographicQuestions([unpublished], schema)[0], unpublished);
  assert.equal(questionMetadataBlockerForDiscovered(unpublished, { closedControlRequiresOptions: true })?.kind, 'missing_exact_options');

  const twins = [discovered('are you a veteran? 248', 6), discovered('are you a veteran? 260', 7)];
  const counts = greenhouseDemographicLabelCounts(twins);
  assert.equal(counts.get('are you a veteran?'), 2);
  for (const twin of twins) {
    assert.equal(joinGreenhouseDemographicQuestion(twin, schema, counts), twin, 'a twin never takes a list that might be its sibling\'s');
  }

  assert.deepEqual(joinGreenhouseDemographicQuestions(FOUR, null), FOUR);
  const withoutDemographics = parseGreenhousePublicApplicationSchema({ ...HRT_SCHEMA, demographic_questions: null })!;
  assert.deepEqual(withoutDemographics.demographicQuestionsByLabel, {});
  assert.deepEqual(joinGreenhouseDemographicQuestions(FOUR, withoutDemographics), FOUR);
});

test('a list discovery already read completely off the live control is kept over the published one', () => {
  const schema = parseGreenhousePublicApplicationSchema(HRT_SCHEMA)!;
  const live = { ...discovered('are you a veteran? 248', 8), options: ['Yes', 'No'], optionsComplete: true };
  assert.equal(joinGreenhouseDemographicQuestions([live], schema)[0], live);
});

test('the board\'s own field type says which question_<id> controls are open text', () => {
  const schema = parseGreenhousePublicApplicationSchema(HRT_SCHEMA)!;
  const highSchool = {
    label: 'please represent both completed and in-progress university degrees above. please also write in your high school/secondary school below. * question_68000291',
    selector: '#question_68000291',
    durableSelector: '#question_68000291',
    inputType: 'text',
    role: null,
    required: true,
  };
  assert.equal(greenhouseSchemaPublishesAsOpenText(schema, highSchool), true);
  const region = { ...highSchool, label: 'where did you attend high school/secondary school? * question_68000292', selector: '#question_68000292', durableSelector: '#question_68000292' };
  assert.equal(greenhouseSchemaPublishesAsOpenText(schema, region), false, 'a published select is still probed');
  assert.equal(greenhouseSchemaPublishesAsOpenText(null, highSchool), false, 'no schema, no authority');
  assert.equal(greenhouseSchemaPublishesAsOpenText(schema, FOUR[0]!), false, 'a control with no id is not named by the list');
});
