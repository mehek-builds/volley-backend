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

/* THE REVIEW ROUND IS AN EPOCH, NOT AN EQUALITY KEY, and that is the whole of this module's second
 * definition.
 *
 * `questions_reviewed_at` is minted once, at the FIRST review a packet ever has, and deliberately
 * never advances on the two narrow paths: `current.questions_reviewed_at ?? now()` in
 * resolveSubmittedApplicationAnswers and in PUT /applications/:id/review/answers. It has to stay
 * frozen there, because advancing it is what would invalidate every standing claim on the packet at
 * once, and re-stamping the carried-forward claims to the new round is the blanket stamp behind the
 * 802-answer laundering incident recorded at mergeSubmittedApplicationReviewQuestions' mint site.
 *
 * WHAT THAT COST, MEASURED. Packet 4a79eec1 (Hudson River Trading, greenhouse) carried round
 * 2026-09-01T21:28:12.934Z, and because the mint wrote the round rather than the clock, every claim
 * minted afterwards was stamped with it - including answers she genuinely edited on 2026-09-03. The
 * record asserted she had reviewed, two days earlier, values that did not exist yet. That is a false
 * sentence about a person in the one field built to say when she looked at something.
 *
 * SO THE ROUND BECOMES A BOUNDARY AND THE STAMP BECOMES THE CLOCK. A claim is current when it was
 * made AT OR AFTER the packet's current epoch: a fresh honest timestamp is at or after it and stays
 * valid, and a claim left over from a superseded epoch is before it and does not. Every one of the
 * twelve readers was already asking exactly that question - "did she choose this, and has that
 * choice been superseded" - and none of them was asking for string identity; identity was only ever
 * the way the frozen round happened to spell it.
 *
 * THIS ACCEPTS STRICTLY MORE THAN EQUALITY DID AND REJECTS NOTHING NEW, which is what makes it safe
 * to land under standing claims. The only records it newly admits are those with
 * `answer_reviewed_at` strictly AFTER the round, and no writer in the repo can produce one today:
 * every mint writes the round itself, applyApplicantReviewedAnswers advances the round and
 * re-stamps in the same breath, and questionSchema strips both provenance keys so no caller can
 * inject one. A claim from a superseded epoch compares BEFORE the round and is refused exactly as
 * it was before. Pinned in submittedAnswers.test.ts under both directions.
 *
 * THE STRING-EQUALITY ARM RUNS FIRST so the guarantee above holds even for a stored round that is
 * not parseable as a date. Anything today's readers accept, this accepts.
 *
 * UNPARSEABLE OTHERWISE MEANS NOT CURRENT, matching every reader's existing shape: a claim whose
 * round cannot be checked is one the reader throws away rather than trusts.
 */
export function applicantReviewIsCurrent(
  answerReviewedAt: string | undefined,
  questionsReviewedAt: string | undefined,
): boolean {
  const claimed = answerReviewedAt?.trim();
  const epoch = questionsReviewedAt?.trim();
  if (!claimed || !epoch) return false;
  if (claimed === epoch) return true;
  const claimedAt = Date.parse(claimed);
  const epochAt = Date.parse(epoch);
  return Number.isFinite(claimedAt) && Number.isFinite(epochAt) && claimedAt >= epochAt;
}

/* WHEN A CLAIM MINTED RIGHT NOW SAYS SHE REVIEWED IT, which is the clock and not the round.
 *
 * Clamped to the epoch so a freshly minted claim is current BY CONSTRUCTION rather than by luck.
 * Two things could otherwise put an honest `now` behind the round it is being minted against: a
 * packet whose stored `questions_reviewed_at` is in the future (a clock that has since been
 * corrected backwards), and a caller that computes its round and its clock in either order. Either
 * one would mint a claim that the reader above immediately refuses - the answers route would return
 * 200 having recorded nothing, which is the shape of the CONFIRM loop this codebase has already
 * paid for twice. The clamp costs a claim at most the round's own timestamp, which is exactly what
 * it used to get unconditionally.
 */
export function mintedApplicantReviewAt(
  reviewedNowAt: string,
  questionsReviewedAt: string | undefined,
): string {
  return applicantReviewIsCurrent(reviewedNowAt, questionsReviewedAt)
    ? reviewedNowAt
    : (questionsReviewedAt ?? reviewedNowAt);
}
