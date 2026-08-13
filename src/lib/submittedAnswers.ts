import { mergeSubmittedApplicationReviewQuestions, type ApplicationReviewQuestion, type ApplicationReviewState } from './applicationReview';
import type { JobCountry } from './jobLocation';
import { refreshKnownQuestionAnswers, type ApplicationProfileLike } from './questionDiscovery';

/**
 * The answers POST /submit-request will fill the employer's form from, and the review round they are
 * recorded against.
 *
 * THREE LINES THAT HAVE TO AGREE, WHICH IS WHY THEY ARE ONE FUNCTION. The merge stamps an answer the
 * applicant supplied for a question the resolver holds; the refresh reads that stamp to decide
 * whether to keep the answer or blank it; and the review that gets persisted has to carry the round
 * both of them were keyed to. Passing a different value to any one of the three silently discards
 * the claim, because a per-answer `answer_reviewed_at` is only meaningful beside the
 * `questions_reviewed_at` it equals.
 *
 * THE ROUND IS THE ONE THIS SUBMIT IS, and only falls back to a stored round when there is one.
 * `questions_reviewed_at` is written only by a save through the review routes, so a packet that has
 * never been through one has none - 130 of the 134 packets holding a resolver-held question on
 * 2026-08-12. Reusing that absent round meant the merge could not record who filled a blank, and the
 * refresh then erased the applicant's own words on the one request that reaches the employer.
 *
 * MINTING A FRESH ROUND CANNOT INVALIDATE ANYTHING THAT WAS ALREADY THERE. Both halves of the claim
 * are always written together, so a packet with no stored round has no stored `answer_reviewed_at`
 * either, and there is nothing for a new round to fail to match. Where a round IS stored, this is
 * that same string and every existing claim is checked exactly as before.
 */
export function resolveSubmittedApplicationAnswers(options: {
  current: Pick<ApplicationReviewState, 'questions' | 'questions_reviewed_at' | 'jd_text'>;
  submitted: readonly ApplicationReviewQuestion[];
  profile: ApplicationProfileLike;
  postingCountry?: JobCountry;
  postingCountryCode?: string;
  now?: () => string;
}): { questions: ApplicationReviewQuestion[]; questionsReviewedAt: string } {
  const { current, submitted, profile, postingCountry, postingCountryCode } = options;
  const questionsReviewedAt = current.questions_reviewed_at
    ?? (options.now ?? (() => new Date().toISOString()))();
  const merged = mergeSubmittedApplicationReviewQuestions(current.questions, submitted, questionsReviewedAt);
  const questions = refreshKnownQuestionAnswers(
    merged,
    profile,
    current.jd_text,
    questionsReviewedAt,
    postingCountry,
    postingCountryCode,
  );
  return { questions, questionsReviewedAt };
}
