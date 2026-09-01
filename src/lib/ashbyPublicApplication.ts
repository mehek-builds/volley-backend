/**
 * Read-only Ashby job-board application metadata.
 *
 * The exact sibling of greenhousePublicApplication.ts, and it exists for the same reason: the
 * browser preparation path needs the employer-published question schema, and keeping that read here
 * prevents importing send-capable code into the browser runner. No submission serializer, no
 * authenticated transport, no applicant data on the wire.
 *
 * WHY ASHBY NEEDS THIS MORE THAN GREENHOUSE DOES. On Greenhouse the public schema is a SECOND read
 * beside a live option probe. On Ashby it is the ONLY read: managedOptionProbeTargets is gated to
 * `['greenhouse','rippling','paylocity']` and pushManagedReactSelectOptionProbeActions returns early
 * for every non-Greenhouse family, so no pass ever opens an Ashby control to see what it offers.
 * Discovery's DOM walk is all there is, and Ashby renders its choice controls with the option list
 * absent until the menu is opened. Measured on OpenAI's "Software Engineer, Internal Applications -
 * Enterprise" (posting db053b0e-c1a5-4b7a-bcb6-6e766629e7b1) on 2026-09-01: the required control
 * "Applicant Arbitration Agreement Acknowledgement" reached the packet with no options, became a
 * `missing_exact_options` metadata blocker, and the dashboard's "read the employer fields again"
 * button re-ran the same deterministic family-gated pass forever. A hold with no exit.
 *
 * WHY THE UNDOCUMENTED ENDPOINT. Ashby's documented posting API
 * (api.ashbyhq.com/posting-api/job-board/<org>, already used by jobMonitor for ingest) publishes
 * titles, locations and descriptions and NO application form at all - verified against the live
 * response, whose job records carry no form key of any kind. The form definition is only available
 * from the same host the applicant's own browser asks, which is the GraphQL route below. That is a
 * read of a public page's own data source, unauthenticated and applicant-free, and it is the only
 * way to learn the employer's accepted values without opening a browser.
 */

/* ONE normalization, shared with the Greenhouse reader rather than re-spelled. If the two readers
 * keyed labels differently, the same employer wording would join under one and miss under the
 * other, and the difference would only ever show up as a silently unattached option list. */
import { greenhousePublicQuestionLabelKey } from './greenhousePublicApplication';

export const ashbyPublicQuestionLabelKey = greenhousePublicQuestionLabelKey;

export const ASHBY_PUBLIC_APPLICATION_SCHEMA_TIMEOUT_MS = 10_000;

const ASHBY_JOB_BOARD_HOST = 'jobs.ashbyhq.com';
const ASHBY_POSTING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* The employer-question witnesses. A real Ashby application form always addresses the applicant's
 * name, email and resume through Ashby's OWN reserved paths; employer-authored questions carry a
 * UUID path instead. Requiring all three distinguishes a complete form definition from a partial or
 * intermediary response that merely happens to contain a `sections` array - the same discipline
 * parseGreenhousePublicApplicationSchema applies with first_name/last_name/email/resume. */
const ASHBY_SYSTEM_FIELD_WITNESSES = ['_systemfield_name', '_systemfield_email', '_systemfield_resume'];

const ASHBY_APPLICATION_FORM_QUERY = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    applicationForm { sections { fieldEntries { field isRequired } } }
  }
}`;

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

/**
 * The organization and posting an Ashby application URL names.
 *
 * Deliberately the same shape canonicalSupportedPortalUrl accepts for the ashby family:
 * `jobs.ashbyhq.com/<org>/<postingId>` with an optional trailing `/application`. Anything else -
 * another host, a listing page, a deeper path - is not a posting this reader can name, and it
 * answers null rather than guessing an organization out of a hostname.
 */
export function ashbyPostingFromUrl(
  rawUrl: string | undefined,
): { organization: string; jobPostingId: string } | null {
  const url = parsedHttpsUrl(rawUrl);
  if (!url || url.hostname.toLowerCase() !== ASHBY_JOB_BOARD_HOST) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 && !(parts.length === 3 && parts[2] === 'application')) return null;
  const [organization, jobPostingId] = parts;
  if (!organization || !ASHBY_POSTING_ID_RE.test(jobPostingId ?? '')) return null;
  return { organization, jobPostingId };
}

export type AshbyPublicApplicationSchema = {
  /** The employer's exact accepted values, keyed by normalized question label. */
  optionsByLabel: Record<string, string[]>;
  /** Labels deliberately WITHOUT an option list because the employer accepts more than one. */
  multiSelectLabels: string[];
};

function ashbyFieldOptions(field: Record<string, unknown>): string[] {
  const values = Array.isArray(field.selectableValues) ? field.selectableValues : [];
  const options: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    // An archived value is one the employer has retired. It is still returned, and it is not on the
    // live control, so offering it would be inventing a choice the form does not accept.
    if (record.isArchived === true) continue;
    const label = trimmed(record.label);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(label);
  }
  return options;
}

function ashbyFormFields(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const form = (value as Record<string, unknown>).applicationForm;
  if (!form || typeof form !== 'object' || Array.isArray(form)) return [];
  const sections = (form as Record<string, unknown>).sections;
  if (!Array.isArray(sections)) return [];
  return sections.flatMap((section) => {
    if (!section || typeof section !== 'object' || Array.isArray(section)) return [];
    const entries = (section as Record<string, unknown>).fieldEntries;
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const field = (entry as Record<string, unknown>).field;
      return field && typeof field === 'object' && !Array.isArray(field)
        ? [field as Record<string, unknown>]
        : [];
    });
  });
}

/**
 * Parse one complete `ApiJobPosting` response into the employer's published option lists.
 *
 * TWO DELIBERATE REFUSALS, both of which keep a control fail-closed rather than half-answered:
 *
 * 1. A field the employer marked `isMany` is skipped. Ashby's MultiValueSelect is single-choice
 *    when isMany is false (both of OpenAI's attestations are), and a genuine multi-select is a
 *    control Litos has already decided it "will not reduce to one answer". Attaching a list to one
 *    would let the single-value fill path answer a question that wants several, so it keeps its
 *    metadata blocker and the applicant handles it on the employer's page.
 * 2. A label two fields share is dropped from BOTH. This mirrors attachManagedFieldOptions'
 *    refusal to attach one list to two controls sharing a durable id: an ambiguous join is worse
 *    than no join, because the wrong employer's option list on a control is unfalsifiable downstream.
 */
export function parseAshbyPublicApplicationSchema(
  value: unknown,
): AshbyPublicApplicationSchema | null {
  const fields = ashbyFormFields(value);
  if (fields.length === 0) return null;

  const paths = new Set(fields.map((field) => trimmed(field.path)).filter(Boolean));
  if (!ASHBY_SYSTEM_FIELD_WITNESSES.every((witness) => paths.has(witness))) return null;

  const optionsByLabel: Record<string, string[]> = {};
  const multiSelectLabels: string[] = [];
  const ambiguousLabels = new Set<string>();
  const seenLabels = new Set<string>();

  for (const field of fields) {
    const labelKey = ashbyPublicQuestionLabelKey(field.title);
    if (!labelKey) continue;
    if (seenLabels.has(labelKey)) ambiguousLabels.add(labelKey);
    seenLabels.add(labelKey);
    const options = ashbyFieldOptions(field);
    if (options.length === 0) continue;
    if (field.isMany === true) {
      if (!multiSelectLabels.includes(labelKey)) multiSelectLabels.push(labelKey);
      continue;
    }
    optionsByLabel[labelKey] = options;
  }

  for (const label of ambiguousLabels) delete optionsByLabel[label];

  return { optionsByLabel, multiSelectLabels };
}

export async function ashbyPublicApplicationSchemaForPosting(
  posting: { organization: string; jobPostingId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<AshbyPublicApplicationSchema | null> {
  const response = await fetchImpl(
    `https://${ASHBY_JOB_BOARD_HOST}/api/non-user-graphql?op=ApiJobPosting`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationName: 'ApiJobPosting',
        variables: {
          organizationHostedJobsPageName: posting.organization,
          jobPostingId: posting.jobPostingId,
        },
        query: ASHBY_APPLICATION_FORM_QUERY,
      }),
      signal: AbortSignal.timeout(ASHBY_PUBLIC_APPLICATION_SCHEMA_TIMEOUT_MS),
    },
  );
  if (!response.ok) return null;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return null;
  }
  /* GraphQL answers 200 with an `errors` array for a schema or lookup failure, so the HTTP status
   * above proves nothing on its own. A partial `data` beside errors is exactly the intermediary
   * response the witness check exists to reject, and rejecting it here is cheaper and clearer. */
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (Array.isArray((parsed as Record<string, unknown>).errors)) return null;
  const data = (parsed as Record<string, unknown>).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return parseAshbyPublicApplicationSchema((data as Record<string, unknown>).jobPosting);
}

/** Read the employer-published schema without submission credentials or applicant data. */
export async function ashbyPublicApplicationSchema(
  rawUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<AshbyPublicApplicationSchema | null> {
  const posting = ashbyPostingFromUrl(rawUrl);
  return posting ? ashbyPublicApplicationSchemaForPosting(posting, fetchImpl) : null;
}
