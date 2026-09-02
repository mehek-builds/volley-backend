import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBulletRepairs,
  BASE_RESUME_GENERATION_FALLBACK_MODEL,
  BASE_RESUME_GENERATION_MODEL,
  BASE_RESUME_MODEL_CALL_CAP_MS,
  BASE_RESUME_REPAIR_CALL_CAP_MS,
  baseResumeModelTimeoutMs,
  baseResumeRepairTimeoutMs,
  baseResumeSelectionIssues,
  enforcePrioritySelection,
  BaseResumeStreamReader,
  parseSpecText,
  priorityEntriesForBaseResume,
} from './baseResume';
import {
  BACKSTOP_REPAIR_ALLOWANCE_MS,
  baseResumeBackstopAllowed,
  baseResumeRepairAllowed,
  REPAIR_PASS_BUDGET_MS,
} from '../routes/baseResume';
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

test('base generation and repair calls obey their interactive caps', () => {
  assert.equal(baseResumeModelTimeoutMs(), BASE_RESUME_MODEL_CALL_CAP_MS);
  assert.equal(baseResumeModelTimeoutMs(5_000), 5_000);
  assert.equal(baseResumeModelTimeoutMs(BASE_RESUME_MODEL_CALL_CAP_MS), BASE_RESUME_MODEL_CALL_CAP_MS);
  assert.equal(baseResumeModelTimeoutMs(120_000), BASE_RESUME_MODEL_CALL_CAP_MS);
  assert.equal(baseResumeRepairTimeoutMs(), BASE_RESUME_REPAIR_CALL_CAP_MS);
  assert.equal(baseResumeRepairTimeoutMs(3_000), 3_000);
  assert.equal(baseResumeRepairTimeoutMs(BASE_RESUME_REPAIR_CALL_CAP_MS), BASE_RESUME_REPAIR_CALL_CAP_MS);
  assert.equal(baseResumeRepairTimeoutMs(120_000), BASE_RESUME_REPAIR_CALL_CAP_MS);
});

test('a grounded local base spec can never enter either repair branch', () => {
  const local = { ...SPEC, generation_method: 'local_fallback' as const };
  assert.equal(baseResumeRepairAllowed(local.generation_method, 0), false);
  assert.equal(baseResumeRepairAllowed(local.generation_method, REPAIR_PASS_BUDGET_MS - 1), false);
  assert.equal(baseResumeBackstopAllowed(local.generation_method), false);
  assert.equal(baseResumeRepairAllowed(undefined, 0), true);
  /* 18s, not 35s: the window covers generation plus repairs, repairs run 1.3-1.7s each live, and
   * the stage carries a sub-30-second promise the old ceiling could not keep. The boundary is
   * inclusive: a pass may START at exactly the budget and still run its full call cap. */
  assert.equal(baseResumeRepairAllowed(undefined, REPAIR_PASS_BUDGET_MS - 1), true);
  assert.equal(baseResumeRepairAllowed(undefined, REPAIR_PASS_BUDGET_MS), true);
  assert.equal(baseResumeRepairAllowed(undefined, REPAIR_PASS_BUDGET_MS + 1), false);
});

test('the repair window survives a worst-case generation, and the backstop is not elapsed-gated', () => {
  /* The one relationship that actually broke the old numbers apart would pass silently: if the
   * generation cap ever meets or exceeds the window, every build's first repair check fails and
   * every weak verb ships (or dies at the fail-closed gate) for every student. Pin it. */
  assert.ok(
    REPAIR_PASS_BUDGET_MS > BASE_RESUME_MODEL_CALL_CAP_MS,
    'a worst-case generation must leave the loop at least one repair pass',
  );
  /* The backstop is the last thing between a floor-injected bullet and a nothing-saved build
   * (measured live 2026-08-29), so no amount of elapsed time may gate it - only a local-fallback
   * spec skips it. Its own allowance stays under the shared repair call cap. */
  assert.equal(baseResumeBackstopAllowed(undefined), true);
  assert.equal(baseResumeBackstopAllowed('local_fallback'), false);
  assert.ok(BACKSTOP_REPAIR_ALLOWANCE_MS <= BASE_RESUME_REPAIR_CALL_CAP_MS);
  assert.equal(baseResumeRepairTimeoutMs(BACKSTOP_REPAIR_ALLOWANCE_MS), BACKSTOP_REPAIR_ALLOWANCE_MS);
});

test('the generation models are the measured pair, spelled exactly', () => {
  /* A typo here does not error: the fallback chain converts an unknown-model 404 into a degraded
   * local-fallback resume that logs outcome=success. This is the only tripwire. */
  assert.equal(BASE_RESUME_GENERATION_MODEL, 'claude-haiku-4-5-20251001');
  assert.equal(BASE_RESUME_GENERATION_FALLBACK_MODEL, 'claude-sonnet-5');
});

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
    const chosen = bankEntry({
      id: 'chosen', org: 'Selected Lab', title: 'Research Lead', date_range: '2024',
      bullet_variants: ['Led a grounded study cohort', 'Published grounded results'],
    });
    const current = bankEntry({ id: 'current', org: 'Current Office', title: 'Assistant', date_range: '2026 - Present' });
    const roleMatch = bankEntry({ id: 'role', org: 'Product Studio', title: 'Product Manager', date_range: '2025' });

    assert.deepEqual(
      priorityEntriesForBaseResume([current, chosen, roleMatch], 'Product Manager', chosen.id).map((entry) => entry.id),
      [chosen.id],
    );
  });

  test('current roles cannot be displaced by older multi-bullet history', () => {
    const professor = bankEntry({
      id: 'professor', org: 'State University', title: 'Adjunct Professor', date_range: '2024 - Present',
      bullet_variants: ['Taught two grounded seminars', 'Advised a grounded thesis cohort'],
    });
    const litigator = bankEntry({
      id: 'litigator', org: 'Legal Aid', title: 'Litigation Associate', date_range: '2023 - Present',
      bullet_variants: ['Argued a grounded motion', 'Drafted grounded discovery requests'],
    });
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
    const twoLines = (a: string, b: string) => [a, b];
    const admin = bankEntry({ id: 'admin', org: 'Engineering Office', title: 'Administrator', date_range: '2019 - 2022', bullet_variants: twoLines('Ran a grounded office process', 'Kept grounded records straight') });
    const nursing = bankEntry({ id: 'nursing', type: 'project', org: 'Clinical Nursing Study', title: 'Nursing Researcher', date_range: '2018', bullet_variants: twoLines('Collected grounded patient data', 'Presented grounded findings') });
    const convent = bankEntry({ id: 'convent', org: 'Convent', title: 'Resident Assistant', date_range: '2016 - 2017', bullet_variants: twoLines('Supported grounded residents', 'Organised grounded events') });

    const priorities = priorityEntriesForBaseResume([admin, nursing, convent], 'Registered Nurse. Nursing Research');
    assert.equal(priorities[0]?.id, 'admin');
    assert.ok(priorities.some((entry) => entry.id === 'nursing'));
  });

  test('a required entry the dedupe emptied is excused, because its sentences are on the page', () => {
    /* The one level deeper the sparse-priority fix could not reach: a duplicate bank row with a
     * DIFFERENT identity (a re-upload that renamed the org) has two grounded variants, so it
     * survives the mandatory filter - and then the floor's cross-entry dedupe empties it because
     * its every sentence already prints under the other copy's heading. Demanding it anyway is the
     * same nothing-saved dead-end. The excuse is keyed on (org, title): a different role at the
     * same organization is NOT excused. */
    const required = bankEntry({ id: 'dupe', org: 'Tri Coast Capital Manhattan Beach, CA', title: 'Analyst', date_range: '2024 - Present' });
    const specWithoutIt = {
      ...SPEC,
      education_position: 'top' as const,
      experience: [{ ...SPEC.experience[0], type: 'job' as const, org: 'Tri Coast Capital', title: 'Analyst', date_range: '2024 - Present' }],
    };
    assert.equal(
      baseResumeSelectionIssues(specWithoutIt, [required], { requireFirst: false }).length,
      1,
    );
    assert.deepEqual(
      baseResumeSelectionIssues(specWithoutIt, [required], {
        requireFirst: false,
        droppedAsAlreadyPrinted: [{ org: 'Tri Coast Capital Manhattan Beach, CA', title: 'Analyst' }],
      }),
      [],
    );
    assert.equal(
      baseResumeSelectionIssues(specWithoutIt, [required], {
        requireFirst: false,
        droppedAsAlreadyPrinted: [{ org: 'Tri Coast Capital Manhattan Beach, CA', title: 'Managing Partner' }],
      }).length,
      1,
    );
  });

  test('an entry the bullet floor is guaranteed to drop is never mandatory', () => {
    /* Reproduced live 2026-09-02/03 against production: a current leadership role with ONE bank
     * variant was required by this fallback, forbidden by the prompt, dropped by the floor (which
     * has no sparse allowance on this path), and the fail-closed ATS gate then refused EVERY
     * build - "required current or role-defining entry missing" on each retry, with nothing
     * saved, deterministically. Being selectable is fine; being mandatory requires being able to
     * survive the floor. */
    const sparse = bankEntry({
      id: 'sparse', type: 'leadership', org: 'Pre-Health Society', title: 'Events Coordinator',
      date_range: '2025 - Present', bullet_variants: ['Organized speaker panels for 80 attendees'],
    });
    const internship = bankEntry({
      id: 'internship', org: 'Genomics Lab', title: 'Research Assistant', date_range: '2025 - Present',
      bullet_variants: ['Performed grounded PCR runs', 'Analyzed grounded sequencing data'],
    });
    const priorities = priorityEntriesForBaseResume([sparse, internship], 'Research Assistant');
    assert.ok(!priorities.some((entry) => entry.id === 'sparse'));
    assert.ok(priorities.some((entry) => entry.id === 'internship'));
    /* A CONFIRMED sparse selection stays mandatory: continue_with_found is the moment the floor
     * and the validator gain their allowance for it, so mandatory-ness may follow. */
    assert.deepEqual(
      priorityEntriesForBaseResume([sparse, internship], 'Research Assistant', 'sparse', { sparseSelectionConfirmed: true })
        .map((entry) => entry.id),
      ['sparse'],
    );
  });

  test('an auto-seeded sparse selection is not mandatory until the applicant confirms it', () => {
    /* Every upload seeds recent_experience_review.selected_entry_id with continue_with_found
     * false (buildRecentExperienceReview), and the explicit branch used to make that auto-pick
     * unconditionally mandatory - recreating the nothing-saved dead-end for a one-variant pick,
     * because no sparse allowance is active without the confirmation. Reproduced live 2026-09-03
     * on a fresh production trial account. Unconfirmed, the pick falls through to the legacy
     * fallback and its survivability filter; a multi-variant pick is unaffected either way. */
    const sparse = bankEntry({
      id: 'sparse', type: 'leadership', org: 'IISE UF Chapter', title: 'Treasurer',
      date_range: '2025 - Present', bullet_variants: ['Managed the chapter budget'],
    });
    const coop = bankEntry({
      id: 'coop', org: 'Distribution Center', title: 'Engineering Co-op', date_range: 'Jan 2026 - Jun 2026',
      bullet_variants: ['Mapped grounded pick paths', 'Built grounded dashboards'],
    });
    const unconfirmed = priorityEntriesForBaseResume([sparse, coop], 'Industrial Engineer', 'sparse');
    assert.ok(!unconfirmed.some((entry) => entry.id === 'sparse'));
    assert.ok(unconfirmed.some((entry) => entry.id === 'coop'));
    /* A survivable auto-pick keeps the old behavior: it is the one mandatory entry. */
    assert.deepEqual(
      priorityEntriesForBaseResume([sparse, coop], 'Industrial Engineer', 'coop').map((entry) => entry.id),
      ['coop'],
    );
  });
});

describe('applyBulletRepairs', () => {
  const spec = parseSpecText(JSON.stringify(SPEC));
  const target = (org: string, bullet: string) => ({ org, bullet, reasons: ['opens weak'] });

  test('an index-keyed rewrite replaces exactly the targeted bullet and nothing else', () => {
    const targets = [target('Acme Labs', 'Built a thing')];
    const reply = JSON.stringify([{ index: 0, rewritten: 'Engineered a data pipeline processing 2M rows daily' }]);
    const repaired = applyBulletRepairs(spec, reply, targets);
    assert.equal(repaired.experience[0].bullets[0], 'Engineered a data pipeline processing 2M rows daily');
    assert.equal(repaired.experience[0].bullets[1], 'Shipped it');
    assert.equal(repaired.experience[1].bullets[0], 'Designed a system');
  });

  test('the rewrite lands even when the model would have mangled an echo, because no echo is read', () => {
    const targets = [target('Acme Labs', 'Built a thing')];
    const reply = JSON.stringify([
      { index: 0, org: 'wrong echo', bullet: 'Engineered stuff already', rewritten: 'Engineered a data pipeline processing 2M rows daily' },
    ]);
    const repaired = applyBulletRepairs(spec, reply, targets);
    assert.equal(repaired.experience[0].bullets[0], 'Engineered a data pipeline processing 2M rows daily');
  });

  test('an out-of-range or missing index is ignored', () => {
    const targets = [target('Acme Labs', 'Built a thing')];
    for (const reply of [
      JSON.stringify([{ index: 5, rewritten: 'Engineered a data pipeline processing 2M rows daily' }]),
      JSON.stringify([{ rewritten: 'Engineered a data pipeline processing 2M rows daily' }]),
      JSON.stringify([{ index: 'zero', rewritten: 'Engineered a data pipeline processing 2M rows daily' }]),
    ]) {
      assert.deepEqual(applyBulletRepairs(spec, reply, targets), spec);
    }
  });

  test('a fenced reply is unwrapped before parsing', () => {
    const targets = [target('Litos', 'Designed a system')];
    const reply = '```json\n' + JSON.stringify([
      { index: 0, rewritten: 'Architected a streaming build system serving three hundred users' },
    ]) + '\n```';
    const repaired = applyBulletRepairs(spec, reply, targets);
    assert.equal(repaired.experience[1].bullets[0], 'Architected a streaming build system serving three hundred users');
  });

  test('malformed replies leave the spec untouched', () => {
    const targets = [target('Acme Labs', 'Built a thing')];
    for (const reply of ['not json', '{"index":0}', '[]', JSON.stringify([{ index: 0 }]), JSON.stringify([{ index: 0, rewritten: '   ' }])]) {
      assert.deepEqual(applyBulletRepairs(spec, reply, targets), spec);
    }
  });

  test('a rewrite that is itself overlong, weak-opened, or outside the word band is refused', () => {
    const targets = [target('Acme Labs', 'Built a thing')];
    for (const rewritten of [
      `Engineered ${'x'.repeat(240)}`,
      'Assisted with the data pipeline work every day',
      'Engineered the whole pipeline',
    ]) {
      const reply = JSON.stringify([{ index: 0, rewritten }]);
      assert.equal(applyBulletRepairs(spec, reply, targets), spec);
    }
  });

  test('a reply that changes nothing returns the same spec reference', () => {
    const targets = [target('Acme Labs', 'Built a thing')];
    const reply = JSON.stringify([{ index: 0, rewritten: 'Built a thing' }]);
    assert.equal(applyBulletRepairs(spec, reply, targets), spec);
  });

  test('whitespace drift between the target text and the spec still matches', () => {
    const targets = [target(' Acme  Labs ', 'Built  a thing ')];
    const reply = JSON.stringify([{ index: 0, rewritten: 'Engineered the data ingestion service end to end reliably' }]);
    const repaired = applyBulletRepairs(spec, reply, targets);
    assert.equal(repaired.experience[0].bullets[0], 'Engineered the data ingestion service end to end reliably');
  });

  test('the original spec object is never mutated', () => {
    const targets = [target('Acme Labs', 'Shipped it')];
    const before = JSON.stringify(spec);
    applyBulletRepairs(spec, JSON.stringify([{ index: 0, rewritten: 'Delivered the feature to three hundred users in production' }]), targets);
    assert.equal(JSON.stringify(spec), before);
  });
});

describe('enforcePrioritySelection', () => {
  const limits = { maxEntries: 4, maxBulletsPerEntry: 3 };
  const specOf = (entries: Array<Record<string, unknown>>) => parseSpecText(JSON.stringify({
    ...SPEC,
    experience: entries,
  }));
  const entry = (org: string, title: string) => (
    { type: 'job', org, title, date_range: '2025', bullets: ['Built the first grounded thing for this role here', 'Shipped the second grounded thing for this role here'] }
  );

  test('one application clears every selection issue baseResumeSelectionIssues reports', () => {
    const current = bankEntry({ id: 'cur', org: 'Current Lab', title: 'Engineer', date_range: '2026 - Present', bullet_variants: ['Ran the lab build pipeline for nine research teams daily'] });
    const spec = specOf([entry('Older Firm', 'Analyst'), entry('Side Project', 'Creator')]);
    const fixed = enforcePrioritySelection(spec, [current], limits);
    assert.deepEqual(baseResumeSelectionIssues(fixed, [current]), []);
    assert.equal(fixed.experience[0].org, 'Current Lab');
    assert.deepEqual(fixed.experience[0].bullets, ['Ran the lab build pipeline for nine research teams daily']);
  });

  test('a priority the model already wrote keeps its written bullets and is only moved', () => {
    const current = bankEntry({ id: 'cur', org: 'Current Lab', title: 'Engineer', date_range: '2026 - Present', bullet_variants: ['raw variant'] });
    const written = entry('Current Lab', 'Engineer');
    const spec = specOf([entry('Older Firm', 'Analyst'), written]);
    const fixed = enforcePrioritySelection(spec, [current], limits);
    assert.equal(fixed.experience[0].org, 'Current Lab');
    assert.deepEqual(fixed.experience[0].bullets, written.bullets);
    assert.equal(fixed.experience[1].org, 'Older Firm');
  });

  test('over the cap, non-priority entries fall off the end first', () => {
    const current = bankEntry({ id: 'cur', org: 'Current Lab', title: 'Engineer', date_range: '2026 - Present', bullet_variants: ['Ran the lab build pipeline for nine research teams daily'] });
    const spec = specOf([entry('A', 'a'), entry('B', 'b'), entry('C', 'c'), entry('D', 'd')]);
    const fixed = enforcePrioritySelection(spec, [current], limits);
    assert.equal(fixed.experience.length, 4);
    assert.equal(fixed.experience[0].org, 'Current Lab');
    assert.deepEqual(fixed.experience.slice(1).map((e) => e.org), ['A', 'B', 'C']);
  });

  test('no priorities means the spec is untouched', () => {
    const spec = specOf([entry('A', 'a')]);
    assert.equal(enforcePrioritySelection(spec, [], limits), spec);
  });
});
