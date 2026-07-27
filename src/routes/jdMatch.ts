import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { profiles } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { resumeSpecText } from '../engine/resumeValidate';
import { scoreJdMatch, scoreBand, MIN_SCORABLE_TERMS } from '../engine/jdMatch';
import { findGapEvidence } from '../engine/gapEvidence';
import { checkResumeHealth } from '../engine/resumeHealth';
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
}
