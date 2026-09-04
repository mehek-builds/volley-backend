import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseExperienceBand,
  namedProfileSkill,
  readExperienceBand,
  readTenureMonth,
  skillEvidencedIn,
  skillNamedIn,
  skillScopedExperienceMonths,
  totalExperienceMonths,
  type ExperiencePeriod,
} from './experienceTenure';

const asOf = new Date('2026-09-02T00:00:00Z');

test('tenure months read every shape a resume prints and a parser emits', () => {
  assert.equal(readTenureMonth('Feb 2026'), 2026 * 12 + 1);
  assert.equal(readTenureMonth('February 2026'), 2026 * 12 + 1);
  assert.equal(readTenureMonth('Sept. 2024'), 2024 * 12 + 8);
  assert.equal(readTenureMonth('02/2026'), 2026 * 12 + 1);
  assert.equal(readTenureMonth('2026-02'), 2026 * 12 + 1);
  assert.equal(readTenureMonth('2026-02-15'), 2026 * 12 + 1);
  assert.deepEqual(readTenureMonth('2024'), { year: 2024 });
  for (const now of ['Present', 'present', 'Current', 'Now', 'Ongoing', 'to date']) {
    assert.equal(readTenureMonth(now), 'present', now);
  }
  for (const junk of ['', '  ', 'Summer 2025', 'Q3 2025', '13/2026', '2026-13', 'soon']) {
    assert.equal(readTenureMonth(junk), undefined, junk);
  }
});

test('total tenure merges concurrent roles and counts exclusive months', () => {
  // The owner's canon roles: an internship, then two overlapping jobs running to today.
  const periods = [
    { start: 'Feb 2025', end: 'May 2025' },
    { start: 'Sep 2025', end: 'Present' },
    { start: 'Feb 2026', end: 'Present' },
  ];
  // Feb->May 2025 is 3 exclusive months; Sep 2025->Sep 2026 is 12; Feb 2026 sits inside it.
  assert.equal(totalExperienceMonths(periods, asOf), 15);
  // The bank's single date_range column reads the same as start/end, and a duplicate of a role
  // already counted adds nothing.
  assert.equal(totalExperienceMonths([...periods, { date_range: 'Feb 2026 - Present' }], asOf), 15);
  assert.equal(totalExperienceMonths([{ date_range: 'Sep 2025 – Present' }], asOf), 12);
  assert.equal(totalExperienceMonths([{ date_range: 'June 2024 to August 2024' }], asOf), 2);
  // A bare year is the SHORTEST span it can mean (December start, January end), so a same-year
  // bare range contributes nothing rather than twelve months; a future start is a plan, not tenure.
  assert.equal(totalExperienceMonths([{ start: '2024', end: '2024' }], asOf), 0);
  assert.equal(totalExperienceMonths([{ start: 'Jan 2027', end: 'Present' }], asOf), null);
  // A role still running is clipped at today, never extended past it.
  assert.equal(totalExperienceMonths([{ start: 'Aug 2026', end: 'Dec 2026' }], asOf), 1);
});

test('total tenure is null - a refusal - with no dated role or with one it cannot read', () => {
  assert.equal(totalExperienceMonths(undefined, asOf), null);
  assert.equal(totalExperienceMonths([], asOf), null);
  assert.equal(totalExperienceMonths([{ start: '', end: '' }], asOf), null);
  assert.equal(totalExperienceMonths([{}], asOf), null);
  // One unreadable date poisons the whole total rather than silently understating it.
  assert.equal(totalExperienceMonths([{ start: 'Sep 2025', end: 'Present' }, { start: 'Summer 2024', end: 'Present' }], asOf), null);
  assert.equal(totalExperienceMonths([{ start: 'May 2025', end: 'Feb 2025' }], asOf), null);
  assert.equal(totalExperienceMonths([{ date_range: 'Jan 2024 - Feb 2024 - Mar 2024' }], asOf), null);
  // An entry with no date at all is simply not dated; a dated sibling still counts.
  assert.equal(totalExperienceMonths([{}, { start: 'Sep 2025', end: 'Present' }], asOf), 12);
});

test('experience bands read the employer wordings and ignore everything without a figure', () => {
  assert.deepEqual(readExperienceBand('Less than 1 year'), { minMonths: 0, maxMonths: 12, open: false });
  assert.deepEqual(readExperienceBand('under 6 months'), { minMonths: 0, maxMonths: 6, open: false });
  assert.deepEqual(readExperienceBand('1-2 years'), { minMonths: 12, maxMonths: 36, open: false });
  assert.deepEqual(readExperienceBand('1 – 2 years'), { minMonths: 12, maxMonths: 36, open: false });
  assert.deepEqual(readExperienceBand('3 to 5 years'), { minMonths: 36, maxMonths: 72, open: false });
  assert.deepEqual(readExperienceBand('between two and five years'), { minMonths: 24, maxMonths: 72, open: false });
  assert.deepEqual(readExperienceBand('6-12 months'), { minMonths: 6, maxMonths: 12, open: false });
  assert.deepEqual(readExperienceBand('5+ years'), { minMonths: 60, maxMonths: Number.POSITIVE_INFINITY, open: true });
  assert.deepEqual(readExperienceBand('More than 10 years'), { minMonths: 120, maxMonths: Number.POSITIVE_INFINITY, open: true });
  assert.deepEqual(readExperienceBand('3 years or more'), { minMonths: 36, maxMonths: Number.POSITIVE_INFINITY, open: true });
  assert.deepEqual(readExperienceBand('at least 2 years'), { minMonths: 24, maxMonths: Number.POSITIVE_INFINITY, open: true });
  assert.deepEqual(readExperienceBand('2 years'), { minMonths: 24, maxMonths: 36, open: false });
  for (const notABand of ['None', 'No experience', 'Student', 'Entry level', 'Select...', 'Other', '']) {
    assert.equal(readExperienceBand(notABand), null, notABand);
  }
});

test('the chosen band is the one holding the total, trimmed to its neighbour and lowest on overlap', () => {
  const personio = ['Less than 1 year', '1-2 years', '3-5 years', '5-10 years', '10+ years'];
  assert.equal(chooseExperienceBand(personio, 0), 'Less than 1 year');
  assert.equal(chooseExperienceBand(personio, 11), 'Less than 1 year');
  assert.equal(chooseExperienceBand(personio, 12), '1-2 years');
  assert.equal(chooseExperienceBand(personio, 15), '1-2 years');
  // "1-2 years" beside "3-5 years": the whole of year two belongs to the first band.
  assert.equal(chooseExperienceBand(personio, 30), '1-2 years');
  assert.equal(chooseExperienceBand(personio, 36), '3-5 years');
  assert.equal(chooseExperienceBand(personio, 200), '10+ years');
  // "1-2 years" beside "2-5 years": the neighbour's floor is the ceiling, so 2.5 years is "2-5".
  const contiguous = ['0-1 years', '1-2 years', '2-5 years', '5+ years'];
  assert.equal(chooseExperienceBand(contiguous, 30), '2-5 years');
  assert.equal(chooseExperienceBand(contiguous, 23), '1-2 years');
  assert.equal(chooseExperienceBand(contiguous, 60), '5+ years');
  // A gap between bands ("0-1", "2-5") hands the gap year to the LOWER band: the smaller claim.
  assert.equal(chooseExperienceBand(['0-1 years', '2-5 years', '5+ years'], 15), '0-1 years');
  // Non-band options are stepped over, and a value no band holds is null.
  assert.equal(chooseExperienceBand(['Select...', 'None', '1-2 years'], 15), '1-2 years');
  assert.equal(chooseExperienceBand(['None', 'Student'], 15), null);
  assert.equal(chooseExperienceBand(['5+ years'], 15), null);
  assert.equal(chooseExperienceBand(undefined, 15), null);
  // Order of arrival does not change the choice.
  assert.equal(chooseExperienceBand([...personio].reverse(), 15), '1-2 years');
});

test('a bare year is the shortest span it can mean, and an empty end is unknown', () => {
  // Dec 2023 -> Jan 2024, exclusive: one month, never twenty-three.
  assert.equal(totalExperienceMonths([{ start: '2023', end: '2024' }], new Date(Date.UTC(2026, 8, 2))), 1);
  // Dec 2025 -> asOf Sep 2026: nine months, never twenty.
  assert.equal(totalExperienceMonths([{ start: '2025', end: 'Present' }], new Date(Date.UTC(2026, 8, 2))), 9);
  // A start with no end is not "present"; the whole total is unknown.
  assert.equal(totalExperienceMonths([{ start: 'Feb 2025', end: '' }], new Date(Date.UTC(2026, 8, 2))), null);
});

/* ---- the same arithmetic, scoped to one named skill ---- */

/* A skill is named as a WHOLE TERM, and the boundary is what keeps the scope honest. Every case
 * below is a real confusion this matcher has to refuse: a language whose name is a common English
 * word ("React" inside "Reactive"), a name that is a suffix of a bigger product's name ("SQL"
 * inside "PostgreSQL", so a Postgres question is never answered from SQL evidence), and the names
 * `\b` cannot bound at all because they do not end in word characters. */
test('a skill is named only as a whole term, including the names \\b cannot bound', () => {
  assert.equal(skillNamedIn('Built Python data pipelines', 'Python'), true);
  assert.equal(skillNamedIn('built python data pipelines', 'Python'), true);
  assert.equal(skillNamedIn('Shipped an AI  agents platform', 'AI agents'), true);

  assert.equal(skillNamedIn('Reactive systems work', 'React'), false);
  assert.equal(skillNamedIn('Tuned a PostgreSQL warehouse', 'SQL'), false);
  assert.equal(skillNamedIn('Wrote SQL against Postgres', 'SQL'), true);

  assert.equal(skillNamedIn('Wrote firmware in C++', 'C++'), true);
  assert.equal(skillNamedIn('Wrote firmware in C++11', 'C++'), false);
  assert.equal(skillNamedIn('Services on Node.js', 'Node.js'), true);
  assert.equal(skillNamedIn('Services on Nodexjs', 'Node.js'), false);

  /* ONE LETTER IS NOT A SCOPE. "C" and "R" are real languages and also single letters that occur
   * throughout ordinary prose; matching them would be noise carrying the authority of a
   * measurement, so they are refused outright rather than guessed at. */
  assert.equal(skillNamedIn('Wrote firmware in C for a sensor', 'C'), false);
  assert.equal(skillNamedIn('Statistics in R and Python', 'R'), false);
  assert.equal(skillNamedIn('anything at all', ''), false);
  assert.equal(skillNamedIn(undefined, 'Python'), false);
});

test('the scope is read off HER skills list, never parsed out of the sentence', () => {
  const skills = ['Python', 'TypeScript', 'React', 'SQL', 'LangChain', 'AI agents'];
  assert.deepEqual(
    namedProfileSkill('How many years of hands on experience do you have with Python?', skills),
    { skill: 'Python' },
  );
  // A skill she has never listed is not this rule's question at all.
  assert.equal(namedProfileSkill('How many years of experience do you have with Kubernetes?', skills), null);
  assert.equal(namedProfileSkill('How many years of experience do you have?', skills), null);
  assert.equal(namedProfileSkill('Years of experience with Python', undefined), null);

  /* TWO DISTINCT SKILLS IS AMBIGUOUS, NOT AN ANSWER: "Python and SQL" wants the intersection of two
   * spans and "Python or SQL" wants the union, the two read identically to a matcher, and they
   * differ by years. Reported so the caller can hand it back with a reason. */
  const both = namedProfileSkill('Years of experience with Python and SQL?', skills);
  assert.ok(both && 'ambiguous' in both);
  assert.deepEqual(both.ambiguous, ['Python', 'SQL']);

  /* OVERLAPPING MATCHES ARE ONE SKILL, NOT TWO. "React Native" also contains the listed skill
   * "React", and refusing that as ambiguous would be a false refusal; the longest, most specific
   * match wins its span. */
  assert.deepEqual(
    namedProfileSkill('Years of experience with React Native', ['React', 'React Native']),
    { skill: 'React Native' },
  );
});

const EVIDENCED: ExperiencePeriod[] = [
  { start: 'September 2025', end: 'Present', description: 'Built Python data pipelines and a React dashboard.' },
  { start: 'June 2024', end: 'August 2024', description: 'Wrote SQL queries against a Postgres warehouse.' },
];
const scopedAsOf = new Date('2026-09-03T00:00:00Z');

test('skill-scoped months are the SAME arithmetic on a selected subset of roles', () => {
  // Sep 2025 -> Sep 2026 exclusive: 12 months, from the one role whose bullets name Python.
  assert.equal(skillScopedExperienceMonths(EVIDENCED, 'Python', scopedAsOf), 12);
  // Jun -> Aug 2024 exclusive: 2 months, and NOT the 14 the whole resume would give.
  assert.equal(skillScopedExperienceMonths(EVIDENCED, 'SQL', scopedAsOf), 2);
  assert.notEqual(skillScopedExperienceMonths(EVIDENCED, 'SQL', scopedAsOf), totalExperienceMonths(EVIDENCED, scopedAsOf));
  /* THE ROLE TITLE IS NOT EVIDENCE. It was, and it produced false claims: titles are Title Case by
   * convention, so a case-based signal is inverted on that field and "Head of Go To Market" wrote
   * years of Go while "Go To Market Lead" refused, on nothing but word order. The field is gone
   * from ExperiencePeriod entirely, so a title cannot be smuggled back in through the description. */
  /* THE TITLE HERE WOULD PASS THE CONSTRUCTION TEST IF IT WERE READ, which is the only way to pin
   * this. "Go services engineer" puts a tool noun straight after the token, so a resolver that read
   * titles would answer; the assertion is that it does not, because the field is not read at all.
   * A title of "Head of Go To Market" proves nothing here: the construction test refuses that on its
   * own, so the assertion would hold whether titles were read or not. */
  const titled = { start: 'Jan 2024', end: 'Present', description: 'Reported weekly.', title: 'Go services engineer' };
  assert.equal(skillScopedExperienceMonths([titled as ExperiencePeriod], 'Go', scopedAsOf), null);
  // Same role, same dates, with the tool named in the BULLETS: now it counts.
  assert.equal(
    skillScopedExperienceMonths([{ ...titled, description: 'Owned Go services.' } as ExperiencePeriod], 'Go', scopedAsOf),
    32,
  );

  /* NO EVIDENCE IS NULL, AND NULL IS NOT ZERO. "No role of hers mentions LangChain" is Litos having
   * no dated evidence either way; answering zero years would be a claim about her that her own
   * resume does not make. Both refusals below are null for that reason. */
  assert.equal(skillScopedExperienceMonths(EVIDENCED, 'LangChain', scopedAsOf), null);
  assert.notEqual(skillScopedExperienceMonths(EVIDENCED, 'LangChain', scopedAsOf), 0);
  assert.equal(skillScopedExperienceMonths(undefined, 'Python', scopedAsOf), null);
  assert.equal(skillScopedExperienceMonths([], 'Python', scopedAsOf), null);

  // The poison rule is inherited whole: an unreadable date on a MATCHING role loses the total.
  assert.equal(
    skillScopedExperienceMonths([{ start: 'Summer 2025', end: 'Present', description: 'Built Python services.' }], 'Python', scopedAsOf),
    null,
  );
  // An unreadable date on a role the skill does not match cannot poison a scope it is not in.
  assert.equal(
    skillScopedExperienceMonths([...EVIDENCED, { start: 'Summer 2025', end: 'Present', description: 'Wrote Rust services.' }], 'Python', scopedAsOf),
    12,
  );
  // Concurrent roles that both name the skill are one span of time, not two.
  assert.equal(
    skillScopedExperienceMonths(
      [
        { start: 'Jan 2026', end: 'Jul 2026', description: 'Built Python tooling.' },
        { start: 'Mar 2026', end: 'Jul 2026', description: 'Shipped Python jobs.' },
      ],
      'Python',
      scopedAsOf,
    ),
    6,
  );
});

/* AN HOURS BAND IS NOT A BAND THIS FILE CAN READ, and that is deliberate rather than an oversight.
 * These are Apollo Research's three real options (lever, measured 2026-09-03). Nothing here may
 * start parsing them: a span of calendar months becomes a number of hours only by inventing an
 * hours-per-week figure that no profile stores. The refusal is stated once more at the resolver, on
 * the UNIT, so the question is handed back for the true reason rather than for this one. */
test('hours options are not bands, and no arithmetic here pretends otherwise', () => {
  for (const option of ['<100 hours', '100-1000 hours', '>1000 hours', '500+ hours', 'less than 100 hours']) {
    assert.equal(readExperienceBand(option), null, option);
  }
  assert.equal(chooseExperienceBand(['<100 hours', '100-1000 hours', '>1000 hours'], 12), null);
});

/* THE HOMOGRAPH FAMILY, measured: this wrote years of experience with tools never opened.
 *
 * One role, Jan 2024 to present, bulleted "Owned go-to-market strategy. Helped the team excel at
 * reporting. Delivered swift turnarounds.", beside a skills list holding Go, Excel and Swift,
 * answered "how many years of hands on experience do you have with X" with 2-3 years for all three.
 * A skills list is full of ordinary English words and prose is full of them too, so the separation
 * cannot be made on the token. It is made on the OCCURRENCE: her prose has to write the thing as a
 * proper noun, and that capital has to mean something more than sentence position.
 */
test('prose that merely contains a skill\'s letters is not evidence she used it', () => {
  const bullets = 'Owned go-to-market strategy. Helped the team excel at reporting. Delivered swift turnarounds.';
  for (const skill of ['Go', 'Excel', 'Swift']) {
    assert.equal(skillEvidencedIn(bullets, skill), false, skill);
  }
  assert.equal(skillNamedIn('go-to-market plan', 'Go'), false, 'the hyphen boundary alone kills this one');

  // The true cases still read as evidence: a tool introduced the way a resume bullet introduces one.
  assert.equal(skillEvidencedIn('Built a Python backtester.', 'Python'), true);
  assert.equal(skillEvidencedIn('Owned Go services end to end.', 'Go'), true);
  assert.equal(skillEvidencedIn('Rebuilt the dashboard in React.', 'React'), true);
  assert.equal(skillEvidencedIn('Built an Excel model for pricing.', 'Excel'), true);
  assert.equal(skillEvidencedIn('Shipped the Swift client.', 'Swift'), true);

  // Tokens ordinary English cannot produce skip the construction test entirely.
  assert.equal(skillEvidencedIn('SQL tuning across the warehouse.', 'SQL'), true);
  assert.equal(skillEvidencedIn('sql tuning across the warehouse.', 'SQL'), true);
  assert.equal(skillEvidencedIn('C++ firmware for the sensor.', 'C++'), true);
  assert.equal(skillEvidencedIn('TypeScript services on call.', 'TypeScript'), true);
  assert.equal(skillEvidencedIn('AI agents shipped to production.', 'AI agents'), true);

  /* CASING IS NOT THE TEST ANY MORE, IN EITHER DIRECTION. These four were all decided wrongly by the
   * capitalisation rule: the first two are real mentions it refused for using the wrong shift key,
   * and the last two are non-mentions it accepted for using the right one. */
  assert.equal(skillEvidencedIn('built python data pipelines', 'Python'), true);
  assert.equal(skillEvidencedIn('Modelled scenarios in excel', 'Excel'), true);
  assert.equal(skillEvidencedIn('Coached the team to Excel under pressure.', 'Excel'), false);
  assert.equal(skillEvidencedIn('Python powered the pipeline.', 'Python'), false);

  // How she typed her skills list is not the test either; how she wrote the ROLE is.
  assert.equal(skillEvidencedIn('Owned Go services end to end.', 'go'), true);
  assert.equal(skillEvidencedIn('Helped the team go faster.', 'go'), false);
  assert.equal(skillEvidencedIn('Rebuilt it in Python.', 'python'), true);

  /* THE LABEL IS JUDGED CASE-INSENSITIVELY AND MUST STAY THAT WAY. How an employer cases a question
   * is a fact about the employer: Apollo Research's real label writes "python" in lower case. */
  assert.equal(skillNamedIn('...experience do you have in python or a similar coding language?', 'Python'), true);
});

/* EVERY PROPER NOUN THAT IS NOT A TOOL, which is what the capitalisation rule could not tell apart.
 * These eleven are the second review's measured cases, verbatim. Each one wrote a multi-year
 * professional claim end to end before the construction test replaced the capital test. */
test('a company, a person, a place, a season and a job title are not tools', () => {
  const notTools: Array<[string, string]> = [
    ['Supported the Head of Go To Market on EMEA pricing.', 'Go'],
    ['Owned Go To Market Strategy for two launches.', 'Go'],
    ['OWNED GO TO MARKET FOR EMEA', 'Go'],
    ['Managed the Swift Transportation account.', 'Swift'],
    ['Advised Spring Health on their onboarding funnel.', 'Spring'],
    ['Launched the pilot in Spring 2026.', 'Spring'],
    ['Presented at the Rust Belt Manufacturing Summit.', 'Rust'],
    ['Grew the Ruby Tuesday account by 30%.', 'Ruby'],
    ['Reported to Julia Chen, VP of Data.', 'Julia'],
    ['Coached the team to Excel under pressure.', 'Excel'],
    ['Head of Go To Market', 'Go'],
  ];
  for (const [prose, skill] of notTools) {
    assert.equal(skillEvidencedIn(prose, skill), false, `${skill} in "${prose}"`);
  }

  /* THE TWO SHAPES DOING THE WORK, separated so a failure says which one broke. A continuing name is
   * refused even when a build verb introduced it, because the verb cannot make "Go To Market" a
   * language; and a construction is required even when nothing follows. */
  assert.equal(skillEvidencedIn('Built Go To Market collateral.', 'Go'), false);
  assert.equal(skillEvidencedIn('Built Go services.', 'Go'), true);
  assert.equal(skillEvidencedIn('Attended Spring conference.', 'Spring'), false);
  assert.equal(skillEvidencedIn('Wrote Spring services.', 'Spring'), true);

  /* THE ACCEPTED COST, pinned so it is a decision rather than a discovery. All three are refusals of
   * real mentions, and a refusal costs her one click on a list already in front of her. */
  assert.equal(skillEvidencedIn('Built Python Pipelines', 'Python'), false, 'a Title Case bullet reads as a continuing name');
  assert.equal(skillEvidencedIn('Used Python 3 throughout.', 'Python'), false, 'a version number reads like a date');
  assert.equal(skillEvidencedIn('Migrated the platform to Python.', 'Python'), false, '"to" is not a tool introducer');
});

/* escapeForPattern, which had no test and whose absence is not a wrong answer but a 500.
 * `new RegExp('(?<![A-Za-z0-9-])C++(?![A-Za-z0-9-])')` throws "Nothing to repeat", and it would throw
 * inside resolveKnownAnswer, on the resolver hot path, for any applicant whose skills list says C++.
 * Every entry point that builds a pattern is exercised here, so no caller can regress alone. */
test('a skills entry made of regex metacharacters is matched, never executed', () => {
  for (const skill of ['C++', 'C#', 'Node.js', '.NET', 'F#', 'Objective-C++']) {
    assert.doesNotThrow(() => skillNamedIn('experience with things', skill), skill);
    assert.doesNotThrow(() => skillEvidencedIn('Built things.', skill), skill);
    assert.doesNotThrow(() => namedProfileSkill('Years of experience with things', [skill]), skill);
  }
  // And the metacharacters are matched as themselves rather than as syntax.
  assert.equal(skillNamedIn('Wrote firmware in C++', 'C++'), true);
  assert.equal(skillNamedIn('Wrote firmware in CCC', 'C++'), false);
  // The escaped dot is a dot: "Node.js" must not match "NodeXjs" through a wildcard.
  assert.equal(skillNamedIn('Services on NodeXjs', 'Node.js'), false);
  assert.deepEqual(namedProfileSkill('Years of experience with C++', ['C++']), { skill: 'C++' });
});

/* The band chooser's own rule, pinned because its docstring used to overclaim it. "Lower wins"
 * holds among bands SHARING a floor; across distinct floors the ceiling trim decides, and both
 * outcomes are true statements because a band is only returned when the total reaches its floor. */
test('the band choice is settled by the ceiling trim, and never by a floor she has not reached', () => {
  // Shared floor: the narrower, smaller claim wins.
  assert.equal(chooseExperienceBand(['1-5 years', '1-2 years'], 12), '1-2 years');
  // Distinct floors with genuine overlap: the trim hands 30 months to the higher floor below it.
  assert.equal(chooseExperienceBand(['1-3 years', '2-5 years'], 30), '2-5 years');
  // Which is still a floor she has reached. Nothing here can return a band she is below.
  assert.equal(chooseExperienceBand(['1-3 years', '2-5 years'], 23), '1-3 years');
  assert.equal(chooseExperienceBand(['2-5 years', '5+ years'], 12), null);
});
