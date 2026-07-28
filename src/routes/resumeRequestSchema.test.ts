import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RESUME_REQUEST_LIMITS, resumeGenerateBodySchema } from './resumeRequestSchema';

const validRequest = {
  company: 'Litos',
  role: 'Software Engineer',
  jd_text: 'Build reliable TypeScript services for students and employers.',
  contact: {
    full_name: 'Alex Rivera',
    email: 'alex@example.com',
    phone: '+1 213 555 0100',
    linkedin_url: null,
  },
};

describe('resume generation request limits', () => {
  test('accepts normal request values and preserves nullable contact compatibility', () => {
    const parsed = resumeGenerateBodySchema.parse(validRequest);
    assert.equal(parsed.contact.linkedin_url, undefined);
  });

  test('accepts optional portal metadata so the dashboard can create a review packet in one request', () => {
    const parsed = resumeGenerateBodySchema.parse({
      ...validRequest,
      application: {
        portal_url: 'https://jobs.ashbyhq.com/litos/role',
        ats_name: 'Ashby',
      },
    });
    assert.equal(parsed.application?.ats_name, 'Ashby');
  });

  test('rejects oversized contact values before PDF measurement', () => {
    const result = resumeGenerateBodySchema.safeParse({
      ...validRequest,
      contact: {
        ...validRequest.contact,
        full_name: 'x'.repeat(RESUME_REQUEST_LIMITS.fullName + 1),
      },
    });
    assert.equal(result.success, false);
  });

  test('rejects oversized job descriptions before model generation', () => {
    const result = resumeGenerateBodySchema.safeParse({
      ...validRequest,
      jd_text: 'x'.repeat(RESUME_REQUEST_LIMITS.jobDescription + 1),
    });
    assert.equal(result.success, false);
  });

  test('carries the monitored job id when the application came from the jobs list', () => {
    const parsed = resumeGenerateBodySchema.parse({
      ...validRequest,
      job_id: 'd6693be1-9d1d-4f61-9911-8d95f1ad1b01',
    });
    assert.equal(parsed.job_id, 'd6693be1-9d1d-4f61-9911-8d95f1ad1b01');
  });

  /* The extension and the hand-typed link panel generate resumes for postings with no
     monitored_jobs row. If this field were ever required, every one of those becomes a 400. */
  test('accepts a request with no job id, because most callers have no posting to point at', () => {
    const parsed = resumeGenerateBodySchema.parse(validRequest);
    assert.equal(parsed.job_id, undefined);
  });

  test('rejects a job id that is not a uuid, so junk never reaches the stored job_context', () => {
    const result = resumeGenerateBodySchema.safeParse({ ...validRequest, job_id: 'not-a-uuid' });
    assert.equal(result.success, false);
  });

  test('rejects a whitespace-only role before headline generation', () => {
    const result = resumeGenerateBodySchema.safeParse({
      ...validRequest,
      role: '   ',
    });
    assert.equal(result.success, false);
  });
});
