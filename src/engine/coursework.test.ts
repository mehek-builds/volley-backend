import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { courseworkIsUngrounded, excerpt, startsWithStrongVerb } from './resumeValidate';
import { stripEmDashes } from './resumePolicy';

/* The case that started this: a UW sample CV listed "Race, Gender, and Sexuality in the Media".
 * The old check split the rendered line on "," and reported a verbatim-copied coursework line as
 * containing a fabricated course. */

describe('courseworkIsUngrounded', () => {
  const uw = [
    'Psychology of Gender',
    'Women and the Law',
    'Feminist Understanding of Victims',
    'Women and Violence',
    'Self-Concept',
    'Race, Gender, and Sexuality in the Media',
  ];

  test('a course whose own title contains commas is not a fabrication', () => {
    assert.equal(courseworkIsUngrounded(uw.join(', '), uw), false);
  });

  test('a course the resume never printed is still caught', () => {
    assert.equal(courseworkIsUngrounded('Psychology of Gender, Quantum Field Theory', uw), true);
  });

  test('a fabricated course hiding beside a comma-containing one is still caught', () => {
    assert.equal(
      courseworkIsUngrounded('Race, Gender, and Sexuality in the Media, Advanced Wizardry', uw),
      true,
    );
  });

  test('a subset of the printed courses is fine', () => {
    assert.equal(courseworkIsUngrounded('Women and Violence, Self-Concept', uw), false);
  });

  test('the longest allowed title wins when one is a prefix of another', () => {
    const allowed = ['Data Structures', 'Data Structures and Algorithms'];
    assert.equal(courseworkIsUngrounded('Data Structures and Algorithms', allowed), false);
    assert.equal(courseworkIsUngrounded('Data Structures', allowed), false);
    assert.equal(courseworkIsUngrounded('Data Structures and Wizardry', allowed), true);
  });

  test('an empty coursework line claims nothing', () => {
    assert.equal(courseworkIsUngrounded('', uw), false);
    assert.equal(courseworkIsUngrounded('   ', uw), false);
    assert.equal(courseworkIsUngrounded('', undefined), false);
  });

  test('any coursework at all is ungrounded when the resume listed none', () => {
    assert.equal(courseworkIsUngrounded('Psychology of Gender', []), true);
    assert.equal(courseworkIsUngrounded('Psychology of Gender', undefined), true);
  });

  test('the separator may vary without becoming a fabrication', () => {
    assert.equal(courseworkIsUngrounded('Women and Violence,Self-Concept', uw), false);
    assert.equal(courseworkIsUngrounded('  Women and Violence ,  Self-Concept  ', uw), false);
  });
});

/* The verb gate must stay a gate. These pin both halves: the synonyms it wrongly rejected on a
 * 15-resume run, and the weak verbs it must keep rejecting. */
describe('the strong-verb gate', () => {
  const admitted = [
    // Each is a synonym of a verb the list already had, named in resumeValidate.ts.
    'Performed column chromatography, PCR, and DNA extraction.',
    'Operated the mass spectrometer across three studies.',
    'Assessed 40 applications against the rubric.',
    'Simulated airflow over the revised wing profile.',
    'Prototyped the fixture in three iterations.',
    'Fabricated the mounting bracket from sheet aluminium.',
    'Programmed the flight controller in C.',
    'Debugged the race condition in the scheduler.',
    'Recorded field data using tablets with Fulcrum.',
    'Compiled the quarterly species count into one report.',
    'Wrote the onboarding guide for incoming volunteers.',
    'Reviewed 200 grant applications against the funding rubric.',
    'Estimated the load case for the revised bracket.',
    'Soldered the sensor harness for the test rig.',
  ];
  for (const bullet of admitted) {
    test(`accepts ${bullet.split(' ')[0]}`, () => {
      assert.equal(startsWithStrongVerb(bullet), true);
    });
  }

  const rejected = [
    'Assisted with collection of fish samples.',
    'Answered visitor questions at the front desk.',
    'Helped the team with weekly reporting.',
    'Worked on the onboarding flow.',
    'Participated in the weekly standup.',
    'Responsible for the lab inventory.',
    // Considered under the synonym rule and deliberately left out: nothing admitted means what
    // these mean, and both describe custody rather than an act.
    'Maintained the lab inventory spreadsheet.',
    'Selected samples for the second round.',
  ];
  for (const bullet of rejected) {
    test(`still rejects ${bullet.split(' ')[0]}`, () => {
      assert.equal(startsWithStrongVerb(bullet), false);
    });
  }
});

/* These strings are rendered verbatim to the student on /start. A hard 40-character cut printed
 * "Maintained a caseload of 12-21 individua" - a chopped word, which reads like the resume itself
 * is corrupted. */
describe('excerpt', () => {
  test('breaks on a word boundary rather than mid-word', () => {
    const bullet = 'Maintained a caseload of 12-21 individual clients a week.';
    const said = excerpt(bullet);
    assert.ok(!said.includes('individua…'), said);
    assert.ok(said.endsWith('…'), said);
    assert.ok(bullet.startsWith(said.slice(0, -1)), said);
  });

  test('a bullet that already fits is returned whole, with no ellipsis', () => {
    assert.equal(excerpt('Built the thing.'), 'Built the thing.');
    assert.equal(excerpt(''), '');
  });

  test('one very long word still gets cut, because there is no boundary to find', () => {
    const said = excerpt('Supercalifragilisticexpialidociousandthensomemore', 20);
    assert.equal(said.length, 21);
    assert.ok(said.endsWith('…'));
  });

  test('whitespace around a bullet is not quoted back', () => {
    assert.equal(excerpt('   Built the thing.   '), 'Built the thing.');
  });
});

/* The em dash reached a rendered PDF through the one spec field the content check did not read.
 * Found 2026-07-27 when the new ATS gate refused to save a WVU criminal-justice resume. */
describe('stripEmDashes', () => {
  test('a date range is the field this was missed in', () => {
    assert.deepEqual(
      stripEmDashes({ date_range: 'Sept. 2019 — Present' }),
      { date_range: 'Sept. 2019 - Present' },
    );
  });

  test('en dashes go too, they arrive from the same place', () => {
    assert.equal(stripEmDashes('May 2024 – Aug 2024'), 'May 2024 - Aug 2024');
  });

  test('reaches every field, including nested bullets and skills', () => {
    const spec = {
      school: 'A — B',
      skills: ['C — D'],
      experience: [{ org: 'E', bullets: ['Built it — fast.'] }],
    };
    const said = stripEmDashes(spec);
    assert.equal(said.school, 'A - B');
    assert.deepEqual(said.skills, ['C - D']);
    assert.equal(said.experience[0].bullets[0], 'Built it - fast.');
  });

  test('a string with no em dash is returned untouched, and non-strings survive', () => {
    assert.equal(stripEmDashes('Built the thing.'), 'Built the thing.');
    assert.deepEqual(stripEmDashes({ n: 3, b: true, z: null }), { n: 3, b: true, z: null });
  });

  test('spacing around the dash is normalised, not doubled', () => {
    assert.equal(stripEmDashes('A—B'), 'A - B');
    assert.equal(stripEmDashes('A — B'), 'A - B');
  });
});
