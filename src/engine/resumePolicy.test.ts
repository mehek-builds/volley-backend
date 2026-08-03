import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExperienceBankEntry } from '../db/schema';
import type { ResumeSpec } from '../llm/resumeSpec';
import { extractPdfText } from '../lib/pdfText';
import { validatePdfLayout, validateResumeSpec } from './resumeValidate';
import { applyResumePolicy, deriveCandidateContext, enforceExperienceBulletFloor } from './resumePolicy';
import { planResumeLayout, renderResumePdf } from './resumeRender';

function bankEntry(
  id: string,
  type: string,
  org: string,
  title: string,
  bullets: string[],
): ExperienceBankEntry {
  return {
    id,
    user_id: 'user-1',
    type,
    org,
    title,
    date_range: '2025 - Present',
    bullet_variants: bullets,
    tags: [],
    created_at: new Date('2026-01-01'),
  } as ExperienceBankEntry;
}

const BANK = [
  bankEntry('1', 'job', 'Acme Labs', 'Product Intern', [
    'Analyzed customer interviews and translated findings into launch priorities for the product team',
    'Built weekly dashboards that tracked activation across three onboarding paths',
    'Presented research findings to leaders and secured approval for two experiments',
  ]),
  bankEntry('2', 'project', 'Campus Search', 'Project Lead', [
    'Built a TypeScript search service that indexed 10,000 campus resources',
    'Optimized PostgreSQL queries and cut median response time by 30%',
    'Deployed the service with automated tests and monitored production errors',
  ]),
  bankEntry('3', 'leadership', 'Women in Computing', 'President', [
    'Led 12 volunteers and grew workshop attendance by 40%',
    'Secured five company sponsors for the annual student conference',
    'Mentored 20 students through technical interview practice',
  ]),
];

function rawSpec(): ResumeSpec {
  return {
    school: 'Invented University',
    degree: 'MBA',
    grad_date: 'May 2027',
    coursework: 'Quantum Hiring',
    education_position: 'after_experience',
    experience: BANK.map((entry) => ({
      type: entry.type as 'job' | 'project' | 'leadership',
      org: entry.org,
      title: entry.title ?? '',
      date_range: entry.date_range ?? '',
      bullets: entry.bullet_variants as string[],
    })),
    skills: ['TypeScript', 'PostgreSQL', 'Research', 'Figma', 'Python', 'SQL'],
  };
}

test('student status comes from uploaded education evidence, not a universal graduation date', () => {
  const now = new Date('2026-07-20T00:00:00Z');
  assert.equal(
    deriveCandidateContext({ school: 'USC', grad_date: 'May 2028', currently_enrolled: true }, now).education_position,
    'top',
  );
  assert.equal(
    deriveCandidateContext({ school: 'USC', grad_date: 'May 2028', currently_enrolled: false }, now).education_position,
    'after_experience',
  );
  assert.equal(
    deriveCandidateContext({ school: 'USC', grad_year: 2028 }, now).education_position,
    'top',
  );
  // CHANGED 2026-07-27, on an explicit product instruction: education leads the page for current
  // students AND recent graduates. May 2025 against a July 2026 clock is 14 months ago, which is
  // squarely "recently graduated", so this now expects 'top' where it previously expected
  // 'after_experience'. currently_enrolled is still false here (the date is in the past) - it is
  // the recency of the degree, not enrolment, that earns it the top slot.
  assert.equal(
    deriveCandidateContext({ school: 'USC', grad_date: 'May 2025', currently_enrolled: true }, now).education_position,
    'top',
  );
  assert.equal(
    deriveCandidateContext({ school: 'USC', currently_enrolled: true }, now).education_position,
    'top',
  );
  // A degree finished long enough ago that the work history leads instead. This is the case that
  // keeps the rule meaningful: without it, education would lead unconditionally.
  assert.equal(
    deriveCandidateContext({ school: 'USC', grad_date: 'May 2018', currently_enrolled: false }, now).education_position,
    'after_experience',
  );
  // No date evidence in either direction. CHANGED 2026-07-27 with the audience: for a student
  // product silence resolved toward student, for a job-seeker product it resolves toward finished,
  // because leading with an undated degree buries the work history an employer reads for. A real
  // current student is unaffected: a future graduation date already sets currently_enrolled above.
  assert.equal(
    deriveCandidateContext({ school: 'USC', currently_enrolled: false }, now).education_position,
    'after_experience',
  );
});

test('policy maps acronym organizations back to the correct source entry type', () => {
  const acronymBank = [
    bankEntry(
      'mit',
      'project',
      'Massachusetts Institute of Technology',
      'Research Project',
      ['Built a robotics controller for the autonomous systems lab'],
    ),
  ];
  const spec = rawSpec();
  spec.experience = [{
    org: 'MIT',
    title: 'Research Project',
    date_range: '2025',
    bullets: ['Built a robotics controller for the autonomous systems lab'],
  }];
  const result = applyResumePolicy(spec, { school: 'USC', grad_date: 'May 2028' }, acronymBank, 'robotics systems');
  assert.equal(result.spec.experience[0].type, 'project');
});

test('policy restores exact education facts and uses only uploaded coursework', () => {
  const education = {
    school: 'University of Southern California',
    degree: 'B.S. Business Administration',
    grad_date: 'May 2028',
    grad_year: 2028,
    currently_enrolled: true,
    coursework: ['Data Structures', 'Statistics'],
  };
  const { spec } = applyResumePolicy(rawSpec(), education, BANK, 'TypeScript PostgreSQL search service engineering', { now: new Date('2026-07-20') });
  assert.equal(spec.school, education.school);
  assert.equal(spec.degree, education.degree);
  assert.equal(spec.grad_date, education.grad_date);
  assert.equal(spec.coursework, 'Data Structures, Statistics');
  assert.equal(spec.education_position, 'top');
  assert.equal(spec.experience[0].org, 'Acme Labs');
  assert.equal(spec.experience[0].type, 'job');
});

test('policy preserves the model order that follows the JD priority order', () => {
  const spec = rawSpec();
  spec.experience = [
    {
      ...spec.experience[0],
      bullets: [
        'Presented research findings to leaders and secured approval for two experiments',
        'Built weekly dashboards that tracked activation across three onboarding paths',
      ],
    },
    spec.experience[1],
  ];

  const result = applyResumePolicy(
    spec,
    { school: 'USC', grad_date: 'May 2028' },
    BANK,
    'First prioritize research. Later, TypeScript PostgreSQL search service engineering dashboards activation.',
  );

  assert.equal(result.spec.experience[0].org, 'Acme Labs');
  assert.equal(
    result.spec.experience[0].bullets[0],
    'Presented research findings to leaders and secured approval for two experiments',
  );
});

test('validator blocks fabricated education and coursework', () => {
  const education = {
    school: 'University of Southern California',
    degree: 'B.S. Business Administration',
    grad_date: 'May 2028',
    currently_enrolled: true,
    coursework: ['Statistics'],
  };
  const result = validateResumeSpec(rawSpec(), 'product research analytics', BANK, undefined, education);
  assert.ok(result.issues.includes('education school differs from uploaded resume'));
  assert.ok(result.issues.includes('education degree differs from uploaded resume'));
  assert.ok(result.issues.includes('education graduation date differs from uploaded resume'));
  assert.ok(result.issues.includes('coursework contains a course not listed on the uploaded resume'));
});

test('layout planner removes the lowest-fit evidence, records omissions, and renders one ATS-readable page', async () => {
  const expanded = rawSpec();
  expanded.experience = [...expanded.experience, ...expanded.experience.map((entry, index) => ({
    ...entry,
    org: `${entry.org} ${index}`,
    bullets: entry.bullets.map((bullet) => `${bullet} while documenting decisions for cross-functional partners and maintaining clear weekly progress reports`),
  }))];
  expanded.skills = Array.from({ length: 24 }, (_, index) => `Skill ${index + 1}`);
  const contact = {
    full_name: 'Jordan Candidate',
    email: 'jordan@example.com',
    phone: '+1 555 010 1000',
    linkedin_url: 'linkedin.com/in/jordan-candidate',
    github_url: 'github.com/jordan-candidate',
    portfolio_url: 'jordan-candidate.example.com',
  };
  const plan = planResumeLayout(expanded, contact, 'TypeScript PostgreSQL search engineering');
  assert.equal(plan.spec.experience.length <= 4, true);
  assert.equal(plan.trimmed, true);
  assert.equal(plan.omissions.length > 0, true);

  const rendered = await renderResumePdf(expanded, contact, 'TypeScript PostgreSQL search engineering');
  const pdf = await extractPdfText(rendered.buffer);
  const validation = validatePdfLayout(pdf.text, pdf.numpages);
  assert.equal(pdf.numpages, 1);
  assert.equal(validation.issues.length, 0);
  assert.deepEqual(rendered.spec, plan.spec);
});

test('policy deterministically sets a resume-safe exact target role headline', () => {
  const result = applyResumePolicy(
    rawSpec(),
    { school: 'USC', grad_date: 'May 2028' },
    BANK,
    'analytics engineering',
    {
      now: new Date('2026-07-20'),
      targetRole: `  Senior Analytics Engineer ${String.fromCharCode(0x2014)} Growth  `,
    },
  );
  assert.equal(result.spec.target_role, 'Senior Analytics Engineer - Growth');
});

test('policy preserves a generated target role when the route has no role context', () => {
  const input = rawSpec();
  input.target_role = 'Analytics Engineer';
  const result = applyResumePolicy(input, { school: 'USC' }, BANK, 'analytics engineering');
  assert.equal(result.spec.target_role, 'Analytics Engineer');
});

test('three-bullet backstop fills from grounded variants and drops unsupported sparse entries', () => {
  const input = rawSpec();
  const sourceBullets = BANK[0].bullet_variants as string[];
  input.experience[0].bullets = [sourceBullets[0], sourceBullets[1]];
  input.experience[1].bullets = ['Built one grounded line for a project that has no additional evidence'];
  const sparseBank = BANK.map((entry) => entry.id === '2' ? { ...entry, bullet_variants: input.experience[1].bullets } : entry);
  const result = enforceExperienceBulletFloor(input, sparseBank);
  assert.equal(result.experience[0].bullets.length, 3);
  assert.equal(result.experience.some((entry) => entry.org === 'Campus Search'), false);
});

test('ATS validation checks the exact post-backstop resume, not unused source-bank bullets', () => {
  const printedBullets = [
    'Implemented automated tests that improved deployment confidence across the release pipeline',
    'Improved continuous integration checks for every production pull request and release',
    'Added automated tests and improved release confidence across the deployment pipeline',
  ];
  const source = bankEntry('final-content', 'project', 'Release Toolkit', 'Software Engineer', [
    ...printedBullets,
    'Maintained the repository and helped teammates with routine deployment tasks',
  ]);
  const streamed: ResumeSpec = {
    school: 'USC',
    degree: 'BS Computer Science',
    grad_date: 'May 2028',
    coursework: '',
    experience: [{
      type: 'project',
      org: source.org,
      title: source.title ?? '',
      date_range: source.date_range ?? '',
      bullets: printedBullets.slice(0, 2),
    }],
    skills: [],
  };

  const finalResume = enforceExperienceBulletFloor(streamed, [source]);
  assert.deepEqual(finalResume.experience[0].bullets, printedBullets);

  const validation = validateResumeSpec(finalResume, '', [source]);
  assert.equal(
    validation.issues.some((issue) => issue.includes('bullet not action-verb-first')),
    false,
    validation.issues.join('; '),
  );
  assert.equal(
    validation.issues.some((issue) => issue.includes('Maintained')),
    false,
    'an unused source-bank bullet is not part of the final resume ATS gate',
  );
});

test('three-bullet backstop uses the matching role when one organization has multiple roles', () => {
  const analyst = bankEntry('analyst', 'job', 'Acme Labs', 'Data Analyst', [
    'Analyzed customer cohorts and identified three activation opportunities',
    'Built weekly dashboards for product and revenue leaders',
    'Automated reporting workflows and reduced manual reconciliation time',
  ]);
  const managerBullets = [
    'Led eight engineers across platform and infrastructure projects',
    'Launched an incident review process across two technical teams',
    'Mentored four engineers into expanded technical leadership roles',
  ];
  const manager = bankEntry('manager', 'job', 'Acme Labs', 'Engineering Manager', managerBullets);
  const input = rawSpec();
  input.experience = [{
    type: 'job',
    org: 'Acme Labs',
    title: 'Engineering Manager',
    date_range: '2025 - Present',
    bullets: [managerBullets[0]],
  }];
  const result = enforceExperienceBulletFloor(input, [analyst, manager]);
  assert.deepEqual(result.experience[0].bullets, managerBullets);
});

test('only an explicitly continued recent entry may remain sparse', () => {
  const input = rawSpec();
  const sourceBullets = BANK[0].bullet_variants as string[];
  input.experience = [{ ...input.experience[0], bullets: [sourceBullets[0]] }];
  const sparseBank = [{ ...BANK[0], bullet_variants: input.experience[0].bullets }];
  assert.equal(enforceExperienceBulletFloor(input, sparseBank).experience.length, 0);
  assert.equal(enforceExperienceBulletFloor(input, sparseBank, {
    priorityEntryId: BANK[0].id,
    allowSparsePriority: true,
  }).experience[0].bullets.length, 1);
});
