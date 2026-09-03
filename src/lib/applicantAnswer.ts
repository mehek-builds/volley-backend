/* THE ONE DEFINITION of "the applicant chose this answer herself", shared by every reader.
 *
 * Before this existed the predicate was written out four times in two casings, and the copies had
 * already drifted on day one: the portalSubmission copy trimmed answer_source, the two
 * submissionRunner copies compared it untrimmed, so a record with stray whitespace in its
 * provenance would pass the builder's failed-probe exemption and fail the merge's, the exact
 * split-brain the failed-probe fix exists to remove.
 *
 * Its own module, not applicationReview.ts, because applicationReview imports from
 * portalSubmission and both need this: the canonical home beside the ApplicationReviewQuestion
 * type would have made the module graph circular.
 *
 * The parameter is structural rather than ApplicationReviewQuestion because the packet's question
 * shape spells the field answerSource; callers on that shape pass
 * { answer, answer_source: item.answerSource }.
 *
 * `consent_permission` is deliberately NOT accepted. That provenance marks a permission Litos
 * recorded, not a value she chose off a control, and every caller of this predicate is deciding
 * whether a HUMAN stands behind the value.
 */
export function applicantChoseStoredAnswer(
  question: { answer: string; answer_source?: string },
): boolean {
  return question.answer_source?.trim() === 'applicant_review' && Boolean(question.answer.trim());
}

/* THE SAME CLAIM, PINNED TO ONE REVIEW ROUND: "she chose this, and she chose it in THIS round".
 *
 * Lives here beside the predicate it strengthens, for the reason the header above gives - it had
 * begun to drift the same way. It was written out in submissionRunner, where every branch that can
 * drop a stored answer during a fill consults it, and again in questionDiscovery for the send
 * gate, and the two copies disagreed in both directions: one trimmed both timestamps and required
 * both non-empty, the other compared them raw and so read an empty round as matching an empty
 * claim. A record could then be hers to the fill and not hers to the gate, which is the deadlock
 * of a run preserving an answer the send then refuses.
 *
 * Both sides are trimmed and both must be non-empty. An absent round is not a match: a packet that
 * has never been reviewed cannot have been reviewed in its current round.
 */
export function applicantChoseStoredAnswerInRound(
  question: { answer: string; answer_source?: string; answer_reviewed_at?: string },
  questionsReviewedAt: string | undefined,
): boolean {
  const answerReviewedAt = question.answer_reviewed_at?.trim();
  const reviewRound = questionsReviewedAt?.trim();
  return applicantChoseStoredAnswer(question)
    && Boolean(answerReviewedAt)
    && Boolean(reviewRound)
    && answerReviewedAt === reviewRound;
}
