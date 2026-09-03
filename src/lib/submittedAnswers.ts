import { mergeSubmittedApplicationReviewQuestions, type ApplicationReviewQuestion, type ApplicationReviewState } from './applicationReview';
import type { JobCountry } from './jobLocation';
import {
  knownAnswerLookup,
  refreshKnownQuestionAnswers,
  snapStoredAnswersToOfferedOptions,
  type ApplicationProfileLike,
} from './questionDiscovery';
import { packetQuestionFixpoint } from './packetQuestionIdentity';
import { reopenUnfitClosedChoiceQuestions } from './questionMetadata';

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
  asOf?: Date;
}): { questions: ApplicationReviewQuestion[]; questionsReviewedAt: string } {
  const { current, submitted, profile, postingCountry, postingCountryCode } = options;
  const questionsReviewedAt = current.questions_reviewed_at
    ?? (options.now ?? (() => new Date().toISOString()))();
  const asOf = options.asOf ?? new Date();
  /* The SAME lookup the refresh below resolves with, handed to the merge above it. The merge has to
   * know what the resolver says for two decisions it cannot otherwise make - whether a submitted
   * answer is her choice or a round trip of the resolver's own value, and which value an override was
   * made against - and building it once here is what stops the two halves of this function
   * disagreeing about that, the same reason the round is computed once. */
  const resolverAnswerFor = knownAnswerLookup(profile, current.jd_text, postingCountry, postingCountryCode, asOf);
  /* THE SPELLING PASS RUNS ON THE STORED ROWS, HERE, AND BEFORE THE MERGE.
   *
   * Before the merge, because the merge asks whether a submitted answer is a round trip of what the
   * screen displayed, and the screen displayed this: GET /applications/:id/submission serves the
   * same shaping and does not persist. Comparing her post-back against the un-snapped stored string
   * would read an untouched Save as an edit and stamp applicant_review on a spelling she never
   * chose, which is the 802-answer laundering. Doing it here rather than by teaching
   * knownAnswerLookup the same trick keeps the control's vocabulary out of `answer_override_of`,
   * whose currency is judged by recomputing the resolver.
   *
   * Outside the fixpoint, because packetQuestionFixpoint re-applies its transform to its own output
   * and the refresh inside it overwrites a stored answer with the profile's value; a spelling rule
   * running in there re-spells the machine's answer from pass 2 on. See
   * snapStoredAnswersToOfferedOptions for the measured trace. */
  const merged = mergeSubmittedApplicationReviewQuestions(
    snapStoredAnswersToOfferedOptions(current.questions),
    submitted,
    questionsReviewedAt,
    resolverAnswerFor,
  );
  /* The re-open pass rides the same fixpoint the refresh does, so a save cannot store an answer a
   * strict closed control has no way to express: it settles as a blank question carrying the exact
   * options (and the removed text as its draft) rather than as an unfillable value that deadlocks
   * the packet at the final required-field confirmation. This path is reachable only through
   * reviewAnswerSaveDisposition, which already refuses every packet that may be with the employer,
   * so no sent record is ever rewritten here. */
  const questions = packetQuestionFixpoint(
    merged,
    (candidate) => reopenUnfitClosedChoiceQuestions(refreshKnownQuestionAnswers(
      candidate,
      profile,
      current.jd_text,
      questionsReviewedAt,
      postingCountry,
      postingCountryCode,
      asOf,
    )),
  );
  return { questions, questionsReviewedAt };
}
