/**
 * Job description sourcing for POST /jobs/extract from an ALLOWLISTED hosted-ATS `https://` posting
 * URL (see ALLOWED_JSON_LD_HOSTS below) whose page carries a schema.org `JobPosting` JSON-LD block,
 * read the same way Recruitee's own step (recruiteeJobDescription.ts) already reads Recruitee's -
 * generalized because the JSON-LD block itself is not a Recruitee invention, and a SECOND ATS was
 * measured hitting the exact same defect this session.
 *
 * NO LONGER HOST-AGNOSTIC (2026-09-04 review round 1, finding 1). This module fetched any `https://`
 * URL a caller pasted, straight through the global `fetch`, until a spy fetch proved that reached
 * 169.254.169.254 (the cloud metadata address), 127.0.0.1:6379 and localhost:9200 unblocked - real
 * SSRF, not a hypothetical one. The rest of this header still describes the JSON-LD reading logic
 * accurately; only how far this module reaches to fetch a page has changed. See
 * ALLOWED_JSON_LD_HOSTS and fetchJsonLdJobDescription's own docstring below for what changed and why
 * a company-hosted page outside the allowlist is not a regression: it still gets read, by the
 * existing managed-browser path, which runs in an isolated remote browser rather than this process.
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
import {
  fetchPublic, safeHttpsUrl, defaultResolveHost, MAX_HTML_BYTES, type ResolveHost,
} from './jobSourceLogoVerification';
import { parsedJsonLdScriptBlocks, sanitizeControlCharactersInJsonStrings } from './jsonLdScriptBlocks';

// Re-exported for backward compatibility: this function's canonical home is now
// jsonLdScriptBlocks.ts (2026-09-04 review round 1, finding 4 - shared with
// recruiteeJobDescription.ts's own JSON-LD reader, which gained the same control-character repair as
// part of sharing ONE script-block extractor), but existing importers of it from this file (this
// file's own test suite included) keep working unchanged.
export { sanitizeControlCharactersInJsonStrings };

const RAW_HTML_TAG_PATTERN = /<\/?[a-zA-Z][a-zA-Z0-9]*[\s/>]/;
// Anchored to the START of the text (2026-09-04 review round 1, finding 2): the earlier, unanchored
// version (`&lt;\/?[a-zA-Z][a-zA-Z0-9]*(?:&gt;|;|\s)/`, tested with `.test()` anywhere in the string)
// matched ordinary prose that merely MENTIONS an escaped tag - "In HTML, &lt;div&gt; is a block
// container while &lt;span&gt; is inline." - and decodeHtmlEntities then unescaped the ENTIRE string,
// turning those two mentions into live `<div>`/`<span>` text. htmlToText's tag-stripping regexes then
// deleted "div" and "span" as if they were real markup, corrupting a sentence that was never HTML to
// begin with. A genuinely HTML-escaped description (Teamtailor's own shape - this file's header)
// STARTS with its outermost escaped tag; prose that only mentions one somewhere in the middle does
// not. Requiring the match at the very start (allowing only leading whitespace) is what tells the two
// apart.
const ESCAPED_FRAGMENT_START_PATTERN = /^\s*&lt;(?:p|div|ul|ol|li|h[1-6]|br|strong|em|span)\b/i;

/**
 * Reveals real HTML in a JSON-LD `description` that was itself HTML-escaped before being placed in
 * the (separately, correctly, JSON-string-escaped) JSON-LD - measured live on Teamtailor's own
 * JobPosting block (this file's header): `&lt;p&gt;...&lt;/p&gt;` literally, not a live `<p>` tag.
 * Handed straight to htmlToText, whose tag-boundary regexes only match a real `<`, that string reads
 * as one giant tagless paragraph - the same shape that made the ORIGINAL managed-browser render
 * fail for Recruitee. Decoding is gated on evidence that the description AS A WHOLE is an escaped
 * HTML fragment - it starts with an escaped block/inline-structure tag AND carries no live `<` tag
 * anywhere (RAW_HTML_TAG_PATTERN, checked first) - not merely that it contains an escaped-looking
 * substring somewhere. Text with a live tag already (Recruitee's own JSON-LD, verified raw HTML on
 * greenflux/envipco/curotec), plain text with neither pattern, and prose that only MENTIONS an
 * escaped tag without opening with one (finding 2: "In HTML, &lt;div&gt; is a block container..." is
 * not a description that was HTML-escaped, it is a sentence that happens to name a tag) are all
 * returned untouched - so this never double-decodes a description that did not need it, and never
 * decodes prose that was never markup at all.
 */
export function unescapeDoubleEncodedHtml(value: string): string {
  if (RAW_HTML_TAG_PATTERN.test(value)) return value;
  if (!ESCAPED_FRAGMENT_START_PATTERN.test(value)) return value;
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
 *
 * Block-finding and JSON-parsing itself is parsedJsonLdScriptBlocks in jsonLdScriptBlocks.ts (shared
 * with recruiteeJobDescription.ts's own reader, 2026-09-04 review round 1, finding 4); this function's
 * own job is only turning each parsed value into JobPosting candidates.
 */
export function jobPostingCandidatesFromHtml(html: string): JsonLdJobPostingCandidate[] {
  const candidates: JsonLdJobPostingCandidate[] = [];
  for (const parsed of parsedJsonLdScriptBlocks(html)) {
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

/**
 * Hosted ATS SaaS domains this step may fetch server-side (2026-09-04 review round 1, finding 1).
 * An arbitrary company-hosted career page is deliberately NOT on this list: this step used to accept
 * ANY `https://` URL a caller pasted, fetch it with the global `fetch`, follow redirects, and read an
 * unbounded body - a spy fetch proved requests to 169.254.169.254 (the cloud metadata address),
 * 127.0.0.1:6379, localhost:9200 and other internal hostnames were all attempted, unblocked. Every
 * entry below is a multi-tenant ATS vendor whose OWN infrastructure serves every tenant's posting
 * under a shared vendor domain - an employer never controls the DNS or the server behind, say,
 * `*.recruitee.com` - which is what makes "any subdomain of this vendor" a safe pattern where
 * "any domain a caller pastes" is not. A posting on a host not listed here still works exactly as it
 * did before this fix: it falls through to the unchanged managed-browser path, which reads it inside
 * an isolated remote browser rather than this process.
 *
 * A SMALL, hand-kept list on purpose, not an import of portalSubmission.ts's own (unexported) HOSTS
 * map: that map is not exported, pulling it in would couple this lightweight best-effort reader to a
 * 700KB+ submission-engine file for a handful of regexes, and its entries answer a DIFFERENT question
 * (which host may Litos SUBMIT an application to - several of its entries are pinned to one or two
 * exact customer tenants for reasons specific to that ATS's own product surface, e.g. its
 * oraclecloud/bullhorn entries). This list only answers "is this a hosted ATS vendor's own domain", a
 * strictly looser bar, so it stays intentionally short: Recruitee and Teamtailor (measured live, see
 * this file's header), the three other families jobDescriptionSourceUrl already reads a JSON-LD-style
 * posting page from in jobExtract.ts (SEPARATE_FORM_ROUTES: Pinpoint, Breezy, Crelate), and the five
 * other hosted boards most commonly seen publishing this exact schema.org markup on their own posting
 * pages (Greenhouse, Lever, Ashby, SmartRecruiters, Workable) - every one of which portalSubmission.ts
 * already trusts with the STRICTER capability of an autofilled submission, so trusting the same host
 * with a read-only GET here grants nothing new. An ATS missing from this list is a candidate for a
 * follow-up, not a reason to widen it on a guess now.
 */
const ALLOWED_JSON_LD_HOSTS: readonly RegExp[] = [
  // One tenant label only, matching jobDescriptionSourceUrl's own SEPARATE_FORM_ROUTES predicates in
  // jobExtract.ts: excludes each vendor's own www/app/api hosts, and Teamtailor's regional tenants
  // (<tenant>.na.teamtailor.com) are real career sites, same as the bare <tenant>.teamtailor.com
  // shape - both measured live (this file's header). The region bound is 2-4 letters, not just 2,
  // matching portalSubmission.ts's own HOSTS.teamtailor widened 2026-09-05 for the same tenants -
  // this reader and the submission detector must agree on which hosts are Teamtailor's, or a
  // regional posting reads here but is refused there (or the reverse).
  /^(?!(?:www|app|api)\.)[a-z0-9-]+\.recruitee\.com$/i,
  /^(?!(?:www|app|api)\.)[a-z0-9-]+(?:\.[a-z]{2,4})?\.teamtailor\.com$/i,
  /^(?!(?:www|app|api)\.)[a-z0-9-]+\.pinpointhq\.com$/i,
  /^(?!(?:www|app|api)\.)[a-z0-9-]+\.breezy\.hr$/i,
  /^jobs\.crelate\.com$/i,
  // The remaining five match portalSubmission.ts's own HOSTS entries for the same vendors exactly
  // (independently written here, not imported - see this constant's own header for why) - each
  // already trusted there with the STRICTER capability of an autofilled submission.
  /(^|\.)greenhouse\.io$/i,
  /(^|\.)lever\.co$/i,
  /(^|\.)ashbyhq\.com$/i,
  /^jobs\.smartrecruiters\.com$/i,
  /^apply\.workable\.com$/i,
];

function isAllowedJsonLdHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ALLOWED_JSON_LD_HOSTS.some((pattern) => pattern.test(host));
}

/** `undefined` on ANY failure - network error, timeout, non-2xx, blocked/non-public host, oversize
 *  body, or a non-HTML content type - never a thrown error, matching fetchText in
 *  recruiteeJobDescription.ts so this step is pure best-effort for its caller too.
 *
 *  Routed through jobSourceLogoVerification.ts's fetchPublic (2026-09-04 review round 1, finding 1)
 *  rather than calling `fetch` directly: every redirect hop is re-resolved and re-checked against
 *  private/reserved IP ranges and a static blocklist before it is followed, the body is bounded to
 *  MAX_HTML_BYTES while streaming rather than after the fact, and `fetchImpl` left undefined (the
 *  production default - see fetchJsonLdJobDescription below) connects over a DNS-pinned socket that
 *  closes the gap between checking an address and a separate resolver connecting to a different one. */
async function fetchHtml(
  rawUrl: string,
  fetchImpl: typeof fetch | undefined,
  resolveHost: ResolveHost,
): Promise<string | undefined> {
  let url: URL;
  try {
    url = safeHttpsUrl(rawUrl);
  } catch {
    return undefined;
  }
  try {
    const { bytes, contentType } = await fetchPublic(
      url,
      'text/html,application/xhtml+xml',
      MAX_HTML_BYTES,
      fetchImpl,
      resolveHost,
      undefined,
      // Overrides jobSourceLogoVerification.ts's own blockedHostname denylist, which refuses several
      // of these exact ATS vendor domains for that file's own, different reason (see this parameter's
      // own doc comment on publicAddresses) - isAllowedJsonLdHost is checked on every hop instead,
      // including a redirect target, so an allowed host cannot be redirected somewhere this reader's
      // own allowlist would refuse.
      isAllowedJsonLdHost,
    );
    // The Accept header above asks for HTML; a server that answers with something else (an API
    // error page, a JSON body, an image) is not a page this reader can find a <script> block on, and
    // decoding it as text risks treating arbitrary bytes as HTML for no benefit.
    if (!contentType.includes('html')) return undefined;
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

export type JsonLdJobDescription = {
  jdText: string;
  pageTitle: string;
  companyName: string;
};

/**
 * Best-effort structured job description for an ALLOWLISTED `https://` posting URL (see
 * ALLOWED_JSON_LD_HOSTS above), sourced from a schema.org `JobPosting` JSON-LD block on the page
 * itself. Deliberately sits ahead of any ATS-specific step (Recruitee's own, below it in
 * jobExtract.ts) for the same reason the monitored-inventory lookup sits ahead of everything -
 * cheaper and more general than what follows, so a deployment without a managed browser can still
 * answer here first, for every hosted ATS family this step knows rather than only Recruitee.
 *
 * NOT HOST-AGNOSTIC, as of 2026-09-04 review round 1, finding 1 - it read this shape from any host a
 * caller pasted until then, which a spy fetch proved reached 169.254.169.254, 127.0.0.1:6379 and
 * localhost:9200 unblocked. An arbitrary company-hosted page still gets its job description read;
 * it now does so by falling through to the existing managed-browser path below, which runs in an
 * isolated remote browser rather than fetching from this process.
 *
 * `fetchImpl` and `resolveHost` are left undefined by every real caller (jobExtract.ts calls this
 * with just `rawUrl`): fetchHtml then routes through jobSourceLogoVerification.ts's fetchPublic with
 * no overrides, which is what selects its DNS-pinned, redirect-and-byte-bounded transport rather than
 * a bare `fetch`. Both parameters exist only so tests can inject a fetch spy and a fixed DNS answer
 * without a real network call, exactly like verifyCatalogSourceLogo's own test suite already does.
 *
 * `undefined` covers every non-good outcome, exactly like fetchRecruiteeJobDescription and
 * findMonitoredJobDescription: not HTTPS, a host outside the allowlist, unparseable URL, fetch
 * failure, no JobPosting block on the page, or an ambiguous multi-JobPosting page with no match for
 * this URL. The caller applies leadRequirementCandidates itself (same guard, same place, for every
 * structured source this route has) - this function's job is only to produce the best text the
 * page's own JSON-LD states, never to judge whether that text states a requirement.
 */
export async function fetchJsonLdJobDescription(
  rawUrl: string,
  fetchImpl?: typeof fetch,
  resolveHost: ResolveHost = defaultResolveHost,
): Promise<JsonLdJobDescription | undefined> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (!isAllowedJsonLdHost(url.hostname)) return undefined;

  const html = await fetchHtml(rawUrl, fetchImpl, resolveHost);
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
