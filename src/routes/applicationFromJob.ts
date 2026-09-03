import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { applications, career_page_sources, generated_resumes, monitored_jobs, profiles, users } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { specWithoutDocumentPointers } from '../lib/documentStore';
import { accountRequiresSponsor, boardConditions } from './jobMonitor';
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
      ...boardConditions({ sponsorOnly, requireVerifiedEvidence: true }),
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

/* The account's own application for a posting, as a READ - the same posting-identity keys the
 * POST above dedupes on, minus the rows a student has already taken off their tracker.
 *
 * REMOVED ROWS ARE EXCLUDED HERE AND NOT IN existingApplicationForJob, and the difference is
 * deliberate. The POST's dedupe answers "does this account already have a record for this
 * posting", where a removed row is still the account's record and returning it is what keeps a
 * second one from being created. This read answers a different question - "is there a packet to
 * carry on with" - and a removed application is exactly the case where the honest answer is no:
 * resuming into a row the student has already discarded would put them back on an application
 * they closed. A caller that gets null here builds a fresh one, which is correct.
 */
async function resumableApplicationForJob(userId: string, jobId: string) {
  const fingerprint = canonicalApplicationFingerprint({ jobId, companyScopeKey: '', role: '' });
  const [row] = await db
    .select({
      id: applications.id,
      job_id: applications.job_id,
      legacy_generated_resume_id: applications.legacy_generated_resume_id,
    })
    .from(applications)
    .where(and(
      eq(applications.user_id, userId),
      isNull(applications.removed_at),
      or(eq(applications.job_id, jobId), eq(applications.application_fingerprint, fingerprint)),
    ))
    .orderBy(desc(applications.updated_at))
    .limit(1);
  return row;
}

/* The application an account still IN SETUP is in the middle of, with no posting named.
 *
 * "Most recently touched, not removed" is the whole rule, and it is enough because of where this
 * is asked from: an account that has not finished onboarding has at most the one or two
 * applications its own /start flow built. There is no ambiguity to resolve between a dozen rows
 * because a locked, mid-setup account cannot have made a dozen - every other creation path
 * (the dashboard, the extension, /applications) is walled off by THE CARD GATE.
 *
 * Restricted to onboarding_completed_at IS NULL for the same reason the build grant is: this
 * route exists to let a student rejoin the sequence they were in, and a finished account is not
 * in one. Its own applications are read through /applications and the dashboard, which are the
 * routes for that and which say so.
 */
async function inProgressOnboardingApplication(userId: string) {
  const [row] = await db
    .select({
      id: applications.id,
      job_id: applications.job_id,
      legacy_generated_resume_id: applications.legacy_generated_resume_id,
    })
    .from(applications)
    .innerJoin(users, eq(users.id, applications.user_id))
    .where(and(
      eq(applications.user_id, userId),
      isNull(applications.removed_at),
      isNull(users.onboarding_completed_at),
    ))
    .orderBy(desc(applications.updated_at))
    .limit(1);
  return row;
}

/* The packet the application carries, read through the id the application itself names.
 *
 * legacy_generated_resume_id, NOT a newest-row-for-this-job search. The canonical application and
 * the generated_resumes packet are parallel rows and the column is the link between them
 * (routes/resume.ts writes it in the same transaction), so reading through it is the only way to
 * be sure the spec returned belongs to the application returned beside it. Scoped to the caller's
 * user_id as well as the id, so a column that somehow named another account's row reads as absent
 * rather than as a packet.
 *
 * Null is an ordinary answer, not a failure: an application can exist with no packet (a row
 * created by a path that does not generate one), and the caller's correct response is to build.
 */
async function packetForApplication(userId: string, packetId: string | null) {
  if (!packetId) return null;
  const [row] = await db
    .select({ id: generated_resumes.id, spec: generated_resumes.spec })
    .from(generated_resumes)
    .where(and(eq(generated_resumes.id, packetId), eq(generated_resumes.user_id, userId)))
    .limit(1);
  return row ?? null;
}

const onboardingPacketQuerySchema = z.object({ job_id: z.string().uuid().optional() });

export async function applicationFromJobRoutes(fastify: FastifyInstance) {
  /* REJOINING A BUILD INSTEAD OF PAYING FOR IT AGAIN.
   *
   * WHAT THIS FIXES. /start keeps its built packet in memory for the sitting only (app/start/
   * page.tsx: "A reload mid-sequence therefore lands the student back on the step the LEDGER says
   * they are on with nothing carried over"). So every reload between the build screen and the send
   * screen dropped the packet, returned the student to the build step, and spent ANOTHER free
   * onboarding build on the SAME posting. The allowance is two (lib/onboardingBuildGrant.ts), so
   * two reloads exhausted it and the account was stuck with no way forward and no way into the
   * dashboard: the build needs an entitlement it no longer has, and THE CARD GATE holds the
   * dashboard shut until setup completes. Measured on production 2026-09-03 on a real account:
   * onboarding_builds_used 2, onboarding_completed_at NULL.
   *
   * The limit was already raised from one to two on 2026-09-01 for this same symptom. That moved
   * the ceiling and left the cause alone, which is why this route is a READ: the packet the student
   * already paid a build for still exists on disk, so the reload has something to carry on with and
   * nothing to buy. THE GRANT LOGIC IS UNTOUCHED BY THIS ROUTE, deliberately - no exemption, no
   * second way to reach /resume/generate without a claim.
   *
   * WHY NOT AN EXEMPTION IN /resume/generate INSTEAD, which is the shorter change. Because job_id
   * does not pin what gets tailored. With no application_id the request's company, role and jd_text
   * are unvalidated against the posting (routes/resume.ts validates them only inside
   * `if (body.application_id)`), and resolveJdText (routes/jdMatch.ts) returns the CALLER'S text
   * whenever it is 2000 characters or longer. Any per-job exemption therefore turns one granted
   * posting into an unmetered tailoring endpoint for arbitrary text, at whatever the rate limiter
   * allows. A read of an already-built packet cannot generate anything, so it has no such shape.
   *
   * TWO QUESTIONS, ONE ROUTE, because they are the same question asked with and without a posting
   * in hand, and both are asked by the same screen sequence:
   *   - with `job_id`: "is there already a packet for THIS posting" - the build step's check before
   *     it spends, so choosing a posting it has already built costs nothing.
   *   - without: "which application is this account in the middle of" - the reload's own rejoin,
   *     which is what puts the student back on the posting they were building rather than on the
   *     match list with no memory of it.
   *
   * ON TIER B2 (lib/cardGate.ts), with the rest of the one free application: it belongs to the
   * sequence a locked account is allowed to finish, and it closes when that sequence does. It is
   * not TIER A or B1 - those stay open for the account's whole locked lifetime, and a route that
   * serves tailored resume content should not outlive the application it was built for.
   */
  fastify.get('/applications/onboarding-packet', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = onboardingPacketQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'A valid job_id is required' });
    const userId = request.jwtPayload!.userId;
    const jobId = parsed.data.job_id;

    const application = jobId
      ? await resumableApplicationForJob(userId, jobId)
      : await inProgressOnboardingApplication(userId);
    /* An account with nothing to rejoin is not an error, and answering 404 would make it one: the
     * caller asks this BEFORE it knows whether there is anything, on every arrival at the build
     * step and on every reload. `null` is the ordinary answer for a first build. */
    if (!application) {
      return reply.header('Cache-Control', 'private, no-store').status(200).send({ application: null });
    }

    const packet = await packetForApplication(userId, application.legacy_generated_resume_id);
    return reply.header('Cache-Control', 'private, no-store').status(200).send({
      application: {
        application_id: application.id,
        job_id: application.job_id,
        /* THE PACKET ID IS generated_resumes.id AND IT IS NOT application_id, which is the
         * canonical row's id. Getting this the wrong way round is a 404 on the send: POST
         * /applications/:id/submit-request resolves its row through ownedResume, which reads
         * generated_resumes alone (measured live 2026-09-01, when the canonical id was handed to
         * the review screen and every onboarding send answered "Application not found"). Both ids
         * are on the wire here under names that say which is which, so a caller cannot pick the
         * wrong one by accident. */
        packet: packet
          /* Through the stripper, like every other stored spec that goes on the wire
           * (lib/documentStore.ts, and see the same call in routes/resume.ts and routes/account.ts):
           * a spec read back off disk can carry document pointers, and this one is genuinely old
           * enough to have them. */
          ? { id: packet.id, spec: specWithoutDocumentPointers(packet.spec) }
          : null,
      },
    });
  });

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
