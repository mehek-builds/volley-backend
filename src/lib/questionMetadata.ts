import {
  discoveredFieldIsFixedPortalProfileControl,
  discoveredFieldIsNotAQuestion,
  discoveredFieldIsRequired,
  isConsentRefusingWording,
  normalizeReviewQuestionLabel,
  REVIEWED_PICK_EXACT_OPTION_TYPE,
  SINGLE_CHOICE_EXACT_OPTION_TYPE,
  type DiscoveredQuestion,
} from './questionDiscovery';
import {
  managedOptionProbeControlId,
  managedOptionProbeExpectsClosedControl,
  type SupportedPortal,
} from './portalSubmission';
import {
  comparableOption,
  FREE_ENTRY_INPUT_TYPE,
  isProfileBackedKey,
  profileAnswerAliases,
  profileFieldIntent,
  usableOptions,
} from './profileFieldResolution';

export type QuestionMetadataBlocker = {
  kind: 'missing_question_text' | 'missing_exact_options';
  required: boolean;
  portal_input_type: string;
  control_id?: string;
  portal_selector?: string;
  question?: string;
};

const GENERIC_ANSWER_CONTROL_LABEL = /^(?:(?:please\s+)?(?:type|enter|write)(?:\s+your)?\s+)?(?:your\s+)?(?:answer|response)(?:\s+here)?[\s.:]*$/i;
const CLOSED_CONTROL_TYPE = /^(?:select(?:-one|-multiple)?|radio|combobox|listbox)$/i;
const EXACT_OPTIONS_BEFORE_RESOLUTION_TYPE = /^(?:select(?:-one|-multiple)?|radio|listbox)$/i;
const QUESTION_CONTROL_TYPE = /^(?:text|textarea|select(?:-one|-multiple)?|radio|checkbox|combobox|listbox)$/i;

type MetadataDiscoveryField = Pick<
  DiscoveredQuestion,
  'label' | 'selector' | 'durableSelector' | 'inputType' | 'role' | 'options' | 'optionsComplete' | 'required'
>;

export function questionLabelIsGenericAnswerControl(label: string): boolean {
  return GENERIC_ANSWER_CONTROL_LABEL.test(normalizeReviewQuestionLabel(label));
}

export function discoveredQuestionsForExactOptionProbe(
  fields: readonly DiscoveredQuestion[],
): DiscoveredQuestion[] {
  return fields.map((field) => {
    if (field.optionsComplete === false) return { ...field, options: null };
    const blocker = questionMetadataBlockerForDiscovered(field, {
      closedControlRequiresOptions: true,
    });
    if (blocker?.kind !== 'missing_exact_options' || !field.options?.length) return field;
    // The shared probe planner historically treated any reported row as a complete inventory.
    // Removing placeholder-only rows here makes the planner open and read the live control.
    return { ...field, options: null };
  });
}

export function discoveredQuestionControlType(
  field: Pick<DiscoveredQuestion, 'inputType' | 'role' | 'options'>,
): string {
  const inputType = field.inputType.trim().toLowerCase() || 'text';
  const role = field.role?.trim().toLowerCase();
  /* A FREE-ENTRY TYPE IS THE ONE FACT NEITHER OF THE TWO RULES BELOW MAY OVERRULE.
   *
   * This function mints `portal_input_type`, which is the single value every downstream consumer
   * reads to decide TYPED versus PICKED - measuredClosedListShape picks the fill action from it,
   * CLOSED_CONTROL_TYPE raises the missing-options blocker from it, and the keep/re-open gates in
   * questionDiscovery.ts judge a stored answer from it. Both rules below could mint a menu from
   * half the evidence, and neither ever checked the other half:
   *
   *   role alone      -> a react-select shell with an EMPTY menu is still called `combobox`;
   *   options alone   -> a list hung on a control that cannot hold one still promotes it.
   *
   * Measured live 2026-09-03, Hudson River Trading packet 4a79eec1: a run parked on the GPA fill
   * with `no option matched "3.89" (the list offered: "No options")` - react-select's own empty-menu
   * placeholder read back as though it were the employer's list. Measured on Pinpoint across the
   * ten-board sweep, from the other side: `["Yes","No"]` arrives attached to `number` fields, where
   * a years-of-experience or salary answer is then ranked against a two-row menu it can never join.
   *
   * FREE_ENTRY_INPUT_TYPE is positive evidence only and never includes `text`, which is what
   * managed discovery reports for every control it walks including react-selects. So a real
   * searchable combobox is untouched by this line and still reaches the role rule below; only a
   * control whose type the DOM states outright, and states as one react-select never renders, is
   * held to its own type here. */
  if (FREE_ENTRY_INPUT_TYPE.test(inputType)) return inputType;
  if (role === 'combobox' || role === 'listbox') return role;
  if (inputType === 'text' && usableOptions(field.options).length > 0) return 'combobox';
  return inputType;
}

/**
 * Controls that cannot safely receive even a profile-backed value until their employer-owned
 * option inventory is known.
 *
 * Searchable comboboxes are deliberately excluded. Greenhouse education controls use that shape
 * and can search for an exact profile value even when the initial DOM walk has not expanded their
 * menu. Native selects, radios, and listboxes cannot make the same promise: a string from the
 * profile is not evidence that the employer currently offers that option.
 */
export function discoveredQuestionNeedsExactOptionsBeforeResolution(
  field: Pick<DiscoveredQuestion, 'inputType' | 'role'>,
): boolean {
  const inputType = field.inputType.trim().toLowerCase();
  const role = field.role?.trim().toLowerCase();
  /* The same rule discoveredQuestionControlType now states, at the one other place a bare `role`
   * could speak for a control over its own type. A free-entry control has no option inventory to
   * wait for, so holding its resolution until one arrives waits forever: the list is never coming,
   * and the answer it was holding is a number that only ever needed typing. */
  if (FREE_ENTRY_INPUT_TYPE.test(inputType)) return false;
  return EXACT_OPTIONS_BEFORE_RESOLUTION_TYPE.test(inputType) || role === 'listbox';
}

function blockerBase(field: MetadataDiscoveryField) {
  const question = normalizeReviewQuestionLabel(field.label);
  const portalInputType = discoveredQuestionControlType(field);
  const controlId = managedOptionProbeControlId(field);
  const portalSelector = field.durableSelector?.trim() || undefined;
  const base = {
    required: discoveredFieldIsRequired(field),
    portal_input_type: portalInputType,
    ...(controlId ? { control_id: controlId } : {}),
    ...(portalSelector ? { portal_selector: portalSelector } : {}),
  };
  return { question, portalInputType, base };
}

export function questionMetadataBlockerForDiscovered(
  field: MetadataDiscoveryField,
  options: { closedControlRequiresOptions?: boolean } = {},
): QuestionMetadataBlocker | null {
  const { question, portalInputType, base } = blockerBase(field);

  if ((!question && QUESTION_CONTROL_TYPE.test(portalInputType)) || questionLabelIsGenericAnswerControl(question)) {
    return { kind: 'missing_question_text', ...base };
  }
  const reportedOptions = field.options?.some((option) => option.trim().length > 0) === true;
  if (CLOSED_CONTROL_TYPE.test(portalInputType)
    && (field.optionsComplete === false
      || (usableOptions(field.options).length === 0
        && (options.closedControlRequiresOptions === true || reportedOptions)))) {
    return { kind: 'missing_exact_options', question, ...base };
  }
  return null;
}

export function questionMetadataBlockerForOptionProbeFailure(
  field: MetadataDiscoveryField,
): QuestionMetadataBlocker {
  const { question, base } = blockerBase(field);
  if (!question || questionLabelIsGenericAnswerControl(question)) {
    return { kind: 'missing_question_text', ...base };
  }
  return { kind: 'missing_exact_options', question, ...base };
}

export function questionMetadataBlockersForOptionProbeFailures(
  portal: SupportedPortal,
  fields: readonly MetadataDiscoveryField[],
  failures: readonly { controlId: string }[],
): QuestionMetadataBlocker[] {
  const failedControlIds = new Set(failures.map(({ controlId }) => controlId));
  return dedupeQuestionMetadataBlockers(fields.flatMap((field) => {
    if (discoveredFieldIsFixedPortalProfileControl(portal, field)) return [];
    const controlId = managedOptionProbeControlId(field);
    if (!controlId || !failedControlIds.has(controlId)) return [];
    const blocker = questionMetadataBlockerForOptionProbeFailure(field);
    if (blocker.kind === 'missing_question_text') return [blocker];
    /* A PROBE FAILURE AGAINST A CONTROL THAT HAS NO OPTION INVENTORY IS NOT AN OPTION PROBLEM.
     *
     * questionMetadataBlockerForOptionProbeFailure returns 'missing_exact_options' for anything that
     * carries a readable label, with no check that the control is closed. So when the option probe
     * targets a free-text field and fails - which it does, because there is nothing there to open -
     * the packet is parked on "Litos could not read the exact options" for a control that can never
     * have any. Measured on Five Rings 767ed539 (Greenhouse): a `missing_exact_options` blocker whose
     * own portal_input_type is `text` and whose required is false, on "if you answered yes to the
     * above, please provide details on competing offers".
     *
     * THE QUESTION IS PUT TO THE PROBE, NOT TO THE OPTIONS. A first cut asked
     * discoveredQuestionControlType, which decides closedness from field.options - the very evidence
     * a failed probe did not produce. A Greenhouse react-select reports inputType 'text' with no DOM
     * options until its menu opens, so that guard called school/degree/discipline/end-month open text
     * and DELETED their blockers, and those blockers are a hard send gate. managedOptionProbeExpects-
     * ClosedControl answers from the probe's own target decision instead, where
     * MANAGED_FIXED_CLOSED_CONTROL_IDS keeps them closed whatever the DOM said.
     *
     * Only the exact-options kind is filtered. `missing_question_text` stays for every control type,
     * because an unlabelled text field is a real defect and the applicant genuinely cannot answer it. */
    if (!managedOptionProbeExpectsClosedControl(field, portal)) return [];
    const question = normalizeReviewQuestionLabel(field.label);
    if (discoveredFieldIsNotAQuestion({ label: field.label, options: field.options })
      || discoveredFieldIsNotAQuestion({ label: question, options: field.options })) return [];
    return [blocker];
  }));
}

export function dedupeQuestionMetadataBlockers(
  blockers: readonly QuestionMetadataBlocker[],
): QuestionMetadataBlocker[] {
  const deduped: QuestionMetadataBlocker[] = [];
  const identities = (blocker: QuestionMetadataBlocker): string[] => [
    ...(blocker.control_id ? [`control\u0000${blocker.control_id}`] : []),
    ...(blocker.portal_selector ? [`selector\u0000${blocker.portal_selector}`] : []),
    ...(blocker.question
      ? [`question\u0000${blocker.question.toLowerCase()}\u0000${blocker.portal_input_type}`]
      : []),
  ];
  const sameControl = (left: QuestionMetadataBlocker, right: QuestionMetadataBlocker): boolean => {
    if (left.control_id && right.control_id && left.control_id !== right.control_id) return false;
    if (left.portal_selector && right.portal_selector && left.portal_selector !== right.portal_selector) return false;
    if (left.control_id && left.control_id === right.control_id) return true;
    if (left.portal_selector && left.portal_selector === right.portal_selector) return true;
    const leftHasStrongIdentity = Boolean(left.control_id || left.portal_selector);
    const rightHasStrongIdentity = Boolean(right.control_id || right.portal_selector);
    if (leftHasStrongIdentity && rightHasStrongIdentity) return false;
    return Boolean(
      left.question
      && right.question
      && left.portal_input_type === right.portal_input_type
      && left.question.toLowerCase() === right.question.toLowerCase(),
    );
  };
  for (const blocker of blockers) {
    const aliases = new Set(identities(blocker));
    if (aliases.size === 0) {
      deduped.push(blocker);
      continue;
    }
    const matchingIndexes = deduped.flatMap((existing, index) => {
      if (existing.kind !== blocker.kind) return [];
      return sameControl(existing, blocker) ? [index] : [];
    });
    if (matchingIndexes.length === 0) {
      deduped.push(blocker);
      continue;
    }
    const strongMatches = new Set(matchingIndexes.flatMap((index) => {
      const existing = deduped[index];
      const strongIdentity = existing.control_id
        ? `control\u0000${existing.control_id}`
        : existing.portal_selector
          ? `selector\u0000${existing.portal_selector}`
          : null;
      return strongIdentity ? [strongIdentity] : [];
    }));
    if (strongMatches.size > 1) {
      deduped.push(blocker);
      continue;
    }
    const targetIndex = matchingIndexes[0];
    const merged = matchingIndexes.reduce<QuestionMetadataBlocker>((existing, index) => {
      const next = deduped[index];
      return {
        ...existing,
        required: existing.required || next.required,
        ...(existing.control_id ? {} : next.control_id ? { control_id: next.control_id } : {}),
        ...(existing.portal_selector ? {} : next.portal_selector ? { portal_selector: next.portal_selector } : {}),
        ...(existing.question ? {} : next.question ? { question: next.question } : {}),
      };
    }, blocker);
    deduped[targetIndex] = merged;
    for (const index of matchingIndexes.slice(1).sort((left, right) => right - left)) {
      deduped.splice(index, 1);
    }
  }
  return deduped;
}

/**
 * Closed single-choice control shapes whose value can only reach the employer as one of the
 * control's own exact options. Deliberately NARROWER than CLOSED_CONTROL_TYPE:
 *
 *   - combobox is excluded. A searchable combobox can find an option the initial DOM walk never
 *     enumerated (the Greenhouse education controls), so a stored answer that matches none of the
 *     recorded options may still land at fill time. Re-opening it would blank answers the fill can
 *     honestly place.
 *   - checkbox is excluded. A single privacy checkbox is not an option list, and its "options" are
 *     not answers to choose between.
 *   - select-multiple is excluded. Its stored answer can legitimately name several options at once,
 *     so whole-string equality against any single option would misread a correct answer as unfit.
 *
 * The gate itself now lives in questionDiscovery.ts (imported above) so the converse rule that KEEPS
 * a reviewed answer matching one of these controls' options - reviewedAnswerIsAnOfferedOption in
 * refreshKnownQuestionAnswers - is gated on exactly the same control set and cannot drift from it.
 */

/**
 * The stored question shape this module can judge without importing the review types (which import
 * this module). `answer_draft` is the display-only field a re-open writes; see the field's own
 * comment in applicationReview.ts.
 */
export type StoredClosedChoiceQuestion = {
  question: string;
  answer: string;
  required: boolean;
  portal_input_type?: string;
  options?: string[] | null;
  answer_draft?: string;
};

/**
 * A stored answer that cannot reach this control: the control is a strict closed single-choice
 * shape, its exact employer options were measured, and the answer matches none of them under the
 * fill path's own equivalence (trimmed, case-insensitive; see reviewedAnswerStillFits and
 * truthfulOtherChoice in routes/submissionRunner.ts, which this must not diverge from).
 *
 * FAIL-SAFE BY CONSTRUCTION, each clause its own guard:
 *   - No options recorded (null, empty, or placeholder-only rows filtered by usableOptions) means
 *     nothing is judged: an open text control, and a closed control whose menu was never read, are
 *     both left exactly as they are. usableOptions is the same placeholder filter resolution uses,
 *     so a "Select..." row can never count as an option here either.
 *   - A blank answer is already open and is not this function's business.
 *   - A consent REFUSAL is never touched. Blanking "I do not agree" would hand the control back to
 *     the resolver, which re-accepts it under the standing permission, turning her explicit refusal
 *     into a machine acceptance. Held exactly as she left it, matching the refresh's own rule.
 */
export function storedAnswerMatchesNoExactOption(
  question: Pick<StoredClosedChoiceQuestion, 'answer' | 'portal_input_type' | 'options'>,
): boolean {
  const controlType = question.portal_input_type?.trim().toLowerCase() ?? '';
  if (!SINGLE_CHOICE_EXACT_OPTION_TYPE.test(controlType)) return false;
  const offered = usableOptions(question.options);
  if (offered.length === 0) return false;
  const answer = question.answer.trim();
  if (!answer) return false;
  if (isConsentRefusingWording(question.answer)) return false;
  return !offered.some((option) => option.trim().toLowerCase() === answer.toLowerCase());
}

/**
 * THE CONVERSE OF "a reviewed answer that still fits is kept" (PR 711): a stored answer that does
 * NOT fit the control's measured exact options must re-open the question, because the packet is
 * otherwise deadlocked between an unfillable answer and an unaskable question.
 *
 * Measured live on the Mytos Lever packet (application 55de7c9e, 2026-08-28): the required
 * degree-classification select offers nine exact options, the stored reviewed answer is the
 * free-text "3.89/4.00 (US 4.0 scale)" which matches none of them, the runner correctly refuses to
 * guess and withholds the final press ("1 required field confirmation failed"), and the dashboard
 * never re-asks - the pending-question flow only surfaces unanswered questions, and a reviewed
 * answer in this state has no edit path. The row is permanently stuck.
 *
 * WHAT A RE-OPEN DOES, and only this:
 *   - blanks the answer, so blankRequiredQuestionLabels sees a required unanswered question again,
 *     the send gates hold, and the dashboard presents it with the exact options beside it, exactly
 *     as R-096 presents a question Litos never answered. An OPTIONAL unfit answer re-opens the same
 *     way but blocks nothing, per the existing convention that only required blanks gate a send.
 *   - preserves the removed text on `answer_draft` (display-only, never packet identity), so a
 *     client that supports prefilled drafts can offer her own words back. A draft already present
 *     is kept in preference to a later machine refill, so her original text survives the
 *     refresh/re-open fixpoint.
 *   - touches NOTHING else: no status, no run or session state, no other question, and every
 *     provenance field rides along untouched (all of them are inert beside a blank answer, and the
 *     refresh's own rules decide their fate on later passes).
 *
 * A row that carries a non-empty answer again (she picked an option, or a resolver refill fits)
 * drops the stale draft, so a draft never lingers beside an accepted answer.
 *
 * Deterministic and idempotent, so it composes with refreshKnownQuestionAnswers inside
 * packetQuestionFixpoint: a resolver refill of the blanked answer is re-blanked to the same record
 * on the next pass, and the chain settles.
 */
export function reopenUnfitClosedChoiceQuestions<T extends StoredClosedChoiceQuestion>(
  questions: readonly T[],
): T[] {
  return questions.map((question) => {
    if (storedAnswerMatchesNoExactOption(question)) {
      return {
        ...question,
        answer: '',
        answer_draft: question.answer_draft?.trim() ? question.answer_draft : question.answer.trim(),
      };
    }
    if (question.answer_draft !== undefined && question.answer.trim()) {
      const { answer_draft: _staleDraft, ...rest } = question;
      return rest as T;
    }
    return question;
  });
}

/**
 * THE STORED ANSWER, WRITTEN THE WAY THE EMPLOYER'S OWN CONTROL WRITES IT - for a PROFILE-BACKED
 * field, when nothing else in the pipeline ever re-snaps one.
 *
 * MEASURED LIVE 2026-09-04, account mehekmandal05@gmail.com, Sage Greenhouse packet
 * aae653a3-2d5a-4f3e-ba3b-afea4219df37. "When do you expect to graduate?" is a required `combobox`
 * offering Spring 2027 / Fall 2027 / Spring 2028 / Fall 2028 / Spring 2029 / Fall 2029 / 2030 or
 * later; her profile stores `grad_date: "May 2028"`. She picked "Spring 2028" through PUT
 * /applications/:id/review/answers - exactly the option resolveProfileField would also have chosen,
 * since graduationDateLadder already carries the May-is-Spring/December-is-Fall mapping - and the
 * save genuinely stored it: `answer: "Spring 2028"`, `answer_option_source: "May 2028"` recording
 * the snap, and no `answer_source`, because mergeSubmittedApplicationReviewQuestions's own
 * anti-laundering gate (submittedIsMachineValue) correctly declines to stamp a machine echo as her
 * choice. See the 2026-08-13 "802 answers" comment in routes/applications.ts for why that refusal
 * is right and is not touched here.
 *
 * refreshKnownQuestionAnswers then ran on the very next read, GET /applications/:id/submission, and
 * had nothing to keep "Spring 2028" with: it is not a parseable date/number BAND
 * (storedOptionAnswerIsCurrent demands one to even look at answer_option_source), the label is not
 * an EEO subject (selfIdentificationAnswerStatesProfileValue is scoped to those), and there was no
 * surviving answer_source to satisfy reviewedAnswerIsAnOfferedOption. So execution fell to the
 * bottom of that function and overwrote it with resolveKnownAnswer's raw, un-snapped "May 2028" -
 * off every option the control offers, which the dashboard's own answered-check then reads as
 * blank. The applicant was asked the same question again: pick Spring 2028, Save, reverts to May
 * 2028, asked again, forever.
 *
 * refreshKnownQuestionAnswers cannot fix this itself - it decides an answer from the label and the
 * profile alone and, by design, never consults a control's option list (see that function's own
 * header). Snapping the decided answer onto a real control is profileFieldResolution.ts's job; this
 * is the missing pass that carries that snap onto the STORED record on every read, so the refresh's
 * un-snapped overwrite is corrected within the same pass rather than left standing until the next
 * save re-derives it and only for as long as that lasts.
 *
 * NOT THE SAME MECHANISM AS PR #892 / #897, DELIBERATELY, though the shape looks identical. Both of
 * those (open, unmerged, on other sessions' branches as of this writing) build a pass with this
 * exact name and this exact seam for the EEO self-identification family - Female/Woman, race
 * widening, decline wordings - and #897's own header spends several paragraphs on why that family
 * needs a narrower rule than a plain alias search (never write a decline, never widen a specific
 * answer to a coarser one, never let two options spelling the same thing pick by DOM order).
 * Reimplementing that contested territory a third way here would be exactly the parallel
 * implementation this fix has to avoid, so EEO labels are left untouched by this function entirely:
 * the gate below is `isProfileBackedKey(profileFieldIntent(label))`, and profileFieldIntent returns
 * null for every EEO label by construction (classifyField's own short-circuit - see
 * profileAnswerAliases's header for the same fact used the same way), so an EEO row is a no-op here
 * whether or not either of those PRs has landed. What this covers is everything
 * PROFILE_BACKED_KEYS names and neither PR touches at all: graduation windows, GPA bands, school
 * names, degree wording, major, referral sources, study year, current enrollment.
 *
 * THE CONTROL SET IS THE WIDER ONE THAT MAY KEEP A FIT ANSWER (REVIEWED_PICK_EXACT_OPTION_TYPE),
 * NOT THE NARROWER ONE THAT MAY BLANK AN UNFIT ONE (SINGLE_CHOICE_EXACT_OPTION_TYPE /
 * storedAnswerMatchesNoExactOption), and that distinction is not a detail here - it is the entire
 * reason this defect reached production. combobox is excluded from the narrow set on purpose: a
 * searchable combobox can hold an answer the DOM's first read never enumerated, so blanking an
 * unfit-LOOKING answer there would destroy a correct one. WRITING a captured option onto the record
 * is not that act - it can only ever replace an off-list value with one the control provably
 * offers, never invent or blank - so it is safe on the wider set, the same argument
 * reviewedAnswerIsAnOfferedOption already relies on for the keep direction. The graduation control
 * measured above is a combobox, which is exactly why nothing protected it before.
 *
 * RUNS INSIDE THE refresh -> snap -> reopen COMPOSITION, ON EVERY PASS, not once before
 * packetQuestionFixpoint starts. That placement was checked, not assumed: packetQuestionFixpoint
 * re-applies its transform to its own output, and "the raw, un-snapped resolver value" is a STABLE
 * fixed point of refresh + reopen alone (once `known.value === question.answer`, refresh's own
 * equality branch keeps it forever) while the snapped value is not, so a snap applied only to the
 * fixpoint's initial input is undone on pass one and the chain settles on the wrong value - measured
 * by hand-tracing this exact composition before choosing where to call it. Composing the snap
 * between the refresh and the re-open, inside the transform, makes the SNAPPED value the transform's
 * own fixed point instead, and it settles in at most two passes (verified for this family: it never
 * writes answer_override_of, which is the field #897's own header shows drifting across passes when
 * a snap runs inside this same loop - that drift is specific to the override-currency chain and is
 * not reachable through the plain alias match this function performs).
 *
 * WHAT IT WRITES BESIDE THE ANSWER. A snapped answer is a MACHINE value, so every claim made about
 * the string it replaced is dropped (answer_source above all - keeping it would assert a review
 * that never happened), and `answer_option_source` is set to the pre-snap string, matching the
 * shape mergeSubmittedApplicationReviewQuestions already writes for the same kind of value. Two
 * offered options denoting the same alias refuse rather than guessing, same as every other matcher
 * in this family.
 */
export function snapStoredAnswersToProfileFieldOptions<T extends StoredClosedChoiceQuestion>(
  questions: readonly T[],
): T[] {
  return questions.map((question) => {
    const answer = question.answer.trim();
    if (!answer) return question;
    /* HER OWN PROVENANCE IS NEVER THIS FUNCTION'S TO REWRITE - a review finding against this PR,
     * fixed here before landing.
     *
     * refreshKnownQuestionAnswers's override branch (derivationIsCurrent, questionDiscovery.ts)
     * deliberately KEEPS an applicant's off-list typed correction across a refresh: she disagreed
     * with the resolver on the review screen, and that disagreement survives for as long as
     * answer_override_of still names what the resolver currently computes. Measured: a degree
     * override "Master's Degree" (answer_override_of "Master of Science in Computer Science") on a
     * list offering "Master's" survives refresh untouched - and then reached here. combobox is in
     * REVIEWED_PICK_EXACT_OPTION_TYPE, "Master's" is one of educationLevelLadder's own aliases of her
     * text, it is the control's only match, and without this guard the code below rewrote her
     * override to "Master's" and stripped answer_source/answer_override_of/answer_confirmed_of along
     * with it - laundering a live, current disagreement into a silent machine echo on the very next
     * read.
     *
     * This function exists only for UNPROVENANCED machine values (see the header above): an answer
     * nobody has claimed, snapped onto the control's own wording so a plain alias match does not
     * strand it. A row that already carries a claim - answer_source 'applicant_review', or an
     * answer_override_of/answer_confirmed_of naming what it was reviewed against - is not that, and
     * is returned exactly as it stands, whether or not any alias below would have matched it.
     * refreshKnownQuestionAnswers is the only place that judges whether her claim is still current;
     * this function does not get a second, looser opinion on the same record. */
    const provenance = question as T & {
      answer_source?: unknown;
      answer_override_of?: unknown;
      answer_confirmed_of?: unknown;
    };
    if (
      provenance.answer_source === 'applicant_review'
      || typeof provenance.answer_override_of === 'string'
      || typeof provenance.answer_confirmed_of === 'string'
    ) {
      return question;
    }
    const controlType = question.portal_input_type?.trim().toLowerCase() ?? '';
    if (!REVIEWED_PICK_EXACT_OPTION_TYPE.test(controlType)) return question;
    const offered = usableOptions(question.options);
    if (offered.length === 0) return question;
    const answerKey = comparableOption(answer);
    // Already on the list under the control's own equivalence: nothing to snap.
    if (offered.some((option) => comparableOption(option) === answerKey)) return question;
    const label = normalizeReviewQuestionLabel(question.question);
    if (!label || !isProfileBackedKey(profileFieldIntent(label))) return question;
    for (const alias of profileAnswerAliases(label, answer)) {
      const key = comparableOption(alias);
      if (!key) continue;
      const matches = offered.filter((option) => comparableOption(option) === key);
      if (matches.length !== 1) continue;
      const withProvenance = question as T & {
        answer_source?: unknown;
        answer_reviewed_at?: unknown;
        answer_option_source?: unknown;
        answer_override_of?: unknown;
        consent_permission_granted_at?: unknown;
        consent_permission_version?: unknown;
        answer_confirmed_of?: unknown;
        answer_state?: unknown;
      };
      const {
        answer_source: _answerSource,
        answer_reviewed_at: _answerReviewedAt,
        answer_option_source: _answerOptionSource,
        answer_override_of: _answerOverrideOf,
        consent_permission_granted_at: _consentGrantedAt,
        consent_permission_version: _consentVersion,
        answer_confirmed_of: _answerConfirmedOf,
        answer_state: _answerState,
        ...rest
      } = withProvenance;
      return { ...rest, answer: matches[0], answer_option_source: answer } as unknown as T;
    }
    return question;
  });
}

export function questionMetadataBlockerReason(blocker: QuestionMetadataBlocker): string {
  if (blocker.kind === 'missing_question_text') {
    return 'Litos could not read the employer\'s exact question text for one application field, so it did not guess at that field.';
  }
  return `Litos could not read the employer's exact answer choices for "${(blocker.question ?? 'one application field').slice(0, 120)}", so it did not guess at that field.`;
}
