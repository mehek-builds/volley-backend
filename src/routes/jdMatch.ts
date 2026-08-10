import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { db } from '../db/index';
import { profiles } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { resumeSpecText } from '../engine/resumeValidate';
import { scoreJdMatch, scoreBand, MIN_SCORABLE_TERMS, segmentJd } from '../engine/jdMatch';
import { scorePosting, type CandidateFacts } from '../engine/clauseMatch';
import { judgeCompetenciesCached } from '../llm/competencyCache';
import { findGapEvidence } from '../engine/gapEvidence';
import { checkResumeHealth } from '../engine/resumeHealth';
import { buildFunnel } from '../engine/funnel';
import { deriveStage, isStage, STAGES, BOARD_LIMIT } from '../engine/pipeline';
import { buildInterviewPrep } from '../engine/interviewPrep';
import { extractJdTerms } from '../engine/jdMatch';
import { generated_resumes, autofill_events, monitored_jobs, career_page_sources } from '../db/schema';
import { AUTONOMOUS_PORTAL_FAMILIES } from '../lib/portalSubmission';
import { resolveRevision } from '../lib/buildInfo';
import { allowHourly, LIMITS, rateLimitedReply } from '../middleware/quota';
import { readExperienceBank, readExperienceBankOrSeedFromBaseResume } from '../db/experienceBank';
import type { ResumeSpec } from '../llm/resumeSpec';

/**
 * POST /jd-match
 *
 * Scores a resume against a job description and returns the number the dashboard shows, plus the
 * matched and missing requirement lists behind it.
 *
 * The scoring model, and why it is not the old ats_keyword_coverage_pct, is documented at length in
 * engine/jdMatch.ts. Two behaviours of this endpoint follow directly from that:
 *
 *   - It can answer 200 with score: null. A posting that lists no specific requirements is not
 *     scorable, and the honest response is to say so rather than to return a confident number the
 *     student would act on. Clients must render the `reason` instead of coercing null to 0.
 *   - It never persists a score. The number is a pure function of (resume, JD) and both change; a
 *     stored score is a stale claim about a resume the student has since edited. Recomputing is
 *     sub-millisecond, so there is nothing to buy by caching it and a correctness bug to invite.
 */

const evidenceBodySchema = z.object({
  terms: z
    .array(z.object({ term: z.string().min(1).max(120), display: z.string().min(1).max(120) }))
    .max(60, 'too many terms to look up at once'),
  resume_text: z.string().min(1).max(30_000).optional(),
});

/**
 * The spec as currently edited in the dashboard. Sent rather than read from storage because the
 * check has to describe the resume ON SCREEN, not the last one saved.
 *
 * A REAL schema, not z.unknown() + sanitizeEditedSpec. Two reasons, both found in review:
 *
 *  - sanitizeEditedSpec only CASTS; it does not type-check. A bullet that was not a string reached
 *    weakOpening and threw, so a malformed body produced a 500 where a 400 belongs.
 *  - sanitizeEditedSpec is the SAVE gate, and it REJECTS any bullet over BULLET_MAX_CHARS. Running
 *    the health check through it made the too-long finding unreachable: the one moment the student
 *    needed to be told a bullet was too long, the route 400d and the panel said it could not check
 *    the resume. A validator for a read-only quality report must not enforce the save rules.
 *
 * Bounds mirror what a one-page resume can physically hold, so a pasted blob cannot pin the loop.
 */
const healthBodySchema = z.object({
  spec: z.object({
    experience: z
      .array(
        z.object({
          org: z.string().max(200).default(''),
          title: z.string().max(200).optional(),
          date_range: z.string().max(100).optional(),
          bullets: z.array(z.string().max(2_000)).max(30).default([]),
        }),
      )
      .max(20)
      .default([]),
    skills: z.array(z.string().max(120)).max(100).default([]),
  }),
});

const bodySchema = z.object({
  // 60k is well past the longest posting we have seen (the 4.8k Cohere JD in the model's tests is
  // typical); the cap exists so a pasted page of HTML cannot pin the event loop.
  // OPTIONAL, and omitting it is the right call for any caller holding a job_id.
  //
  // GET /jobs sends `left(description, 600)`, a preview sized for a list row. A caller that scores
  // that preview is scoring six hundred characters of company blurb: measured on the live board it
  // yields two or three requirement terms, every posting falls under MIN_SCORABLE_TERMS, and every
  // card renders as unscorable. That is exactly what shipped on 2026-08-04 and what a check on a
  // real account caught - the dashboard drew no number at all, for anyone.
  //
  // So the rule mirrors resume_text directly above: absent means "you hold the authority, read it
  // yourself". The server loads the posting's full stored description from the job row. Present
  // means the caller has text the server does not have, which is the review screen, holding the
  // JD captured in the packet at the moment the resume was tailored to it. That text must win: it
  // is what the resume was written against, and the live row may have been edited since.
  jd_text: z.string().min(1, 'jd_text cannot be empty').max(60_000, 'jd_text is too long to score').optional(),
  // Optional override: score arbitrary resume text instead of the stored base resume. The tailored
  // per-application resume flows through here, and so does the "what if" editor in the dashboard.
  // .min(1) matters: an empty string is NOT the same as an absent field. Absent falls through to
  // the stored base resume and 404s when there is none, which routes the student to /start. An
  // empty string used to score as a confident 0% "Weak match", a claim about them that the input
  // never supported.
  resume_text: z.string().min(1, 'resume_text cannot be empty').max(30_000).optional(),
  // The posting's own company, role and offices. Excluded from the requirement set: a posting never
  // asks a student to have experience with the company they are applying to, with its job title, or
  // with the city it sits in.
  //
  // TWO WAYS TO SUPPLY THE LOCATION, and the id is the one clients should send.
  //
  // `location` is for a caller that already holds the job row (the ranking pass inside GET /jobs).
  // `job_id` is for the review screen, which holds a saved application packet instead. The packet
  // stores company, role and job_id and has never stored a location, so a client-side wiring would
  // have covered only packets generated after the change and left every existing one scoring with
  // its geography in the denominator. Resolving the id here covers all of them, and reads the LIVE
  // row rather than a copy that was already stale by the time it was written.
  //
  // Nullable rather than merely optional because the job row the caller reads it from is, and
  // forcing every caller to translate null to undefined is how a multi-site string ends up dropped.
  job_context: z
    .object({
      company: z.string().max(200).optional(),
      role: z.string().max(200).optional(),
      location: z.string().max(500).nullish(),
      job_id: z.string().uuid().nullish(),
    })
    .optional(),
});

const requirementsSchema = z.object({
  jd_text: z.string().min(1).max(60_000).optional(),
  /**
   * The tailored packet's spec, when the review screen holds one. Falls back to the base resume.
   *
   * Same shape as healthBodySchema's, and for the same reason recorded there: a REAL schema rather
   * than a cast, so a malformed body is a 400 instead of a 500 deep inside the matcher. Education
   * fields are carried too, because the degree and graduation clauses are checked against them.
   */
  spec: z
    .object({
      school: z.string().max(300).optional(),
      degree: z.string().max(300).optional(),
      grad_date: z.string().max(100).optional(),
      coursework: z.string().max(1_000).optional(),
      target_role: z.string().max(200).optional(),
      experience: z
        .array(
          z.object({
            org: z.string().max(200).default(''),
            title: z.string().max(200).optional(),
            date_range: z.string().max(100).optional(),
            bullets: z.array(z.string().max(2_000)).max(30).default([]),
          }),
        )
        .max(20)
        .default([]),
      skills: z.array(z.string().max(120)).max(100).default([]),
    })
    .optional(),
  job_context: z
    .object({
      company: z.string().max(200).optional(),
      role: z.string().max(200).optional(),
      location: z.string().max(500).nullish(),
      job_id: z.string().uuid().nullish(),
    })
    .optional(),
});

/**
 * The offices of the posting a saved packet was built for, or null when we cannot tell.
 *
 * Null is the ordinary answer for every packet that has no job_id: applications started from the
 * extension or from a hand-typed link point at no monitored posting, and there is nothing to look
 * up. Those score exactly as they did before, with the geography still in, which is the honest
 * outcome rather than a guess at where the employer sits.
 *
 * SCOPED LIKE GET /jobs/:id, and it was not always. This helper began as a location lookup, and
 * the comment here used to say scoping was unnecessary because "one nullable location column
 * discloses nothing". That stopped being true the moment it started returning the DESCRIPTION:
 * /jd-match/requirements hands the text back clause by clause, so an unscoped read let any caller
 * pull the full posting of anything the board deliberately refuses to serve - a disabled source, a
 * demoted ATS family - by uuid alone. Found in retrospective review 2026-08-04.
 *
 * `is_active` is deliberately NOT required, and that is the one place this differs from
 * GET /jobs/:id. A packet is often held for a posting that has since closed, and its review screen
 * must still score: refusing there would break the repair path for every packet that stored the
 * 600-character preview. Closure is a fact about the job, not a permission boundary; the source
 * and portal-family checks are the permission boundary and both are enforced.
 */
export async function postingRow(
  jobId: string | null | undefined,
): Promise<{ location: string | null; portal_country: string | null; description: string | null } | null> {
  if (!jobId) return null;
  const [row] = await db
    .select({
      location: monitored_jobs.location,
      // Bounded ATS metadata persisted in monitored_jobs.raw_json. Null on rows created before the
      // preservation path shipped, and filled by the next ordinary poll without a migration.
      portal_country: sql<string | null>`${monitored_jobs.raw_json}->>'portal_country'`,
      // Capped at the same 60k the request schema allows, so a posting cannot arrive here longer
      // than the engine's own bound just because it skipped the schema on its way in.
      description: sql<string>`left(${monitored_jobs.description}, 60000)`,
    })
    .from(monitored_jobs)
    .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
    .where(
      and(
        eq(monitored_jobs.id, jobId),
        eq(career_page_sources.enabled, true),
        inArray(career_page_sources.ats_name, [...AUTONOMOUS_PORTAL_FAMILIES]),
      ),
    )
    .limit(1);
  return row ? {
    location: row.location ?? null,
    portal_country: row.portal_country ?? null,
    description: row.description ?? null,
  } : null;
}

/**
 * Which text to score: the caller's, or the posting row's.
 *
 * ONE HELPER, used by both /jd-match and /jd-match/requirements, because they run on the SAME
 * SCREEN. The headline percentage and the requirement breakdown scoring different texts is
 * ISSUE-014 in miniature: two numbers about one posting with nothing on screen saying why they
 * disagree. When this was written into only one of them, that is exactly what it produced.
 *
 * The caller normally wins, which is the rule the review screen needs: its packet holds the JD the
 * resume was tailored against, and the live row may have been edited since. The exception is a
 * PREVIEW. Packets built before 2026-08-04 stored `left(description, 600)`, truncated mid-word,
 * because the dashboard forwarded the job list's preview to /resume/generate. Those are on disk and
 * nothing rewrites them, so preferring the row when the caller's text is preview-shaped repairs
 * them on read instead of leaving them permanently unscoreable.
 */
export function resolveJdText(sent: string, rowDescription: string | null | undefined): string {
  // A row that is itself capped at the 60k ceiling is truncated mid-word too, so it is no better.
  if (!rowDescription || rowDescription.length === 60_000) return sent;
  if (sent.length >= 2_000) return sent;
  return rowDescription.length > sent.length ? rowDescription : sent;
}

export async function jdMatchRoutes(fastify: FastifyInstance) {
  /**
   * The requirement-by-requirement breakdown, for the REVIEW SCREEN ONLY.
   *
   * Deliberately not on /jd-match and deliberately not on a list. This costs one Sonnet call the
   * first time a posting is read against a resume, and the review screen is the one place a student
   * is deciding about a single job rather than scanning twenty. Repeat views cost nothing: the
   * judge is content-addressed cached on (clause, bullets), so re-opening a packet is a database
   * read. The route reports `judged` and `from_cache` so that stays visible rather than assumed.
   *
   * WHAT THIS ANSWERS THAT /jd-match CANNOT. The term scorer sees only requirements that name a
   * technology, which measured over 600 live postings is 34.6% of the clauses employers write. The
   * rest - a degree in the right field, five years of something, communicating with partners - were
   * invisible, and they are disproportionately the ones a student MEETS, so the number ran low in
   * one direction. This returns every stated clause with a verdict and, when met, the student's own
   * bullet as the reason.
   */
  fastify.post('/jd-match/requirements', { preHandler: requireAuth, bodyLimit: 128 * 1024 }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    const parsed = requirementsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
    }

    /* METERED AND BOUNDED, like every other model-backed route here.
     *
     * This shipped with neither, which made it the only paid endpoint in the repo behind nothing
     * but the 180 req/min IP limiter. The spec bounds allow twenty entries of thirty bullets, and
     * every bullet is inlined into the prompt; because the cache is keyed on the bullets, changing
     * one character guarantees a miss and a fresh Sonnet call. That is an unmetered spend endpoint,
     * and the fact that its own cache made the common path free is exactly what hid it.
     *
     * IT METERS REQUESTS, NOT MODEL CALLS, and the ceiling is set for that. A cache hit costs
     * nothing and still spends a unit, because the limit has to be decided before the work rather
     * than after it. An earlier version of this comment claimed cached reads were free of the
     * quota; they are not, and pretending otherwise would set the ceiling by the wrong arithmetic.
     * It runs after the body parse so a malformed request cannot burn a unit.
     *
     * Generous rather than tight: a student reading through a day's packets opens a lot of them.
     * This exists to stop a loop, not to ration ordinary use. */
    if (!(await allowHourly(userId, 'jdRequirements', LIMITS.perHour.jdRequirements))) {
      return rateLimitedReply(reply);
    }

    const [profile] = await db.select().from(profiles).where(eq(profiles.user_id, userId));
    const stored = profile?.base_resume_json as ResumeSpec | null | undefined;
    const spec = (parsed.data.spec as ResumeSpec | undefined) ?? stored;
    if (!spec) return reply.status(404).send({ error: 'No main resume yet' });

    const posting = await postingRow(parsed.data.job_context?.job_id);
    /* THE LONGER OF THE TWO, not simply the caller's.
     *
     * Every packet built before 2026-08-04 stored `left(description, 600)` in _review.jd_text,
     * because the dashboard forwarded the list preview to /resume/generate. Those packets are on
     * disk and their stored JD is truncated mid-word, so a review screen that trusted the caller's
     * text scored ZERO clauses on them: the requirements section had been cut away before the JD
     * was ever saved. Measured on a real packet, 600 characters ending "high-growth enterprise
     * technology comp".
     *
     * Preferring the longer text repairs those packets without a migration, and still lets a caller
     * who genuinely holds more than we do win, which is the case the caller-first rule existed for. */
    const jdText = resolveJdText(parsed.data.jd_text ?? '', posting?.description);
    if (!jdText) {
      return reply
        .status(400)
        .send({ error: 'jd_text is required unless job_context.job_id names a posting we hold' });
    }

    const bullets = spec.experience.flatMap((e) => e.bullets ?? []);
    const facts: CandidateFacts = {
      degree: spec.degree,
      school: spec.school,
      gradDate: spec.grad_date,
      resumeText: resumeSpecText(spec),
      bullets,
    };

    let judged = 0;
    let fromCache = 0;
    const result = await scorePosting(
      jdText,
      facts,
      {
        ...parsed.data.job_context,
        location: parsed.data.job_context?.location ?? posting?.location ?? null,
      },
      segmentJd,
      /* THE PROFILE IS THE THIRD ARGUMENT, and dropping it is silent.
         This callback was typed (b, qs), so scorePosting's profile went nowhere: eligibility
         questions reached the model with an empty CANDIDATE FACTS block, every "met" failed the
         grounding gate for citing a date that was not there, and a student graduating May 2028
         scored 0 against a posting asking for Spring 2028 - told "nothing in your profile
         establishes this" about a date sitting in their own packet. */
      async (b, qs, profile) => {
        const r = await judgeCompetenciesCached(b, qs, profile);
        judged = r.judged;
        fromCache = r.fromCache;
        return { verdicts: r.verdicts, rejected: r.rejected };
      },
    );

    /* `degraded` exists because `unscoreable` means two different things downstream and only one
       of them is true here. The dashboard renders unscoreable clauses as "about attitude rather
       than experience", which is right for "you stay curious" and a lie about "communicate nuance
       to partners" when the truth is that a rate limit stopped us asking. The client branches on
       this rather than inferring from a null score. */
    return reply.status(200).send({
      degraded: result.score === null && result.clauses.some((c) => c.verdict === 'unscoreable'),
      score: result.score,
      // Clauses the model could not be asked about are absent from the denominator, so a reader can
      // see the count they were scored on rather than inferring it.
      scored: result.clauses.filter((c) => c.verdict !== 'unscoreable').length,
      met: result.clauses.filter((c) => c.verdict === 'met').length,
      clauses: result.clauses.map((c) => ({
        text: c.text,
        weight: c.weight,
        verdict: c.verdict,
        basis: c.basis,
        evidence: c.evidence ?? null,
        missing_terms: c.missingTerms ?? [],
      })),
      judged,
      from_cache: fromCache,
      // Non-empty means the model returned a verdict it could not ground in a real bullet and it
      // was thrown away. Surfaced rather than swallowed so a bad run is visible.
      // Flattened for the wire. The structure exists so the CACHE can filter on ids without
      // parsing prose; a client only needs to be told something was discarded.
      rejected: result.rejected.map((r) => (r.id ? `${r.id}: ${r.reason}` : r.reason)),
    });
  });

  fastify.post('/jd-match', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues[0]?.message : undefined;
      return reply.status(400).send({ error: message ?? 'Invalid request body' });
    }

    let storedResumeText: string | null = null;
    if (body.resume_text === undefined) {
      const [profile] = await db.select().from(profiles).where(eq(profiles.user_id, userId));
      const spec = profile?.base_resume_json as ResumeSpec | null | undefined;
      if (!spec) {
        // Mirrors GET /resume/base. The dashboard uses this to route the student to /start rather
        // than showing them a 0% that is about the missing resume, not about their fit.
        return reply.status(404).send({ error: 'No main resume yet' });
      }
      storedResumeText = resumeSpecText(spec);
    }

    const posting = await postingRow(body.job_context?.job_id);

    /* The caller's text wins when it has one. See the jd_text note on bodySchema: the review screen
       holds the JD the packet was tailored against, which is the text its number has to be about. */
    const jdText = resolveJdText(body.jd_text ?? posting?.description ?? '', posting?.description);
    if (!jdText) {
      // Neither supplied nor resolvable. Distinguished from a thin posting on purpose: this is a
      // wiring fault, and answering it with the engine's "this posting did not list enough" would
      // tell a student something about a job when the truth is about us.
      return reply
        .status(400)
        .send({ error: 'jd_text is required unless job_context.job_id names a posting we hold' });
    }

    const resumeText = body.resume_text ?? storedResumeText ?? '';
    const result = scoreJdMatch(resumeText, jdText, {
      ...body.job_context,
      location: body.job_context?.location ?? posting?.location ?? null,
    });

    return reply.status(200).send({
      score: result.score,
      scorable: result.scorable,
      reason: result.reason,
      band: result.score === null ? null : scoreBand(result.score, result.required_coverage),
      required_coverage: result.required_coverage,
      term_count: result.term_count,
      min_scorable_terms: MIN_SCORABLE_TERMS,
      // Display strings, not match keys: the student should see "CI/CD", not "ci cd".
      /* `satisfied_by` rides with the matched terms so the review screen can put the blue mark on
         the words the resume actually uses. See resumeSatisfies in engine/jdMatch.ts. */
      matched: result.matched.map((t) => ({ term: t.term, display: t.display, weight: t.weight, satisfied_by: t.satisfied_by })),
      missing: result.missing.map((t) => ({ term: t.term, display: t.display, weight: t.weight })),
    });
  });

  /**
   * POST /jd-match/evidence
   *
   * For each requirement the resume is missing, the student's OWN wording from their experience
   * bank that already evidences it, or an explicit "nothing in your experience mentions this".
   *
   * A separate call from /jd-match on purpose. The score recomputes as the student types, and this
   * reads the whole experience bank; folding it in would put a bank query behind every keystroke to
   * answer a question the student only asks once, when they look at the gap list.
   */
  fastify.post('/jd-match/evidence', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    let body: z.infer<typeof evidenceBodySchema>;
    try {
      body = evidenceBodySchema.parse(request.body);
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues[0]?.message : undefined;
      return reply.status(400).send({ error: message ?? 'Invalid request body' });
    }

    const [bank, storedResume] = await Promise.all([
      readExperienceBankOrSeedFromBaseResume(userId),
      body.resume_text === undefined
        ? db
            .select()
            .from(profiles)
            .where(eq(profiles.user_id, userId))
            .then(([profile]) => {
              const spec = profile?.base_resume_json as ResumeSpec | null | undefined;
              return spec ? resumeSpecText(spec) : '';
            })
        : Promise.resolve(body.resume_text),
    ]);

    const answers = findGapEvidence(
      body.terms.map((t) => ({ term: t.term, display: t.display, weight: 1, kind: 'required' as const })),
      bank,
      storedResume,
    );

    return reply.status(200).send({ answers });
  });

  /**
   * POST /resume/health
   *
   * The quality rules the generator already enforces, reported to the student instead of only to
   * the model. Named findings with the bullet each fired on, ordered so the top one is worth fixing
   * first. Deliberately NOT a score: Litos already has one number that means something specific,
   * and a second one competing with it teaches students to average two different questions.
   */
  // 64KB is generous for a one-page resume and well under Fastify's 1MB default.
  fastify.post('/resume/health', { preHandler: requireAuth, bodyLimit: 64 * 1024 }, async (request: FastifyRequest, reply: FastifyReply) => {
    let body: z.infer<typeof healthBodySchema>;
    try {
      body = healthBodySchema.parse(request.body);
    } catch {
      return reply.status(400).send({ error: 'Invalid request body' });
    }

    return reply.status(200).send(checkResumeHealth(body.spec as unknown as ResumeSpec));
  });

  /**
   * GET /metrics/funnel
   *
   * The student's own throughput, from what Litos observed. No interview or response rate: nothing
   * tells us when a company replies, and inferring it from silence would be a guess about their
   * life dressed as a measurement.
   */
  fastify.get('/metrics/funnel', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    // Minutes east of UTC, from the client. Days are the student's days: bucketing by UTC put a
    // Dubai student's early-morning applications on the previous day's bar.
    const rawOffset = Number((request.query as { tz_offset?: string } | undefined)?.tz_offset);
    const offsetMinutes = Number.isFinite(rawOffset) && Math.abs(rawOffset) <= 14 * 60 ? rawOffset : 0;

    // PROJECTED, not select *. generated_resumes.spec is a jsonb blob carrying the whole job
    // description, the resume and the cover letter, 20-40KB a row, and the dashboard prewarms up to
    // 30 resumes a day. Selecting the row to read two timestamps and one status string pulled tens
    // of megabytes out of Neon on every dashboard mount.
    const [resumeRows, fillRows] = await Promise.all([
      db
        .select({
          created_at: generated_resumes.created_at,
          status: sql<string | null>`${generated_resumes.spec}->'_review'->>'status'`,
          submitted_at: sql<string | null>`${generated_resumes.spec}->'_review'->>'submitted_at'`,
        })
        .from(generated_resumes)
        .where(eq(generated_resumes.user_id, userId)),
      db
        .select({ total: sql<number>`coalesce(sum(${autofill_events.fields_filled}), 0)::int` })
        .from(autofill_events)
        .where(eq(autofill_events.user_id, userId)),
    ]);

    const tailoredAt: Date[] = [];
    const submittedAt: Date[] = [];
    for (const row of resumeRows) {
      if (row.created_at) tailoredAt.push(row.created_at);
      // Only a genuine submitted status counts. A resume that exists is not an application sent,
      // and conflating them would inflate the one number the student is here to watch.
      if (row.status !== 'submitted') continue;
      const parsed = row.submitted_at ? new Date(row.submitted_at) : null;
      // A malformed timestamp costs the submission its place on the chart, never its place in the
      // count: dropping it entirely would silently under-report a real application.
      const at = parsed && !Number.isNaN(parsed.getTime()) ? parsed : row.created_at;
      if (at) submittedAt.push(at);
    }

    return reply.status(200).send(
      buildFunnel({
        tailoredAt,
        submittedAt,
        fieldsFilled: fillRows[0]?.total ?? 0,
        now: new Date(),
        offsetMinutes,
      }),
    );
  });

  /**
   * GET /applications/board
   *
   * One row per application, with the stage the student put it in. Projected, not select *: spec is
   * a jsonb blob carrying the whole job description.
   */
  fastify.get('/applications/board', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const rows = await db
      .select({
        id: generated_resumes.id,
        job_context: generated_resumes.job_context,
        created_at: generated_resumes.created_at,
        pipeline_stage: generated_resumes.pipeline_stage,
        pipeline_stage_at: generated_resumes.pipeline_stage_at,
        status: sql<string | null>`${generated_resumes.spec}->'_review'->>'status'`,
        reviewable: sql<boolean>`${generated_resumes.spec}->'_review' is not null`,
        /* WHICH BUILD THE STATE ON THIS CARD IS EVIDENCE ABOUT. See ApplicationReviewState.
         * run_revision. A board reader comparing these to `revision` below can tell a packet that
         * stopped for a reason apart from one that has not been re-run since the fix, which is the
         * distinction a results table built off submission_status alone silently gets wrong. */
        run_revision: sql<string | null>`${generated_resumes.spec}->'_review'->>'run_revision'`,
        review_updated_at: sql<string | null>`${generated_resumes.spec}->'_review'->>'updated_at'`,
      })
      .from(generated_resumes)
      .where(eq(generated_resumes.user_id, userId))
      .orderBy(desc(generated_resumes.created_at))
      // Bounded. The dashboard prewarms up to 30 resumes a day, so an unbounded board sends
      // thousands of cards the student will never scroll to and renders a select for each.
      .limit(BOARD_LIMIT);

    return reply.status(200).send({
      stages: STAGES,
      limit: BOARD_LIMIT,
      /* The commit serving this response, so "is this card's state current?" is answerable from one
       * request instead of a board call plus a /health call plus the assumption that nothing
       * deployed in between. Null when the deployment supplied no SHA; see lib/buildInfo. */
      revision: resolveRevision().revision,
      cards: rows.map((row) => {
        const context = (row.job_context ?? {}) as { company?: string; role?: string; job_id?: string };
        return {
          id: row.id,
          // The monitored_jobs posting this application was started from, or null. The jobs list
          // uses it to mark exactly one row "Applied" instead of every row that shares a company
          // and a title. Null for rows written before it was recorded and for applications that
          // never came from a posting, and those still fall back to the company+role match.
          job_id: typeof context.job_id === 'string' ? context.job_id : null,
          company: context.company ?? 'Unknown company',
          role: context.role ?? 'Unknown role',
          created_at: row.created_at,
          moved_at: row.pipeline_stage_at,
          reviewable: row.reviewable,
          submission_status: row.status,
          // Absent on packets last written before run_revision shipped, and on any run whose
          // deployment supplied no SHA. Null means unknown, never "current".
          run_revision: row.run_revision,
          review_updated_at: row.review_updated_at,
          stage: deriveStage(row.pipeline_stage, row.status),
        };
      }),
    });
  });

  /**
   * PATCH /applications/:id/stage
   *
   * The student moving a card. Scoped to their own rows by the where clause, so a guessed id
   * touches nothing.
   */
  fastify.patch('/applications/:id/stage', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    // A malformed id reached Postgres as a uuid comparison and came back a 500. The repo's other
    // id-bearing routes validate the param; this one skipped it.
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid application id' });
    const { id } = params.data;
    const stage = (request.body as { stage?: unknown } | undefined)?.stage;

    if (!isStage(stage)) {
      return reply.status(400).send({ error: `stage must be one of: ${STAGES.join(', ')}` });
    }

    const updated = await db
      .update(generated_resumes)
      .set({ pipeline_stage: stage, pipeline_stage_at: new Date() })
      .where(and(eq(generated_resumes.id, id), eq(generated_resumes.user_id, userId)))
      .returning({ id: generated_resumes.id });

    if (updated.length === 0) return reply.status(404).send({ error: 'Application not found' });
    return reply.status(200).send({ id, stage });
  });

  /**
   * POST /interview-prep
   *
   * The questions this posting implies, each answered by the student's own resume bullet or marked
   * as having no answer. Derived, never generated: see engine/interviewPrep.ts.
   */
  fastify.post('/interview-prep', { preHandler: requireAuth, bodyLimit: 128 * 1024 }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    const parsed = z
      .object({
        jd_text: z.string().min(1).max(60_000),
        /* Same three exclusions as POST /jd-match, for the same reason and via the same helper.
           This route runs extractJdTerms too, so without them it turns the employer's office list
           into interview questions: "tell me about your experience with Bellevue". */
        job_context: z
          .object({
            company: z.string().max(200).optional(),
            role: z.string().max(200).optional(),
            location: z.string().max(500).nullish(),
            job_id: z.string().uuid().nullish(),
          })
          .optional(),
        spec: z
          .object({
            experience: z
              .array(
                z.object({
                  org: z.string().max(200).default(''),
                  bullets: z.array(z.string().max(2_000)).max(30).default([]),
                }),
              )
              .max(20)
              .default([]),
          })
          .optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request body' });

    let spec = parsed.data.spec as unknown as ResumeSpec | undefined;
    if (!spec) {
      const [profile] = await db.select().from(profiles).where(eq(profiles.user_id, userId));
      const stored = profile?.base_resume_json as ResumeSpec | null | undefined;
      if (!stored) return reply.status(404).send({ error: 'No main resume yet' });
      spec = stored;
    }

    // extractJdTerms directly, not scoreJdMatch('', jd) with an empty resume. That call read as if
    // it merged two meaningful sets when `matched` is structurally always empty against an empty
    // resume, and it dragged the scorer's user-facing copy along with it into a panel that is not
    // about scoring.
    const prep = buildInterviewPrep(
      extractJdTerms(parsed.data.jd_text, {
        ...parsed.data.job_context,
        location:
          parsed.data.job_context?.location ??
          (await postingRow(parsed.data.job_context?.job_id))?.location ??
          null,
      }),
      spec,
    );
    if (prep.items.length === 0) {
      return reply.status(200).send({
        ...prep,
        reason: 'This posting does not name enough specific skills to prepare questions from.',
      });
    }
    return reply.status(200).send(prep);
  });
}
