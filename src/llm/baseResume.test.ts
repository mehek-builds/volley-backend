import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
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

  test('role-defining work is protected alongside the most recent general role', () => {
    const admin = bankEntry({ id: 'admin', org: 'Engineering Office', title: 'Administrator', date_range: '2019 - 2022' });
    const nursing = bankEntry({ id: 'nursing', type: 'project', org: 'Clinical Nursing Study', title: 'Nursing Researcher', date_range: '2018' });
    const convent = bankEntry({ id: 'convent', org: 'Convent', title: 'Resident Assistant', date_range: '2016 - 2017' });

    const priorities = priorityEntriesForBaseResume([admin, nursing, convent], 'Registered Nurse. Nursing Research');
    assert.equal(priorities[0]?.id, 'admin');
    assert.ok(priorities.some((entry) => entry.id === 'nursing'));
  });
});
