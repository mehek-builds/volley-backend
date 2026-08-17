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
