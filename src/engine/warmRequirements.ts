import { segmentJd } from './jdMatch';
import { splitClauses, matchClause, type CandidateFacts } from './clauseMatch';
import { judgeCompetenciesCached } from '../llm/competencyCache';
import type { CompetencyQuestion } from '../llm/competencyJudge';

/**
 * Fill the competency cache for a posting BEFORE anyone opens its review screen.
 *
 * WHY HERE. Judging a posting's competency clauses is one Sonnet call, and measured on the live
 * account it put 24 seconds in front of a student who had just clicked "What this job asks for".
 * The cache made the SECOND look free and did nothing for the first. Packets are prewarmed in the
 * background, minutes or hours before anyone reads them, so the same call costs nothing there.
 *
 * BOUNDED AND NON-FATAL, both deliberately. This is an optimisation for a screen nobody is looking
 * at yet: a slow model, a rate limit or an outage must never turn into a failed resume generation,
 * and it must never hold a response open. The worst case is exactly today's behaviour, the student
 * pays for the judgement when they open the breakdown.
 *
 * It writes NOTHING of its own. judgeCompetenciesCached owns the write, and it only stores verdicts
 * that survived the grounding gate, so warming cannot put anything in the cache that asking
 * directly would not have.
 */

/** Long enough for one batched judgement, short enough that a hung model cannot stall a generate. */
export const WARM_TIMEOUT_MS = 20_000;

export interface WarmResult {
  /** Clauses sent for judgement. Zero when the posting states none, which is common and fine. */
  asked: number;
  judged: number;
  fromCache: number;
  /** Why it did not finish, when it did not. Never thrown. */
  skipped?: string;
}

/* The questions a warm pass would ask, split out so they can be tested without a database.
   warmRequirementCache reaches Postgres on its very next line, so every assertion about WHICH
   clauses get warmed had to mock the world or go unwritten - and went unwritten, which is how
   graduation clauses sat outside the warm set. */
export function warmQuestions(
  jdText: string,
  facts: CandidateFacts,
  context: { company?: string; role?: string; job_id?: string | null } | undefined,
): CompetencyQuestion[] {
  const questions: CompetencyQuestion[] = [];
  for (const section of segmentJd(jdText)) {
    if (section.kind !== 'required' && section.kind !== 'preferred') continue;
    for (const text of splitClauses(section.text)) {
      const clause = matchClause(text, section.weight, facts, context);
      /* GRADUATION IS WARMED TOO. It is a model call on the same batch, so leaving it out meant
         the review screen still paid for one round trip after a "warm" packet build, on exactly
         the clause the student most wants an answer to. The kind must ride along: warmed without
         it, the answer is judged against the bullets, rejected as ungrounded, and the cache is
         poisoned with an unmet for a requirement that was never really asked. */
      if (clause.basis === 'competency') {
        questions.push({ id: `w${questions.length}`, clause: text, kind: 'competency' });
      } else if (clause.basis === 'graduation' && clause.verdict === 'pending') {
        questions.push({ id: `w${questions.length}`, clause: text, kind: 'eligibility' });
      }
    }
  }
  return questions;
}

export async function warmRequirementCache(
  jdText: string | null | undefined,
  facts: CandidateFacts,
  context: { company?: string; role?: string; job_id?: string | null } | undefined,
  timeoutMs: number = WARM_TIMEOUT_MS,
): Promise<WarmResult> {
  const bullets = facts.bullets ?? [];
  if (!jdText || bullets.length === 0) return { asked: 0, judged: 0, fromCache: 0, skipped: 'nothing to judge' };

  // The same deterministic pass the review screen runs, so the clauses warmed are exactly the
  // clauses it will ask about. Anything decidable locally never reaches the model here either.
  const questions = warmQuestions(jdText, facts, context);

  if (questions.length === 0) return { asked: 0, judged: 0, fromCache: 0 };

  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      judgeCompetenciesCached(bullets, questions, {
        degree: facts.degree,
        school: facts.school,
        gradDate: facts.gradDate,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('warm timed out')), timeoutMs);
      }),
    ]);
    return { asked: questions.length, judged: result.judged, fromCache: result.fromCache };
  } catch (err) {
    // Swallowed on purpose. See the header: this must not be able to fail a generation.
    return {
      asked: questions.length,
      judged: 0,
      fromCache: 0,
      skipped: err instanceof Error ? err.message : 'warm failed',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
