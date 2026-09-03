import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseExperienceBand,
  namedProfileSkill,
  readExperienceBand,
  readTenureMonth,
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
  {
    start: 'September 2025',
    end: 'Present',
    title: 'Software Engineer Intern',
    description: 'Built Python data pipelines and a React dashboard.',
  },
  {
    start: 'June 2024',
    end: 'August 2024',
    title: 'Data Research Assistant',
    description: 'Wrote SQL queries against a Postgres warehouse.',
  },
];
const scopedAsOf = new Date('2026-09-03T00:00:00Z');

test('skill-scoped months are the SAME arithmetic on a selected subset of roles', () => {
  // Sep 2025 -> Sep 2026 exclusive: 12 months, from the one role whose bullets name Python.
  assert.equal(skillScopedExperienceMonths(EVIDENCED, 'Python', scopedAsOf), 12);
  // Jun -> Aug 2024 exclusive: 2 months, and NOT the 14 the whole resume would give.
  assert.equal(skillScopedExperienceMonths(EVIDENCED, 'SQL', scopedAsOf), 2);
  assert.notEqual(skillScopedExperienceMonths(EVIDENCED, 'SQL', scopedAsOf), totalExperienceMonths(EVIDENCED, scopedAsOf));
  // A title is evidence as well as a bullet.
  assert.equal(skillScopedExperienceMonths(EVIDENCED, 'Data Research', scopedAsOf), 2);

  /* NO EVIDENCE IS NULL, AND NULL IS NOT ZERO. "No role of hers mentions LangChain" is Litos having
   * no dated evidence either way; answering zero years would be a claim about her that her own
   * resume does not make. Both refusals below are null for that reason. */
  assert.equal(skillScopedExperienceMonths(EVIDENCED, 'LangChain', scopedAsOf), null);
  assert.notEqual(skillScopedExperienceMonths(EVIDENCED, 'LangChain', scopedAsOf), 0);
  assert.equal(skillScopedExperienceMonths(undefined, 'Python', scopedAsOf), null);
  assert.equal(skillScopedExperienceMonths([], 'Python', scopedAsOf), null);

  // The poison rule is inherited whole: an unreadable date on a MATCHING role loses the total.
  assert.equal(
    skillScopedExperienceMonths([{ start: 'Summer 2025', end: 'Present', description: 'Python' }], 'Python', scopedAsOf),
    null,
  );
  // An unreadable date on a role the skill does not match cannot poison a scope it is not in.
  assert.equal(
    skillScopedExperienceMonths([...EVIDENCED, { start: 'Summer 2025', end: 'Present', description: 'Rust' }], 'Python', scopedAsOf),
    12,
  );
  // Concurrent roles that both name the skill are one span of time, not two.
  assert.equal(
    skillScopedExperienceMonths(
      [
        { start: 'Jan 2026', end: 'Jul 2026', description: 'Python' },
        { start: 'Mar 2026', end: 'Jul 2026', description: 'Python' },
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
