import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findGroundingViolations,
  findUngroundedSkills,
  pruneUngroundedContent,
  validateResumeSpec,
} from './resumeValidate';
import type { ResumeSpec } from '../llm/resumeSpec';
import type { ExperienceBankEntry } from '../db/schema';

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

test('R-015: a JD keyword the student never claimed is ungrounded, even though the JD wants it', () => {
  // The submitted Monzo Analytics Engineer resume claims BigQuery and Looker. Mehek has never used
  // either; they are simply the JD's headline tools, echoed back. That application went out on
  // 2026-07-16 and a recruiter will ask about them in a screen.
  const declared = ['Python', 'TypeScript', 'React'];
  const out = findUngroundedSkills(['Python', 'BigQuery', 'Looker'], BANK, declared);
  assert.deepEqual(out, ['BigQuery', 'Looker']);
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

test('R-015: prune strips an off-list skill as a last resort, and keeps the declared ones', () => {
  const s = spec([{ org: 'Northwind Labs', title: 'Engineer', date_range: '2024', bullets: [] }]);
  s.skills = ['Python', 'BigQuery', 'Looker'];
  const { spec: cleaned, removed } = pruneUngroundedContent(s, BANK, ['Python']);
  assert.deepEqual(cleaned.skills, ['Python']);
  assert.ok(removed.some((r) => r.includes('BigQuery') && r.includes('Looker')));
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
