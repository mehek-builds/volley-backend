import assert from 'node:assert/strict';
import test from 'node:test';

import {
  answerCarriesCurrentApplicantReview,
  resolveKnownAnswer,
  sensitiveQuestionRequiresAttention,
} from './questionDiscovery';

/* THE SEND GATE THAT NO ANSWER COULD SATISFY.
 *
 * Measured live on 2026-09-03, Exa "Software Engineer, Intern" packet 73768339 (ashby), account
 * mehekmandal05@gmail.com. The packet sat in ready_for_final_approval with every question answered
 * and the resume attached, and POST /applications/:id/submission/approve returned 422
 * FINAL_APPROVAL_VERIFICATION_FAILED with one issue:
 *
 *   "Sensitive question requires your attention: do you require visa sponsorship to work in your
 *    selected location? if so, which one? and when does your visa expire?"
 *
 * The dashboard rendered that sentence and offered no control that could clear it. It could not:
 * resolveKnownAnswer DECLINES this label by design - R-004 refuses to let the product declare
 * anyone's work eligibility - so there was no `value` to compare an answer against, and the old
 * expression
 *
 *   return !(known && 'value' in known && comparableAnswer(known.value) === comparableAnswer(answer))
 *
 * returned true for EVERY possible answer. Measured: her own reviewed paragraph -> true, and a bare
 * "Yes" -> true. The application was permanently unsendable, and so was every other packet carrying
 * a free-text work-eligibility question.
 *
 * The fix reads a declined resolve as what it says: the question is left FOR HER. Her own
 * current-round review is the attention the gate asks for. An answer the product computed is not.
 */

/** Her stored eligibility record, read live from GET /profile/application on 2026-09-03. */
const PROFILE = {
  citizenship: 'India',
  address_country: 'United States',
  work_authorized: true,
  needs_sponsorship: true,
  work_eligibility_by_country: [{
    country_code: 'US',
    authorized_now: true,
    needs_sponsorship_now: false,
    needs_sponsorship_future: true,
    authorization_type: 'F-1 CPT/OPT',
  }],
} as unknown as Parameters<typeof sensitiveQuestionRequiresAttention>[3];

const VISA_LABEL =
  'do you require visa sponsorship to work in your selected location? if so, which one? and when does your visa expire?';

/* Her answer as stored on the packet, answer_source applicant_review, answer_reviewed_at equal to
 * the packet's questions_reviewed_at. Every clause of it is a field of the record above, which is
 * the point: the product's own richest representation of her eligibility cannot be expressed as the
 * yes/no scalar the resolver would collapse it to. */
const VISA_ANSWER =
  'I am authorized to work in the US on F-1 status (CPT/OPT), so I do not require sponsorship for an '
  + 'internship. I would require sponsorship for full-time employment in the future. My work '
  + 'authorization expires 05/2031.';

function requiresAttention(answer: string, applicantReviewed: boolean, label = VISA_LABEL): boolean {
  return sensitiveQuestionRequiresAttention(label, answer, 'text', PROFILE, undefined, undefined, 'US', applicantReviewed);
}

test('the resolver declines the compound visa question, which is what makes the gate unsatisfiable', () => {
  const known = resolveKnownAnswer(VISA_LABEL, 'text', PROFILE, undefined, undefined, 'US');
  assert.ok(known && 'skipReason' in known, 'R-004 must keep declining to declare her work eligibility');
});

test('an unreviewed answer still requires attention, exactly as before the fix', () => {
  assert.equal(requiresAttention(VISA_ANSWER, false), true);
  // The measurement that proved no answer could pass: even the resolver-shaped scalar failed.
  assert.equal(requiresAttention('Yes', false), true);
  assert.equal(requiresAttention('No', false), true);
});

test('her own current-round review is the attention the gate asks for', () => {
  assert.equal(requiresAttention(VISA_ANSWER, true), false, 'the Exa send was blocked on exactly this');
});

test('a review never clears a never-fill question', () => {
  /* SSN, driver's licence, captcha and recording consent are absolute. They are refused above the
   * declined-resolver branch, so a review cannot reach them and must not clear them. */
  for (const label of [
    'social security number',
    "driver's license number",
    'please complete the captcha',
  ]) {
    assert.equal(requiresAttention('123-45-6789', true, label), true, `${label} stays refused`);
    assert.equal(requiresAttention('123-45-6789', false, label), true, `${label} stays refused`);
  }
});

test('a review NEVER overrides an answer the resolver can check - the R-004 guard', () => {
  /* THE LINE AN EARLIER CUT OF THIS CHANGE CROSSED, pinned so it cannot be crossed again.
   *
   * That cut hoisted the review check above the resolver comparison, on the theory that a review
   * is a review whichever branch it lands in. It is not. The comparison branch is the only place
   * a sensitive answer is ever checked against what her profile actually says, and removing it let
   * a stored contradiction through on the strength of a claim that the product itself can mint in
   * bulk. R-004 is what that looks like in production: a false legal declaration, sent.
   *
   * Asserted unconditionally rather than under `if (known && 'value' in known)`, so this cannot
   * quietly stop testing anything the day EEO resolution changes shape. */
  const ETHNICITY = 'are you hispanic/latino? hispanic_ethnicity';
  const known = resolveKnownAnswer(ETHNICITY, 'text', PROFILE, undefined, undefined, 'US');
  assert.ok(known && 'value' in known, 'an EEO label resolves to a value, not a skipReason');

  // Matching the resolver clears it, review or no review - unchanged behaviour.
  assert.equal(requiresAttention(known.value, false, ETHNICITY), false);
  assert.equal(requiresAttention(known.value, true, ETHNICITY), false);
  // Contradicting it is refused EVEN with a current-round review.
  assert.equal(requiresAttention('Yes', false, ETHNICITY), true);
  assert.equal(requiresAttention('Yes', true, ETHNICITY), true, 'a review must not override the profile');
});

test('a reviewed work-authorization contradiction is still refused', () => {
  /* The concrete R-004 shape: the profile says she is not authorized, the packet says she is. */
  const UNAUTHORIZED = {
    ...(PROFILE as Record<string, unknown>),
    work_authorized: false,
    needs_sponsorship: true,
    work_eligibility_by_country: [{
      country_code: 'US', authorized_now: false, needs_sponsorship_now: true, needs_sponsorship_future: true,
    }],
  } as unknown as Parameters<typeof sensitiveQuestionRequiresAttention>[3];

  const LABEL = 'are you legally authorized to work in the united states?';
  const known = resolveKnownAnswer(LABEL, 'text', UNAUTHORIZED, undefined, undefined, 'US');
  if (known && 'value' in known) {
    assert.equal(
      sensitiveQuestionRequiresAttention(LABEL, 'Yes', 'text', UNAUTHORIZED, undefined, undefined, 'US', true),
      true,
      'a current-round review must not send a work-authorization claim the profile contradicts',
    );
  } else {
    // The resolver declined instead, so the escape hatch is reachable - that is the visa case, and
    // it is covered above. Either way this label must never pass unreviewed.
    assert.equal(
      sensitiveQuestionRequiresAttention(LABEL, 'Yes', 'text', UNAUTHORIZED, undefined, undefined, 'US', false),
      true,
    );
  }
});

test('the provenance half is the canonical predicate, whitespace and all', () => {
  /* answerCarriesCurrentApplicantReview composes applicantChoseStoredAnswer rather than
   * re-writing it. That helper trims answer_source; a hand-written copy here would not, and the
   * two would disagree about the same record - the split-brain applicantAnswer.ts exists to end. */
  const ROUND = '2026-09-02T12:23:29.281Z';
  assert.equal(
    answerCarriesCurrentApplicantReview(
      { answer: VISA_ANSWER, answer_source: '  applicant_review  ', answer_reviewed_at: ROUND },
      ROUND,
    ),
    true,
  );
});

test('a review only counts for the round it was made in', () => {
  const ROUND = '2026-09-02T12:23:29.281Z';
  const reviewed = { answer: VISA_ANSWER, answer_source: 'applicant_review', answer_reviewed_at: ROUND };

  assert.equal(answerCarriesCurrentApplicantReview(reviewed, ROUND), true);
  assert.equal(
    answerCarriesCurrentApplicantReview(reviewed, '2026-09-03T18:40:21.281Z'),
    false,
    'a review from an earlier round cannot stand in for one in this round',
  );
  // Every other way the signal can be absent is fail-closed.
  assert.equal(answerCarriesCurrentApplicantReview(reviewed, undefined), false);
  /* An EMPTY round is not a round. Comparing the two raw made '' equal '', so a packet that
   * somehow persisted an empty questions_reviewed_at would have read every answer on it as her
   * current-round review and opened this gate for answers nobody reviewed. */
  assert.equal(
    answerCarriesCurrentApplicantReview({ ...reviewed, answer_reviewed_at: '' }, ''),
    false,
    'an empty claim must not match an empty round',
  );
  assert.equal(answerCarriesCurrentApplicantReview({ ...reviewed, answer_reviewed_at: '  ' }, ROUND), false);
  assert.equal(
    answerCarriesCurrentApplicantReview({ ...reviewed, answer_source: 'profile' }, ROUND),
    false,
    'a value the product computed is not a review',
  );
  assert.equal(answerCarriesCurrentApplicantReview({ ...reviewed, answer: '   ' }, ROUND), false);
  assert.equal(answerCarriesCurrentApplicantReview({ ...reviewed, answer_reviewed_at: 1 }, ROUND), false);
});
