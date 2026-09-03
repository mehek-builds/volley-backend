import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
  priorityEntryMayBeMandatory,
} from './baseResume';
import { enforceExperienceBulletFloor } from '../engine/resumePolicy';
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
        droppedByTheFloor: [{ sourceId: null, org: 'Tri Coast Capital Manhattan Beach, CA', title: 'Analyst' }],
      }),
      [],
    );
    assert.equal(
      baseResumeSelectionIssues(specWithoutIt, [required], {
        requireFirst: false,
        droppedByTheFloor: [{ sourceId: null, org: 'Tri Coast Capital Manhattan Beach, CA', title: 'Managing Partner' }],
      }).length,
      1,
    );
    /* THE ID IS THE REAL KEY, and identity only the fallback behind it. The org and title on a
     * drop are the MODEL'S strings, so a row stored as "Tri Coast Capital Manhattan Beach, CA"
     * that the model wrote as "Tri Coast Capital" was reported under the short name and excused
     * nothing - which is precisely the near-duplicate shape that caused the drop. */
    assert.deepEqual(
      baseResumeSelectionIssues(specWithoutIt, [required], {
        requireFirst: false,
        droppedByTheFloor: [{ sourceId: required.id, org: 'Tri Coast Capital', title: 'Analyst' }],
      }),
      [],
    );
    /* BOTH KEYS COUNT, and this case is why. matchingBankEntry breaks an exact org-containment
     * tie by preferring the LONGER org, so with a re-upload duplicate the floor attributes the
     * drop to the sibling row whichever copy the model wrote. Excusing by id alone, with identity
     * used only when no id was reported, then refused this student on every posting - a
     * regression on the exact scenario the excuse was written for. */
    assert.deepEqual(
      baseResumeSelectionIssues(specWithoutIt, [required], {
        requireFirst: false,
        droppedByTheFloor: [{ sourceId: 'the-sibling-row', org: 'Tri Coast Capital Manhattan Beach, CA', title: 'Analyst' }],
      }),
      [],
    );
    /* Neither key matching is still an issue: a different role at the same organization, dropped,
     * does not excuse this one. */
    assert.equal(
      baseResumeSelectionIssues(specWithoutIt, [required], {
        requireFirst: false,
        droppedByTheFloor: [{ sourceId: 'a-different-row', org: 'Tri Coast Capital Manhattan Beach, CA', title: 'Managing Partner' }],
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

  test('the TAILORED path cannot require a selection the floor is guaranteed to drop', () => {
    /* THE THIRD HEAD, on /resume/generate. #872 and #875 closed both base-resume branches and
     * left this one open: the tailored route required whatever `bank.find(entry => entry.id ===
     * selectedEntryId)` returned, with no survivability or confirmation check at all. So the same
     * account healed in onboarding could still dead-end on EVERY application - and worse than the
     * base case, because no wording of any posting changes it: the floor drops the entry, both
     * gates demand it, and the packet is refused with resume_quality_hold every time.
     *
     * Run here as the route runs it, floor first and gate second, because the contradiction only
     * exists between the two. */
    const sparse = bankEntry({
      id: 'sparse', type: 'leadership', org: 'IISE UF Chapter', title: 'Treasurer',
      date_range: '2025 - Present', bullet_variants: ['Managed the chapter budget'],
    });
    const coop = bankEntry({
      id: 'coop', org: 'Distribution Center', title: 'Engineering Co-op', date_range: 'Jan 2026 - Jun 2026',
      bullet_variants: ['Mapped grounded pick paths', 'Built grounded dashboards'],
    });
    const generated = {
      ...SPEC,
      education_position: 'top' as const,
      experience: [
        { type: 'leadership' as const, org: sparse.org, title: 'Treasurer', date_range: '2025 - Present', bullets: ['Managed the chapter budget'] },
        { type: 'job' as const, org: coop.org, title: 'Engineering Co-op', date_range: 'Jan 2026 - Jun 2026', bullets: ['Mapped grounded pick paths', 'Built grounded dashboards'] },
      ],
    };

    /* Unconfirmed, the floor removes it - allowSparsePriority keys on continue_with_found, so
     * naming it as the priority entry buys nothing. */
    const printed = enforceExperienceBulletFloor(generated, [sparse, coop], {
      priorityEntryId: sparse.id,
      allowSparsePriority: false,
    });
    assert.ok(!printed.experience.some((entry) => entry.org === sparse.org));
    /* ...and requiring it anyway is the dead-end, reachable on every posting. */
    assert.deepEqual(
      baseResumeSelectionIssues(printed, [sparse], { requireFirst: false }),
      ['required current or role-defining entry missing: Treasurer at IISE UF Chapter'],
    );

    /* The rule the route now applies before it decides what is mandatory. */
    assert.equal(priorityEntryMayBeMandatory(sparse), false);
    assert.equal(priorityEntryMayBeMandatory(coop), true);
    assert.equal(priorityEntryMayBeMandatory(sparse, { sparseSelectionConfirmed: true }), true);

    /* CONFIRMED, nothing changes: the allowance keeps the entry on the page, so demanding it is
     * coherent and the student still gets the selection they asked to continue with. */
    const withAllowance = enforceExperienceBulletFloor(generated, [sparse, coop], {
      priorityEntryId: sparse.id,
      allowSparsePriority: true,
    });
    assert.ok(withAllowance.experience.some((entry) => entry.org === sparse.org));
    assert.deepEqual(baseResumeSelectionIssues(withAllowance, [sparse], { requireFirst: false }), []);
  });

  test('/resume/generate computes what is mandatory rather than requiring the raw selection', () => {
    /* Pinned against the source because the mechanism tests above cannot see the route, and the
     * route is where this defect lived for both of its lives: the gate, the floor and the
     * predicate were each individually correct while /resume/generate simply handed the gate a
     * bank row nobody had checked. Every mechanism test here passes with the route fully
     * reverted, so these assertions carry the whole load.
     *
     * Resolved from THIS file rather than the process cwd. `node --test` run from src/ made the
     * old cwd-relative read throw ENOENT; CI happens to run from the repo root, so the failure
     * mode was a green suite everywhere it mattered and a red one for whoever ran it locally. */
    const route = readFileSync(path.join(__dirname, '../routes/resume.ts'), 'utf8');
    assert.match(route, /const priorityEntry = selectedEntry\s*\n\s*&& priorityEntryMayBeMandatory\(selectedEntry, \{ sparseSelectionConfirmed \}\)/);
    assert.doesNotMatch(route, /const priorityEntry = bank\.find/);
    assert.match(route, /priorityEntryId: selectedEntry\?\.id/);
    /* BOTH gates take the checked entry. Swapping either back to the raw selection restores the
     * original bug with every mechanism test still green, so the call sites are pinned, not just
     * the binding they read from. */
    const gateCalls = route.match(/baseResumeSelectionIssues\(spec, \[[a-zA-Z]+\]/g) ?? [];
    assert.deepEqual(gateCalls, [
      'baseResumeSelectionIssues(spec, [priorityEntry]',
      'baseResumeSelectionIssues(spec, [priorityEntry]',
    ]);
    /* THE EXCUSE IS ACTUALLY POPULATED. Passing the array to the gate proves nothing if nothing
     * ever pushes to it: delete the push and the array stays permanently empty, the duplicate
     * dead-end returns, and a test that builds its own local array cannot see it. */
    /* UNCONDITIONALLY, which a substring match does not establish: re-adding the
     * `if (reason === 'already_printed')` guard in front of this push leaves a plain
     * `assert.match` for the push itself green, and the below_floor strand comes straight back.
     * The mechanism test above collects its own array, so it cannot see the route's filter. */
    assert.match(route, /onDropped: \(\{ org, title, sourceId, bullets, reason \}\) => \{\n\s*droppedByTheFloor\.push\(\{ sourceId, org, title \}\);/);
    assert.doesNotMatch(route, /reason === 'already_printed'\) droppedByTheFloor/);
    assert.match(route, /requireFirst: false, droppedByTheFloor/);
  });

  test('routes/baseResume.ts feeds its gate the same way', () => {
    /* The two routes share the gate and the floor, so an excuse that is collected on one and not
     * the other is how they drift back apart. Same two pins. */
    const route = readFileSync(path.join(__dirname, '../routes/baseResume.ts'), 'utf8');
    /* UNCONDITIONALLY, which a substring match does not establish: re-adding the
     * `if (reason === 'already_printed')` guard in front of this push leaves a plain
     * `assert.match` for the push itself green, and the below_floor strand comes straight back.
     * The mechanism test above collects its own array, so it cannot see the route's filter. */
    assert.match(route, /onDropped: \(\{ org, title, sourceId, bullets, reason \}\) => \{\n\s*droppedByTheFloor\.push\(\{ sourceId, org, title \}\);/);
    assert.doesNotMatch(route, /reason === 'already_printed'\) droppedByTheFloor/);
    assert.match(route, /baseResumeSelectionIssues\(printed, priorityEntries, \{ droppedByTheFloor \}\)/);
  });

  test('the tailored gate excuses a required entry the cross-entry dedupe emptied', () => {
    /* The other head of the same contradiction, and the one the survivability rule cannot reach:
     * this row has TWO grounded variants, so it is mandatory by every rule above - and the floor
     * still empties it, because a re-upload created a second row for the same work under a
     * renamed org and its every sentence already prints under the first copy's heading. Demanded
     * and removed is a permanent resume_quality_hold on every posting. routes/baseResume.ts has
     * excused this since #872; the tailored route did not collect the list at all. */
    const original = bankEntry({
      id: 'original', org: 'Tri Coast Capital', title: 'Analyst', date_range: '2024 - Present',
      bullet_variants: ['Modeled grounded deal comparables', 'Wrote grounded diligence memos'],
    });
    const renamed = bankEntry({
      id: 'renamed', org: 'Tri Coast Capital Manhattan Beach, CA', title: 'Analyst', date_range: '2024 - Present',
      bullet_variants: ['Modeled grounded deal comparables', 'Wrote grounded diligence memos'],
    });
    /* Survivable, so the mandatory rule from the test above lets it through. */
    assert.equal(priorityEntryMayBeMandatory(renamed), true);

    const generated = {
      ...SPEC,
      education_position: 'top' as const,
      experience: [
        { type: 'job' as const, org: original.org, title: 'Analyst', date_range: '2024 - Present', bullets: ['Modeled grounded deal comparables', 'Wrote grounded diligence memos'] },
        { type: 'job' as const, org: renamed.org, title: 'Analyst', date_range: '2024 - Present', bullets: ['Modeled grounded deal comparables', 'Wrote grounded diligence memos'] },
      ],
    };
    const droppedByTheFloor: Array<{ sourceId?: string | null; org: string; title?: string | null }> = [];
    const printed = enforceExperienceBulletFloor(generated, [original, renamed], {
      onDropped: ({ org, title, sourceId }) => { droppedByTheFloor.push({ sourceId, org, title }); },
    });
    assert.ok(!printed.experience.some((entry) => entry.org === renamed.org));
    assert.deepEqual(droppedByTheFloor, [{ sourceId: renamed.id, org: renamed.org, title: 'Analyst' }]);

    assert.equal(baseResumeSelectionIssues(printed, [renamed], { requireFirst: false }).length, 1);
    assert.deepEqual(
      baseResumeSelectionIssues(printed, [renamed], { requireFirst: false, droppedByTheFloor }),
      [],
    );
  });

  test('the dedupe also strands a survivable entry ONE bullet short, not only an emptied one', () => {
    /* THE REASON THE EXCUSE COVERS EVERY DROP. The first fix filtered the excuse to
     * `already_printed`, which is the exact-duplicate case. But the same cross-entry dedupe takes
     * ONE shared sentence from a two-variant row and leaves it on a single bullet, which the
     * floor reports as `below_floor` - unexcused, still mandatory, refused on every posting. It
     * is the likelier shape, too: a re-upload that renames an org usually rewords a bullet as
     * well, so the variant lists overlap partially rather than exactly.
     *
     * Deterministic, not luck: the floor tops the entry back up from its OWN variant list, and
     * the shared sentence is already taken, so no wording the model chooses can rescue it. */
    const alpha = bankEntry({
      id: 'alpha', org: 'Alpha Corp', title: 'Analyst', date_range: '2024 - Present',
      bullet_variants: ['Modeled grounded deal comparables', 'Wrote grounded diligence memos'],
    });
    const beta = bankEntry({
      id: 'beta', org: 'Alpha Corp Manhattan Beach, CA', title: 'Analyst', date_range: '2024 - Present',
      bullet_variants: ['Modeled grounded deal comparables', 'Led grounded market sizing work'],
    });
    assert.equal(priorityEntryMayBeMandatory(beta), true);

    const droppedByTheFloor: Array<{ sourceId?: string | null; org: string; title?: string | null }> = [];
    const printed = enforceExperienceBulletFloor(
      {
        ...SPEC,
        education_position: 'top' as const,
        experience: [
          { type: 'job' as const, org: alpha.org, title: 'Analyst', date_range: '2024 - Present', bullets: [...alpha.bullet_variants as string[]] },
          { type: 'job' as const, org: beta.org, title: 'Analyst', date_range: '2024 - Present', bullets: [...beta.bullet_variants as string[]] },
        ],
      },
      [alpha, beta],
      { onDropped: ({ org, title, sourceId, reason }) => {
        assert.equal(reason, 'below_floor');
        droppedByTheFloor.push({ sourceId, org, title });
      } },
    );
    assert.ok(!printed.experience.some((entry) => entry.org === beta.org));
    assert.equal(baseResumeSelectionIssues(printed, [beta], { requireFirst: false }).length, 1);
    assert.deepEqual(
      baseResumeSelectionIssues(printed, [beta], { requireFirst: false, droppedByTheFloor }),
      [],
    );
  });

  test('the floor may attribute a duplicate drop to the SIBLING row, and the excuse still holds', () => {
    /* End to end through the real matcher, because this is where excusing by id alone regressed.
     * matchingBankEntry scores org containment and breaks the exact tie by preferring the longer
     * org, so with two rows for one job the drop is reported against the LONG row whichever copy
     * the model wrote - and the priority here is the short one, whose id therefore never appears
     * among the drops at all. */
    const shared = ['Modeled grounded deal comparables for midmarket targets', 'Wrote grounded diligence memos for the committee'];
    const short = bankEntry({ id: 'short', org: 'Tri Coast Capital', title: 'Analyst', date_range: '2024 - Present', bullet_variants: [...shared] });
    const long = bankEntry({ id: 'long', org: 'Tri Coast Capital Manhattan Beach, CA', title: 'Analyst', date_range: '2024 - Present', bullet_variants: [...shared] });
    const droppedByTheFloor: Array<{ sourceId?: string | null; org: string; title?: string | null }> = [];
    const printed = enforceExperienceBulletFloor(
      { ...SPEC, education_position: 'top' as const, experience: [
        { type: 'job' as const, org: long.org, title: 'Analyst', date_range: '2024 - Present', bullets: [...shared] },
        { type: 'job' as const, org: short.org, title: 'Analyst', date_range: '2024 - Present', bullets: [...shared] },
      ] },
      [short, long],
      { onDropped: ({ org, title, sourceId }) => { droppedByTheFloor.push({ sourceId, org, title }); } },
    );
    /* The drop is attributed to the row the priority is NOT. */
    assert.equal(droppedByTheFloor.length, 1);
    assert.notEqual(droppedByTheFloor[0]?.sourceId, short.id);
    assert.ok(!printed.experience.some((entry) => entry.org === short.org));
    assert.deepEqual(
      baseResumeSelectionIssues(printed, [short], { requireFirst: false, droppedByTheFloor }),
      [],
    );
  });

  test('survivability counts DISTINCT sentences, the way the floor counts them', () => {
    /* No second bank row and no confirmation flag needed for this one. A re-upload that reparsed
     * one bullet with a trailing period gives a row two variant STRINGS and one distinct
     * sentence: the predicate called it survivable, the floor collapsed the pair on its
     * normalized key and dropped the entry, and the gate refused every build. One normalizer,
     * asked by both, is what keeps the two answers the same answer. */
    const punctuationTwin = bankEntry({
      id: 'twin', type: 'leadership', org: 'IISE UF Chapter', title: 'Treasurer', date_range: '2025 - Present',
      bullet_variants: ['Managed the chapter budget', 'Managed the chapter budget.'],
    });
    assert.equal(priorityEntryMayBeMandatory(punctuationTwin), false);
    assert.equal(
      enforceExperienceBulletFloor(
        { ...SPEC, education_position: 'top' as const, experience: [
          { type: 'leadership' as const, org: punctuationTwin.org, title: 'Treasurer', date_range: '2025 - Present', bullets: ['Managed the chapter budget', 'Managed the chapter budget.'] },
        ] },
        [punctuationTwin],
      ).experience.length,
      0,
    );
    /* Two genuinely different sentences still survive, so this is not just a stricter count. */
    assert.equal(priorityEntryMayBeMandatory(bankEntry({
      id: 'real', bullet_variants: ['Managed the chapter budget', 'Ran the grounded speaker series'],
    })), true);
    /* A PUNCTUATION-ONLY VARIANT IS NOT A SENTENCE THE FLOOR CAN USE. Its normalized key is
     * empty, and the floor's top-up loop - the loop that decides whether a bank row can carry an
     * entry to the floor - skips exactly those. Counting it called the row survivable while the
     * floor still dropped it, which is the overstatement this count exists to remove. */
    const punctuationOnly = bankEntry({
      id: 'punct', org: 'Campus Lab', title: 'Intern',
      bullet_variants: ['Managed the chapter budget for the year', '!!!'],
    });
    assert.equal(priorityEntryMayBeMandatory(punctuationOnly), false);
    assert.equal(
      enforceExperienceBulletFloor(
        { ...SPEC, education_position: 'top' as const, experience: [
          { type: 'job' as const, org: 'Campus Lab', title: 'Intern', date_range: '2024', bullets: ['Managed the chapter budget for the year'] },
        ] },
        [punctuationOnly],
      ).experience.length,
      0,
      'the floor drops it, so the predicate must not call it survivable',
    );
  });

  test('an entry with no grounded evidence is never mandatory, confirmed or not', () => {
    /* The confirmation arm asserted an allowance that cannot fire. The floor's zero-bullet drop
     * runs AHEAD of every sparse allowance, and pruneUngroundedContent removes such an entry
     * earlier still and silently, with no onDropped and so no omission - so the student would be
     * refused for a missing required entry with nothing anywhere saying why.
     * PUT /profile/recent-experience stores continue_with_found for whatever entry the body
     * names, with no bullet-count precondition, so this arm has to carry its own floor. */
    const empty = bankEntry({ id: 'empty', org: 'Campus Club', title: 'Member', bullet_variants: [] });
    assert.equal(priorityEntryMayBeMandatory(empty), false);
    assert.equal(priorityEntryMayBeMandatory(empty, { sparseSelectionConfirmed: true }), false);
    const blank = bankEntry({ id: 'blank', org: 'Campus Club', title: 'Member', bullet_variants: ['   ', ''] });
    assert.equal(priorityEntryMayBeMandatory(blank, { sparseSelectionConfirmed: true }), false);
    /* One real sentence plus the confirmation is still mandatory: that is the case the
     * continue-with-found flow exists for. */
    const oneReal = bankEntry({ id: 'one', org: 'Campus Club', title: 'Treasurer', bullet_variants: ['Managed the chapter budget'] });
    assert.equal(priorityEntryMayBeMandatory(oneReal, { sparseSelectionConfirmed: true }), true);
  });

  test('the excuse stays bounded: only what the floor REPORTED is excused', () => {
    /* THE PROPERTY THAT KEEPS THE GATE WORTH HAVING, and the one to re-check before touching
     * either route's onDropped wiring. Excusing a below_floor drop is defensible only because the
     * list is built exclusively from the floor's own callback: the floor is the last thing that
     * can remove an entry before this gate, so what IT removed is unreachable and re-demanding it
     * can only refuse the document forever.
     *
     * Every other way an entry can leave the page is NOT unreachable. pruneUngroundedContent cuts
     * an ungrounded entry before the floor ever sees it, planResumeLayout trims whole entries to
     * make one page, the maxEntries slice drops the tail, and the model can simply never write the
     * entry at all. None of those call onDropped, so none of them reach the excuse - and all of
     * them are cases a differently-worded rebuild can genuinely fix, which is exactly why the gate
     * must keep refusing them.
     *
     * The tests above hand-build the excuse list to pin how it is KEYED. This one drives the real
     * floor and asserts what it does NOT report, because the bound is a property of the wiring
     * rather than of the lookup. */
    const required = bankEntry({
      id: 'required', org: 'Gamma Corp', title: 'Engineer', date_range: '2024 - Present',
      bullet_variants: ['Gamma grounded sentence one', 'Gamma grounded sentence two'],
    });
    const thin = bankEntry({
      id: 'thin', org: 'Delta Corp', title: 'Volunteer', date_range: '2023',
      bullet_variants: ['Delta grounded sentence one'],
    });
    const kept = bankEntry({
      id: 'kept', org: 'Epsilon Corp', title: 'Analyst', date_range: '2023',
      bullet_variants: ['Epsilon grounded sentence one', 'Epsilon grounded sentence two'],
    });

    /* THE SHARP CASE. The floor really does drop something here, so the excuse list is NON-EMPTY -
     * it just does not name the required entry, which the model never wrote. A blanket excuse, or
     * one keyed on nothing, would swallow this and ship a resume silently missing the applicant's
     * defining work. */
    const withoutRequired = {
      ...SPEC,
      education_position: 'top' as const,
      experience: [
        { type: 'job' as const, org: kept.org, title: 'Analyst', date_range: '2023', bullets: ['Epsilon grounded sentence one', 'Epsilon grounded sentence two'] },
        { type: 'job' as const, org: thin.org, title: 'Volunteer', date_range: '2023', bullets: ['Delta grounded sentence one'] },
      ],
    };
    const droppedByTheFloor: Array<{ sourceId?: string | null; org: string; title?: string | null }> = [];
    const printed = enforceExperienceBulletFloor(withoutRequired, [required, thin, kept], {
      onDropped: ({ sourceId, org, title }) => droppedByTheFloor.push({ sourceId, org, title }),
    });
    assert.deepEqual(droppedByTheFloor, [{ sourceId: thin.id, org: thin.org, title: 'Volunteer' }]);
    assert.ok(!printed.experience.some((entry) => entry.org === required.org));
    assert.deepEqual(
      baseResumeSelectionIssues(printed, [required], { requireFirst: false, droppedByTheFloor }),
      ['required current or role-defining entry missing: Engineer at Gamma Corp'],
    );

    /* AFTER THE FLOOR, nothing reports - and this half is only worth writing because the excuse
     * list is non-empty while the removal that matters is absent from it. An empty list proves
     * nothing here: `relaxing position does NOT relax inclusion` above already covers a gate
     * called with no excuses at all, and it passes under a blanket excuse for want of a list to
     * blanket over.
     *
     * planResumeLayout hands the gate its trimmed spec on both routes (`spec = rendered.spec` on
     * the tailored path, `printed = rendered.spec` on the base one), so an entry removed to make
     * the page fit arrives with an excuse list that never heard about it. The floor is asserted to
     * have KEPT it first, so the trim is a real second removal rather than an artifact of the
     * entry never surviving. */
    const floorKept: Array<{ sourceId?: string | null; org: string; title?: string | null }> = [];
    const survived = enforceExperienceBulletFloor(
      {
        ...SPEC,
        education_position: 'top' as const,
        experience: [
          { type: 'job' as const, org: required.org, title: 'Engineer', date_range: '2024 - Present', bullets: ['Gamma grounded sentence one', 'Gamma grounded sentence two'] },
          { type: 'job' as const, org: thin.org, title: 'Volunteer', date_range: '2023', bullets: ['Delta grounded sentence one'] },
        ],
      },
      [required, thin],
      { onDropped: ({ sourceId, org, title }) => floorKept.push({ sourceId, org, title }) },
    );
    /* The floor removed the thin entry and KEPT the required one. */
    assert.deepEqual(floorKept, [{ sourceId: thin.id, org: thin.org, title: 'Volunteer' }]);
    assert.deepEqual(survived.experience.map((entry) => entry.org), [required.org]);
    /* Now the layout takes the survivor off to make the page fit, reporting nothing. */
    const trimmedForFit = { ...survived, experience: [] };
    assert.deepEqual(
      baseResumeSelectionIssues(trimmedForFit, [required], { requireFirst: false, droppedByTheFloor: floorKept }),
      ['required current or role-defining entry missing: Engineer at Gamma Corp'],
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
