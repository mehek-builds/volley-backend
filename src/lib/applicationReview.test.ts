import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ExperienceBankEntry } from '../db/schema';
import type { ResumeSpec } from '../llm/resumeSpec';
import { deriveEditedTerms, readApplicationReview } from './applicationReview';

const bank: ExperienceBankEntry[] = [
  {
    id: '09d813c6-72b6-47ba-aabf-79430408b740',
    user_id: '8e56fe73-daf4-4b79-8ca9-e4d38e2e8ac7',
    type: 'job',
    org: 'Elemental AI',
    title: 'Engineer',
    location: 'Dubai, UAE',
    date_range: '2026',
    bullet_variants: ['Built a client handoff tool used by 18 projects.'],
    tags: [],
    created_at: new Date('2026-01-01'),
  },
];

const spec: ResumeSpec = {
  school: 'USC',
  degree: 'BS',
  grad_date: '2027',
  coursework: '',
  education_position: 'top',
  experience: [
    {
      type: 'job',
      org: 'Elemental AI',
      title: 'Engineer',
      date_range: '2026',
      bullets: ['Built an automated client workflow used by 18 projects.'],
    },
  ],
  skills: ['TypeScript'],
};

describe('application review metadata', () => {
  test('derives only terms introduced by the tailored bullet', () => {
    const edited = deriveEditedTerms(spec, bank).map((term) => term.toLowerCase());
    assert.deepEqual(edited.sort(), ['automated', 'workflow']);
  });

  test('reads a persisted review packet and ignores plain resume specs', () => {
    assert.equal(readApplicationReview(spec), null);
    const review = {
      jd_text: 'Build workflow software',
      status: 'resume_ready' as const,
      edited_terms: ['workflow'],
      questions: [],
      skipped_reasons: [],
      updated_at: '2026-07-21T00:00:00.000Z',
    };
    assert.deepEqual(readApplicationReview({ ...spec, _review: review }), review);
  });
});
