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

/* A PROFILE GAP IS NOT A POSTING VERDICT, and conflating the two is what sent a student in a loop.
 *
 * `resume_quality_hold` means "the resume Litos would write is not a fit for THIS posting" - the
 * honest recovery is another posting, which is why the client offers one. A missing school or
 * degree is a different kind of fact: it is about the ACCOUNT, not this posting, so it follows the
 * student to every posting and "try another one" fails identically each time. Measured live
 * 2026-09-02: the missing-education hold shipped as `resume_quality_hold`, so onboarding told a
 * student with no degree on file that the posting was "not a fit Litos can write honestly. Try
 * another posting" and offered "Show me a different one" - the exact dead-end loop the 402
 * entitlement denial already had carved out for itself.
 *
 * This distinct code lets the client route the student to the one place that fixes it, the same way
 * a missing name or resume email already does. `field` names what is missing so the client can send
 * them straight to it rather than describing a generic failure. */
export const resumeProfileIncompleteResponseSchema = z.object({
  error: z.string(),
  code: z.literal('resume_profile_incomplete'),
  field: z.enum(['education']),
  quality: resumeQualityResponseSchema.optional(),
});
export type ResumeProfileIncompleteResponse = z.infer<typeof resumeProfileIncompleteResponseSchema>;

/* WHERE EMPLOYER REPLIES WILL LAND, said out loud in the response.
 *
 * The decision was already frozen into the packet as `spec._applicant_email`, and that was the
 * whole problem: a fallback to the applicant's personal address is a fact she has to act on, and
 * it was legible only to someone reading stored JSON. `notice` is the sentence, already written,
 * for any caller to show. It is null exactly when `tracked` is true, so a client can render it
 * unconditionally.
 *
 * Optional so the extension and any older client keep parsing responses they already understand. */
export const resumeApplicantEmailResponseSchema = z.object({
  address: z.string(),
  source: z.enum(['litos_alias', 'contact_email', 'account_email']),
  reason: z.string(),
  tracked: z.boolean(),
  notice: z.string().nullable(),
});

export const resumeGenerateSuccessResponseSchema = z.object({
  resume_id: z.string().uuid(),
  resume_url: z.string(),
  canonical_application_id: z.string().uuid().optional(),
  artifact_id: z.string().uuid().optional(),
  file_name: z.string(),
  spec: z.unknown(),
  applicant_email: resumeApplicantEmailResponseSchema.optional(),
  application: z.object({
    id: z.string().uuid(),
    job_context: z.object({
      company: z.string(),
      role: z.string(),
      jd_hash: z.string(),
      location: z.string().optional(),
      // Exact country metadata published by the monitored ATS, when it supplied one.
      portal_country: z.string().optional(),
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
