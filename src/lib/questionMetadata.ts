import {
  discoveredFieldIsFixedPortalProfileControl,
  discoveredFieldIsNotAQuestion,
  discoveredFieldIsRequired,
  isConsentRefusingWording,
  normalizeReviewQuestionLabel,
  SINGLE_CHOICE_EXACT_OPTION_TYPE,
  type DiscoveredQuestion,
} from './questionDiscovery';
import {
  durablePortalSelector,
  managedOptionProbeControlId,
  managedOptionProbeExpectsClosedControl,
  type SupportedPortal,
} from './portalSubmission';
import { usableOptions } from './profileFieldResolution';

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
 * THE MENU THE LAST READ MEASURED, KEPT WHEN THIS READ MEASURED NOTHING.
 *
 * `options` on a stored question is written from the CURRENT run's read. A read that produced
 * nothing is not evidence the employer's menu is gone - the probe is opened by an option probe that
 * can be skipped, batched away, or time out - so writing its emptiness over a list an earlier run
 * really measured is a DELETION, not a refresh. The runner already refuses that trade one level up:
 * managedFormSnapshotWithStableCapabilities keeps `prior.field_options` when discovery failed. This
 * is the same rule for the per-question copy.
 *
 * MEASURED on origin/main at the deployed revision (107e1ae7), by driving discoverAndResolveQuestions
 * through two runs over one Greenhouse gender combobox `[id="245"]`:
 *   run 1, menu read : options ["Woman","Man","Non-binary","I don't wish to answer"], answer "Woman"
 *   run 2, menu unread: options null, answer "Female"
 * The list is the smaller half of that. The answer moved because reviewedAnswerStillFits (see
 * routes/submissionRunner.ts) is gated on `unreadClosedControl?.kind !== 'missing_exact_options'`,
 * so an empty read DISARMS the keep gate, and her reviewed pick of an employer option is replaced by
 * a profile value that matches nothing the control offers. That is the "ANSWERED with nothing
 * selected" loop reviewedComboboxOptionKept.test.ts was written for, reached by a different door.
 *
 * WHY THIS IS NARROWER THAN "any closed control", and the narrowing is the safety argument:
 *
 *   - SAME CONTROL ONLY. A list is evidence about the control it was read from, so it is kept only
 *     when this field carries the selector the stored question was bound to. The quarantine branch
 *     in the runner already proves a stored record this same way (`existing.portal_selector ===
 *     selector`) before letting it survive an unread menu.
 *   - NEVER A TYPE storedAnswerMatchesNoExactOption CAN JUDGE. That gate blanks a stored answer
 *     matching none of the recorded options, and it runs on SINGLE_CHOICE_EXACT_OPTION_TYPE. Handing
 *     a retained list to a select, radio or listbox would let a menu measured on an earlier render
 *     RE-OPEN a correct answer - destroying data to fix a display gap, which is a strictly worse
 *     trade than the one being fixed. Excluding that set is what makes retention unable to blank
 *     anything: on the types that remain, the re-open gate returns false before it looks at options.
 *     Written as the set difference rather than a combobox literal so the two stay coupled - widen
 *     the re-open gate later and retention narrows itself automatically.
 *
 *     That exclusion is belt and braces rather than the only guard, which is what makes the rule
 *     safe to reason about at the call sites. A zero-option read on a type that needs exact options
 *     before resolution raises `missing_exact_options` at the TOP of the discovery loop, and that
 *     branch ends in `continue` - the record is preserved wholesale under its own current-round
 *     same-selector proof, or invalidated. Control never reaches the writes this function serves.
 *     EXACT_OPTIONS_BEFORE_RESOLUTION_TYPE is a superset of SINGLE_CHOICE_EXACT_OPTION_TYPE, so
 *     every blankable type is intercepted there; combobox is the exempt one, and is therefore the
 *     only type that reaches here with an unread menu. choiceOptionsNeverCaptured.test.ts pins both
 *     halves of that.
 *   - STILL A CHOICE CONTROL. A menu is kept only for something that is still a menu; a control this
 *     run read as free text has no use for one.
 *
 * On the types that survive those tests the retained list can only help: the keep gate
 * (REVIEWED_PICK_EXACT_OPTION_TYPE, which DOES admit combobox) can see that her reviewed answer is
 * an offered option and hold it, and the dashboard can render the employer's choices instead of a
 * bare text box.
 */
export function optionsSurvivingAnUnreadMenu(input: {
  freshOptions: readonly string[] | null | undefined;
  controlType: string;
  selector: string | null | undefined;
  existing: { options?: readonly string[] | null; portal_selector?: string | null } | undefined;
}): string[] | null {
  const fresh = usableOptions(input.freshOptions);
  if (fresh.length > 0) return fresh;
  const kept = usableOptions(input.existing?.options);
  if (kept.length === 0) return null;
  const controlType = input.controlType?.trim().toLowerCase() ?? '';
  // A menu is kept only for a control that still offers one...
  if (!CLOSED_CONTROL_TYPE.test(controlType)) return null;
  // ...and never for one whose stored answer the re-open gate is allowed to blank.
  if (SINGLE_CHOICE_EXACT_OPTION_TYPE.test(controlType)) return null;
  /* THE SAME-CONTROL PROOF HAS TO BE A DURABLE ONE.
   *
   * portalSelectorForField hands back `field.selector` - the `[data-litos-discovered-N]` marker
   * stamped by the DISCOVERY page load - for a Greenhouse combobox with no id, which is precisely
   * the population this function serves. durablePortalSelector refuses that marker, and it is right
   * to: N is assigned by discovery ORDER, so the same marker can name a different control on a later
   * run (a conditional field appeared, a section expanded) and the same control can change markers.
   * Comparing raw selectors therefore reads as a proof of identity while proving nothing, and the
   * consequence is not merely cosmetic - reviewedAnswerStillFits consults this menu, so a marker
   * collision would keep an answer against another control's options AND skip the
   * missing_exact_options blocker that would otherwise hold the send.
   *
   * Where identity cannot be proven, nothing is kept, which is exactly today's behaviour. */
  const selector = durablePortalSelector(input.selector ?? undefined);
  if (!selector) return null;
  if (durablePortalSelector(input.existing?.portal_selector ?? undefined) !== selector) return null;
  return kept;
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

export function questionMetadataBlockerReason(blocker: QuestionMetadataBlocker): string {
  if (blocker.kind === 'missing_question_text') {
    return 'Litos could not read the employer\'s exact question text for one application field, so it did not guess at that field.';
  }
  return `Litos could not read the employer's exact answer choices for "${(blocker.question ?? 'one application field').slice(0, 120)}", so it did not guess at that field.`;
}
