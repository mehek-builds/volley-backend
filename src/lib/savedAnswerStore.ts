/**
 * Reading and writing the answers a student gave once, keyed by the question rather than by a
 * column. The rule for WHICH answers may live here is in lib/answerReuse.ts and is enforced on both
 * sides of this module; nothing here decides anything.
 *
 * TOLERANT ON READ, deliberately, and for the reason lib/applicationFacts.ts is: on Vercel a merge
 * is a deploy, so this code can be live for minutes or hours before the migration that creates its
 * table has run. A missing table must degrade to "she has never answered anything", which is the
 * behaviour that exists today, rather than take down the Apply path for every posting.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { saved_application_answers } from '../db/schema';
import type { AnswerReuseContext, StorableAnswer } from './answerReuse';
import { reusableAnswersToStore, type ReviewedAnswer } from './answerReuse';

/** Postgres "relation does not exist". The one error a not-yet-migrated table produces. */
function isMissingRelation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '42P01';
}

/** Every remembered answer for this student, as key -> answer. Empty when nothing is stored. */
export async function loadSavedAnswers(userId: string): Promise<Map<string, string>> {
  try {
    const rows = await db
      .select({
        question_key: saved_application_answers.question_key,
        answer: saved_application_answers.answer,
      })
      .from(saved_application_answers)
      .where(eq(saved_application_answers.user_id, userId));
    return new Map(rows.map((row) => [row.question_key, row.answer]));
  } catch (error) {
    if (isMissingRelation(error)) return new Map();
    throw error;
  }
}

/**
 * Remember the reusable answers out of a reviewed set.
 *
 * Returns what was stored, so a caller can log it and a test can assert on it without a database.
 * An answer that is already stored is UPDATED rather than skipped: she has just retyped it on a
 * live form, which is the most recent thing she has said about it.
 */
export async function rememberReusableAnswers(
  userId: string,
  answers: readonly ReviewedAnswer[],
  context: AnswerReuseContext & { jobId?: string | null } = {},
): Promise<StorableAnswer[]> {
  const storable = reusableAnswersToStore(answers, { company: context.company });
  if (storable.length === 0) return [];
  const now = new Date();
  try {
    await db
      .insert(saved_application_answers)
      .values(storable.map((item) => ({
        user_id: userId,
        question_key: item.key,
        question: item.question,
        answer: item.answer,
        first_answered_job_id: context.jobId ?? null,
        created_at: now,
        updated_at: now,
      })))
      .onConflictDoUpdate({
        target: [saved_application_answers.user_id, saved_application_answers.question_key],
        set: {
          answer: sql`excluded.answer`,
          question: sql`excluded.question`,
          updated_at: now,
        },
      });
    return storable;
  } catch (error) {
    if (isMissingRelation(error)) return [];
    throw error;
  }
}

/** Forget specific remembered answers, by key. Used when a student edits or clears one. */
export async function forgetSavedAnswers(userId: string, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await db.delete(saved_application_answers).where(and(
      eq(saved_application_answers.user_id, userId),
      inArray(saved_application_answers.question_key, [...keys]),
    ));
  } catch (error) {
    if (isMissingRelation(error)) return;
    throw error;
  }
}
