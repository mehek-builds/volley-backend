import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { profiles } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { resumeSpecText } from '../engine/resumeValidate';
import { scoreJdMatch, scoreBand, MIN_SCORABLE_TERMS } from '../engine/jdMatch';
import { findGapEvidence } from '../engine/gapEvidence';
import { checkResumeHealth } from '../engine/resumeHealth';
import { buildFunnel } from '../engine/funnel';
import { deriveStage, isStage, STAGES, BOARD_LIMIT } from '../engine/pipeline';
import { buildInterviewPrep } from '../engine/interviewPrep';
import { extractJdTerms } from '../engine/jdMatch';
import { generated_resumes, autofill_events } from '../db/schema';
import { readExperienceBank } from '../db/experienceBank';
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
  jd_text: z.string().min(1, 'jd_text is required').max(60_000, 'jd_text is too long to score'),
  // Optional override: score arbitrary resume text instead of the stored base resume. The tailored
  // per-application resume flows through here, and so does the "what if" editor in the dashboard.
  // .min(1) matters: an empty string is NOT the same as an absent field. Absent falls through to
  // the stored base resume and 404s when there is none, which routes the student to /start. An
  // empty string used to score as a confident 0% "Weak match", a claim about them that the input
  // never supported.
  resume_text: z.string().min(1, 'resume_text cannot be empty').max(30_000).optional(),
});

export async function jdMatchRoutes(fastify: FastifyInstance) {
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
        return reply.status(404).send({ error: 'No base resume yet' });
      }
      storedResumeText = resumeSpecText(spec);
    }

    const resumeText = body.resume_text ?? storedResumeText ?? '';
    const result = scoreJdMatch(resumeText, body.jd_text);

    return reply.status(200).send({
      score: result.score,
      scorable: result.scorable,
      reason: result.reason,
      band: result.score === null ? null : scoreBand(result.score, result.required_coverage),
      required_coverage: result.required_coverage,
      term_count: result.term_count,
      min_scorable_terms: MIN_SCORABLE_TERMS,
      // Display strings, not match keys: the student should see "CI/CD", not "ci cd".
      matched: result.matched.map((t) => ({ term: t.term, display: t.display, weight: t.weight })),
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
      readExperienceBank(userId),
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

    // Minutes east of UTC, from the client. Weeks are the student's weeks: bucketing by UTC put a
    // Dubai student's Monday-morning applications in the previous week's bar.
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
      cards: rows.map((row) => {
        const context = (row.job_context ?? {}) as { company?: string; role?: string };
        return {
          id: row.id,
          company: context.company ?? 'Unknown company',
          role: context.role ?? 'Unknown role',
          created_at: row.created_at,
          moved_at: row.pipeline_stage_at,
          reviewable: row.reviewable,
          submission_status: row.status,
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
      if (!stored) return reply.status(404).send({ error: 'No base resume yet' });
      spec = stored;
    }

    // extractJdTerms directly, not scoreJdMatch('', jd) with an empty resume. That call read as if
    // it merged two meaningful sets when `matched` is structurally always empty against an empty
    // resume, and it dragged the scorer's user-facing copy along with it into a panel that is not
    // about scoring.
    const prep = buildInterviewPrep(extractJdTerms(parsed.data.jd_text), spec);
    if (prep.items.length === 0) {
      return reply.status(200).send({
        ...prep,
        reason: 'This posting does not name enough specific skills to prepare questions from.',
      });
    }
    return reply.status(200).send(prep);
  });
}
