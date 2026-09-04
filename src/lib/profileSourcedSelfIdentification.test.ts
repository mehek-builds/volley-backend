import assert from 'node:assert/strict';
import test from 'node:test';

import {
  refreshKnownQuestionAnswers,
  reviewQuestionRequiresAttention,
  selfIdentificationAnswerStatesProfileValue,
  sensitiveQuestionRequiresAttention,
} from './questionDiscovery';
import { reopenUnfitClosedChoiceQuestions } from './questionMetadata';
import type { ApplicationReviewQuestion } from './applicationReview';

/* THE QUESTION THAT DID NOT NEED HER, AND THE ONE THAT STILL DOES.
 *
 * Packet 4a79eec1 (Hudson River Trading, greenhouse), ready_for_final_approval. The submission
 * envelope reported two questions as requiring her confirmation:
 *
 *   "will you now, or in the future, require visa sponsorship to legally work in the country
 *    specified for this position?"
 *   "what is your gender?"
 *
 * The second is in her profile. eeo_prefs holds gender "Female"; the Greenhouse control offers
 * "Woman / Man / Non-binary / I don't wish to answer"; resolution snapped one onto the other and the
 * fill committed "Woman" on the employer's own page with no error. The only thing that was ever in
 * doubt was the SPELLING, and the R-004 gate read a spelling difference as an unvouched-for answer.
 *
 * THE OWNER'S RULE, and this file is written to it: an answer that came from her saved profile does
 * not need a second per-application approval. She supplied that profile deliberately, once, and that
 * IS her declaration. What must still refuse is the machine inventing a legal answer her profile
 * does not cover, which is the actual R-004 incident.
 *
 * WHAT IS NOT TOUCHED HERE. The sponsorship refusal stays exactly as it is: HRT's posting names
 * three countries, workEligibilityAnswer refuses a multi-country label by design, and clearing it is
 * volley PR 911's job through the country she herself indicated on the same form. The tests below
 * pin that it is still refused by this change, so the two can be told apart.
 */

/** Her real stored record, from the owner account. eeo_prefs is what the resolver reads. */
const HER_PROFILE = {
  citizenship: 'India',
  eeo_prefs: {
    gender: 'Female',
    veteran_status: 'No',
    disability_status: 'No',
  },
  work_eligibility_by_country: [{
    country_code: 'US',
    authorized_now: true,
    needs_sponsorship_now: false,
    needs_sponsorship_future: true,
    authorization_type: 'F-1 CPT/OPT',
  }],
} as unknown as Parameters<typeof sensitiveQuestionRequiresAttention>[3];

/** The same account with the gender preference never stated. Everything else identical. */
const PROFILE_WITHOUT_GENDER = {
  ...(HER_PROFILE as unknown as Record<string, unknown>),
  eeo_prefs: { veteran_status: 'No', disability_status: 'No' },
} as unknown as Parameters<typeof sensitiveQuestionRequiresAttention>[3];

/** The employer's own wording, byte for byte off the packet. */
const GENDER_LABEL = 'what is your gender?';
const SPONSORSHIP_LABEL =
  'will you now, or in the future, require visa sponsorship to legally work in the country specified for this position?';

/** The control's own list, measured live on the packet. Her profile spelling is not on it. */
const GENDER_OPTIONS = ['Woman', 'Man', 'Non-binary', "I don't wish to answer"];

function gate(
  question: { question: string; answer: string; answer_confirmed_of?: unknown },
  profile = HER_PROFILE,
): boolean {
  return reviewQuestionRequiresAttention(question, profile, undefined, undefined, undefined);
}

/**
 * The packet's gender record as the fill left it: the employer's option as the answer, her profile
 * spelling recorded as what it was snapped from.
 */
function genderQuestion(overrides: Partial<ApplicationReviewQuestion> = {}): ApplicationReviewQuestion {
  return {
    id: 'gender',
    question: GENDER_LABEL,
    answer: 'Woman',
    kind: 'required',
    required: true,
    portal_selector: '#gender',
    portal_input_type: 'select',
    options: GENDER_OPTIONS,
    answer_option_source: 'Female',
    ...overrides,
  } as ApplicationReviewQuestion;
}

/* ---- the defect ---- */

test('her profile gender, in the employer\'s own spelling, no longer needs her', () => {
  /* Stated first and separately: the resolver really does answer this label from her profile, and it
   * really does answer it in HER spelling. Without both, a later test passing would prove nothing. */
  assert.equal(gate({ question: GENDER_LABEL, answer: 'Female' }), false,
    'the profile spelling was always accepted, which is what makes the next line the whole defect');
  assert.equal(gate({ question: GENDER_LABEL, answer: 'Woman' }), false,
    'and so is the only spelling this control can actually hold');
});

test('the send gate and the refresh now agree about the same record', () => {
  /* THE DRIFT THIS FIXES, as two readers of one row rather than as an abstraction.
   * refreshKnownQuestionAnswers has kept a snapped demographic answer since the Verkada fix; the
   * gate was never told and reported the same row as needing her. Both are asked here, in order, so
   * a change that satisfies one and not the other fails. */
  const [refreshed] = refreshKnownQuestionAnswers([genderQuestion()], HER_PROFILE, undefined);
  assert.equal(refreshed.answer, 'Woman',
    'the refresh keeps the employer\'s spelling rather than overwriting it with hers');
  assert.equal(gate(refreshed), false, 'and the gate reads the very record the refresh produced');
});

test('the answer the refresh keeps is the answer the control can hold', () => {
  /* The other half of "no click from her": an answer that survives the refresh and is then blanked
   * by the closed-choice re-open is a required blank, which refuses for a different reason and would
   * make this fix look like it worked. Both passes, in the order the packet audit runs them. */
  const settled = reopenUnfitClosedChoiceQuestions(
    refreshKnownQuestionAnswers([genderQuestion()], HER_PROFILE, undefined),
  );
  assert.equal(settled[0].answer, 'Woman', 'still answered after the unfit-choice pass');
  assert.equal(gate(settled[0]), false, 'and still hers');
});

test('the refresh keeps a respelled answer and replaces one that says something else', () => {
  /* THE OTHER READER OF THE SHARED RULE, and the half that had no test before this change.
   *
   * refreshKnownQuestionAnswers keeps a demographic answer written in the control's vocabulary on
   * two conditions: the snap is still current (answer_option_source equals what the profile
   * resolves to now) AND the stored string still states what the profile states. Only the first was
   * covered. Dropping the second is a one-line change that keeps ANY answer carrying a current
   * derivation, so a record reading "Man" beside a snap from "Female" would survive the refresh and
   * be typed onto a live employer form as her self-identification.
   *
   * Both directions asserted, because keeping everything and keeping nothing are both wrong. */
  const snapped = { ...genderQuestion(), answer_source: undefined, answer_reviewed_at: undefined } as ApplicationReviewQuestion;
  assert.equal(
    refreshKnownQuestionAnswers([snapped], HER_PROFILE, undefined)[0].answer,
    'Woman',
    'her own declaration in the control\'s wording survives, which is what the branch is for',
  );
  const contradicting = { ...snapped, answer: 'Man' } as ApplicationReviewQuestion;
  assert.equal(
    refreshKnownQuestionAnswers([contradicting], HER_PROFILE, undefined)[0].answer,
    'Female',
    'and a value her profile does not state is recomputed away rather than preserved by the snap',
  );
});

/* ---- a machine answer must still be unable to make a declaration ---- */

test('a gender the profile never stated is still refused', () => {
  /* THE R-004 FAILURE MODE ITSELF. An unset preference resolves to "Decline to self-identify", and a
   * decline does not state a claim, so "Woman" on this profile is the machine inventing a
   * self-identification. It stays refused whatever the record says about where it came from. */
  assert.equal(gate({ question: GENDER_LABEL, answer: 'Woman' }, PROFILE_WITHOUT_GENDER), true);
  assert.equal(
    reviewQuestionRequiresAttention(
      genderQuestion(), PROFILE_WITHOUT_GENDER, undefined, undefined, undefined,
    ),
    true,
    'and a recorded snap on the record does not help: the profile is what is read, not the record',
  );
});

test('an answer that contradicts the profile is refused however the record is decorated', () => {
  /* THE DISCRIMINATOR IS RECOMPUTED, NEVER ASSERTED. This record wears every provenance field the
   * codebase has - the applicant claim, the option derivation, a review round - and says "Man" for a
   * profile that says "Female". A rule keyed on any of those fields passes it; this one cannot,
   * because it compares against her profile as read on this call. */
  const forged = genderQuestion({
    answer: 'Man',
    answer_source: 'applicant_review',
    answer_reviewed_at: '2026-09-03T00:00:00.000Z',
    answer_option_source: 'Female',
  });
  assert.equal(gate(forged), true);
});

test('a refusal is not her claim and her claim is not a refusal', () => {
  /* selfIdentificationAnswerStates' own rule, asked through the gate because that is where getting
   * it backwards would send a declaration she never made. */
  assert.equal(gate({ question: GENDER_LABEL, answer: "I don't wish to answer" }), true,
    'her profile states a gender, so a decline is not what it says');
  assert.equal(
    gate({ question: GENDER_LABEL, answer: "I don't wish to answer" }, PROFILE_WITHOUT_GENDER),
    false,
    'and with nothing stated the decline IS what the profile says, which is the Verkada shape',
  );
});

test('a profile that has moved stops clearing the old answer', () => {
  const corrected = {
    ...(HER_PROFILE as unknown as Record<string, unknown>),
    eeo_prefs: { gender: 'Non-binary' },
  } as unknown as Parameters<typeof sensitiveQuestionRequiresAttention>[3];
  assert.equal(gate(genderQuestion(), corrected), true,
    'nothing is cached, so correcting the profile refuses the stale answer on the very next read');
});

test('a stored yes/no self-identification is answered by the option that states it', () => {
  /* The veteran and disability family, whose profile value is a polarity and whose controls are
   * sentences. Measured wordings from Verkada, already pinned in selfIdentification.test.ts. */
  const label = 'are you a protected veteran?';
  assert.equal(gate({ question: label, answer: 'I am not a protected veteran' }), false);
  assert.equal(gate({ question: label, answer: 'I identify as one or more of the classifications of a protected veteran' }), true,
    'the opposite claim is not what "No" states');
});

/* ---- nothing else moves ---- */

test('the sponsorship declaration is still refused by this change', () => {
  /* NOT THIS FIX'S TO CLEAR, and pinned so the two are never confused. The resolver answers a
   * skipReason for a multi-country work-eligibility label, so there is no profile value to state and
   * this rule is inert. PR 911 clears it through the office location she herself indicated. */
  assert.equal(gate({ question: SPONSORSHIP_LABEL, answer: 'Yes' }), true);
  assert.equal(
    selfIdentificationAnswerStatesProfileValue(SPONSORSHIP_LABEL, 'Yes', 'Yes'),
    false,
    'the rule refuses the subject outright rather than by failing a comparison',
  );
});

test('a never-fill label is refused whatever the profile says', () => {
  assert.equal(gate({ question: 'Social Security Number', answer: '000-00-0000' }), true);
});

test('a question that is not sensitive is not made sensitive', () => {
  assert.equal(gate({ question: 'What is your preferred start date?', answer: 'June 2026' }), false);
});

test('a blank self-identification answer is not a declaration', () => {
  assert.equal(gate(genderQuestion({ answer: '' })), true,
    'there is nothing to compare, and a blank required answer is a different refusal');
});

/* ---- the confirmation route PR 906 opened is untouched ---- */

test('her explicit confirmation still clears a question the profile cannot answer', () => {
  assert.equal(
    gate({ question: SPONSORSHIP_LABEL, answer: 'Yes', answer_confirmed_of: SPONSORSHIP_LABEL }),
    false,
  );
});
