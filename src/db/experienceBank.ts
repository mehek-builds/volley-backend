import { eq } from 'drizzle-orm';
import { db } from './index';
import { experience_bank, type ExperienceBankEntry } from './schema';

// The one way to read a student's experience bank.
//
// It exists so the ORDER BY cannot be forgotten (R-022). Postgres promises no row order without
// one, and the bank is not just displayed: it is fed into grounding, where the entry chosen for an
// org used to depend on which row came back first, so two identical requests could produce
// different resumes. That surfaced as the pruner rewriting a real title ("AI Engineer" -> the
// "Founder" of a sibling entry sharing one word) and deleting a true bullet.
//
// matchBankEntry no longer breaks ties on array order, so this is belt-and-braces for correctness.
// It still earns its place twice over:
//   - Reproducibility. Same bank + same JD should mean the same spec, or a bug report cannot be
//     re-run.
//   - Cost. resumeSpec.ts serializes JSON.stringify(bank) into a `cache_control: ephemeral` prompt
//     prefix, so an unstable row order silently busts the prompt cache and re-bills the whole bank
//     plus JD at full price on every call.
//
// created_at is the student's own authoring order; id breaks any same-timestamp tie (onboarding
// inserts a batch in one statement, so identical timestamps are the normal case, not an edge one).
export function readExperienceBank(userId: string): Promise<ExperienceBankEntry[]> {
  return db
    .select()
    .from(experience_bank)
    .where(eq(experience_bank.user_id, userId))
    .orderBy(experience_bank.created_at, experience_bank.id);
}
