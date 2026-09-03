import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { db } from '../db/index';
import { profiles } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { resumeSpecText } from '../engine/resumeValidate';
import { scoreJdMatch, scoreBand, MIN_SCORABLE_TERMS, segmentJd, extractJdTermsWithSections, normalizeTerm, ELIGIBILITY_LINE, type JdTerm } from '../engine/jdMatch';
import { scorePosting, splitClauses, statesTiming, UNSCOREABLE, type CandidateFacts } from '../engine/clauseMatch';
import { judgeCompetenciesCached } from '../llm/competencyCache';
import { findGapEvidence } from '../engine/gapEvidence';
import { checkResumeHealth } from '../engine/resumeHealth';
import { buildFunnel } from '../engine/funnel';
import { deriveStage, isStage, STAGES, BOARD_LIMIT } from '../engine/pipeline';
import { buildInterviewPrep } from '../engine/interviewPrep';
import { extractJdTerms } from '../engine/jdMatch';
import { applications, generated_resumes, autofill_events, monitored_jobs, career_page_sources } from '../db/schema';
import { AUTONOMOUS_PORTAL_FAMILIES } from '../lib/portalSubmission';
import { resolveRevision } from '../lib/buildInfo';
import { authoritativeSubmissionProjection } from '../lib/authoritativeSubmissionProjection';
import { SUBMISSION_AUTHORITY_SCHEMA_VERSION } from '../lib/submissionAuthorityRevision';
import {
  submissionAuthorityPublicationForPacket,
  submissionAuthorityRefusalForWire,
  submissionAuthorityRefusalTallies,
  submissionAuthorityUnavailableMarker,
  type SubmissionAuthorityRefusal,
} from '../lib/submissionAuthorityEnvelope';
import { allowHourly, LIMITS, rateLimitedReply } from '../middleware/quota';
import { readExperienceBank, readExperienceBankOrSeedFromBaseResume } from '../db/experienceBank';
import type { ResumeSpec } from '../llm/resumeSpec';
import { requireFeature } from '../lib/entitlements';
import { accountRequiresSponsor, boardConditions } from './jobMonitor';

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
 * HOW MUCH OF THE POSTING THE SCORE IS ACTUALLY DRAWN OVER.
 *
 * `term_count` is a count of what the extractor RECOGNISED, and it was being read as a count of what
 * the posting ASKED FOR. Those are the same number only when the extractor read everything, and on a
 * prose-heavy posting they are far apart: a Databricks PM internship states roughly eight things and
 * yields three or four terms, so the screen printed "3 of 3 requirements we counted" beside a score
 * of 100 and a student read it as a perfect match. The denominator was self-fulfilling - a
 * requirement the extractor could not tokenize left the numerator and the denominator together, so
 * failing to read a requirement could only ever raise the score.
 *
 * This changes no term, no weight and no score. It only lets the caller say what was not read.
 *
 * WHY THE FILTERS. A raw count of term-less lines would be noise: the sections the engine scores
 * still contain dispositions ("curious", "thrives in ambiguity"), eligibility boilerplate (GPA,
 * work authorization) and timing lines, none of which a resume can be scored against and all of
 * which the codebase ALREADY has vocabularies for. Counting those as "requirements we could not
 * read" would make the caption lie in the opposite direction, and it would break the one posting
 * this repo pins as genuinely stating nothing. So an unread line is only counted when it is not
 * something the engine deliberately declines to score.
 *
 * KNOWN AND DELIBERATE UNDER-COUNT. splitClauses drops any line under four words, a floor it holds
 * for the clause judge's own reasons, so a terse bullet ("Proficiency in Excel") is counted neither
 * read nor unread and a terse posting reports 0/0. That is the safe direction and it is why this
 * reuses splitClauses instead of splitting lines itself: under-counting means the caption stays
 * quiet about a requirement it cannot see, whereas a private splitter with a lower floor would
 * start counting headings and fragments as requirements the extractor "could not read", which is a
 * claim about the student's resume that would not be true. `unread` is therefore a floor on what
 * was missed, never an estimate of it, and the caption must be worded to match.
 */
export function requirementLineCoverage(
  jdText: string,
  context: Parameters<typeof extractJdTermsWithSections>[1],
): { read: number; unread: number } {
  const { terms, scored } = extractJdTermsWithSections(jdText, context);
  const keys = new Set<string>();
  for (const term of terms as JdTerm[]) {
    keys.add(term.term);
    for (const alternative of term.alternatives ?? []) keys.add(alternative);
  }
  let read = 0;
  let unread = 0;
  for (const section of scored) {
    for (const clause of splitClauses(section.text)) {
      const hay = ` ${normalizeTerm(clause)} `;
      /* Whole-word, never substring: `ai` must not mark a line because it says "available". */
      if ([...keys].some((key) => key && hay.includes(` ${key} `))) {
        read += 1;
        continue;
      }
      if (ELIGIBILITY_LINE.test(clause)) continue;
      if (statesTiming(clause)) continue;
      if (UNSCOREABLE.some((pattern) => pattern.test(clause))) continue;
      unread += 1;
    }
  }
  return { read, unread };
}

/**
 * Posting reads have two authorization levels. A caller-supplied UUID must still name a row on the
 * current verified board. A closed row can be read only when an application or generated packet
 * already binds that row to the signed-in account. This keeps historical review usable without
 * treating knowledge of a UUID as permission to read an unsurfaced description.
 */
export type ActionPostingRow = {
  external_id: string;
  company_name: string | null;
  location: string | null;
  portal_country: string | null;
  job_country: string | null;
  description: string | null;
  apply_url: string;
  posting_url: string;
  ats_name: string;
  board_token: string;
};

const actionPostingSelection = {
  external_id: monitored_jobs.external_id,
  company_name: career_page_sources.company_name,
  location: monitored_jobs.location,
  // Bounded ATS metadata persisted in monitored_jobs.raw_json. Null on rows created before the
  // preservation path shipped, and filled by the next ordinary poll without a migration.
  portal_country: sql<string | null>`${monitored_jobs.raw_json}->>'portal_country'`,
  job_country: monitored_jobs.job_country,
  // Capped at the same 60k the request schema allows, so a posting cannot arrive here longer
  // than the engine's own bound just because it skipped the schema on its way in.
  description: sql<string>`left(${monitored_jobs.description}, 60000)`,
  apply_url: monitored_jobs.apply_url,
  posting_url: monitored_jobs.posting_url,
  ats_name: career_page_sources.ats_name,
  board_token: career_page_sources.board_token,
} as const;

function normalizeActionPostingRow(row: {
  external_id: string;
  company_name: string;
  location: string | null;
  portal_country: string | null;
  job_country: string;
  description: string;
  apply_url: string;
  posting_url: string;
  ats_name: string;
  board_token: string;
}): ActionPostingRow {
  return {
    external_id: row.external_id,
    company_name: row.company_name,
    location: row.location,
    portal_country: row.portal_country,
    job_country: row.job_country,
    description: row.description,
    apply_url: row.apply_url,
    posting_url: row.posting_url,
    ats_name: row.ats_name,
    board_token: row.board_token,
  };
}

/**
 * A raw job id supplied by a caller has no authority of its own. It may resolve only through the
 * exact strict predicate that defines verified current board inventory.
 */
export async function currentActionPostingRow(
  jobId: string | null | undefined,
  sponsorOnly = false,
): Promise<ActionPostingRow | null> {
  if (!jobId) return null;
  const [row] = await db
    .select(actionPostingSelection)
    .from(monitored_jobs)
    .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
    .where(
      and(
        eq(monitored_jobs.id, jobId),
        ...boardConditions({ sponsorOnly, requireVerifiedEvidence: true }),
      ),
    )
    .limit(1);
  return row ? normalizeActionPostingRow(row) : null;
}

/**
 * Closed postings remain useful evidence for a packet the account already owns. This weaker read
 * is impossible to reach through possession of a job UUID alone: either applications.job_id or an
 * owned generated packet's job_context must already bind the user to the row.
 */
export async function ownedHistoricalActionPostingRow(
  jobId: string | null | undefined,
  userId: string,
): Promise<ActionPostingRow | null> {
  if (!jobId) return null;
  const [row] = await db
    .select(actionPostingSelection)
    .from(monitored_jobs)
    .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
    .where(
      and(
        eq(monitored_jobs.id, jobId),
        eq(career_page_sources.enabled, true),
        inArray(career_page_sources.ats_name, [...AUTONOMOUS_PORTAL_FAMILIES]),
        sql`(
          exists (
            select 1 from ${applications}
            where ${applications.user_id} = ${userId}
              and ${applications.job_id} = ${monitored_jobs.id}
          )
          or exists (
            select 1 from ${generated_resumes}
            where ${generated_resumes.user_id} = ${userId}
              and ${generated_resumes.job_context}->>'job_id' = ${monitored_jobs.id}::text
          )
        )`,
      ),
    )
    .limit(1);
  return row ? normalizeActionPostingRow(row) : null;
}

/** Strict current inventory first, with a user-owned historical fallback for closed packets. */
export async function actionPostingRowForUser(
  jobId: string | null | undefined,
  userId: string,
): Promise<ActionPostingRow | null> {
  if (!jobId) return null;
  const sponsorOnly = await accountRequiresSponsor(userId);
  return (await currentActionPostingRow(jobId, sponsorOnly))
    ?? ownedHistoricalActionPostingRow(jobId, userId);
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
    const feedback = await requireFeature(userId, 'ai_resume_feedback', 'resume_requirement_suggestions');
    if (!feedback.allowed) return reply.status(402).send(feedback.denial);

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

    const requestedJobId = parsed.data.job_context?.job_id;
    const posting = await actionPostingRowForUser(requestedJobId, userId);
    if (requestedJobId && !posting) {
      return reply.status(409).send({
        error: 'Current verified posting not found',
        code: 'job_not_available',
      });
    }
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

    const requestedJobId = body.job_context?.job_id;
    const posting = await actionPostingRowForUser(requestedJobId, userId);
    if (requestedJobId && !posting) {
      return reply.status(409).send({
        error: 'Current verified posting not found',
        code: 'job_not_available',
      });
    }

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
    /* THE COMPANY IS BACKFILLED FROM THE POSTING FOR THE SAME REASON THE LOCATION IS.
       selfReferenceTokens (engine/jdMatch.ts:2657) deletes the employer's own name from every
       section, on the ground that a posting cannot require experience with itself. It can only do
       that when a company reaches it, and this route was backfilling `location` from the job row
       while leaving `company` to whatever the caller happened to send. A caller that omits it gets
       the employer's name scored as an unmet requirement: measured on a Databricks posting, the
       term set is 4 terms with the company supplied and 5 without, the fifth being `databricks`.
       The dashboard does send it, so this is a latent hole rather than a live defect, but the route
       already knows the answer and there is no reason for it to depend on the caller. */
    const result = scoreJdMatch(resumeText, jdText, {
      ...body.job_context,
      company: body.job_context?.company ?? posting?.company_name ?? undefined,
      location: body.job_context?.location ?? posting?.location ?? null,
    });

    const coverage = requirementLineCoverage(jdText, {
      ...body.job_context,
      company: body.job_context?.company ?? posting?.company_name ?? undefined,
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
      /* What the score is drawn over. A client that ignores these two fields sees exactly today's
         behaviour; a client that reads them can stop presenting term_count as the whole posting. */
      clauses_read: coverage.read,
      clauses_unread: coverage.unread,
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
    const feedback = await requireFeature(userId, 'ai_resume_feedback', 'resume_gap_evidence');
    if (!feedback.allowed) return reply.status(402).send(feedback.denial);

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
   *
   * SUBMISSION AUTHORITY. The dashboard treats this payload as one passive authority snapshot: it
   * requires a top-level `schema_version` of `submission-authority-v1`, the user's
   * `submission_authority_revision`, and a `submission_authority` envelope on EVERY card whose
   * `revision` equals that collection revision, and it throws "Application board authority was
   * incomplete." otherwise, which Board.tsx renders as "Could not load your board". Measured in
   * prod 2026-09-02: the payload carried none of those fields, so the board had been unloadable for
   * every user since the dashboard shipped that check (role-quick-website #466, 2026-08-31).
   *
   * The envelopes come from the same authoritative projection the submission path itself uses, in
   * ONE batched read over the page's packets (one transaction, one per-user advisory lock, the same
   * cost /resume/history already pays for its page), serialised by the one shared envelope builder.
   * The card's own `stage` and `submission_status` are untouched: the client derives what it shows
   * from the envelope, demoting an unconfirmed "applied" card to saved and routing a held or
   * repair-required one to review.
   *
   * FAIL-CLOSED, the same way as the list and history routes. A projection read failure attaches no
   * collection fields and no envelopes; a card whose envelope cannot be published (a held attempt
   * awaiting a manual handoff, a confirmation outside the client's vocabulary, see the builder)
   * gets none. The client then refuses the whole board rather than showing a card whose authority
   * it could not verify. That is deliberate: the board is a submission-evidence surface, and an
   * envelope this route would have to invent is worse than a board that says it could not load.
   * Each omission is logged with the packet id so the gap is diagnosable from the server side.
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

    const submissionAuthority = await (async () => {
      try {
        return await authoritativeSubmissionProjection({ userId, packetIds: rows.map((row) => row.id) });
      } catch (error) {
        request.log.warn(
          { err: error },
          'submission authority projection unavailable for the board; cards carry no envelope and the dashboard fails closed',
        );
        return null;
      }
    })();

    return reply.status(200).send({
      stages: STAGES,
      limit: BOARD_LIMIT,
      /* The commit serving this response, so "is this card's state current?" is answerable from one
       * request instead of a board call plus a /health call plus the assumption that nothing
       * deployed in between. Null when the deployment supplied no SHA; see lib/buildInfo. */
      revision: resolveRevision().revision,
      /* The passive-collection authority fields. Both are absent when the projection could not be
       * read, so the client sees an incomplete collection, never a fabricated revision. That is the
       * one condition the client must still refuse the WHOLE payload for: without them nothing
       * proves the payload came from a server that speaks this contract. */
      ...(submissionAuthority
        ? {
          schema_version: SUBMISSION_AUTHORITY_SCHEMA_VERSION,
          submission_authority_revision: submissionAuthority.revision,
        }
        : {}),
      cards: rows.map((row) => {
        const context = (row.job_context ?? {}) as { company?: string; role?: string; job_id?: string };
        const publication = submissionAuthority
          ? submissionAuthorityPublicationForPacket({
            packetId: row.id,
            projection: submissionAuthority.byPacketId.get(row.id),
            retrySafety: submissionAuthority.retrySafetyByPacketId.get(row.id),
            revision: submissionAuthority.revision,
          })
          // The batched read failed for every packet on the page, so the server has no opinion
          // about any of them. The collection fields above are absent for the same reason.
          : ({ published: false, reason: 'projection_read_failed' } as const);
        if (!publication.published) {
          /* WHICH FIELD, AND WHAT SHAPE. This line already named the packet, the reason, the
           * projection state and the retry kind, and on 2026-09-03 that was still not enough to act
           * on: 163 of this account's 200 cards came back `unpublishable_projection`, which SEVEN
           * separate checks across FOUR branches of the builder can produce, and the value that
           * failed is deliberately withheld from the wire so no client call could narrow it. The
           * three rejection fields are the builder naming its own refusal - the branch that
           * classified the packet, the field of the shape it would have emitted, and the class that
           * field failed (see SubmissionAuthorityRejectedShape). They are a classification, never
           * the value: an attempt id stays an internal identifier. Absent when the reason is
           * already the whole story, and pino drops the keys then. */
          const rejected = 'rejected' in publication ? publication.rejected : undefined;
          request.log.warn(
            {
              packetId: row.id,
              reason: publication.reason,
              projectionState: submissionAuthority?.byPacketId.get(row.id)?.state,
              retrySafetyKind: submissionAuthority?.retrySafetyByPacketId.get(row.id)?.kind,
              rejectedBranch: rejected?.branch,
              rejectedField: rejected?.field,
              rejectedShape: rejected?.shape,
            },
            'board card has no publishable submission authority envelope; it is published as unverifiable',
          );
        }
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
          /* Exactly one of these two, always. An envelope is the server vouching for this card's
           * send state; the marker is the server saying, in machine-readable form, that it cannot,
           * and why. Silently omitting both was the third possibility, and it made an unverifiable
           * card indistinguishable from a server that does not speak this contract, which is what
           * made one such card take the whole board down. The card's own stage and
           * submission_status are untouched either way, and no envelope is ever invented. */
          ...(publication.published
            ? { submission_authority: publication.envelope }
            : { submission_authority_unavailable: submissionAuthorityUnavailableMarker(row.id, publication.reason) }),
        };
      }),
    });
  });

  /**
   * GET /applications/board/authority-rejections
   *
   * WHY THIS IS A ROUTE AND NOT A FIELD, 2026-09-03.
   *
   * #894 gave every shape-caused refusal a SubmissionAuthorityRejection - the branch that classified
   * the packet, the field of the wire shape it would have emitted, the class that field failed - and
   * put it in two server log lines. That was the correct place for it and it turned out to be an
   * unreadable one: Litos serves from Railway, the person debugging this has no log reader wired up
   * here, and the two Vercel projects are abandoned aliases with empty logs. So the largest single
   * send blocker on the account (163 of 200 cards refused on 2026-09-03, all under the one word
   * `unpublishable_projection`) stayed unfalsifiable from every surface she can actually reach.
   *
   * WHY IT CANNOT QUARANTINE A CARD. It publishes no card. The board's payload, its collection
   * fields, its envelopes and its `submission_authority_unavailable` markers are not touched by a
   * byte, and neither is the per-packet submission response in applications.ts. The dashboard's
   * exact-shape parser is applied to the ENVELOPE object and to nothing else, so the only way to
   * quarantine a card is to change what an envelope or its card looks like, and this route changes
   * neither. That is the whole reason it exists as a separate read rather than as an additive key.
   *
   * WHAT WAS MEASURED ABOUT THE CLIENT, 2026-09-03, and what it does NOT say. #894 reported that the
   * role-quick-website checkout carries no reader for `submission_authority` at all. That checkout
   * is a shallow clone whose main tree is effectively its 2026-08-26 clone state; the readers live
   * in a sibling worktree of the same repo (rq-counter, branch
   * fix/home-sent-count-survives-a-failed-inventory, 2026-09-02), and they say this:
   *   - features/applications/domain/submission-authority-envelope.ts:174 applies `exactKeys` to the
   *     envelope, its projection and its receipt. Nothing applies it to the card or to the response
   *     root, and infrastructure/response-shape.ts:184 spreads unknown top-level keys through.
   *   - domain/board-submission-authority.ts:29 treats a card with no `submission_authority` as
   *     ABSENT rather than corrupt, and the collection check at :58 skips it, so one unpublishable
   *     card no longer takes the board down.
   *   - `submission_authority_unavailable` appears ZERO times in that tree. The marker the board
   *     has published per card since 56ab02a ("One unverifiable card is one card, not the whole
   *     board") is read by nothing.
   * So an additive key on the marker would very likely have been inert too. "Very likely" against a
   * worktree that may not be the deployed commit is not the standard this contract is held to, and a
   * quarantined card is exactly the failure being diagnosed, so the diagnosis goes where it cannot
   * be wrong: its own route.
   *
   * A CLASSIFICATION, NEVER A VALUE. Only branch, field and shape travel, all three from closed
   * vocabularies re-checked at the boundary by submissionAuthorityRefusalForWire. The attempt id,
   * timestamp, URL or receipt text that failed is not carried in any form. `packet_id` is the
   * caller's own row id.
   *
   * SCOPED TO THE CALLER, like every other read in this file: the row select is filtered by
   * `user_id` before anything is classified, so a `packet_id` naming somebody else's packet
   * classifies nothing and returns an empty census rather than a 404 that confirms it exists.
   *
   * Deliberately NOT under /internal: that family is uniformly gated by the cron secret
   * (isCronAuthorized) and serves no user's own rows. A route that answers "which of MY packets" has
   * to authenticate as the user, which is what /metrics/funnel next door already does. It inherits
   * /applications' drain rule and is refused during a submission cutover, which is correct - it is a
   * diagnostic, not an evidence sink, and nothing here should widen the drain surface.
   */
  fastify.get('/applications/board/authority-rejections', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const query = z.object({ packet_id: z.string().uuid().optional() }).safeParse(request.query ?? {});
    if (!query.success) return reply.status(400).send({ error: 'Invalid packet id' });

    /* ONE COLUMN. The board's own select projects seven, because it draws cards; this classifies
     * them, and every input the classification needs comes from the projection read below. Pulling
     * `job_context` here would carry a whole job description per row into a diagnostic. Same
     * ordering and same BOARD_LIMIT as the board, so "the 163" here are the same 163 there. */
    const rows = await db
      .select({ id: generated_resumes.id })
      .from(generated_resumes)
      .where(query.data.packet_id
        ? and(eq(generated_resumes.user_id, userId), eq(generated_resumes.id, query.data.packet_id))
        : eq(generated_resumes.user_id, userId))
      .orderBy(desc(generated_resumes.created_at))
      .limit(BOARD_LIMIT);

    const submissionAuthority = await (async () => {
      try {
        return await authoritativeSubmissionProjection({ userId, packetIds: rows.map((row) => row.id) });
      } catch (error) {
        request.log.warn(
          { err: error },
          'submission authority projection unavailable for the rejection census; every packet reports projection_read_failed',
        );
        return null;
      }
    })();

    const refusals: SubmissionAuthorityRefusal[] = [];
    for (const row of rows) {
      const publication = submissionAuthority
        ? submissionAuthorityPublicationForPacket({
          packetId: row.id,
          projection: submissionAuthority.byPacketId.get(row.id),
          retrySafety: submissionAuthority.retrySafetyByPacketId.get(row.id),
          revision: submissionAuthority.revision,
        })
        // The same fallback the board uses when the batched read failed for every packet on the
        // page: the server has no opinion about any of them, and says so per packet.
        : ({ published: false, reason: 'projection_read_failed' } as const);
      const refusal = submissionAuthorityRefusalForWire(row.id, publication);
      if (refusal) refusals.push(refusal);
    }

    return reply.status(200).send({
      schema_version: SUBMISSION_AUTHORITY_SCHEMA_VERSION,
      /* Null, not absent, when the projection could not be read. The board omits its collection
       * fields in that case because their presence is what proves the payload is authority the
       * client may act on; nothing here is authority to act on anything, so an explicit null is the
       * honest answer and saves a reader guessing whether the key was dropped or the read failed. */
      submission_authority_revision: submissionAuthority?.revision ?? null,
      /* The denominator, so a small census cannot be misread as a small problem, and the reader can
       * tell "no packet was refused" from "no packet was classified". */
      packets_classified: rows.length,
      packets_refused: refusals.length,
      /* The largest refusal class first. This is the reading the 2026-09-03 census could not
       * produce: 163 cards under one reason word is a count over seven return sites, while a ranked
       * (branch, field, shape) table is a list of repairs. */
      summary: submissionAuthorityRefusalTallies(refusals),
      /* And the packets themselves, so a repair can be verified on the exact rows it was aimed at.
       * Bounded by BOARD_LIMIT above, so this is at most one id and three closed-vocabulary strings
       * per board card. */
      rejections: refusals,
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

    const requestedJobId = parsed.data.job_context?.job_id;
    const posting = await actionPostingRowForUser(requestedJobId, userId);
    if (requestedJobId && !posting) {
      return reply.status(409).send({
        error: 'Current verified posting not found',
        code: 'job_not_available',
      });
    }

    // extractJdTerms directly, not scoreJdMatch('', jd) with an empty resume. That call read as if
    // it merged two meaningful sets when `matched` is structurally always empty against an empty
    // resume, and it dragged the scorer's user-facing copy along with it into a panel that is not
    // about scoring.
    /* UNGROUPED, so this pane and the score pane cannot disagree. Interview prep asks a question
       per named technology; handed a folded choice it asked one question about the whole group and
       reported it unanswered, on a posting where scoreJdMatch had already counted that requirement
       met from the branch the resume carries. Two panes of one product, two answers. */
    const prep = buildInterviewPrep(
      extractJdTerms(
        parsed.data.jd_text,
        {
          ...parsed.data.job_context,
          location:
            parsed.data.job_context?.location ??
            posting?.location ??
            null,
        },
        { groupChoices: false },
      ),
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
