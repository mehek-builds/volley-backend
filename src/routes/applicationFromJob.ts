import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { applications, career_page_sources, monitored_jobs, profiles } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { AUTONOMOUS_PORTAL_FAMILIES } from '../lib/portalSubmission';
import { accountRequiresSponsor, sponsorOnlyPredicate } from './jobMonitor';
import { canonicalApplicationFingerprint } from './canonicalApplications';
import { RESUME_REQUEST_LIMITS } from './resumeRequestSchema';

/* SIGNED-IN JOB-FIRST ENTRY: turn a monitored posting into this account's application.
 *
 * WHY THIS ROUTE EXISTS. The strong-match email promises "This takes you straight to the full
 * posting and an apply-ready packet", and for a guest that promise is kept: /start?job=<id> opens
 * a guest session, the click pins pinned_onboarding_job_id, and onboarding's build step turns the
 * pin into a canonical application plus a tailored packet through POST /resume/generate. A
 * SIGNED-IN account had no equivalent at all (measured live 2026-08-28): /start bounced them to
 * /dashboard and the job in the link was simply lost, on the exact click where the email said the
 * packet would be. This route is that missing half.
 *
 * IT CREATES NOTHING OF ITS OWN. The packet pipeline is POST /resume/generate, called in-process
 * through fastify.inject() with the caller's own Authorization header, which is the established
 * pattern for reusing a real route rather than re-deriving it (see routes/dashboardBootstrap.ts
 * and routes/autopilotMatcher.ts, and lib/internalAutomationAuth.ts for why calling the REAL
 * route matters). That is what keeps every property of an onboarding build true here without a
 * second copy of any of it: the same entitlement checks and quotas (requireFeature, the
 * reservation, the onboarding build grant), the same full-description JD resolution, the same
 * contact-of-record and applicant-alias rules, and the same canonical application row shape.
 * A 402 or 422 from the pipeline is forwarded to the caller untouched for the same reason.
 */

const fromJobBodySchema = z.object({ job_id: z.string().uuid() });

/* What the pipeline needs from the posting, selected under the SAME never-relaxed predicate
 * GET /jobs/:id and the board enforce (routes/jobMonitor.ts): is_active, the source enabled,
 * the ATS family autonomous, and the account's own sponsor-only declaration. A weaker check here
 * would attach an account to a posting the rest of the product refuses to show or submit to. */
async function attachablePosting(jobId: string, userId: string) {
  const sponsorOnly = await accountRequiresSponsor(userId);
  const [row] = await db
    .select({
      id: monitored_jobs.id,
      company_name: monitored_jobs.company_name,
      title: monitored_jobs.title,
      description: monitored_jobs.description,
    })
    .from(monitored_jobs)
    .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
    .where(and(
      eq(monitored_jobs.id, jobId),
      eq(monitored_jobs.is_active, true),
      eq(career_page_sources.enabled, true),
      inArray(career_page_sources.ats_name, [...AUTONOMOUS_PORTAL_FAMILIES]),
      ...(sponsorOnly ? [sponsorOnlyPredicate()] : []),
    ))
    .limit(1);
  return row;
}

/* The account's application for this posting, if one exists, through the same posting-identity
 * keys the duplicate machinery uses: the job_id column every creation path writes, and the
 * `job:<id>` fingerprint upsertCanonicalApplicationForUser computes for job-keyed rows
 * (routes/canonicalApplications.ts). Rows born in /resume/generate carry a `legacy:` fingerprint
 * but always carry the job_id column, so the OR covers both shapes. */
async function existingApplicationForJob(userId: string, jobId: string) {
  const fingerprint = canonicalApplicationFingerprint({ jobId, companyScopeKey: '', role: '' });
  const [row] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(and(
      eq(applications.user_id, userId),
      or(eq(applications.job_id, jobId), eq(applications.application_fingerprint, fingerprint)),
    ))
    .orderBy(desc(applications.updated_at))
    .limit(1);
  return row;
}

export async function applicationFromJobRoutes(fastify: FastifyInstance) {
  fastify.post('/applications/from-job', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = fromJobBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'A valid job_id is required' });
    const userId = request.jwtPayload!.userId;
    const jobId = parsed.data.job_id;

    /* DEDUPE BEFORE VALIDATION, deliberately. The click that lands here is often a strong-match
     * email link opened days later, and by then the posting can have closed. An account that
     * already built its application for that posting must still be taken to it: their application
     * exists regardless of what the board now says about the posting, and a 404 here would deny
     * them their own record. Only an account with nothing for the posting gets the board's
     * verdict. Returning the existing row instead of creating a second one is the same
     * posting-distinction rule the fingerprint machinery enforces everywhere else. */
    const existing = await existingApplicationForJob(userId, jobId);
    if (existing) {
      return reply.header('Cache-Control', 'private, no-store').status(200).send({
        application_id: existing.id,
        created: false,
        deduped: true,
      });
    }

    const posting = await attachablePosting(jobId, userId);
    if (!posting) return reply.status(404).send({ error: 'Job not found' });

    /* The same preconditions onboarding's build step checks before it spends anything
     * (lib/onboarding-build.ts on the website): a name for the page, from the same parse
     * GET /profile serves it from. The resume email precondition is left to the pipeline, which
     * already refuses without one (422 resume_email_required) and is forwarded below. */
    const [profileRow] = await db
      .select({ parsed_json: profiles.parsed_json })
      .from(profiles)
      .where(eq(profiles.user_id, userId))
      .limit(1);
    if (!profileRow) {
      return reply.status(409).send({
        error: 'Upload a resume before adding a job to your tracker.',
        code: 'profile_required',
      });
    }
    const parsedProfile = (profileRow.parsed_json && typeof profileRow.parsed_json === 'object'
      ? profileRow.parsed_json
      : {}) as { full_name?: unknown };
    const fullName = typeof parsedProfile.full_name === 'string' ? parsedProfile.full_name.trim() : '';
    if (!fullName) {
      return reply.status(422).send({
        error: 'Your resume did not give us a name to put on the page.',
        code: 'full_name_required',
      });
    }

    /* The pipeline replaces jd_text with the posting's FULL description whenever job_id names a
     * row (see the posting-in-full block in routes/resume.ts), so this value only has to clear
     * the request schema's floor. A posting whose description cannot even do that has nothing to
     * tailor against, and refusing is more honest than padding. */
    const jdText = posting.description?.trim() ?? '';
    if (jdText.length < 20) {
      return reply.status(422).send({
        error: 'This posting does not carry enough of a description to build against.',
        code: 'posting_description_unavailable',
      });
    }

    const response = await fastify.inject({
      method: 'POST',
      url: '/resume/generate',
      headers: {
        'content-type': 'application/json',
        ...(typeof request.headers.authorization === 'string'
          ? { authorization: request.headers.authorization }
          : {}),
      },
      /* Preserve the caller's rate-limit identity, exactly as the dashboard bootstrap does:
       * injected requests otherwise all read as 127.0.0.1 and unrelated users in one warm
       * instance would drain one shared bucket. */
      remoteAddress: request.ip,
      payload: JSON.stringify({
        initiation: 'explicit_click',
        company: posting.company_name.slice(0, RESUME_REQUEST_LIMITS.company),
        role: posting.title.slice(0, RESUME_REQUEST_LIMITS.role),
        jd_text: jdText,
        job_id: jobId,
        contact: { full_name: fullName.slice(0, RESUME_REQUEST_LIMITS.fullName) },
      }),
    });

    if (response.statusCode >= 400) {
      /* Forwarded untouched. A 402 here carries the entitlement denial the client already knows
       * how to render, and a 422 names the exact profile fix; wrapping either would strip the
       * code the caller acts on. */
      return reply.status(response.statusCode).send(response.json());
    }

    const generated = response.json() as { canonical_application_id?: string };
    let applicationId = generated.canonical_application_id;
    if (!applicationId) {
      /* The pipeline can succeed while its audit persistence was skipped, in which case the
       * canonical id is absent from the response. The application row, when it landed, is still
       * findable by the posting it names; only when it truly does not exist is this a failure. */
      applicationId = (await existingApplicationForJob(userId, jobId))?.id;
      if (!applicationId) {
        return reply.status(502).send({
          error: 'The application could not be recorded for this posting. Try again.',
          code: 'application_attach_incomplete',
        });
      }
    }

    return reply.header('Cache-Control', 'private, no-store').status(201).send({
      application_id: applicationId,
      created: true,
      deduped: false,
    });
  });
}
