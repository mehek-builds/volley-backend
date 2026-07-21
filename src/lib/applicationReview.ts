import type { ExperienceBankEntry } from '../db/schema';
import type { ResumeSpec } from '../llm/resumeSpec';

export type ApplicationReviewQuestion = {
  id: string;
  question: string;
  answer: string;
  kind: 'essay' | 'required';
  required: boolean;
};

export type ApplicationReviewState = {
  jd_text: string;
  portal_url?: string;
  ats_name?: string;
  status:
    | 'resume_ready'
    | 'questions_ready'
    | 'ready_to_submit'
    | 'submit_requested'
    | 'submitting'
    | 'submitted'
    | 'failed';
  edited_terms: string[];
  questions: ApplicationReviewQuestion[];
  skipped_reasons: string[];
  updated_at: string;
  submitted_at?: string;
  submission_error?: string;
};

const TERM_RE = /[A-Za-z][A-Za-z0-9+#./-]*/g;
const STOPWORDS = new Set(
  'the a an and or but to of in on for with from by as at is are was were be been being this that these those your our their'.split(
    ' ',
  ),
);

function terms(value: string): string[] {
  return (value.match(TERM_RE) ?? [])
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 2 && !STOPWORDS.has(term));
}

function overlapScore(left: string, right: string): number {
  const a = new Set(terms(left));
  const b = new Set(terms(right));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

/**
 * Returns the exact words introduced by tailoring, compared with the closest
 * source bullet for the same experience-bank entry. The result is metadata for
 * the review UI only. Grounding is still enforced by resumeValidate.ts.
 */
export function deriveEditedTerms(
  spec: ResumeSpec,
  bank: ExperienceBankEntry[],
): string[] {
  const introduced = new Map<string, string>();

  for (const entry of spec.experience) {
    const sourceEntry = bank.find(
      (candidate) => candidate.org.trim().toLowerCase() === entry.org.trim().toLowerCase(),
    );
    if (!sourceEntry) continue;

    const variants = Array.isArray(sourceEntry.bullet_variants)
      ? sourceEntry.bullet_variants.filter((item): item is string => typeof item === 'string')
      : [];

    for (const bullet of entry.bullets) {
      const source = variants
        .map((variant) => ({ variant, score: overlapScore(bullet, variant) }))
        .sort((a, b) => b.score - a.score)[0]?.variant;
      if (!source) continue;

      const sourceTerms = new Set(terms(source));
      for (const rendered of bullet.match(TERM_RE) ?? []) {
        const normalized = rendered.toLowerCase();
        if (
          normalized.length > 2 &&
          !STOPWORDS.has(normalized) &&
          !sourceTerms.has(normalized)
        ) {
          introduced.set(normalized, rendered);
        }
      }
    }
  }

  return [...introduced.values()].slice(0, 80);
}

export function readApplicationReview(spec: unknown): ApplicationReviewState | null {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const review = (spec as Record<string, unknown>)._review;
  if (!review || typeof review !== 'object' || Array.isArray(review)) return null;
  return review as ApplicationReviewState;
}
