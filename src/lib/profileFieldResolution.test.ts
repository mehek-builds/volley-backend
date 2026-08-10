import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRequiredBlocker } from './fieldLabel';
import {
  chooseClosestOption,
  candidateTermInterval,
  chooseEeoOption,
  disciplineLadder,
  educationLevelLadder,
  eeoAnswerLadder,
  eeoFederalRaceCategory,
  isDeclineToState,
  optionCoversMonthYear,
  parseNumericRange,
  profileAnswerAliases,
  profileBackedBlockerLabels,
  referralSourceLadder,
  resolveProfileField,
  schoolAliasLadder,
  selfIdentificationDeclineWording,
  usableOptions,
} from './profileFieldResolution';
import type { ApplicationProfileLike } from './questionDiscovery';
import { employerOwnSiteOption } from './referralSource';

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
  work_eligibility_by_country: [{
    country_code: 'US', authorized_now: true, needs_sponsorship_now: false, needs_sponsorship_future: true,
  }],
};

// The same person as parsed from the resume, where `major` is the full sentence rather than the
// tidied application_profile value. This is the harder input and it must resolve identically.
const PARSED_PROFILE: ApplicationProfileLike = {
  ...STORED_PROFILE,
  major: 'Computer Science & Business Administration, Finance Emphasis',
};

const EMPLOYER_SITE_EVIDENCE: ApplicationProfileLike['referral_source_evidence'] = {
  kind: 'employer_career_site',
  value: 'Company website',
  jobId: '11111111-1111-4111-8111-111111111111',
  sourceId: '22222222-2222-4222-8222-222222222222',
  sourceUrl: 'https://careers.example.com/jobs/123',
  observedAt: '2026-08-09T00:00:00.000Z',
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
  /* A YEAR QUESTION WITH NO OPTION LIST NOW ANSWERS "May 2028", and that is deliberate.
   *
   * Prod packet 59fb48ae (Deepgram on Ashby, 2026-08-09): "Expected Graduation Year" is a
   * react-datepicker at day precision. A bare "2028" fills nothing, because tabbing off a typed
   * year commits 01/01/2028 - four months before a May graduation - so the runner refuses it. The
   * same control takes "May 2028" and commits 05/01/2028. Nothing here can tell a datepicker from a
   * text box: the managed provider reports inputType "text" for every discovered control.
   *
   * The month is never invented. It comes from grad_date, and a profile holding only a year still
   * answers with only that year (asserted below). */
  assert.equal(answer('Graduation Year'), 'May 2028');
  assert.equal(answer('What is your expected graduation year?'), 'May 2028');

  // ONLY A YEAR ON FILE MEANS ONLY A YEAR IN THE ANSWER. graduationDateAnswer defaults an absent
  // month to '05' so a native date input gets a complete day; that default must never reach an
  // answer, and this is the assertion that keeps it out.
  const yearOnly = { ...STORED_PROFILE, grad_date: '2028' };
  assert.equal(answer('Graduation Year', undefined, yearOnly), '2028');
  assert.equal(answer('Graduation Year', undefined, { ...STORED_PROFILE, grad_date: undefined }), '2028');
  // grad_date and grad_year disagreeing is two facts, not one with extra precision. The year they
  // agree on is the whole answer.
  assert.equal(answer('Graduation Year', undefined, { ...STORED_PROFILE, grad_date: 'May 2027' }), '2028');

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

/* R-118. The last blocker standing between this account and its first real submission.
 *
 * Prod packet 59fb48ae-382c-4157-9b3d-d4c12883cc62 (Deepgram, Ashby) had every other field filled
 * and passed every acceptance check on one sentence:
 *
 *   "Expected Graduation Year" is required and is still empty
 *
 * The control is a react-datepicker at DAY precision. Measured live against the posting: "2028"
 * fills nothing (the runner refuses it, because tabbing off a typed year commits 01/01/2028, four
 * months adrift of a May graduation), "May 2028" commits 05/01/2028 and the gate clears. The stored
 * question row carried "2028" and was re-resolved from the profile on every run, so no dashboard
 * edit could survive; the fix has to be in the resolver.
 *
 * The whole of the risk is in the second half of this test: a year select must keep getting a year.
 */
test('R-118: a graduation year answers with the month the profile states, and a year list still gets the year', () => {
  const label = 'Expected Graduation Year';

  // What packet 59fb48ae will now carry. `question` and `portal_selector` unchanged; only `answer`.
  assert.equal(answer(label), 'May 2028');
  assert.equal(answer('expected graduation year'), 'May 2028');

  // ...and the ladder that keeps it free. The bare year is on it, so an option list still reaches it.
  const resolved = resolveProfileField({ label }, STORED_PROFILE);
  assert.ok(resolved);
  assert.equal(resolved.candidates[0], 'May 2028');
  assert.ok(resolved.candidates.includes('2028'), `bare year missing from ${JSON.stringify(resolved.candidates)}`);
  assert.equal(resolved.matchedOption, false);

  // A YEAR SELECT IS UNTOUCHED. chooseClosestOption runs its exact pass over every candidate before
  // any inexact stage, so "2028" is found however far down the ladder it sits.
  assert.equal(answer(label, ['2026', '2027', '2028', '2029']), '2028');
  assert.equal(answer(label, ['Select...', '2028', '2029']), '2028');
  assert.equal(answer('Graduation Year', ['2026', '2027', '2028', '2029']), '2028');
  // A term list is a real graduation-year control too, and the month is what makes it answerable.
  assert.equal(answer(label, ['Spring 2028', 'Fall 2028']), 'Spring 2028');

  // A control that cannot physically hold a month name gets the year. This only fires where the
  // input type is REAL: the managed provider reports "text" for everything, so nothing on that path
  // depends on it.
  assert.equal(
    resolveProfileField({ label, inputType: 'number' }, STORED_PROFILE)?.value,
    '2028',
  );

  // And the collapse: no month on file, no month in the answer, on every shape.
  const yearOnly: ApplicationProfileLike = { ...STORED_PROFILE, grad_date: '2028' };
  assert.equal(answer(label, undefined, yearOnly), '2028');
  assert.equal(answer(label, ['2026', '2027', '2028'], yearOnly), '2028');
  assert.deepEqual(resolveProfileField({ label }, yearOnly)?.candidates, ['2028']);
});

test('Class A: how did you hear about this job requires packet-specific evidence', () => {
  const evidenced = { ...STORED_PROFILE, referral_source_evidence: EMPLOYER_SITE_EVIDENCE };
  assert.equal(answer('How did you hear about this job?'), null);
  assert.equal(answer('How did you first hear about Five Rings?'), null);
  assert.equal(answer('How did you hear about this internship?'), null);

  assert.equal(
    answer('How did you hear about this job?', ['LinkedIn', 'Company Website', 'Job Board', 'Other'], evidenced),
    'Company Website',
  );
  assert.equal(
    answer('How did you first hear about Five Rings?', ['University event', 'Careers Page', 'Referral'], evidenced),
    'Careers Page',
  );
  // No same-channel option means review, never a generic value that can overwrite the truth.
  assert.equal(
    answer('How did you hear about this internship?', ['LinkedIn', 'Employee referral', 'Other'], evidenced),
    null,
  );
});

test('Class A: visa sponsorship comes from the stored boolean (Akuna x7, Virtu)', () => {
  const label = 'Do you now, or will you in the future, require visa sponsorship to continue working in the United States (e.g. H-1B, TN,';
  assert.equal(answer(label), 'Yes');
  assert.equal(answer(label, ['Yes', 'No']), 'Yes');
  /* Virtu's real label, cut at the 120-character review limit, which is where the country it names
   * gets cut off. It answers again: "yes, I need sponsorship" discloses a need rather than claiming
   * a permission, so it does not depend on the employer having spelled out the country. Expecting
   * null here for one day was the regression, not the rule; a truncation must not be able to delete
   * a stored answer. */
  assert.equal(
    answer('Do you now, or will you in the future, need sponsorship from an employer in order to obtain, extend or renew your author', ['Yes', 'No']),
    null,
  );
  assert.equal(
    answer('Do you now, or will you in the future, need sponsorship from an employer to work in the United States?', ['Yes', 'No']),
    'Yes',
  );
  assert.equal(answer(label, ['Yes', 'No'], {
    ...STORED_PROFILE,
    needs_sponsorship: false,
    work_eligibility_by_country: [{
      country_code: 'US', authorized_now: true, needs_sponsorship_now: false, needs_sponsorship_future: false,
    }],
  }), 'No');
  // The claim direction still needs the country. "No, I need no sponsorship" asserts eligibility,
  // and the truncated label no longer says where.
  assert.equal(
    answer(
      'Do you now, or will you in the future, need sponsorship from an employer in order to obtain, extend or renew your author',
      ['Yes', 'No'],
      {
        ...STORED_PROFILE,
        needs_sponsorship: false,
        work_eligibility_by_country: [{
          country_code: 'US', authorized_now: true, needs_sponsorship_now: false, needs_sponsorship_future: false,
        }],
      },
    ),
    null,
  );
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

/* Every candidate is the same acquisition fact. A generic fallback can overwrite an earlier exact
 * managed selection, so a closed list with no same-channel option returns for review. */
test('a referral source never claims a channel the applicant did not use', () => {
  assert.equal(
    answer('How did you hear about this job?', ['LinkedIn', 'Job Board', 'Employee referral', 'Other']),
    null,
  );
  assert.deepEqual(referralSourceLadder('Company website'), []);
  assert.equal(referralSourceLadder('Company website').includes('Job Board'), false);
  // A user-declared source gets only its exact channel, and no invented alternative.
  assert.deepEqual(referralSourceLadder('LinkedIn'), ['LinkedIn']);
  assert.equal(
    chooseClosestOption(referralSourceLadder('LinkedIn'), ['Company Website', 'Job Board', 'Other']),
    null,
  );
  // The truthful specific option is still selected whenever it is on the list.
  assert.equal(
    answer(
      'How did you hear about this job?',
      ['LinkedIn', 'Company Website', 'Job Board', 'Other'],
      { ...STORED_PROFILE, referral_source_evidence: EMPLOYER_SITE_EVIDENCE },
    ),
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
  const ap: ApplicationProfileLike = {
    referral_source_default: 'Company website',
    referral_source_evidence: EMPLOYER_SITE_EVIDENCE,
  };
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

/* ─── EEO self-identification ───────────────────────────────────────────────────────────────────
 *
 * The stored preferences are the account's REAL eeo_prefs, read from prod on 2026-08-09 (user
 * a18f774b-a306-4804-93f3-cd6020c27fb3), and the two option lists are the ONLY option vocabularies
 * the corpus has ever recorded. Both are read verbatim out of stored question labels, where managed
 * discovery concatenated the select's option text into the label blob:
 *
 *   "veteran statusselect ...i identify as one or more of the classifications of protected veteran
 *    listed abovei am not a protected veterani decline to self-identify for protected veteran
 *    status eeo[veteran]"
 *   "disability statusselect ...yes, i have a disability, or have had one in the pastno, i do not
 *    have a disability and have not had one in the pasti do not want to answer eeo[disability]"
 *
 * Both came back unmatched on the measured Skydio run, and both are answered by an option that was
 * sitting on the list the whole time.
 */
const STORED_EEO: ApplicationProfileLike = {
  eeo_prefs: {
    race: 'South Asian',
    gender: 'Female',
    veteran_status: 'Decline to self-identify',
    disability_status: 'Decline to self-identify',
    sexual_orientation: 'Heterosexual',
    transgender_status: 'Decline to self-identify',
  },
};

const MEASURED_VETERAN_OPTIONS = [
  'Select ...',
  'I identify as one or more of the classifications of protected veteran listed above',
  'I am not a protected veteran',
  'I decline to self-identify for protected veteran status',
];

const MEASURED_DISABILITY_OPTIONS = [
  'Select ...',
  'Yes, I have a disability, or have had one in the past',
  'No, I do not have a disability and have not had one in the past',
  'I do not want to answer',
];

// The federal self-identification enum. NOT from the corpus, which stores no race option list at
// all, and labelled as such so nobody later mistakes it for a measurement.
const FEDERAL_RACE_OPTIONS = [
  'Hispanic or Latino',
  'White',
  'Black or African American',
  'Native Hawaiian or Other Pacific Islander',
  'Asian',
  'American Indian or Alaska Native',
  'Two or More Races',
  'Decline to self-identify',
];

test('the opt-out is matched by what it means, not by how the employer spelled it', () => {
  const veteran = resolveProfileField(
    { label: 'veteran status veteran_status', inputType: 'text', options: MEASURED_VETERAN_OPTIONS },
    STORED_EEO,
  );
  assert.equal(veteran?.value, 'I decline to self-identify for protected veteran status');
  assert.equal(veteran?.matchedOption, true);

  const disability = resolveProfileField(
    { label: 'disability status disability_status', inputType: 'text', options: MEASURED_DISABILITY_OPTIONS },
    STORED_EEO,
  );
  assert.equal(disability?.value, 'I do not want to answer');
  assert.equal(disability?.matchedOption, true);
});

test('the veteran opt-out is not read as an extension that changes the claim', () => {
  // The precise mechanism of the measured failure. CLOSED_SET_ANSWER_RE lists "decline to self
  // identify" among the answers whose whole meaning is the phrase itself, so the generic matcher
  // saw "... for protected veteran status" as words that alter the claim and refused the option.
  // That refusal is correct for "Yes" against a sponsorship sentence and wrong for a decline: the
  // remainder names the question being declined rather than asserting anything.
  assert.equal(chooseClosestOption(['Decline to self-identify'], MEASURED_VETERAN_OPTIONS), null);
  assert.equal(
    chooseEeoOption('veteran status', 'Decline to self-identify', MEASURED_VETERAN_OPTIONS),
    'I decline to self-identify for protected veteran status',
  );
  // And the rule it must not weaken for anyone else.
  assert.equal(
    chooseClosestOption(['Yes'], ['Yes - I am authorized to work in the US for any employer', 'No']),
    null,
  );
});

test('a stored race widens to the federal category that already contains it', () => {
  const race = resolveProfileField(
    { label: 'how would you describe your racial/ethnic background?', inputType: 'text', options: FEDERAL_RACE_OPTIONS },
    STORED_EEO,
  );
  assert.equal(race?.value, 'Asian');
  assert.equal(race?.matchedOption, true);
  // Her own words stay at the head of the ladder, so a free-text control still gets what she wrote
  // and a list carrying her own wording matches it before anything coarser.
  assert.equal(eeoAnswerLadder('race', 'South Asian')[0], 'South Asian');
  assert.equal(
    chooseEeoOption('race', 'South Asian', ['South Asian', 'East Asian', 'Asian', 'Decline to self-identify']),
    'South Asian',
  );
});

test('only a clean containment widens, and everything else declines instead of guessing', () => {
  // No decline option on this list, so a refusal to map shows up as no match at all rather than as
  // the opt-out standing in for one.
  const noOptOut = ['Hispanic or Latino', 'White', 'Black or African American', 'Asian', 'Two or More Races'];
  assert.equal(eeoFederalRaceCategory('South Asian'), 'Asian');
  // Central Asia is not named by the federal definition of Asian.
  assert.equal(eeoFederalRaceCategory('Central Asian'), undefined);
  assert.equal(chooseEeoOption('race', 'Central Asian', noOptOut), null);
  // Spans two categories, so either choice narrows her answer.
  assert.equal(eeoFederalRaceCategory('Asian/Pacific Islander'), undefined);
  // Ambiguous between Asian Indian and American Indian.
  assert.equal(eeoFederalRaceCategory('Indian'), undefined);
  assert.equal(chooseEeoOption('race', 'Indian', noOptOut), null);
  // The enum files these under White. A contested reassignment is not a coarser word.
  assert.equal(eeoFederalRaceCategory('Middle Eastern'), undefined);
  assert.equal(eeoFederalRaceCategory('North African'), undefined);
  // Widening only. A stored category against a finer list invents detail she never gave.
  assert.equal(chooseEeoOption('race', 'Asian', ['South Asian', 'East Asian', 'Southeast Asian']), null);
});

test('the opt-out never displaces an answer the list can actually hold', () => {
  const gender = resolveProfileField(
    { label: 'gender', inputType: 'text', options: ['Male', 'Female', 'Non-binary', "I don't wish to answer"] },
    STORED_EEO,
  );
  assert.equal(gender?.value, 'Female');
  assert.equal(gender?.matchedOption, true);
  // And where the list has no word for what she said, the opt-out answers rather than the control
  // being left blank: it states nothing untrue about her, and it is the entry the employer put on
  // its own list for exactly this case.
  const orientation = resolveProfileField(
    {
      label: 'how would you describe your sexual orientation? (mark all that apply)',
      inputType: 'text',
      options: ['Gay', 'Lesbian', 'Bisexual', 'Queer', 'I prefer not to say'],
    },
    STORED_EEO,
  );
  assert.equal(orientation?.value, 'I prefer not to say');
  assert.equal(orientation?.matchedOption, true);
});

test('two opt-outs are resolved by a fixed order of wordings, never by DOM order', () => {
  // A list carrying two refusals is answered by whichever one the ladder names first, because that
  // is a decision Litos made once, in source, rather than a guess about which row the employer
  // happened to render first.
  assert.equal(
    chooseEeoOption('race', 'South Asian', ['I prefer not to say', 'Decline to self-identify', 'White']),
    'Decline to self-identify',
  );
  assert.equal(
    chooseEeoOption('race', 'South Asian', ['Decline to self-identify', 'I prefer not to say', 'White']),
    'Decline to self-identify',
  );
  // And when two refusals are worded in ways the ladder does not name, there is nothing to rank
  // them by, so it refuses rather than picking whichever came first out of the DOM.
  assert.equal(
    chooseEeoOption('race', 'South Asian', ['White', 'I would rather not disclose this', 'Choose not to say']),
    null,
  );
});

test('an affirmative option is never read as a refusal to state', () => {
  for (const option of [...MEASURED_VETERAN_OPTIONS, ...MEASURED_DISABILITY_OPTIONS].slice(0, -1)) {
    if (/^select/i.test(option)) continue;
    if (/decline|do not want to answer/i.test(option)) continue;
    assert.equal(isDeclineToState(option), false, `read as a decline: ${option}`);
  }
  assert.equal(isDeclineToState('No, I do not have a disability and have not had one in the past'), false);
  assert.equal(isDeclineToState('I am not a protected veteran'), false);
  assert.equal(isDeclineToState('I identify as one or more of the classifications of protected veteran listed above'), false);
  assert.equal(isDeclineToState('I do not want to answer'), true);
  assert.equal(isDeclineToState('I decline to self-identify for protected veteran status'), true);
  assert.equal(isDeclineToState("I don't wish to answer"), true);
  assert.equal(isDeclineToState('Prefer not to say'), true);
  assert.equal(isDeclineToState('Choose not to disclose'), true);
});

test('the opt-out stands in on self-identification questions and nowhere else', () => {
  // A discipline list that happens to carry a "prefer not to say" row must not absorb a major that
  // is not on it: outside the self-identification block a refusal is not an available answer, and
  // the field being left for the applicant is the correct outcome.
  const discipline = resolveProfileField(
    { label: 'discipline', inputType: 'text', options: ['Accounting', 'Finance', 'Prefer not to say'] },
    { major: 'Computer Science' },
  );
  assert.equal(discipline?.matchedOption, false);
  assert.equal(discipline?.value, 'Computer Science');
});

/* THE MEASURED HISPANIC/LATINO FAILURE, and it was the largest single one in the corpus.
 *
 * Across the prod packets for the owner account on 2026-08-09, twenty packets over eight employers
 * (Together AI, Anduril, Flow Traders, DRW, Scale AI, DV Trading, Astranis, Cloudflare) came back
 * with `no option matched "Decline to self-identify", left for you to choose` on the question
 * discovered as "are you hispanic/latino? hispanic_ethnicity".
 *
 * Its option list is the board's own, read on 2026-08-09 from the published English strings behind
 * eeoc.questions.hispanic_ethnicity, and is identical for every customer. The stored answer and the
 * option it belongs to are the same refusal separated by one hyphen. */
const BOARD_HISPANIC_OPTIONS = ['Yes', 'No', 'Decline To Self Identify'];
const BOARD_VETERAN_OPTIONS = [
  'I am not a protected veteran',
  'I identify as one or more of the classifications of a protected veteran',
  "I don't wish to answer",
];
const BOARD_DISABILITY_OPTIONS = [
  'Yes, I have a disability, or have had one in the past',
  'No, I do not have a disability and have not had one in the past',
  'I do not want to answer',
];

/** What the managed runner does with a value: case and spacing forgiven, nothing else. */
function runnerWouldMatch(value: string, options: readonly string[]): boolean {
  const want = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return options.some((option) => option.trim().toLowerCase().replace(/\s+/g, ' ') === want);
}

test('a refusal is offered in the spelling the control itself uses, first', () => {
  const label = 'are you hispanic/latino? hispanic_ethnicity';
  const ladder = eeoAnswerLadder(label, 'Decline to self-identify');
  assert.equal(ladder[0], 'Decline To Self Identify');
  // The managed path gets ONE attempt per control, so the head of the ladder is the whole fix.
  assert.equal(runnerWouldMatch(ladder[0], BOARD_HISPANIC_OPTIONS), true);
  assert.equal(chooseEeoOption(label, 'Decline to self-identify', BOARD_HISPANIC_OPTIONS), 'Decline To Self Identify');
  assert.equal(profileAnswerAliases(label, 'Decline to self-identify')[0], 'Decline To Self Identify');
});

test('each self-identification control gets its own vocabulary, not one house spelling', () => {
  assert.equal(selfIdentificationDeclineWording('are you hispanic/latino? hispanic_ethnicity'), 'Decline To Self Identify');
  assert.equal(selfIdentificationDeclineWording('gender'), 'Decline To Self Identify');
  assert.equal(selfIdentificationDeclineWording('race'), 'Decline To Self Identify');
  assert.equal(selfIdentificationDeclineWording('veteran status veteran_status'), "I don't wish to answer");
  assert.equal(selfIdentificationDeclineWording('disability status disability_status'), 'I do not want to answer');
  assert.equal(
    runnerWouldMatch(eeoAnswerLadder('veteran status veteran_status', 'Decline to self-identify')[0], BOARD_VETERAN_OPTIONS),
    true,
  );
  assert.equal(
    runnerWouldMatch(eeoAnswerLadder('disability status disability_status', 'Decline to self-identify')[0], BOARD_DISABILITY_OPTIONS),
    true,
  );
});

test('the employer-authored demographic block keeps her own wording', () => {
  // Those questions are written by the employer, their labels end in a numeric question id rather
  // than a field handle, and their opt-out is worded differently again. Guessing a spelling there
  // would replace a wording that currently lands with one that does not.
  const label = 'how would you describe your racial/ethnic background? (mark all that apply) 4012866007';
  assert.equal(selfIdentificationDeclineWording(label), undefined);
  assert.equal(eeoAnswerLadder(label, "I don't wish to answer")[0], "I don't wish to answer");
});

test('the vocabulary spelling is only ever substituted for another refusal', () => {
  // A stated answer is never displaced by an opt-out, whatever the control's handle is.
  assert.equal(eeoAnswerLadder('race', 'South Asian')[0], 'South Asian');
  assert.equal(eeoAnswerLadder('gender', 'Female')[0], 'Female');
  assert.equal(chooseEeoOption('gender', 'Female', ['Male', 'Female', 'Decline To Self Identify']), 'Female');
});

test('a refusal with nowhere to go is still left for her', () => {
  // Point72, measured: "Have you served in the military?" is a required Yes/No with no opt-out at
  // all, and three packets reported it unmatched. That is the correct outcome. Litos must not
  // answer Yes or No to a question she declined, and there is no third choice to reach for.
  assert.equal(chooseEeoOption('have you served in the military?', 'Decline to self-identify', ['Yes', 'No']), null);
  assert.equal(chooseClosestOption(eeoAnswerLadder('gender', 'Decline to self-identify'), ['Male', 'Female']), null);
});

/* THE TERM THAT COULD NOT REACH ITS OWN BUCKET.
 *
 * Six prod packets across IMC Trading and DV Trading reported
 * `no option matched "Spring 2028", left for you to choose`. Both lists are the same shape and both
 * are read off the live forms on 2026-08-09. Spring 2028 is March, April and May 2028; every one of
 * them is inside "January 2028 - July 2028" and none is inside any other entry, so the answer is
 * arithmetic rather than a guess. */
const DV_GRADUATION_OPTIONS = [
  "I've already graduated",
  'August 2026 - December 2026',
  'January 2027 - July 2027',
  'August 2027 - December 2027',
  'January 2028 - July 2028',
  'August 2028 - December 2028',
  'After January 2029',
];

test('a term reaches the bucket that wholly contains it', () => {
  assert.equal(chooseClosestOption(['Spring 2028'], DV_GRADUATION_OPTIONS), 'January 2028 - July 2028');
  assert.equal(chooseClosestOption(['Fall 2027'], DV_GRADUATION_OPTIONS), 'August 2027 - December 2027');
  // A month still goes through the more precise point stage, unchanged.
  assert.equal(chooseClosestOption(['May 2028'], DV_GRADUATION_OPTIONS), 'January 2028 - July 2028');
});

test('a term that only half fits a bucket is left for her', () => {
  // Summer is June, July and August, and this list splits at the end of July. Two of her three
  // months are in one bucket and the third is in the next, so neither bucket is a true statement
  // about when she finishes and the question goes back to her.
  assert.equal(chooseClosestOption(['Summer 2028'], DV_GRADUATION_OPTIONS), null);
  // Winter straddles the year, so there is no single span that is honestly the term.
  assert.equal(chooseClosestOption(['Winter 2028'], DV_GRADUATION_OPTIONS), null);
  assert.equal(candidateTermInterval('Winter 2028'), null);
  // An option NARROWER than the term invents a month she never stated.
  assert.equal(chooseClosestOption(['Spring 2028'], ['May 2028', 'June 2028', 'December 2028']), null);
  // And a term with no bucket around it at all stays unanswered.
  assert.equal(chooseClosestOption(['Spring 2028'], ['August 2027 - December 2027', 'August 2029 - December 2029']), null);
  // A candidate that names an explicit month is not re-read as a term.
  assert.equal(candidateTermInterval('May 2028'), null);
  assert.equal(candidateTermInterval('Spring semester, May 2028'), null);
});

test('among the buckets that contain a term, the narrowest one wins', () => {
  assert.equal(
    chooseClosestOption(['Spring 2028'], ['2028 or earlier', '2028', 'January 2028 - July 2028']),
    'January 2028 - July 2028',
  );
});

/* THE EMPLOYER'S OWN SITE, UNDER THE EMPLOYER'S OWN NAME FOR IT.
 *
 * "Company website" came back as `no option matched` on fourteen prod packets across six employers,
 * the second most repeated failure in the corpus, and on most of those lists the option stating
 * exactly that fact was sitting there under a name the ladder cannot spell. Every list below was
 * read off the live form on 2026-08-09. */
const ANDURIL_REFERRAL_OPTIONS = [
  'Google job search', 'News coverage of Anduril', 'Friend/know someone at the company',
  'Outreach from an Anduril recruiter', 'BuiltIn', 'Indeed', 'Anduril social media',
  'Anduril YouTube videos', 'Podcast featuring an Anduril leader', 'LinkedIn', 'GitHub',
  'Handshake', 'Glassdoor', 'Simplify', 'Anduril Website', 'University Career Fair',
  'Networking Event', 'Other',
];
const CLOUDFLARE_REFERRAL_OPTIONS = [
  'Grace Hopper Celebration', 'College/University Career Fair or Career Website',
  'Word of mouth from peers, friends, others', 'Cloudflare social media: Twitter, Blog, etc.',
  'Linkedin', 'Google', 'Referral', 'Other conferences or events', 'Other (none of the above)',
];
const FIVE_RINGS_REFERRAL_OPTIONS = [
  'Coffee Chat', 'Conference', 'GitHub', 'Handshake', 'LinkedIn',
  'Student Organization Newsletter or Event', 'University Career Fair / Networking Event',
  'Word of Mouth', 'Information Session', 'Other',
];

test('the employer\'s own site is found under whatever the employer calls it', () => {
  const evidenced = { ...STORED_PROFILE, referral_source_evidence: EMPLOYER_SITE_EVIDENCE };
  assert.equal(answer('How did you hear about Anduril?', ANDURIL_REFERRAL_OPTIONS, evidenced), 'Anduril Website');
  assert.equal(
    answer('How did you hear about this internship?', ['Virtu Careers Site', 'Social Media - LinkedIn', 'Job Posting', 'Career Fair', 'Other'], evidenced),
    'Virtu Careers Site',
  );
  assert.equal(
    answer('How did you hear about DV Trading?', ['LinkedIn', 'DV Recruitment', 'DV Employee', 'DV Website', 'Campus Event', 'Other'], evidenced),
    'DV Website',
  );
  assert.equal(
    answer('How did you hear about this job?', ['DRW Careers Page', 'Employee Referral', 'LinkedIn', 'Newspaper', 'Other'], evidenced),
    'DRW Careers Page',
  );
});

test('somebody else\'s website is never read as the employer\'s own', () => {
  const evidenced = { ...STORED_PROFILE, referral_source_evidence: EMPLOYER_SITE_EVIDENCE };
  // Cloudflare's only entry with the word website in it is a UNIVERSITY career website. Choosing it
  // would tell an employer she came through her school, which is not what happened.
  assert.equal(answer('How did you hear about this job?', CLOUDFLARE_REFERRAL_OPTIONS, evidenced), null);
  assert.equal(employerOwnSiteOption(CLOUDFLARE_REFERRAL_OPTIONS), undefined);
  // And a list with no company-site entry at all stays with her rather than reaching for Other.
  assert.equal(answer('How did you first hear about Five Rings?', FIVE_RINGS_REFERRAL_OPTIONS, evidenced), null);
  assert.equal(employerOwnSiteOption(FIVE_RINGS_REFERRAL_OPTIONS), undefined);
  // Two candidates is an ambiguity, not a choice.
  assert.equal(employerOwnSiteOption(['Acme Website', 'Acme Careers Site', 'LinkedIn']), undefined);
});

test('the site option is only reached when the evidence says she came through the site', () => {
  // No evidence at all: the acquisition channel is unknown, so nothing is claimed about it.
  assert.equal(answer('How did you hear about Anduril?', ANDURIL_REFERRAL_OPTIONS), null);
  assert.equal(
    answer('How did you hear about Anduril?', ANDURIL_REFERRAL_OPTIONS, {
      ...STORED_PROFILE,
      referral_source_evidence: { ...EMPLOYER_SITE_EVIDENCE, kind: 'litos_job_board', value: 'Job board' },
    }),
    null,
  );
});
