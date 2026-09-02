/* THE EEOC LISTS GREENHOUSE PUBLISHES AND THIS REPO WALKED PAST.
 *
 * Hudson River Trading packet 4a79eec1, measured in prod 2026-09-02, filed four
 * missing_exact_options blockers on "what is your gender?", "are you a veteran?", "do you have a
 * disability?" and "what is your race/ethnicity?" - all required, all react-select comboboxes whose
 * ids on job-boards.greenhouse.io are bare numbers (245/248/249/250) with no options in the DOM.
 * The board API publishes every one of those lists, in `compliance`, a sibling of `questions` that
 * parseGreenhousePublicApplicationSchema never read.
 *
 * The fixture below is the exact shape of a live response, recorded 2026-09-02 from
 * boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>?questions=true: four `compliance` blocks of
 * type "eeoc", each holding `questions[].fields[]` of type multi_value_single_select with
 * `values[]` of {label, value}, keyed by the employer's own field names.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGreenhousePublicApplicationSchema } from './greenhousePublicApplication';
import { eeoSubjectPreferenceKeys } from './questionDiscovery';

const select = (name: string, labels: string[]) => ({
  name,
  type: 'multi_value_single_select',
  values: labels.map((label, index) => ({ label, value: String(index + 1) })),
});

const SCHEMA = {
  questions: [
    { label: 'First Name', required: true, fields: [{ name: 'first_name', type: 'input_text' }] },
    { label: 'Last Name', required: true, fields: [{ name: 'last_name', type: 'input_text' }] },
    { label: 'Email', required: true, fields: [{ name: 'email', type: 'input_text' }] },
    { label: 'Resume', required: true, fields: [{ name: 'resume', type: 'input_file' }] },
    {
      label: 'Are you legally authorized to work in the United States?',
      required: true,
      fields: [select('question_4577001007', ['Yes', 'No'])],
    },
  ],
  compliance: [
    { type: 'eeoc', description: 'a preamble with no questions at all', questions: [] },
    {
      type: 'eeoc',
      questions: [{
        label: 'DisabilityStatus',
        required: false,
        fields: [select('disability_status', [
          'I do not want to answer',
          'No, I do not have a disability and have not had one in the past',
          'Yes, I have a disability, or have had one in the past',
        ])],
      }],
    },
    {
      type: 'eeoc',
      questions: [{
        label: 'VeteranStatus',
        required: false,
        fields: [select('veteran_status', [
          "I don't wish to answer",
          'I identify as one or more of the classifications of a protected veteran',
          'I am not a protected veteran',
        ])],
      }],
    },
    {
      type: 'eeoc',
      questions: [
        { label: 'Race', required: false, fields: [select('race', ['Decline To Self Identify', 'Two or More Races', 'Asian'])] },
        { label: 'Gender', required: false, fields: [select('gender', ['Decline To Self Identify', 'Female', 'Male'])] },
      ],
    },
  ],
};

test('the four EEOC lists are read off the compliance block, keyed by the employer field name', () => {
  const parsed = parseGreenhousePublicApplicationSchema(SCHEMA);
  assert.ok(parsed);
  assert.deepEqual(Object.keys(parsed!.complianceOptionsByField).sort(), [
    'disability_status', 'gender', 'race', 'veteran_status',
  ]);
  assert.deepEqual(parsed!.complianceOptionsByField.gender, ['Decline To Self Identify', 'Female', 'Male']);
  assert.equal(parsed!.complianceOptionsByField.race.length, 3);
  // They join by control id too, for the boards.greenhouse.io variant that names its controls.
  assert.deepEqual(parsed!.fieldOptions.veteran_status, parsed!.complianceOptionsByField.veteran_status);
  // The ordinary questions reading is untouched.
  assert.deepEqual(parsed!.fieldOptions.question_4577001007, ['Yes', 'No']);
  assert.deepEqual(
    parsed!.optionsByLabel['are you legally authorized to work in the united states?'],
    ['Yes', 'No'],
  );
});

test('the compliance labels are machine tokens, so only the SUBJECT can join them to the form', () => {
  const parsed = parseGreenhousePublicApplicationSchema(SCHEMA)!;
  // What the DOM asks on job-boards.greenhouse.io, verbatim from the four prod blockers.
  const asked = [
    ['what is your gender?', 'gender'],
    ['are you a veteran?', 'veteran_status'],
    ['do you have a disability?', 'disability_status'],
    ['what is your race/ethnicity?', 'race'],
  ] as const;
  for (const [label, field] of asked) {
    // The label join cannot reach them: "DisabilityStatus" is not a question anyone asks.
    assert.equal(parsed.optionsByLabel[label], undefined);
    const subject = eeoSubjectPreferenceKeys(label).find((key) => parsed.complianceOptionsByField[key]?.length);
    assert.equal(subject, field, `${label} reads as ${field}`);
    assert.ok(parsed.complianceOptionsByField[subject!].length >= 3);
  }
});

test('a response with no compliance block parses exactly as it always did', () => {
  const { compliance: _compliance, ...withoutCompliance } = SCHEMA;
  const parsed = parseGreenhousePublicApplicationSchema(withoutCompliance);
  assert.ok(parsed);
  assert.deepEqual(parsed!.complianceOptionsByField, {});
  assert.deepEqual(parsed!.fieldOptions.question_4577001007, ['Yes', 'No']);
  // Still refused when the response is not a complete application schema.
  assert.equal(parseGreenhousePublicApplicationSchema({ compliance: SCHEMA.compliance }), null);
});

test('a compliance field never overwrites a name the questions block already published', () => {
  const shadowed = {
    ...SCHEMA,
    questions: [...SCHEMA.questions, { label: 'Gender', required: false, fields: [select('gender', ['Only this one'])] }],
  };
  const parsed = parseGreenhousePublicApplicationSchema(shadowed)!;
  assert.deepEqual(parsed.fieldOptions.gender, ['Only this one'], 'the questions reading wins');
  assert.deepEqual(parsed.complianceOptionsByField.gender, ['Decline To Self Identify', 'Female', 'Male']);
});

test('the subject vocabulary is one ladder, and it still reads what it always read', () => {
  assert.deepEqual(eeoSubjectPreferenceKeys('Do you identify as transgender?'), ['transgender_status', 'transgender']);
  assert.deepEqual(eeoSubjectPreferenceKeys('Are you Hispanic or Latino?'), ['hispanic_ethnicity', 'hispanic', 'ethnicity']);
  assert.deepEqual(eeoSubjectPreferenceKeys('What is your sexual orientation?'), ['sexual_orientation']);
  assert.deepEqual(eeoSubjectPreferenceKeys('Which of these states do you currently live in?'), []);
});
