import { z } from 'zod';

export const resumeLayoutResponseSchema = z.object({
  fill_ratio_pct: z.number().min(0).max(100),
  bottom_whitespace_pt: z.number(),
  density_expansion_pct: z.number().min(0).max(100),
  body_font_size_pt: z.number().positive(),
  section_order: z.array(z.string()),
});

export const resumeBulletWarningSchema = z.object({
  entry: z.string(),
  bullet: z.string(),
  flags: z.array(z.string()),
});

export const resumeQualityResponseSchema = z.object({
  ready_to_attach: z.boolean(),
  issues: z.array(z.string()),
  warnings: z.array(resumeBulletWarningSchema),
  ats_keyword_coverage_pct: z.number().optional(),
  trimmed_for_one_page_fit: z.boolean().optional(),
  sparse_add_more_experience: z.boolean().optional(),
  grounding_removed: z.array(z.string()).optional(),
  omissions: z.array(z.string()).optional(),
  visual_warnings: z.array(z.string()).optional(),
  layout: resumeLayoutResponseSchema.optional(),
});

export const resumeQualityHoldResponseSchema = z.object({
  error: z.string(),
  code: z.literal('resume_quality_hold'),
  quality: resumeQualityResponseSchema.optional(),
});

export const resumeGenerateSuccessResponseSchema = z.object({
  resume_id: z.string().uuid(),
  resume_url: z.string(),
  file_name: z.string(),
  spec: z.unknown(),
  application: z.object({
    id: z.string().uuid(),
    job_context: z.object({
      company: z.string(),
      role: z.string(),
      jd_hash: z.string(),
      // Present only for applications started from the jobs list; see resumeRequestSchema.
      job_id: z.string().uuid().optional(),
    }),
    spec: z.unknown(),
    download_url: z.string(),
    created_at: z.string(),
  }).optional(),
  quality: resumeQualityResponseSchema.extend({
    ready_to_attach: z.literal(true),
    ats_keyword_coverage_pct: z.number(),
    trimmed_for_one_page_fit: z.boolean(),
    sparse_add_more_experience: z.boolean(),
    grounding_removed: z.array(z.string()),
    omissions: z.array(z.string()),
  }),
});

export type ResumeGenerateSuccessResponse = z.infer<typeof resumeGenerateSuccessResponseSchema>;
export type ResumeQualityHoldResponse = z.infer<typeof resumeQualityHoldResponseSchema>;
