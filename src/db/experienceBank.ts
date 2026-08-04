import { eq } from 'drizzle-orm';
import { db } from './index';
import { experience_bank, profiles, type ExperienceBankEntry, type NewExperienceBankEntry } from './schema';
import type { ResumeSpec } from '../llm/resumeSpec';

export function bankEntriesFromResumeSpec(spec: ResumeSpec, userId: string): NewExperienceBankEntry[] {
  return (spec.experience ?? [])
    .filter((entry) => entry.org?.trim())
    .map((entry) => ({
      user_id: userId,
      type: entry.type ?? 'job',
      org: entry.org.trim(),
      title: entry.title?.trim() || null,
      date_range: entry.date_range?.trim() || null,
      location: entry.location?.trim() || null,
      bullet_variants: (entry.bullets ?? []).map((bullet) => bullet.trim()).filter(Boolean),
      tags: [],
    }))
    .filter((entry) => (entry.bullet_variants as string[]).length > 0);
}

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

export async function readExperienceBankOrSeedFromBaseResume(userId: string): Promise<ExperienceBankEntry[]> {
  const existing = await readExperienceBank(userId);
  if (existing.length > 0) return existing;

  const [profile] = await db
    .select({ base_resume_json: profiles.base_resume_json })
    .from(profiles)
    .where(eq(profiles.user_id, userId))
    .limit(1);
  const spec = profile?.base_resume_json as ResumeSpec | null | undefined;
  if (!spec) return existing;

  const entries = bankEntriesFromResumeSpec(spec, userId);
  if (entries.length === 0) return existing;

  await db.insert(experience_bank).values(entries);
  return readExperienceBank(userId);
}
