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
      file_name: 'Alex_Litos_Resume.pdf',
      spec: {},
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
