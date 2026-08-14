import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  resumeGenerateSuccessResponseSchema,
  resumeQualityHoldResponseSchema,
} from './resumeResponseSchema';

describe('resume response contract', () => {
  test('keeps legacy quality-hold fields valid without visual metadata', () => {
    const result = resumeQualityHoldResponseSchema.safeParse({
      error: 'Resume needs review',
      code: 'resume_quality_hold',
      quality: {
        ready_to_attach: false,
        issues: ['grounding failed'],
        warnings: [],
        omissions: [],
      },
    });
    assert.equal(result.success, true);
  });

  test('accepts additive visual metadata on successful generations', () => {
    const result = resumeGenerateSuccessResponseSchema.safeParse({
      resume_id: 'd6693be1-9d1d-4f61-9911-8d95f1ad1b01',
      resume_url: 'https://api.example.com/resume/download?t=token',
      canonical_application_id: '4ab51106-6fbe-4b56-8822-0db01b27bef0',
      artifact_id: '84f8cab7-3a83-4d16-9ca6-2815e78889b7',
      file_name: 'Alex_Example_Engineer_Resume.pdf',
      spec: {},
      application: {
        id: 'd6693be1-9d1d-4f61-9911-8d95f1ad1b01',
        job_context: {
          company: 'Litos',
          role: 'Engineer',
          jd_hash: 'abc123',
          location: 'London',
          portal_country: 'GB',
        },
        spec: { _review: { status: 'ready_to_submit' } },
        download_url: 'https://api.example.com/resume/download?t=token',
        created_at: '2026-07-23T00:00:00.000Z',
      },
      quality: {
        ready_to_attach: true,
        issues: [],
        warnings: [{
          entry: 'Litos',
          bullet: 'Built onboarding workflows',
          flags: ['thin(no-metric+low-fit)'],
        }],
        ats_keyword_coverage_pct: 80,
        trimmed_for_one_page_fit: false,
        sparse_add_more_experience: false,
        grounding_removed: [],
        omissions: [],
        visual_warnings: [],
        layout: {
          fill_ratio_pct: 66,
          bottom_whitespace_pt: 210,
          density_expansion_pct: 75,
          body_font_size_pt: 11.25,
          section_order: ['HEADER', 'EDUCATION', 'EXPERIENCE', 'SKILLS'],
        },
      },
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.application?.job_context.portal_country, 'GB');
      assert.equal(result.data.canonical_application_id, '4ab51106-6fbe-4b56-8822-0db01b27bef0');
      assert.equal(result.data.artifact_id, '84f8cab7-3a83-4d16-9ca6-2815e78889b7');
    }
  });

  test('rejects a changed legacy field type', () => {
    const result = resumeQualityHoldResponseSchema.safeParse({
      error: 'Resume needs review',
      code: 'resume_quality_hold',
      quality: {
        ready_to_attach: 'false',
        issues: [],
        warnings: [],
      },
    });
    assert.equal(result.success, false);
  });
});
