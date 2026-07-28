import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index';
import { career_page_sources, monitored_jobs, profiles } from '../db/schema';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import { fetchSourceJobs, type JobSourceInput, type SupportedJobBoard } from '../lib/jobMonitor';
import { optionalAuth } from '../middleware/auth';
import { scoreJdMatch } from '../engine/jdMatch';
import { resumeSpecText } from '../engine/resumeValidate';
import type { ResumeSpec } from '../llm/resumeSpec';

const sourceSchema = z.object({
  company_name: z.string().trim().min(1).max(200),
  ats_name: z.enum(['greenhouse', 'lever', 'ashby']),
  board_token: z.string().trim().min(1).max(300),
  career_url: z.string().url().max(4000),
  enabled: z.boolean().optional().default(true),
});

const sourcesBodySchema = z.object({ sources: z.array(sourceSchema).min(1).max(100) });
const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  location: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  remote: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const jobParamsSchema = z.object({ id: z.string().uuid() });

/**
 * How many postings get scored and ranked on a request.
 *
 * Sorting by fit cannot be expressed in the query, because the score is computed in this process,
 * so the sort has to happen over a set this route holds in memory: the newest RANKING_POOL
 * postings that match the filters.
 *
 * THE NUMBER IS A BUDGET, AND THE BUDGET IS EVENT-LOOP TIME. Measured on this engine (Node 22,
 * warm, a ~2KB resume against SCORING_CHARS-capped postings): 0.3-0.5 ms per posting on synthetic
 * text, and up to ~1.3 ms on term-dense real postings. That cost is SYNCHRONOUS — Fastify serves
 * nothing else while it runs — so the pool size is directly a latency ceiling for every other
 * in-flight request. At 100 that is roughly 30-130 ms. It was 200, which doubled that for a second
 * page of results almost nobody scrolls to. An earlier version of this comment called the pass
 * "the low tens of milliseconds" and the per-call cost "well under a millisecond"; both were
 * asserted rather than measured, and the numbers above replaced them (2026-07-28).
 *
 * The consequence is real and is why the response carries `ranked_pool` and `pool_exhausted`: past
 * RANKING_POOL matching postings, the next-newest is not considered for ranking however well it
 * fits. Filters are how a student narrows the pool, and the list has to SAY it stopped ranking
 * rather than quietly reporting no more results.
 */
export const RANKING_POOL = 100;

/**
 * How much of a posting gets scored.
 *
 * `monitored_jobs.description` is an unbounded `text` column holding whatever the board returned,
 * and the poller stores it verbatim. Without a cap, ranking pulled the FULL description for every
 * row in the pool: at the 5-50KB postings that are ordinary, that is megabytes of detoasted text
 * fetched, shipped from Neon, and held as JS strings in a serverless function on every keystroke
 * of a debounced search.
 *
 * 20k characters is well past where a posting states its requirements (the whole reason this
 * scores the full column instead of the 600-char preview) and it bounds both the transfer and the
 * scoring pass. POST /jd-match already caps its input at 60k for the same reason.
 */
export const SCORING_CHARS = 20_000;

/** The minimum a row needs to be rankable. Kept structural so the sort can be tested without a DB. */
export type RankableJob = {
  company_name: string;
  title: string;
  /** The posting text to score. Capped at SCORING_CHARS by the query, not the full column. */
  scored_description: string | null;
};

/**
 * Postings ordered best fit first, carrying the score that put them there.
 *
 * Exported for its own tests. The three behaviours worth pinning down, and each is a decision
 * rather than an accident:
 *
 *  - Unscorable postings (jdMatch returned null) sort BELOW every scored one, and hold their
 *    incoming order among themselves. They are not zeros; a zero would rank a posting we declined
 *    to judge alongside one we judged and found nothing in.
 *  - Equal scores keep the incoming order, which the caller has already set to newest first. Two
 *    88% matches are separated by recency, which is the only other fact we have.
 *  - The sort is stable by construction (the index tiebreak), not by trusting the engine's sort to
 *    be. Array#sort stability is specified now, but the comparator saying so is what makes the
 *    intent survive someone swapping the sort.
 */
export function rankByFit<T extends RankableJob>(
  rows: readonly T[],
  resumeText: string,
): Array<{ row: T; score: number | null }> {
  const scored = rows.map((row, index) => ({
    row,
    // The posting never asks for experience with its own company or job title, so both are excluded
    // from the requirement set. Same context the review screen passes.
    score: scoreJdMatch(resumeText, row.scored_description ?? '', {
      company: row.company_name,
      role: row.title,
    }).score,
    index,
  }));
  scored.sort((a, b) => {
    if (a.score === null && b.score === null) return a.index - b.index;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score || a.index - b.index;
  });
  return scored.map(({ row, score }) => ({ row, score }));
}

/**
 * The student's main resume as plain text, or null if there is nothing to rank against.
 *
 * Null covers three different situations on purpose — signed out, signed in with no resume yet, and
 * signed in with a resume that holds no text — because the list behaves identically in all three:
 * unranked, unscored, newest first. Returning a 404 here (as POST /jd-match does) would be wrong;
 * that route exists to answer a question about one posting, while this one has a perfectly good
 * answer without a resume.
 */
async function baseResumeText(userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  const [profile] = await db
    .select({ base_resume_json: profiles.base_resume_json })
    .from(profiles)
    .where(eq(profiles.user_id, userId))
    .limit(1);
  const spec = profile?.base_resume_json as ResumeSpec | null | undefined;
  if (!spec) return null;
  const text = resumeSpecText(spec).trim();
  return text.length > 0 ? text : null;
}

function requireOperator(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!isCronConfigured() || !isCronAuthorized(request)) {
    reply.status(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

function configuredSources(): JobSourceInput[] {
  const raw = process.env.JOB_MONITOR_SOURCES_JSON;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('JOB_MONITOR_SOURCES_JSON must be valid JSON');
  }
  const result = z.array(sourceSchema).max(100).safeParse(parsed);
  if (!result.success) throw new Error('JOB_MONITOR_SOURCES_JSON contains an invalid source');
  return result.data;
}

async function upsertSources(sources: JobSourceInput[]) {
  for (const source of sources) {
    const rows = await db.insert(career_page_sources).values(source).onConflictDoUpdate({
      target: [career_page_sources.ats_name, career_page_sources.board_token],
      set: {
        company_name: source.company_name,
        career_url: source.career_url,
        enabled: source.enabled ?? true,
      },
    }).returning({ id: career_page_sources.id });
    if (source.enabled === false && rows[0]) {
      await db.update(monitored_jobs).set({ is_active: false }).where(eq(monitored_jobs.source_id, rows[0].id));
    }
  }
}

async function pollSource(source: typeof career_page_sources.$inferSelect) {
  try {
    const jobs = await fetchSourceJobs({
      ats_name: source.ats_name as SupportedJobBoard,
      board_token: source.board_token,
    });
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.update(monitored_jobs).set({ is_active: false }).where(eq(monitored_jobs.source_id, source.id));
      for (const job of jobs) {
        await tx.insert(monitored_jobs).values({
          source_id: source.id,
          company_name: source.company_name,
          ...job,
          last_seen_at: now,
          is_active: true,
        }).onConflictDoUpdate({
          target: [monitored_jobs.source_id, monitored_jobs.external_id],
          set: {
            company_name: source.company_name,
            title: job.title,
            location: job.location,
            department: job.department,
            employment_type: job.employment_type,
            description: job.description,
            apply_url: job.apply_url,
            posting_url: job.posting_url,
            remote: job.remote,
            posted_at: job.posted_at,
            last_seen_at: now,
            is_active: true,
            raw_json: job.raw_json,
          },
        });
      }
    });
    await db.update(career_page_sources).set({ last_polled_at: now, last_error: null }).where(eq(career_page_sources.id, source.id));
    return { source_id: source.id, company: source.company_name, jobs: jobs.length, ok: true as const };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 2000) : 'Career page poll failed';
    await db.update(career_page_sources).set({ last_polled_at: new Date(), last_error: message }).where(eq(career_page_sources.id, source.id));
    return { source_id: source.id, company: source.company_name, jobs: 0, ok: false as const, error: message };
  }
}

export async function jobMonitorRoutes(fastify: FastifyInstance) {
  /**
   * GET /jobs
   *
   * The list of live postings, and — for a signed-in student with a main resume — how well each one
   * matches it, best first.
   *
   * WHY THE RANKING HAPPENS HERE AND NOT IN THE BROWSER
   * ---------------------------------------------------
   * Not because it is free — see RANKING_POOL for the measured cost, which is real and synchronous.
   * Because the ORDER cannot be known until every score is. Scoring in the client would mean one
   * request per row and a list that cannot be SORTED by fit until all of them land, which is to say
   * a list that is not sorted by fit. That argument stands on its own and does not need a
   * performance claim propping it up; an earlier version of this paragraph had one, unmeasured, and
   * it was wrong by roughly an order of magnitude.
   *
   * FOUR RULES THIS HOLDS
   * ---------------------
   *  - IT SCORES THE WHOLE POSTING, NOT THE PREVIEW. The payload's `description` is truncated to
   *    600 characters for transport; the score reads the full column. Scoring the preview would
   *    grade every posting on its intro paragraph, which is where the requirements are not.
   *  - AN UNSCORABLE POSTING GETS null, NEVER 0. jdMatch refuses to score a posting that lists too
   *    few real requirements, and 0 there is a claim about the student's resume that the input
   *    never supported. Those rows sort last, keeping their newest-first order among themselves.
   *  - NO RESUME MEANS NO SCORES AT ALL. Signed in without a main resume, the list behaves exactly
   *    as it does signed out. There is nothing honest to rank against.
   *  - THE RANKING POOL IS BOUNDED AND SAID OUT LOUD. Ordering by fit means the ordering cannot be
   *    pushed into SQL, so the pool is the RANKING_POOL newest matching postings and the response
   *    reports both `ranked` and `ranked_pool` rather than implying the whole board was considered.
   */
  fastify.get('/jobs', { preHandler: optionalAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid job filters' });
    const { q, location, company, remote, limit, offset } = parsed.data;
    const conditions = [eq(monitored_jobs.is_active, true), eq(career_page_sources.enabled, true)];
    if (q) conditions.push(or(ilike(monitored_jobs.title, `%${q}%`), ilike(monitored_jobs.description, `%${q}%`))!);
    if (location) conditions.push(ilike(monitored_jobs.location, `%${location}%`));
    if (company) conditions.push(ilike(monitored_jobs.company_name, `%${company}%`));
    if (remote) conditions.push(eq(monitored_jobs.remote, remote === 'true'));

    const resumeText = await baseResumeText(request.jwtPayload?.userId);

    const selection = {
      id: monitored_jobs.id,
      company_name: monitored_jobs.company_name,
      title: monitored_jobs.title,
      location: monitored_jobs.location,
      department: monitored_jobs.department,
      employment_type: monitored_jobs.employment_type,
      description: sql<string>`left(${monitored_jobs.description}, 600)`,
      apply_url: monitored_jobs.apply_url,
      posting_url: monitored_jobs.posting_url,
      remote: monitored_jobs.remote,
      posted_at: monitored_jobs.posted_at,
      first_seen_at: monitored_jobs.first_seen_at,
      ats_name: career_page_sources.ats_name,
      /* The company's OWN careers page, which is the only field here that can carry the company's
         own domain. Every other URL on the row points at the job board: apply_url and posting_url
         are both greenhouse/lever/ashby, so a client deriving a company identity from either gets
         the board's identity for every row instead. Operators sometimes register the board URL as
         the careers URL too, so the client still has to check before trusting it. */
      career_url: career_page_sources.career_url,
    };
    const newestFirst = [
      desc(monitored_jobs.posted_at),
      desc(monitored_jobs.first_seen_at),
      desc(monitored_jobs.id),
    ] as const;

    if (!resumeText) {
      const rows = await db
        .select(selection)
        .from(monitored_jobs)
        .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
        .where(and(...conditions))
        .orderBy(...newestFirst)
        .limit(limit + 1)
        .offset(offset);
      return reply.send({
        jobs: rows.slice(0, limit).map((row) => ({ ...row, match_score: null })),
        limit,
        offset,
        has_more: rows.length > limit,
        ranked: false,
        ranked_pool: null,
        pool_exhausted: false,
      });
    }

    /* The scored text is pulled for scoring only, and capped at SCORING_CHARS. It never reaches
       the payload: `description` in `selection` is the 600-char preview, and the scored copy is
       dropped when the response is built.
       One row past the pool is fetched so the route can tell "the ranking stopped here" apart from
       "the board ends here". They are different sentences and the UI says different things. */
    const pool = await db
      .select({
        ...selection,
        scored_description: sql<string>`left(${monitored_jobs.description}, ${SCORING_CHARS})`,
      })
      .from(monitored_jobs)
      .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
      .where(and(...conditions))
      .orderBy(...newestFirst)
      .limit(RANKING_POOL + 1);

    const poolExhausted = pool.length > RANKING_POOL;
    const scored = rankByFit(pool.slice(0, RANKING_POOL), resumeText);

    const page = scored.slice(offset, offset + limit);
    return reply.send({
      jobs: page.map(({ row, score }) => {
        const { scored_description: _dropped, ...job } = row;
        return { ...job, match_score: score };
      }),
      limit,
      offset,
      has_more: scored.length > offset + limit,
      ranked: true,
      ranked_pool: scored.length,
      /* True when postings exist that were never ranked. Without this the client cannot tell the
         end of the ranking from the end of the board, and `has_more: false` at the pool boundary
         reads as "you have seen everything" when the truth is "we stopped ranking here". */
      pool_exhausted: poolExhausted,
    });
  });

  fastify.get('/jobs/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = jobParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid job id' });
    const rows = await db
      .select({
        id: monitored_jobs.id,
        company_name: monitored_jobs.company_name,
        title: monitored_jobs.title,
        location: monitored_jobs.location,
        department: monitored_jobs.department,
        employment_type: monitored_jobs.employment_type,
        description: monitored_jobs.description,
        apply_url: monitored_jobs.apply_url,
        posting_url: monitored_jobs.posting_url,
        remote: monitored_jobs.remote,
        posted_at: monitored_jobs.posted_at,
        first_seen_at: monitored_jobs.first_seen_at,
        is_active: monitored_jobs.is_active,
        ats_name: career_page_sources.ats_name,
        career_url: career_page_sources.career_url,
      })
      .from(monitored_jobs)
      .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
      .where(and(
        eq(monitored_jobs.id, parsed.data.id),
        eq(monitored_jobs.is_active, true),
        eq(career_page_sources.enabled, true),
      ))
      .limit(1);
    if (!rows[0]) return reply.status(404).send({ error: 'Job not found' });
    return reply.send({ job: rows[0] });
  });

  fastify.post('/internal/job-monitor/sources', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireOperator(request, reply)) return;
    const parsed = sourcesBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid career page sources', detail: parsed.error.issues });
    await upsertSources(parsed.data.sources);
    return reply.status(204).send();
  });

  fastify.get('/internal/job-monitor', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireOperator(request, reply)) return;
    const envSources = configuredSources();
    if (envSources.length > 0) await upsertSources(envSources);
    const sources = await db.select().from(career_page_sources)
      .where(eq(career_page_sources.enabled, true))
      .orderBy(sql`${career_page_sources.last_polled_at} asc nulls first`)
      .limit(20);
    const results = [];
    for (let index = 0; index < sources.length; index += 4) {
      results.push(...await Promise.all(sources.slice(index, index + 4).map(pollSource)));
    }
    return reply.send({
      sources: results.length,
      jobs: results.reduce((sum, result) => sum + result.jobs, 0),
      failed: results.filter((result) => !result.ok).length,
      results,
    });
  });
}
