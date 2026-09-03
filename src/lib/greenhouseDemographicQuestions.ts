/**
 * THE JOIN BETWEEN A LIVE GREENHOUSE DEMOGRAPHIC COMBOBOX AND THE LIST THE BOARD API PUBLISHES.
 *
 * Measured on Hudson River Trading packet 4a79eec1 (greenhouse, run d712aa9f, 2026-09-02): the
 * managed fill completed and parked on four `missing_exact_options` blockers, "What is your
 * gender?", "Are you a veteran?", "Do you have a disability?" and "What is your race/ethnicity?",
 * every one `portal_input_type: combobox`, `portal_selector: null`, required, and none with a
 * stored question row. Three facts explain that, and this module is the answer to all three:
 *
 *   1. The job-boards renderer builds these as react-selects with bare NUMERIC ids (245/248/249/
 *      250) and no options in the DOM until the menu opens. The discovery runner declines a
 *      digit-leading id as a durable selector, so the field arrives with the temporary
 *      `[data-litos-discovered-N]` marker only, and the option probe cannot name it either.
 *   2. PR #852 taught the schema reader the `compliance` block, but on this board `compliance` is
 *      `null`: the lists live under `demographic_questions.questions[]`, keyed by the employer's
 *      exact wording and carrying the same numeric id the DOM uses. So the #852 join had nothing
 *      to join.
 *   3. questionMetadataBlockerForDiscovered files missing_exact_options while
 *      `optionsComplete === false` whatever list is attached, so an attached list must say it is
 *      the employer's complete inventory - which a published answer_options list is.
 *
 * FAIL-CLOSED BY CONSTRUCTION. A field joins only on an exact normalized-label match against a
 * label exactly one discovered field carries and exactly one published question carries. Nothing
 * here guesses an answer: the resolver's own EEO rules run afterwards, and a control that matches
 * no published question keeps the blocker it always had.
 */
import {
  greenhousePublicQuestionLabelKey,
  type GreenhousePublicApplicationSchema,
} from './greenhousePublicApplication';
import { normalizeDiscoveredLabel } from './questionDiscovery';
import { managedOptionProbeControlId } from './portalSubmission';

type DiscoveredLike = {
  label: string;
  durableSelector?: string | null;
  options?: string[] | null;
  optionsComplete?: boolean;
};

/* The runner concatenates the control's own id onto the visible label ("what is your gender?
 * 245"), and normalizeDiscoveredLabel strips it back off. Read here for the one purpose the
 * strip exists to prevent elsewhere: it is the DOM id, and it is only trusted when it equals the
 * id the board published for the SAME question. */
const TRAILING_NUMERIC_HANDLE_RE = /\s+\*?\s*(\d+)\s*$/u;

/** The label key a discovered field joins on, or undefined when it has no readable wording. */
export function greenhouseDemographicLabelKey(rawLabel: string): string | undefined {
  return greenhousePublicQuestionLabelKey(normalizeDiscoveredLabel(rawLabel));
}

/** How many discovered fields carry each label key, for the ambiguity guard. */
export function greenhouseDemographicLabelCounts(
  fields: ReadonlyArray<Pick<DiscoveredLike, 'label'>>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const field of fields) {
    const key = greenhouseDemographicLabelKey(field.label);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The durable selector for a joined field: the one discovery reported, else an attribute selector
 * on the numeric id, minted ONLY when the id the runner concatenated onto the label equals the id
 * the board published for this exact question. Two independent sources naming one number is the
 * evidence; a published id alone is not, because it is a claim about a DOM this code never saw.
 */
function joinedDurableSelector(
  field: DiscoveredLike,
  publishedId: string,
): string | null | undefined {
  const reported = field.durableSelector?.trim();
  if (reported) return reported;
  const trailing = field.label.match(TRAILING_NUMERIC_HANDLE_RE)?.[1];
  return trailing === publishedId ? `[id="${publishedId}"]` : field.durableSelector;
}

export function joinGreenhouseDemographicQuestion<T extends DiscoveredLike>(
  field: T,
  schema: Pick<GreenhousePublicApplicationSchema, 'demographicQuestionsByLabel'> | null | undefined,
  labelCounts: ReadonlyMap<string, number>,
): T {
  if (!schema) return field;
  // A list discovery read completely off the live control is the better evidence; keep it.
  if (field.options?.length && field.optionsComplete !== false) return field;
  const key = greenhouseDemographicLabelKey(field.label);
  if (!key || labelCounts.get(key) !== 1) return field;
  const published = schema.demographicQuestionsByLabel[key];
  if (!published?.options.length) return field;
  return {
    ...field,
    options: [...published.options],
    optionsComplete: true,
    durableSelector: joinedDurableSelector(field, published.id),
  };
}

/** The whole-list form of the join, with the ambiguity guard computed from the same list. */
export function joinGreenhouseDemographicQuestions<T extends DiscoveredLike>(
  fields: readonly T[],
  schema: Pick<GreenhousePublicApplicationSchema, 'demographicQuestionsByLabel'> | null | undefined,
): T[] {
  if (!schema) return [...fields];
  const counts = greenhouseDemographicLabelCounts(fields);
  return fields.map((field) => joinGreenhouseDemographicQuestion(field, schema, counts));
}

/**
 * Whether the board publishes this discovered control as open text, in which case the option
 * probe must not treat it as a closed list however its label reads. Keyed on the control id the
 * probe itself would use, so the two cannot disagree about which control is meant.
 */
export function greenhouseSchemaPublishesAsOpenText(
  schema: Pick<GreenhousePublicApplicationSchema, 'openTextFieldNames'> | null | undefined,
  field: { label?: string | null; selector?: string | null; durableSelector?: string | null },
): boolean {
  if (!schema || schema.openTextFieldNames.length === 0) return false;
  const controlId = managedOptionProbeControlId(field);
  return Boolean(controlId) && schema.openTextFieldNames.includes(controlId!);
}
