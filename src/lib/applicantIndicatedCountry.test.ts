import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applicantIndicatedWorkCountry,
  isApplicantWorkLocationIndicationQuestion,
} from './applicantIndicatedCountry';
import {
  knownAnswerLookup,
  refreshKnownQuestionAnswers,
  resolveKnownAnswer,
  reviewQuestionRequiresAttention,
  sensitiveQuestionRequiresAttention,
  type ApplicationProfileLike,
} from './questionDiscovery';
import { postingCountryCodeFromJobContext, postingCountryFromJobContext } from './jobLocation';

/* ONE PACKET THAT COULD NOT BE SENT, AND THE TWO ANSWERS ON IT THAT SETTLE WHY.
 *
 * Hudson River Trading packet 4a79eec1 (greenhouse), status ready_for_final_approval, 27 of 27
 * questions answered. Every press of Send returned 422 on this label:
 *
 *   "will you now, or in the future, require visa sponsorship to legally work in the country
 *    specified for this position?"
 *
 * HRT publishes the posting for Austin, Chicago, New York, London and Singapore. "The country
 * specified for this position" therefore names three countries and her position differs between
 * them, so workEligibilityAnswer refused the label, the gate's only test was false, and the send
 * refused forever. The refusal is correct on its own terms: R-004 is the logged incident where a
 * machine picked one country out of several and a false legal declaration reached an employer.
 *
 * The ambiguity is not real on THIS form, and she is the one who settled it. Verbatim from the
 * packet's stored questions:
 *
 *   "please select your top preferred hrt office location..."   ->  "New York"
 *   "if you equally prefer two office locations..."             ->  "Chicago"
 *   "will you now, or in the future, require visa sponsorship"  ->  "Yes"
 *
 * Two independent answers, both US cities, so her indicated country is unanimous without anything
 * being guessed for her. Her stored sponsorship answer is ALREADY "Yes", so what this change does
 * to the packet is CONFIRM her answer, never alter it - which is asserted directly below.
 */
const SPONSORSHIP_LABEL =
  'will you now, or in the future, require visa sponsorship to legally work in the country specified for this position?';
const TOP_OFFICE_LABEL =
  'please select your top preferred hrt office location. return offers will be specific to the office you have selected.';
const SECOND_OFFICE_LABEL =
  'if you equally prefer two office locations, please select your second choice here.';
/* A REAL NEAR MISS ON THIS VERY PACKET. A naive /prefer/ matcher takes this control, and it carries
 * "Mehek", which is not a place - so the packet she is trying to send would refuse for a new
 * reason. Pinned rather than assumed. */
const PREFERRED_NAME_LABEL = 'preferred first name preferred first name preferred_name';

/** Her stored eligibility, exactly as the profile holds it: one scoped record, for the US only. */
const APPLICANT: ApplicationProfileLike = {
  citizenship: 'India',
  work_authorized: true,
  needs_sponsorship: true,
  work_eligibility_by_country: [{
    country_code: 'US',
    authorized_now: true,
    needs_sponsorship_now: false,
    needs_sponsorship_future: true,
    authorization_type: 'F-1 CPT/OPT',
  }],
} as ApplicationProfileLike;

/** The posting's own five offices, which is what makes the label ambiguous in the first place. */
const HRT_JOB_CONTEXT = {
  company: 'Hudson River Trading',
  locations: ['Austin', 'Chicago', 'New York', 'London', 'Singapore'],
};

function hrtPacket(overrides: Array<{ question: string; answer: string }> = []) {
  return [
    { question: TOP_OFFICE_LABEL, answer: 'New York' },
    { question: SECOND_OFFICE_LABEL, answer: 'Chicago' },
    { question: PREFERRED_NAME_LABEL, answer: 'Mehek' },
    { question: SPONSORSHIP_LABEL, answer: 'Yes' },
    ...overrides,
  ];
}

function resolveOnPacket(
  packet: readonly { question: string; answer?: string }[],
  profile: ApplicationProfileLike = APPLICANT,
  jobContext: Record<string, unknown> = HRT_JOB_CONTEXT,
  label: string = SPONSORSHIP_LABEL,
) {
  return resolveKnownAnswer(
    label,
    'text',
    profile,
    undefined,
    postingCountryFromJobContext(jobContext),
    postingCountryCodeFromJobContext(jobContext),
    undefined,
    undefined,
    undefined,
    applicantIndicatedWorkCountry(packet)?.code,
  );
}

function sendGateBlocks(
  packet: readonly { question: string; answer?: string }[],
  profile: ApplicationProfileLike = APPLICANT,
  jobContext: Record<string, unknown> = HRT_JOB_CONTEXT,
  answer = 'Yes',
) {
  return sensitiveQuestionRequiresAttention(
    packet,
    SPONSORSHIP_LABEL,
    answer,
    'text',
    profile,
    undefined,
    postingCountryFromJobContext(jobContext),
    postingCountryCodeFromJobContext(jobContext),
  );
}

describe('the packet that could not be sent', () => {
  test('precondition: the posting itself names no single country, so the refusal was right', () => {
    assert.equal(postingCountryFromJobContext(HRT_JOB_CONTEXT), 'unknown');
    assert.equal(postingCountryCodeFromJobContext(HRT_JOB_CONTEXT), undefined);
    // With nothing of hers to read, the label is held exactly as it is on main today.
    const held = resolveOnPacket([]);
    assert.ok(held && 'skipReason' in held, JSON.stringify(held));
    assert.equal(sendGateBlocks([]), true, 'the refusal must survive for a packet with no indication');
  });

  test('her own two office answers resolve the country to the US', () => {
    assert.deepEqual(
      applicantIndicatedWorkCountry(hrtPacket()),
      { code: 'US', locations: ['New York', 'Chicago'] },
    );
  });

  /* THE ONE ASSERTION THIS WHOLE CHANGE HAS TO SATISFY. Her stored answer is "Yes". If the rule
   * produced anything else it would be REWRITING a legal declaration she made, which is the
   * opposite of the point, so the value and the stored answer are compared directly. */
  test('the sponsorship label answers Yes, which CONFIRMS her stored answer rather than altering it', () => {
    const resolved = resolveOnPacket(hrtPacket());
    assert.deepEqual(resolved, { value: 'Yes' });
    const stored = hrtPacket().find((question) => question.question === SPONSORSHIP_LABEL)!.answer;
    assert.equal(stored, 'Yes');
    assert.equal((resolved as { value: string }).value, stored, 'the rule must agree with her, not overwrite her');
  });

  test('"Yes" comes from needs_sponsorship_future, not from being authorized now', () => {
    /* She is authorized in the US NOW and needs no sponsorship YET, so a rule reading only the
     * present tense would answer "No" here and file a false declaration. The label says "now, or in
     * the future", and only needs_sponsorship_future makes it Yes. */
    const record = APPLICANT.work_eligibility_by_country![0];
    assert.equal(record.needs_sponsorship_now, false);
    assert.equal(record.needs_sponsorship_future, true);
    assert.deepEqual(resolveOnPacket(hrtPacket()), { value: 'Yes' });

    const noFutureNeed: ApplicationProfileLike = {
      ...APPLICANT,
      work_eligibility_by_country: [{ ...record, needs_sponsorship_future: false }],
    } as ApplicationProfileLike;
    assert.deepEqual(resolveOnPacket(hrtPacket(), noFutureNeed), { value: 'No' },
      'the answer must track the stored field, not be a constant');
  });

  test('the send gate stops refusing this packet, and still refuses a different answer', () => {
    assert.equal(sendGateBlocks(hrtPacket()), false, 'the 422 must be gone');
    // The gate accepts only the answer the profile actually supports. "No" is still a false
    // declaration and is still held, indicated country or not.
    assert.equal(sendGateBlocks(hrtPacket(), APPLICANT, HRT_JOB_CONTEXT, 'No'), true);
  });
});

describe('what must still refuse, because the ambiguity is real', () => {
  /* (a) TWO INDICATED LOCATIONS IN DIFFERENT COUNTRIES. */
  test('New York and London do not agree, so the refusal stands', () => {
    const split = hrtPacket().map((question) => (
      question.question === SECOND_OFFICE_LABEL ? { ...question, answer: 'London' } : question
    ));
    assert.equal(applicantIndicatedWorkCountry(split), undefined);
    const held = resolveOnPacket(split);
    assert.ok(held && 'skipReason' in held, JSON.stringify(held));
    assert.equal(sendGateBlocks(split), true);
  });

  test('unanimity is never a first choice and never a majority', () => {
    // Two US cities and one London: a majority rule would answer US. It must refuse.
    const majority = [
      { question: TOP_OFFICE_LABEL, answer: 'New York' },
      { question: SECOND_OFFICE_LABEL, answer: 'Chicago' },
      { question: 'which office location do you prefer for your third choice?', answer: 'London' },
    ];
    assert.equal(applicantIndicatedWorkCountry(majority), undefined);
    // And the FIRST answer being American is not enough either, whatever order they arrive in.
    assert.equal(applicantIndicatedWorkCountry([
      { question: TOP_OFFICE_LABEL, answer: 'New York' },
      { question: SECOND_OFFICE_LABEL, answer: 'Singapore' },
    ]), undefined);
  });

  /* (b) A COUNTRY WITH NO work_eligibility_by_country ENTRY. */
  test('a country she has no stored record for is refused, not approximated', () => {
    const londonOnly = [
      { question: TOP_OFFICE_LABEL, answer: 'London' },
      { question: SPONSORSHIP_LABEL, answer: 'Yes' },
    ];
    // The country resolves fine - it is her eligibility that is silent about it.
    assert.deepEqual(applicantIndicatedWorkCountry(londonOnly), { code: 'GB', locations: ['London'] });
    const held = resolveOnPacket(londonOnly);
    assert.ok(held && 'skipReason' in held, JSON.stringify(held));
    assert.equal(sendGateBlocks(londonOnly), true);
  });

  /* (c) THE TOP-LEVEL needs_sponsorship IS NEVER A FALLBACK.
   *
   * work_authorized and needs_sponsorship are ONE PAIR OF BOOLEANS FOR THE WHOLE WORLD. On a
   * posting spanning three countries they cannot be true of every country they cover, so reading
   * them for a country SHE named is exactly the flattening that produces a wrong legal answer. */
  test('an applicant-indicated country never falls back to the country-agnostic booleans', () => {
    const legacyOnly: ApplicationProfileLike = {
      citizenship: 'India',
      work_authorized: true,
      needs_sponsorship: true,
      work_eligibility_by_country: undefined,
    } as ApplicationProfileLike;
    // The scalars would say "Yes" loudly if consulted. They must not be consulted.
    assert.equal(legacyOnly.needs_sponsorship, true);
    const held = resolveOnPacket(hrtPacket(), legacyOnly);
    assert.ok(held && 'skipReason' in held, `must not answer from the global booleans: ${JSON.stringify(held)}`);
    assert.equal(sendGateBlocks(hrtPacket(), legacyOnly), true);

    // An EMPTY scoped list is the same refusal: still no record for the country she named.
    const emptyList = { ...legacyOnly, work_eligibility_by_country: [] } as ApplicationProfileLike;
    const alsoHeld = resolveOnPacket(hrtPacket(), emptyList);
    assert.ok(alsoHeld && 'skipReason' in alsoHeld, JSON.stringify(alsoHeld));

    // And a record for a DIFFERENT country than the one she indicated is not a substitute.
    const gbOnly = {
      ...legacyOnly,
      work_eligibility_by_country: [{
        country_code: 'GB',
        authorized_now: true,
        needs_sponsorship_now: false,
        needs_sponsorship_future: true,
      }],
    } as ApplicationProfileLike;
    const gbHeld = resolveOnPacket(hrtPacket(), gbOnly);
    assert.ok(gbHeld && 'skipReason' in gbHeld, JSON.stringify(gbHeld));
  });

  test('the posting-derived US bridge to the legacy booleans is untouched', () => {
    /* The bridge closed above is closed ONLY for a country she named. A posting that says the
     * United States outright still answers from the legacy scalars exactly as it does on main, and
     * that behaviour is what this assertion protects from an over-broad fix. */
    const legacyOnly: ApplicationProfileLike = {
      work_authorized: true, needs_sponsorship: true, work_eligibility_by_country: undefined,
    } as ApplicationProfileLike;
    const usPosting = { locations: ['New York, NY, United States'] };
    assert.equal(postingCountryCodeFromJobContext(usPosting), 'US');
    assert.deepEqual(resolveOnPacket([], legacyOnly, usPosting), { value: 'Yes' });
  });

  test('a posting that names one country outranks her preference, and a contradiction refuses', () => {
    // A single-country posting is the employer's own statement; nothing on the form moves it.
    const ukPosting = { locations: ['London, United Kingdom'] };
    assert.equal(postingCountryCodeFromJobContext(ukPosting), 'GB');
    const contradiction = [
      { question: TOP_OFFICE_LABEL, answer: 'New York' },
      { question: SPONSORSHIP_LABEL, answer: 'Yes' },
    ];
    // She has a US record and no GB one. If her New York answer could override the UK posting this
    // would answer "Yes" about a British job from an American record.
    const held = resolveOnPacket(contradiction, APPLICANT, ukPosting);
    assert.ok(held && 'skipReason' in held, JSON.stringify(held));
  });

  /* THE CONTRADICTION THAT ACTUALLY BITES, and the one the test above does NOT reach.
   *
   * Above, the posting is British and she has no British record, so the packet refuses whether or
   * not the contradiction guard exists - mutation testing showed deleting the guard left it green.
   * The dangerous direction is the opposite one: an AMERICAN posting she DOES have a record for,
   * beside an office answer naming London. Without the guard the posting wins, her US record
   * answers, and an application she believes is for London carries a declaration about the US. */
  test('an American posting beside a London office answer refuses instead of answering from the US record', () => {
    const usPosting = { locations: ['New York, NY, United States'] };
    assert.equal(postingCountryCodeFromJobContext(usPosting), 'US');
    // Precondition: with no indication at all this posting answers, so the refusal below is the
    // guard doing something and not the packet being unanswerable anyway.
    assert.deepEqual(resolveOnPacket([], APPLICANT, usPosting), { value: 'Yes' });

    const saysLondon = [
      { question: TOP_OFFICE_LABEL, answer: 'London' },
      { question: SPONSORSHIP_LABEL, answer: 'Yes' },
    ];
    const held = resolveOnPacket(saysLondon, APPLICANT, usPosting);
    assert.ok(held && 'skipReason' in held, `a contradiction must refuse, got ${JSON.stringify(held)}`);
  });

  test('the same contradiction refuses on the legal-scope US bridge, where no exact code exists', () => {
    /* The classifier can prove "this posting is American" without producing an exact ISO code, and
     * that bridge has its own guard. Exercised by calling the resolver directly with the two
     * independent inputs, since postingCountry and postingCountryCode are separate parameters. */
    const answered = resolveKnownAnswer(
      SPONSORSHIP_LABEL, 'text', APPLICANT, undefined, 'us', undefined, undefined, undefined, undefined, undefined,
    );
    assert.deepEqual(answered, { value: 'Yes' }, 'precondition: the us bridge answers on its own');

    const contradicted = resolveKnownAnswer(
      SPONSORSHIP_LABEL, 'text', APPLICANT, undefined, 'us', undefined, undefined, undefined, undefined, 'GB',
    );
    assert.ok(contradicted && 'skipReason' in contradicted, JSON.stringify(contradicted));
    // And an indication that AGREES with the bridge leaves it answering exactly as before.
    assert.deepEqual(
      resolveKnownAnswer(
        SPONSORSHIP_LABEL, 'text', APPLICANT, undefined, 'us', undefined, undefined, undefined, undefined, 'US',
      ),
      { value: 'Yes' },
    );
  });
});

describe('what counts as her indicating a country', () => {
  test('only an ANSWERED question indicates anything', () => {
    assert.equal(applicantIndicatedWorkCountry([{ question: TOP_OFFICE_LABEL, answer: '' }]), undefined);
    assert.equal(applicantIndicatedWorkCountry([{ question: TOP_OFFICE_LABEL }]), undefined);
    assert.equal(applicantIndicatedWorkCountry([{ question: TOP_OFFICE_LABEL, answer: '   ' }]), undefined);
    assert.equal(applicantIndicatedWorkCountry([]), undefined);
    assert.equal(applicantIndicatedWorkCountry(undefined), undefined);
    // A blank second choice beside an answered first is silence, not disagreement.
    assert.deepEqual(
      applicantIndicatedWorkCountry([
        { question: TOP_OFFICE_LABEL, answer: 'New York' },
        { question: SECOND_OFFICE_LABEL, answer: '' },
      ]),
      { code: 'US', locations: ['New York'] },
    );
  });

  /* "No" IS NOT NORWAY. Measured on this employer: HRT, 2026-09-01, "No" typed into a location
   * preference. Handed to the classifier bare it is the ISO code for Norway. It is refused here
   * rather than left to be caught by her having no Norway record, because which countries happen to
   * be absent from a profile is luck, not a safety rule. */
  test('a two-letter or yes/no answer is not a place, and refuses the whole indication', () => {
    for (const answer of ['No', 'no', 'Yes', 'N/A', 'n/a', 'none', 'TBD', 'any', 'unsure', 'No preference', '-']) {
      assert.equal(
        applicantIndicatedWorkCountry([{ question: TOP_OFFICE_LABEL, answer }]),
        undefined,
        `bare "${answer}" must indicate nothing`,
      );
    }
    // Including when it sits beside a real city: an answer we cannot read is not one we may ignore.
    assert.equal(applicantIndicatedWorkCountry([
      { question: TOP_OFFICE_LABEL, answer: 'New York' },
      { question: SECOND_OFFICE_LABEL, answer: 'No' },
    ]), undefined);
    // Bare country codes go the same way: "IN" is Indiana or India and two characters settle nothing.
    for (const answer of ['IN', 'IL', 'US', 'UK', 'DE']) {
      assert.equal(applicantIndicatedWorkCountry([{ question: TOP_OFFICE_LABEL, answer }]), undefined, answer);
    }
  });

  test('a place this codebase cannot pin to a country refuses rather than defaulting', () => {
    // Singapore and Melbourne are deliberately absent from the structured city table; "Remote" names
    // no country at all. None of them may fall back to the US.
    for (const answer of ['Singapore', 'Melbourne', 'Remote', 'Anywhere', 'Somewhereville']) {
      assert.equal(applicantIndicatedWorkCountry([{ question: TOP_OFFICE_LABEL, answer }]), undefined, answer);
    }
  });

  test('the matcher takes both real HRT location labels and neither identity control', () => {
    assert.equal(isApplicantWorkLocationIndicationQuestion(TOP_OFFICE_LABEL), true);
    assert.equal(isApplicantWorkLocationIndicationQuestion(SECOND_OFFICE_LABEL), true,
      'the second-choice label is where "Chicago" lives, and missing it is the dangerous direction');
    assert.equal(isApplicantWorkLocationIndicationQuestion(PREFERRED_NAME_LABEL), false);
    for (const label of [
      'preferred first name',
      'preferred name',
      'what are your preferred pronouns?',
      'preferred email address',
      'preferred phone number',
      'name pronunciation',
      /* A WELDED LABEL THAT CARRIES BOTH. This codebase already has scars from discovery welding
       * adjacent controls into one label ("first name* first name first_name"), so a name control
       * sitting next to a location control is the realistic collision - and it is the only one of
       * these that reaches the identity exclusion at all, the rest being refused earlier for
       * carrying no work-location noun. */
      'preferred name preferred location',
      'preferred office location contact name',
    ]) {
      assert.equal(isApplicantWorkLocationIndicationQuestion(label), false, label);
    }
  });

  /* HER FLAT IS NOT A ROLE LOCATION. This is the one over-match that could CREATE an indicated set
   * where she indicated nothing, rather than merely adding a member to one, so it is excluded by
   * name. A woman living in New York applying to a London-only role has told us nothing about which
   * office she wants by saying where she sleeps. */
  test('a question about where she LIVES never indicates the role country', () => {
    for (const label of [
      'where are you currently located?',
      'where are you based?',
      'what is your current location?',
      'country of residence',
      'current address',
      'home location',
      'are you currently residing in the united states?',
      'your permanent address',
      /* THE ONES THAT CARRY BOTH A LOCATION NOUN AND AN INDICATION VERB, which are the only ones
       * that actually exercise the exclusion. Mutation testing said so: with only the labels above,
       * deleting the whole residence rule left the suite green, because none of them reached it. */
      'which location are you currently based in?',
      'please select your current location',
      'which office are you currently based out of?',
      'select your country of residence',
      'what is your preferred mailing location?',
      'choose your preferred shipping location for equipment',
    ]) {
      assert.equal(isApplicantWorkLocationIndicationQuestion(label), false, label);
      assert.equal(applicantIndicatedWorkCountry([{ question: label, answer: 'New York' }]), undefined, label);
    }
  });

  /* WHERE SHE HAS WORKED IS NOT WHERE SHE WANTS TO WORK. Same shape of danger as the residence
   * exclusion: a history answer would CREATE an indicated set out of a question that was never
   * about this role, rather than merely adding a member to a real one. */
  test('an employment-history location question never indicates the role country', () => {
    for (const label of [
      'in which locations have you previously worked?',
      'please list the office locations where you have worked',
      'which of our offices have you worked at before?',
      'previous work location',
      'prior office location',
      'have you worked in this location before?',
    ]) {
      assert.equal(isApplicantWorkLocationIndicationQuestion(label), false, label);
      assert.equal(applicantIndicatedWorkCountry([{ question: label, answer: 'New York' }]), undefined, label);
    }
  });

  test('the ordinary office-choice wordings are read', () => {
    for (const label of [
      'which office location would you prefer?',
      'please rank your preferred office locations',
      'select your first choice office',
      'what is your desired work location?',
      'preferred job location',
      'please choose a campus location',
      'top location preference',
    ]) {
      assert.equal(isApplicantWorkLocationIndicationQuestion(label), true, label);
    }
  });
});

describe('the gate, the lookup and the refresh cannot disagree', () => {
  /* THE DEADLOCK THIS PREVENTS. refreshKnownQuestionAnswers BLANKS any answer to a question the
   * resolver holds. If the send gate learned she indicated New York but the refresh did not, the
   * gate would clear the packet and the very next save would delete the sponsorship answer it had
   * just cleared. All three read the same list, so all three see the same form. */
  /* THE OFFICE ANSWERS MUST CARRY HER REVIEW STAMP, AND THAT IS NOT A TEST DETAIL.
   *
   * A location preference is itself a REFUSED question - Litos cannot pick her office for her - so
   * the refresh blanks any answer to it that cannot prove it came from her. That rule predates this
   * change and is right. But it means the evidence this feature reads is evidence the refresh can
   * erase, and the refresh runs to a FIXPOINT: blank the office answer on pass one and the
   * indicated country is gone by pass two, taking the sponsorship answer with it.
   *
   * It holds because the stamp survives. Her office answers were typed on the answers screen and
   * carry answer_source 'applicant_review' with the round's answer_reviewed_at, exactly as her
   * sponsorship answer does, so the refresh keeps all three and the fixpoint settles on the first
   * pass. The stored shape is reproduced here rather than assumed, and the fixpoint is run below. */
  const ROUND = '2026-09-01T21:28:12.934Z';
  const reviewed = (question: string, answer: string) => ({
    question,
    answer,
    answer_source: 'applicant_review',
    answer_reviewed_at: ROUND,
  });

  function refreshOnce(questions: ReturnType<typeof reviewed>[]) {
    return refreshKnownQuestionAnswers(
      questions,
      APPLICANT,
      undefined,
      ROUND,
      postingCountryFromJobContext(HRT_JOB_CONTEXT),
      postingCountryCodeFromJobContext(HRT_JOB_CONTEXT),
    );
  }

  const reviewedHrtPacket = () => [
    reviewed(TOP_OFFICE_LABEL, 'New York'),
    reviewed(SECOND_OFFICE_LABEL, 'Chicago'),
    reviewed(SPONSORSHIP_LABEL, 'Yes'),
  ];

  test('the refresh keeps her answer instead of blanking it, and does not change it', () => {
    const refreshed = refreshOnce(reviewedHrtPacket());
    const sponsorship = refreshed.find((question) => question.question === SPONSORSHIP_LABEL)!;
    assert.equal(sponsorship.answer, 'Yes', 'the refresh must neither blank nor rewrite her answer');
    // Her office answers, which are the evidence, survive the same pass.
    assert.equal(refreshed.find((q) => q.question === TOP_OFFICE_LABEL)!.answer, 'New York');
    assert.equal(refreshed.find((q) => q.question === SECOND_OFFICE_LABEL)!.answer, 'Chicago');
  });

  test('the refresh is a fixpoint: re-running it does not erode the evidence and then the answer', () => {
    let questions = reviewedHrtPacket();
    for (let pass = 0; pass < 4; pass += 1) {
      questions = refreshOnce(questions) as ReturnType<typeof reviewed>[];
      assert.equal(
        questions.find((q) => q.question === SPONSORSHIP_LABEL)!.answer,
        'Yes',
        `sponsorship answer lost on pass ${pass + 1}`,
      );
      assert.equal(
        questions.find((q) => q.question === TOP_OFFICE_LABEL)!.answer,
        'New York',
        `office evidence lost on pass ${pass + 1}`,
      );
    }
  });

  test('an office answer with no review stamp is blanked, and the sponsorship answer refuses with it', () => {
    /* The honest limit of the rule, asserted rather than hidden: the evidence must be hers in a way
     * the packet can still prove. A machine-written office answer is blanked by the pre-existing
     * refusal branch, so by the second pass there is no indication left and the send refuses again
     * - which is the correct direction to fail in. */
    const unstamped = [
      { question: TOP_OFFICE_LABEL, answer: 'New York' },
      { question: SPONSORSHIP_LABEL, answer: 'Yes' },
    ];
    const once = refreshKnownQuestionAnswers(
      unstamped, APPLICANT, undefined, ROUND,
      postingCountryFromJobContext(HRT_JOB_CONTEXT), postingCountryCodeFromJobContext(HRT_JOB_CONTEXT),
    );
    assert.equal(once.find((q) => q.question === TOP_OFFICE_LABEL)!.answer, '');
    const twice = refreshKnownQuestionAnswers(
      once, APPLICANT, undefined, ROUND,
      postingCountryFromJobContext(HRT_JOB_CONTEXT), postingCountryCodeFromJobContext(HRT_JOB_CONTEXT),
    );
    assert.equal(twice.find((q) => q.question === SPONSORSHIP_LABEL)!.answer, '');
  });

  /* THE ASSERTION THAT MAKES THE REFRESH'S COPY OF THE RULE LOAD-BEARING.
   *
   * Mutation testing caught this: with only the test above, deleting the indicated country from
   * refreshKnownQuestionAnswers' resolve call left the suite GREEN. The reason is that the test
   * above proves nothing about this change - her sponsorship answer carries a review stamp, and the
   * refusal branch already keeps a stamped answer, so it survived either way.
   *
   * The case that separates them is a sponsorship answer WITHOUT a current stamp beside office
   * answers that have one - a packet rebuild that dropped the round, which is a shape this codebase
   * has measured. With the country she indicated, the resolver ANSWERS and the row is filled with
   * "Yes". Without it, the resolver refuses, the branch blanks an unstamped answer, and the packet
   * goes back to being unsendable for a blank required field.
   */
  test('an unstamped sponsorship answer is resolved rather than blanked, because her offices say US', () => {
    const rebuilt = [
      reviewed(TOP_OFFICE_LABEL, 'New York'),
      reviewed(SECOND_OFFICE_LABEL, 'Chicago'),
      { question: SPONSORSHIP_LABEL, answer: 'Yes' } as ReturnType<typeof reviewed>,
    ];
    const refreshed = refreshOnce(rebuilt);
    assert.equal(
      refreshed.find((q) => q.question === SPONSORSHIP_LABEL)!.answer,
      'Yes',
      'the refresh must resolve this from her offices, not blank it for want of a stamp',
    );
  });

  test('the refresh still blanks the same answer when the countries disagree', () => {
    const split = hrtPacket().map((question) => (
      question.question === SECOND_OFFICE_LABEL ? { ...question, answer: 'London' } : question
    ));
    const refreshed = refreshKnownQuestionAnswers(
      split, APPLICANT, undefined, undefined,
      postingCountryFromJobContext(HRT_JOB_CONTEXT), postingCountryCodeFromJobContext(HRT_JOB_CONTEXT),
    );
    assert.equal(refreshed.find((q) => q.question === SPONSORSHIP_LABEL)!.answer, '');
  });

  test('knownAnswerLookup reports exactly what the refresh will serve', () => {
    const lookup = knownAnswerLookup(
      hrtPacket(), APPLICANT, undefined,
      postingCountryFromJobContext(HRT_JOB_CONTEXT), postingCountryCodeFromJobContext(HRT_JOB_CONTEXT),
    );
    assert.equal(lookup({ question: SPONSORSHIP_LABEL, answer: 'Yes' }), 'Yes');
    // Given a packet with no indication it reports the refusal, which is undefined.
    const blind = knownAnswerLookup(
      [], APPLICANT, undefined,
      postingCountryFromJobContext(HRT_JOB_CONTEXT), postingCountryCodeFromJobContext(HRT_JOB_CONTEXT),
    );
    assert.equal(blind({ question: SPONSORSHIP_LABEL, answer: 'Yes' }), undefined);
  });

  /* THE MUTATION THAT TYPE-CHECKS AND REVERTS EVERYTHING. Dropping the packet at the route's call
   * site is one token; the gate then never sees her answers, every multi-country sponsorship
   * question refuses again, and no unit test is red. The list is the FIRST and REQUIRED parameter
   * precisely so that dropping it cannot compile, and this pins the call site in the shape a reader
   * can check by eye. */
  test('the send gate is called with the packet it is judging', () => {
    const source = readFileSync('src/routes/applications.ts', 'utf8');
    assert.match(
      source,
      /reviewQuestionRequiresAttention\(\s*\n\s*packetQuestions,\s*\n\s*question,/,
      'the route must hand the whole packet to the sensitive-question gate',
    );
    assert.match(
      source,
      /const packetQuestions = normalizeApplicationReviewQuestions\(questions\);/,
      'and it must be the same normalized list the gate walks',
    );
  });
});

/* ---- and the other exit from the same gate, which shipped separately ----
 *
 * #906 landed the general escape hatch: for a sensitive question the resolver genuinely CANNOT
 * answer, her explicit per-question confirmation mints answer_confirmed_of and clears the gate.
 * This rule is the narrower case where the resolver CAN answer, because she already named the
 * country. The two are complementary and the order between them is what makes them so.
 */
describe('this rule and her explicit confirmation are two exits, not two hurdles', () => {
  const row = { question: SPONSORSHIP_LABEL, answer: 'Yes' };
  const gate = (
    packet: readonly { question: string; answer?: string }[],
    question: { question: string; answer: string; answer_confirmed_of?: unknown },
  ) => reviewQuestionRequiresAttention(
    packet,
    question,
    APPLICANT,
    undefined,
    postingCountryFromJobContext(HRT_JOB_CONTEXT),
    postingCountryCodeFromJobContext(HRT_JOB_CONTEXT),
  );

  /* THE ASSERTION THE TWO CHANGES HAVE TO SATISFY TOGETHER. The confirmation branch runs BEFORE the
   * resolver, so the obvious worry is that it becomes a precondition and she is asked to confirm
   * something her own office answers already settled. It does not: it is an early EXIT, so a
   * question this rule can answer falls straight through it and is cleared by the resolver. */
  test('a question this rule answers does not also demand a confirmation', () => {
    assert.equal(gate(hrtPacket(), row), false, 'no redundant confirmation may be required');
  });

  test('#906 still carries every case this rule does not', () => {
    // No office answers, so no indicated country: this rule refuses and hers is the only way out.
    assert.equal(gate([row], row), true);
    assert.equal(gate([row], { ...row, answer_confirmed_of: SPONSORSHIP_LABEL }), false);
  });

  test('she can still confirm her way past a genuinely ambiguous packet', () => {
    const split = [
      { question: TOP_OFFICE_LABEL, answer: 'New York' },
      { question: SECOND_OFFICE_LABEL, answer: 'London' },
      row,
    ];
    assert.equal(gate(split, row), true, 'two countries is a real ambiguity and this rule refuses it');
    assert.equal(
      gate(split, { ...row, answer_confirmed_of: SPONSORSHIP_LABEL }),
      false,
      'and her own confirmation is still the escape hatch, exactly as #906 shipped it',
    );
  });
});
