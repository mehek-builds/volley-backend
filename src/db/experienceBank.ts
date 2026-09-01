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

/* Org and title, and NOT type: see the note inside missingBankEntriesFromResumeSpec for why a
   differing type is a rendering disagreement about one entry rather than a second entry. Narrowed
   rather than left carrying an unused field, so the next reader cannot conclude type still votes. */
type ExistingBankIdentity = Pick<ExperienceBankEntry, 'org' | 'title'>;

function normalizedBankIdentity(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function missingBankEntriesFromResumeSpec(
  spec: ResumeSpec,
  userId: string,
  existing: ExistingBankIdentity[],
): NewExperienceBankEntry[] {
  return bankEntriesFromResumeSpec(spec, userId).filter((candidate) => {
    const candidateOrg = normalizedBankIdentity(candidate.org);
    const candidateTitle = normalizedBankIdentity(candidate.title);
    return !existing.some((entry) => {
      /* TYPE IS NOT PART OF AN ENTRY'S IDENTITY, and treating it as one seeded duplicates.
       *
       * This used to open with `if (entry.type !== candidate.type) return false`, so a bank
       * already holding Tonee as a `project` did not suppress the same Tonee arriving from the
       * base resume as a `job`: same org, same title, same sentences, admitted as a new row
       * because one word of metadata differed. The student then had two bank rows for one
       * venture, /resume/generate selected both, and resumeRender split them across EXPERIENCE
       * and PROJECTS - printing the same bullet twice on a one-page resume.
       *
       * Org and title already answer "is this the same entry". `type` answers "which section
       * does it print under", which is a rendering decision the parse and the base resume
       * routinely disagree about for one venture, and disagreement there is precisely the case
       * this filter exists to collapse rather than to wave through. */
      if (normalizedBankIdentity(entry.org) !== candidateOrg) return false;
      const entryTitle = normalizedBankIdentity(entry.title);
      return !candidateTitle || !entryTitle || candidateTitle === entryTitle;
    });
  });
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
export function readExperienceBank(
  userId: string,
  executor: Pick<typeof db, 'select'> = db,
): Promise<ExperienceBankEntry[]> {
  return executor
    .select()
    .from(experience_bank)
    .where(eq(experience_bank.user_id, userId))
    .orderBy(experience_bank.created_at, experience_bank.id);
}

export async function readExperienceBankOrSeedFromBaseResume(
  userId: string,
  executor: Pick<typeof db, 'select' | 'insert'> = db,
): Promise<ExperienceBankEntry[]> {
  const existing = await readExperienceBank(userId, executor);

  const [profile] = await executor
    .select({ base_resume_json: profiles.base_resume_json })
    .from(profiles)
    .where(eq(profiles.user_id, userId))
    .limit(1);
  const spec = profile?.base_resume_json as ResumeSpec | null | undefined;
  if (!spec) return existing;

  const entries = missingBankEntriesFromResumeSpec(spec, userId, existing);
  if (entries.length === 0) return existing;

  await executor.insert(experience_bank).values(entries);
  return readExperienceBank(userId, executor);
}
