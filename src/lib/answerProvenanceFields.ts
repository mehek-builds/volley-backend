/* ---- the two kinds of provenance, and the rule that keys each one ----
 *
 * PR 496 shipped `answer_option_source` dropped at one site of three. PR 503 root-caused why that
 * kept happening and fixed it with the distinction below rather than with another list. This branch
 * adds two fields and classifies them rather than re-deriving anything.
 *
 * AN APPLICANT-CLAIM asserts something about the RECORD and about what the applicant did with it:
 * "she read this exact text and let it stand". A rename, a stale review round or a re-issued id can
 * falsify that without the answer changing at all, so it is keyed on record identity
 * (exactReviewedIdentityUnchanged) and drops the moment that identity moves.
 *
 * AN ANSWER-CLAIM asserts something about the ANSWER: "this value was snapped for profile value X",
 * "this value was accepted under a standing permission granted at T". Only replacing the answer can
 * falsify it, so it is keyed on `answerUnchanged` and survives exactly as long as the answer does,
 * byte for byte. Keying one of these on record identity is the PR 503 defect: an untouched Save
 * posts back a machine-resolved answer with no answer_source at all, record identity fails, and a
 * claim that was still perfectly true is discarded.
 *
 * THE CONSENT FIELDS ARE ANSWER-CLAIMS, and that classification is what closes the hole they were
 * blocked for: when the applicant edits a consent to "I do not agree" the answer changed, so the
 * acceptance grant drops with it. No strip site had to remember them.
 *
 * The two lists partition AnswerProvenanceField exactly, checked at compile time below, so a field
 * added without being classified does not build.
 *
 * ---- WHY THIS IS ITS OWN MODULE, WITH NOTHING ABOVE IT ----
 *
 * These lists were declared in applicationReview.ts, next to the question type they describe, and
 * that is the natural place for them right up until a second module needs to strip by them. The
 * one that does is questionDiscovery.ts, and it cannot import applicationReview.ts for a value:
 * applicationReview.ts imports portalSubmission.ts, which imports questionDiscovery.ts, so the
 * import would close a require cycle through the largest module in the tree.
 *
 * The alternative was for questionDiscovery.ts to keep its own hand-written copy of the field
 * names, which is exactly the arrangement that shipped `answer_approved_at` surviving onto an
 * answer the refresh had just replaced: the copy in applicationReview.ts was updated and the copy
 * in questionDiscovery.ts was not, and no compiler saw a difference between them. A leaf module
 * with no imports of its own can be read by both, so there is one list and the partition guard
 * below governs every site that strips.
 */
export type AnswerProvenanceField =
  | 'answer_source'
  | 'answer_reviewed_at'
  | 'answer_approved_at'
  | 'answer_option_source'
  | 'consent_permission_granted_at'
  | 'consent_permission_version';

/** Keyed on RECORD IDENTITY. Falsified by a rename or a stale review round. */
export const APPLICANT_CLAIM_FIELDS = ['answer_source', 'answer_reviewed_at', 'answer_approved_at'] as const;
/** Keyed on THE ANSWER. Falsified only by replacing the answer. */
export const ANSWER_CLAIM_FIELDS = [
  'answer_option_source',
  'consent_permission_granted_at',
  'consent_permission_version',
] as const;

/* EVERY PROVENANCE FIELD, for the sites that strip regardless of class.
 *
 * A branch that REPLACES the answer falsifies both kinds at once: the value the answer-claims
 * describe is gone, and so is the record identity the applicant-claims are keyed to. Such a branch
 * has no classification to make and no list to maintain, so it strips this and cannot be the site
 * that forgets a field. Derived from the two lists rather than written out a third time, because
 * writing it out a third time is the bug this exists to prevent.
 */
export const ANSWER_PROVENANCE_FIELDS = [
  ...APPLICANT_CLAIM_FIELDS,
  ...ANSWER_CLAIM_FIELDS,
] as const satisfies readonly AnswerProvenanceField[];

/* The partition, enforced by the compiler rather than by a reviewer.
 *
 * Written as a call rather than an assignment so the error NAMES the offending field: leaving
 * `answer_translated_from` out of both lists fails with `Argument of type 'true' is not assignable
 * to parameter of type '"answer_translated_from"'`, which tells the next person what to do. An
 * assignment to `never` compiles to "Type 'true' is not assignable to type 'never'", which does not.
 *
 * Being in BOTH lists is caught the same way, from the other direction: a field keyed two ways is
 * keyed by whichever branch runs first, which is not a decision anybody made. */
type Classified = (typeof APPLICANT_CLAIM_FIELDS)[number] | (typeof ANSWER_CLAIM_FIELDS)[number];
type Unclassified =
  | Exclude<AnswerProvenanceField, Classified>
  | Exclude<Classified, AnswerProvenanceField>
  | ((typeof APPLICANT_CLAIM_FIELDS)[number] & (typeof ANSWER_CLAIM_FIELDS)[number]);
function assertEveryProvenanceFieldIsClassifiedExactlyOnce(
  _classified: [Unclassified] extends [never] ? true : Unclassified,
): void { void _classified; }
assertEveryProvenanceFieldIsClassifiedExactlyOnce(true);
