import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index';
import { career_page_sources, monitored_jobs, profiles } from '../db/schema';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import { fetchSourceJobs, POLLABLE_JOB_BOARDS, type JobSourceInput, type SupportedJobBoard } from '../lib/jobMonitor';
import { AUTONOMOUS_PORTAL_FAMILIES } from '../lib/portalSubmission';
import { optionalAuth } from '../middleware/auth';
import { scoreJdMatch } from '../engine/jdMatch';
import { resumeSpecText } from '../engine/resumeValidate';
import type { ResumeSpec } from '../llm/resumeSpec';
import { rankingCacheKey, readRanking, writeRanking } from '../lib/rankingCache';
import { companyDomainFor } from '../lib/companyDomains';

const sourceSchema = z.object({
  company_name: z.string().trim().min(1).max(200),
  // Derived, never re-listed. This is the runtime gate on POST /internal/job-monitor/sources, and a
  // hand-written copy of the board list here would be the easiest place for the guarantee to rot:
  // it would accept a source the type system forbids, and the row would outlive the mistake.
  // POLLABLE_JOB_BOARDS, not AUTONOMOUS_PORTAL_FAMILIES: a source also needs a fetcher, and
  // accepting one without would store a row the daily poll can only ever record an error against.
  ats_name: z.enum(POLLABLE_JOB_BOARDS),
  board_token: z.string().trim().min(1).max(300),
  career_url: z.string().url().max(4000),
  enabled: z.boolean().optional().default(true),
});

const sourcesBodySchema = z.object({ sources: z.array(sourceSchema).min(1).max(100) });
const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  /* Title-only, and deliberately not the same thing as `q`. `q` matches the title OR the whole
     description, which is right for one general-purpose box and wrong for a field labelled
     "Job title": the board's title field would otherwise return every posting that merely mentions
     the words somewhere in its body. Both are supported and they AND together. */
  title: z.string().trim().max(200).optional(),
  location: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  remote: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const jobParamsSchema = z.object({ id: z.string().uuid() });

/**
 * THE BOARD MUST NEVER FALL BELOW THIS MANY SURFACED JOBS.
 *
 * A hard product floor, not a target and not a nice-to-have. Below a thousand postings the board
 * stops being a place a job seeker can browse and becomes a list they exhaust in one sitting, so a
 * board that quietly shrinks is a broken product that still returns HTTP 200.
 *
 * COUNTED THE WAY A USER SEES IT, which is the only count that means anything: active postings, from
 * enabled sources, on portals Litos can finish autonomously. That last clause is why this constant
 * lives next to the autonomy filter rather than off in a monitoring config - the two constraints
 * pull against each other. Narrowing what Litos may surface (demoting a portal to multi-step, say)
 * directly subtracts from this number, so whoever tightens the first has to answer for the second,
 * and this check is what forces that conversation instead of letting the board silently drain.
 *
 * Headroom today: ~7,100 surfaced against a floor of 1,000, all from Greenhouse, Lever and Ashby.
 *
 * If this fires, DO NOT fix it by lowering the number. It is a symptom of one of:
 *   - sources failing their polls (check career_page_sources.last_error)
 *   - a portal demoted out of AUTONOMOUS_PORTAL_FAMILIES, taking its boards with it
 *   - the deactivation sweep in pollSource wiping boards (see the empty-response guard there)
 * The fix is more sources or a restored adapter. Adding a Workable fetcher is the cheapest lever:
 * Workable is already autonomous and just has no poller (see POLLABLE_JOB_BOARDS).
 */
export const MINIMUM_SURFACED_JOBS = 1_000;

/** The floor rule as a predicate, so the number and the comparison are testable without a database. */
export function boardIsBelowFloor(surfacedJobs: number): boolean {
  return surfacedJobs < MINIMUM_SURFACED_JOBS;
}

/**
 * Whether a poll that came back empty should leave the existing postings alone.
 *
 * Extracted and exported for the same reason rankByFit is: it is the decision, and it is worth
 * pinning down without standing up a database. See the long note in pollSource for the reasoning -
 * in short, an empty board response is far more often a rotated token than a company closing every
 * role at once, and the deactivation it would otherwise trigger is what takes the board under
 * MINIMUM_SURFACED_JOBS in a single cron run.
 */
export function shouldKeepPostingsOnEmptyFetch(fetchedCount: number, activeNow: number): boolean {
  return fetchedCount === 0 && activeNow > 0;
}

/**
 * How many jobs the board would show right now, under exactly the filters GET /jobs applies.
 *
 * Deliberately re-derived from the same three predicates rather than counting monitored_jobs: a
 * count that includes rows the board filters out would report a healthy number while the board
 * itself was empty, which is the precise failure this whole check exists to catch.
 */
export async function surfacedJobCount(): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(monitored_jobs)
    .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
    .where(and(
      eq(monitored_jobs.is_active, true),
      eq(career_page_sources.enabled, true),
      inArray(career_page_sources.ats_name, [...AUTONOMOUS_PORTAL_FAMILIES]),
    ));
  return row?.total ?? 0;
}

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
 * nothing else while it runs. An earlier version of this comment called the pass "the low tens of
 * milliseconds" and the per-call cost "well under a millisecond"; both were asserted rather than
 * measured, and the numbers above replaced them (2026-07-28).
 *
 * 300 is affordable BECAUSE OF THE CACHE, and would not be without it. The ranking is now computed
 * once per (student, resume, filters) and every page is a slice of it, so this cost is paid once
 * per list rather than once per page — which is what makes a pool three times larger cheaper in
 * practice than the old 200 was. Roughly 100-400 ms on a miss, and nothing on a hit.
 *
 * The cap is still real, and is why the response carries `ranked_pool` and `pool_exhausted`: past
 * RANKING_POOL matching postings, the next-newest is not considered for ranking however well it
 * fits. Filters are how a student narrows the pool, and the list has to SAY it stopped ranking
 * rather than quietly reporting no more results.
 */
export const RANKING_POOL = 300;

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

/**
 * How many candidate rows are read before the pool is chosen from them.
 *
 * Only id and company_name are read at this stage — no descriptions — so this is a cheap two-column
 * scan even at a few thousand rows. It exists so the pool can be chosen from a wide enough slice of
 * the board for `PER_COMPANY_CAP` to actually have something to spread across.
 */
const CANDIDATE_SCAN = 3_000;

/**
 * How many postings any ONE employer may contribute to the ranking pool.
 *
 * WHY THIS EXISTS, measured against production 2026-07-28. The pool was the newest RANKING_POOL
 * postings, full stop. On the real board that is not a sample of the market, it is a sample of
 * whoever posted most recently: of 300 pooled rows, 166 were Datadog and 35 companies appeared out
 * of the 53 sources being polled. The top ten "Top matches for you" were ten Datadog jobs.
 *
 * The ranking was working perfectly and the feature was still useless, because a student looking
 * for the best-fitting job in a 7,115-posting board was being shown the best-fitting job at one
 * company. No unit test could have caught it; it only shows up against real data.
 *
 * 6 is RANKING_POOL / 50, so the pool spreads across roughly fifty employers before the cap starts
 * binding, while still letting a genuinely large employer contribute a handful of roles. A student
 * who wants more from one company can search for it, which is what the company filter is for.
 */
const PER_COMPANY_CAP = 6;

/* Two or three, Mehek's rule, and three is the generous end of it. Measured against a 24-row page:
   three of anything is noticeable, four reads as a takeover. RANKED_PAGE_WINDOW is the page size the
   dashboard actually asks for; the cap is meaningless without knowing the window it applies to. */
const PER_PAGE_COMPANY_CAP = 3;
const RANKED_PAGE_WINDOW = 24;

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
/**
 * The pool, chosen so it spans employers instead of echoing one.
 *
 * Walks the candidates in the order the query returned them (title matches first when there is a
 * search, then newest) and takes each one unless its employer has already contributed `perCompany`.
 * The result therefore keeps the incoming priority — the newest and most relevant postings still
 * come first — while no single employer can crowd out the rest of the board.
 *
 * Two deliberate properties:
 *
 *  - IT NEVER RETURNS FEWER THAN IT COULD. If capping leaves the pool short of `poolSize` (a board
 *    with only a handful of employers, or a narrow search), a second pass takes the skipped rows,
 *    still in their original order. A student searching for one company must still get that
 *    company's jobs; the cap is there to stop an employer dominating a BROWSE, not to withhold
 *    results from a search that asked for it.
 *  - ONE MORE THAN ASKED FOR, when available, so the caller can tell "the pool ends here" apart
 *    from "the board ends here" exactly as it could before.
 */
export function pickDiversePool<T extends { company_name: string }>(
  candidates: readonly T[],
  perCompany: number,
  poolSize: number,
): T[] {
  const taken: T[] = [];
  const skipped: T[] = [];
  const seen = new Map<string, number>();
  // One past poolSize: the caller reads the overflow as "there was more we did not rank".
  const want = poolSize + 1;

  for (const row of candidates) {
    if (taken.length >= want) break;
    const key = row.company_name.trim().toLowerCase();
    const count = seen.get(key) ?? 0;
    if (count >= perCompany) {
      skipped.push(row);
      continue;
    }
    seen.set(key, count + 1);
    taken.push(row);
  }

  // Backfill in original order, so a thin board still fills the page.
  for (const row of skipped) {
    if (taken.length >= want) break;
    taken.push(row);
  }
  return taken;
}

/**
 * The in-memory half of the one-employer-must-not-own-the-page rule, for the ranked list.
 *
 * The board can scatter in SQL because its order is recency. The dashboard's order is FIT, and a
 * round-robin there would be actively wrong: it would put a 40% match from a rare employer above a
 * 95% match, which is the opposite of what "Top matches for you" promises. So this keeps fit order
 * and only defers the rows that would break the cap, pulling them back in as soon as the next page
 * begins.
 *
 * Applied once, to the ranking that gets cached, so every page is a slice of one decided list —
 * exactly the property the ranking cache exists to hold. Re-sorting each page instead would let a
 * posting appear on two pages or none.
 *
 * A deferred row is never dropped. If a whole page could only be filled by breaking the cap, the
 * cap gives way rather than the page coming up short: a short page is a worse lie than a repeated
 * employer.
 */
export function scatterRanked<T extends { company_name: string }>(
  rows: readonly T[],
  perPage: number,
  pageSize: number,
): T[] {
  const pending = [...rows];
  const out: T[] = [];

  while (pending.length) {
    const windowStart = Math.floor(out.length / pageSize) * pageSize;
    const counts = new Map<string, number>();
    for (let i = windowStart; i < out.length; i += 1) {
      const key = out[i].company_name.trim().toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let index = pending.findIndex(
      (row) => (counts.get(row.company_name.trim().toLowerCase()) ?? 0) < perPage,
    );
    // Nothing left that fits the cap: take the best remaining rather than leave the page short.
    if (index === -1) index = 0;
    out.push(pending[index]);
    pending.splice(index, 1);
  }
  return out;
}

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

/* One daily run has to touch EVERY enabled source, not a rotating slice of
   them. At 20 per run a 40-source board took two days to come round, and a
   source is only marked stale when it is polled, so a posting closed on Monday
   sat on the public board until Wednesday. The Vercel function ceiling is 300s
   (vercel.json) and a board fetch is one HTTP call plus one transaction, so
   eight at a time clears ~60 sources well inside the budget. Raise the source
   count past this and the limit needs raising with it, or the tail stops
   refreshing daily and nothing says so.

   RAISED TO 400 ON 2026-07-28, when the board went from 51 sources to 239. At 60
   a run, 179 of them would have sat unpolled every night and come round once
   every four days — the exact "tail stops refreshing and nothing says so"
   failure the paragraph above warns about, reintroduced by growing the source
   list rather than by lowering this number.

   The budget is measured, not guessed: the 2026-07-28 18:19 UTC run polled 51
   sources in 22s at this concurrency, so ~0.43s per source wall-clock. 239
   sources is therefore ~103s, and 400 would be ~172s, both inside the 300s
   Vercel ceiling. 400 leaves room to roughly double the board again before this
   needs revisiting; past that, raise POLL_CONCURRENCY rather than this, since
   the cost is network wait rather than CPU. */
const POLL_SOURCES_PER_RUN = 400;
const POLL_CONCURRENCY = 8;
const UPSERT_CHUNK = 200;

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

export async function upsertSources(sources: JobSourceInput[]) {
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

export async function pollSource(source: typeof career_page_sources.$inferSelect) {
  try {
    const jobs = await fetchSourceJobs({
      ats_name: source.ats_name as SupportedJobBoard,
      board_token: source.board_token,
    });

    /* AN EMPTY RESPONSE NEVER DEACTIVATES A BOARD.
     *
     * The transaction below flips every one of this source's jobs to is_active = false and then
     * re-inserts whatever the fetch returned. With `jobs` empty that is a silent wipe of the entire
     * board: Databricks alone is ~600 postings, so two or three sources answering with an empty
     * array takes the whole list under the floor in one cron run, and every check we had would still
     * report success. That is the same shape as the failure this file already carries a comment
     * about, where career_page_sources was empty for months and an empty board looked exactly like a
     * healthy one.
     *
     * An empty array from a board API is overwhelmingly a rotated token, a changed endpoint, or a
     * transient 200-with-no-body - not every job at a company closing between two polls. So it is
     * treated as an error to investigate, and the previous postings stay up. Stale beats absent:
     * a job that closed yesterday wastes one click, an empty board wastes the whole product.
     *
     * A board that genuinely empties recovers by hand (disable the source, or let the row age out).
     * That is the correct trade - the manual step is on the rare true case, not the common false one.
     */
    if (jobs.length === 0) {
      const [existing] = await db
        .select({ active: sql<number>`count(*)::int` })
        .from(monitored_jobs)
        .where(and(eq(monitored_jobs.source_id, source.id), eq(monitored_jobs.is_active, true)));
      if (shouldKeepPostingsOnEmptyFetch(jobs.length, existing?.active ?? 0)) {
        const message = `Board returned no postings while ${existing!.active} are live; keeping them and not deactivating.`;
        await db.update(career_page_sources)
          .set({ last_polled_at: new Date(), last_error: message })
          .where(eq(career_page_sources.id, source.id));
        return { source_id: source.id, company: source.company_name, jobs: 0, ok: false as const, error: message };
      }
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.update(monitored_jobs).set({ is_active: false }).where(eq(monitored_jobs.source_id, source.id));
      /* One statement per posting meant 7,109 round trips for a full sweep and
         a 469s run, against a 300s Vercel ceiling (vercel.json) — the daily
         cron would have died halfway through the alphabet, leaving every
         un-reached source's jobs flipped to is_active = false by the sweep
         above. That failure empties the public board rather than staling it.
         Chunked so a single board the size of Databricks still fits well
         inside Postgres's 65,535-parameter cap: 14 columns x 200 rows. */
      for (let index = 0; index < jobs.length; index += UPSERT_CHUNK) {
        const chunk = jobs.slice(index, index + UPSERT_CHUNK).map((job) => ({
          source_id: source.id,
          company_name: source.company_name,
          ...job,
          last_seen_at: now,
          is_active: true,
        }));
        await tx.insert(monitored_jobs).values(chunk).onConflictDoUpdate({
          target: [monitored_jobs.source_id, monitored_jobs.external_id],
          set: {
            company_name: sql`excluded.company_name`,
            title: sql`excluded.title`,
            location: sql`excluded.location`,
            department: sql`excluded.department`,
            employment_type: sql`excluded.employment_type`,
            description: sql`excluded.description`,
            apply_url: sql`excluded.apply_url`,
            posting_url: sql`excluded.posting_url`,
            remote: sql`excluded.remote`,
            posted_at: sql`excluded.posted_at`,
            last_seen_at: sql`excluded.last_seen_at`,
            is_active: sql`excluded.is_active`,
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

/* The board's filter set, in ONE place.
 *
 * /jobs and /jobs/grouped answer the same question with different shapes, so the filters have to be
 * identical or the two disagree about what exists — and the autonomous-portal rule in particular is
 * a product guarantee, not a detail: a posting Litos cannot finish is worse on the board than
 * absent, because it looks like every other job right up until the student has tailored a resume
 * for it. Copying these four lines into the second route is how that guarantee rots on one of them.
 */
/**
 * ONE EMPLOYER MUST NOT OWN THE PAGE.
 *
 * Mehek's rule, 2026-07-28: the same company should not appear more than two or three times on a
 * page, on the signed-out board and on the dashboard's jobs list alike. A board where the first
 * screen is nine Datadog roles reads as one employer's careers page with our name on it, however
 * correct the ordering that produced it.
 *
 * This is the SQL half, for the routes whose pages are database slices. It cannot be done by
 * re-sorting a page in memory: page 2 would be sorted independently of page 1, so a posting could
 * appear on both pages or on neither, and `total` would stop describing the list. The ordering has
 * to be a property of the whole set.
 *
 * `row_number() over (partition by company)` numbers each employer's postings 1, 2, 3… Ordering by
 * that number FIRST is a round-robin: every company's newest posting comes before any company's
 * second. With ~50 companies on the board that puts at most one row per employer in any 50
 * consecutive rows, comfortably inside a 24-row page — stricter than "two or three", and the
 * strictness is the point.
 *
 * What it does NOT do, deliberately:
 * - It never outranks relevance. A title search still puts title matches first and scatters only
 *   within them, or the first page of a search reads as unrelated.
 * - It is skipped entirely when the visitor filtered BY company. Someone who typed "MongoDB" asked
 *   for MongoDB's roles and must get all 267, not one per page.
 * - Deep in the board, once the smaller employers are exhausted, the remaining pages are
 *   necessarily the big ones. That is the shape of the data, not a failure of this rule.
 */
function companyScatter(filters: { company?: string }) {
  if (filters.company) return [];
  return [
    sql`row_number() over (partition by lower(${monitored_jobs.company_name}) order by ${monitored_jobs.posted_at} desc nulls last, ${monitored_jobs.first_seen_at} desc, ${monitored_jobs.id} desc)`,
  ];
}

function boardConditions(f: {
  q?: string;
  title?: string;
  location?: string;
  company?: string;
  remote?: 'true' | 'false';
}) {
  const conditions = [
    eq(monitored_jobs.is_active, true),
    eq(career_page_sources.enabled, true),
    inArray(career_page_sources.ats_name, [...AUTONOMOUS_PORTAL_FAMILIES]),
  ];
  if (f.q) {
    conditions.push(or(ilike(monitored_jobs.title, `%${f.q}%`), ilike(monitored_jobs.description, `%${f.q}%`))!);
  }
  if (f.title) conditions.push(ilike(monitored_jobs.title, `%${f.title}%`));
  if (f.location) conditions.push(ilike(monitored_jobs.location, `%${f.location}%`));
  if (f.company) conditions.push(ilike(monitored_jobs.company_name, `%${f.company}%`));
  if (f.remote) conditions.push(eq(monitored_jobs.remote, f.remote === 'true'));
  return conditions;
}

/**
 * The row as the client receives it, with the employer's own domain attached.
 *
 * Resolved here rather than in the browser because `career_url` cannot answer it: on every source
 * polled today that field holds the JOB BOARD, so a client deriving an identity from it would paint
 * one ATS logo across every row. See lib/companyDomains.ts for how each domain was established and
 * why an unmapped company correctly gets null.
 */
function withCompanyDomain<T extends { company_name: string }>(row: T) {
  return { ...row, company_domain: companyDomainFor(row.company_name) };
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
    const { q, title, location, company, remote, limit, offset } = parsed.data;
    // Only surface jobs Litos can carry all the way to a confirmation on its own.
    //
    // Belt and braces with the compile-time constraint on SupportedJobBoard, and it earns its keep:
    // that type stops NEW sources being added, but monitored_jobs rows outlive their source. A board
    // polled before this rule existed, or one disabled rather than deleted, still has rows joined to
    // a career_page_sources row whose ats_name is whatever it was then. This is the filter that
    // keeps those out of the board and the dashboard, which both read this one route.
    const conditions = boardConditions(parsed.data);

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

    /* A search matches the title OR the body, and the body is the whole job description, so
       "product manager" matched 707 postings of which most only mention the phrase in passing
       ("you will work with our product manager"). Sorted by date alone, the top of that page was
       Senior Machine Learning Engineer — a board that looks broken to anyone who types what they
       actually want. Title hits first, then the same date order within each group. Recency alone
       stays the order when there is no search term, which is what a browse wants.
       This also decides WHICH postings enter the ranking pool below, so a search still puts title
       matches in front of the scorer rather than letting them fall off the end of the pool. */
    const relevanceThenNewest = [
      ...(q ? [sql`case when ${monitored_jobs.title} ilike ${`%${q}%`} then 0 else 1 end`] : []),
      ...(title ? [sql`case when ${monitored_jobs.title} ilike ${`%${title}%`} then 0 else 1 end`] : []),
      /* Relevance first, then one employer per turn, then recency. See companyScatter. */
      ...companyScatter(parsed.data),
      desc(monitored_jobs.posted_at),
      desc(monitored_jobs.first_seen_at),
      desc(monitored_jobs.id),
    ];

    /* The board on trylitos.com/browse-jobs prints how many jobs there are and paginates over the
       whole set, and neither is derivable from has_more: a caller reading page 1 can only say
       "more than 24". Counted under the same filters as the page, so the number always describes
       the list beneath it rather than the table. */
    const jobCount = async () => {
      const [row] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(monitored_jobs)
        .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
        .where(and(...conditions));
      return row?.total ?? 0;
    };

    if (!resumeText) {
      const rows = await db
        .select(selection)
        .from(monitored_jobs)
        .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
        .where(and(...conditions))
        .orderBy(...relevanceThenNewest)
        .limit(limit + 1)
        .offset(offset);
      return reply.send({
        jobs: rows.slice(0, limit).map((row) => ({ ...withCompanyDomain(row), match_score: null })),
        total: await jobCount(),
        limit,
        offset,
        has_more: rows.length > limit,
        ranked: false,
        ranked_pool: null,
        pool_exhausted: false,
      });
    }

    /* One ranking per (student, resume, filters), reused across their pages.
       This is what makes the pages TILE. Ranking a live pool on every request meant page 2 was cut
       from a different ordering than page 1, so a posting could appear on both or on neither; now
       the order is decided once and every page is a slice of the same list. It also means the
       scoring pass is paid once per list rather than once per page.
       See lib/rankingCache.ts for what is and is not cached, and for why a miss is always fine. */
    const cacheKey = rankingCacheKey(
      request.jwtPayload!.userId,
      resumeText,
      JSON.stringify([q ?? '', title ?? '', location ?? '', company ?? '', remote ?? '']),
    );
    let ranking = readRanking(cacheKey);

    if (!ranking) {
      /* TWO PHASES, and the cheap one comes first.
         Phase 1 reads id and company_name only, for a wide slice of the board. No descriptions, so
         a few thousand rows cost almost nothing, and it is what gives PER_COMPANY_CAP enough
         candidates to spread the pool across employers rather than echoing whoever posted last. */
      const candidates = await db
        .select({ id: monitored_jobs.id, company_name: monitored_jobs.company_name })
        .from(monitored_jobs)
        .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
        .where(and(...conditions))
        .orderBy(...relevanceThenNewest)
        .limit(CANDIDATE_SCAN);

      const chosen = pickDiversePool(candidates, PER_COMPANY_CAP, RANKING_POOL);
      const poolExhausted = chosen.length > RANKING_POOL;
      const poolIds = chosen.slice(0, RANKING_POOL).map((row) => row.id);

      /* Phase 2 reads the text to score, and ONLY for the rows that made the pool. The scored copy
         is capped at SCORING_CHARS and never reaches the payload: `description` in `selection` is
         the 600-char preview. */
      const pool = poolIds.length
        ? await db
            .select({
              id: monitored_jobs.id,
              company_name: monitored_jobs.company_name,
              title: monitored_jobs.title,
              scored_description: sql<string>`left(${monitored_jobs.description}, ${SCORING_CHARS})`,
            })
            .from(monitored_jobs)
            .where(inArray(monitored_jobs.id, poolIds))
        : [];

      /* Back into candidate order before scoring. `inArray` makes no ordering promise, and
         rankByFit breaks score ties by incoming position — so without this, two equal matches would
         be separated arbitrarily instead of by "most relevant, then newest", which is the only
         other fact we have about them. */
      const poolById = new Map(pool.map((row) => [row.id, row]));
      const orderedPool = poolIds
        .map((id) => poolById.get(id))
        .filter((row): row is (typeof pool)[number] => row !== undefined);

      const scored = rankByFit(orderedPool, resumeText);
      /* Fit order decides WHICH jobs lead; this decides that no single employer owns the screen
         while they do. pickDiversePool already spread the POOL across employers, but the pool is
         300 rows and a page is a handful — six Datadog roles could still land together at the top.
         Capped per page, not per pool. */
      const spread = scatterRanked(
        scored.map((entry) => ({ ...entry, company_name: entry.row.company_name })),
        PER_PAGE_COMPANY_CAP,
        RANKED_PAGE_WINDOW,
      );
      ranking = writeRanking(cacheKey, {
        ids: spread.map(({ row }) => row.id),
        scores: new Map(scored.map(({ row, score }) => [row.id, score])),
        poolExhausted,
      });
    }

    const pageIds = ranking.ids.slice(offset, offset + limit);
    /* Rows are read fresh every time, never served from the cache, so a posting edited or pulled
       since the ranking was computed is not resurrected by it. Only the ORDER is remembered. */
    const rows = pageIds.length
      ? await db
          .select(selection)
          .from(monitored_jobs)
          .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
          .where(and(
            eq(monitored_jobs.is_active, true),
            inArray(monitored_jobs.id, pageIds),
            /* The autonomy filter has to be repeated HERE, even though the pool that produced
               pageIds was already filtered by `conditions`. This read is by id, and the ids can come
               from readRanking() - a ranking computed before this rule existed, or before a source
               changed, still holds ids from boards Litos cannot finish. Without this line the cache
               resurrects exactly the jobs the board is meant to exclude, which is the same reasoning
               as the comment below about deactivated postings. */
            inArray(career_page_sources.ats_name, [...AUTONOMOUS_PORTAL_FAMILIES]),
          ))
      : [];

    /* Back into ranked order, and silently dropping any id that no longer resolves — a posting
       deactivated since the ranking was built is simply gone, which is the truth. */
    const byId = new Map(rows.map((row) => [row.id, row]));
    const jobs = pageIds
      .map((id) => byId.get(id))
      .filter((row): row is (typeof rows)[number] => row !== undefined)
      .map((row) => ({ ...withCompanyDomain(row), match_score: ranking!.scores.get(row.id) ?? null }));

    return reply.send({
      jobs,
      total: await jobCount(),
      limit,
      offset,
      has_more: ranking.ids.length > offset + limit,
      ranked: true,
      ranked_pool: ranking.ids.length,
      /* True when postings exist that were never ranked. Without this the client cannot tell the
         end of the ranking from the end of the board, and `has_more: false` at the pool boundary
         reads as "you have seen everything" when the truth is "we stopped ranking here". */
      pool_exhausted: ranking.poolExhausted,
    });
  });

  /* The same role at the same company, in one row, carrying all of its locations.
   *
   * Companies routinely post one job once per city: Lyft's "Account Manager, Strategic Healthcare
   * Partnerships" is a separate posting for San Francisco and for New York, and the board showed
   * them as two tiles that were identical apart from a line of grey text. That is the same job
   * twice as far as the reader is concerned.
   *
   * Grouped in SQL rather than in the page, because the page is paginated: merging client-side
   * would only ever merge the copies that happened to land on the same page, `total` would still
   * count the un-merged rows, and pages would hold inconsistent numbers of tiles. Grouping here
   * keeps the count, the pagination and the tiles describing the same set.
   *
   * The grouping key is (company, title) EXACTLY — Mehek's rule, 2026-07-28. No fuzzy matching, no
   * normalisation beyond what the employer typed: "Software Engineer II" and "Software Engineer"
   * are different jobs, and a merge that guesses otherwise hides a real posting behind another
   * one's apply link.
   *
   * Deliberately its own route rather than a flag on /jobs: that route now carries resume-based
   * ranking, a ranking cache and a pool, all of which are per-posting concepts. Threading a
   * grouped shape through them would put the board's needs inside the dashboard's hot path.
   */
  fastify.get('/jobs/grouped', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid job filters' });
    const { title, limit, offset } = parsed.data;
    const where = and(...boardConditions(parsed.data));

    /* One row per (company, title). The aggregates are chosen so the row still describes something
       true of the whole group: the newest timestamps, every distinct location, and the apply link
       belonging to the newest posting in the group rather than an arbitrary member. */
    const rows = await db
      .select({
        id: sql<string>`(array_agg(${monitored_jobs.id} order by ${monitored_jobs.posted_at} desc nulls last, ${monitored_jobs.id} desc))[1]`,
        company_name: monitored_jobs.company_name,
        title: monitored_jobs.title,
        locations: sql<string[]>`array_remove(array_agg(distinct ${monitored_jobs.location}), null)`,
        openings: sql<number>`count(*)::int`,
        apply_url: sql<string>`(array_agg(${monitored_jobs.apply_url} order by ${monitored_jobs.posted_at} desc nulls last, ${monitored_jobs.id} desc))[1]`,
        remote: sql<boolean>`bool_or(${monitored_jobs.remote})`,
        posted_at: sql<string | null>`max(${monitored_jobs.posted_at})`,
        first_seen_at: sql<string>`min(${monitored_jobs.first_seen_at})`,
        ats_name: career_page_sources.ats_name,
        career_url: sql<string>`min(${career_page_sources.career_url})`,
      })
      .from(monitored_jobs)
      .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
      .where(where)
      .groupBy(monitored_jobs.company_name, monitored_jobs.title, career_page_sources.ats_name)
      .orderBy(
        /* Same relevance-then-recency rule as /jobs: a title hit outranks a body-only hit, or the
           first page of a search reads as unrelated. */
        ...(title ? [sql`case when min(${monitored_jobs.title}) ilike ${`%${title}%`} then 0 else 1 end`] : []),
        /* Scatter across employers, same rule as /jobs but over the grouped rows: the window runs
           on the aggregate, so it numbers each company's ROLES rather than its postings, which is
           what a reader of this board counts. */
        ...(parsed.data.company
          ? []
          : [sql`row_number() over (partition by lower(${monitored_jobs.company_name}) order by max(${monitored_jobs.posted_at}) desc nulls last, min(${monitored_jobs.first_seen_at}) desc)`]),
        sql`max(${monitored_jobs.posted_at}) desc nulls last`,
        sql`min(${monitored_jobs.first_seen_at}) desc`,
      )
      .limit(limit + 1)
      .offset(offset);

    /* count of GROUPS, not of postings. Counting rows here would print a number the page cannot
       show, which is the same lie as the competitor's 644,546. */
    const counted = await db.execute<{ total: number }>(sql`
      select count(*)::int as total from (
        select 1 from ${monitored_jobs}
        inner join ${career_page_sources} on ${monitored_jobs.source_id} = ${career_page_sources.id}
        where ${where}
        group by ${monitored_jobs.company_name}, ${monitored_jobs.title}, ${career_page_sources.ats_name}
      ) groups
    `);

    const countRow = counted.rows[0];

    return reply.send({
      jobs: rows.slice(0, limit),
      total: Number(countRow?.total ?? 0),
      limit,
      offset,
      has_more: rows.length > limit,
    });
  });

  /* Suggestions for the board's three search fields.
   *
   * The fields accept free text too, so this is a convenience rather than a controlled vocabulary:
   * it exists so a job seeker who does not already know that we watch "Qube Research &
   * Technologies" can find it, and so the city field offers real cities rather than making them
   * guess our formatting. Cities and titles are the most common ones, because the full lists are
   * thousands long and nobody scrolls a datalist that size.
   */
  fastify.get('/jobs/facets', async (_request: FastifyRequest, reply: FastifyReply) => {
    const where = and(...boardConditions({}));
    const base = db
      .select({ v: monitored_jobs.company_name, n: sql<number>`count(*)::int` })
      .from(monitored_jobs)
      .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
      .where(where);

    const [companies, locations, titles] = await Promise.all([
      base.groupBy(monitored_jobs.company_name).orderBy(sql`1 asc`),
      db
        .select({ v: monitored_jobs.location, n: sql<number>`count(*)::int` })
        .from(monitored_jobs)
        .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
        .where(where)
        .groupBy(monitored_jobs.location)
        .orderBy(sql`count(*) desc`)
        .limit(120),
      db
        .select({ v: monitored_jobs.title, n: sql<number>`count(*)::int` })
        .from(monitored_jobs)
        .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
        .where(where)
        .groupBy(monitored_jobs.title)
        .orderBy(sql`count(*) desc`)
        .limit(120),
    ]);

    return reply.send({
      companies: companies.map((r) => r.v).filter(Boolean),
      locations: locations.map((r) => r.v).filter(Boolean),
      titles: titles.map((r) => r.v).filter(Boolean),
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
        // Same rule as the list route. Without it a job filtered off the board is still reachable by
        // id - from a bookmark, a shared link, or a dashboard row cached before the filter landed -
        // and the detail page is exactly where a student commits to applying.
        inArray(career_page_sources.ats_name, [...AUTONOMOUS_PORTAL_FAMILIES]),
      ))
      .limit(1);
    if (!rows[0]) return reply.status(404).send({ error: 'Job not found' });
    return reply.send({ job: withCompanyDomain(rows[0]) });
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
      .limit(POLL_SOURCES_PER_RUN);
    const results = [];
    for (let index = 0; index < sources.length; index += POLL_CONCURRENCY) {
      results.push(...await Promise.all(sources.slice(index, index + POLL_CONCURRENCY).map(pollSource)));
    }
    /* THE FLOOR CHECK. See MINIMUM_SURFACED_JOBS.
     *
     * Reported on every run, not only on a breach, so the number is watchable while it is still
     * healthy rather than only once it is already a problem. A board does not usually collapse in
     * one step; it erodes as tokens rotate and boards go quiet, and a figure in every cron response
     * is what makes that erosion visible before it crosses the line.
     *
     * A breach answers 5xx ON PURPOSE. This route is the daily Vercel cron, and a cron that returns
     * 200 is a cron nobody looks at - which is exactly how career_page_sources sat empty for months
     * while every check reported success. Failing the run is the only signal that reaches anyone.
     * The poll itself still committed; this reports the state, it does not roll anything back.
     */
    const surfaced = await surfacedJobCount();
    const payload = {
      sources: results.length,
      jobs: results.reduce((sum, result) => sum + result.jobs, 0),
      failed: results.filter((result) => !result.ok).length,
      surfaced_jobs: surfaced,
      minimum_surfaced_jobs: MINIMUM_SURFACED_JOBS,
      results,
    };
    if (boardIsBelowFloor(surfaced)) {
      request.log.error(
        { surfaced, floor: MINIMUM_SURFACED_JOBS, failedSources: payload.failed },
        'Job board is below its minimum surfaced-jobs floor',
      );
      return reply.status(500).send({
        ...payload,
        error: `The job board is showing ${surfaced} jobs, below the floor of ${MINIMUM_SURFACED_JOBS}. `
          + 'Check career_page_sources.last_error for failing polls, and whether a portal left '
          + 'AUTONOMOUS_PORTAL_FAMILIES. Do not lower the floor to clear this.',
      });
    }
    return reply.send(payload);
  });
}
