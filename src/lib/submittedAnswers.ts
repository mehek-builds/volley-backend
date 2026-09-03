import { mergeSubmittedApplicationReviewQuestions, type ApplicationReviewQuestion, type ApplicationReviewState } from './applicationReview';
import type { JobCountry } from './jobLocation';
import { knownAnswerLookup, refreshKnownQuestionAnswers, type ApplicationProfileLike } from './questionDiscovery';
import { packetQuestionFixpoint } from './packetQuestionIdentity';
import { reopenUnfitClosedChoiceQuestions } from './questionMetadata';
import { resolveProfileField } from './profileFieldResolution';

/**
 * THE STRING THE MACHINE ACTUALLY WRITES INTO THIS CONTROL, which is not always the string the
 * resolver decided.
 *
 * MEASURED IN PRODUCTION 2026-09-03, packet 4a79eec1 (Hudson River Trading, greenhouse), after a
 * managed run at revision 07637333. The required control asks "What is your gender?" and offers
 * Woman / Man / Non-binary / I don't wish to answer. Her `eeo_prefs.gender` is `Female`, and the
 * packet came back reading:
 *
 *   answer                 "Woman"
 *   answer_source          "applicant_review"
 *   answer_override_of     "Female"
 *   answer_reviewed_at     "2026-09-01T21:28:12.934Z"   == questions_reviewed_at
 *
 * The packet asserted she reviewed that control on 2026-09-01 and overrode `Female` with `Woman`.
 * She did not, and on 2026-09-01 no code path in the repo could produce `Woman` for this label: the
 * Female/Woman equivalence shipped on 2026-09-03 as 7a3d1b2.
 *
 * WHY THE EXISTING GUARD DID NOT CATCH IT, and it is one step and not a design flaw.
 * mergeSubmittedApplicationReviewQuestions already refuses to mint a claim for a submitted answer
 * that is only the resolver's own value coming back - that is `submittedIsResolverValue`, and the
 * lookup behind it is `knownAnswerLookup`, i.e. `resolveKnownAnswer`. But `resolveKnownAnswer`
 * decides WHETHER a question is answerable and WHAT the answer is FROM THE PROFILE; it is
 * `resolveProfileField` that decides how that same answer is WRITTEN INTO THIS CONTROL, snapping it
 * onto the employer's own option text. The fill, the packet audit and the runner all resolve
 * through the second one. The mint gate asked only the first, so every SNAPPED machine value -
 * `Female` written as `Woman`, `Decline to self-identify` written as `Decline To Self Identify` -
 * was a string the gate had never heard of, and a body carrying it read as an edit.
 *
 * SO THIS IS THE SAME RULE, ASKED ABOUT THE RIGHT STRING. It answers exactly one question - "is
 * this what Litos itself would put in this control?" - and it is consulted for exactly one purpose:
 * refusing to assert that the applicant chose bytes the machine produces on its own. It never
 * writes an answer and never widens one, so the worst it can do is decline to record a claim, which
 * is the direction this whole family of rules errs in already.
 *
 * IT IS NOT THE OVERRIDE'S VALUE, and the two must not be merged into one lookup.
 * `answer_override_of` records the value a real override was made AGAINST, and
 * refreshKnownQuestionAnswers proves that override still current by recomputing `resolveKnownAnswer`
 * - so it has to be the PRE-SNAP string. Recording the snapped one there would make every override
 * on a snapped control fail its own currency check, which is the graduation-band defect the
 * override field's own doc records. Two lookups, two jobs.
 *
 * THE ROW'S OWN CONTROL SHAPE IS THE INPUT. `portal_input_type` and `options` are what the last run
 * measured off the employer's form, which is what the screen rendered and what the client posted
 * back.
 *
 * ONLY WHEN THE SNAP ACTUALLY LANDED ON ONE OF THE EMPLOYER'S OWN OPTIONS, and this clause is the
 * whole difference between a rule and a guess. It was measured as a regression before it was
 * measured as a rule: without it, reviewAnswerSave.test.ts's Lever degree case went red.
 *
 *   stored (an earlier run's resolution)   "Bachelor of Science in Computer Science"
 *   she types                              "Bachelor's Degree"
 *   resolveProfileField, options undefined "Bachelor's Degree", matchedOption FALSE
 *
 * With no option list to snap onto, resolveProfileField is not choosing the employer's wording, it
 * is REPHRASING the profile down its own alias ladder - and the string it lands on is exactly the
 * kind of thing an applicant types. Treating that as "the machine wrote this" refuses her claim on
 * the one path the mint rule was built for: the supported edit of a machine-resolved answer, which
 * refreshKnownQuestionAnswers then recomputes away.
 *
 * `matchedOption` is the repo's own predicate for "this value came off the list the caller
 * supplied", the same one the runner reads to say "none of the options match your saved answer".
 * Asked through that flag rather than by re-testing the value against `question.options` here: a
 * second relation that disagreed with the first is exactly how a narrow rule becomes a rewrite with
 * a decorative guard. So the claim this makes is the narrow one and the true one: THIS EXACT STRING
 * IS ON THE EMPLOYER'S CONTROL AND IS THE ONE LITOS WOULD PICK. Anything less than that, and the
 * answer is hers.
 */
export function machineAnswerLookup(
  profile: ApplicationProfileLike,
  jdText?: string,
  postingCountry?: JobCountry,
  postingCountryCode?: string,
  /* THE SAME MOMENT knownAnswerLookup IS BUILT WITH, or the two resolutions this gate compares can
     disagree for no reason but the wall clock. */
  asOf?: Date,
): (question: ApplicationReviewQuestion) => string | undefined {
  return (question) => {
    const resolved = resolveProfileField(
      {
        label: question.question,
        inputType: question.portal_input_type,
        options: question.options,
      },
      profile,
      jdText,
      postingCountry,
      postingCountryCode,
      asOf,
    );
    return resolved?.matchedOption ? resolved.value : undefined;
  };
}

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
  const merged = mergeSubmittedApplicationReviewQuestions(
    current.questions,
    submitted,
    questionsReviewedAt,
    resolverAnswerFor,
    /* And what that same resolution SNAPS TO on this employer's own control, because the screen the
     * body came from was rendered from the snapped value and the gate above only knows the unsnapped
     * one. See machineAnswerLookup for the measured HRT record. */
    machineAnswerLookup(profile, current.jd_text, postingCountry, postingCountryCode, asOf),
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
