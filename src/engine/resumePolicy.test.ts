import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExperienceBankEntry } from '../db/schema';
import type { ResumeSpec } from '../llm/resumeSpec';
import { extractPdfText } from '../lib/pdfText';
import { validatePdfLayout, validateResumeSpec } from './resumeValidate';
import { allowedSparseEntriesForGeneration, applyResumePolicy, deriveCandidateContext, educationGpaLine, enforceExperienceBulletFloor, orgScore, SAME_EMPLOYER_SCORE } from './resumePolicy';
import { planResumeLayout, renderResumePdf } from './resumeRender';
import { RESUME_CONTENT_LIMITS } from './resumeContentPolicy';

test('provider-outage continuity preserves a grounded one-bullet entry for review', () => {
  const source = bankEntry('sparse', 'job', 'Acme', 'Intern', ['Helped users']);
  const spec = {
    school: 'USC', degree: 'B.S.', grad_date: '2027', coursework: '', skills: [],
    experience: [{ type: 'job' as const, org: 'Acme', title: 'Intern', date_range: '2025 - Present', bullets: ['Helped users'] }],
  };
  assert.equal(enforceExperienceBulletFloor(spec, [source]).experience.length, 0);
  assert.equal(enforceExperienceBulletFloor(spec, [source], { allowSparseAll: true }).experience.length, 1);
});

test('provider-outage continuity takes precedence over a prior continue-with-found review', () => {
  const priority = bankEntry('priority', 'job', 'Acme', 'Intern', ['Helped users']);
  const second = bankEntry('second', 'project', 'Campus Search', 'Builder', ['Built search']);
  assert.deepEqual(
    allowedSparseEntriesForGeneration('local_fallback', [priority, second], [priority], true),
    [priority, second],
  );
  assert.deepEqual(
    allowedSparseEntriesForGeneration('model', [priority, second], [priority], true),
    [priority],
  );
});

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

test('the backstop fills from grounded variants and drops entries under the floor', () => {
  /* The floor moved from three to two on 2026-08-20 (see resumeContentPolicy), so this asserts the
     two behaviours that did NOT change: an entry is topped up from the student's OWN bank rather
     than padded, and an entry that still cannot reach the floor is dropped. The entry here holds a
     single bullet with no other evidence, and one is still never enough. */
  const input = rawSpec();
  const sourceBullets = BANK[0].bullet_variants as string[];
  input.experience[0].bullets = [sourceBullets[0]];
  input.experience[1].bullets = ['Built one grounded line for a project that has no additional evidence'];
  const sparseBank = BANK.map((entry) => entry.id === '2' ? { ...entry, bullet_variants: input.experience[1].bullets } : entry);
  const result = enforceExperienceBulletFloor(input, sparseBank);
  // Topped up from the bank to the floor rather than left short or dropped.
  assert.equal(result.experience[0].bullets.length, RESUME_CONTENT_LIMITS.minBulletsPerEntry);
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

  /* Two bullets MEETS the floor now, so the backstop leaves them alone rather than topping up to
     three. The point of this case is unchanged and is about what the ATS gate reads: the resume as
     printed, not the unused fourth bullet sitting in the source bank. */
  const finalResume = enforceExperienceBulletFloor(streamed, [source]);
  assert.deepEqual(finalResume.experience[0].bullets, printedBullets.slice(0, 2));

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

test('the backstop uses the matching role when one organization has multiple roles', () => {
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
  /* The subject here is WHOSE bullets get used, not how many: the top-up must come from the
     Engineering Manager row and never from the Data Analyst row at the same organisation. It fills
     to the floor, which is two. */
  const result = enforceExperienceBulletFloor(input, [analyst, manager]);
  assert.deepEqual(result.experience[0].bullets, managerBullets.slice(0, RESUME_CONTENT_LIMITS.minBulletsPerEntry));
  assert.equal(
    result.experience[0].bullets.some((bullet) => bullet.includes('cohorts')),
    false,
    "the top-up reached into the other role at the same organisation",
  );
});

/* THE BACKSTOP FOR ACCOUNTS WHOSE BANK WAS ALREADY POISONED.
 *
 * The ingestion fixes (routes/profile.ts dropRestatedBankEntries, db/experienceBank.ts identity)
 * stop a second row being written for one venture, but they do nothing for the rows written before
 * they existed. Measured on production 2026-09-01, three accounts carried a pair of same-org rows
 * with byte-identical bullet arrays, and one of them reached a live resume: Tonee printed as a
 * `project` titled AI Engineer and again as a `job` titled Founder, same date range, same three
 * sentences, split across PROJECTS and EXPERIENCE by the renderer. */
test('a bullet already printed under an earlier entry is not printed again', () => {
  const shared = [
    'Shipped consumer mobile app end-to-end; designed feature set and UX in Figma for 100+ users',
    'Conducted 47 user interviews and analyzed 8,300+ behavioral data points across three markets',
    'Evaluated 3 technical architectures and cut mobile inference latency from 2.3s to 0.1s',
  ];
  const project = bankEntry('p', 'project', 'Tonee - AI Texting Tone Detector', 'AI Engineer', shared);
  const job = bankEntry('j', 'job', 'Tonee - AI Texting Tone Detector', 'Founder', shared);
  const input = rawSpec();
  input.experience = [
    { type: 'project', org: 'Tonee - AI Texting Tone Detector', title: 'AI Engineer', date_range: '2025 - Present', bullets: [...shared] },
    { type: 'job', org: 'Tonee - AI Texting Tone Detector', title: 'Founder', date_range: '2025 - Present', bullets: [...shared] },
  ];

  const result = enforceExperienceBulletFloor(input, [project, job]);
  assert.equal(result.experience.length, 1, 'the wholly duplicated entry is dropped, not left empty');
  assert.equal(result.experience[0].title, 'AI Engineer', 'keep-first, so lead_alignment still cites entry one');
  const printed = result.experience.flatMap((entry) => entry.bullets);
  assert.equal(new Set(printed).size, printed.length, 'no sentence is printed twice');
});

/* Punctuation is typography, not a different claim. The two production copies of the Tonee latency
   bullet differed by ONE character: an em dash on the project row where the job row had a comma. */
test('a repeat differing only in punctuation still counts as already printed', () => {
  const withDash = 'Evaluated 3 technical architectures and cut inference latency from 2.3s to 0.1s - enabling real-time use';
  const withComma = 'Evaluated 3 technical architectures and cut inference latency from 2.3s to 0.1s, enabling real-time use';
  const others = [
    'Shipped consumer mobile app end-to-end; designed feature set and UX in Figma for 100+ users',
    'Conducted 47 user interviews and analyzed 8,300+ behavioral data points across three markets',
  ];
  const first = bankEntry('a', 'project', 'Tonee', 'AI Engineer', [withDash, ...others]);
  const second = bankEntry('b', 'job', 'Tonee', 'Founder', [withComma, ...others]);
  const input = rawSpec();
  input.experience = [
    { type: 'project', org: 'Tonee', title: 'AI Engineer', date_range: '2025 - Present', bullets: [withDash, others[0]] },
    { type: 'job', org: 'Tonee', title: 'Founder', date_range: '2025 - Present', bullets: [withComma, others[1]] },
  ];

  const result = enforceExperienceBulletFloor(input, [first, second]);
  const printed = result.experience.flatMap((entry) => entry.bullets);
  assert.equal(
    printed.filter((bullet) => bullet.includes('2.3s to 0.1s')).length,
    1,
    'the comma copy is the same sentence as the dash copy',
  );
});

/* The top-up reads bullet_variants, so a duplicated venture's second row can refill exactly what
   the dedupe just removed. The shared set has to cover the top-up as well as the model's output. */
test('the bullet top-up cannot re-add a sentence an earlier entry already printed', () => {
  const shared = [
    'Shipped consumer mobile app end-to-end; designed feature set and UX in Figma for 100+ users',
    'Conducted 47 user interviews and analyzed 8,300+ behavioral data points across three markets',
    'Evaluated 3 technical architectures and cut mobile inference latency from 2.3s to 0.1s',
  ];
  const first = bankEntry('a', 'job', 'Tonee', 'Founder', shared);
  const second = bankEntry('b', 'project', 'Tonee', 'AI Engineer', shared);
  const input = rawSpec();
  input.experience = [
    { type: 'job', org: 'Tonee', title: 'Founder', date_range: '2025 - Present', bullets: [...shared] },
    // One bullet, so the floor will try to top this entry up out of its own bank row.
    { type: 'project', org: 'Tonee', title: 'AI Engineer', date_range: '2025 - Present', bullets: [shared[0]] },
  ];

  const result = enforceExperienceBulletFloor(input, [first, second]);
  const printed = result.experience.flatMap((entry) => entry.bullets);
  assert.equal(new Set(printed).size, printed.length);
});

/* An entry emptied by the dedupe is a heading over white space, which pruneUngroundedContent
   refuses to emit for the same reason. The sparse allowances exist for a thin REAL entry and must
   not wave an empty shell through. */
test('provider-outage continuity still drops an entry the dedupe emptied', () => {
  const shared = ['Shipped consumer mobile app end-to-end; designed the feature set and UX in Figma'];
  const first = bankEntry('a', 'job', 'Tonee', 'Founder', shared);
  const second = bankEntry('b', 'project', 'Tonee', 'AI Engineer', shared);
  const input = rawSpec();
  input.experience = [
    { type: 'job', org: 'Tonee', title: 'Founder', date_range: '2025 - Present', bullets: [...shared] },
    { type: 'project', org: 'Tonee', title: 'AI Engineer', date_range: '2025 - Present', bullets: [...shared] },
  ];

  const dropped: { org: string; bullets: number; reason: string }[] = [];
  const result = enforceExperienceBulletFloor(input, [first, second], {
    allowSparseAll: true,
    onDropped: (entry) => dropped.push(entry),
  });
  assert.equal(result.experience.length, 1);
  /* `reason` is what stops the caller printing "it has 0 bullets, add another and it goes on" for
     a drop that adding a bullet cannot fix: every bullet on this entry is already on the page
     under an earlier heading, so a fourth would change nothing and the student would be sent round
     a loop. The two routes branch on this to say what actually happened. */
  assert.deepEqual(
    dropped,
    [{ org: 'Tonee', title: 'AI Engineer', bullets: 0, reason: 'already_printed' }],
    'the emptied entry is reported with the cause, not silently gone',
  );
});

test('a genuinely thin entry still reports the bullet-count cause', () => {
  const source = bankEntry('thin', 'job', 'Acme', 'Intern', ['Helped users onboard to the new billing flow']);
  const input = rawSpec();
  input.experience = [{
    type: 'job',
    org: 'Acme',
    title: 'Intern',
    date_range: '2025 - Present',
    bullets: ['Helped users onboard to the new billing flow'],
  }];

  const dropped: { org: string; bullets: number; reason: string }[] = [];
  enforceExperienceBulletFloor(input, [source], { onDropped: (entry) => dropped.push(entry) });
  assert.deepEqual(dropped, [{ org: 'Acme', title: 'Intern', bullets: 1, reason: 'below_floor' }]);
});

/* Two genuinely different entries keep every one of their bullets. The dedupe keys on the sentence,
   never on the org, so an ordinary resume is untouched by it. */
test('distinct bullets at one organisation all survive', () => {
  const analystBullets = [
    'Analyzed customer interviews and translated findings into launch priorities for the team',
    'Built weekly dashboards that tracked activation across three onboarding paths',
  ];
  const managerBullets = [
    'Led eight engineers across platform and infrastructure projects',
    'Launched an incident review process across two technical teams',
  ];
  const analyst = bankEntry('a', 'job', 'Acme Labs', 'Data Analyst', analystBullets);
  const manager = bankEntry('m', 'job', 'Acme Labs', 'Engineering Manager', managerBullets);
  const input = rawSpec();
  input.experience = [
    { type: 'job', org: 'Acme Labs', title: 'Data Analyst', date_range: '2024 - 2025', bullets: [...analystBullets] },
    { type: 'job', org: 'Acme Labs', title: 'Engineering Manager', date_range: '2025 - Present', bullets: [...managerBullets] },
  ];

  const result = enforceExperienceBulletFloor(input, [analyst, manager]);
  assert.equal(result.experience.length, 2);
  assert.deepEqual(result.experience[0].bullets, analystBullets);
  assert.deepEqual(result.experience[1].bullets, managerBullets);
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

/* GPA, printed only when the student's own resume printed one.
 *
 * The denominator is the part worth pinning. A bare "3.8" is a different claim on a 4.0 than on a
 * 5.0, so defaulting the missing case would be a fabricated academic claim on an employment
 * document. The parser records a scale only when the page states one; this keeps that promise all
 * the way to the paper. */
test('a GPA renders only with the denominator the resume actually printed', () => {
  assert.equal(educationGpaLine({ gpa: '3.8', gpa_scale: '4.0' }), '3.8/4.0');
  assert.equal(educationGpaLine({ gpa: '3.8' }), '3.8');
  assert.equal(educationGpaLine({ gpa: '3.8', gpa_scale: '' }), '3.8');
});

test('no GPA on file prints nothing, and is never treated as a missing field', () => {
  assert.equal(educationGpaLine({}), '');
  assert.equal(educationGpaLine({ gpa: '' }), '');
  assert.equal(educationGpaLine({ gpa: '   ' }), '');
  assert.equal(educationGpaLine({ gpa_scale: '4.0' }), '');
});

/* parsed_json is jsonb and a hand-edited row can hold anything. A value that is not a number is a
   claim nobody read off the page, so it does not reach the document. */
test('a value that is not a grade is refused rather than printed', () => {
  assert.equal(educationGpaLine({ gpa: 'first class honours' }), '');
  assert.equal(educationGpaLine({ gpa: '3.8; Dean\'s List' }), '');
  assert.equal(educationGpaLine({ gpa: '<script>' }), '');
  // A junk scale drops the scale, it does not drop a legitimate grade.
  assert.equal(educationGpaLine({ gpa: '3.8', gpa_scale: 'excellent' }), '3.8');
});

test('the education block carries the GPA from the profile, never from the model', () => {
  const spec = rawSpec();
  (spec as { gpa?: string }).gpa = '9.9/10.0';
  const { spec: out } = applyResumePolicy(
    spec,
    { school: 'USC', degree: 'BS CS', grad_date: 'May 2027', gpa: '3.8', gpa_scale: '4.0' },
    BANK,
    'engineering role',
  );
  assert.equal(out.gpa, '3.8/4.0');
});

/* Every path that builds a CandidateEducation has to carry the GPA, or the student is shown a base
   resume without one and a tailored resume with one, which reads as the product changing their
   education between screens. baseResume.ts builds its own via educationFrom and was missed on the
   first pass; this is the reminder for the next field. */
test('the base resume path carries the same education fields the tailored path does', async () => {
  const { educationFrom } = await import('../routes/baseResume');
  const education = educationFrom({
    school: 'USC',
    degree: 'BS CS',
    grad_date: 'May 2027',
    gpa: '3.8',
    gpa_scale: '4.0',
    coursework: ['Algorithms'],
  });
  assert.equal(educationGpaLine(education), '3.8/4.0');
});

/* Location is a claim about WHERE someone worked, so it is held to a stricter match than the
   bullets are. matchingBankEntry accepts a 0.5 organisation overlap, which is right for pulling a
   student's own bullets onto the right row and wrong for asserting a city. */
test('a location is copied only when the organisation is unmistakably the same', () => {
  const spec = rawSpec();
  spec.experience = [{ ...spec.experience[0], org: 'Company 2', title: 'Engineer', date_range: '2024', bullets: spec.experience[0].bullets }];
  const near = [{
    ...BANK[0], org: 'Company 1', title: 'Engineer', date_range: '2024',
    location: 'Princeton, NJ', bullet_variants: spec.experience[0].bullets,
  }] as typeof BANK;
  const { spec: out } = applyResumePolicy(spec, { school: 'USC' }, near, 'engineering');
  // The row still matches well enough to carry bullets; the city does not come with it.
  assert.equal(out.experience[0].location, '');
});

test('an exact organisation match does carry the location', () => {
  const spec = rawSpec();
  const org = spec.experience[0].org;
  const exact = [{
    ...BANK[0], org, title: spec.experience[0].title, date_range: spec.experience[0].date_range,
    location: 'Los Angeles, CA', bullet_variants: spec.experience[0].bullets,
  }] as typeof BANK;
  const { spec: out } = applyResumePolicy(spec, { school: 'USC' }, exact, 'engineering');
  assert.equal(out.experience[0].location, 'Los Angeles, CA');
});

test('a bank row with no location prints none, rather than inheriting a neighbour', () => {
  const spec = rawSpec();
  const org = spec.experience[0].org;
  const noPlace = [{
    ...BANK[0], org, title: spec.experience[0].title, date_range: spec.experience[0].date_range,
    location: null, bullet_variants: spec.experience[0].bullets,
  }] as typeof BANK;
  const { spec: out } = applyResumePolicy(spec, { school: 'USC' }, noPlace, 'engineering');
  assert.equal(out.experience[0].location, '');
});

/* These pairs used to be guarded by a separate exact-name check on the location field. That check
   is gone: matchingBankEntry now refuses anything below SAME_EMPLOYER_SCORE, so the same pairs are
   rejected one step earlier and by one rule instead of two. The assertions move to orgScore rather
   than disappearing, because the pairs are the point, not the function that answered for them. */
test('organisations differing only by a number are not the same employer', () => {
  assert.ok(orgScore('Company 1', 'Company 2') < SAME_EMPLOYER_SCORE);
  assert.ok(orgScore('Site 1', 'Site 2') < SAME_EMPLOYER_SCORE);
  assert.ok(orgScore('Bank of America', 'Bank of the West') < SAME_EMPLOYER_SCORE);
});

test('punctuation, spacing and case are noise, not a different employer', () => {
  assert.ok(orgScore("St. Jude's", 'St Judes') >= SAME_EMPLOYER_SCORE);
  assert.ok(orgScore('TRI COAST CAPITAL', 'Tri Coast Capital') >= SAME_EMPLOYER_SCORE);
  assert.equal(orgScore('', ''), 0);
});

/* The honest case the old exact gate was quietly costing: an abbreviated organisation kept its
   bullets and its type but lost its city, for a spelling difference. */
test('an abbreviated organisation keeps its location', () => {
  const spec = rawSpec();
  spec.experience = [{ ...spec.experience[0], org: 'Traeco', title: 'AI Engineer', date_range: '2026', bullets: spec.experience[0].bullets }];
  const bank = [{ ...BANK[0], org: 'Traeco - AI Agent Cost Infrastructure', title: 'AI Engineer',
    date_range: '2026', location: 'Los Angeles, CA', bullet_variants: spec.experience[0].bullets }] as typeof BANK;
  const { spec: out } = applyResumePolicy(spec, { school: 'USC' }, bank, 'engineering');
  assert.equal(out.experience[0].location, 'Los Angeles, CA');
});

/* orgScore decides which bank row a generated entry belongs to, which is what carries the
   student's own bullets, the entry type, and (behind a stricter gate) the printed city. It could
   not tell "Company 1" from "Company 2": tokens() drops single characters, so both reduced to
   {company} and scored a PERFECT 1.0. The threshold was 0.5, which separately let any two-word
   company match its nearest unrelated neighbour. */
describe('orgScore tells employers apart', () => {
  const MATCH = 0.8; // the caller's threshold

  test('a digit disagreement is disqualifying, whatever else the names share', () => {
    assert.equal(orgScore('Company 1', 'Company 2'), 0);
    assert.equal(orgScore('Site 1', 'Site 2'), 0);
    assert.equal(orgScore('17 Asset Management', '18 Asset Management'), 0);
    assert.equal(orgScore('Studio 54', 'Studio 60'), 0);
  });

  test('half a name is not a name', () => {
    assert.ok(orgScore('Bank of America', 'Bank of the West') < MATCH);
    assert.ok(orgScore('First National Bank', 'First Republic Bank') < MATCH);
  });

  test('an abbreviated organisation still matches its full name', () => {
    // The common healthy case: the model writes the short form the resume prints.
    assert.ok(orgScore('Traeco', 'Traeco - AI Agent Cost Infrastructure') >= MATCH);
    assert.ok(orgScore('Einstein Bros. Bagels', 'Einstein Bros. Bagels (Mobile Ordering)') >= MATCH);
    assert.ok(orgScore('USC Lava Lab', 'Lava Lab') >= MATCH);
  });

  test('legal and generic wrappers are not identity', () => {
    assert.ok(orgScore('Nike Inc.', 'Nike') >= MATCH);
    assert.ok(orgScore('Bain & Company', 'Bain') >= MATCH);
    assert.ok(orgScore('Stripe, Inc.', 'Stripe') >= MATCH);
  });

  test('acronyms still resolve, which is why this is not just string equality', () => {
    assert.ok(orgScore('MIT', 'Massachusetts Institute of Technology') >= MATCH);
    assert.ok(orgScore('USC', 'University of Southern California') >= MATCH);
  });

  test('a shared number does not rescue an otherwise different name', () => {
    assert.ok(orgScore('Studio 54 Records', 'Gallery 54 Partners') < MATCH);
  });
});

/* The end-to-end consequence: a near-miss organisation must not hand its bullets to the wrong row.
   Before this, "Company 2" matched the "Company 1" bank entry at a perfect score and inherited its
   type and its bullet backfill. */
test('a near-miss organisation no longer inherits another employer\'s entry', () => {
  const spec = rawSpec();
  const bullets = spec.experience[0].bullets;
  spec.experience = [{ org: 'Company 2', title: 'Engineer', date_range: '2024', bullets }];
  const other = [{ ...BANK[0], type: 'leadership', org: 'Company 1', title: 'Engineer',
    date_range: '2024', location: 'Princeton, NJ', bullet_variants: bullets }] as typeof BANK;
  const { spec: out } = applyResumePolicy(spec, { school: 'USC' }, other, 'engineering');
  // No match, so it falls back to the default type rather than borrowing 'leadership'.
  assert.equal(out.experience[0].type, 'job');
  assert.equal(out.experience[0].location, '');
});

/* Two defects found reviewing the shipped matcher against its own edge cases. Both were mine and
   both failed silently, which is the only reason they survived three rounds of prod verification. */
describe('orgScore: a name made only of generic words', () => {
  test('an organisation still matches itself when every word is a noise word', () => {
    // "The Company", "Holdings", "The Group" reduced to an empty token set and scored 0.00 against
    // themselves - never matching their own bank row, so bullets, type and city all vanished.
    for (const name of ['The Company', 'Holdings', 'The Group', 'Company']) {
      assert.ok(orgScore(name, name) >= SAME_EMPLOYER_SCORE, `${name} must match itself`);
    }
  });

  test('the fallback does not make two different generic names equal', () => {
    assert.ok(orgScore('The Company', 'The Group') < SAME_EMPLOYER_SCORE);
    assert.ok(orgScore('Holdings', 'Company') < SAME_EMPLOYER_SCORE);
  });

  test('noise stripping still applies whenever a real word survives it', () => {
    assert.ok(orgScore('Nike Inc.', 'Nike') >= SAME_EMPLOYER_SCORE);
    assert.ok(orgScore('Bain & Company', 'Bain') >= SAME_EMPLOYER_SCORE);
  });
});

describe('educationGpaLine: scales that are not out of four', () => {
  test('a percentage-style denominator survives', () => {
    // "85/100" printed as "GPA: 85", which reads as an 85 on a 4.0-style scale: a materially
    // better claim than the resume made. The /100 and percentage systems are standard in India
    // and the UAE.
    assert.equal(educationGpaLine({ gpa: '85', gpa_scale: '100' }), '85/100');
    assert.equal(educationGpaLine({ gpa: '75.5', gpa_scale: '100' }), '75.5/100');
  });

  test('the ordinary scales are unchanged', () => {
    assert.equal(educationGpaLine({ gpa: '3.89', gpa_scale: '4.0' }), '3.89/4.0');
    assert.equal(educationGpaLine({ gpa: '9.2', gpa_scale: '10' }), '9.2/10');
  });

  test('a year is still not a grade', () => {
    assert.equal(educationGpaLine({ gpa: '2024' }), '');
    assert.equal(educationGpaLine({ gpa: '3.8', gpa_scale: '2024' }), '3.8');
  });
});
