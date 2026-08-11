import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  POSTING_QUESTIONS_FAILED_TTL_MS,
  POSTING_QUESTIONS_TTL_MS,
  postingQuestionsAreFresh,
  postingQuestionsFromDiscovered,
  prescriptAskExplanation,
  resolvePrescript,
  type PostingQuestion,
} from './postingQuestions';
import { savedAnswerKey } from './answerReuse';
import type { ApplicationProfileLike } from './questionDiscovery';

const HOUR = 60 * 60 * 1000;

/* The owner's real profile, as measured on 2026-08-08. Everything the resolver can already answer
 * comes from here, and every gap below is a gap on the live account. */
const profile: ApplicationProfileLike = {
  full_name: 'Mehek Mandal',
  phone: '+971500000000',
  school: 'University of Southern California, Viterbi School of Engineering',
  degree: 'Bachelor of Science in Computer Science',
  major: 'Computer Science & Business Administration, Finance Emphasis',
  gpa: '3.89',
  gpa_scale: '4.0',
  grad_date: 'May 2028',
  grad_year: 2028,
  currently_enrolled: true,
  needs_sponsorship: true,
  work_authorized: false,
};

function question(partial: Partial<PostingQuestion> & { label: string }): PostingQuestion {
  return {
    input_type: 'text',
    options: null,
    required: true,
    max_length: null,
    ...partial,
  };
}

// ---- storage ----

test('a discovery result becomes a form inventory with no applicant in it', () => {
  const stored = postingQuestionsFromDiscovered([
    { label: 'Discipline* discipline--0', selector: '[id="discipline--0"]', inputType: 'combobox', maxLength: null, options: ['Computer Science', 'Mathematics'], required: true },
    { label: 'What is your GPA?', selector: '#gpa', inputType: 'text', maxLength: 10, required: false },
    // The fixed-field pass types these from the packet on every run, so they are never work for her.
    { label: 'First Name*', selector: '#first_name', inputType: 'text', maxLength: null, required: true },
    { label: 'Email*', selector: '#email', inputType: 'email', maxLength: null, required: true },
  ]);
  assert.deepEqual(stored.map((item) => item.label), ['Discipline', 'What is your GPA?']);
  const discipline = stored[0];
  // Required is read off the RAW label, before normalization strips the employer's own marker.
  assert.equal(discipline.required, true);
  assert.deepEqual(discipline.options, ['Computer Science', 'Mathematics']);
  assert.equal(stored[1].required, false);
  assert.equal(stored[1].max_length, 10);
  // Nothing about any applicant is stored: no answer, no verdict, no skip reason.
  assert.deepEqual(Object.keys(discipline).sort(), ['input_type', 'label', 'max_length', 'options', 'required']);
});

test('one label discovered twice keeps the richer record', () => {
  const stored = postingQuestionsFromDiscovered([
    { label: 'How did you hear about us?', selector: '#a', inputType: 'radio', maxLength: null, options: null, required: false },
    { label: 'How did you hear about us?*', selector: '#b', inputType: 'radio', maxLength: null, options: ['LinkedIn', 'A friend'], required: true },
  ]);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].options, ['LinkedIn', 'A friend']);
  assert.equal(stored[0].required, true);
});

test('a scan is believed for a fortnight, and a scan that reached nothing for six hours', () => {
  const now = new Date('2026-08-08T12:00:00Z');
  const at = (msAgo: number) => new Date(now.getTime() - msAgo);
  const url = 'https://job-boards.greenhouse.io/acme/jobs/1';

  assert.ok(postingQuestionsAreFresh({ apply_url: url, discovery_status: 'ok', discovered_at: at(13 * 24 * HOUR) }, url, now));
  assert.ok(!postingQuestionsAreFresh({ apply_url: url, discovery_status: 'ok', discovered_at: at(15 * 24 * HOUR) }, url, now));
  assert.ok(postingQuestionsAreFresh({ apply_url: url, discovery_status: 'form_not_reached', discovered_at: at(5 * HOUR) }, url, now));
  assert.ok(!postingQuestionsAreFresh({ apply_url: url, discovery_status: 'form_not_reached', discovered_at: at(7 * HOUR) }, url, now));
  assert.ok(!postingQuestionsAreFresh(null, url, now));
  // A poll rewrote apply_url, so the questions came from a different page. Age is irrelevant.
  assert.ok(!postingQuestionsAreFresh({ apply_url: `${url}?gh_src=x`, discovery_status: 'ok', discovered_at: at(1 * HOUR) }, url, now));
  // The failed life is shorter than the good one, which is the property that matters more than
  // either number: a page that would not load is usually about the moment, not the posting.
  assert.ok(POSTING_QUESTIONS_FAILED_TTL_MS < POSTING_QUESTIONS_TTL_MS);
});

// ---- the split, per applicant ----

test('only what she has to answer is asked, and the profile answers the rest', () => {
  const { ask, questions } = resolvePrescript([
    question({ label: 'What is your GPA?' }),
    question({ label: 'Which University do you attend?' }),
    question({ label: 'Please rate your skill level in C++', options: ['Beginner', 'Intermediate', 'Advanced', 'Expert'], input_type: 'select' }),
    question({ label: 'Based on the team descriptions above, which opening would you be most interested in contributing to?', input_type: 'textarea' }),
  ], profile, new Map(), { company: 'Faire' });

  assert.deepEqual(questions.filter((item) => !item.ask).map((item) => item.label), [
    'What is your GPA?',
    'Which University do you attend?',
  ]);
  assert.deepEqual(ask.map((item) => item.label), [
    'Please rate your skill level in C++',
    'Based on the team descriptions above, which opening would you be most interested in contributing to?',
  ]);
  assert.equal(ask[0].reason, 'self_declaration');
  assert.deepEqual(ask[0].options, ['Beginner', 'Intermediate', 'Advanced', 'Expert']);
  assert.equal(ask[1].reason, 'needs_your_words');
});

test('nothing on this screen is ever prefilled by a guess', () => {
  const { ask } = resolvePrescript([
    question({ label: 'Astranis complies with U.S. Government space technology export regulations, including the International Traffic in Arms Regulations (ITAR). Are you a U.S. person as defined by these regulations?' }),
    question({ label: 'Are you or have you been entrusted with a position or function in any government, international organization, or state-owned enterprise?' }),
  ], profile, new Map(), { company: 'Astranis' });
  assert.equal(ask.length, 2);
  for (const item of ask) {
    assert.equal(item.answer, '', 'a declaration is presented blank or not at all');
    assert.equal(item.reason, 'self_declaration');
    assert.equal(item.remembered, false);
  }
});

test('a declaration is asked even when a stored profile column could have answered it', () => {
  // needs_sponsorship is on file and the runner will still use it if she leaves this alone. The
  // pre-script asks anyway: the entire point of the screen is that a declaration goes past her.
  const { ask } = resolvePrescript(
    [question({ label: 'Do you now OR in the future require visa sponsorship to continue working in the US?', options: ['Yes', 'No'], input_type: 'select' })],
    profile,
    new Map(),
    { company: 'Truveta' },
  );
  assert.equal(ask.length, 1);
  assert.equal(ask[0].answer, '');
});

test('a narrowly factual standardized score she gave once comes back filled', () => {
  const label = 'What was your SAT score?';
  const saved = new Map([[savedAnswerKey(label), '1510']]);
  const { ask, questions } = resolvePrescript([question({ label })], profile, saved, { company: 'Jane Street' });
  assert.equal(ask.length, 0);
  assert.equal(questions[0].answer, '1510');
  assert.equal(questions[0].remembered, true);
  assert.equal(questions[0].reusable, true);
});

test('a remembered standardized score is asked again when the current closed options changed', () => {
  const label = 'What was your SAT score?';
  const saved = new Map([[savedAnswerKey(label), '1510']]);
  const { ask, questions } = resolvePrescript([
    question({ label, input_type: 'select', options: ['1200-1399', '1400-1499', '1500-1600'] }),
  ], profile, saved, { company: 'Jane Street' });
  assert.equal(ask.length, 1);
  assert.equal(questions[0].answer, '');
  assert.equal(questions[0].remembered, false);
  assert.equal(questions[0].reason, 'choice_for_you');
});

test('a posting-specific answer she gave elsewhere is never carried in', () => {
  const label = 'What is your preferred work location?';
  // Stored under the same key by some other path. The read side refuses it anyway.
  const saved = new Map([[savedAnswerKey(label), 'New York']]);
  const { ask } = resolvePrescript(
    [question({ label, options: ['Stamford, CT', 'New York, NY'], input_type: 'select' })],
    profile,
    saved,
    { company: 'Point72' },
  );
  assert.equal(ask.length, 1);
  assert.equal(ask[0].answer, '', 'a posting-specific answer must not be prefilled from another posting');
  assert.equal(ask[0].reusable, false);
  assert.equal(ask[0].reason, 'choice_for_you');
});

test('an optional field Litos cannot answer is left alone rather than turned into work', () => {
  const { ask } = resolvePrescript(
    [question({ label: 'Anything else you would like us to know?', required: false, input_type: 'textarea' })],
    profile,
    new Map(),
  );
  assert.equal(ask.length, 0);
});

test('every ask carries a sentence saying why it is hers', () => {
  for (const reason of ['self_declaration', 'choice_for_you', 'needs_your_words', 'nothing_on_file'] as const) {
    const text = prescriptAskExplanation(reason, 'Discipline');
    assert.ok(text.length > 10, reason);
  }
});

test('the pre-script cannot draft: there is no model on this path', () => {
  const source = readFileSync('src/lib/postingQuestions.ts', 'utf8');
  assert.doesNotMatch(source, /draftApplicationAnswer|from '\.\.\/llm\//);
});

// ---- the cost decision ----

test('the cost argument against pre-scanning the whole board is written down where it can be read', () => {
  const source = readFileSync('src/lib/postingQuestions.ts', 'utf8');
  // The three numbers that make an eager sweep impossible rather than merely expensive: the size of
  // the board, the cron's ceiling, and the transfer budget the read side has to live inside.
  assert.match(source, /22,644/);
  assert.match(source, /300s|300 s|maxDuration/);
  assert.match(source, /5 GB|5GB/);
  assert.match(source, /docs\/incidents\/2026-08-04/);
});

test('the pre-script is not joined into a board list query', () => {
  // The board is the most-loaded surface in the product. Fifty rows of question JSON per page would
  // be roughly 100 KB against the 1.1 MB worst case egressBudget.test.ts pins, on the one surface
  // that gains nothing from it. Read exactly one row, on the Apply path, and nowhere else.
  const board = readFileSync('src/routes/jobMonitor.ts', 'utf8');
  assert.doesNotMatch(board, /posting_questions/);
});

/* ---------------------------------------------------------------------------------------------
 * AN EXISTING USER WHO HAS NOT ANSWERED IS ASKED, NEVER DEFAULTED.
 *
 * The migration that adds onsite_commitment is additive and nullable, so every account already on
 * the system reads null the moment the code deploys. The failure mode this pins is the tempting
 * one: making the new column "default to what we did before" so nothing appears to change. That
 * would be the constant again, with a migration in front of it.
 *
 * Instead the resolver refuses, and the pre-script - the ask-at-Apply machinery from PR #373 -
 * puts the question on the screen with a sentence naming it, before the run starts.
 * ------------------------------------------------------------------------------------------- */
test('an account with no stored onsite commitment is asked at Apply, not answered', () => {
  // The exact Redwood Materials label, from packet 8d12aea8-8476-4f7a-860b-fa6393842df9, which was
  // ready to send with this answered "Yes".
  const redwood: PostingQuestion = {
    label: 'Are you available to work from our office in San Francisco?',
    input_type: 'select',
    options: ['Yes', 'No'],
    required: true,
    max_length: null,
  };
  const { ask, questions } = resolvePrescript([redwood], profile, new Map(), { company: 'Redwood Materials' });
  assert.equal(ask.length, 1);
  assert.equal(ask[0].label, redwood.label);
  // Blank. Not "Yes", and not a best guess off her address.
  assert.equal(ask[0].answer, '');
  assert.equal(questions[0].remembered, false);
  // And she is told which question is waiting, rather than finding an empty required field later.
  assert.ok(prescriptAskExplanation(ask[0].reason!, redwood.label).length > 20);

  /* ONCE SHE HAS ANSWERED, the pre-script stops asking, which is the whole point of the columns.
     A list that does not include San Francisco is a truthful No, not a shrug: she named the offices
     she will sit in and this is not one of them. A list that does include it is a Yes. Neither is a
     guess, and neither reads anything off her home address. */
  const notListed = resolvePrescript([redwood], {
    ...profile,
    onsite_commitment: 'listed_locations',
    onsite_locations: ['Los Angeles'],
  }, new Map(), { company: 'Redwood Materials' });
  assert.equal(notListed.ask.length, 0);
  assert.equal(notListed.questions[0].answer, 'No');

  const listed = resolvePrescript([redwood], {
    ...profile,
    onsite_commitment: 'listed_locations',
    onsite_locations: ['San Francisco'],
  }, new Map(), { company: 'Redwood Materials' });
  assert.equal(listed.ask.length, 0);
  assert.equal(listed.questions[0].answer, 'Yes');

  const anywhere = resolvePrescript([redwood], {
    ...profile,
    onsite_commitment: 'anywhere',
  }, new Map(), { company: 'Redwood Materials' });
  assert.equal(anywhere.ask.length, 0);
  assert.equal(anywhere.questions[0].answer, 'Yes');
});

/* ---------------------------------------------------------------------------------------------
 * OPTIONS ARRIVING AS QUESTIONS.
 *
 * Every fixture below is a real row from the owner's production packets of 2026-08-11, where 11
 * Palantir packets each carried "Yes", "Yes, I consent" and "English (ENG)" as REQUIRED questions
 * while the four questions the form actually asked had no record at all.
 * --------------------------------------------------------------------------------------------- */

test('a radio option standing where its question should be is not stored as a question', () => {
  const stored = postingQuestionsFromDiscovered([
    // The discriminator: the label case-folds equal to a member of its own option list.
    { label: 'Yes', selector: '#a', inputType: 'radio', maxLength: null, options: ['Yes', 'No'], required: true },
    { label: 'No', selector: '#b', inputType: 'radio', maxLength: null, options: ['Yes', 'No'], required: true },
    { label: 'Yes, I consent', selector: '#c', inputType: 'checkbox', maxLength: null, options: ['Yes, I consent', 'No, I do not consent'], required: true },
    // Punctuation and case carry no meaning in the comparison.
    { label: 'DECLINE TO SELF-IDENTIFY', selector: '#d', inputType: 'radio', maxLength: null, options: ['Decline to self identify', 'Female', 'Male'], required: false },
    // The real question on the same form survives untouched.
    { label: 'Do you require visa sponsorship?', selector: '#e', inputType: 'radio', maxLength: null, options: ['Yes', 'No'], required: true },
  ]);
  assert.deepEqual(stored.map((item) => item.label), ['Do you require visa sponsorship?']);
});

test('an answer token is refused on the managed path, where no option list is reported', () => {
  // stratus-browser-cloud reports no options, so the exact own-option test has nothing to compare
  // against. This is the closed vocabulary that has to carry it instead.
  const stored = postingQuestionsFromDiscovered([
    { label: 'Yes', selector: '#a', inputType: 'radio', maxLength: null, options: null, required: true },
    { label: 'Yes, I consent', selector: '#b', inputType: 'checkbox', maxLength: null, options: null, required: true },
    { label: 'I agree', selector: '#c', inputType: 'checkbox', maxLength: null, options: null, required: true },
    { label: 'I do not want to answer', selector: '#d', inputType: 'radio', maxLength: null, options: null, required: false },
    // A language checkbox's own option: a name and its ISO-639 code, and nothing else.
    { label: 'English (ENG)', selector: '#e', inputType: 'checkbox', maxLength: null, options: null, required: true },
    { label: 'Espanol (SPA)', selector: '#f', inputType: 'checkbox', maxLength: null, options: null, required: true },
    // What an employer actually writes when it wants to know about languages.
    { label: 'Which languages do you speak?', selector: '#g', inputType: 'text', maxLength: null, options: null, required: true },
  ]);
  assert.deepEqual(stored.map((item) => item.label), ['Which languages do you speak?']);
});

test("Lever's card handle is stripped, and a row that was nothing but the handle is dropped", () => {
  // Exactly the labels the 11 Palantir packets stored, name attribute and all.
  const stored = postingQuestionsFromDiscovered([
    { label: 'Yes cards[a69a985a-eae9-4c14-90fb-b5a4b891523e][field0]', selector: '#a', inputType: 'radio', maxLength: null, options: null, required: true },
    { label: 'English (ENG) cards[a69a985a-eae9-4c14-90fb-b5a4b891523e][field0]', selector: '#b', inputType: 'checkbox', maxLength: null, options: null, required: true },
    { label: 'cards[a69a985a-eae9-4c14-90fb-b5a4b891523e][field1]', selector: '#c', inputType: 'text', maxLength: null, options: null, required: true },
    // A card whose question text survived keeps it, and loses only the handle.
    { label: 'Year of Graduation cards[a69a985a-eae9-4c14-90fb-b5a4b891523e][field0]', selector: '#d', inputType: 'text', maxLength: null, options: null, required: true },
  ]);
  assert.deepEqual(stored.map((item) => item.label), ['Year of Graduation']);
});

test("a composite widget's rendered subtree is not a question", () => {
  const stored = postingQuestionsFromDiscovered([
    // textContent of a <label> wrapping a typeahead: heading, required glyph, empty state, loader.
    { label: 'Current location No location found. Try entering a different locationLoading location location-input', selector: '#a', inputType: 'text', maxLength: null, options: null, required: true },
    // A select whose label swallowed the placeholder, every option, the name and a tag name.
    {
      label: 'Disability statusSelect ...Yes, I have a disability, or have had one in the pastNo, I do not have a disability and have not had one in the pastI do not want to answer eeo[disability] disabilitySelectElement',
      selector: '#b',
      inputType: 'select',
      maxLength: null,
      options: ['Yes, I have a disability, or have had one in the past', 'No, I do not have a disability and have not had one in the past', 'I do not want to answer'],
      required: true,
    },
    { label: 'Where do you currently live?', selector: '#c', inputType: 'text', maxLength: null, options: null, required: true },
  ]);
  assert.deepEqual(stored.map((item) => item.label), ['Where do you currently live?']);
});

test('the bare privacy labels are questions and are never filtered out', () => {
  /* R-PROTECT. "Privacy" (8 packets, Point72) and "Privacy statement" (7, IMC) are the employer's
   * real, bare labels for a consent checkbox. BARE_PRIVACY_ACKNOWLEDGEMENT answers both from
   * accept_privacy_notices, and the owner has a saved answer for each. They are short, they are not
   * sentences, and they sit next to a Yes/No control, so every plausible shape rule for "this looks
   * like an option, not a question" is one edit away from deleting them. This test is here so that
   * edit fails loudly instead of silently costing two answers Litos already has. */
  const stored = postingQuestionsFromDiscovered([
    { label: 'Privacy', selector: '#a', inputType: 'checkbox', maxLength: null, options: null, required: true },
    { label: 'Privacy statement', selector: '#b', inputType: 'checkbox', maxLength: null, options: null, required: true },
    { label: 'Privacy Policy Acknowledgement', selector: '#c', inputType: 'checkbox', maxLength: null, options: null, required: true },
    // Even when the control does report a Yes/No list, the LABEL is not a member of it.
    { label: 'Privacy notice', selector: '#d', inputType: 'radio', maxLength: null, options: ['Yes', 'No'], required: true },
  ]);
  assert.deepEqual(
    stored.map((item) => item.label),
    ['Privacy', 'Privacy statement', 'Privacy Policy Acknowledgement', 'Privacy notice'],
  );
});

test('short and unusual employer labels are not mistaken for options', () => {
  // No minimum length, and no "must contain a verb" rule: these are all real field names.
  const stored = postingQuestionsFromDiscovered([
    { label: 'GPA', selector: '#a', inputType: 'text', maxLength: null, options: null, required: true },
    { label: 'School', selector: '#b', inputType: 'combobox', maxLength: null, options: null, required: true },
    { label: 'Major', selector: '#c', inputType: 'combobox', maxLength: null, options: null, required: true },
    { label: 'Race', selector: '#d', inputType: 'select', maxLength: null, options: ['Asian', 'White'], required: false },
    { label: 'Veteran status', selector: '#e', inputType: 'select', maxLength: null, options: null, required: false },
    { label: 'Other', selector: '#f', inputType: 'text', maxLength: null, options: null, required: false },
    { label: 'Offer Deadlines', selector: '#g', inputType: 'text', maxLength: null, options: null, required: false },
  ]);
  assert.deepEqual(
    stored.map((item) => item.label),
    ['GPA', 'School', 'Major', 'Race', 'Veteran status', 'Other', 'Offer Deadlines'],
  );
});
