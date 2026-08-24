import {
  discoveredFieldIsFixedPortalProfileControl,
  discoveredFieldIsNotAQuestion,
  discoveredFieldIsRequired,
  normalizeReviewQuestionLabel,
  type DiscoveredQuestion,
} from './questionDiscovery';
import { managedOptionProbeControlId, type SupportedPortal } from './portalSubmission';
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
const QUESTION_CONTROL_TYPE = /^(?:text|textarea|select(?:-one|-multiple)?|radio|checkbox|combobox|listbox)$/i;

type MetadataDiscoveryField = Pick<
  DiscoveredQuestion,
  'label' | 'selector' | 'durableSelector' | 'inputType' | 'role' | 'options' | 'required'
>;

export function questionLabelIsGenericAnswerControl(label: string): boolean {
  return GENERIC_ANSWER_CONTROL_LABEL.test(normalizeReviewQuestionLabel(label));
}

export function discoveredQuestionsForExactOptionProbe(
  fields: readonly DiscoveredQuestion[],
): DiscoveredQuestion[] {
  return fields.map((field) => {
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
    && usableOptions(field.options).length === 0
    && (options.closedControlRequiresOptions === true || reportedOptions)) {
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

export function questionMetadataBlockerReason(blocker: QuestionMetadataBlocker): string {
  if (blocker.kind === 'missing_question_text') {
    return 'Litos could not read the employer\'s exact question text for one application field, so it did not guess at that field.';
  }
  return `Litos could not read the employer's exact answer choices for "${(blocker.question ?? 'one application field').slice(0, 120)}", so it did not guess at that field.`;
}
