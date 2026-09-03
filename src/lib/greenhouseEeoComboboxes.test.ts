/* THE PLUMBING AROUND THE DEMOGRAPHIC JOIN, ON THE EXISTING EXPORTS IT HAS TO PASS THROUGH.
 *
 * greenhouseDemographicQuestions.test.ts pins the join itself. This file pins what the rest of the
 * repo does with a numeric-id control and with the high-school text box that shared the same run
 * (Hudson River Trading 4a79eec1, 2026-09-02):
 *
 *   - `[id="248"]` is a control id, so the fallback option probe can target it, the blocker names
 *     it, and the fill can look its options up (portalSubmission.ts).
 *   - the probe planner still reads HRT's high-school TEXT box as an education react-select from
 *     its label, which is exactly why the runner now asks the board's published type first.
 *   - "write in your high school" is a refusal, not a drafter prompt and not the university.
 *   - discoverAndResolveQuestions stores the four joined controls with their selectors, answers
 *     veteran and disability from her stored preferences, and files no blocker.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  buildManagedDiscoveredOptionProbeActions,
  managedOptionProbeControlId,
  managedOptionProbeExpectsClosedControl,
  managedOptionProbeTargets,
} from './portalSubmission';
import { questionMetadataBlockersForOptionProbeFailures } from './questionMetadata';
import { resolveKnownAnswer } from './questionDiscovery';
import { discoverAndResolveQuestions, type ResumeRow } from '../routes/submissionRunner';
import type { ApplicationReviewState } from './applicationReview';

const HIGH_SCHOOL_LABEL = 'Please represent both completed and in-progress university degrees above. Please also write in your high school/secondary school below.';

const numericCombobox = (label: string, id: string, options: string[] | null = null) => ({
  label,
  selector: '[data-litos-discovered-3]',
  durableSelector: `[id="${id}"]`,
  inputType: 'text',
  role: 'combobox',
  maxLength: null,
  options,
  ...(options ? { optionsComplete: true } : {}),
  required: true,
});

test('an attribute selector on a numeric id is a control id, so the probe, the blocker and the fill can name it', () => {
  assert.equal(managedOptionProbeControlId({ label: 'are you a veteran?', durableSelector: '[id="248"]' }), '248');
  assert.equal(managedOptionProbeControlId({ label: 'are you a veteran?', selector: 'input[id="248"]' }), '248');
  // The hash form is still not a selector, and a three-digit trailing number is still not a handle.
  assert.equal(managedOptionProbeControlId({ label: 'are you a veteran? 248', selector: '[data-litos-discovered-3]', durableSelector: null }), undefined);
  assert.equal(managedOptionProbeControlId({ label: 'x', durableSelector: '#248' }), undefined);

  const field = numericCombobox('are you a veteran? 248', '248');
  assert.deepEqual(managedOptionProbeTargets('greenhouse', [field], {}, true), ['248']);
  const actions = buildManagedDiscoveredOptionProbeActions('greenhouse', [field], {}, true);
  assert.ok(actions.some((action) => action.selector === '[id="248"]:is([role="combobox"],[aria-haspopup="listbox"])'), 'identity read on the numeric id');
  assert.ok(actions.some((action) => action.selector === '[id="react-select-248-listbox"]'), 'the listbox read for the fallback path');

  // And when that fallback read fails, the control stays a blocker that now NAMES its control.
  const blockers = questionMetadataBlockersForOptionProbeFailures('greenhouse', [field], [{ controlId: '248' }]);
  assert.deepEqual(blockers, [{
    kind: 'missing_exact_options',
    question: 'are you a veteran?',
    required: true,
    portal_input_type: 'combobox',
    control_id: '248',
    portal_selector: '[id="248"]',
  }]);
});

test('the label heuristic still calls the high-school text box a closed list, which is why the schema type must override it', () => {
  const highSchool = {
    label: `${HIGH_SCHOOL_LABEL.toLowerCase()} * question_68000291`,
    selector: '#question_68000291',
    durableSelector: '#question_68000291',
    inputType: 'text',
    role: null,
    required: true,
  };
  assert.equal(managedOptionProbeExpectsClosedControl(highSchool, 'greenhouse'), true);
  assert.equal(managedOptionProbeControlId(highSchool), 'question_68000291');
});

test('an instruction to write in her high school is left for her, never drafted and never the university', () => {
  const profile = {
    school: 'University of Southern California',
    degree: "Bachelor's",
    major: 'Computer Science',
    high_school_grad_date: 'May 2023',
  };
  const held = resolveKnownAnswer(HIGH_SCHOOL_LABEL, 'text', profile, undefined);
  assert.ok(held && 'skipReason' in held, 'a refusal, not null (null falls through to the drafter)');
  assert.match(held.skipReason, /^high school question left for you/);
  for (const variant of [
    'Please enter your secondary school.',
    'Please list your high school.',
  ]) {
    const answer = resolveKnownAnswer(variant, 'text', profile, undefined);
    assert.ok(answer && 'skipReason' in answer && /^high school question left for you/.test(answer.skipReason), variant);
  }
  // The graduation rule keeps its own labels: a write-in of the DATE is answered from the date.
  assert.deepEqual(resolveKnownAnswer('Please write in your high school graduation year', 'text', profile, undefined), { value: 'May 2023' });
  // A negated instruction is the university's control and is not refused by this rule.
  const university = resolveKnownAnswer('Do not write your high school here. Which university are you attending?', 'text', profile, undefined);
  assert.ok(!(university && 'skipReason' in university && /^high school question left for you/.test(university.skipReason)));
  // Palantir's conditional write-in is addressed to a school leaver, not to her: still the university.
  assert.deepEqual(
    resolveKnownAnswer('School name (if you did not attend college, enter your high school)', 'textarea', profile, undefined),
    { value: 'University of Southern California' },
  );
});

test('the four joined controls are stored with their selectors and answered from her stored preferences, with no blocker', async () => {
  const current: ApplicationReviewState = {
    jd_text: 'Build C++ services.',
    role: 'Software Engineering Internship (C++ or Python)',
    portal_url: 'https://job-boards.greenhouse.io/embed/job_app?for=wehrtyou&token=8052083',
    ats_name: 'greenhouse',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };
  const result = await discoverAndResolveQuestions(
    [
      numericCombobox('what is your gender? 245', '245', ['Woman', 'Man', 'Non-binary', "I don't wish to answer"]),
      numericCombobox('are you a veteran? 248', '248', ['Yes', 'No', "I don't wish to answer"]),
      numericCombobox('do you have a disability? 249', '249', ['Yes', 'No', "I don't wish to answer"]),
      numericCombobox('what is your race/ethnicity? 250', '250', ['East Asian', 'South Asian', 'White', "I don't wish to answer"]),
      {
        label: `${HIGH_SCHOOL_LABEL} * question_68000291`,
        selector: '#question_68000291',
        durableSelector: '#question_68000291',
        inputType: 'text',
        role: null,
        maxLength: null,
        required: true,
      },
    ],
    { user_id: 'user-1' } as ResumeRow,
    current,
    {
      school: 'University of Southern California',
      high_school_grad_date: 'May 2023',
      eeo_prefs: { disability_status: 'No', veteran_status: 'No' },
    },
    true,
    'greenhouse',
  );
  assert.deepEqual(result.questionMetadataBlockers, []);
  const byQuestion = new Map(result.questions.map((question) => [question.question, question]));
  assert.deepEqual(
    ['are you a veteran?', 'do you have a disability?'].map((label) => [byQuestion.get(label)?.answer, byQuestion.get(label)?.portal_selector]),
    [['No', '[id="248"]'], ['No', '[id="249"]']],
  );
  for (const label of ['what is your gender?', 'what is your race/ethnicity?']) {
    const stored = byQuestion.get(label);
    assert.ok(stored, label);
    assert.equal(stored.portal_input_type, 'combobox');
    assert.ok(stored.options && stored.options.length >= 4, 'the choices travel with the row so she can change them');
    assert.ok(stored.options.includes(stored.answer), 'whatever is stored is one of the employer\'s own rows');
  }
  const highSchool = result.questions.find((question) => /write in your high school/i.test(question.question));
  assert.ok(highSchool, 'the text box reaches her as a question instead of a probe failure');
  assert.equal(highSchool.answer, '');
  assert.equal(highSchool.required, true);
  assert.equal(highSchool.portal_selector, '#question_68000291');
  assert.equal(highSchool.answer_state, 'litos_refused');
  assert.ok(result.attentionReasons.some((reason) => /^high school question left for you/.test(reason)));
});

test('the managed runner joins the demographic set inside the live-discovery map and keeps published text controls out of the probe', () => {
  const runner = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  assert.match(
    runner,
    /const normalizedDiscoveredFields = \(discoveryResult\?\.discovered \?\? \[\]\)\.map[\s\S]{0,1500}joinGreenhouseDemographicQuestion\(\s*field,\s*greenhouseSchema,\s*greenhouseDemographicCounts,\s*\)/,
    'the exact-label join runs on each field the live page discovered, before the compliance subject join',
  );
  assert.match(
    runner,
    /discoveredQuestionsForExactOptionProbe\(\s*publicSchemaDiscoveredFields,\s*\)\.filter\(\(field\) => !greenhouseSchemaPublishesAsOpenText\(greenhouseSchema, field\)\)/,
  );
});
