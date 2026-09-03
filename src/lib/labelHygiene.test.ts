/* THE EMPLOYER'S QUESTION, WITHOUT THE FORM'S PLUMBING.
 *
 * Discovery names a control by concatenating everything that might be its label, and the last two
 * parts of that join are the control's own `name` and `id` attributes. On a control that carries a
 * real written label those handles are welded onto the end of a perfectly good question and nothing
 * removed them, so the applicant was asked "available from* (required) available_from
 * field-available_from". On a control whose only text is its placeholder there is no question at
 * all, and she was asked "enter a number number-" with no options and a disabled Save.
 *
 * Every string in this file was read out of production on 2026-09-02, from the five packets of
 * account a18f774b-a306-4804-93f3-cd6020c27fb3 on four boards: crelate (Blueprint Hires e3a22025,
 * Prediktive da59781b), personio (xolife 29c73b37), pinpoint (Confluence Technologies c9b0c807) and
 * teamtailor (TixTrack 6703778e). They are exact, including the doubled "??" and the trailing ".*".
 *
 * THE RULES ARE ALL ONE-DIRECTIONAL. Stripping a handle can only shorten a label, and it is
 * abandoned outright when it would leave nothing, so no question can be lost to it. Recognising a
 * non-question requires the WHOLE label to be the non-question, so there is never a question inside
 * one to swallow. The negative half of this file is the part that matters: real employer questions
 * that superficially look like plumbing and have to come through untouched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isOpaqueIdentifier, sanitizeProviderBlockers, tidyLabel } from './fieldLabel';
import { managedOptionProbeControlId } from './portalSubmission';
import { normalizeDiscoveredLabel, type DiscoveredQuestion } from './questionDiscovery';
import { questionLabelIsGenericAnswerControl } from './questionMetadata';
import { postingQuestionInventoryFromDiscovered } from './postingQuestions';

/* ---------------------------------------------------------------------------------------------
 * THE MEASURED STRINGS, one test per rule that carries them.
 */

test('a bracketed attribute path trailing a real label is stripped off it', () => {
  // pinpoint, Confluence Technologies. The `name` attribute alone, so this fails if the bracketed
  // shape is removed even though the snake_case shape survives.
  assert.equal(normalizeDiscoveredLabel('phone application_form[application][phone]'), 'phone');
  assert.equal(
    normalizeDiscoveredLabel('cover letter candidate[job_applications_attributes][0][cover_letter]'),
    'cover letter',
  );
});

test('a field-prefixed slug trailing a real label is stripped off it', () => {
  // personio, xolife. The `id` alone: `field-available_from` carries a hyphen, so the bare
  // snake_case shape cannot match it and only the explicit `field-` shape can.
  assert.equal(normalizeDiscoveredLabel('available from field-available_from'), 'available from');
  assert.equal(normalizeDiscoveredLabel('expected salary field-salary_expectations'), 'expected salary');
});

test('a bare snake_case slug trailing a real label is stripped off it', () => {
  assert.equal(normalizeDiscoveredLabel('expected salary salary_expectations'), 'expected salary');
  assert.equal(normalizeDiscoveredLabel('phone application_form_application_phone'), 'phone');
});

test('the type prefix a uuid strip leaves standing is stripped off a real label', () => {
  // crelate. INLINE_UUID_RE clears the uuid out of `short-<uuid>` and leaves the word "short-".
  assert.equal(normalizeDiscoveredLabel('maximum 400 characters short-'), 'maximum 400 characters');
  assert.equal(normalizeDiscoveredLabel('enter a number number-'), 'enter a number');
});

test('a hyphenated slug is stripped only when the label already spells it out', () => {
  /* pinpoint's optional summary, exact. `personal-summary` is the id and repeats the heading
   * verbatim, and refusing every hyphenated token also stranded the bracketed `name` behind it. */
  assert.equal(
    normalizeDiscoveredLabel('personal summary this section is optional. use it to tell us a little '
      + 'more about yourself. application_form[application][summary] personal-summary'),
    'personal summary this section is optional. use it to tell us a little more about yourself.',
  );
  // With no such evidence the word is the employer's and the walk stops on it.
  assert.equal(normalizeDiscoveredLabel('are you currently self-employed'), 'are you currently self-employed');
});

test('a label that is nothing but a dangling type prefix is not a question', () => {
  // crelate, Blueprint Hires: the stored question was the single token "yesno-", six characters.
  assert.equal(isOpaqueIdentifier('yesno-'), true);
  assert.equal(normalizeDiscoveredLabel('yesno-'), '');
});

test('the required marker and the control handles come off the same label together', () => {
  // personio, xolife, exactly as stored (62 and 73 characters). Both decorations plus both handles.
  assert.equal(
    normalizeDiscoveredLabel('available from* (required) available_from field-available_from'),
    'available from',
  );
  assert.equal(
    normalizeDiscoveredLabel('expected salary* (required) salary_expectations field-salary_expectations'),
    'expected salary',
  );
  // teamtailor, TixTrack, exactly as stored (131 characters). The bare word "Required" is a chip
  // here, and the employer's own asterisk in front of it is the evidence that says so.
  assert.equal(
    normalizeDiscoveredLabel('cover letter* required candidate[job_applications_attributes][0][cover_letter] '
      + 'candidate_job_applications_attributes_0_cover_letter'),
    'cover letter',
  );
});

test('the handle comes off before the repeat collapse, so a doubled label still halves', () => {
  /* personio stores the label twice with the id behind it. collapseRepeatedLabel halves on an EVEN
   * word count, so the handle made the count three and the doubled label survived into the stored
   * question. This is why the strip runs in normalizeDiscoveredLabel and not only inside tidyLabel.
   */
  assert.equal(normalizeDiscoveredLabel('phone phone field-phone'), 'phone');
  assert.equal(normalizeDiscoveredLabel('location location field-location'), 'location');
});

test('the same rules clean every sibling row in the same packets', () => {
  // Read out of the same five packets, all exact. None of these was on the blocked list; all of
  // them carried the same plumbing.
  const cleaned: ReadonlyArray<readonly [string, string]> = [
    [
      'preferred name application_form[application][preferred_name] application_form_application_preferred_name',
      'preferred name',
    ],
    [
      'what are your base salary expectations (excluding benefits)? please input an annual figure in '
        + 'local currency. application_form[application][answers_attributes][2][number_answer] '
        + 'application_form_application_answers_attributes_2_number_answer',
      'what are your base salary expectations (excluding benefits)? please input an annual figure in '
        + 'local currency.',
    ],
    [
      // Note the employer's doubled "??", which is theirs and stays.
      'how many years of hands on experience do you have with python?? '
        + 'application_form[application][answers_attributes][3][number_answer] '
        + 'application_form_application_answers_attributes_3_number_answer',
      'how many years of hands on experience do you have with python??',
    ],
    [
      'referred by: candidate[answers_attributes][0][text] candidate_answers_attributes_0_text',
      'referred by',
    ],
    [
      'what are your salary expectations for this position?* required '
        + 'candidate[answers_attributes][3][number] candidate_answers_attributes_3_number',
      'what are your salary expectations for this position?',
    ],
    [
      'city/state* required candidate[answers_attributes][5][text] candidate_answers_attributes_5_text',
      'city/state',
    ],
    [
      'do you have a valid eu work permit? custom_attribute_4230180 field-custom_attribute_4230180',
      'do you have a valid eu work permit?',
    ],
    [
      'language skills: english custom_attribute_4230717 field-custom_attribute_4230717',
      'language skills: english',
    ],
    [
      'years of experience years_of_experience field-years_of_experience',
      'years of experience',
    ],
    [
      'linkedin custom_attribute_243150 field-custom_attribute_243150',
      'linkedin',
    ],
    // A blocker-only row, where the same decoration rule improves the sentence the applicant reads.
    [
      'which of these states do you currently live in?* required',
      'which of these states do you currently live in?',
    ],
  ];
  for (const [raw, expected] of cleaned) {
    assert.equal(normalizeDiscoveredLabel(raw), expected, raw);
  }
});

test('a label whose whole text is the box\'s own mechanics is not a question', () => {
  assert.equal(questionLabelIsGenericAnswerControl('maximum 400 characters short-'), true);
  assert.equal(questionLabelIsGenericAnswerControl('Max. 500 characters'), true);
  assert.equal(questionLabelIsGenericAnswerControl('400 characters or less'), true);
  assert.equal(questionLabelIsGenericAnswerControl('0/400 characters'), true);
  assert.equal(questionLabelIsGenericAnswerControl('enter a number number-'), true);
  assert.equal(questionLabelIsGenericAnswerControl('Please enter a value'), true);
  // pinpoint captions its send area "4. Submit Application" and bound the caption to the consent
  // checkbox inside it, which is how a section heading became a required question.
  assert.equal(questionLabelIsGenericAnswerControl('4. submit application'), true);
  // A bare counter has no letters at all, so isOpaqueIdentifier already refuses it upstream.
  assert.equal(normalizeDiscoveredLabel('0 / 400'), '');
});

/* ---------------------------------------------------------------------------------------------
 * THE NEGATIVE HALF. Real employer questions that resemble plumbing and must survive intact.
 *
 * Suppressing a genuine question is far more expensive than letting noise through: the applicant
 * then never sees something the employer asked. Every rule above is written to fail safe, and these
 * are the cases that prove it.
 */

test('a real question is never shortened by the handle strip', () => {
  const untouched = [
    // A hyphenated word ends a real question all the time. This is why the generic slug shape takes
    // only "_": "self-employed" and "part-time" are words a person wrote.
    'are you currently self-employed',
    'is this role full-time or part-time',
    'do you have a valid work-permit',
    // Prose that merely CONTAINS the mechanics words.
    'describe your proudest project in 400 characters or fewer',
    'enter a number of years of relevant experience',
    'please enter a date you could start',
    'why should we submit your application to the client team',
    // "required" as an ordinary word, with no employer asterisk in front of it.
    'is a visa required',
    'is a cover letter required',
    // A numbered question is still a question. Only the whole string "submit application" is not.
    '1. why do you want to work here?',
    '2) what is your notice period?',
  ];
  for (const label of untouched) {
    assert.equal(normalizeDiscoveredLabel(label), label, label);
    assert.equal(questionLabelIsGenericAnswerControl(label), false, label);
  }
});

test('a label that is nothing but a meaningful attribute name keeps it', () => {
  /* THE ABANDON GUARD. A control with no written label at all is often named only by its own
   * attribute, and isCoreIdentityField and classifyField both read the intent off exactly that
   * string. Stripping it would leave nothing and turn a fillable identity control into an
   * unreadable question. */
  for (const handle of ['first_name', 'last_name', 'linkedin_url', 'cover_letter', 'phone_number']) {
    assert.equal(normalizeDiscoveredLabel(handle), handle, handle);
  }
});

test('a control handle the option probe reads back out of the stored label survives', () => {
  /* managedOptionProbeControlId recovers a control id from the label when the provider addressed
   * the element by data attribute and left no selector, and on the stored-question path that label
   * is the normalized one. Greenhouse's five self-identification controls are named by exactly the
   * snake_case shape the strip removes, so stripping them would silently skip the option probe for
   * gender, ethnicity, veteran and disability status. */
  const preserved = [
    'are you hispanic/latino? hispanic_ethnicity',
    'are you a protected veteran? veteran_status',
    'do you have a disability? disability_status',
    // A trailing six-digit id is the other shape read back off a label. It matches none of the
    // handle shapes, and this pins that.
    'how would you describe your gender identity? 4001608',
  ];
  for (const label of preserved) {
    assert.equal(normalizeDiscoveredLabel(label), label, label);
  }
  /* And the property that actually matters, stated directly: the id is still recoverable from the
   * NORMALIZED label. On the stored-question path that is the only label the probe planner has, so
   * this is the assertion that would catch a future widening of the strip. */
  assert.equal(
    managedOptionProbeControlId({
      label: normalizeDiscoveredLabel('are you hispanic/latino? hispanic_ethnicity'),
      selector: '',
      durableSelector: null,
    }),
    'hispanic_ethnicity',
  );
});

test('the blocker sentence names the control the same way the stored question does', () => {
  /* There are two label readers on the managed path and they are kept in step by hand: discovery
   * mints the stored question, and the pre-submit required-field gate writes the blocker line. When
   * only one of them is cleaned, the dashboard shows the cleaned row and the raw sentence side by
   * side and counts them as two pieces of work on one box. sanitizeProviderBlockers is where the
   * provider's own sentences enter this repo, so the same strip runs there. */
  assert.deepEqual(
    sanitizeProviderBlockers([
      '"available from* (required) available_from field-available_from" is required and is still empty',
    ]),
    ['"available from" is required and is still empty'],
  );
  // A bare handle with no question in front of it stays what it always was: an honest unnamed field.
  assert.deepEqual(
    sanitizeProviderBlockers(['"yesno-" is required']),
    ['A required field on the form has no label Litos can read, and is still empty'],
  );
});

test('the strip is bounded, so no text rule can run away down a sentence', () => {
  /* AT MOST FOUR TOKENS. A `name` and an `id` is two, and a flattened id splits into no more, so a
   * longer run is not a handle join and the rule stops rather than eating a sentence. */
  assert.equal(
    normalizeDiscoveredLabel('tell us more alpha_one beta_two gamma_three delta_four epsilon_five'),
    'tell us more alpha_one',
  );
  // AND NO LONG TOKEN. Anything past 200 characters is prose, whatever its punctuation.
  const longToken = `a_${'very_long_'.repeat(25)}tail`;
  assert.ok(longToken.length > 200);
  assert.equal(
    normalizeDiscoveredLabel(`what is your answer ${longToken}`),
    `what is your answer ${longToken}`,
  );
});

test('a consent statement keeps every word the applicant is agreeing to', () => {
  /* teamtailor, TixTrack, exactly as stored (229 characters). The handles come off; the statement
   * is DELIBERATELY NOT SUPPRESSED, and this test is the record of that decision.
   * consentAcceptanceValue reads this very wording to decide whether Litos may tick the box at all,
   * so reducing it to "question not readable" would not make the field honest, it would remove
   * Litos's own evidence that the control is a consent control and leave a required checkbox that
   * nothing can fill. It is also a real statement she is agreeing to. */
  const statement = 'required. by submitting this application, i agree that i have read the privacy '
    + 'policy and confirm that tixtrack store my personal details to be able to process my job '
    + 'application.';
  assert.equal(
    normalizeDiscoveredLabel(`${statement}* candidate[consent_given] candidate_consent_given`),
    statement,
  );
  assert.equal(questionLabelIsGenericAnswerControl(statement), false);
  // The opt-in beside it, same packet, same treatment.
  assert.equal(
    normalizeDiscoveredLabel('yes, tixtrack can contact me directly about specific future job '
      + 'opportunities. candidate[consent_given_future_jobs] candidate_consent_given_future_jobs'),
    'yes, tixtrack can contact me directly about specific future job opportunities.',
  );
});

test('a section heading bound to a control is left alone for a binding fix', () => {
  /* pinpoint, Confluence Technologies, exactly as stored (99 characters), on a control whose
   * portal_selector is `#postcode`. NOT fixed here, and the omission is deliberate: a numbered
   * heading with prose after it is the same length and shape as a real long-form question, there is
   * no text evidence separating the two, and the defect is that the control was bound to its
   * section's heading rather than to its own. Suppressing it by text would be a rule that could eat
   * a genuine question, which is the one failure this pass will not risk. */
  const heading = "1.personal details we'll need these details in order to be able to contact you. "
    + 'apply with linkedin';
  assert.equal(normalizeDiscoveredLabel(heading), heading);
  assert.equal(questionLabelIsGenericAnswerControl(heading), false);
  // Same packet, same class, same decision.
  assert.equal(normalizeDiscoveredLabel('3.questions'), '3.questions');
});

test('tidyLabel strips both decorations however they are ordered', () => {
  // The single pass removed the trailing "*" before it removed the trailing "(required)", so a
  // label carrying both came out still wearing the asterisk.
  assert.equal(tidyLabel('available from* (required)'), 'available from');
  assert.equal(tidyLabel('Cover letter* Required'), 'Cover letter');
  // The shapes that already worked keep working.
  assert.equal(tidyLabel('Degree:'), 'Degree');
  assert.equal(tidyLabel('Name*'), 'Name');
  assert.equal(tidyLabel('Discipline (required)'), 'Discipline');
});

/* ---------------------------------------------------------------------------------------------
 * END TO END, THROUGH THE SHIPPED PROJECTION.
 *
 * postingQuestionInventoryFromDiscovered is the function that turns a discovery result into the
 * inventory that is stored and shown, so it is where the outcome is actually decided: a clean
 * question in the employer's own words, or a `missing_question_text` blocker that reaches the
 * applicant as "Litos could not read the employer's exact question text for one application field,
 * so it did not guess at that field."
 *
 * The ids below are the real ones off those packets, full guids included, because a short
 * alphabetic stand-in would not exercise the uuid strip that runs before any of this.
 */
const field = (over: Partial<DiscoveredQuestion> & { label: string }): DiscoveredQuestion => ({
  selector: '[data-litos-discovered-1]',
  durableSelector: null,
  inputType: 'text',
  role: null,
  maxLength: null,
  options: null,
  required: true,
  ...over,
});

test('the four measured boards project to clean questions and honest blockers', () => {
  const inventory = postingQuestionInventoryFromDiscovered([
    // personio, xolife.
    field({
      label: 'available from* (required) available_from field-available_from',
      selector: '[data-litos-discovered-3]',
      durableSelector: '#field-available_from',
    }),
    field({
      label: 'expected salary* (required) salary_expectations field-salary_expectations',
      selector: '[data-litos-discovered-4]',
      durableSelector: '#field-salary_expectations',
    }),
    // teamtailor, TixTrack.
    field({
      label: 'cover letter* required candidate[job_applications_attributes][0][cover_letter] '
        + 'candidate_job_applications_attributes_0_cover_letter',
      selector: '[data-litos-discovered-5]',
      durableSelector: '#candidate_job_applications_attributes_0_cover_letter',
      inputType: 'textarea',
    }),
    // crelate, Blueprint Hires and Prediktive: a placeholder and a character-limit hint, each
    // welded to the type prefix left behind by the uuid strip.
    field({
      label: 'enter a number number-',
      selector: '[data-litos-discovered-6]',
      durableSelector: '[name="number-498dedf8-2a04-4b83-6e48-d3de76dcd908"]',
      inputType: 'number',
    }),
    field({
      label: 'maximum 400 characters short-',
      selector: '[data-litos-discovered-7]',
      durableSelector: '[name="short-e49c4230-526b-4288-842e-a95a0030e2d6"]',
    }),
    field({
      label: 'yesno-',
      selector: '[data-litos-discovered-8]',
      durableSelector: '[name="yesno-c1d2e3f4-0000-4000-8000-abcdefabcdef"]',
    }),
    // pinpoint, Confluence Technologies: the submit section's caption, bound to the consent
    // checkbox that lives inside it.
    field({
      label: '4. submit application',
      selector: '[data-litos-discovered-9]',
      durableSelector: '#application_form_application_privacy',
      inputType: 'checkbox',
    }),
    // A control that was already fine, carried through untouched.
    field({
      label: 'why do you want to work here?',
      selector: '[data-litos-discovered-10]',
      inputType: 'textarea',
    }),
  ]);

  assert.deepEqual(inventory.questions.map((question) => question.label), [
    'available from',
    'expected salary',
    'cover letter',
    'why do you want to work here?',
  ]);
  // Every field that carried no readable question became the honest blocker rather than an
  // unanswerable card, and none of them was silently dropped.
  assert.equal(inventory.metadata_blockers.length, 4);
  assert.equal(
    inventory.metadata_blockers.every((blocker) => blocker.kind === 'missing_question_text'),
    true,
  );
  assert.equal(inventory.metadata_blockers.every((blocker) => !blocker.question), true);
});

test('a Greenhouse self-identification control still reaches the option probe by its label', () => {
  /* The end-to-end guard on the exemption above. This field has no durable selector, so the label
   * is the ONLY place its control id appears, and the probe finds it there or not at all. */
  const inventory = postingQuestionInventoryFromDiscovered([
    field({
      label: 'are you hispanic/latino? hispanic_ethnicity',
      selector: '[data-litos-discovered-14]',
      inputType: 'select-one',
    }),
  ]);
  const blocker = inventory.metadata_blockers[0];
  assert.equal(blocker?.kind, 'missing_exact_options');
  assert.equal(blocker?.control_id, 'hispanic_ethnicity');
});
