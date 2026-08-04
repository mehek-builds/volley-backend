import { createHash } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { db } from '../db/index';
import { competency_verdicts } from '../db/schema';
import { isoDay, judgeCompetencies, type CandidateProfile, type CompetencyQuestion, type CompetencyRejection, type CompetencyVerdict } from './competencyJudge';

/**
 * The competency judge, with the same answer never bought twice.
 *
 * CONTENT-ADDRESSED, so there is no invalidation to get wrong. The key is the clause and the
 * bullets, hashed. Edit the resume and every key changes; edit the posting and the affected
 * clause's key changes. A stale hit is not something this can produce, which is why the rows never
 * expire and nothing sweeps them.
 *
 * EVERYTHING THE ANSWER DEPENDS ON IS IN THE KEY, which for an ELIGIBILITY question is more than
 * the clause and the bullets. Its answer turns on the candidate's GRADUATION DATE, which is not a
 * bullet, and on TODAY, because "rising senior" and "graduating within twelve months" mean
 * different things in different months. Keyed on clause and bullets alone:
 *   - a student who corrects their graduation date keeps the verdict computed from the old one,
 *     forever, because nothing expires;
 *   - two students with no bullets on file share a key, so the first one's graduation verdict is
 *     served to the second;
 *   - a "not yet a senior" answer stays cached into the year they become one.
 * So the eligibility key carries the facts and the day as well. Competency keys are unchanged:
 * whether a bullet shows Python does not depend on the date.
 *
 * ONLY SURVIVING VERDICTS ARE WRITTEN. A verdict the grounding gate threw out is a bad model
 * response, and caching it would make one bad response permanent for everyone who ever asks the
 * same question. Rejections are returned to the caller and forgotten.
 */

export function cacheKey(
  clause: string,
  bullets: string[],
  /** Present only for eligibility questions. Omitted, this is the original competency key. */
  scope?: { gradDate?: string | null; today?: string },
): string {
  const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);
  /* The bullets are hashed as one document rather than per bullet: a competency verdict is about
   * the whole resume ("do ANY of these bullets show this"), so the resume is the unit.
   *
   * JSON.stringify, not a join. This shipped joining on a literal NUL byte, which worked - nothing
   * can collide through it - but made the FILE BINARY to git, so every diff of this module rendered
   * as "Bin 3503 -> 3952 bytes" and could not be read by a human or a reviewer. A separator that
   * makes its own module unreviewable costs more than the collision it prevents. JSON quoting is
   * unambiguous for the same reason and stays printable. */
  const base = `${h(clause.trim())}:${h(JSON.stringify(bullets.map((b) => b.trim())))}`;
  if (!scope) return base;
  /* Prefixed rather than mixed into the existing halves, so an eligibility key can never collide
     with the competency key for the same clause and resume, and so a key is readable at a glance
     when one turns up wrong in the table. */
  return `e:${h(JSON.stringify([scope.gradDate ?? null, scope.today ?? null]))}:${base}`;
}

export interface CachedJudgement {
  verdicts: CompetencyVerdict[];
  rejected: CompetencyRejection[];
  /** How many answers came back without a model call, for the route to report. */
  fromCache: number;
  /** How many had to be judged. Zero on a repeat view, which is the point. */
  judged: number;
}

export async function judgeCompetenciesCached(
  bullets: string[],
  questions: CompetencyQuestion[],
  profile?: CandidateProfile,
): Promise<CachedJudgement> {
  if (questions.length === 0) return { verdicts: [], rejected: [], fromCache: 0, judged: 0 };

  const today = isoDay();
  const keyFor = (q: CompetencyQuestion) =>
    q.kind === 'eligibility'
      ? cacheKey(q.clause, bullets, { gradDate: profile?.gradDate ?? null, today })
      : cacheKey(q.clause, bullets);
  const keyed = questions.map((q) => ({ q, key: keyFor(q) }));
  const rows = await db
    .select()
    .from(competency_verdicts)
    .where(inArray(competency_verdicts.cache_key, [...new Set(keyed.map((k) => k.key))]));
  const cached = new Map(rows.map((r) => [r.cache_key, r]));

  const hits: CompetencyVerdict[] = [];
  const misses: CompetencyQuestion[] = [];
  for (const { q, key } of keyed) {
    const row = cached.get(key);
    if (row) hits.push({ id: q.id, met: row.met, quote: row.quote ?? undefined, why: row.why ?? undefined });
    else misses.push(q);
  }

  if (misses.length === 0) return { verdicts: hits, rejected: [], fromCache: hits.length, judged: 0 };

  const fresh = await judgeCompetencies(bullets, misses, profile);

  // A row is keyed on content alone, so two requests racing on the same clause write the same
  // value; onConflictDoNothing makes that a no-op rather than an error.
  /* Read off the STRUCTURE, not off a formatted string. This split a human message on ':' and
     assumed every rejection began with an id; "unknown id X" and "response had no verdicts array"
     do not, so they produced junk set members. Benign then, and a silent fail-open the moment
     anyone reworded a message: a hallucinated verdict would have been cached forever. */
  const rejectedIds = new Set(fresh.rejected.map((r) => r.id).filter((id): id is string => Boolean(id)));
  const byId = new Map(misses.map((q) => [q.id, q]));
  const writable = fresh.verdicts.filter((v) => !rejectedIds.has(v.id) && byId.has(v.id));
  if (writable.length > 0) {
    await db
      .insert(competency_verdicts)
      .values(
        writable.map((v) => ({
          /* keyFor, NOT cacheKey(clause, bullets). Writing under the unscoped key while reading
             under the scoped one means an eligibility answer is filed where nobody looks: every
             view is a fresh model call, and the row it leaves behind is labelled as if it were
             valid for any graduation date and any day. */
          cache_key: keyFor(byId.get(v.id)!),
          met: v.met,
          quote: v.quote ?? null,
          why: v.why ?? null,
        })),
      )
      .onConflictDoNothing();
  }

  return {
    verdicts: [...hits, ...fresh.verdicts],
    rejected: fresh.rejected,
    fromCache: hits.length,
    judged: misses.length,
  };
}
