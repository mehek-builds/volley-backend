import { z } from 'zod';

export const RESUME_REQUEST_LIMITS = {
  company: 200,
  role: 200,
  jobDescription: 100_000,
  fullName: 200,
  email: 320,
  phone: 50,
  url: 500,
} as const;

const optionalContactField = (maximum: number) =>
  z.string().max(maximum).nullable().optional().transform((value) => value ?? undefined);

export const resumeGenerateBodySchema = z.object({
  company: z.string().min(1).max(RESUME_REQUEST_LIMITS.company),
  role: z.string().trim().min(1).max(RESUME_REQUEST_LIMITS.role),
  jd_text: z.string().min(20).max(RESUME_REQUEST_LIMITS.jobDescription),
  application: z.object({
    portal_url: z.string().url().max(4000),
    ats_name: z.string().min(1).max(100),
  }).optional(),
  contact: z.object({
    full_name: z.string().min(1).max(RESUME_REQUEST_LIMITS.fullName),
    email: optionalContactField(RESUME_REQUEST_LIMITS.email),
    phone: optionalContactField(RESUME_REQUEST_LIMITS.phone),
    linkedin_url: optionalContactField(RESUME_REQUEST_LIMITS.url),
    github_url: optionalContactField(RESUME_REQUEST_LIMITS.url),
    portfolio_url: optionalContactField(RESUME_REQUEST_LIMITS.url),
  }),
});

export type ResumeGenerateBody = z.infer<typeof resumeGenerateBodySchema>;
