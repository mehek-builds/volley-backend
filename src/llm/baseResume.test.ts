import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBulletRepairs,
  baseResumeSelectionIssues,
  BaseResumeStreamReader,
  parseSpecText,
  priorityEntriesForBaseResume,
} from './baseResume';
import type { BaseResumeEvent } from './baseResume';
import type { ExperienceBankEntry } from '../db/schema';

/* The stream reader is the one piece here with no server to catch its mistakes: it runs against a
 * half-written JSON document and has to decide what is safe to paint. The bar it must clear is not
 * "emits everything" but "never emits something wrong" - a piece that arrives late is a slightly
 * duller animation, a piece that arrives WRONG is a resume the student sees us get backwards.
 */

const SPEC = {
  school: 'University of Southern California',
  degree: 'Bachelor of Science in Computer Science',
  grad_date: 'May 2028',
  coursework: 'Data Structures, Algorithms',
  education_position: 'top',
  experience: [
    { type: 'job', org: 'Acme Labs', title: 'SWE Intern', date_range: 'Jun 2026 - Aug 2026', bullets: ['Built a thing', 'Shipped it'] },
    { type: 'project', org: 'Litos', title: 'Founder', date_range: '2026', bullets: ['Designed a system'] },
  ],
  skills: ['TypeScript', 'Python'],
};

function bankEntry(over: Partial<ExperienceBankEntry>): ExperienceBankEntry {
  return {
    id: crypto.randomUUID(),
    user_id: 'user',
    type: 'job',
    org: 'Example',
    title: 'Contributor',
    date_range: '2020',
    bullet_variants: ['Built grounded evidence for the source role'],
    tags: [],
    created_at: new Date(),
    ...over,
  } as ExperienceBankEntry;
}

/** Feed the serialized spec through the reader in fixed-size slices, as a real stream would. */
function streamThrough(text: string, chunkSize: number): BaseResumeEvent[] {
  const reader = new BaseResumeStreamReader();
  const events: BaseResumeEvent[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    events.push(...reader.push(text.slice(i, i + chunkSize)));
  }
  return events;
}

describe('BaseResumeStreamReader', () => {
  test('emits education, every entry once, and skills - at any chunk size', () => {
    const text = JSON.stringify(SPEC);
    // 1 exercises the worst case: every brace, quote and comma arrives alone.
    for (const chunkSize of [1, 3, 17, 64, text.length]) {
      const events = streamThrough(text, chunkSize);
      const entries = events.filter((e) => e.type === 'entry');
      const educations = events.filter((e) => e.type === 'education');
      const skills = events.filter((e) => e.type === 'skills');

      assert.equal(educations.length, 1, `education emitted once at chunk ${chunkSize}`);
      assert.equal(entries.length, 2, `both entries emitted at chunk ${chunkSize}`);
      assert.equal(skills.length, 1, `skills emitted once at chunk ${chunkSize}`);

      assert.deepEqual(
        entries.map((e) => (e.type === 'entry' ? e.entry.org : '')),
        ['Acme Labs', 'Litos'],
      );
      // Index must track emission order, since the client paints by index.
      assert.deepEqual(entries.map((e) => (e.type === 'entry' ? e.index : -1)), [0, 1]);
      assert.deepEqual(skills[0]?.type === 'skills' ? skills[0].skills : [], ['TypeScript', 'Python']);
    }
  });

  test('never emits a half-written entry', () => {
    const reader = new BaseResumeStreamReader();
    // Everything up to the middle of the first entry's bullets: the object has not closed.
    const partial = '{"education_position":"top","experience":[{"type":"job","org":"Acme","title":"SWE","date_range":"2026","bullets":["Built a th';
    const events = reader.push(partial);
    assert.equal(events.filter((e) => e.type === 'entry').length, 0);
    // Education is separately complete, so it may (and should) land early.
    assert.equal(events.filter((e) => e.type === 'education').length, 1);
  });

  test('a brace inside a string does not close an entry early', () => {
    // The scanner tracks string state; without that, "}" in a bullet ends the object one field in
    // and the client paints an entry with no bullets.
    const spec = {
      education_position: 'top',
      experience: [{ type: 'job', org: 'Acme', title: 'SWE', date_range: '2026', bullets: ['Refactored the {config} block'] }],
      skills: ['Go'],
    };
    const events = streamThrough(JSON.stringify(spec), 1);
    const entries = events.filter((e) => e.type === 'entry');
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].type === 'entry' ? entries[0].entry.bullets : [], ['Refactored the {config} block']);
  });

  test('an escaped quote inside a bullet does not desync string tracking', () => {
    const spec = {
      education_position: 'after_experience',
      experience: [{ type: 'job', org: 'Acme', title: 'SWE', date_range: '2026', bullets: ['Shipped the "fast" path'] }],
      skills: ['Rust'],
    };
    const events = streamThrough(JSON.stringify(spec), 1);
    const entries = events.filter((e) => e.type === 'entry');
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].type === 'entry' ? entries[0].entry.bullets : [], ['Shipped the "fast" path']);
  });

  test('reports education_position verbatim, both values', () => {
    const top = streamThrough(JSON.stringify({ education_position: 'top', experience: [], skills: [] }), 5);
    const after = streamThrough(JSON.stringify({ education_position: 'after_experience', experience: [], skills: [] }), 5);
    assert.equal(top.find((e) => e.type === 'education')?.type === 'education' ? (top[0] as { education_position: string }).education_position : '', 'top');
    const afterEvent = after.find((e) => e.type === 'education');
    assert.equal(afterEvent?.type === 'education' ? afterEvent.education_position : '', 'after_experience');
  });
});

describe('parseSpecText', () => {
  test('parses a bare object', () => {
    assert.equal(parseSpecText(JSON.stringify(SPEC)).school, SPEC.school);
  });

  test('strips a markdown fence', () => {
    assert.equal(parseSpecText('```json\n' + JSON.stringify(SPEC) + '\n```').school, SPEC.school);
  });

  test('recovers from explanation text around the object', () => {
    const wrapped = `Here is the spec:\n${JSON.stringify(SPEC)}\nLet me know if you need changes.`;
    assert.equal(parseSpecText(wrapped).experience.length, 2);
  });

  test('throws with a readable message on unrecoverable output', () => {
    assert.throws(() => parseSpecText('I cannot build this resume.'), /invalid JSON/);
  });
});

describe('base resume priority selection', () => {
  test('an onboarding choice is the only mandatory base-resume entry', () => {
    const chosen = bankEntry({ id: 'chosen', org: 'Selected Lab', title: 'Research Lead', date_range: '2024' });
    const current = bankEntry({ id: 'current', org: 'Current Office', title: 'Assistant', date_range: '2026 - Present' });
    const roleMatch = bankEntry({ id: 'role', org: 'Product Studio', title: 'Product Manager', date_range: '2025' });

    assert.deepEqual(
      priorityEntriesForBaseResume([current, chosen, roleMatch], 'Product Manager', chosen.id).map((entry) => entry.id),
      [chosen.id],
    );
  });

  test('current one-bullet roles cannot be displaced by older multi-bullet history', () => {
    const professor = bankEntry({ id: 'professor', org: 'State University', title: 'Adjunct Professor', date_range: '2024 - Present' });
    const litigator = bankEntry({ id: 'litigator', org: 'Legal Aid', title: 'Litigation Associate', date_range: '2023 - Present' });
    const oldRole = bankEntry({
      id: 'old',
      org: 'Old Firm',
      title: 'Junior Associate',
      date_range: '1997 - 2001',
      bullet_variants: ['Built one grounded line', 'Led another grounded line', 'Drafted a third grounded line'],
    });

    const priorities = priorityEntriesForBaseResume([oldRole, professor, litigator], 'Attorney. Legal Counsel');
    assert.deepEqual(priorities.slice(0, 2).map((entry) => entry.id), ['professor', 'litigator']);
    assert.deepEqual(
      baseResumeSelectionIssues(
        { ...SPEC, education_position: 'top' as const, experience: [{ ...SPEC.experience[0], type: 'job' as const, org: oldRole.org, title: oldRole.title ?? '', date_range: oldRole.date_range ?? '' }] },
        priorities,
      ).length,
      2,
    );
  });

  /* THE SPLIT BETWEEN INCLUSION AND POSITION, pinned from both sides.
   *
   * `priorities` is ranked by recency, so the position half of this check was a recency rule: it
   * failed any tailored packet whose lead entry was chosen against the posting, which made "the top
   * experience is aligned for their role" unreachable no matter what the prompt asked for. The
   * tailored path now passes requireFirst: false and hands ordering to leadAlignmentIssues.
   *
   * The safety question that gated that change is the third test here. Relaxing POSITION must not
   * quietly relax INCLUSION, because inclusion is the half that protects a real user: it is what
   * keeps the current role on the page for someone whose onboarding selection is live. This
   * applicant's selected_entry_id is stale and absent from her bank, so priorityEntry resolves to
   * null and she exercises none of it - which is exactly why it needs a test rather than a
   * measurement. */
  const priorityOf = (over: Partial<ExperienceBankEntry>) => bankEntry(over);
  const specWithExperience = (orgs: Array<{ org: string; title: string; date_range: string }>) => ({
    ...SPEC,
    education_position: 'top' as const,
    experience: orgs.map((o) => ({ ...SPEC.experience[0], type: 'job' as const, ...o, bullets: ['Built a thing'] })),
  });

  test('the base resume still requires the priority entry to lead, with no posting to rank against', () => {
    const current = priorityOf({ org: 'Current Lab', title: 'Engineer', date_range: '2026 - Present' });
    const issues = baseResumeSelectionIssues(
      specWithExperience([
        { org: 'Older Firm', title: 'Analyst', date_range: '2023' },
        { org: 'Current Lab', title: 'Engineer', date_range: '2026 - Present' },
      ]),
      [current],
    );
    assert.deepEqual(issues, ['required priority entry is not first: Engineer at Current Lab']);
  });

  test('a tailored resume may lead with a different entry, as long as the priority entry is on it', () => {
    const current = priorityOf({ org: 'Current Lab', title: 'Engineer', date_range: '2026 - Present' });
    const issues = baseResumeSelectionIssues(
      specWithExperience([
        { org: 'Older Firm', title: 'Analyst', date_range: '2023' },
        { org: 'Current Lab', title: 'Engineer', date_range: '2026 - Present' },
      ]),
      [current],
      { requireFirst: false },
    );
    assert.deepEqual(issues, []);
  });

  test('relaxing position does NOT relax inclusion: a dropped priority entry still fails', () => {
    const current = priorityOf({ org: 'Current Lab', title: 'Engineer', date_range: '2026 - Present' });
    const issues = baseResumeSelectionIssues(
      specWithExperience([{ org: 'Older Firm', title: 'Analyst', date_range: '2023' }]),
      [current],
      { requireFirst: false },
    );
    assert.deepEqual(issues, ['required current or role-defining entry missing: Engineer at Current Lab']);
  });

  test('role-defining work is protected alongside the most recent general role', () => {
    const admin = bankEntry({ id: 'admin', org: 'Engineering Office', title: 'Administrator', date_range: '2019 - 2022' });
    const nursing = bankEntry({ id: 'nursing', type: 'project', org: 'Clinical Nursing Study', title: 'Nursing Researcher', date_range: '2018' });
    const convent = bankEntry({ id: 'convent', org: 'Convent', title: 'Resident Assistant', date_range: '2016 - 2017' });

    const priorities = priorityEntriesForBaseResume([admin, nursing, convent], 'Registered Nurse. Nursing Research');
    assert.equal(priorities[0]?.id, 'admin');
    assert.ok(priorities.some((entry) => entry.id === 'nursing'));
  });
});

describe('applyBulletRepairs', () => {
  const spec = parseSpecText(JSON.stringify(SPEC));

  test('replaces exactly the matched (org, bullet) pair and nothing else', () => {
    const reply = JSON.stringify([
      { org: 'Acme Labs', bullet: 'Built a thing', rewritten: 'Engineered a data pipeline processing 2M rows daily' },
    ]);
    const repaired = applyBulletRepairs(spec, reply);
    assert.equal(repaired.experience[0].bullets[0], 'Engineered a data pipeline processing 2M rows daily');
    assert.equal(repaired.experience[0].bullets[1], 'Shipped it');
    assert.equal(repaired.experience[1].bullets[0], 'Designed a system');
  });

  test('the same bullet text under a different org is not touched', () => {
    const reply = JSON.stringify([
      { org: 'Litos', bullet: 'Built a thing', rewritten: 'Should not land anywhere' },
    ]);
    const repaired = applyBulletRepairs(spec, reply);
    assert.deepEqual(repaired.experience[0].bullets, ['Built a thing', 'Shipped it']);
    assert.deepEqual(repaired.experience[1].bullets, ['Designed a system']);
  });

  test('a fenced reply is unwrapped before parsing', () => {
    const reply = '```json\n' + JSON.stringify([
      { org: 'Litos', bullet: 'Designed a system', rewritten: 'Architected a streaming build system' },
    ]) + '\n```';
    const repaired = applyBulletRepairs(spec, reply);
    assert.equal(repaired.experience[1].bullets[0], 'Architected a streaming build system');
  });

  test('malformed replies leave the spec untouched', () => {
    for (const reply of ['not json', '{"org":"x"}', '[]', JSON.stringify([{ org: 'Acme Labs' }]), JSON.stringify([{ org: 'Acme Labs', bullet: 'Built a thing', rewritten: '   ' }])]) {
      assert.deepEqual(applyBulletRepairs(spec, reply), spec);
    }
  });

  test('the original spec object is never mutated', () => {
    const before = JSON.stringify(spec);
    applyBulletRepairs(spec, JSON.stringify([
      { org: 'Acme Labs', bullet: 'Shipped it', rewritten: 'Delivered the feature to 300 users' },
    ]));
    assert.equal(JSON.stringify(spec), before);
  });
});
