import type { ExperienceBankEntry } from '../db/schema';
import { resumeCovers, type JdTerm } from './jdMatch';

/**
 * Turning a missing requirement into a resume bullet, WITHOUT inventing one.
 *
 * The competitive version of this feature (Rezi's "AI Keyword Targeting", the single most praised
 * thing in its review corpus) works like this: for each keyword the posting wants and the resume
 * lacks, generate a new bullet that naturally includes the term. That is the most-copied idea in
 * the category, and shipping it as written would manufacture the exact defect this codebase spent
 * R-015 removing. A generated bullet containing "Kubernetes" is a claim that the student used
 * Kubernetes. The model does not know whether they did. Neither does the JD.
 *
 * So Litos does the half that is true and refuses the half that is not:
 *
 *   SELECTION, NOT INVENTION. experience_bank.bullet_variants holds every phrasing the student has
 *   ever written for an entry across resume versions. A requirement the resume does not mention is
 *   very often one the student HAS done and simply phrased differently in the variant that got
 *   picked this time. Surfacing that variant is a real fix, and every word of it is theirs.
 *
 *   AN HONEST EMPTY ANSWER. When nothing in the bank mentions the term, we say nothing in their
 *   experience mentions it and stop. We do not offer to write it. That empty state IS the feature:
 *   it tells the student what they would have to have actually done, instead of handing them a
 *   sentence that reads well and is not true.
 *
 * The lesson the vault already paid for: the 2026-07-27 onboarding run found the worst defect in
 * the product was base-resume skills that were model-written rather than the student's own. This
 * is the same failure one layer up, and the same answer applies.
 */

export interface GapEvidence {
  /** The normalized requirement term this evidence is for. */
  term: string;
  /** The bank entry the wording came from. */
  entry_id: string;
  org: string;
  title: string | null;
  /** The student's own phrasing, verbatim. Never generated, never edited. */
  variant: string;
  /** True when this exact wording is already on the tailored resume, so swapping it in is a no-op. */
  already_on_resume: boolean;
}

export interface GapAnswer {
  term: string;
  display: string;
  /** Every variant in the bank that evidences this term, best (most specific) first. */
  evidence: GapEvidence[];
  /** No evidence anywhere in the bank. The UI says so plainly rather than offering to write one. */
  unsupported: boolean;
}

/**
 * Rank evidence so the most useful variant is offered first.
 *
 * A variant that mentions the term AND carries a metric is stronger than one that only mentions it,
 * because the resume policy already prefers quantified bullets. Among equals, shorter wins: it is
 * likelier to fit the one page the renderer enforces.
 */
const METRIC_RE = /(\$|%|\d)/;

function rank(a: GapEvidence, b: GapEvidence): number {
  const metric = Number(METRIC_RE.test(b.variant)) - Number(METRIC_RE.test(a.variant));
  if (metric !== 0) return metric;
  return a.variant.length - b.variant.length;
}

/**
 * For each missing requirement, find the student's own wording that already evidences it.
 *
 * @param missing     the unmet requirements, from scoreJdMatch
 * @param bank        the student's experience bank
 * @param resumeText  the resume as currently tailored, used only to mark a variant as already used
 */
export function findGapEvidence(
  missing: JdTerm[],
  bank: ExperienceBankEntry[],
  resumeText: string,
): GapAnswer[] {
  return missing.map((term) => {
    const evidence: GapEvidence[] = [];

    for (const entry of bank) {
      // bullet_variants is jsonb, so drizzle types it as unknown. It is written as string[] by
      // the only writer (PUT /profile/experience-bank, zod-validated), but a defensive narrow here
      // costs nothing and a malformed row must not throw inside a scoring request.
      const variants = Array.isArray(entry.bullet_variants) ? (entry.bullet_variants as string[]) : [];
      for (const variant of variants) {
        if (typeof variant !== 'string' || !variant.trim()) continue;
        // The SAME matcher the score uses. If this drifted, we would offer the student a bullet
        // that does not move the number, or fail to offer one that would.
        if (!resumeCovers(variant, term.term)) continue;
        evidence.push({
          term: term.term,
          entry_id: entry.id,
          org: entry.org,
          title: entry.title ?? null,
          variant,
          // The WHOLE variant, not a prefix. A 60-char prefix check reported "already on this
          // resume" for a bullet that differs only near its end, which is the common case: the
          // bank holds "...deployed them on Kubernetes, cutting release time by 35%" while the
          // resume carries the AWS phrasing of the same sentence. They share the first 60 chars,
          // so the Kubernetes variant was marked as already used and the student could never
          // accept the one that would actually close the gap.
          already_on_resume: resumeCovers(resumeText, variant),
        });
      }
    }

    evidence.sort(rank);
    return {
      term: term.term,
      display: term.display,
      evidence,
      unsupported: evidence.length === 0,
    };
  });
}
