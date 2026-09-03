import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findGroundingViolations,
  findUngroundedSkills,
  pruneUngroundedContent,
  pruneUngroundedSkills,
  validateResumeSpec,
  overlongBullets,
  BULLET_MAX_CHARS,
  isProviderDependentResumeStyleIssue,
} from './resumeValidate';
import type { ResumeSpec } from '../llm/resumeSpec';
import type { ExperienceBankEntry } from '../db/schema';
import { RESUME_CONTENT_LIMITS } from './resumeContentPolicy';
import { allowedSparseEntriesForGeneration, enforceExperienceBulletFloor } from './resumePolicy';

function bankEntry(partial: Partial<ExperienceBankEntry>): ExperienceBankEntry {
  return {
    id: 'e1',
    user_id: 'u1',
    type: 'job',
    org: 'Acme',
    title: 'Engineer',
    date_range: '2024',
    bullet_variants: [],
    tags: [],
    created_at: new Date(),
    ...partial,
  } as ExperienceBankEntry;
}

test('outage continuity relaxes only provider-dependent style issues', () => {
  assert.equal(isProviderDependentResumeStyleIssue('bullet not action-verb-first ("Helped"): "Helped users"'), true);
  assert.equal(isProviderDependentResumeStyleIssue('bullet has 3 words (min 8): "Built the thing"'), true);
  assert.equal(isProviderDependentResumeStyleIssue(`bullet exceeds ${BULLET_MAX_CHARS} chars: "Built"`), true);
  assert.equal(isProviderDependentResumeStyleIssue('no experience entries selected'), false);
  assert.equal(isProviderDependentResumeStyleIssue('grounding: invented organization'), false);
  assert.equal(isProviderDependentResumeStyleIssue('education school differs from uploaded resume'), false);
});

function spec(experience: ResumeSpec['experience']): ResumeSpec {
  return {
    school: 'USC',
    degree: 'BS Computer Science',
    grad_date: 'May 2027',
    coursework: 'Algorithms, Databases',
    experience,
    skills: ['Python', 'TypeScript'],
  };
}

const BANK: ExperienceBankEntry[] = [
  bankEntry({
    id: 'a',
    org: 'Northwind Labs',
    title: 'Software Engineer Intern',
    bullet_variants: [
      'Built an internal analytics dashboard used by the growth team',
      'Shipped a caching layer that cut page load time by 30%',
    ],
    tags: ['python', 'react', 'caching'],
  }),
  bankEntry({
    id: 'b',
    org: 'Campus Robotics Club',
    title: 'Project Lead',
    bullet_variants: ['Led a 5 person team to build an autonomous rover'],
    tags: ['leadership', 'robotics'],
  }),
];

test('a bullet citing a company NOT in the experience bank is a grounding violation', () => {
  const s = spec([
    {
      org: 'Globex Corporation',
      title: 'Software Engineer Intern',
      date_range: '2024',
      bullets: ['Built an internal analytics dashboard used by the growth team'],
    },
  ]);
  const violations = findGroundingViolations(s, BANK);
  assert.ok(violations.some((v) => v.kind === 'org' && v.detail === 'Globex Corporation'));
});

test('a fabricated metric not present in the source entry is a grounding violation', () => {
  const s = spec([
    {
      org: 'Northwind Labs',
      title: 'Software Engineer Intern',
      date_range: '2024',
      // Source bullets mention "30%" but never "40K requests/day".
      bullets: ['Built a dashboard serving 40K requests/day for the growth team'],
    },
  ]);
  const violations = findGroundingViolations(s, BANK);
  assert.ok(violations.some((v) => v.kind === 'metric' && v.detail === '40K'));
});

test('a fabricated nonnumeric achievement is a grounding violation', () => {
  const s = spec([
    {
      org: 'Northwind Labs',
      title: 'Software Engineer Intern',
      date_range: '2024',
      bullets: ['Negotiated enterprise partnerships and closed strategic customer contracts'],
    },
  ]);
  const violations = findGroundingViolations(s, BANK);
  assert.ok(violations.some((v) => v.kind === 'claim'));
});

test('a faithfully-grounded bullet passes grounding', () => {
  const s = spec([
    {
      org: 'Northwind Labs',
      title: 'Software Engineer Intern',
      date_range: '2024',
      bullets: [
        'Built an internal analytics dashboard used by the growth team',
        'Shipped a caching layer that cut page load time by 30%',
      ],
    },
  ]);
  assert.deepEqual(findGroundingViolations(s, BANK), []);
});

test('content rules make short, long, and unsupported one-bullet entries hard failures', () => {
  const source = bankEntry({
    id: 'content',
    org: 'Content Lab',
    title: 'Analyst',
    date_range: '2024',
    bullet_variants: [
      'Built reliable tools',
      'Designed one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight twenty-nine thirty',
    ],
  });
  const result = validateResumeSpec(
    spec([{
      org: source.org,
      title: source.title ?? '',
      date_range: source.date_range ?? '',
      bullets: source.bullet_variants as string[],
    }]),
    '',
    [source],
  );

  assert.ok(result.issues.some((issue) => /bullet has 3 words \(min 8\)/.test(issue)));
  assert.ok(result.issues.some((issue) => /bullet has 31 words \(max 30\)/.test(issue)));

  const oneBullet = validateResumeSpec(
    spec([{
      org: source.org,
      title: source.title ?? '',
      date_range: source.date_range ?? '',
      bullets: ['Built reliable tools'],
    }]),
    '',
    [source],
  );
  /* One is still never enough, and the message states the floor rather than a fixed 3, which moved
     to 2 on 2026-08-20. The subject of this case is that a single-bullet entry is a HARD failure. */
  assert.ok(
    oneBullet.issues.some((issue) =>
      new RegExp(`1 bullet selected \\(min ${RESUME_CONTENT_LIMITS.minBulletsPerEntry}\\)`).test(issue),
    ),
    oneBullet.issues.join('; '),
  );
});

test('a source-limited priority role may keep its only grounded bullet without invention', () => {
  const current = bankEntry({
    id: 'current',
    org: 'Legal Aid',
    title: 'Litigation Associate',
    date_range: '2024 - Present',
    bullet_variants: ['Represented clients through complex hearings and negotiated settlement proceedings'],
  });
  const result = validateResumeSpec(
    spec([{
      org: current.org,
      title: current.title ?? '',
      date_range: current.date_range ?? '',
      bullets: current.bullet_variants as string[],
    }]),
    '',
    [current],
    undefined,
    undefined,
    undefined,
    { allowedSingleBulletEntries: [current] },
  );

  assert.ok(!result.issues.some((issue) => /bullet selected \(min 2\)/.test(issue)));
});

test('a source is sparse by DISTINCT sentences, so a punctuation twin is not two bullets', () => {
  /* THE THIRD COUNTER of the same quantity, and it disagreed with the other two. The allowance
     above forgives a one-bullet entry only when its bank row is genuinely sparse. Counting raw
     variant strings made a row holding one sentence and that sentence with a trailing period look
     like two, so a confirmed sparse selection was allowed onto the page by the floor and then
     failed HERE - a resume_quality_hold on every posting that no rebuild can clear, since the
     bank row never changes. The floor collapses the pair on its normalized key; so does this. */
  const sentence = 'Managed the chapter budget and reconciled every line of it monthly';
  const twin = bankEntry({
    id: 'twin',
    org: 'IISE UF Chapter',
    title: 'Treasurer',
    date_range: '2025 - Present',
    bullet_variants: [sentence, `${sentence}.`],
  });
  const result = validateResumeSpec(
    spec([{ org: twin.org, title: twin.title ?? '', date_range: twin.date_range ?? '', bullets: [sentence] }]),
    '',
    [twin],
    undefined,
    undefined,
    undefined,
    { allowedSingleBulletEntries: [twin] },
  );

  assert.ok(
    !result.issues.some((issue) => /bullet selected \(min 2\)/.test(issue)),
    result.issues.join('; '),
  );
});

/* THE FOURTH VARIANT of "a rule demands what another rule removes", and the only one the
   dropped-entry excuse could never reach.
 *
 * The three before it were all closed by making the counters agree about what ONE SENTENCE is, or
 * by excusing an entry the floor DROPPED. This one is neither. The floor dedupes across entries,
 * so it tops an entry up only from sentences no earlier entry already printed - and two bank rows
 * holding one sentence in common therefore give the second row a ceiling of one bullet, while a
 * count of that row on its own still says two.
 *
 * Nothing was dropped, so nothing can be excused: the sparse allowance KEEPS the priority entry at
 * one bullet, onDropped never fires, and droppedByTheFloor stays empty. The validator then called
 * the source non-sparse and refused the build. Fail-closed, so the tailored route 422s with
 * resume_quality_hold and the base route fails its ATS gate with nothing saved - on every posting,
 * forever, because the bank rows never change. isProviderDependentResumeStyleIssue does not filter
 * this string, so a local_fallback generation hit it too.
 *
 * THE FLOOR RUNS FOR REAL HERE rather than the post-floor spec being written out by hand. The whole
 * bug is a disagreement between what the floor does and what the validator believes it did, so a
 * test that asserts the validator's opinion of a spec someone typed cannot see it.
 */
test('a bullet the page already spent is not one this entry can still print', () => {
  const shared = 'Coordinated a weekly investor update across the entire deal team';
  const alphaOnly = 'Built a discounted cash flow model for a mid market acquisition target';
  const betaOnly = 'Drafted diligence memos for three portfolio companies every quarter';

  const alpha = bankEntry({
    id: 'alpha',
    org: 'Alpha Partners',
    title: 'Analyst',
    date_range: '2024 - 2025',
    bullet_variants: [shared, alphaOnly],
  });
  /* The confirmed sparse priority - continue_with_found is what turns the allowance on, and
     without it this entry would be DROPPED by the floor and excused by droppedByTheFloor. */
  const beta = bankEntry({
    id: 'beta',
    org: 'Beta Ventures',
    title: 'Associate',
    date_range: '2025 - Present',
    bullet_variants: [shared, betaOnly],
  });

  const dropped: string[] = [];
  const printed = enforceExperienceBulletFloor(
    spec([
      { org: alpha.org, title: alpha.title ?? '', date_range: alpha.date_range ?? '', bullets: [shared, alphaOnly] },
      { org: beta.org, title: beta.title ?? '', date_range: beta.date_range ?? '', bullets: [shared, betaOnly] },
    ]),
    [alpha, beta],
    {
      priorityEntryId: beta.id,
      allowSparsePriority: true,
      onDropped: (entry) => dropped.push(entry.org),
    },
  );

  /* The shape the bug needs, pinned so a change in the floor cannot leave this test asserting
     nothing. Beta is ON the page at one bullet, and nothing was dropped. */
  assert.deepEqual(printed.experience.map((entry) => entry.bullets.length), [2, 1]);
  assert.deepEqual(dropped, [], 'the floor dropped an entry, so this is not the case under test');

  const result = validateResumeSpec(
    printed,
    '',
    [alpha, beta],
    undefined,
    undefined,
    undefined,
    {
      allowedSingleBulletEntries: allowedSparseEntriesForGeneration('model', [alpha, beta], [beta], true),
    },
  );

  assert.ok(
    !result.issues.some((issue) => /bullet selected \(min 2\)/.test(issue)),
    result.issues.join('; '),
  );
});

/* The other half of the same rule, because forgiving a one-bullet entry unconditionally would be
   just as wrong and would pass the test above. A row with a second sentence NOTHING has printed can
   still reach the floor, so a one-bullet entry against it is a real defect and stays reported. */
test('an entry whose source can still reach the floor is not forgiven for having one bullet', () => {
  const alphaOnly = 'Built a discounted cash flow model for a mid market acquisition target';
  const betaFirst = 'Drafted diligence memos for three portfolio companies every quarter';
  const betaSecond = 'Reconciled quarterly valuations across eleven active portfolio positions';

  const alpha = bankEntry({
    id: 'alpha',
    org: 'Alpha Partners',
    title: 'Analyst',
    date_range: '2024 - 2025',
    bullet_variants: [alphaOnly, 'Sized four adjacent markets for the investment committee memo'],
  });
  const beta = bankEntry({
    id: 'beta',
    org: 'Beta Ventures',
    title: 'Associate',
    date_range: '2025 - Present',
    bullet_variants: [betaFirst, betaSecond],
  });

  /* Straight to the validator: the floor would have topped this entry up to two, which is exactly
     why one bullet here means something went wrong further down (the one-page fit trims whole
     bullets) and must not be waved through by the sparse allowance. */
  const result = validateResumeSpec(
    spec([
      { org: alpha.org, title: alpha.title ?? '', date_range: alpha.date_range ?? '', bullets: [alphaOnly] },
      { org: beta.org, title: beta.title ?? '', date_range: beta.date_range ?? '', bullets: [betaFirst] },
    ]),
    '',
    [alpha, beta],
    undefined,
    undefined,
    undefined,
    { allowedSingleBulletEntries: [alpha, beta] },
  );

  assert.ok(
    result.issues.some((issue) => /Beta Ventures: 1 bullet selected \(min 2\)/.test(issue)),
    result.issues.join('; '),
  );
});

/* The near-duplicate check used to loop per entry, so a pair sharing 30% of its words inside one
   entry was flagged while a pair sharing 100% across two entries passed in silence. That is how a
   live resume printed the same three sentences under EXPERIENCE and again under PROJECTS with
   nothing raised here. */
test('a bullet repeated under another entry is flagged, not just one repeated in place', () => {
  const shared = 'Shipped a consumer mobile app end to end and reached 100+ active users in eight weeks';
  const result = validateResumeSpec(
    spec([
      {
        org: 'Tonee - AI Texting Tone Detector',
        title: 'AI Engineer',
        date_range: '2025 - Present',
        bullets: [shared, 'Conducted 47 user interviews across three separate consumer markets'],
      },
      {
        org: 'Tonee - AI Texting Tone Detector',
        title: 'Founder',
        date_range: '2025 - Present',
        bullets: [shared, 'Evaluated three technical architectures for mobile inference performance'],
      },
    ]),
    '',
    BANK,
  );

  const overlap = result.warnings.filter((warning) =>
    warning.flags.some((flag) => flag.startsWith('overlaps')),
  );
  assert.ok(
    overlap.some((warning) => warning.flags.some((flag) => flag.includes('a bullet under "Tonee'))),
    JSON.stringify(overlap),
  );
  /* Reported only. The deterministic removal lives in enforceExperienceBulletFloor, which runs
     after this and can also see the bank top-up; two mechanisms racing to drop one bullet would
     make it impossible to say from a packet which one acted. */
  assert.ok(!result.issues.some((issue) => /overlaps/.test(issue)));
});

test('two bullets under one entry still name each other by their position in that entry', () => {
  const result = validateResumeSpec(
    spec([{
      org: 'Northwind Labs',
      title: 'Software Engineer Intern',
      date_range: '2024',
      bullets: [
        'Built an internal analytics dashboard used by the growth team every week',
        'Built an internal analytics dashboard used by the growth team every month',
      ],
    }]),
    '',
    BANK,
  );

  assert.ok(
    result.warnings.some((warning) => warning.flags.some((flag) => /^overlaps bullet 2 /.test(flag))),
    JSON.stringify(result.warnings),
  );
});

test('target role headline must match the role for this application', () => {
  const s = spec([
    {
      org: 'Northwind Labs',
      title: 'Software Engineer Intern',
      date_range: '2024',
      bullets: ['Built an internal analytics dashboard used by the growth team'],
    },
  ]);
  s.target_role = 'Product Manager';
  const result = validateResumeSpec(s, 'analytics engineering role', BANK, undefined, undefined, 'Analytics Engineer');
  assert.ok(result.issues.includes('target role headline does not exactly match the resume-safe job title'));

  s.target_role = 'Analytics Engineer';
  const aligned = validateResumeSpec(s, 'analytics engineering role', BANK, undefined, undefined, 'Analytics Engineer');
  assert.ok(!aligned.issues.includes('target role headline does not exactly match the resume-safe job title'));
});

test('target role validation rejects an empty normalized job title', () => {
  const s = spec([]);
  s.target_role = '';
  const result = validateResumeSpec(s, 'product research analytics', [], undefined, undefined, '   ');
  assert.ok(result.issues.includes('target role headline requires a non-empty job title'));
});

/* The em-dash scan reads resumeSpecText, which is every word the resume PRINTS, and the target role
   is no longer printed. So a dash in it is no longer a punctuation issue, and asserting that it is
   would be asserting against a line that does not exist.

   It is still caught, by a stricter check. resumeSafeTargetRole normalises en and em dashes to
   hyphens, so a raw dashed value cannot equal the resume-safe title and fails the exact-match rule
   instead. Same defect, named accurately. */
test('a dashed target role fails the exact-match rule, not the printed-punctuation rule', () => {
  const s = spec([]);
  s.target_role = `Analytics Engineer ${String.fromCharCode(0x2014)} Growth`;
  const result = validateResumeSpec(s, 'analytics engineering role', [], undefined, undefined, 'Analytics Engineer - Growth');
  assert.ok(!result.issues.includes('spec contains an em dash'));
  assert.ok(result.issues.includes('target role headline does not exactly match the resume-safe job title'));
});

test('a title swapped for a completely different one is flagged, a light rewrite is not', () => {
  const swapped = spec([
    {
      org: 'Northwind Labs',
      title: 'Chief Marketing Officer',
      date_range: '2024',
      bullets: ['Built an internal analytics dashboard used by the growth team'],
    },
  ]);
  assert.ok(findGroundingViolations(swapped, BANK).some((v) => v.kind === 'title'));

  const rewritten = spec([
    {
      org: 'Northwind Labs',
      title: 'Software Engineer', // shares "software"/"engineer" with the source title
      date_range: '2024',
      bullets: ['Built an internal analytics dashboard used by the growth team'],
    },
  ]);
  assert.ok(!findGroundingViolations(rewritten, BANK).some((v) => v.kind === 'title'));
});

test('validateResumeSpec surfaces grounding violations as hard issues (drives the retry loop)', () => {
  const s = spec([
    {
      org: 'Globex Corporation',
      title: 'Software Engineer',
      date_range: '2024',
      bullets: ['Built an analytics dashboard for the growth team'],
    },
  ]);
  const jd = 'Looking for a software engineer to build analytics dashboards with python and react.';
  const withBank = validateResumeSpec(s, jd, BANK);
  assert.ok(withBank.issues.some((i) => i.startsWith('grounding:')));
  // Without a bank, grounding is skipped (form-only validation) - no grounding issues.
  const withoutBank = validateResumeSpec(s, jd, []);
  assert.ok(!withoutBank.issues.some((i) => i.startsWith('grounding:')));
});

test('a fabricated employment year not in the source entry is a grounding violation', () => {
  const s = spec([
    {
      org: 'Northwind Labs',
      title: 'Software Engineer Intern',
      date_range: 'Jun 2021 - Aug 2024', // source entry is dated 2024 only; 2021 is invented
      bullets: ['Built an internal analytics dashboard used by the growth team'],
    },
  ]);
  const violations = findGroundingViolations(s, BANK);
  assert.ok(violations.some((v) => v.kind === 'date' && v.detail === '2021'));
});

test('pruneUngroundedContent resets a fabricated date to the source entry date', () => {
  const s = spec([
    {
      org: 'Northwind Labs',
      title: 'Software Engineer Intern',
      date_range: '2019 - 2024', // 2019 is not in the source
      bullets: ['Shipped a caching layer that cut page load time by 30%'],
    },
  ]);
  const { spec: cleaned } = pruneUngroundedContent(s, BANK);
  assert.equal(cleaned.experience[0].date_range, '2024');
});

test('H2: an acronym org matches its full-name bank entry and is NOT flagged/pruned as invented', () => {
  const acronymBank: ExperienceBankEntry[] = [
    bankEntry({
      id: 'mit',
      org: 'Massachusetts Institute of Technology',
      title: 'Research Assistant',
      date_range: '2024',
      bullet_variants: ['Built a robotics controller for the lab'],
      tags: ['robotics'],
    }),
  ];
  const s = spec([
    {
      org: 'MIT', // acronym of the full bank org; shares zero tokens with it
      title: 'Research Assistant',
      date_range: '2024',
      bullets: ['Built a robotics controller for the lab'],
    },
  ]);
  // Must NOT be treated as an invented org.
  assert.deepEqual(
    findGroundingViolations(s, acronymBank).filter((v) => v.kind === 'org'),
    [],
  );
  // ...and pruning must keep the real entry rather than silently dropping it.
  const { spec: cleaned, removed } = pruneUngroundedContent(s, acronymBank);
  assert.equal(cleaned.experience.length, 1);
  assert.equal(cleaned.experience[0].org, 'MIT');
  assert.deepEqual(removed, []);

  // Reverse direction: bank stores the acronym, generated uses the full name.
  const acronymStoredBank: ExperienceBankEntry[] = [
    bankEntry({ id: 'usc', org: 'USC', title: 'TA', bullet_variants: ['Graded assignments'] }),
  ];
  const s2 = spec([
    {
      org: 'University of Southern California',
      title: 'TA',
      date_range: '2024',
      bullets: ['Graded assignments'],
    },
  ]);
  assert.deepEqual(
    findGroundingViolations(s2, acronymStoredBank).filter((v) => v.kind === 'org'),
    [],
  );
});

test('findUngroundedSkills flags a skill absent from the bank but not one present in it', () => {
  const out = findUngroundedSkills(['Python', 'Kubernetes'], BANK);
  assert.ok(out.includes('Kubernetes')); // never appears in any bank entry
  assert.ok(!out.includes('Python')); // 'python' is a tag on the Northwind entry
});

// ─── R-015: the declared skills list is authoritative ───────────────────────
// The cases below are the real fabrications caught on 2026-07-17, verified against the stored
// generated_resumes.spec for 21 real model runs. Each claimed skill returns zero rows when grepped
// across the entire bank.

test('R-015: a JD keyword outside the declared list is ungrounded, even though the JD wants it', () => {
  // The submitted Monzo Analytics Engineer resume claims BigQuery and Looker, neither of which the
  // model had any grounding for: it echoed the JD's headline tools.
  //
  // ⚠️ This test's original comment claimed "Mehek has never used either". That was WRONG, and it is
  // corrected here rather than deleted, because the mistake is instructive. It was inferred from the
  // experience BANK (0 rows for both), but the bank is a seeded, incomplete artifact and is not a
  // record of what she can do. Her own resumes claim Looker on 14 of them and BigQuery on 1, and she
  // confirmed on 2026-07-17 that she has really used both. So the defect was never "it claimed a
  // false skill" - it was "it claimed a skill it had NO WAY OF KNOWING she had", and happened to be
  // right. An ungrounded guess is a defect even when it guesses correctly, which is the whole reason
  // the declared list, not the bank, is the authority.
  //
  // The assertion is unchanged and still exactly right: whatever is not in the declared list is
  // ungrounded, full stop. Here `declared` is a deliberately unrelated list, not Mehek's real one.
  const declared = ['Python', 'TypeScript', 'React'];
  const out = findUngroundedSkills(['Python', 'BigQuery', 'Looker'], BANK, declared);
  assert.deepEqual(out, ['BigQuery', 'Looker']);
});

// ─── Translation: rendering a DECLARED skill in the JD's vocabulary (2026-07-17) ─────────────
// Mehek asked for the SKILLS line to be tailored per JD. Selecting and ordering her real skills is
// plainly fine; ADDING the JD's keywords is R-015 itself and is refused. Renaming sits between them:
// writing a skill she HAS in the words the JD uses is honest and beats the ATS filter. spec
// .skill_source carries the rename so the validator can still enforce truth.

test('translation: a declared skill written in the JD\'s words survives', () => {
  const declared = ['SQL', 'A/B testing'];
  const out = findUngroundedSkills(['ETL', 'experimentation'], BANK, declared, {
    ETL: 'SQL',
    experimentation: 'A/B testing',
  });
  assert.deepEqual(out, [], 'a rename of a declared skill must not be pruned');
});

test('translation CANNOT smuggle in a skill the student never declared', () => {
  // The whole risk of allowing renames. The map is only believed when the thing it claims to rename
  // is itself declared: "Kubernetes" mapped to a skill she does not have grounds nothing.
  const declared = ['SQL', 'Python'];
  const out = findUngroundedSkills(['Kubernetes'], BANK, declared, { Kubernetes: 'Production deployment' });
  assert.deepEqual(out, ['Kubernetes'], 'the renamed-from skill must itself be declared');
});

test('translation cannot launder a skill by pointing at an unrelated declared one', () => {
  // A well-formed map whose target IS declared is the residual risk: the model could mislabel. The
  // prompt's negative examples target it, and the mapping stays visible in skill_source rather than
  // disappearing. Pinning current behaviour honestly: this DOES pass the validator, so the guard is
  // the prompt plus auditability, not this function. If mislabelling ever shows up live, this is the
  // test to change, and a whitelist of accepted renames is the likely answer.
  const declared = ['SQL'];
  const out = findUngroundedSkills(['BigQuery'], BANK, declared, { BigQuery: 'SQL' });
  assert.deepEqual(out, [], 'documents the known limit: a declared target is accepted on trust');
});

test('translation map is ignored when it is absent, malformed, or self-referential junk', () => {
  const declared = ['SQL'];
  assert.deepEqual(findUngroundedSkills(['ETL'], BANK, declared), ['ETL'], 'no map -> no rename');
  assert.deepEqual(findUngroundedSkills(['ETL'], BANK, declared, {}), ['ETL'], 'empty map -> no rename');
  assert.deepEqual(
    findUngroundedSkills(['ETL'], BANK, declared, { Other: 'SQL' }),
    ['ETL'],
    'a map entry for a DIFFERENT term must not ground this one',
  );
});

test('R-015: the declared list overrides the seeded bank tags, which are junk', () => {
  // 'python' is a tag on a bank entry, so soft mode grounds it. But the seeded tags are the
  // identical copy-pasted array on 6 of 7 rows (including a Product Management internship and a VP
  // of Finance role), which is exactly how gRPC and SDK design reached every resume she has sent.
  // A source that is itself unreliable must not be able to launder a claim.
  const out = findUngroundedSkills(['Python'], BANK, ['TypeScript']);
  assert.deepEqual(out, ['Python'], 'declared mode must not consult the bank corpus');
});

test('R-015: declared matching is case- and whitespace-insensitive, not a literal compare', () => {
  const declared = ['REST APIs', 'Python'];
  assert.deepEqual(findUngroundedSkills(['rest apis', '  Python  '], BANK, declared), []);
});

test('R-015: an empty declared list falls back to soft bank-grounding, it does not reject everything', () => {
  // NULL/[] means "the student never gave us a list", NOT "the student has no skills". Getting this
  // wrong would strip the SKILLS line off every resume for every user who hasn't onboarded yet.
  assert.deepEqual(findUngroundedSkills(['Python'], BANK, []), []);
  assert.deepEqual(findUngroundedSkills(['Python'], BANK, null), []);
  assert.deepEqual(findUngroundedSkills(['Python'], BANK, undefined), []);
});

test('R-015: an off-list skill is a HARD issue when a list exists, and a warning when it does not', () => {
  // The hard issue is what drives the retry loop, so the model gets told to fix it rather than the
  // student being handed a fabricated resume with an advisory attached.
  const s = spec([{ org: 'Northwind Labs', title: 'Engineer', date_range: '2024', bullets: [] }]);
  s.skills = ['BigQuery'];

  const declaredMode = validateResumeSpec(s, 'we use bigquery', BANK, ['Python']);
  assert.ok(declaredMode.issues.some((i) => i.includes('BigQuery')), 'should be a hard issue');
  assert.ok(!declaredMode.warnings.some((w) => w.bullet === 'BigQuery'));

  const softMode = validateResumeSpec(s, 'we use bigquery', BANK);
  assert.ok(!softMode.issues.some((i) => i.includes('BigQuery')), 'should not hard-fail with no list');
  assert.ok(softMode.warnings.some((w) => w.bullet === 'BigQuery'), 'should still warn');
});

test('a rename emitted DESPITE the prompt ban is pruned and hard-flagged, not honored', () => {
  // Renaming is disabled in the prompt, and the reason it is disabled is that the model has already
  // ignored that prompt's rules once. So the validator must not honor skill_source either: a ban the
  // validator quietly waives on request is not a ban. "ETL" here renames a genuinely declared "SQL",
  // i.e. the BEST case for a rename, and it must still be pruned until the curated whitelist exists.
  const s = spec([{ org: 'Northwind Labs', title: 'Engineer', date_range: '2024', bullets: [] }]);
  s.skills = ['SQL', 'ETL'];
  s.skill_source = { ETL: 'SQL' };

  const { spec: cleaned, removed } = pruneUngroundedContent(s, BANK, ['SQL']);
  assert.deepEqual(cleaned.skills, ['SQL'], 'the rename must not survive the prune');
  assert.ok(removed.some((r) => r.includes('ETL')));

  const validated = validateResumeSpec(s, 'we use ETL pipelines', BANK, ['SQL']);
  assert.ok(
    validated.issues.some((i) => i.includes('ETL')),
    'the rename must drive the retry as a hard issue',
  );
});

test('R-015: prune strips an off-list skill as a last resort, and keeps the declared ones', () => {
  const s = spec([{ org: 'Northwind Labs', title: 'Engineer', date_range: '2024', bullets: [] }]);
  s.skills = ['Python', 'BigQuery', 'Looker'];
  const { spec: cleaned, removed } = pruneUngroundedContent(s, BANK, ['Python']);
  assert.deepEqual(cleaned.skills, ['Python']);
  assert.ok(removed.some((r) => r.includes('BigQuery') && r.includes('Looker')));
});

test('pruneUngroundedSkills removes only generated off-list skills and keeps editable experience intact', () => {
  const s = spec([{
    org: 'Northwind Labs',
    title: 'Engineer',
    date_range: '2025',
    bullets: ['Built an internal analytics dashboard used by the growth team'],
  }]);
  s.skills = ['Python', 'BigQuery'];

  const { spec: cleaned, removed } = pruneUngroundedSkills(s, BANK, ['Python']);
  assert.deepEqual(cleaned.experience, s.experience);
  assert.deepEqual(cleaned.skills, ['Python']);
  assert.ok(removed.some((r) => r.includes('BigQuery')));
});

test('R-015: prune leaves skills alone in soft mode', () => {
  // Soft grounding must never DROP a skill: the bank is an incomplete view of what a student knows,
  // so a miss there is a reason to warn, not to delete.
  const s = spec([{ org: 'Northwind Labs', title: 'Engineer', date_range: '2024', bullets: [] }]);
  s.skills = ['Python', 'Kubernetes'];
  const { spec: cleaned } = pruneUngroundedContent(s, BANK);
  assert.deepEqual(cleaned.skills, ['Python', 'Kubernetes']);
});

test('pruneUngroundedContent drops the invented entry and the fabricated-metric bullet', () => {
  const s = spec([
    {
      org: 'Globex Corporation', // not in bank -> whole entry dropped
      title: 'Software Engineer',
      date_range: '2024',
      bullets: ['Did things'],
    },
    {
      org: 'Northwind Labs',
      title: 'Software Engineer Intern',
      date_range: '2024',
      bullets: [
        'Built a dashboard serving 40K requests/day for the growth team', // ungrounded metric -> dropped
        'Shipped a caching layer that cut page load time by 30%', // grounded -> kept
      ],
    },
  ]);
  const { spec: cleaned, removed } = pruneUngroundedContent(s, BANK);
  assert.equal(cleaned.experience.length, 1);
  assert.equal(cleaned.experience[0].org, 'Northwind Labs');
  assert.deepEqual(cleaned.experience[0].bullets, [
    'Shipped a caching layer that cut page load time by 30%',
  ]);
  assert.ok(removed.length >= 2);
  // The cleaned spec must now be fully grounded.
  assert.deepEqual(findGroundingViolations(cleaned, BANK), []);
});

// ─── R-022: a short bank org must not hijack the match for a longer one ──────────────────────
//
// Found 2026-07-17 by generating real resumes against live Cohere JDs with Mehek's real bank. Her
// bank holds BOTH "Traeco" (Founder) and "Traeco - AI Agent Cost Infrastructure" (AI Engineer).
// Containment scored the one-word entry 1/min(5,1) = 1.0 and the real entry 5/min(5,5) = 1.0, a
// dead tie that "first one wins" resolved by whichever row Postgres returned first. On the losing
// side the pruner reset her real title to "Founder" and deleted a true bullet, on 4/4 generations.

const traecoBank: ExperienceBankEntry[] = [
  bankEntry({
    id: 'founder',
    org: 'Traeco',
    title: 'Founder',
    bullet_variants: ['Built an AI cost-visibility product and grew the waitlist 35% over two months'],
  }),
  bankEntry({
    id: 'aieng',
    org: 'Traeco - AI Agent Cost Infrastructure',
    title: 'AI Engineer',
    bullet_variants: ['Engineered a Python SDK and orchestration layer, scoped from 50+ discovery interviews'],
  }),
];

const traecoSpec = () =>
  spec([
    {
      org: 'Traeco - AI Agent Cost Infrastructure',
      title: 'AI Engineer',
      date_range: '2024',
      bullets: ['Instrumented orchestration pipelines from 50+ discovery interviews to fix failure patterns.'],
    },
  ]);

test('R-022: the specific bank entry wins over a shorter one sharing a token', () => {
  assert.deepEqual(findGroundingViolations(traecoSpec(), traecoBank), []);
});

test('R-022: the match does not depend on bank row order', () => {
  // The exact failure: no ORDER BY upstream, so the DB may hand these back either way round.
  const reversed = [...traecoBank].reverse();
  assert.deepEqual(findGroundingViolations(traecoSpec(), reversed), []);
  assert.deepEqual(
    pruneUngroundedContent(traecoSpec(), reversed).removed,
    pruneUngroundedContent(traecoSpec(), traecoBank).removed,
  );
});

test('R-022: the pruner no longer rewrites a real title into a different real one', () => {
  for (const b of [traecoBank, [...traecoBank].reverse()]) {
    const { spec: cleaned, removed } = pruneUngroundedContent(traecoSpec(), b);
    assert.equal(cleaned.experience[0].title, 'AI Engineer', 'her real title must survive');
    assert.equal(removed.length, 0, `nothing should be pruned, got: ${removed.join('; ')}`);
  }
});

test('R-022: a grounded metric is not dropped just because a sibling entry lacks it', () => {
  // "50+" lives in the AI Engineer entry, not the Founder one. Matching the wrong sibling made a
  // true bullet look fabricated and deleted it.
  const violations = findGroundingViolations(traecoSpec(), traecoBank).filter((v) => v.kind === 'metric');
  assert.deepEqual(violations, []);
});

test('R-022: a genuinely invented org is still caught', () => {
  // The gate must not have been loosened into uselessness by the ranking change.
  const invented = spec([{ org: 'Globex Corporation', title: 'Engineer', date_range: '2024', bullets: ['Shipped a thing.'] }]);
  assert.ok(findGroundingViolations(invented, traecoBank).some((v) => v.kind === 'org'));
});

test('R-022: a less specific spec org still matches its only plausible bank entry', () => {
  // Containment still gates, so the tolerated "spec says less than the bank" case keeps working.
  const short = spec([{ org: 'Traeco', title: 'Founder', date_range: '2024', bullets: ['Built an AI cost-visibility product.'] }]);
  assert.deepEqual(findGroundingViolations(short, traecoBank).filter((v) => v.kind === 'org'), []);
});

// ─── R-023: an unreachable gate must not drive the retry loop ────────────────────────────────
//
// jdKeywords() treats every non-stopword JD word over 3 chars as a required keyword: 304 of them
// for a 4.8k Cohere posting, including "toronto", "vacation", "passionate", "obsess". Measured
// 2026-07-17 against Mehek's real bank: her ENTIRE bank (7 entries, 409 words, ~3x what fits on a
// page) covers only 12-17%. Nothing she could write reaches the 18% floor, so this fired on 100%
// of generations, forced a second model call that could never clear it, and fed the model
// "not tailored enough to this JD" as a fix-this instruction, which is how JD vocabulary got
// imported into the skills line.

test('R-023: low ATS coverage is reported but does NOT become a retry-driving issue', () => {
  const bank = [bankEntry({ org: 'Northwind Labs', title: 'Engineer', bullet_variants: ['Shipped a Python service.'] })];
  const s = spec([{ org: 'Northwind Labs', title: 'Engineer', date_range: '2024', bullets: ['Shipped a Python service.'] }]);
  // A JD sharing almost no vocabulary with the resume: coverage is necessarily near zero.
  const jd = 'Kubernetes Rust Terraform observability oncall distributed consensus Byzantine tolerance quorum replication sharding';
  const r = validateResumeSpec(s, jd, bank);

  assert.ok(r.ats_keyword_coverage_pct < 18, 'precondition: coverage is below the floor');
  assert.equal(
    r.issues.some((i) => /keyword coverage/i.test(i)),
    false,
    'coverage must not be a hard issue: it is unreachable, so it would retry forever and pressure the model to stuff JD keywords',
  );
  assert.ok(
    r.warnings.some((w) => w.entry === 'ats' && w.flags.some((f) => /low-keyword-coverage/.test(f))),
    'but it must still be surfaced as a warning so a genuinely untailored resume is visible',
  );
});

test('R-023: the coverage number is still computed and reported', () => {
  const bank = [bankEntry({ org: 'Northwind Labs', bullet_variants: ['Built Python REST services.'] })];
  const s = spec([{ org: 'Northwind Labs', title: 'Engineer', date_range: '2024', bullets: ['Built Python REST services.'] }]);
  const r = validateResumeSpec(s, 'python python python rest rest services services engineer', bank);
  assert.ok(typeof r.ats_keyword_coverage_pct === 'number' && r.ats_keyword_coverage_pct > 0);
});

// ─── R-022 follow-up: a literal token match must beat an initialism inference ────────────────
//
// Caught in code review of the R-022 fix itself. Ranking word matches by Jaccard while the acronym
// branch still returned a flat 1 meant the weaker evidence won: a spec's "MIT" scored 1/3 against
// "MIT Media Lab" but 1.0 against "Massachusetts Institute of Technology". The H2 test above misses
// this because its bank holds a single entry, so nothing competes for the match.

const acronymCompetitionBank: ExperienceBankEntry[] = [
  bankEntry({ id: 'lab', org: 'MIT Media Lab', title: 'Researcher', bullet_variants: ['Built a tangible interface.'] }),
  bankEntry({ id: 'uni', org: 'Massachusetts Institute of Technology', title: 'Student', bullet_variants: ['Studied things.'] }),
];

test('R-022: a literal shared token outranks an initialism when both are in the bank', () => {
  const s = spec([{ org: 'MIT', title: 'Researcher', date_range: '2024', bullets: ['Built a tangible interface.'] }]);
  assert.deepEqual(
    findGroundingViolations(s, acronymCompetitionBank),
    [],
    '"MIT" must resolve to MIT Media Lab, not to the university it is also an initialism of',
  );
});

test('R-022: that ranking does not depend on bank row order either', () => {
  const s = spec([{ org: 'MIT', title: 'Researcher', date_range: '2024', bullets: ['Built a tangible interface.'] }]);
  assert.deepEqual(findGroundingViolations(s, [...acronymCompetitionBank].reverse()), []);
});

test('R-022: the pruner does not rewrite the title via the losing acronym match', () => {
  for (const b of [acronymCompetitionBank, [...acronymCompetitionBank].reverse()]) {
    const { spec: cleaned, removed } = pruneUngroundedContent(
      spec([{ org: 'MIT', title: 'Researcher', date_range: '2024', bullets: ['Built a tangible interface.'] }]),
      b,
    );
    assert.equal(cleaned.experience[0].title, 'Researcher');
    assert.equal(removed.length, 0, `nothing should be pruned, got: ${removed.join('; ')}`);
  }
});

test('R-022: an acronym still matches when it is the ONLY evidence available', () => {
  // The tier must not disable the acronym path, only rank it below a literal match (guards H2).
  const uniOnly = [acronymCompetitionBank[1]];
  const s = spec([{ org: 'MIT', title: 'Student', date_range: '2024', bullets: ['Studied things.'] }]);
  assert.deepEqual(findGroundingViolations(s, uniOnly).filter((v) => v.kind === 'org'), []);
});

/* THE BULLET LENGTH REPAIR PASS.
 *
 * overlongBullets exists so the base-resume build can FIX a too-long bullet instead of failing the
 * ATS gate on it. These tests hold it to the one property that matters: it must flag exactly what
 * validateResumeSpec would reject, no more and no less. If the two ever disagree, the repair loop
 * either spins on a bullet the gate is happy with or hands the gate a bullet it never repaired. */

const LONG_BULLET_239 =
  'Designed automated monitoring system detecting partnership failures before escalation: defined 8 leading indicators from historical dropout patterns, built threshold-based alerting across 96 pairs, recovering 9 of 14 at-risk relationships.';

test('the bullet that failed a real build on 2026-08-04 is flagged, with its overage', () => {
  assert.equal(LONG_BULLET_239.length, 239, 'the fixture must stay the bullet that actually failed');
  const found = overlongBullets(
    spec([{ org: 'Cinematica Labs', title: 'Intern', date_range: '2025', bullets: [LONG_BULLET_239] }]),
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].org, 'Cinematica Labs');
  assert.equal(found[0].length, 239);
  assert.equal(found[0].bullet, LONG_BULLET_239, 'the whole bullet goes back, so the model can trim it');
});

test('the boundary is exactly BULLET_MAX_CHARS: 235 is legal, 236 is not', () => {
  const at = 'Built '.padEnd(BULLET_MAX_CHARS, 'x');
  const over = 'Built '.padEnd(BULLET_MAX_CHARS + 1, 'x');
  assert.equal(at.length, BULLET_MAX_CHARS);
  assert.deepEqual(overlongBullets(spec([{ org: 'Acme', title: 'E', date_range: '2024', bullets: [at] }])), []);
  assert.equal(
    overlongBullets(spec([{ org: 'Acme', title: 'E', date_range: '2024', bullets: [over] }]))[0].length,
    BULLET_MAX_CHARS + 1,
  );
});

test('it flags every offender across entries, not just the first', () => {
  const found = overlongBullets(
    spec([
      { org: 'Acme', title: 'E', date_range: '2024', bullets: ['Built a short one.', LONG_BULLET_239] },
      { org: 'Globex', title: 'E', date_range: '2023', bullets: [LONG_BULLET_239] },
    ]),
  );
  assert.deepEqual(found.map((b) => b.org), ['Acme', 'Globex']);
});

test('it agrees with the gate: anything it clears raises no length issue in validateResumeSpec', () => {
  // The repair loop breaks when this returns empty, so an under-strict helper would ship a spec
  // straight into a gate failure the loop had already declared clean.
  const trimmed = `${LONG_BULLET_239.slice(0, 200).trim()}.`;
  const s = spec([{ org: 'Acme', title: 'Engineer', date_range: '2024', bullets: [trimmed] }]);
  assert.deepEqual(overlongBullets(s), []);
  const lengthIssues = validateResumeSpec(s, '', BANK, [], undefined).issues.filter((i) => i.includes('exceeds'));
  assert.deepEqual(lengthIssues, []);
});

test('it agrees with the gate the other way: what it flags, the gate rejects', () => {
  const s = spec([{ org: 'Acme', title: 'Engineer', date_range: '2024', bullets: [LONG_BULLET_239] }]);
  assert.equal(overlongBullets(s).length, 1);
  const lengthIssues = validateResumeSpec(s, '', BANK, [], undefined).issues.filter((i) => i.includes('exceeds'));
  assert.equal(lengthIssues.length, 1, `expected the gate to reject it, got: ${lengthIssues.join('; ')}`);
});

test('a spec with no experience does not throw', () => {
  assert.deepEqual(overlongBullets({ ...spec([]), experience: undefined } as unknown as ResumeSpec), []);
});

/* Her own main resume is not a generation. The declared list and the uploaded document are two
 * stores of the same fact; when they drift (Hudson River Trading, application 4a79eec1,
 * 2026-09-01: four skills she wrote on her own resume were missing from the declared list), the
 * generator's skills gate must not refuse the document she uploaded. It stays a warning there and
 * a hard issue on every tailored packet. */
test('an untailored main-resume packet is not refused for skills off the declared list', () => {
  const declared = ['Python', 'TypeScript', 'SQL'];
  const uploaded = { ...spec([{
    org: 'Northwind Labs',
    title: 'Software Engineer Intern',
    date_range: '2024',
    bullets: [
      'Built an internal analytics dashboard used by the growth team',
      'Shipped a caching layer that cut page load time by 30%',
    ],
  }]), skills: ['Python', 'wireframing', 'mobile UX'] };

  const tailored = validateResumeSpec(uploaded, 'We want wireframing and mobile UX', BANK, declared);
  assert.deepEqual(
    tailored.issues.filter((issue) => issue.startsWith('grounding: skill')),
    [
      'grounding: skill "wireframing" is not in the student\'s skills list; never add a skill because the JD asks for it',
      'grounding: skill "mobile UX" is not in the student\'s skills list; never add a skill because the JD asks for it',
    ],
  );

  const own = validateResumeSpec(uploaded, 'We want wireframing and mobile UX', BANK, declared, undefined, undefined, { untailored: true });
  assert.equal(own.issues.some((issue) => issue.startsWith('grounding: skill')), false);
  assert.deepEqual(
    own.warnings.filter((warning) => warning.flags.includes('ungrounded-skill')).map((warning) => warning.bullet),
    ['wireframing', 'mobile UX'],
  );
  // Every other rule is untouched by the flag: an invented employer is still a hard issue.
  const invented = validateResumeSpec(
    { ...uploaded, experience: [{ org: 'Nowhere Inc', title: 'Engineer', date_range: '2024', bullets: ['Built an internal analytics dashboard used by the growth team'] }] },
    '',
    BANK,
    declared,
    undefined,
    undefined,
    { untailored: true },
  );
  assert.ok(invented.issues.some((issue) => issue.startsWith('grounding: experience entry')));
});
