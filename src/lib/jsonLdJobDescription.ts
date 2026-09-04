/**
 * Host-agnostic job description sourcing for POST /jobs/extract: any `https://` posting URL whose
 * page carries a schema.org `JobPosting` JSON-LD block, read the same way Recruitee's own step
 * (recruiteeJobDescription.ts) already reads Recruitee's - generalized because the JSON-LD block
 * itself is not a Recruitee invention, and a SECOND ATS was measured hitting the exact same defect
 * this session.
 *
 * MEASURED LIVE 2026-09-04. The dashboard's "Read job" refused a Teamtailor posting
 * (`https://sendsafely.teamtailor.com/jobs/1593900-software-development-internship`) with the
 * identical guard sentence Recruitee hit: "Litos could not find a stated requirement on that page."
 * Fetching that page directly (plain `curl`, read-only, no application action) shows it carries
 * exactly one `<script type="application/ld+json">` block, `@type: "JobPosting"`, same schema.org
 * shape Recruitee's own postings use. Generalizing the structured-source step to read that block
 * on ANY page - not a hand-maintained per-ATS list - fixes this one and, going forward, any other
 * ATS that publishes the same standard markup without this file needing to know its name.
 *
 * TWO THINGS MEASURED ON TEAMTAILOR'S BLOCK THAT RECRUITEE'S NEVER SHOWED, both required to read
 * the SendSafely posting at all (see fixtures/teamtailor-sendsafely-internship.json - the full raw
 * page, fetched live, byte for byte except one redacted per-request CSRF token that carries no
 * posting information and this reader never touches):
 *
 *   1. HTML-DOUBLE-ESCAPED DESCRIPTION. Recruitee's JSON-LD `description` is raw HTML already
 *      (`<p>...`). Teamtailor's is HTML-escaped ON TOP of that (`&lt;p&gt;...`) - the literal text
 *      "&lt;p&gt;", not a live `<p>` tag. recruiteeHtmlToText's tag-boundary regexes only match a
 *      real `<`, so handed this string unchanged they see one tagless paragraph and reproduce the
 *      exact zero-candidate failure this whole structured-source approach exists to avoid. See
 *      `unescapeDoubleEncodedHtml` below - it decodes once, ONLY when the text shows this exact
 *      escaped-tag shape, before the normal (unmodified) HTML-to-text conversion runs.
 *
 *   2. A RAW CONTROL CHARACTER INSIDE THE JSON STRING. Teamtailor's `description` value contains a
 *      literal, unescaped newline byte between two HTML-escaped tags. That is invalid JSON (RFC
 *      8259 S7 requires control characters inside a string to be escaped) and both Node's and every
 *      browser's native `JSON.parse` throw a SyntaxError on it verbatim - confirmed directly against
 *      this exact live block. Reusing Recruitee's reader's own catch-and-skip behavior here would
 *      silently treat a REAL JobPosting block as if the page had none. See
 *      `sanitizeControlCharactersInJsonStrings` below: a strict parse is tried first (the common,
 *      well-formed case, Recruitee included, pays nothing extra), and only on failure does this
 *      escape bare control characters found INSIDE a string literal - never anything outside one,
 *      where such bytes are already just insignificant JSON whitespace - and retry.
 *
 * WHY TEAMTAILOR GETS NO API-BASED FALLBACK THE WAY RECRUITEE DOES. Recruitee keeps its own
 * `/api/offers/<slug>` step (recruiteeJobDescription.ts, unchanged by this file) because that
 * endpoint answers for the ONE posting a caller asked about. Teamtailor's closest public
 * equivalent, checked live on this exact tenant 2026-09-04, is `https://<tenant>.teamtailor.com/
 * jobs.json` - a real, documented, versioned format (JSON Feed, jsonfeed.org/version/1.1, `content-
 * type: application/feed+json`) - but it is a TENANT-WIDE listing, not a per-posting lookup, and on
 * sendsafely.teamtailor.com it does not include this exact posting: the feed returns exactly one
 * item ("Join Our Talent Network"), and the tenant's own server-rendered `/jobs` page lists the same
 * single posting. The software-development-internship posting is real, live, and publicly reachable
 * at its direct URL (confirmed: plain `curl`, HTTP 200, full JSON-LD present) - it is simply absent
 * from both of the tenant's own indexes, for reasons this repo cannot see from outside (closed to
 * new listing but left live for in-flight applicants is one plausible explanation; there may be
 * others). A listing endpoint that does not reliably contain the one posting a caller pasted is not
 * a usable per-URL fallback, so none is added here - matching this task's own instruction that
 * JSON-LD alone is fine when nothing more specific is reliable. If a future need shows jobs.json is
 * usable for OTHER tenants, that is a new, separate, additive step - not a reason to have blocked on
 * one here.
 *
 * BEST-EFFORT BY THE SAME RULE AS fetchRecruiteeJobDescription AND findMonitoredJobDescription: not
 * HTTPS, any fetch failure, no JobPosting block, an ambiguous multi-JobPosting page with no match
 * for the requested URL, or a result that itself states no requirement (checked by the caller, not
 * this file) all return `undefined`, and the caller falls through to whatever the next step is. This
 * module may only ever short-circuit with a GOOD result; it must never introduce a new failure mode
 * a URL would not already have hit.
 *
 * PORTAL_URL IS NEVER TOUCHED HERE, same rule as jobDescriptionSourceUrl and
 * fetchRecruiteeJobDescription: this reads exactly the URL it is given, for extraction only, and
 * never rewrites or returns a different one for the caller to store.
 */

import { recruiteeHtmlToText as htmlToText, decodeHtmlEntities } from './recruiteeJobDescription';

/**
 * Escapes bare control characters (U+0000-U+001F) found INSIDE a JSON string literal, leaving
 * everything outside a string untouched - such bytes are already just insignificant whitespace
 * between tokens under the JSON grammar (RFC 8259 S2), including the ordinary newlines any
 * pretty-printed JSON-LD block uses between object members.
 *
 * MEASURED LIVE 2026-09-04 (see this file's header): Teamtailor's own JobPosting block contains a
 * literal, unescaped newline inside its `description` string. Both Node's and every browser's
 * native `JSON.parse` reject that verbatim - not a parser bug, the document is malformed JSON by
 * spec - which is why callers try a strict parse first and only reach for this on failure: it
 * performs the same narrow repair a lenient consumer would, and cannot alter meaning anywhere a
 * strict parser would have accepted the input unchanged.
 *
 * A small hand-rolled string-boundary scan rather than a regex, specifically so an ESCAPED quote
 * (`\"`) inside a string can never be mistaken for the string's end - the one detail that makes a
 * regex-based version of this unsafe.
 */
export function sanitizeControlCharactersInJsonStrings(raw: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const code = raw.charCodeAt(i);
    if (inString && escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (inString && ch === '\\') {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString && code < 0x20) {
      switch (ch) {
        case '\n': result += '\\n'; break;
        case '\r': result += '\\r'; break;
        case '\t': result += '\\t'; break;
        case '\b': result += '\\b'; break;
        case '\f': result += '\\f'; break;
        default: result += `\\u${code.toString(16).padStart(4, '0')}`;
      }
      continue;
    }
    result += ch;
  }
  return result;
}

const RAW_HTML_TAG_PATTERN = /<\/?[a-zA-Z][a-zA-Z0-9]*[\s/>]/;
const ESCAPED_HTML_TAG_PATTERN = /&lt;\/?[a-zA-Z][a-zA-Z0-9]*(?:&gt;|;|\s)/;

/**
 * Reveals real HTML in a JSON-LD `description` that was itself HTML-escaped before being placed in
 * the (separately, correctly, JSON-string-escaped) JSON-LD - measured live on Teamtailor's own
 * JobPosting block (this file's header): `&lt;p&gt;...&lt;/p&gt;` literally, not a live `<p>` tag.
 * Handed straight to htmlToText, whose tag-boundary regexes only match a real `<`, that string reads
 * as one giant tagless paragraph - the same shape that made the ORIGINAL managed-browser render
 * fail for Recruitee. Decoding is gated on evidence of exactly this shape - text with a live tag
 * already (Recruitee's own JSON-LD, verified raw HTML on greenflux/envipco/curotec) is returned
 * untouched, and so is plain text with neither pattern - so this never double-decodes a description
 * that did not need it.
 */
export function unescapeDoubleEncodedHtml(value: string): string {
  if (RAW_HTML_TAG_PATTERN.test(value)) return value;
  if (!ESCAPED_HTML_TAG_PATTERN.test(value)) return value;
  return decodeHtmlEntities(value);
}

export type JsonLdJobPostingCandidate = {
  description: string;
  title?: string;
  companyName?: string;
  /** schema.org `url` on the JobPosting itself, when the page states one. */
  url?: string;
  /** schema.org `identifier`, normalized to its plain value whether the page wrote it as a bare
   *  string or (Teamtailor's own shape, measured live) a `PropertyValue` object's `.value`. */
  identifierValue?: string;
};

function identifierValueOf(record: Record<string, unknown>): string | undefined {
  const identifier = record.identifier;
  if (typeof identifier === 'string') return identifier;
  if (identifier && typeof identifier === 'object') {
    const value = (identifier as Record<string, unknown>).value;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function jobPostingCandidateFromRecord(record: Record<string, unknown>): JsonLdJobPostingCandidate | undefined {
  const type = record['@type'];
  const isJobPosting = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
  if (!isJobPosting) return undefined;
  const description = typeof record.description === 'string' ? record.description : '';
  if (!description.trim()) return undefined;
  const title = typeof record.title === 'string' ? record.title : undefined;
  const org = record.hiringOrganization;
  const companyName = (org && typeof org === 'object' && typeof (org as Record<string, unknown>).name === 'string')
    ? (org as Record<string, unknown>).name as string
    : undefined;
  const url = typeof record.url === 'string' ? record.url : undefined;
  return { description, title, companyName, url, identifierValue: identifierValueOf(record) };
}

/**
 * Expands one parsed JSON-LD value into every embedded object, following `@graph` - schema.org's
 * documented way to carry multiple entities in one block - at any level, and a bare top-level array
 * (a page can list `[jobPosting, ...]` directly, or wrap either shape in `@graph`). Not a JobPosting
 * filter itself; jobPostingCandidateFromRecord applies that to whatever this returns.
 */
function flattenJsonLdValue(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLdValue);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const graph = record['@graph'];
  if (Array.isArray(graph)) return graph.flatMap(flattenJsonLdValue);
  return [record];
}

/**
 * Every JobPosting this page's JSON-LD states, across every `<script type="application/ld+json">`
 * block on it - never just the first match, because selectJobPostingForUrl's mismatch-refusal rule
 * needs the FULL set to know whether more than one candidate exists at all.
 */
export function jobPostingCandidatesFromHtml(html: string): JsonLdJobPostingCandidate[] {
  // Function-local (not module-level) specifically because it carries `g` + `.exec` state: a shared
  // regex here would let two concurrent requests interleave through the same `lastIndex`, exactly
  // like jsonLdJobPostingFromHtml's own scan in recruiteeJobDescription.ts.
  const scriptPattern = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const candidates: JsonLdJobPostingCandidate[] = [];
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign -- straightforward regex scan
  while ((match = scriptPattern.exec(html))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      // Strict parse failed - retry once against the control-character-sanitized text (see its own
      // header for why this is needed at all, measured live on Teamtailor) before giving up on this
      // block. A block that is malformed for any OTHER reason still falls through to `continue`.
      try {
        parsed = JSON.parse(sanitizeControlCharactersInJsonStrings(match[1]));
      } catch {
        continue;
      }
    }
    for (const record of flattenJsonLdValue(parsed)) {
      const candidate = jobPostingCandidateFromRecord(record);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function normalizedPath(url: URL): string {
  return url.pathname.replace(/\/+$/, '');
}

/**
 * Whether `candidate` plausibly states it IS `requestedUrl`: its own `url` field resolves to the
 * same origin and path (ignoring a trailing slash, and any query/hash - the same tracking-state
 * tolerance this route's own urlWithoutTrackingState applies elsewhere), or its identifier's value
 * appears in the requested path. The identifier check exists because schema.org leaves `identifier`
 * shape up to the publisher and at least one real page has no `url` field to check at all:
 * Teamtailor's own live JobPosting (fixtures/teamtailor-sendsafely-internship.json) carries no `url`
 * whatsoever and a structured `identifier.value` ("1593900") that IS the numeric id in its own
 * posting path - a bare string-equality check against `identifier` would never have matched it. An
 * identifier under 3 characters is never trusted alone - too likely to appear in an unrelated URL by
 * coincidence.
 */
export function jobPostingMatchesRequestedUrl(candidate: JsonLdJobPostingCandidate, requestedUrl: string): boolean {
  let target: URL;
  try {
    target = new URL(requestedUrl);
  } catch {
    return false;
  }
  if (candidate.url) {
    try {
      const candidateUrl = new URL(candidate.url, target);
      if (candidateUrl.origin === target.origin && normalizedPath(candidateUrl) === normalizedPath(target)) {
        return true;
      }
    } catch {
      // A malformed `url` field is not fatal to the match - fall through to the identifier check.
    }
  }
  if (candidate.identifierValue && candidate.identifierValue.length >= 3) {
    if (target.pathname.includes(candidate.identifierValue)) return true;
  }
  return false;
}

/**
 * One candidate is unambiguous and is returned as-is - matching how Recruitee's own JSON-LD reader
 * has always behaved (jsonLdJobPostingFromHtml takes the first JobPosting it finds, no URL check at
 * all), and required to read a real page like Teamtailor's SendSafely posting, whose sole JobPosting
 * carries no `url` field to check against. More than one candidate makes the page's own claim
 * ambiguous on its face - `@graph` can legitimately list unrelated entities together, and nothing
 * stops two DIFFERENT postings' JSON-LD both being present (a "similar roles" widget, for one) - so
 * this only trusts whichever one states it IS the requested URL; none doing so is a refusal, not a
 * guess at which one the caller meant.
 */
export function selectJobPostingForUrl(
  candidates: JsonLdJobPostingCandidate[],
  requestedUrl: string,
): JsonLdJobPostingCandidate | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  return candidates.find((candidate) => jobPostingMatchesRequestedUrl(candidate, requestedUrl));
}

// Generous enough for a plain unauthenticated GET, short enough that a slow/hanging host cannot
// meaningfully delay the existing fallback steps this sits in front of. Same value
// recruiteeJobDescription.ts uses for the same reason; kept as this file's own constant (rather than
// imported) because this step is not Recruitee-specific and should not read as if it were.
const JSON_LD_FETCH_TIMEOUT_MS = 6_000;
const JSON_LD_FETCH_USER_AGENT = 'LitosJobExtract/1.0';

/** `undefined` on ANY failure - network error, timeout, or non-2xx - never a thrown error, matching
 *  fetchText in recruiteeJobDescription.ts so this step is pure best-effort for its caller too. */
async function fetchHtml(url: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JSON_LD_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'text/html', 'User-Agent': JSON_LD_FETCH_USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return await response.text();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export type JsonLdJobDescription = {
  jdText: string;
  pageTitle: string;
  companyName: string;
};

/**
 * Best-effort structured job description for ANY `https://` posting URL, sourced from a schema.org
 * `JobPosting` JSON-LD block on the page itself. Host-agnostic by design: not a hand-maintained list
 * of ATS families, and deliberately sits ahead of any ATS-specific step (Recruitee's own, below it
 * in jobExtract.ts) for the same reason the monitored-inventory lookup sits ahead of everything -
 * cheaper and more general than what follows, so a deployment without a managed browser can still
 * answer here first.
 *
 * `undefined` covers every non-good outcome, exactly like fetchRecruiteeJobDescription and
 * findMonitoredJobDescription: not HTTPS, unparseable URL, fetch failure, no JobPosting block on the
 * page, or an ambiguous multi-JobPosting page with no match for this URL. The caller applies
 * leadRequirementCandidates itself (same guard, same place, for every structured source this route
 * has) - this function's job is only to produce the best text the page's own JSON-LD states, never
 * to judge whether that text states a requirement.
 */
export async function fetchJsonLdJobDescription(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JsonLdJobDescription | undefined> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;

  const html = await fetchHtml(rawUrl, fetchImpl);
  if (!html) return undefined;

  const chosen = selectJobPostingForUrl(jobPostingCandidatesFromHtml(html), rawUrl);
  if (!chosen) return undefined;

  const jdText = htmlToText(unescapeDoubleEncodedHtml(chosen.description));
  if (!jdText) return undefined;

  return {
    jdText,
    pageTitle: (chosen.title ?? '').trim(),
    companyName: (chosen.companyName ?? '').trim(),
  };
}
