/**
 * Read-only Lever job-board application metadata.
 *
 * The exact sibling of ashbyPublicApplication.ts, for the same reason: the browser preparation path
 * needs the employer-published question schema beside the live DOM read, and keeping that read here
 * keeps send-capable code out of the browser runner. No submission serializer, no authenticated
 * transport, no applicant data on the wire - one GET of the posting's own public apply page.
 *
 * WHY LEVER NEEDS THIS. Lever's hosted apply page (jobs.lever.co/<site>/<posting>/apply) is
 * server-rendered: every custom-question control is in the HTML with its full option inventory,
 * `<select name="cards[<card>][fieldN]">` with its `<option>`s and `<input type="radio">` groups
 * with their `<span class="application-answer-alternative">` texts. Discovery's DOM walk, however,
 * reports a closed control's options COMPLETE only when it could enumerate them, and Lever's
 * university dropdown defeats that: measured live 2026-09-04 on Belvedere Trading's Software
 * Engineer Intern - Summer 2027 (packet c4413bff, `cards[6d127747-...][field9]`), the "Name of
 * School" select carries 2,965 options and reached the packet as `missing_exact_options` with
 * `portal_input_type: combobox`, so a required control the applicant's own profile answers exactly
 * ("University of Southern California" is one of the 2,965) was left blank on every fill. The
 * employer's own page already lists every accepted value; this reads that list.
 *
 * Read-only and fail-closed: a URL that is not a Lever posting, any fetch failure, a page without
 * the apply form's own witnesses, an ambiguous label (two controls with the same wording) all leave
 * a control exactly as the live DOM read left it. This module never invents an option: every value
 * it publishes is a `<option>` or a radio/checkbox alternative the employer rendered.
 */

/* ONE normalization, shared with the Greenhouse and Ashby readers rather than re-spelled, plus
 * Lever's own required marker. Lever renders "required" as a trailing `<span class="required">✱</span>`
 * inside the label, and the live DOM read keeps that glyph in the discovered label ("name of school
 * ✱", measured on the same packet), so the marker is stripped on BOTH sides of the join by the same
 * function - a key computed from the published label and one computed from the discovered label
 * must agree byte for byte or the list silently never attaches. */
import { greenhousePublicQuestionLabelKey } from './greenhousePublicApplication';

export function leverPublicQuestionLabelKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return greenhousePublicQuestionLabelKey(value.replace(/[✱*]/g, ' '));
}

export const LEVER_PUBLIC_APPLICATION_SCHEMA_TIMEOUT_MS = 10_000;

const LEVER_HOSTS = new Set(['jobs.lever.co', 'jobs.eu.lever.co']);
const LEVER_POSTING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LeverPublicApplicationSchema = {
  /** The employer's exact accepted values, keyed by normalized question label. */
  optionsByLabel: Record<string, string[]>;
};

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
 * The site and posting a Lever application URL names.
 *
 * Deliberately the same shape the lever portal family accepts: `jobs.lever.co/<site>/<postingId>`
 * with an optional trailing `/apply`, on the US or EU host. Anything else - another host, a listing
 * page, a deeper path - is not a posting this reader can name, and it answers null rather than
 * guessing.
 */
export function leverPostingFromUrl(
  rawUrl: string | undefined,
): { host: string; site: string; postingId: string } | null {
  const url = parsedHttpsUrl(rawUrl);
  if (!url || !LEVER_HOSTS.has(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 && !(parts.length === 3 && parts[2] === 'apply')) return null;
  const [site, postingId] = parts;
  if (!site || !/^[a-z0-9][a-z0-9._-]*$/i.test(site) || !LEVER_POSTING_ID_RE.test(postingId ?? '')) return null;
  return { host: url.hostname.toLowerCase(), site, postingId: postingId!.toLowerCase() };
}

/** The apply form's own witnesses: the form element and the resume control every Lever apply page renders. */
const LEVER_APPLY_FORM_WITNESSES = [
  // `<form id="application-form" enctype="multipart/form-data" method="POST">` on the live page,
  // measured 2026-09-04; the class form is accepted too in case a tenant theme renames the id.
  /<form\b[^>]*\b(?:id|class)="[^"]*\bapplication-form\b[^"]*"/i,
  /name="resume"/i,
];

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)));
}

function visibleText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * The question text a control sits under: the last `application-label … <div class="text">…</div>`
 * rendered before it. Lever puts exactly one such label ahead of each custom question's control
 * block, so the nearest one behind the control is its own; the window is bounded so a control with
 * no label of its own (the EEO selects, which Lever labels differently) cannot borrow the previous
 * question's wording.
 */
function nearestQuestionLabel(html: string, controlIndex: number, ownGroupName?: string): string | undefined {
  const windowStart = Math.max(0, controlIndex - 1_500);
  const before = html.slice(windowStart, controlIndex);
  const labels = [...before.matchAll(/<div class="application-label[^"]*">\s*<div class="text">([\s\S]*?)<\/div>/g)];
  const last = labels[labels.length - 1];
  if (!last) return undefined;
  /* Another question's control between the label and this control means the label is not ours -
   * the EEO selects at the foot of the page, for instance, sit after the last custom question's
   * radios with no `application-label` of their own, and must not borrow that question's wording.
   * The only controls allowed in between are this radio/checkbox group's OWN earlier inputs. */
  const afterLabel = before.slice((last.index ?? 0) + last[0].length);
  for (const control of afterLabel.matchAll(/<(select|textarea|input)\b([^>]*)>/gi)) {
    const attributes = control[2];
    if (control[1].toLowerCase() === 'input') {
      if (/\btype="hidden"/i.test(attributes)) continue;
      const name = /\bname="([^"]+)"/i.exec(attributes)?.[1];
      if (ownGroupName && name === ownGroupName && /\btype="(?:radio|checkbox)"/i.test(attributes)) continue;
    }
    return undefined;
  }
  return visibleText(last[1]) || undefined;
}

function addOptions(
  optionsByLabel: Record<string, string[]>,
  ambiguous: Set<string>,
  seen: Set<string>,
  label: string | undefined,
  options: readonly string[],
): void {
  const key = leverPublicQuestionLabelKey(label);
  if (!key) return;
  if (seen.has(key)) {
    ambiguous.add(key);
    return;
  }
  seen.add(key);
  if (options.length > 0) optionsByLabel[key] = [...options];
}

/**
 * Parse one Lever apply page into the employer's published option lists.
 *
 * Two control shapes, both read exactly as rendered:
 *  - `<select>`: every `<option>` whose `value` is non-empty. Lever's placeholder ("Select...") has
 *    an empty value and is not a choice the form accepts.
 *  - radio and checkbox groups, grouped by `name`: each input's rendered alternative text, falling
 *    back to its `value`, which on Lever is the same string.
 * A label two controls share is dropped from both, the same refusal the Ashby reader makes: an
 * ambiguous join is worse than none. Returns null when the page is not a Lever apply form at all
 * (unknown), and an empty map when it is one with no closed controls (known, nothing to attach).
 */
export function parseLeverPublicApplicationSchema(html: unknown): LeverPublicApplicationSchema | null {
  if (typeof html !== 'string' || !LEVER_APPLY_FORM_WITNESSES.every((witness) => witness.test(html))) return null;
  const optionsByLabel: Record<string, string[]> = {};
  const ambiguous = new Set<string>();
  const seen = new Set<string>();

  for (const match of html.matchAll(/<select\b[^>]*>([\s\S]*?)<\/select>/gi)) {
    const options: string[] = [];
    for (const option of match[1].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
      const value = /\bvalue="([^"]*)"/i.exec(option[1])?.[1] ?? '';
      if (value.trim() === '') continue;
      const text = visibleText(option[2]) || decodeEntities(value).trim();
      if (text && !options.includes(text)) options.push(text);
    }
    addOptions(optionsByLabel, ambiguous, seen, nearestQuestionLabel(html, match.index ?? 0), options);
  }

  const groups = new Map<string, { index: number; options: string[] }>();
  for (const match of html.matchAll(/<input\b([^>]*\btype="(?:radio|checkbox)"[^>]*)>/gi)) {
    const attributes = match[1];
    const name = /\bname="([^"]+)"/i.exec(attributes)?.[1];
    if (!name) continue;
    const value = decodeEntities(/\bvalue="([^"]*)"/i.exec(attributes)?.[1] ?? '').trim();
    const tail = html.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 400);
    const alternative = /<span class="application-answer-alternative">([\s\S]*?)<\/span>/i.exec(tail)?.[1];
    const text = (alternative ? visibleText(alternative) : '') || value;
    const group = groups.get(name) ?? { index: match.index ?? 0, options: [] };
    if (text && !group.options.includes(text)) group.options.push(text);
    groups.set(name, group);
  }
  for (const [name, group] of groups) {
    addOptions(optionsByLabel, ambiguous, seen, nearestQuestionLabel(html, group.index, name), group.options);
  }

  for (const key of ambiguous) delete optionsByLabel[key];
  return { optionsByLabel };
}

export async function leverPublicApplicationSchemaForPosting(
  posting: { host: string; site: string; postingId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<LeverPublicApplicationSchema | null> {
  if (!LEVER_HOSTS.has(posting.host)) return null;
  const response = await fetchImpl(
    `https://${posting.host}/${encodeURIComponent(posting.site)}/${posting.postingId}/apply`,
    {
      method: 'GET',
      headers: { accept: 'text/html' },
      redirect: 'manual',
      signal: AbortSignal.timeout(LEVER_PUBLIC_APPLICATION_SCHEMA_TIMEOUT_MS),
    },
  );
  if (!response.ok) return null;
  let html: string;
  try {
    html = await response.text();
  } catch {
    return null;
  }
  return parseLeverPublicApplicationSchema(html);
}

/** Read the employer-published schema without submission credentials or applicant data. */
export async function leverPublicApplicationSchema(
  rawUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<LeverPublicApplicationSchema | null> {
  const posting = leverPostingFromUrl(rawUrl);
  return posting ? leverPublicApplicationSchemaForPosting(posting, fetchImpl) : null;
}
