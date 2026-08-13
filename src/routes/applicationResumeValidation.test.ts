import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExperienceBankEntry } from '../db/schema';
import { checkResumeHealth } from '../engine/resumeHealth';
import { validateResumeSpec } from '../engine/resumeValidate';
import type { ResumeSpec } from '../llm/resumeSpec';
import { monitoredDescriptionHash } from '../lib/monitoredPortalRepair';
import {
  allowedSparseEntriesForApplicationEdit,
  applicationLeadAlignmentIssues,
  sameApplicationPacketSpec,
} from './applications';
import { runnerLeadAlignmentIssues } from './submissionRunner';

const source: ExperienceBankEntry = {
  id: 'recent-role',
  user_id: 'user-1',
  type: 'job',
  org: 'Northwind Labs',
  title: 'Software Engineer',
  date_range: 'June 2024 - Present',
  bullet_variants: [
    'Built TypeScript services and React interfaces used by operations teams',
    'Added automated tests, improved deployment checks, and reduced production errors by 35 percent',
  ],
  tags: [],
  created_at: new Date('2026-08-03T00:00:00Z'),
} as ExperienceBankEntry;

const resume: ResumeSpec = {
  school: 'Example University',
  degree: 'BS Computer Science',
  grad_date: '2024',
  coursework: '',
  experience: [{
    type: 'job',
    org: source.org,
    title: source.title ?? '',
    date_range: source.date_range ?? '',
    bullets: source.bullet_variants as string[],
  }],
  skills: ['TypeScript', 'React'],
};

const continuedReview = {
  recent_experience_review: {
    selected_entry_id: source.id,
    continue_with_found: true,
  },
};

function validate(spec: ResumeSpec, parsed: unknown = continuedReview) {
  return validateResumeSpec(spec, '', [source], undefined, undefined, undefined, {
    allowedSingleBulletEntries: allowedSparseEntriesForApplicationEdit(parsed, [source]),
  });
}

test('an advisory no-number finding does not block an already-approved sparse resume', () => {
  const health = checkResumeHealth(resume);
  const noMetric = health.findings.find((finding) => finding.rule === 'no-metric');
  assert.equal(noMetric?.severity, 'consider');

  const validation = validate(resume);
  assert.deepEqual(validation.issues, []);
});

test('the sparse exception requires the recorded continue decision and selected bank entry', () => {
  assert.deepEqual(allowedSparseEntriesForApplicationEdit({}, [source]), []);
  assert.deepEqual(allowedSparseEntriesForApplicationEdit({
    recent_experience_review: { selected_entry_id: source.id, continue_with_found: false },
  }, [source]), []);
  assert.deepEqual(allowedSparseEntriesForApplicationEdit({
    recent_experience_review: { selected_entry_id: 'another-entry', continue_with_found: true },
  }, [source]), []);

  const validation = validate(resume, {});
  assert.ok(validation.issues.some((issue) => issue.includes('2 bullet selected (min 3)')));
});

test('real content errors remain blocking even when sparse source content is allowed', () => {
  const weak = structuredClone(resume);
  weak.experience[0].bullets[0] = 'Helped with TypeScript services and React interfaces used by operations teams';
  assert.ok(validate(weak).issues.some((issue) => issue.includes('bullet not action-verb-first')));

  const fabricated = structuredClone(resume);
  fabricated.experience[0].bullets[1] =
    'Added automated tests, improved deployment checks, and reduced production errors by 40 percent';
  assert.ok(validate(fabricated).issues.some((issue) => issue.includes('grounding: metric "40"')));
});

const JD = `Software Engineer

Responsibilities:
- Build TypeScript services and React interfaces for operations teams

Requirements:
- Experience shipping tested production software`;
const WORKABLE_FORM_ONLY_JD = `Sales Setter / Executive
Remote Recruitment
Personal details
First name
Last name
Email
Phone
Photo
Education
School
Field of study
Degree
Start date
End date
Experience
Title
Company
Industry
Summary
Resume
Do you live in South Africa?
Submit application`;
const sourceBullets = source.bullet_variants as string[];

function storedWithCitation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...structuredClone(resume),
    lead_alignment: {
      entry_org: source.org,
      requirement: 'Build TypeScript services and React interfaces for operations teams',
      evidence: sourceBullets[0],
      jd_hash: monitoredDescriptionHash(JD),
    },
    _review: {
      jd_text: JD,
      role: 'Software Engineer',
      status: 'ready_to_submit',
      edited_terms: [],
      questions: [],
      skipped_reasons: [],
      updated_at: '2026-08-09T00:00:00.000Z',
    },
    ...overrides,
  };
}

test('pre-send lead verification rejects a dashboard reorder with a stale citation', () => {
  const stale = storedWithCitation({
    experience: [
      {
        type: 'job',
        org: 'Unrelated Lab',
        title: 'Research Intern',
        date_range: '2025',
        bullets: ['Presented qualitative research findings to an internal team'],
      },
      ...resume.experience,
    ],
  });
  assert.match(applicationLeadAlignmentIssues(stale)[0], /but the first entry is/);
});

test('pre-send lead verification rejects removal of the exact cited bullet', () => {
  const stale = storedWithCitation({
    experience: [{ ...resume.experience[0], bullets: [sourceBullets[1]] }],
  });
  assert.ok(applicationLeadAlignmentIssues(stale).some((issue) => /evidence is not one of the bullets/.test(issue)));
});

test('pre-send lead verification rejects a citation bound to another JD', () => {
  const stale = storedWithCitation({
    lead_alignment: {
      entry_org: source.org,
      requirement: 'Build TypeScript services and React interfaces for operations teams',
      evidence: sourceBullets[0],
      jd_hash: monitoredDescriptionHash(`${JD}\nChanged`),
    },
  });
  assert.ok(applicationLeadAlignmentIssues(stale).some((issue) => /jd_hash does not match/.test(issue)));
});

function runnerRow(spec: Record<string, unknown>) {
  return {
    spec,
    job_context: { company: 'Northwind Labs', role: 'Software Engineer' },
  } as Parameters<typeof runnerLeadAlignmentIssues>[0];
}

test('centralized runner gate rejects a hashless legacy lead citation', () => {
  const legacy = storedWithCitation();
  delete (legacy.lead_alignment as Record<string, unknown>).jd_hash;
  assert.ok(runnerLeadAlignmentIssues(runnerRow(legacy)).some((issue) => /jd_hash is missing/.test(issue)));
});

test('centralized runner gate rejects stale evidence before any submission channel', () => {
  const stale = storedWithCitation({
    experience: [{ ...resume.experience[0], bullets: [sourceBullets[1]] }],
  });
  assert.ok(runnerLeadAlignmentIssues(runnerRow(stale)).some((issue) => /evidence is not one of the bullets/.test(issue)));
});

test('form-only Workable packets remain eligible through both downstream lead gates', () => {
  const stored = storedWithCitation({
    lead_alignment: null,
    _review: {
      jd_text: WORKABLE_FORM_ONLY_JD,
      role: 'Sales Setter / Executive',
      status: 'ready_to_submit',
      edited_terms: [],
      questions: [],
      skipped_reasons: [],
      updated_at: '2026-08-11T00:00:00.000Z',
    },
  });
  const row = {
    spec: stored,
    job_context: { company: 'Remote Recruitment', role: 'Sales Setter / Executive' },
  } as Parameters<typeof runnerLeadAlignmentIssues>[0];
  assert.deepEqual(applicationLeadAlignmentIssues(stored, 'Remote Recruitment'), []);
  assert.deepEqual(runnerLeadAlignmentIssues(row), []);
});

test('packet version equality rejects either preclaim race window after validation', () => {
  const validated = storedWithCitation();
  assert.equal(sameApplicationPacketSpec(validated, structuredClone(validated)), true);

  const editedResume = structuredClone(validated);
  (editedResume.experience as Array<{ bullets: string[] }>)[0].bullets = [sourceBullets[1]];
  assert.equal(sameApplicationPacketSpec(validated, editedResume), false);

  const editedReview = structuredClone(validated);
  (editedReview._review as Record<string, unknown>).updated_at = '2026-08-09T00:01:00.000Z';
  assert.equal(sameApplicationPacketSpec(validated, editedReview), false);
});
