import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decide, parseTerm, parseGraduation, classifyRole, isBlocked } from './eligibility';

const intern = (title: string, description?: string) => ({ title, employment_type: 'Internship', description });

describe('the case the gate exists for', () => {
  test('a student who graduated before the term begins is blocked', () => {
    // May 2026 graduate, Summer 2027 internship. There is no employer policy under which a person
    // who finished their degree a year ago is an enrolled student.
    const e = decide(intern('Software Engineer Intern, Summer 2027'), 'May 2026');
    assert.equal(e.verdict, 'ineligible');
    assert.ok(isBlocked(e));
    assert.match(e.reason, /enrolled student/);
  });

  test('a student still enrolled through the term is eligible', () => {
    assert.equal(decide(intern('SWE Intern, Summer 2027'), 'May 2028').verdict, 'eligible');
  });

  test('a rising sophomore is eligible for an early internship', () => {
    // Graduating May 2028, Summer 2026 internship: enrolled, just early. This must NOT be hidden.
    assert.equal(decide(intern('Product Intern [Summer 2026]'), 'May 2028').verdict, 'eligible');
  });
});

describe('what the gate deliberately will not decide', () => {
  /* Every one of these is a case where hiding would be wrong or unprovable, and the product hard
     filters with nothing shown to the student. `unknown` is the only safe answer. */

  test('graduating DURING the term is not blocked', () => {
    /* The common employer preference is a returning student, but it is a preference: postings
       written for graduating seniors in their final summer exist, and that summer is the single
       most valuable season a student has. Hiding it on a guess is the worst thing this gate could
       do. The clause judge reads what THIS employer said. */
    const e = decide(intern('SWE Intern, Summer 2027'), 'May 2027');
    assert.equal(e.verdict, 'unknown');
    assert.ok(!isBlocked(e));
  });

  test('a posting with no term is never blocked', () => {
    assert.equal(decide(intern('Software Engineer Intern'), 'May 2020').verdict, 'unknown');
  });

  test('a student with no graduation date on file is never blocked', () => {
    assert.equal(decide(intern('SWE Intern, Summer 2027'), null).verdict, 'unknown');
    assert.equal(decide(intern('SWE Intern, Summer 2027'), '').verdict, 'unknown');
  });

  test('an ordinary full-time role is never blocked', () => {
    assert.equal(decide({ title: 'Senior Backend Engineer', employment_type: 'Full-time' }, 'May 2028').verdict, 'unknown');
  });
});

describe('reading the term', () => {
  test('the title wins over the body', () => {
    /* A body mentions other programmes, deadlines and history. "Founded in summer 2019" as the
       term would hide the posting from everyone, and under a hard filter nobody would ever know. */
    const t = parseTerm('SWE Intern, Summer 2027', 'We have been building since summer 2019.');
    assert.equal(t?.label, 'Summer 2027');
  });

  test('the body is used only when the title says nothing', () => {
    assert.equal(parseTerm('Software Engineer Intern', 'This is a Fall 2026 placement.')?.label, 'Fall 2026');
  });

  test('bracketed and prose forms both read', () => {
    assert.equal(parseTerm('Power Systems Intern [Fall 2026]')?.label, 'Fall 2026');
    assert.equal(parseTerm('Intern - spring of 2028')?.label, 'Spring 2028');
  });

  test('winter crosses the year boundary', () => {
    const w = parseTerm('Intern, Winter 2026')!;
    assert.ok(w.end > w.start, 'December 2026 to March 2027, not backwards');
    // A January 2027 graduate is inside it, so not blocked.
    assert.equal(decide(intern('Intern, Winter 2026'), 'January 2027').verdict, 'unknown');
  });

  test('no season, no term', () => {
    assert.equal(parseTerm('Software Engineer Intern 2027'), null, 'a bare year is not a term');
  });
});

describe('reading the graduation date', () => {
  test('the formats students actually have', () => {
    assert.equal(parseGraduation('May 2027'), parseGraduation('2027-05'));
    assert.equal(parseGraduation('05/2027'), parseGraduation('May 2027'));
    assert.equal(parseGraduation('Dec. 2027'), parseGraduation('2027-12'));
  });

  test('a bare year reads as December, not January', () => {
    /* submissionEducationGuard builds grad_date from grad_year, so "2027" is a real stored value.
       Read as January, every one of those students looks finished a term early, and spring
       internships they can do would be hidden from them. */
    assert.equal(parseGraduation('2027'), parseGraduation('December 2027'));
    // Read as January this would be ineligible, which is the hidden-and-unreportable failure.
    assert.ok(!isBlocked(decide(intern('Intern, Spring 2027'), '2027')));
    assert.equal(decide(intern('Intern, Spring 2026'), '2027').verdict, 'eligible');
  });

  test('nonsense is not a date', () => {
    assert.equal(parseGraduation('sometime soon'), null);
  });

  test('a malformed date falls back to the year rather than to a wrong month', () => {
    /* "13/2027" has no month 13. Reading it as month 1 would be a guess that can only hide roles;
       falling back to the year, which December-ends, is the reading that cannot over-block. */
    assert.equal(parseGraduation('13/2027'), parseGraduation('2027'));
  });
});

describe('classifying the role', () => {
  test('internship spellings', () => {
    for (const t of ['SWE Intern', 'Summer Internship', 'Co-op Engineer', 'Coop Student', 'Engineering Trainee'])
      assert.equal(classifyRole(t), 'internship', t);
  });

  test('a word that merely contains "intern" is not an internship', () => {
    // The reason INTERN is bounded: this is a senior full-time role and must never be gated.
    assert.equal(classifyRole('Head of International Sales'), 'unknown');
    assert.equal(classifyRole('Internal Tools Engineer'), 'unknown');
  });

  test('new-grad spellings', () => {
    for (const t of ['New Grad Software Engineer', 'Graduate Programme 2027', 'Early Career Analyst'])
      assert.equal(classifyRole(t), 'new-grad', t);
  });
});

describe('new-grad intake', () => {
  test('a recent graduate is eligible', () => {
    assert.equal(decide({ title: 'New Grad Engineer, Fall 2027' }, 'May 2027').verdict, 'eligible');
  });

  test('someone who graduated years earlier is blocked', () => {
    assert.equal(decide({ title: 'New Grad Engineer, Fall 2027' }, 'May 2019').verdict, 'ineligible');
  });

  test('someone still studying is not blocked, only unresolved', () => {
    // They may well be the target: the programme starts after they finish.
    assert.equal(decide({ title: 'Graduate Programme, Fall 2027' }, 'May 2028').verdict, 'unknown');
  });
});
