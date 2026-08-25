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
  optionsByLabel: Record<string, string[]>;
  fieldNamesByLabel: Record<string, string>;
  coverLetterSupported: boolean;
  transcriptSupported: boolean;
};

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
  const optionsByLabel: Record<string, string[]> = {};
  const fieldNamesByLabel: Record<string, string> = {};
  const allFields: Array<{ name?: string; type?: string }> = [];
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

  const fieldNames = new Set(allFields.map((field) => field.name).filter(Boolean));
  const hasResumeFile = allFields.some((field) => field.name === 'resume' && field.type === 'input_file');
  if (!fieldNames.has('first_name')
    || !fieldNames.has('last_name')
    || !fieldNames.has('email')
    || !hasResumeFile) return null;

  return {
    fieldOptions,
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
