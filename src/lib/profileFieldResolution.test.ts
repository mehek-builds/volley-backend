import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRequiredBlocker } from './fieldLabel';
import {
  chooseClosestOption,
  disciplineLadder,
  educationLevelLadder,
  optionCoversMonthYear,
  parseNumericRange,
  profileBackedBlockerLabels,
  referralSourceLadder,
  resolveProfileField,
  schoolAliasLadder,
  usableOptions,
} from './profileFieldResolution';
import type { ApplicationProfileLike } from './questionDiscovery';

// The account's REAL stored values, read from prod on 2026-08-08 (user
// a18f774b-a306-4804-93f3-cd6020c27fb3): application_profile holds major, gpa, gpa_scale and
// referral_source_default; profiles.parsed_json holds school, degree, grad_date, grad_year and
// currently_enrolled. Every fixture below is one of those strings verbatim, because the whole
// point of this file is that these exact values were sitting in the database while six employers
// were told the fields were empty.
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
  referral_source_default: 'Company website',
  work_authorized: true,
  needs_sponsorship: true,
};

// The same person as parsed from the resume, where `major` is the full sentence rather than the
// tidied application_profile value. This is the harder input and it must resolve identically.
const PARSED_PROFILE: ApplicationProfileLike = {
  ...STORED_PROFILE,
  major: 'Computer Science & Business Administration, Finance Emphasis',
};

function answer(label: string, options?: string[], ap: ApplicationProfileLike = STORED_PROFILE): string | null {
  return resolveProfileField({ label, options }, ap)?.value ?? null;
}

// ---------------------------------------------------------------------------
// Class A, row by row. Each label is quoted from a real "<label> is required and is still empty"
// blocker recorded against one of the 25 measured packets.
// ---------------------------------------------------------------------------

test('Class A: GPA (Akuna x4, Five Rings, IMC, Virtu)', () => {
  // Free text: the stored number, unchanged.
  assert.equal(answer('What is your GPA?'), '3.89');
  assert.equal(answer('Overall GPA'), '3.89');
  assert.equal(answer('Please indicate your overall GPA.'), '3.89');

  // A bucketed select. Typing "3.89" at this control selects nothing at all, which is exactly how
  // a stored GPA became '"What is your GPA?" is required and is still empty'.
  assert.equal(
    answer('What is your GPA?', ['Select...', 'Below 3.0', '3.0 - 3.49', '3.5 - 3.74', '3.75 - 4.0']),
    '3.75 - 4.0',
  );
  assert.equal(answer('Overall GPA', ['3.5+', '3.0 - 3.49', 'Below 3.0']), '3.5+');

  // A select that lists exact values still gets the exact value.
  assert.equal(answer('What is your GPA?', ['3.87', '3.88', '3.89', '3.90']), '3.89');
  // And one that lists one decimal place gets the rounded form rather than nothing.
  assert.equal(answer('What is your GPA?', ['3.7', '3.8', '3.9', '4.0']), '3.9');
});

test('Class A: which university do/did you attend (Akuna, Virtu)', () => {
  // Free text keeps the resume's full phrasing.
  assert.equal(
    answer('Which University do/did you attend?'),
    'University of Southern California, Viterbi School of Engineering',
  );

  // A closed list carries the institution WITHOUT the school-within-the-university clause, so the
  // stored string matches no option. Dropping that clause is what makes the option reachable.
  assert.equal(
    answer('Which University do/did you attend?', ['Stanford University', 'University of Southern California', 'Other']),
    'University of Southern California',
  );
  assert.equal(
    answer('Which university are you currently attending? Select "Other" if not listed', [
      'MIT',
      'USC',
      'UCLA',
    ]),
    'USC',
  );
});

test('Class A: education level and Discipline (Akuna, Point72, Five Rings, IMC, Tower, Virtu)', () => {
  // A bare "Degree" is Greenhouse's education-section level picker. It arrives from discovery as
  // "degree* degree--0" and must normalize to the employer's own label.
  assert.equal(answer('degree* degree--0'), "Bachelor's Degree");
  assert.equal(answer('What education level are you currently pursuing?'), "Bachelor's Degree");
  assert.equal(
    answer('What education level are you currently pursuing?', ['Bachelors', 'Masters', 'PhD']),
    'Bachelors',
  );
  assert.equal(
    answer('degree* degree--0', ["Associate's Degree", "Bachelor's Degree", "Master's Degree"]),
    "Bachelor's Degree",
  );

  // Point72 asks in prose, so the resume sentence is the truest free-text answer, while the same
  // question backed by a list resolves onto the list.
  assert.equal(answer('What degree are you currently pursuing?'), 'Bachelor of Science in Computer Science');
  assert.equal(
    answer('What degree are you currently pursuing?', ['Bachelor of Science', 'Master of Science', 'PhD']),
    'Bachelor of Science',
  );

  // Discipline is a taxonomy, never a sentence.
  assert.equal(answer('discipline* discipline--0'), 'Computer Science');
  assert.equal(
    answer('discipline* discipline--0', ['Business', 'Computer and Information Sciences', 'Engineering']),
    'Computer and Information Sciences',
  );
  assert.equal(
    answer('Discipline', ['Business', 'Computer Science', 'Mathematics'], PARSED_PROFILE),
    'Computer Science',
  );
});

test('Class A: graduation month, year, and anticipated date (Akuna x6, Virtu, IMC, Five Rings)', () => {
  assert.equal(answer('Graduation Month'), 'May');
  assert.equal(answer('Graduation Year'), '2028');
  assert.equal(answer('What is your expected graduation year?'), '2028');

  // Month and year are separate selects on the Greenhouse education section, and each spells its
  // options differently. "May 2028" satisfies neither of them on its own.
  assert.equal(
    answer('Graduation Month', ['January', 'February', 'March', 'April', 'May', 'June']),
    'May',
  );
  assert.equal(answer('Graduation Month', ['01', '02', '03', '04', '05', '06']), '05');
  assert.equal(answer('Graduation Year', ['2026', '2027', '2028', '2029']), '2028');

  // IMC asks for a RANGE. Range arithmetic, not substring matching on the year: the wrong half of
  // 2028 is a different answer about the same person.
  assert.equal(
    answer('When is your anticipated graduation date - please select a Graduation Date range', [
      'Before 2027',
      'January 2027 - June 2027',
      'July 2027 - December 2027',
      'January 2028 - June 2028',
      'July 2028 - December 2028',
    ]),
    'January 2028 - June 2028',
  );
  assert.equal(
    answer('Expected Graduation Date', ['Fall 2027', 'Spring 2028', 'Fall 2028']),
    'Spring 2028',
  );
});

test('Class A: how did you hear about this job (Akuna, Five Rings, Virtu, IMC)', () => {
  assert.equal(answer('How did you hear about this job?'), 'Company website');
  assert.equal(answer('How did you first hear about Five Rings?'), 'Company website');
  assert.equal(answer('How did you hear about this internship?'), 'Company website');

  assert.equal(
    answer('How did you hear about this job?', ['LinkedIn', 'Company Website', 'Job Board', 'Other']),
    'Company Website',
  );
  assert.equal(
    answer('How did you first hear about Five Rings?', ['University event', 'Careers Page', 'Referral']),
    'Careers Page',
  );
  // "Other" is truthful and is the LAST resort, never something that displaces a real option.
  assert.equal(
    answer('How did you hear about this internship?', ['LinkedIn', 'Employee referral', 'Other']),
    'Other',
  );
});

test('Class A: visa sponsorship comes from the stored boolean (Akuna x7, Virtu)', () => {
  const label = 'Do you now, or will you in the future, require visa sponsorship to continue working in the United States (e.g. H-1B, TN,';
  assert.equal(answer(label), 'Yes');
  assert.equal(answer(label, ['Yes', 'No']), 'Yes');
  assert.equal(
    answer('Do you now, or will you in the future, need sponsorship from an employer in order to obtain, extend or renew your author', ['Yes', 'No']),
    null,
  );
  assert.equal(
    answer('Do you now, or will you in the future, need sponsorship from an employer to work in the United States?', ['Yes', 'No']),
    'Yes',
  );
  assert.equal(answer(label, ['Yes', 'No'], { ...STORED_PROFILE, needs_sponsorship: false }), 'No');
});

// ---------------------------------------------------------------------------
// The regression the whole class needs.
// ---------------------------------------------------------------------------

// Every Class A blocker sentence measured in prod, verbatim, including the provider's own
// mid-sentence truncation.
const CLASS_A_LABELS = [
  'What is your GPA?',
  'Overall GPA',
  'Please indicate your overall GPA.',
  'Which University do/did you attend?',
  'Which university are you currently attending? Select "Other" if not listed',
  'What education level are you currently pursuing?',
  'What degree are you currently pursuing?',
  'Discipline',
  'Graduation Month',
  'Graduation Year',
  'What is your expected graduation year?',
  'When is your anticipated graduation date - please select a Graduation Date range',
  'How did you hear about this job?',
  'How did you first hear about Five Rings?',
  'How did you hear about this internship?',
  'Do you now, or will you in the future, require visa sponsorship to continue working in the United States (e.g. H-1B, TN,',
];

test('a value present in the profile is never reported as required and still empty unattempted', () => {
  const blockers = CLASS_A_LABELS.map((label) => describeRequiredBlocker(label));

  // Built through describeRequiredBlocker so this breaks if the production sentence ever changes
  // shape, rather than quietly matching nothing and passing.
  assert.deepEqual(profileBackedBlockerLabels(blockers, STORED_PROFILE), CLASS_A_LABELS);

  // Each one individually, so a failure names the field instead of dumping the whole array.
  for (const label of CLASS_A_LABELS) {
    const resolved = resolveProfileField({ label }, STORED_PROFILE);
    assert.ok(resolved && resolved.value.trim(), `resolver produced nothing for ${label}`);
  }
});

test('the guard stays honest: Class B fields the profile really does not hold are not flagged', () => {
  // If these were reported too, the guard above would be green no matter what the resolver did.
  // Every one of them is a real Class B blocker: genuinely absent, and destined for onboarding.
  const classB = [
    'We care about addressing everyone correctly. Add your personal pronouns below to share with the hiring team.',
    'Select your Standardized Test score type',
    'Provide your best result on SAT',
    'Provide your best result on ACT',
  ];
  assert.deepEqual(profileBackedBlockerLabels(classB.map((label) => describeRequiredBlocker(label)), STORED_PROFILE), []);
});

test('an empty profile flags only what the resolver can answer without one', () => {
  const blockers = CLASS_A_LABELS.map((label) => describeRequiredBlocker(label));
  /* Every academic fact and the sponsorship boolean drop out, which proves the guard is reading the
     profile rather than the label list.

     CHANGED 2026-08-09: referral source used to stay on this list, with the note "resolveKnownAnswer
     answers it with 'Company website' for an account that has set no default, and that is a
     deliberate product behaviour rather than stored data". Both halves of that were true, and the
     second half is why it is gone: it was a statement of fact about how she found the posting, made
     to an employer in her name, that no person had made - and usually false, because Litos finds
     these on a monitored board. Measured the same day, all 16 production rows carried "Company
     website" purely from the column default, so there was no account anywhere for which it was a
     choice. An empty profile now answers NOTHING here, which is what an empty profile means. */
  assert.deepEqual(profileBackedBlockerLabels(blockers, {}), []);
  // With a real stored answer it is relayed again, and the blocker is correctly profile-backed.
  assert.deepEqual(
    profileBackedBlockerLabels(
      [describeRequiredBlocker('How did you hear about this job?')],
      { referral_source_default: 'LinkedIn' },
    ),
    ['How did you hear about this job?'],
  );
});

// ---------------------------------------------------------------------------
// The pieces, tested directly.
// ---------------------------------------------------------------------------

test('chooseClosestOption refuses a weak match rather than picking a wrong legal answer', () => {
  // Nothing in the list is the applicant's school, so nothing is selected. Leaving a field empty
  // is recoverable; selecting the wrong university on a real application is not.
  assert.equal(chooseClosestOption(['University of Southern California'], ['Harvard University', 'Yale University']), null);
  // A two-letter candidate never wins by containment: "BS" must not select "Business".
  assert.equal(chooseClosestOption(['BS'], ['Business', 'Biology']), null);
  // The placeholder row of a select is never an answer.
  assert.equal(chooseClosestOption(['Anything'], ['Select...', '--', 'Please select']), null);
  assert.equal(chooseClosestOption([], ['Yes', 'No']), null);
  assert.equal(chooseClosestOption(['Yes'], null), null);
});

/* BLOCKER 2. An option that states the answer and then keeps going is a different answer.
 *
 * Measured on the merged tree, with needs_sponsorship: true so the resolver's own answer is "Yes,
 * I need sponsorship":
 *
 *   chooseClosestOption(['Yes'],
 *     ['Yes - I am authorized to work in the US for any employer','No - I will require sponsorship'])
 *   -> 'Yes - I am authorized to work in the US for any employer'
 *
 * The resolver selected the sentence asserting the opposite of the answer it was given, on a
 * question with legal weight, and reported matchedOption: true. Refusing costs an empty field the
 * applicant can fill in herself. This cost her the truth. */
test('a short answer never adopts a longer option that adds meaning', () => {
  assert.equal(
    chooseClosestOption(['Yes'], [
      'Yes - I am authorized to work in the US for any employer',
      'No - I will require sponsorship',
    ]),
    null,
  );
  // Several options share the prefix, so there is nothing to disambiguate on. Refuse.
  assert.equal(chooseClosestOption(['Yes'], ['Yes, with sponsorship', 'Yes, without sponsorship', 'No']), null);
  // A bare Yes/No list is unambiguous and still answered, which is the case that must not regress.
  assert.equal(chooseClosestOption(['Yes'], ['Yes', 'No']), 'Yes');
  assert.equal(
    resolveProfileField(
      {
        label: 'Are you legally authorized to work in the United States?',
        options: ['Yes, with sponsorship', 'Yes, without sponsorship', 'No'],
      },
      STORED_PROFILE,
    )?.matchedOption,
    false,
    'an unmatched option list must never be reported as a confident selection',
  );
});

/* The same rule on a proper noun. The school ladder drops a trailing "..., Viterbi School of
 * Engineering" clause to reach an option that names the institution alone, and on a Berkeley
 * profile that truncation also drops the campus:
 *
 *   schoolAliasLadder('University of California, Berkeley') -> [..., 'University of California']
 *   vs options ['University of California, Los Angeles','University of California, Davis'] -> UCLA
 *
 * Two employers would have been told she attends UCLA. Nothing in the list is her university, so
 * nothing is selected. */
test('a truncated school name never picks a campus it cannot distinguish', () => {
  assert.deepEqual(
    schoolAliasLadder('University of California, Berkeley'),
    ['University of California, Berkeley', 'University of California'],
  );
  assert.equal(
    chooseClosestOption(schoolAliasLadder('University of California, Berkeley'), [
      'University of California, Los Angeles',
      'University of California, Davis',
    ]),
    null,
  );
  // One campus in the list is no better: "Los Angeles" is a distinguishing word, not a spelling of
  // the same institution, so a single matching option is still a different university.
  assert.equal(
    chooseClosestOption(schoolAliasLadder('University of California, Berkeley'), [
      'University of California, Los Angeles',
      'Stanford University',
    ]),
    null,
  );
  // Her own campus, spelled either way, still resolves. The rule refuses guesses, not answers.
  assert.equal(
    chooseClosestOption(schoolAliasLadder('University of California, Berkeley'), [
      'University of California, Berkeley',
      'University of California, Davis',
    ]),
    'University of California, Berkeley',
  );
  // And a parenthetical initialism adds no meaning, so it is still allowed through.
  assert.equal(
    chooseClosestOption(['University of Southern California'], ['University of Southern California (USC)']),
    'University of Southern California (USC)',
  );
});

/* BOTH EXTRAS, because each one puts a false statement on a form.
 *
 * referralSourceLadder listed 'Job Board' ahead of 'Other', so a stored "Company website" against
 * ['LinkedIn','Job Board','Employee referral','Other'] returned Job Board: a claim about how she
 * found the role that did not happen. "Other" is true however she arrived. */
test('a referral source never claims a channel the applicant did not use', () => {
  assert.equal(
    answer('How did you hear about this job?', ['LinkedIn', 'Job Board', 'Employee referral', 'Other']),
    'Other',
  );
  assert.deepEqual(referralSourceLadder('Company website').at(-1), 'Other');
  assert.equal(referralSourceLadder('Company website').includes('Job Board'), false);
  // A stored value that is NOT the company's own site does not get the company-site synonyms
  // offered on its behalf either. Stored value, then Other, and nothing invented in between.
  assert.deepEqual(referralSourceLadder('LinkedIn'), ['LinkedIn', 'Other']);
  assert.equal(
    chooseClosestOption(referralSourceLadder('LinkedIn'), ['Company Website', 'Job Board', 'Other']),
    'Other',
  );
  // The truthful specific option still beats Other whenever it is on the list.
  assert.equal(
    answer('How did you hear about this job?', ['LinkedIn', 'Company Website', 'Job Board', 'Other']),
    'Company Website',
  );
});

/* usableOptions stripped 'none' and 'n/a' as placeholder rows. For "outstanding offers", "prior
 * applications" and "test scores" None IS the answer, so the correct entry was filtered out of its
 * own option list and the control came back "required and is still empty". */
test('None and N/A are answers, not placeholder rows', () => {
  assert.deepEqual(usableOptions(['Select...', 'None', 'N/A', 'Yes']), ['None', 'N/A', 'Yes']);
  assert.equal(chooseClosestOption(['None'], ['Select...', 'None', '1', '2']), 'None');
  assert.equal(chooseClosestOption(['N/A'], ['Please select', 'N/A', 'SAT', 'ACT']), 'N/A');
  // The rows that really are placeholders still go.
  assert.deepEqual(usableOptions(['Select...', '--', 'Please select', '-- Choose --', 'Yes']), ['Yes']);
});

test('chooseClosestOption ignores case, punctuation, and possessive spelling', () => {
  assert.equal(chooseClosestOption(["Bachelor's Degree"], ['bachelors degree', 'masters degree']), 'bachelors degree');
  assert.equal(chooseClosestOption(['Company website'], ['Company Website']), 'Company Website');
  assert.equal(chooseClosestOption(['Decline to self-identify'], ['Decline To Self Identify']), 'Decline To Self Identify');
});

test('parseNumericRange reads the bucket wordings portals actually ship', () => {
  assert.deepEqual(parseNumericRange('3.5 - 4.0'), { min: 3.5, max: 4 });
  assert.deepEqual(parseNumericRange('3.50–3.74'), { min: 3.5, max: 3.74 });
  assert.deepEqual(parseNumericRange('3.0 to 3.49'), { min: 3, max: 3.49 });
  assert.deepEqual(parseNumericRange('3.5+'), { min: 3.5, max: Number.POSITIVE_INFINITY });
  assert.deepEqual(parseNumericRange('Above 3.5'), { min: 3.5, max: Number.POSITIVE_INFINITY });
  assert.deepEqual(parseNumericRange('Below 3.0'), { min: Number.NEGATIVE_INFINITY, max: 3 });
  assert.deepEqual(parseNumericRange('4.0'), { min: 4, max: 4 });
  assert.equal(parseNumericRange('Prefer not to say'), null);
});

test('optionCoversMonthYear distinguishes the halves of a graduation year', () => {
  assert.equal(optionCoversMonthYear('January 2028 - June 2028', 5, 2028), true);
  assert.equal(optionCoversMonthYear('July 2028 - December 2028', 5, 2028), false);
  assert.equal(optionCoversMonthYear('Spring 2028', 5, 2028), true);
  assert.equal(optionCoversMonthYear('Fall 2028', 5, 2028), false);
  assert.equal(optionCoversMonthYear('2028', 5, 2028), true);
  assert.equal(optionCoversMonthYear('2027', 5, 2028), false);
  assert.equal(optionCoversMonthYear('2027 - 2029', 5, 2028), true);
});

/* BLOCKER 1. A boundary qualifier is not decoration, it is the whole meaning of the option.
 *
 * Measured against the real stored profile (grad_date 'May 2028') on the merged tree:
 *   optionCoversMonthYear('Before 2028', 5, 2028)        -> true
 *   optionCoversMonthYear('After 2028', 5, 2028)         -> true
 *   optionCoversMonthYear('2028 or earlier', 5, 2028)    -> true
 *   optionCoversMonthYear('No later than 2028', 5, 2028) -> true
 * All four answered the same, because the year was parsed out and the qualifier thrown away. Two of
 * the four are flatly false about a person graduating in May 2028, and "graduated before 2028" is a
 * hard eligibility filter on a campus role. parseNumericRange has read above/below/or-higher off a
 * GPA bucket since it was written; the calendar path now reads the same shapes.
 */
test('a boundary qualifier decides which side of the year an option covers', () => {
  assert.equal(optionCoversMonthYear('Before 2028', 5, 2028), false);
  assert.equal(optionCoversMonthYear('After 2028', 5, 2028), false);
  assert.equal(optionCoversMonthYear('Prior to 2028', 5, 2028), false);
  // These two are inclusive of 2028 and were right by accident. They stay right on purpose.
  assert.equal(optionCoversMonthYear('2028 or earlier', 5, 2028), true);
  assert.equal(optionCoversMonthYear('No later than 2028', 5, 2028), true);
  assert.equal(optionCoversMonthYear('2028 or later', 5, 2028), true);
  // ...and each one still excludes the side it is supposed to exclude.
  assert.equal(optionCoversMonthYear('Before 2029', 5, 2028), true);
  assert.equal(optionCoversMonthYear('After 2027', 5, 2028), true);
  assert.equal(optionCoversMonthYear('2027 or earlier', 5, 2028), false);
  assert.equal(optionCoversMonthYear('2029 or later', 5, 2028), false);
  // A month-precision boundary is read at month precision, not rounded to the year.
  assert.equal(optionCoversMonthYear('Before June 2028', 5, 2028), true);
  assert.equal(optionCoversMonthYear('Before May 2028', 5, 2028), false);
  assert.equal(optionCoversMonthYear('After May 2028', 5, 2028), false);
  // A written range states both of its ends, so a stray qualifier word cannot reopen one.
  assert.equal(optionCoversMonthYear('From January 2027 through December 2027', 5, 2028), false);
  // Winter is December, January and February. Collapsing it to min-to-max swallowed the year.
  assert.equal(optionCoversMonthYear('Winter 2028', 5, 2028), false);
  assert.equal(optionCoversMonthYear('Winter 2028', 1, 2028), true);
  assert.equal(optionCoversMonthYear('Winter 2028', 12, 2028), true);
});

/* The same defect at the level the applicant actually feels it. chooseClosestOption took the FIRST
 * covering option in DOM order, and a graduation select routinely opens with a catch-all:
 *
 *   options: ['Before 2028','January 2028 - June 2028','July 2028 - December 2028','After 2028']
 *   -> 'Before 2028', matchedOption: true
 *
 * She graduates in May 2028 and the form said she had already graduated before 2028, reported with
 * confidence. The narrowest covering bucket wins now, wherever it sits in the list. */
test('the narrowest covering graduation bucket wins, not the first one listed', () => {
  const range = resolveProfileField(
    {
      label: 'When is your anticipated graduation date - please select a Graduation Date range',
      options: ['Before 2028', 'January 2028 - June 2028', 'July 2028 - December 2028', 'After 2028'],
    },
    STORED_PROFILE,
  );
  assert.equal(range?.value, 'January 2028 - June 2028');
  assert.equal(range?.matchedOption, true);

  // A catch-all that genuinely does cover her still loses to anything more specific.
  assert.equal(
    chooseClosestOption(['May 2028'], ['2028 or earlier', 'January 2028 - June 2028']),
    'January 2028 - June 2028',
  );
  assert.equal(chooseClosestOption(['May 2028'], ['2028 or earlier', 'Spring 2028']), 'Spring 2028');
  assert.equal(chooseClosestOption(['May 2028'], ['2028 or earlier', '2028']), '2028');
  // And when the catch-all is the only thing that covers her, it is the honest answer.
  assert.equal(chooseClosestOption(['May 2028'], ['2027 or earlier', '2028 or later']), '2028 or later');
  // Nothing covers May 2028, so nothing is selected.
  assert.equal(chooseClosestOption(['May 2028'], ['Before 2028', 'After 2028']), null);
});

test('the alias ladders are derived from the stored value, never from an employer name', () => {
  assert.deepEqual(
    schoolAliasLadder('University of Southern California, Viterbi School of Engineering'),
    [
      'University of Southern California, Viterbi School of Engineering',
      'University of Southern California',
      'USC',
    ],
  );
  assert.deepEqual(
    educationLevelLadder('Bachelor of Science in Computer Science').slice(0, 4),
    ["Bachelor's Degree", "Bachelor's", 'Bachelor of Science', 'Undergraduate Degree'],
  );
  assert.deepEqual(
    educationLevelLadder('Master of Science in Statistics').slice(0, 3),
    ["Master's Degree", "Master's", 'Graduate Degree'],
  );
  assert.deepEqual(
    disciplineLadder('Computer Science & Business Administration, Finance Emphasis').slice(0, 3),
    ['Computer Science', 'Business Administration', 'Finance'],
  );
});

test('resolveProfileField reports whether the value came from the real option list', () => {
  const withOptions = resolveProfileField(
    { label: 'Graduation Month', options: ['January', 'May', 'December'] },
    STORED_PROFILE,
  );
  assert.equal(withOptions?.matchedOption, true);
  assert.equal(withOptions?.value, 'May');

  const withoutOptions = resolveProfileField({ label: 'Graduation Month' }, STORED_PROFILE);
  assert.equal(withoutOptions?.matchedOption, false);
  assert.equal(withoutOptions?.value, 'May');
  // The ladder is still there for a fill layer that cannot see the options, which is every
  // react-select: its menu does not exist until it is opened.
  assert.deepEqual(withoutOptions?.candidates, ['May', '05', '5']);
});

test('resolveProfileField never answers a question the resolver refuses', () => {
  // SSN and consent are owned by resolveKnownAnswer and stay refused or handed to the human.
  assert.equal(resolveProfileField({ label: 'Social Security Number' }, STORED_PROFILE), null);
  assert.equal(resolveProfileField({ label: '' }, STORED_PROFILE), null);
  assert.equal(
    resolveProfileField({ label: 'What is your current immigration status?' }, STORED_PROFILE),
    null,
  );
});

/* ─── PR #361's snapping, now that the managed path can actually supply an option list ────────
 *
 * The verbatim discovered label and the real Greenhouse discipline taxonomy, both read on
 * 2026-08-08: the label off the Anduril run's discovery pass, the options off the live listbox.
 */
test('the stored major snaps onto the Greenhouse discipline taxonomy', () => {
  const options = [
    'Accounting',
    'Actuarial/Risk Analysis',
    'Business Administration',
    'Computer Science',
    'Computer/Software Engineering',
    'Finance',
    'Mathematics',
  ];
  const ap: ApplicationProfileLike = {
    major: 'Computer Science & Business Administration, Finance Emphasis',
    degree: 'Bachelor of Science in Computer Science',
  };
  const snapped = resolveProfileField({ label: 'discipline', inputType: 'text', options }, ap);
  assert.equal(snapped?.value, 'Computer Science');
  assert.equal(snapped?.matchedOption, true);

  // And the reason it never fired in production: the managed provider reports no options at all,
  // so the same call with none returns the stored sentence, which is not on that list.
  const unprobed = resolveProfileField({ label: 'discipline', inputType: 'text' }, ap);
  assert.equal(unprobed?.matchedOption, false);
  assert.equal(unprobed?.value, 'Computer Science & Business Administration, Finance Emphasis');
});

test('the referral answer snaps onto an employer-named referral list', () => {
  // Verbatim from the Anduril form: the question names the employer, and the option list is the
  // one the control actually offers.
  const ap: ApplicationProfileLike = { referral_source_default: 'Company website' };
  const snapped = resolveProfileField(
    {
      label: 'how did you hear about anduril?',
      inputType: 'text',
      options: ['Select...', 'LinkedIn', 'Company Website', 'Employee Referral', 'Other'],
    },
    ap,
  );
  assert.equal(snapped?.value, 'Company Website');
  assert.equal(snapped?.matchedOption, true);
});
