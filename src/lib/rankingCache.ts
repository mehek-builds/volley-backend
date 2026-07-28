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

/** How long a ranking stays usable. Short: new postings should appear without a sign-out. */
export const RANKING_CACHE_TTL_MS = 60_000;

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

export function writeRanking(key: string, value: Omit<RankedList, 'createdAt'>, now: number = Date.now()): RankedList {
  const entry: RankedList = { ...value, createdAt: now };
  // Re-inserting moves the key to the end of the iteration order, so the eviction below stays
  // oldest-first rather than evicting a key that was just refreshed.
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > RANKING_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  return entry;
}

/** Tests only. Production has no reason to drop a ranking early; the TTL owns that. */
export function clearRankingCache(): void {
  cache.clear();
}

export function rankingCacheSize(): number {
  return cache.size;
}
