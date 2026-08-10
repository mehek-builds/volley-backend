import { z } from 'zod';

export const RESUME_REQUEST_LIMITS = {
  company: 200,
  role: 200,
  jobDescription: 100_000,
  fullName: 200,
  email: 320,
  phone: 50,
  // "Los Angeles, CA" or "Dubai, United Arab Emirates". Generous enough for a long country name
  // and short enough that no caller can push a paragraph into the header.
  location: 120,
  url: 500,
} as const;

const optionalContactField = (maximum: number) =>
  z.string().max(maximum).nullable().optional().transform((value) => value ?? undefined);

export const resumeGenerateBodySchema = z.object({
  company: z.string().min(1).max(RESUME_REQUEST_LIMITS.company),
  role: z.string().trim().min(1).max(RESUME_REQUEST_LIMITS.role),
  jd_text: z.string().min(20).max(RESUME_REQUEST_LIMITS.jobDescription),
  profile_education: z.object({
    school: z.string().max(200).optional(),
    degree: z.string().max(200).optional(),
    grad_date: z.string().max(40).optional(),
    grad_year: z.number().int().min(1900).max(2200).optional(),
    currently_enrolled: z.boolean().optional(),
    coursework: z.array(z.string().max(200)).max(30).optional(),
    school_location: z.string().max(200).optional(),
  }).optional(),
  // Which monitored_jobs row this application is against, when the student came from the jobs
  // list rather than pasting a link. It is what lets the jobs list say "Applied" on exactly the
  // posting they applied to: company+role alone cannot tell two reqs apart, so one Mountain View
  // application marked the NYC and London postings of the same title too.
  //
  // OPTIONAL, and must stay that way. The extension and the hand-typed "Add a job link" panel
  // both generate resumes for postings that have no monitored_jobs row at all, and neither can
  // invent one. A required field here would turn every one of those into a 400.
  //
  // Not validated against the table on purpose. It lands in a jsonb blob, so there is no foreign
  // key to lean on, and the only consumer treats it as an equality probe: an id that matches no
  // posting simply never matches a row, which is the same outcome as sending nothing.
  job_id: z.string().uuid().optional(),
  /**
   * True only when a background loop is building this packet ahead of the student reading it.
   *
   * Gates the requirement-cache warm, which is a model call. The prewarm loop can afford it because
   * nobody is waiting; an interactive "Apply now" cannot. Default false, so the expensive path is
   * opt-in rather than something a caller has to know to avoid.
   */
  prewarm: z.boolean().optional(),
  application: z.object({
    portal_url: z.string().url().max(4000),
    ats_name: z.string().min(1).max(100),
  }).optional(),
  contact: z.object({
    full_name: z.string().min(1).max(RESUME_REQUEST_LIMITS.fullName),
    email: optionalContactField(RESUME_REQUEST_LIMITS.email),
    phone: optionalContactField(RESUME_REQUEST_LIMITS.phone),
    // A PREFERENCE, like every other field here: what the caller sends wins, and what it leaves
    // blank is filled from the stored address by resumeContactOfRecord. Before this line existed
    // there was no way for a caller to state one and no fallback behind it, so the header printed
    // no location at all on all 158 stored packets.
    location: optionalContactField(RESUME_REQUEST_LIMITS.location),
    linkedin_url: optionalContactField(RESUME_REQUEST_LIMITS.url),
    github_url: optionalContactField(RESUME_REQUEST_LIMITS.url),
    portfolio_url: optionalContactField(RESUME_REQUEST_LIMITS.url),
  }),
});

export type ResumeGenerateBody = z.infer<typeof resumeGenerateBodySchema>;
