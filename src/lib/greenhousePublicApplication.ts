/**
 * Read-only Greenhouse Job Board API application metadata.
 *
 * This module deliberately contains no submission serializer or authenticated transport. Both the
 * browser preparation path and the optional ATS channel need the employer-published question
 * schema, and keeping that read here prevents importing send-capable code into the browser runner.
 */

const GREENHOUSE_JOB_BOARD_HOSTS = new Set([
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

export const GREENHOUSE_PUBLIC_APPLICATION_SCHEMA_TIMEOUT_MS = 10_000;

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parsedHttpsUrl(rawUrl: string | undefined): URL | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  return url.protocol === 'https:' ? url : null;
}

export function greenhousePostingFromUrl(
  rawUrl: string | undefined,
): { boardToken: string; jobId: string } | null {
  const url = parsedHttpsUrl(rawUrl);
  if (!url || !GREENHOUSE_JOB_BOARD_HOSTS.has(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length >= 3 && parts[1] === 'jobs' && /^\d+$/.test(parts[2])) {
    return { boardToken: parts[0], jobId: parts[2] };
  }
  if (parts[0] !== 'embed' || parts[1] !== 'job_app') return null;
  const jobId = url.searchParams.get('token');
  const boardToken = url.searchParams.get('for') ?? url.searchParams.get('b');
  return jobId && /^\d+$/.test(jobId) && boardToken ? { boardToken, jobId } : null;
}

export function greenhousePublicQuestionLabelKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+\*$/, '')
    .trim()
    .toLowerCase();
  return normalized || undefined;
}

export type GreenhousePublicApplicationSchema = {
  fieldOptions: Record<string, string[]>;
  /**
   * THE EEOC SELF-IDENTIFICATION LISTS, KEYED BY THE EMPLOYER'S OWN FIELD NAME.
   *
   * Greenhouse publishes these in a `compliance` array that sits BESIDE `questions` at the top
   * level, and this parser walked straight past it. Measured 2026-09-02 against a live board:
   * `compliance[].questions[].fields[]` carries `disability_status`, `veteran_status`, `race` and
   * `gender` as multi_value_single_select, each with its full `values[]` of `{label, value}` - the
   * identical shape the `questions` loop already reads.
   *
   * That omission is what parked Hudson River Trading packet 4a79eec1: on job-boards.greenhouse.io
   * these render as react-select comboboxes whose ids are bare numbers (245/248/249/250) with no
   * options in the DOM, so the live probe cannot name them and the published list was the only
   * source there was. Kept as its own map rather than folded into optionsByLabel because the
   * compliance label is a machine token ("DisabilityStatus"), not the employer's question wording,
   * so it can only be joined by SUBJECT - see the greenhouse join in submissionRunner.
   */
  complianceOptionsByField: Record<string, string[]>;
  /**
   * THE EMPLOYER'S OWN DEMOGRAPHIC QUESTION SET, KEYED BY THE EXACT QUESTION WORDING.
   *
   * The `compliance` reading above was measured against one board and generalised. Measured again
   * 2026-09-03 against Hudson River Trading (boards-api.greenhouse.io/v1/boards/wehrtyou/jobs/
   * 8052083?questions=true), `compliance` is `null` and the four EEO lists live under a sibling
   * top-level object, `demographic_questions.questions[]`: `{id: 245, label: "What is your
   * gender?", required, type, answer_options: [{id, label, free_form, decline_to_answer}]}`. The
   * label IS the wording the form asks, and the question `id` IS the numeric DOM id the
   * job-boards renderer gives the react-select (245/248/249/250, the ids every prod blocker
   * carried). So this set joins by exact label, and the id is the durable selector the runner
   * could never name because the discovery runner declines digit-leading ids.
   *
   * A label two demographic questions share is dropped as ambiguous, the same rule the Ashby
   * reader applies: a list that might belong to a twin must never be attached to either.
   */
  demographicQuestionsByLabel: Record<string, GreenhouseDemographicQuestion>;
  /**
   * Field names the employer publishes as OPEN TEXT (`input_text`, `textarea`). The option probe
   * decides closedness for a `question_<id>` from its label alone, and "Please represent both
   * completed and in-progress university degrees above. Please also write in your high
   * school/secondary school below." reads as an education react-select to that heuristic. It is
   * a text box (question_68000291, HRT, measured 2026-09-02), the probe found no listbox, and the
   * field was filed missing_exact_options and removed from resolution. The employer's own type is
   * the authority the heuristic lacks.
   */
  openTextFieldNames: string[];
  optionsByLabel: Record<string, string[]>;
  fieldNamesByLabel: Record<string, string>;
  coverLetterSupported: boolean;
  transcriptSupported: boolean;
};

export type GreenhouseDemographicQuestion = {
  /** The published question id as a string, e.g. "248". */
  id: string;
  options: string[];
  required: boolean;
};

function greenhouseDemographicQuestionOptions(question: Record<string, unknown>): string[] {
  const values = Array.isArray(question.answer_options) ? question.answer_options : [];
  const options: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const label = trimmed((value as Record<string, unknown>).label);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(label);
  }
  return options;
}

/** `demographic_questions.questions[]`, keyed by exact label; ambiguous labels dropped. */
function parseGreenhouseDemographicQuestions(
  value: unknown,
): Record<string, GreenhouseDemographicQuestion> {
  const out: Record<string, GreenhouseDemographicQuestion> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const questions = (value as Record<string, unknown>).questions;
  const ambiguous = new Set<string>();
  for (const question of Array.isArray(questions) ? questions : []) {
    if (!question || typeof question !== 'object' || Array.isArray(question)) continue;
    const record = question as Record<string, unknown>;
    const label = greenhousePublicQuestionLabelKey(record.label);
    const id = typeof record.id === 'number' && Number.isInteger(record.id) && record.id > 0
      ? String(record.id)
      : trimmed(record.id)?.match(/^\d+$/)?.[0];
    const options = greenhouseDemographicQuestionOptions(record);
    if (!label || !id || options.length === 0) continue;
    if (out[label]) {
      ambiguous.add(label);
      continue;
    }
    out[label] = { id, options, required: record.required === true };
  }
  for (const label of ambiguous) delete out[label];
  return out;
}

function greenhousePublicQuestionFields(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const fields = (value as Record<string, unknown>).fields;
  return Array.isArray(fields)
    ? fields.filter((field): field is Record<string, unknown> => Boolean(field)
      && typeof field === 'object'
      && !Array.isArray(field))
    : [];
}

function greenhousePublicFieldName(field: Record<string, unknown>): string | undefined {
  return trimmed(field.name) ?? trimmed(field.id);
}

function greenhousePublicFieldOptions(field: Record<string, unknown>): string[] {
  const values = Array.isArray(field.values) ? field.values : [];
  const options: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const label = trimmed((value as Record<string, unknown>).label);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(label);
  }
  return options;
}

/**
 * Parse one complete `?questions=true` response.
 *
 * The booleans in the result are authoritative, so a partial object must not become an all-false
 * schema. A real Greenhouse application schema always names its core identity fields and resume
 * file control. Requiring those witnesses distinguishes the complete public response from an
 * intermediary or malformed response that merely happens to contain a `questions` property.
 */
export function parseGreenhousePublicApplicationSchema(
  value: unknown,
): GreenhousePublicApplicationSchema | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rawQuestions = (value as Record<string, unknown>).questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;

  const fieldOptions: Record<string, string[]> = {};
  const complianceOptionsByField: Record<string, string[]> = {};
  const optionsByLabel: Record<string, string[]> = {};
  const fieldNamesByLabel: Record<string, string> = {};
  const allFields: Array<{ name?: string; type?: string }> = [];
  const openTextFieldNames: string[] = [];
  let coverLetterSupported = false;
  let transcriptSupported = false;

  for (const question of rawQuestions) {
    if (!question || typeof question !== 'object' || Array.isArray(question)) continue;
    const record = question as Record<string, unknown>;
    const label = greenhousePublicQuestionLabelKey(record.label);
    const fields = greenhousePublicQuestionFields(record);
    const questionOptions: string[] = [];
    let firstFieldName: string | undefined;

    for (const field of fields) {
      const fieldName = greenhousePublicFieldName(field);
      const fieldType = trimmed(field.type)?.toLowerCase();
      if (fieldName && !firstFieldName) firstFieldName = fieldName;
      allFields.push({ name: fieldName, type: fieldType });
      if (fieldName && (fieldType === 'input_text' || fieldType === 'textarea')) {
        openTextFieldNames.push(fieldName);
      }

      const options = greenhousePublicFieldOptions(field);
      if (fieldName && options.length > 0) fieldOptions[fieldName] = options;
      for (const option of options) {
        if (!questionOptions.some((candidate) => candidate.toLowerCase() === option.toLowerCase())) {
          questionOptions.push(option);
        }
      }

      if (fieldName === 'cover_letter' && fieldType === 'input_file') coverLetterSupported = true;
      if (fieldType === 'input_file' && /\btranscript\b/i.test(String(record.label ?? ''))) {
        transcriptSupported = true;
      }
    }

    if (label && firstFieldName) fieldNamesByLabel[label] = firstFieldName;
    if (label && questionOptions.length > 0) optionsByLabel[label] = questionOptions;
  }

  /* Read after the questions loop and never allowed to overwrite it: a board that publishes the
   * same field name in both places is describing one control, and the `questions` reading is the
   * one every other join in this repo is built on. */
  const rawCompliance = (value as Record<string, unknown>).compliance;
  for (const block of Array.isArray(rawCompliance) ? rawCompliance : []) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const blockQuestions = (block as Record<string, unknown>).questions;
    for (const question of Array.isArray(blockQuestions) ? blockQuestions : []) {
      if (!question || typeof question !== 'object' || Array.isArray(question)) continue;
      for (const field of greenhousePublicQuestionFields(question)) {
        const fieldName = greenhousePublicFieldName(field);
        const options = greenhousePublicFieldOptions(field);
        if (!fieldName || options.length === 0) continue;
        if (!complianceOptionsByField[fieldName]) complianceOptionsByField[fieldName] = options;
        if (!fieldOptions[fieldName]) fieldOptions[fieldName] = options;
      }
    }
  }

  const fieldNames = new Set(allFields.map((field) => field.name).filter(Boolean));
  const hasResumeFile = allFields.some((field) => field.name === 'resume' && field.type === 'input_file');
  if (!fieldNames.has('first_name')
    || !fieldNames.has('last_name')
    || !fieldNames.has('email')
    || !hasResumeFile) return null;

  return {
    fieldOptions,
    complianceOptionsByField,
    demographicQuestionsByLabel: parseGreenhouseDemographicQuestions(
      (value as Record<string, unknown>).demographic_questions,
    ),
    openTextFieldNames,
    optionsByLabel,
    fieldNamesByLabel,
    coverLetterSupported,
    transcriptSupported,
  };
}

export async function greenhousePublicApplicationSchemaForPosting(
  posting: { boardToken: string; jobId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<GreenhousePublicApplicationSchema | null> {
  const response = await fetchImpl(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(posting.boardToken)}/jobs/${encodeURIComponent(posting.jobId)}?questions=true`,
    {
      method: 'GET',
      signal: AbortSignal.timeout(GREENHOUSE_PUBLIC_APPLICATION_SCHEMA_TIMEOUT_MS),
    },
  );
  if (!response.ok) return null;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return null;
  }
  return parseGreenhousePublicApplicationSchema(parsed);
}

/** Read the employer-published schema without submission credentials or applicant data. */
export async function greenhousePublicApplicationSchema(
  rawUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<GreenhousePublicApplicationSchema | null> {
  const posting = greenhousePostingFromUrl(rawUrl);
  return posting ? greenhousePublicApplicationSchemaForPosting(posting, fetchImpl) : null;
}
