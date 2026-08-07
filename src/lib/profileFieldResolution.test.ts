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
  resolveProfileField,
  schoolAliasLadder,
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
  // Every academic fact and the sponsorship boolean drop out, which proves the guard is reading
  // the profile rather than the label list. Referral source stays, because resolveKnownAnswer
  // answers it with "Company website" for an account that has set no default, and that is a
  // deliberate product behaviour rather than stored data.
  assert.deepEqual(profileBackedBlockerLabels(blockers, {}), [
    'How did you hear about this job?',
    'How did you first hear about Five Rings?',
    'How did you hear about this internship?',
  ]);
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
