import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANSWER_CLAIM_FIELDS,
  APPLICANT_CLAIM_FIELDS,
  mergeSubmittedApplicationReviewQuestions,
  type ApplicationReviewQuestion,
} from './applicationReview';

/* THE CLASSIFICATION, TESTED AS A CLASSIFICATION.
 *
 * Three provenance fields have been mis-keyed in this one function across three PRs, so the thing
 * worth pinning is not "these five names are handled" - a list goes stale the moment a sixth field
 * is added - but the RULE that decides how any field is keyed:
 *
 *   an APPLICANT-CLAIM asserts what the applicant did with this record, so a change of record
 *   identity falsifies it;
 *   an ANSWER-CLAIM asserts something about the answer, so only replacing the answer falsifies it.
 *
 * Every assertion below iterates the exported lists rather than naming fields, so a newly added
 * field is tested the moment it is classified, and a field classified the wrong way fails here.
 * A field left UNCLASSIFIED does not reach this file at all: it fails `npm run typecheck` on the
 * partition guard in applicationReview.ts, which is the stronger half of the guarantee.
 */

const REVIEWED_AT = '2026-08-12T10:00:00.000Z';

/** Every provenance field set, so one fixture exercises both classes at once. */
function storedQuestion(overrides: Partial<ApplicationReviewQuestion> = {}): ApplicationReviewQuestion {
  return {
    id: 'q1',
    question: 'Privacy Statement',
    answer: 'I agree',
    kind: 'required',
    required: true,
    answer_source: 'applicant_review',
    answer_reviewed_at: REVIEWED_AT,
    answer_option_source: 'Yes',
    answer_override_of: 'Yes',
    consent_permission_version: 'privacy_and_terms@2026-08-12',
    consent_permission_granted_at: '2026-08-12T09:15:00.000Z',
    ...overrides,
  };
}

function submitted(answer: string, overrides: Partial<ApplicationReviewQuestion> = {}): ApplicationReviewQuestion {
  return { id: 'q1', question: 'Privacy Statement', answer, kind: 'required', required: true, ...overrides };
}

describe('answer-claims are keyed on the answer', () => {
  test('they survive a save that did not change the answer', () => {
    /* The PR 503 defect, generalised. An untouched review screen posts back the answer alone, with
     * every provenance key stripped by questionSchema. A claim about the ANSWER is still true, and
     * dropping it here is what let refreshKnownQuestionAnswers replace a resolved option with the
     * raw profile value on a save that changed nothing. */
    const [merged] = mergeSubmittedApplicationReviewQuestions(
      [storedQuestion()],
      [submitted('I agree')],
      'some-other-review-round',
    ) as ApplicationReviewQuestion[];
    for (const field of ANSWER_CLAIM_FIELDS) {
      assert.notEqual(merged[field], undefined, `${field} is an answer-claim and the answer did not change`);
    }
  });

  test('they drop the moment the answer is replaced', () => {
    /* And this is what closes the consent hole: editing a consent to "I do not agree" changes the
     * answer, so the record stops claiming it was accepted under a machine permission. No strip site
     * had to remember the consent fields; the rule covers them. */
    const [merged] = mergeSubmittedApplicationReviewQuestions(
      [storedQuestion()],
      [submitted('I do not agree')],
      REVIEWED_AT,
    ) as ApplicationReviewQuestion[];
    assert.equal(merged.answer, 'I do not agree');
    /* `answer_override_of` is the one answer-claim a replacement CREATES rather than falsifies, so
     * "absent" is the wrong test for it and it is asserted on its own line below. It is still keyed
     * on the answer and still cannot go stale: the stored 'Yes' is gone, and what stands beside the
     * new answer is the value this request actually typed over. A second edit replaces it again by
     * the same rule. Filtering by name here rather than dropping the loop keeps every other field
     * covered the moment it is classified, which is what this file is for. */
    for (const field of ANSWER_CLAIM_FIELDS.filter((name) => name !== 'answer_override_of')) {
      assert.equal(merged[field], undefined, `${field} is an answer-claim and the answer changed`);
    }
    /* 'Yes' rather than 'I agree' because the fixture already carries an override: resolution said
     * "Yes", she wrote "I agree" over it, and she is now writing "I do not agree" over that. What the
     * chain disagrees with is still "Yes", and it is the only value in it whose currency the refresh
     * can check against the profile. See overriddenResolverValue. */
    assert.equal(merged.answer_override_of, 'Yes',
      'the resolver value the chain overrode, carried forward rather than restarted at her own answer');
  });

  test('a refusal never keeps an acceptance grant, stated as the case it was blocked for', () => {
    const [merged] = mergeSubmittedApplicationReviewQuestions(
      [storedQuestion()],
      [submitted('I do not agree')],
      REVIEWED_AT,
      undefined,
      // She refused at the moment the epoch opened: this packet's first review.
      REVIEWED_AT,
    ) as ApplicationReviewQuestion[];
    assert.equal(merged.consent_permission_version, undefined);
    assert.equal(merged.consent_permission_granted_at, undefined);
    /* AND SAYS WHOSE REFUSAL IT IS. This asserted `undefined` while minting an applicant claim was
     * restricted to filling a blank, which made every edit of a resolved answer unrecordable and
     * therefore unsendable - see applicantSuppliedAnswer. The grant fields above are what this test
     * exists for and they still drop; the refusal itself is hers, she typed it over an acceptance,
     * and a record that says so is the honest one. 'consent_permission' would be the wrong value
     * here: no machine permission produced "I do not agree". */
    assert.equal(merged.answer_source, 'applicant_review');
    assert.equal(merged.answer_reviewed_at, REVIEWED_AT);
  });
});

describe('applicant-claims are keyed on record identity', () => {
  test('they drop when the review round does not match, even with the answer untouched', () => {
    const [merged] = mergeSubmittedApplicationReviewQuestions(
      [storedQuestion()],
      [submitted('I agree')],
      'some-other-review-round',
    ) as ApplicationReviewQuestion[];
    for (const field of APPLICANT_CLAIM_FIELDS) {
      assert.equal(merged[field], undefined, `${field} is an applicant-claim and the review round moved`);
    }
  });

  test('they survive only the exact reviewed identity', () => {
    const [merged] = mergeSubmittedApplicationReviewQuestions(
      [storedQuestion()],
      [submitted('I agree')],
      REVIEWED_AT,
    ) as ApplicationReviewQuestion[];
    for (const field of APPLICANT_CLAIM_FIELDS) {
      assert.notEqual(merged[field], undefined, `${field} survives an unchanged reviewed identity`);
    }
  });

  test('a renamed question cannot inherit them', () => {
    const [merged] = mergeSubmittedApplicationReviewQuestions(
      [storedQuestion()],
      [submitted('I agree', { question: 'Privacy  Statement' })],
      REVIEWED_AT,
    ) as ApplicationReviewQuestion[];
    for (const field of APPLICANT_CLAIM_FIELDS) {
      assert.equal(merged[field], undefined, `${field} must not survive a rename`);
    }
  });
});

describe('the branch that replaces nothing keeps every answer-claim', () => {
  test('a stored question no submit body mentioned keeps them', () => {
    /* The no-match branch. It does not replace the answer, so an answer-claim on it is still true.
     * Stripping here "to be thorough" is precisely the PR 496 defect PR 503 root-caused, and adding
     * the consent fields to that strip would have re-introduced it in a new place. */
    const [merged] = mergeSubmittedApplicationReviewQuestions(
      [storedQuestion()],
      [],
      REVIEWED_AT,
    ) as ApplicationReviewQuestion[];
    assert.equal(merged.answer, 'I agree');
    for (const field of ANSWER_CLAIM_FIELDS) {
      assert.notEqual(merged[field], undefined, `${field} survives a branch that replaces nothing`);
    }
    for (const field of APPLICANT_CLAIM_FIELDS) {
      assert.equal(merged[field], undefined, `${field} is a claim about a review that did not happen`);
    }
  });

  test('a submit-only question brings no provenance of either class', () => {
    const merged = mergeSubmittedApplicationReviewQuestions(
      [],
      [{ ...storedQuestion(), question: 'Interview Code of Conduct' }],
      REVIEWED_AT,
    ) as ApplicationReviewQuestion[];
    for (const field of [...ANSWER_CLAIM_FIELDS, ...APPLICANT_CLAIM_FIELDS]) {
      assert.equal(merged[0][field], undefined, `${field} must not be assertable by a caller`);
    }
  });
});

describe('the classification itself', () => {
  test('the two classes are disjoint and neither is empty', () => {
    const overlap = APPLICANT_CLAIM_FIELDS.filter((field) => (ANSWER_CLAIM_FIELDS as readonly string[]).includes(field));
    assert.deepEqual(overlap, [], 'a field cannot be keyed two ways');
    assert.ok(APPLICANT_CLAIM_FIELDS.length > 0);
    assert.ok(ANSWER_CLAIM_FIELDS.length > 0);
  });

  test('the consent grant is classified as an answer-claim', () => {
    // Stated explicitly, because this is the classification the block was about. It asserts
    // something about the ANSWER, so it lives and dies with the answer.
    for (const field of ['consent_permission_version', 'consent_permission_granted_at']) {
      assert.ok(
        (ANSWER_CLAIM_FIELDS as readonly string[]).includes(field),
        `${field} asserts something about the answer, not about what the applicant did`,
      );
    }
  });
});
