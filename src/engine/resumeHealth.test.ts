import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkResumeHealth, WEAK_OPENERS } from './resumeHealth';
import { STRONG_VERBS, BULLET_MAX_CHARS } from './resumeValidate';
import type { ResumeSpec } from '../llm/resumeSpec';

function spec(bullets: string[], over: Partial<ResumeSpec> = {}): ResumeSpec {
  return {
    school: 'USC',
    degree: 'BS Computer Science',
    grad_date: 'May 2028',
    coursework: '',
    experience: [{ type: 'job', org: 'Traeco', title: 'Intern', date_range: 'Jun 2025', bullets }],
    skills: ['Python'],
    ...over,
  } as ResumeSpec;
}

const rules = (s: ResumeSpec) => checkResumeHealth(s).findings.map((f) => f.rule);

describe('checkResumeHealth', () => {
  test('a strong bullet produces no findings', () => {
    const r = checkResumeHealth(spec(['Built a dashboard used by 40 people, cutting reporting time 35%']));
    assert.deepEqual(r.findings, []);
    assert.equal(r.quantified_count, 1);
  });

  test('an unquantified bullet is named, with the bullet quoted', () => {
    // Paired with a quantified one, so the per-bullet rule fires rather than the summary that
    // replaces it when NOTHING on the resume carries a number.
    const r = checkResumeHealth(spec(['Shipped 3 features', 'Built a dashboard for the operations team']));
    const finding = r.findings.find((f) => f.rule === 'no-metric');
    assert.ok(finding);
    assert.equal(finding.org, 'Traeco');
    assert.match(finding.bullet ?? '', /Built a dashboard/);
  });

  test('a genuinely weak opening is named with the word in the title', () => {
    const finding = checkResumeHealth(spec(['Responsible for 12 weekly reports'])).findings.find(
      (f) => f.rule === 'weak-verb',
    );
    assert.ok(finding);
    assert.match(finding.title, /Responsible/);
  });

  test('a strong verb missing from STRONG_VERBS is NOT flagged', () => {
    // The first screenshot of this panel told the student that "Containerized six services with
    // Docker, cutting release time by 35%" opened on a weak verb, because "containerized" is not
    // in the enumerated strong-verb list. No list of good verbs will ever be complete, so the rule
    // names genuinely weak openings instead of everything it does not recognise.
    for (const verb of ['Containerized', 'Instrumented', 'Backfilled', 'Parallelized', 'Deprecated']) {
      const r = checkResumeHealth(spec([`${verb} six services, cutting release time by 35%`]));
      assert.deepEqual(
        r.findings.filter((f) => f.rule === 'weak-verb'),
        [],
        `"${verb}" is a strong verb and must not be flagged`,
      );
    }
  });

  test('the constructions that actually bury the work are still caught', () => {
    // 'Supported' and 'Contributed' were dropped after review: both have ordinary transitive uses
    // that a bare first-word test cannot separate from the passive sense.
    for (const opener of ['Helped', 'Assisted', 'Worked', 'Participated', 'Involved', 'Responsible']) {
      const r = checkResumeHealth(spec([`${opener} on 4 launches`]));
      assert.equal(
        r.findings.filter((f) => f.rule === 'weak-verb').length,
        1,
        `"${opener}" describes proximity, not doing`,
      );
    }
  });

  test('an over-long bullet reports its actual length', () => {
    const long = 'Built ' + 'a very long dashboard description '.repeat(9) + 'for 40 users';
    const finding = checkResumeHealth(spec([long])).findings.find((f) => f.rule === 'too-long');
    assert.ok(finding);
    assert.match(finding.title, new RegExp(String(long.length)));
  });

  test('fixes sort above considerations', () => {
    const r = checkResumeHealth(spec(['Built a dashboard for the team'], { skills: [] }));
    const severities = r.findings.map((f) => f.severity);
    assert.deepEqual([...severities].sort((a, b) => (a === 'fix' ? -1 : 1)), severities);
  });

  test('a resume with no numbers anywhere says so ONCE, without repeating it per bullet', () => {
    // Both fired before, so a 2-bullet resume with no numbers reported "3 things worth fixing" for
    // what is one problem stated three times.
    const r = checkResumeHealth(spec(['Built a dashboard', 'Wrote documentation']));
    assert.equal(r.findings.filter((f) => f.rule === 'no-metrics-anywhere').length, 1);
    assert.equal(r.findings.filter((f) => f.rule === 'no-metric').length, 0);
  });

  test('WEAK_OPENERS and STRONG_VERBS can never contradict each other', () => {
    // "facilitated" was in both: the panel told the student to rewrite a bullet the generator's own
    // hard gate had just certified as opening on a strong verb.
    const overlap = [...WEAK_OPENERS].filter((w) => STRONG_VERBS.has(w));
    assert.deepEqual(overlap, [], `these words are in both lists: ${overlap.join(', ')}`);
  });

  test('a transitive use of a passive-sounding verb is not flagged', () => {
    const r = checkResumeHealth(spec(['Exposed a REST API for 12 downstream services']));
    assert.deepEqual(r.findings.filter((f) => f.rule === 'weak-verb'), []);
  });

  test('the passive construction still is', () => {
    const r = checkResumeHealth(spec(['Exposed to 4 production incidents']));
    assert.equal(r.findings.filter((f) => f.rule === 'weak-verb').length, 1);
  });

  test('a year or a version string does not count as a metric', () => {
    // A bare digit test counted "v2.1" and "2025", so a bullet with no scale read as quantified.
    const r = checkResumeHealth(spec(['Migrated the billing service to v2.1 in 2025']));
    assert.equal(r.quantified_count, 0);
    assert.ok(r.findings.some((f) => f.rule === 'no-metrics-anywhere'));
  });

  test('an empty resume is a finding, never an all clear', () => {
    const r = checkResumeHealth(spec([], { experience: [] }));
    assert.ok(r.findings.some((f) => f.rule === 'no-bullets'));
    assert.notEqual(r.findings.length, 0, 'zero findings renders as "nothing to fix"');
  });

  test('findings come back in resume order, with one bullet\'s findings together', () => {
    const long = 'Helped ' + 'with a very long description of the work '.repeat(6) + 'for the team';
    const s2 = spec(['Shipped 3 features', long, 'Assisted on 2 launches']);
    const orders = checkResumeHealth(s2)
      .findings.filter((f) => f.severity === 'fix')
      .map((f) => f.bullet ?? '');
    // The long/weak bullet's two findings are adjacent, not split across rule groups.
    const firstLong = orders.findIndex((b) => b.startsWith('Helped'));
    const lastLong = orders.map((b) => b.startsWith('Helped')).lastIndexOf(true);
    assert.equal(lastLong - firstLong, 1, `expected adjacency, got ${JSON.stringify(orders)}`);
  });

  test('a bullet over the length limit is reported, not swallowed by a validator', () => {
    // sanitizeEditedSpec REJECTS an over-long bullet, so routing the health check through it made
    // this finding unreachable: the panel said it could not check the resume instead.
    const long = 'Shipped ' + 'x'.repeat(BULLET_MAX_CHARS) + ' for 40 users';
    const r = checkResumeHealth(spec([long]));
    assert.ok(r.findings.some((f) => f.rule === 'too-long'));
  });

  test('an empty skills line is a consideration, not a fix', () => {
    const finding = checkResumeHealth(spec(['Shipped 3 features'], { skills: [] })).findings.find(
      (f) => f.rule === 'no-skills',
    );
    assert.equal(finding?.severity, 'consider');
  });

  test('a role with no bullets is called out by name', () => {
    const s = spec(['Shipped 3 features']);
    s.experience.push({ type: 'project', org: 'Litos', title: 'Founder', date_range: '2026', bullets: [] });
    const finding = checkResumeHealth(s).findings.find((f) => f.rule === 'empty-entry');
    assert.match(finding?.title ?? '', /Litos/);
  });

  test('an empty resume does not crash and does not invent findings about bullets', () => {
    const r = checkResumeHealth(spec([], { experience: [], skills: ['Python'] }));
    assert.equal(r.bullet_count, 0);
    assert.ok(!rules(spec([], { experience: [], skills: ['Python'] })).includes('no-metrics-anywhere'));
  });

  test('counts are the ones the UI states, and cannot exceed each other', () => {
    const r = checkResumeHealth(spec(['Shipped 3 features', 'Wrote docs']));
    assert.equal(r.bullet_count, 2);
    assert.equal(r.quantified_count, 1);
    assert.ok(r.quantified_count <= r.bullet_count);
  });
});
