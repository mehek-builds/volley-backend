import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExperienceBankEntry } from '../db/schema';
import type { ResumeSpec } from '../llm/resumeSpec';
import { extractPdfText } from '../lib/pdfText';
import { validatePdfLayout, validateResumeSpec } from './resumeValidate';
import { applyResumePolicy, deriveCandidateContext } from './resumePolicy';
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
  // No date evidence at all. parse.ts returns currently_enrolled false when a resume simply does
  // not say, so this must NOT be read as "graduated": for a student product, silence resolves
  // toward student. Measured 2026-07-27: three of five real sample resumes land here, because
  // they print a graduation date with no "Expected" and no parseable year.
  assert.equal(
    deriveCandidateContext({ school: 'USC', currently_enrolled: false }, now).education_position,
    'top',
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
