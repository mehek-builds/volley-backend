/**
 * The ordered list of job ids one student's resume produced for one set of filters.
 *
 * WHY THIS EXISTS
 * ---------------
 * Ranking by fit cannot be pushed into SQL, so GET /jobs scores a pool of postings in this process
 * and sorts them here. Without a cache that happens on EVERY request, which bought two problems and
 * no benefit:
 *
 *  - COST. Each page re-fetched the pool and re-scored all of it, so paging to the fourth page paid
 *    the whole synchronous scoring pass four times for one list.
 *  - CORRECTNESS, which is the one that actually mattered. Each page ranked a LIVE pool, so a
 *    posting sitting at rank 49 when page 1 was cut could be at rank 51 by the time page 2 was, and
 *    arrive on both. Two identical React keys is a crash; the same job listed twice is a lie about
 *    the board. Rows could just as easily shift the other way and be skipped entirely, which nobody
 *    would ever see.
 *
 * Caching the ORDER fixes both: a list is ranked once and then paged, so pages tile it exactly.
 * It also makes a larger pool affordable, because the pool is now scored once per list rather than
 * once per page.
 *
 * WHAT IS CACHED, AND WHAT IS DELIBERATELY NOT
 * --------------------------------------------
 * Only the ordering and the scores behind it — never the postings themselves. Rows are always read
 * fresh, so an edited or withdrawn posting is never served from here.
 *
 * The key includes a fingerprint of the resume text, so editing a resume does not serve a stale
 * ranking: a changed resume is simply a different key and misses. It also includes the user id, so
 * one student's ordering can never be served to another.
 *
 * A NOTE ON SERVERLESS, because it bounds what this can promise. In production this runs on Vercel,
 * where module state lives only as long as a warm instance. A student clicking "show more" hits a
 * warm instance most of the time, which is exactly the pattern this is for; a cold instance simply
 * misses and ranks again. So this is a latency and consistency improvement, not a guarantee, and
 * nothing downstream may assume a hit.
 *
 * WHY THERE IS A SECOND TIER (2026-08-04)
 * ---------------------------------------
 * The paragraph above understated what "simply misses and ranks again" costs. A miss re-runs phase
 * 2 of the ranking, which reads `left(description, SCORING_CHARS)` for the whole pool: megabytes
 * out of Neon, per miss. At Litos traffic the process map is cold far more often than it is warm,
 * so the miss was close to the common case and that read was being paid on nearly every board load.
 * It exhausted the Neon free tier's 5 GB/month public network transfer, which suspends the compute
 * until the billing period rolls over. That is the bug this tier exists to stop recurring.
 *
 * So L1 stays exactly as it was (a process map, the fast path on a warm instance) and L2 is an
 * optional Upstash Redis behind `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`, shared by
 * every instance and surviving cold starts. Unconfigured, this file behaves precisely as it did
 * before: L1 only. L2 is never load-bearing for correctness, only for cost.
 *
 * Spoken to over Upstash's REST API with plain `fetch` rather than through `@upstash/redis`. The
 * SDK is a wrapper over these same two calls, and a dependency that ships into a serverless bundle
 * to send two HTTP requests is not worth its weight.
 */

export type RankedList = {
  /** Job ids, best fit first. The ordering the page is cut from. */
  ids: string[];
  /** Score per job id. Null means the posting was not scorable, which is not zero. */
  scores: Map<string, number | null>;
  /** True when postings matched that were never ranked, so the list can say why it stopped. */
  poolExhausted: boolean;
  createdAt: number;
};

/** How long a ranking stays usable in L1. Short: new postings should appear without a sign-out. */
export const RANKING_CACHE_TTL_MS = 60_000;

/**
 * How long a ranking stays usable in L2, which is the number that actually decides the Neon bill.
 *
 * Fifteen minutes rather than L1's sixty seconds, and the asymmetry is the point. L1's short window
 * was chosen when a miss was cheap-ish and freshness was the only thing being traded; L2 exists
 * because a miss is megabytes of description text off Neon, so it is worth holding an ordering far
 * longer than a warm process would.
 *
 * Fifteen minutes is safe here in a way it would NOT be for a row cache, because this holds only an
 * ordering of ids. GET /jobs re-reads every row fresh and REAPPLIES THE WHOLE FILTER CONTRACT to it
 * (see the `inArray(monitored_jobs.id, pageIds)` query in jobMonitor.ts), so an id that has since
 * been withdrawn, edited out of the filters, or had its source disabled simply fails to resolve and
 * is dropped from the page. The worst a stale ordering can do is rank a posting by a fit score that
 * is up to fifteen minutes old, and show slightly fewer than `limit` rows on a page whose ids have
 * since stopped matching. Both were already possible at sixty seconds.
 *
 * What DOES drift further at this window is `ranked_pool` and `has_more`, which count ids in the
 * cached list rather than rows that still resolve. Also already true at sixty seconds, and still
 * the right trade: the alternative is re-reading the pool to keep a count honest.
 */
export const RANKING_SHARED_TTL_MS = 900_000;

/**
 * How many rankings to hold. Each is a few hundred ids and their scores, so the whole map is well
 * under a megabyte at this size, and the eviction below is oldest-first rather than true LRU
 * because the TTL already does most of the work.
 */
export const RANKING_CACHE_MAX = 200;

const cache = new Map<string, RankedList>();

/**
 * A short, stable fingerprint of the resume text.
 *
 * Not a cryptographic hash and does not need to be: a collision means one student briefly sees an
 * ordering computed from their own previous resume, which the TTL clears within a minute. The
 * length is mixed in because it is the cheapest possible discriminator between two edits.
 */
export function resumeFingerprint(resumeText: string): string {
  let hash = 5381;
  for (let i = 0; i < resumeText.length; i++) {
    hash = ((hash << 5) + hash + resumeText.charCodeAt(i)) | 0;
  }
  return `${resumeText.length}.${(hash >>> 0).toString(36)}`;
}

/** Two requests share a ranking only if the student, their resume, and their filters all match. */
export function rankingCacheKey(userId: string, resumeText: string, filters: string): string {
  return `${userId}|${resumeFingerprint(resumeText)}|${filters}`;
}

export function readRanking(key: string, now: number = Date.now()): RankedList | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (now - entry.createdAt > RANKING_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry;
}

/**
 * Insert into L1 and enforce the size bound.
 *
 * Its own function because there are now TWO ways an entry enters L1 — a fresh ranking from
 * writeRanking, and an L2 hit promoted by readRankingShared — and the second one originally called
 * `cache.set` directly. That skipped the eviction below, so on a warm instance serving many
 * distinct keys out of L2 the map grew without any bound at all. RANKING_CACHE_MAX is not a
 * suggestion: this runs in a serverless process whose memory is shared with resume generation.
 */
function insertIntoL1(key: string, entry: RankedList): void {
  // Re-inserting moves the key to the end of the iteration order, so the eviction below stays
  // oldest-first rather than evicting a key that was just refreshed.
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > RANKING_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export function writeRanking(key: string, value: Omit<RankedList, 'createdAt'>, now: number = Date.now()): RankedList {
  const entry: RankedList = { ...value, createdAt: now };
  insertIntoL1(key, entry);
  return entry;
}

/** Tests only. Production has no reason to drop a ranking early; the TTL owns that. */
export function clearRankingCache(): void {
  cache.clear();
}

export function rankingCacheSize(): number {
  return cache.size;
}

/* ------------------------------------------------------------------------------------------------
 * L2: the shared tier.
 * ---------------------------------------------------------------------------------------------- */

/** Namespaced so a shared Upstash database cannot collide with another user of the same instance. */
const SHARED_PREFIX = 'litos:ranking:v1:';

/**
 * How long to wait on Upstash before giving up and treating it as a miss.
 *
 * A miss costs a re-rank. A hang costs the request. Two seconds is far past a healthy Upstash
 * round trip and far short of anything a student would sit through, and the abort means a Redis
 * outage degrades this to exactly the L1-only behaviour that shipped before, rather than taking
 * the board down with it.
 */
const SHARED_TIMEOUT_MS = 2_000;

type SharedConfig = { url: string; token: string };

/**
 * Read at call time rather than at module load, because tests set and unset these between cases
 * and a module-level capture would freeze whichever value happened to be present at import.
 */
function sharedConfig(): SharedConfig | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

export function sharedRankingConfigured(): boolean {
  return sharedConfig() !== null;
}

/**
 * The wire shape. `scores` is a Map in memory and Maps do not survive JSON, so it goes over as
 * pairs. Versioned by the key prefix rather than a field, so a shape change is a new keyspace and
 * old entries expire on their own instead of needing a reader that understands both.
 */
type SharedPayload = {
  ids: string[];
  scores: [string, number | null][];
  poolExhausted: boolean;
  createdAt: number;
};

async function upstash(config: SharedConfig, command: unknown[]): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHARED_TIMEOUT_MS);
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { result?: unknown };
    return body?.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * L1, then L2, then miss.
 *
 * An L2 hit is promoted into L1 so the rest of that instance's life pages out of memory. It is
 * promoted with its ORIGINAL `createdAt`, not with `now`: rewriting the timestamp would let a
 * ranking be handed from instance to instance and refreshed at each hop, so a popular key could
 * outlive its own TTL indefinitely and freshness would decay silently as traffic grew.
 *
 * Every failure path here returns null, which the caller already handles as a miss. A ranking cache
 * that throws is strictly worse than one that is empty.
 */
export async function readRankingShared(key: string, now: number = Date.now()): Promise<RankedList | null> {
  const local = readRanking(key, now);
  if (local) return local;

  const config = sharedConfig();
  if (!config) return null;

  try {
    const raw = await upstash(config, ['GET', `${SHARED_PREFIX}${key}`]);
    if (typeof raw !== 'string') return null;
    const parsed = JSON.parse(raw) as SharedPayload;
    if (!parsed || !Array.isArray(parsed.ids) || !Array.isArray(parsed.scores)) return null;
    /* Upstash honours the EX we set, but an entry can still be older than L2's window if the TTL
       was changed after it was written. Checked here so the deploy that shortens the window takes
       effect immediately rather than whenever the last long-lived entry happens to expire. */
    if (now - parsed.createdAt > RANKING_SHARED_TTL_MS) return null;
    const entry: RankedList = {
      ids: parsed.ids,
      scores: new Map(parsed.scores),
      poolExhausted: Boolean(parsed.poolExhausted),
      createdAt: parsed.createdAt,
    };
    /* Through the same bounded insert as a fresh write. A bare cache.set here would skip
       RANKING_CACHE_MAX entirely, and this is the path that runs on every cold-ish request, so it
       is the one most able to grow the map without limit. */
    insertIntoL1(key, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * Write both tiers. L1 first and unconditionally, so an Upstash outage cannot cost the warm-instance
 * behaviour that shipped before L2 existed.
 *
 * The L2 write is AWAITED rather than left floating. On Vercel a serverless invocation can be frozen
 * the moment its response is sent, so a fire-and-forget SET is not merely unordered, it may never be
 * sent at all, and the tier that exists to survive cold starts would then be empty exactly when it
 * matters. The abort in `upstash` bounds what that await can cost.
 */
export async function writeRankingShared(
  key: string,
  value: Omit<RankedList, 'createdAt'>,
  now: number = Date.now(),
): Promise<RankedList> {
  const entry = writeRanking(key, value, now);

  const config = sharedConfig();
  if (!config) return entry;

  const payload: SharedPayload = {
    ids: entry.ids,
    scores: [...entry.scores.entries()],
    poolExhausted: entry.poolExhausted,
    createdAt: entry.createdAt,
  };
  try {
    await upstash(config, [
      'SET',
      `${SHARED_PREFIX}${key}`,
      JSON.stringify(payload),
      'EX',
      String(Math.floor(RANKING_SHARED_TTL_MS / 1000)),
    ]);
  } catch {
    /* Cost optimisation, not correctness. A failed write means the next cold instance re-ranks,
       which is exactly what happened before this tier existed. */
  }
  return entry;
}
