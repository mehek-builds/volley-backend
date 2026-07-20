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
});
