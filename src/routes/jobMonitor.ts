import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, ilike, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index';
import { career_page_sources, monitored_jobs, profiles, sponsor_employers, users } from '../db/schema';
import { normalizeEmployerName, readPostingSponsorship, sponsorOnlyBoardRequired, sponsorshipVerdict, type PostingSponsorship } from '../lib/sponsorship';
import { resolveJobCountry } from '../lib/jobLocation';
import { portalNameAgrees } from '../lib/sponsorIdentity';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import { fetchSourceJobs, isIngestablePosting, POLLABLE_JOB_BOARDS, type JobSourceInput, type SupportedJobBoard } from '../lib/jobMonitor';
import { AUTONOMOUS_PORTAL_FAMILIES } from '../lib/portalSubmission';
import { rankCities } from '../lib/cities';
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
  /* Show only postings where visa sponsorship is confirmed. A filter anyone may ask for - the
     public board at /browse-jobs offers it as a checkbox - and one that some accounts get whether
     they ask or not. On GET /jobs the account's own answer is OR-ed with this, never overridden by
     it: somebody who said at onboarding that they need sponsorship cannot turn the filter off by
     omitting a query parameter. See sponsorOnlyBoardRequired in lib/sponsorship.ts. */
  sponsor_only: z.enum(['true', 'false']).optional(),
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

/**
 * REQUIRED HEADROOM OVER THE FLOOR.
 *
 * 1,000 is the point at which the board is broken. This is the point at which someone has to look at
 * it. Alarming only at the floor means the first warning arrives when the product is already
 * unusable, so the cron treats 5x as the line and the floor as the emergency below it.
 */
export const REQUIRED_HEADROOM_MULTIPLE = 5;
export const REQUIRED_SURFACED_JOBS = MINIMUM_SURFACED_JOBS * REQUIRED_HEADROOM_MULTIPLE;

/**
 * ONLY POSTINGS FROM THE LAST SEVEN DAYS ARE SHOWN.
 *
 * SEVEN IS STRUCTURAL, NOT A ROUND NUMBER. Hiring is weekday work: measured on this board on
 * 2026-07-28, weekdays carry 700-3,500 postings a day while **Saturday carries 143 and Sunday 22**.
 * A window shorter than a week therefore changes size depending on which days it happens to cover -
 * a rolling 3-day window measured 3,917 on a Tuesday and would hold roughly 2,000 on a Monday, when
 * it spans Sat+Sun+Mon. Any 7-day window contains exactly one Saturday and one Sunday, so the
 * weekend dip is fully absorbed and the count stops swinging with the day of the week.
 *
 * Measured windows the day this shipped: 3d = 3,917 · 4d = 6,927 · 5d = 7,815 · **7d = 9,664**.
 * Only 7d clears REQUIRED_SURFACED_JOBS on every weekday, and it does so with ~1.9x margin.
 *
 * WHAT WOULD MAKE THIS UNSUSTAINABLE, and what the cron watches for: weekly posting volume falling
 * (a hiring slowdown, or the December lull), or sources decaying as board tokens rotate. Either
 * shows up as `surfaced_jobs` trending toward REQUIRED_SURFACED_JOBS in the daily cron response,
 * which is why that number is reported on every run and not only when it breaks.
 *
 * If it does trend down, WIDEN THIS BEFORE LOWERING THE FLOOR. A 14-day window measured 12,516, so
 * there is a lot of room in the window itself before the floor is the thing that has to give.
 *
 * Greenhouse note: `posted_at` is Greenhouse's `updated_at` (it publishes no create date), so for
 * 77% of the board this is "changed in the last 7 days" rather than "posted". That is a deliberate
 * call, and it is why the board card says UPDATED for Greenhouse rows and POSTED for Lever/Ashby.
 * Do not collapse those two words - claiming a publish date we do not have is the one thing the
 * board's copy tests exist to prevent.
 */
export const JOB_FRESHNESS_DAYS = 7;

function freshnessPredicate() {
  return sql`${monitored_jobs.posted_at} >= now() - (${JOB_FRESHNESS_DAYS} || ' days')::interval`;
}

/**
 * How long a posting that has left its board is kept before the row is deleted.
 *
 * A posting is REMOVED FROM THE PRODUCT the moment `is_active` goes false - that is what the poll's
 * sweep does, and every board query filters on it, so nothing here affects what a visitor sees. This
 * constant is only about how long the dead row survives in the table.
 *
 * Two days rather than zero, deliberately. `last_seen_at` on a closed row is the only record of when
 * a posting disappeared, and deleting on the same run destroys the evidence for the one question
 * worth asking after a bad poll: did these vanish because the employer closed them, or because a
 * token rotated and a whole board went quiet? Two days is long enough to answer that and short
 * enough that the dead rows never accumulate.
 */
export const CLOSED_POSTING_RETENTION_DAYS = 2;

/**
 * How old a posting must be before its row is deleted outright.
 *
 * A FULL WINDOW OF SLACK past the window itself, and the slack is the whole point: purging at the
 * 7-day boundary would delete rows the very next poll re-inserts, forever, for any posting sitting
 * near the edge. Exported so the relationship to JOB_FRESHNESS_DAYS is pinned by a test rather than
 * recomputed in one.
 */
export const PURGE_POSTINGS_OLDER_THAN_DAYS = JOB_FRESHNESS_DAYS * 2;

/**
 * Delete rows that can never be shown again: closed postings past their retention, and anything that
 * aged out of the window before the ingest filter existed.
 *
 * This is the "old listings get pushed off" half of the rolling window. The ingest filter in
 * pollSource stops new stale rows being written; this clears what is already there, including the
 * 12,117 rows that were active-but-invisible before the window was enforced at write time.
 *
 * Runs AFTER the poll, never before: the poll is what marks closed postings inactive in the first
 * place, so purging first would delete a day late and always leave one run's worth behind.
 *
 * Returns the count so the cron can report it, because a purge that silently deletes the wrong thing
 * looks exactly like a purge that works.
 */
export async function purgeExpiredPostings(): Promise<number> {
  const result = await db.delete(monitored_jobs).where(or(
    // Left its board, and the grace period for diagnosing why has passed.
    and(
      eq(monitored_jobs.is_active, false),
      sql`${monitored_jobs.last_seen_at} < now() - (${CLOSED_POSTING_RETENTION_DAYS} || ' days')::interval`,
    ),
    /* Outside the window with a full window of slack. The slack matters: deleting exactly at the
       boundary would fight the poller over any posting sitting near it, deleting a row the next run
       re-inserts, forever. A posting still listed by its employer is re-added by the very next poll
       anyway, so this only ever removes rows nothing is refreshing. */
    sql`${monitored_jobs.posted_at} < now() - (${PURGE_POSTINGS_OLDER_THAN_DAYS} || ' days')::interval`,
  ));
  const purged = (result as { rowCount?: number }).rowCount ?? 0;

  /* Reclaim after deleting, or the rolling window costs more space than it saves.
   *
   * A DELETE leaves dead tuples; it does not free anything. Measured on the first real purge run:
   * 8,702 rows deleted and the database went UP, 158 MB -> 194 MB, because the churn is now daily
   * and outpaces autovacuum's own schedule. A VACUUM FULL afterwards took it to 73 MB.
   *
   * Plain VACUUM here, NOT VACUUM FULL. Full takes an ACCESS EXCLUSIVE lock and rewrites the table,
   * which would make the board unavailable in the middle of a cron run; plain VACUUM takes no such
   * lock and returns the space for reuse by the next day's inserts, which is exactly what a bounded,
   * high-churn table needs. Space is not returned to the OS - run VACUUM FULL by hand if the file
   * size itself ever matters - but the table stops growing, which is the actual requirement.
   *
   * Best-effort: a failed vacuum must never fail the poll. The postings are already correct at this
   * point; this is housekeeping. */
  try {
    await db.execute(sql`vacuum ${monitored_jobs}`);
  } catch {
    // Intentionally swallowed. See above: the board is correct with or without this.
  }

  return purged;
}

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
export async function surfacedJobCount(sponsorOnly = false): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(monitored_jobs)
    .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
    // boardConditions(), not a hand-copied predicate list. This number is only meaningful if it
    // counts exactly what GET /jobs returns, and the freshness window is precisely the kind of
    // filter that gets added to the route and forgotten here: the count would have read ~22,000
    // while the board showed ~9,700, and the floor check would have been watching a number no
    // visitor ever sees.
    .where(and(...boardConditions({ sponsorOnly })));
  return row?.total ?? 0;
}

/**
 * Whether the board still has the headroom the product needs, and if not, how it is failing.
 *
 * Two levels rather than one, because they mean different things. 'low' is "someone should look at
 * the sources this week"; 'breached' is "the board is not a browsable product right now". Alarming
 * only at the floor would mean the first warning arrives when it is already unusable.
 */
export function boardHealth(surfacedJobs: number): 'ok' | 'low' | 'breached' {
  if (boardIsBelowFloor(surfacedJobs)) return 'breached';
  if (surfacedJobs < REQUIRED_SURFACED_JOBS) return 'low';
  return 'ok';
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
/**
 * Does this account's board only show employers who sponsor?
 *
 * Signed out, the answer is always no - there is no account to have declared anything - and the
 * caller falls back to the query parameter, which is how the public board's checkbox works.
 *
 * The read is two columns and it happens on every /jobs request. That is deliberate rather than
 * cached: this is the one filter where serving a stale `false` puts someone in front of jobs they
 * cannot take, and the row is already the cheapest kind of lookup this route makes.
 */
async function accountRequiresSponsor(userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  const [row] = await db
    .select({
      declared: users.sponsorship_required_at_onboarding,
      setting: users.sponsor_only_jobs_enabled,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return false;
  return sponsorOnlyBoardRequired({ declaredAtOnboarding: row.declared, settingEnabled: row.setting });
}

/** Which evidence, if any, lets this row be shown to someone who needs sponsorship. */
function evidenceFor(row: { sponsorship_status: string | null; employer_sponsors: boolean | null }) {
  return sponsorshipVerdict({
    posting: (row.sponsorship_status ?? 'unstated') as PostingSponsorship,
    employerFilesH1b: row.employer_sponsors === true,
  }).evidence;
}

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

/**
 * The sponsor_employers row for a company name, or null when nothing confirms it.
 *
 * Resolved on every upsert rather than only by the seed script, and that is a correctness fix
 * rather than tidiness: without it a source added after the last seed run stays NULL forever, which
 * means invisible to everyone who needs sponsorship, and a source whose company_name is CORRECTED
 * keeps the previous company's H-1B link - a posting surfaced on another company's filing record.
 */
async function sponsorEmployerIdFor(companyName: string): Promise<string | null> {
  const [row] = await db
    .select({ id: sponsor_employers.id })
    .from(sponsor_employers)
    .where(eq(sponsor_employers.normalized_name, normalizeEmployerName(companyName)))
    .limit(1);
  return row?.id ?? null;
}

export async function upsertSources(sources: JobSourceInput[]) {
  for (const source of sources) {
    const sponsorEmployerId = await sponsorEmployerIdFor(source.company_name);
    const rows = await db.insert(career_page_sources).values({ ...source, sponsor_employer_id: sponsorEmployerId }).onConflictDoUpdate({
      target: [career_page_sources.ats_name, career_page_sources.board_token],
      set: {
        company_name: source.company_name,
        career_url: source.career_url,
        enabled: source.enabled ?? true,
        // Recomputed, including back to NULL. A link that outlived its company name is the one
        // failure here that surfaces jobs on the wrong employer's filing record.
        sponsor_employer_id: sponsorEmployerId,
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

    /* THE WINDOW IS ENFORCED AT INGEST, not only at read time.
     *
     * Filtering only in boardConditions() meant the table stored every posting a board had ever
     * carried and then hid most of them on every single read: 22,125 rows active, 10,008 shown,
     * 12,117 stored and re-upserted daily purely to be filtered out again. That is storage and write
     * amplification for rows no visitor can reach, on a 512 MB database.
     *
     * Dropping them here is self-healing rather than lossy. If a board later re-dates a posting into
     * the window - which Greenhouse does routinely, since its date is `updated_at` - the next poll
     * simply sees it as fresh and inserts it. Nothing needs to remember what was skipped.
     *
     * NOTE the guard above keys off `jobs.length`, the RAW fetch, and must keep doing so. If it read
     * this filtered count instead, a board whose postings are all older than the window would look
     * identical to a board that returned nothing, and the run would refuse to deactivate postings
     * that genuinely aged out. "The API returned nothing" and "the API returned nothing FRESH" are
     * different facts and only the first one is a fault. */
    const cutoff = new Date(Date.now() - JOB_FRESHNESS_DAYS * 86_400_000);
    const fresh = jobs
      .filter((job) => job.posted_at instanceof Date && job.posted_at >= cutoff)
      /* Same reasoning as the window, and deliberately on the same side of the guard. Two things
         never reach the table: a posting whose description is a placeholder or the title repeated
         (nothing a student can evaluate or the matcher can score), and a posting that declares
         itself a test or a fake (BCG ships four, two of them with a full and convincing role
         description bolted onto the disclaimer). This is the daily cron's path, so both are
         enforced at ingest every morning rather than hidden at read time.
         It must run HERE and not inside the normalizers: Disney's board is two postings and both
         are placeholders, so filtering upstream would make that board indistinguishable from one
         that answered with nothing, and the guard above would then pin the junk in place. */
      .filter(isIngestablePosting);

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.update(monitored_jobs).set({ is_active: false }).where(eq(monitored_jobs.source_id, source.id));
      /* One statement per posting meant 7,109 round trips for a full sweep and
         a 469s run, against a 300s Vercel ceiling (vercel.json) — the daily
         cron would have died halfway through the alphabet, leaving every
         un-reached source's jobs flipped to is_active = false by the sweep
         above. That failure empties the public board rather than staling it.
         Chunked so a single board the size of Databricks still fits well
         inside Postgres's 65,535-parameter cap: 20 columns x 200 rows. */
      for (let index = 0; index < fresh.length; index += UPSERT_CHUNK) {
        const chunk = fresh.slice(index, index + UPSERT_CHUNK).map(({ pay, ...job }) => ({
          source_id: source.id,
          company_name: source.company_name,
          ...job,
          /* Destructured OUT of the spread above, never spread in. `pay` is a nested object on
             NormalizedJob and there is no such column; drizzle would carry it into the INSERT and
             fail the whole 200-row chunk, which takes that board's poll down with it.
             All four move together - a posting whose pay period could not be established stores
             null in all of them rather than a figure with no period. See lib/compensation.ts. */
          salary_min: pay?.min ?? null,
          salary_max: pay?.max ?? null,
          salary_currency: pay?.currency ?? null,
          salary_interval: pay?.interval ?? null,
          last_seen_at: now,
          is_active: true,
          /* Read here, at the moment the description arrives, so the board filter is a plain column
             comparison. Recomputed on every poll rather than kept from the first sighting: employers
             edit this sentence into and out of a live posting, and a policy that changed on their
             page while ours still said the old thing is the one error this feature cannot afford. */
          sponsorship_status: readPostingSponsorship(job.description),
          /* The portal's own country field first, the location string only when it published none.
             Reading the string first is what made "IN - Bengaluru" Indiana and "Amsterdam, NH" New
             Hampshire. */
          job_country: resolveJobCountry(job.portal_country, job.location),
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
            sponsorship_status: sql`excluded.sponsorship_status`,
            job_country: sql`excluded.job_country`,
            /* Overwritten on every poll, not merged. An employer that REMOVES a published range
               (or edits one into a shape we decline to guess a period for) must see it disappear
               from the board on the next run; a COALESCE here would pin the old figure to the row
               forever, which is the one error a salary display cannot afford. */
            salary_min: sql`excluded.salary_min`,
            salary_max: sql`excluded.salary_max`,
            salary_currency: sql`excluded.salary_currency`,
            salary_interval: sql`excluded.salary_interval`,
          },
        });
      }
    });
    await db.update(career_page_sources).set({ last_polled_at: now, last_error: null }).where(eq(career_page_sources.id, source.id));
    return { source_id: source.id, company: source.company_name, jobs: fresh.length, fetched: jobs.length, ok: true as const };
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
 * THE SPONSOR-ONLY BOARD, as one SQL predicate, written ONCE.
 *
 * It is the rule in lib/sponsorship.ts (sponsorshipVerdict) expressed for the query planner: the
 * posting says it sponsors, OR the employer has an H-1B filing record and this posting does not
 * refuse.
 *
 * It is a function rather than three inline copies because it is needed in three places that are
 * hundreds of lines apart - the list's WHERE clause, the ranked page's re-read by id, and the
 * detail route - and a change to the rule that reached two of them would show a different board on
 * the list, the ranked page and the posting somebody actually opens, with every test still green.
 *
 * It has to be in the WHERE clause rather than a filter over rows a page returned. Filtering after
 * the fact would leave `total` counting postings the list does not contain, pages holding different
 * numbers of tiles, and the ranking pool spending its 300 slots on postings dropped on the way out,
 * which is the same page-tiling bug the ranking cache exists to prevent.
 */
export function sponsorOnlyPredicate() {
  return or(
    /* The posting's own words, wherever the role is. An employer writing "visa sponsorship
       available" on a Berlin role is talking about Germany, and it is their statement to make. */
    eq(monitored_jobs.sponsorship_status, 'offers'),
    and(
      isNotNull(career_page_sources.sponsor_employer_id),
      /* Belt and braces with the unlink in pollSource: a source whose portal name disagrees with
         ours is one we cannot identify, so nothing on it may be called a confirmed sponsor - even
         if a link survived from before the mismatch was noticed. */
      eq(career_page_sources.portal_name_mismatch, false),
      ne(monitored_jobs.sponsorship_status, 'refuses'),
      /* AND THE ROLE HAS TO BE ONE AN H-1B COULD COVER. The employer-level evidence is a US
         petition record; applying it to a Bengaluru or Tokyo posting claims something about a
         visa regime this product knows nothing about. 'unknown' (a bare "Remote") stays in: at a
         company whose entire filing history is American, that is not evidence of a foreign role,
         and hiding it would cost real US openings to avoid a hypothetical. */
      ne(monitored_jobs.job_country, 'non_us'),
    ),
  )!;
}

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
  sponsorOnly?: boolean;
}) {
  const conditions = [
    eq(monitored_jobs.is_active, true),
    eq(career_page_sources.enabled, true),
    inArray(career_page_sources.ats_name, [...AUTONOMOUS_PORTAL_FAMILIES]),
    freshnessPredicate(),
  ];
  if (f.sponsorOnly) conditions.push(sponsorOnlyPredicate());
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
    /* OR, never override. The account's standing answer can only ever ADD the filter, so a request
       that omits the parameter (or sends sponsor_only=false) cannot unfilter the board of someone
       who declared at onboarding that they need sponsorship. */
    const sponsorOnly = (await accountRequiresSponsor(request.jwtPayload?.userId))
      || parsed.data.sponsor_only === 'true';
    // Only surface jobs Litos can carry all the way to a confirmation on its own.
    //
    // Belt and braces with the compile-time constraint on SupportedJobBoard, and it earns its keep:
    // that type stops NEW sources being added, but monitored_jobs rows outlive their source. A board
    // polled before this rule existed, or one disabled rather than deleted, still has rows joined to
    // a career_page_sources row whose ats_name is whatever it was then. This is the filter that
    // keeps those out of the board and the dashboard, which both read this one route.
    const conditions = boardConditions({ ...parsed.data, sponsorOnly });

    const resumeText = await baseResumeText(request.jwtPayload?.userId);

    const selection = {
      id: monitored_jobs.id,
      company_name: monitored_jobs.company_name,
      title: monitored_jobs.title,
      location: monitored_jobs.location,
      department: monitored_jobs.department,
      employment_type: monitored_jobs.employment_type,
      /* Sent as four raw facts, not as a formatted string. The board and the dashboard render pay
         differently (a tile has room for "$145K-200K/yr", a dashboard row shows the full figures),
         and a currency the server has already turned into a symbol cannot be re-rendered for a
         reader's locale. formatPay on the client is the single place that decides how it reads. */
      salary_min: monitored_jobs.salary_min,
      salary_max: monitored_jobs.salary_max,
      salary_currency: monitored_jobs.salary_currency,
      salary_interval: monitored_jobs.salary_interval,
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
      /* The two facts behind the sponsorship badge, sent as facts rather than as a verdict. The row
         says what the posting stated and whether the employer has a filing record; evidenceFor()
         turns that into one word, using the same function the filter does. Sending a pre-baked
         "sponsors: true" would let a badge outlive a change to the rule that drew it. */
      sponsorship_status: monitored_jobs.sponsorship_status,
      employer_sponsors: sql<boolean>`${career_page_sources.sponsor_employer_id} is not null`,
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
        jobs: rows.slice(0, limit).map((row) => ({
          ...withCompanyDomain(row),
          match_score: null,
          sponsorship_evidence: evidenceFor(row),
        })),
        total: await jobCount(),
        limit,
        offset,
        has_more: rows.length > limit,
        ranked: false,
        ranked_pool: null,
        pool_exhausted: false,
        sponsor_only: sponsorOnly,
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
      /* sponsorOnly is PART OF THE KEY. Without it, one account's two states - before and after the
         filter turns on - share a cached ordering, and the id list computed on the whole board is
         then replayed against the filtered one. Every id it holds still resolves, so the page comes
         back full of exactly the postings the filter exists to hide. */
      JSON.stringify([q ?? '', title ?? '', location ?? '', company ?? '', remote ?? '', sponsorOnly]),
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
            /* And the sponsorship filter, repeated for exactly the same reason, with a sharper
               edge: the cache key includes sponsorOnly so a filtered read cannot reuse an
               unfiltered ordering, but ids also outlive the FACTS behind them. A posting that said
               nothing about sponsorship when it was ranked can be re-polled with a refusal in it,
               and an employer's confirmation can be withdrawn when the ingest is refreshed. This
               read is the last gate before the row reaches someone who cannot take the job. */
            ...(sponsorOnly ? [sponsorOnlyPredicate()] : []),
          ))
      : [];

    /* Back into ranked order, and silently dropping any id that no longer resolves — a posting
       deactivated since the ranking was built is simply gone, which is the truth. */
    const byId = new Map(rows.map((row) => [row.id, row]));
    const jobs = pageIds
      .map((id) => byId.get(id))
      .filter((row): row is (typeof rows)[number] => row !== undefined)
      .map((row) => ({
        ...withCompanyDomain(row),
        match_score: ranking!.scores.get(row.id) ?? null,
        sponsorship_evidence: evidenceFor(row),
      }));

    return reply.send({
      jobs,
      total: await jobCount(),
      limit,
      offset,
      has_more: ranking.ids.length > offset + limit,
      ranked: true,
      ranked_pool: ranking.ids.length,
      sponsor_only: sponsorOnly,
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
  fastify.get('/jobs/grouped', { preHandler: optionalAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid job filters' });
    const { title, limit, offset } = parsed.data;
    /* The account's answer counts HERE TOO, and leaving it out was a real hole: this route returns
       company, title, locations and an apply link, so it is a complete substitute for the list it
       mirrors, and a declared account calling it would have been handed the unfiltered board.
       Most callers are anonymous - it serves the public board at /browse-jobs, which is
       server-rendered with no session - and for them the page's checkbox is the whole answer. */
    const sponsorOnly = (await accountRequiresSponsor(request.jwtPayload?.userId))
      || parsed.data.sponsor_only === 'true';
    const where = and(...boardConditions({ ...parsed.data, sponsorOnly }));

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
        /* Pay and job type, aggregated with the same caution as sponsorship below: a group is one
           role open in several cities, and those copies routinely disagree.
           A range is shown only when every member that published one used the SAME currency and the
           SAME period - a role paying USD in Austin and CAD in Toronto has no single range, and
           spanning them would invent one. Where they do agree, the span runs lowest min to highest
           max, so the row is true of every posting inside it.
           count(distinct) ignores nulls, so members that published nothing neither block the range
           nor get counted into it: the row reports what was stated, by the postings that stated it.
           Job type is the same test with no arithmetic - one distinct value or nothing, so a group
           mixing an internship with a full-time posting of the same title shows no chip rather than
           picking whichever the aggregate happened to reach first. */
        salary_min: sql<number | null>`case when count(distinct ${monitored_jobs.salary_currency}) = 1 and count(distinct ${monitored_jobs.salary_interval}) = 1 then min(${monitored_jobs.salary_min}) end`,
        salary_max: sql<number | null>`case when count(distinct ${monitored_jobs.salary_currency}) = 1 and count(distinct ${monitored_jobs.salary_interval}) = 1 then max(${monitored_jobs.salary_max}) end`,
        salary_currency: sql<string | null>`case when count(distinct ${monitored_jobs.salary_currency}) = 1 and count(distinct ${monitored_jobs.salary_interval}) = 1 then min(${monitored_jobs.salary_currency}) end`,
        salary_interval: sql<string | null>`case when count(distinct ${monitored_jobs.salary_currency}) = 1 and count(distinct ${monitored_jobs.salary_interval}) = 1 then min(${monitored_jobs.salary_interval}) end`,
        employment_type: sql<string | null>`case when count(distinct ${monitored_jobs.employment_type}) = 1 then min(${monitored_jobs.employment_type}) end`,
        /* Sponsorship, aggregated the careful way round. A group is one role posted in several
           cities, and those copies can disagree - the same title is routinely open in a country the
           company sponsors in and one it does not. `refuses_any` is what stops the tile claiming
           sponsorship on behalf of a copy that refuses it: one refusal anywhere in the group and
           the tile says nothing at all, which is true of every member. */
        offers_any: sql<boolean>`bool_or(${monitored_jobs.sponsorship_status} = 'offers')`,
        refuses_any: sql<boolean>`bool_or(${monitored_jobs.sponsorship_status} = 'refuses')`,
        employer_sponsors: sql<boolean>`bool_or(${career_page_sources.sponsor_employer_id} is not null)`,
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
      jobs: rows.slice(0, limit).map(({ offers_any, refuses_any, employer_sponsors, ...row }) => ({
        ...row,
        sponsorship_evidence: refuses_any
          ? null
          : evidenceFor({
            sponsorship_status: offers_any ? 'offers' : 'unstated',
            employer_sponsors,
          }),
      })),
      total: Number(countRow?.total ?? 0),
      limit,
      offset,
      has_more: rows.length > limit,
      sponsor_only: sponsorOnly,
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
  fastify.get('/jobs/facets', { preHandler: optionalAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    /* The suggestions have to describe the board the visitor is actually looking at. Offering
       "GitLab" to someone browsing with the sponsorship filter on sends them to a search that
       returns nothing, and reads as a broken board rather than as a company we cannot confirm.
       The account's standing answer counts here too, for the same reason it counts on the list.
       Parsed on its OWN rather than off listQuerySchema: this route reads no other filter, so
       validating the whole query object meant an unrelated bad parameter (limit=500) failed the
       parse and silently served unfiltered suggestions - the filter dropping out because of a
       mistake in a field this route does not even look at. */
    const sponsorOnly = (await accountRequiresSponsor(request.jwtPayload?.userId))
      || z.object({ sponsor_only: z.enum(['true', 'false']).optional() })
        .safeParse(request.query).data?.sponsor_only === 'true';
    const where = and(...boardConditions({ sponsorOnly }));
    /* FIFTY of each, ranked by how much of the board they actually account for
       (Mehek, 2026-07-29). The lists used to be 202 companies alphabetically
       and 120 raw location strings: a dropdown nobody scrolls, opening on "AQR"
       rather than on the employers most of the board belongs to. */
    const TOP = 50;

    const companies = await db
      .select({ v: monitored_jobs.company_name, n: sql<number>`count(*)::int` })
      .from(monitored_jobs)
      .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
      .where(where)
      .groupBy(monitored_jobs.company_name)
      .orderBy(sql`count(*) desc`)
      .limit(TOP);

    /* Cities, not location strings.
       An employer's `location` is whatever they typed: often a list ("Boston;
       New York City; Pennsylvania"), often carrying a country ("San Mateo, CA,
       United States"), and the same place spelled three ways. Grouping the raw
       column offered "United States" as a city and spent three of the fifty
       slots on New York. A wide slice is read here and ranked in rankCities,
       which merges the spellings — see src/lib/cities.ts for why that judgement
       lives in a tested function rather than in SQL. */
    const locationRows = await db
      .select({ location: monitored_jobs.location, n: sql<number>`count(*)::int` })
      .from(monitored_jobs)
      .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
      .where(where)
      .groupBy(monitored_jobs.location)
      .orderBy(sql`count(*) desc`)
      .limit(400);

    return reply.send({
      companies: companies.map((r) => r.v).filter(Boolean),
      locations: rankCities(locationRows, TOP),
      /* `titles` is gone on purpose. It returned the board's most common RAW
         posting titles — "Senior Product Manager - Network Path" — which is not
         what a person types into a field labelled Job title. The board now
         offers a curated vocabulary of role families it holds in the website
         (lib/job-titles.ts), so there is nothing useful for this endpoint to
         say about titles. */
    });
  });

  fastify.get('/jobs/:id', { preHandler: optionalAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = jobParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid job id' });
    /* Same reasoning as the autonomy rule below, applied to sponsorship: the list is not the only
       way into a posting. A bookmark, a shared link, or a dashboard row cached before the filter
       turned on all arrive here, and this is the page where somebody commits to applying. Signed
       out there is no account to have declared anything, so the detail page stays open - the promise
       is about a person's board, not about hiding postings from the world. */
    const sponsorOnly = await accountRequiresSponsor(request.jwtPayload?.userId);
    const rows = await db
      .select({
        id: monitored_jobs.id,
        company_name: monitored_jobs.company_name,
        title: monitored_jobs.title,
        location: monitored_jobs.location,
        department: monitored_jobs.department,
        employment_type: monitored_jobs.employment_type,
        salary_min: monitored_jobs.salary_min,
        salary_max: monitored_jobs.salary_max,
        salary_currency: monitored_jobs.salary_currency,
        salary_interval: monitored_jobs.salary_interval,
        description: monitored_jobs.description,
        apply_url: monitored_jobs.apply_url,
        posting_url: monitored_jobs.posting_url,
        remote: monitored_jobs.remote,
        posted_at: monitored_jobs.posted_at,
        first_seen_at: monitored_jobs.first_seen_at,
        is_active: monitored_jobs.is_active,
        ats_name: career_page_sources.ats_name,
        career_url: career_page_sources.career_url,
        sponsorship_status: monitored_jobs.sponsorship_status,
        employer_sponsors: sql<boolean>`${career_page_sources.sponsor_employer_id} is not null`,
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
        ...(sponsorOnly ? [sponsorOnlyPredicate()] : []),
      ))
      .limit(1);
    if (!rows[0]) return reply.status(404).send({ error: 'Job not found' });
    return reply.send({ job: { ...withCompanyDomain(rows[0]), sponsorship_evidence: evidenceFor(rows[0]) } });
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
    /* Purge before counting, so surfaced_jobs and purged_postings describe the same moment. Counting
       first would report a board that includes rows this run was about to delete. */
    const purged = await purgeExpiredPostings();

    const surfaced = await surfacedJobCount();
    /* THE FLOOR IS CHECKED TWICE, because there are two boards.
     * A count over the whole board says nothing about the sponsor-only one, and the sponsor-only
     * one is the fragile of the two: it drains when employer links go NULL, when a data refresh
     * drops confirmations, or when employers add a refusal sentence. Measuring only the total meant
     * the board a job seeker who needs sponsorship sees could fall to zero while this cron reported
     * ~7,100 and returned 200 - which is precisely the failure the total-board floor exists to
     * prevent, one audience over. */
    const surfacedSponsorOnly = await surfacedJobCount(true);
    const payload = {
      sources: results.length,
      jobs: results.reduce((sum, result) => sum + result.jobs, 0),
      failed: results.filter((result) => !result.ok).length,
      surfaced_jobs: surfaced,
      surfaced_sponsor_only_jobs: surfacedSponsorOnly,
      minimum_surfaced_jobs: MINIMUM_SURFACED_JOBS,
      /* THE SUSTAINABILITY CHECK, run every day rather than once.
       *
       * Whether a 7-day window keeps the board above REQUIRED_SURFACED_JOBS is not a question that
       * stays answered: it depends on weekly hiring volume and on sources still resolving, and both
       * drift. Reporting the window, the requirement and the current multiple on every run is what
       * turns "we checked once in July" into something that keeps checking itself.
       *
       * headroom_multiple is the number to watch. It was 1.9x the day this shipped; a slide toward
       * 1.0 is the signal to widen JOB_FRESHNESS_DAYS or add sources, well before anything breaks. */
      freshness_window_days: JOB_FRESHNESS_DAYS,
      /* The rolling window's two halves, reported so both are visible: how many stale/closed rows
         this run removed, and how long a closed posting is kept before deletion. A purge that
         suddenly deletes thousands, or nothing at all, is the first sign something upstream changed. */
      purged_postings: purged,
      closed_posting_retention_days: CLOSED_POSTING_RETENTION_DAYS,
      required_surfaced_jobs: REQUIRED_SURFACED_JOBS,
      headroom_multiple: Number((surfaced / MINIMUM_SURFACED_JOBS).toFixed(1)),
      board_health: boardHealth(surfaced),
      results,
    };
    const below = boardIsBelowFloor(surfaced);
    const sponsorBelow = boardIsBelowFloor(surfacedSponsorOnly);
    /* Short of the 5x headroom but not yet under the floor: logged as a warning and reported in the
     * payload, NOT a 5xx. The distinction is deliberate. A 5xx here means "the board is broken now";
     * if the merely-thin case also failed the run, the alarm would stop meaning that, and the first
     * real breach would arrive in a channel everyone had learned to ignore. This is the early
     * warning, and it is early precisely because it does not page anyone. */
    if (!below && payload.board_health === 'low') {
      request.log.warn(
        { surfaced, required: REQUIRED_SURFACED_JOBS, windowDays: JOB_FRESHNESS_DAYS, headroom: payload.headroom_multiple },
        `Job board has thin headroom: ${surfaced} surfaced against a ${REQUIRED_SURFACED_JOBS} target. `
        + `Widen JOB_FRESHNESS_DAYS or add sources before it reaches the floor.`,
      );
    }
    if (below || sponsorBelow) {
      request.log.error(
        { surfaced, surfacedSponsorOnly, floor: MINIMUM_SURFACED_JOBS, failedSources: payload.failed },
        'Job board is below its minimum surfaced-jobs floor',
      );
      return reply.status(500).send({
        ...payload,
        error: `The job board is showing ${surfaced} jobs (${surfacedSponsorOnly} of them at employers `
          + `confirmed to sponsor), below the floor of ${MINIMUM_SURFACED_JOBS}. `
          + 'Check career_page_sources.last_error for failing polls, whether a portal left '
          + 'AUTONOMOUS_PORTAL_FAMILIES, and whether career_page_sources.sponsor_employer_id went '
          + 'NULL after a data refresh. Do not lower the floor to clear this.',
      });
    }
    return reply.send(payload);
  });
}
