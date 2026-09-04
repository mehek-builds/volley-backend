/**
 * Recruitee-specific job description sourcing for POST /jobs/extract.
 *
 * MEASURED LIVE 2026-09-04. Pasting a Recruitee posting (`https://gpr.recruitee.com/o/software-
 * engineer-intern`) into "Fill an application" and pressing "Read job" returned jobExtract.ts's
 * generic 502: "Litos could not find a stated requirement on that page." That guard
 * (leadRequirementCandidates, called on whatever runManagedBrowser's `extract: 'body'` step
 * returned) is doing its job - the failure is upstream of it, in what the managed browser handed
 * it.
 *
 * WHY THE MANAGED BROWSER'S TEXT LOSES THE REQUIREMENTS. Recruitee career pages are a heavy
 * SSR/hydration app: fetching a live posting (greenflux.recruitee.com/o/senior-principal-software-
 * engineer, confirmed 2026-09-04, since gpr.recruitee.com now 301s to recruitee.com's own
 * "careers_not_hosted" page and cannot be re-verified directly - see the PR description) shows the
 * SAME description HTML repeated close to twenty times across the raw page: once as the visible
 * DOM, and the rest inside `<script>`-embedded hydration JSON, each copy HTML-escaped one layer
 * deeper than the last. `extract: 'body'` runs in a remote browser this codebase does not control
 * (Browserbase or Stratus - see runManagedBrowser in lib/browserbase.ts); whatever it does to turn
 * that DOM into text, this repo already knows from three unrelated postings (Jane Street, a Lever
 * apply form, a Databricks fixture - all in the block comment above jobExtract.ts's guard) that a
 * page can pass "non-empty" and still not contain a stated requirement by the time it is measured
 * here. Empirically: converting Recruitee's OWN structured description with paragraph and list-item
 * boundaries collapsed - the same shape `Element.textContent` produces, and a plausible shape for
 * whatever this run's extractor does - leaves leadRequirementCandidates with zero candidates on a
 * posting that has twelve when line structure survives. That collapse, or the extractor reading one
 * of the escaped-JSON copies instead of the rendered DOM, are both consistent with what was measured
 * live; this module does not need to know which, because it does not depend on the managed
 * browser's render at all.
 *
 * THE FIX, matching how jobDescriptionSourceUrl above rewrites Workable/Lever/Crelate/etc URLs so
 * the managed browser reads the posting instead of the application form: per ATS, never a blanket
 * rule, and never by weakening leadRequirementCandidates itself. Recruitee publishes the same
 * posting as structured data through two first-party, unauthenticated channels that this route did
 * not previously use:
 *
 *   1. A `<script type="application/ld+json">` JobPosting block on the posting page itself
 *      (schema.org's job-posting markup, present on every live tenant checked: greenflux, envipco,
 *      curotec). Its `description` field is the full posting HTML - description AND requirements
 *      already combined by Recruitee's own renderer.
 *   2. Failing that, Recruitee's public offers API, `https://<tenant>.recruitee.com/api/offers/
 *      <slug>`, documented by Recruitee and used already by this codebase's OWN board-monitoring
 *      poller (normalizeRecruiteeJobs in lib/jobMonitor.ts, against the LIST form of this endpoint).
 *      Its `offer.description` and `offer.requirements` are separate HTML fields.
 *
 * Both are fetched with plain HTTP - no managed browser, no render race, no cost - and converted to
 * text that keeps a hard guarantee the DOM-derived text above could not: every `<p>`, `<li>`,
 * heading, and `<br>` boundary in the source HTML becomes its own line, because splitClauses (the
 * function underneath leadRequirementCandidates) reads one clause per line and drops anything over
 * 300 characters. A paragraph or bullet list flattened onto one line is indistinguishable to that
 * guard from the single giant paragraph it exists to catch.
 *
 * Verified end-to-end against this repo's own leadAlignment.leadRequirementCandidates: the
 * greenflux fixture below (see recruiteeJobDescription.test.ts) converts to 12 accepted
 * requirement candidates through this exact pipeline.
 *
 * BEST-EFFORT BY THE SAME RULE AS findMonitoredJobDescription IN jobExtract.ts: any fetch failure,
 * missing JSON-LD, missing API payload, or a result that itself states no requirement returns
 * `undefined` and the caller falls through to the existing managed-browser path unchanged. This
 * module may only ever short-circuit with a GOOD result; it must never introduce a new failure mode
 * a URL would not already have hit.
 *
 * PORTAL_URL IS NEVER TOUCHED HERE. Exactly like jobDescriptionSourceUrl's own rule: this reads the
 * posting for extraction only. The caller's original pasted URL is what gets stored and submitted
 * against; nothing in this module rewrites or returns it.
 */

export type RecruiteeOfferUrlParts = {
  /** The tenant subdomain label, e.g. `gpr` for `gpr.recruitee.com`. */
  tenant: string;
  /** The offer slug, e.g. `software-engineer-intern`. Verbatim from the URL - not case-folded,
   *  matching how jobDescriptionSourceUrl treats every other ATS's captured path segments. */
  slug: string;
};

// Single DNS label only, and never www/app/api - the vendor's own marketing, product, and API
// hosts, not a tenant's career site. Mirrors the recruitee entry in this file's own
// SEPARATE_FORM_ROUTES host predicate.
const RECRUITEE_OFFER_HOST = /^(?!(?:www|app|api)\.)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.recruitee\.com$/i;
// Accepts the posting route AND its apply route (`/o/<slug>/c/new`, the same shape
// RECRUITEE_APPLICATION_PATH matches above) as the same offer, because both identify one slug and
// this module answers "what does that offer say", not "which page did the operator paste".
const RECRUITEE_OFFER_PATH = /^\/o\/([a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?)(?:\/c\/new)?\/?$/i;

/** Whether `rawUrl` names a Recruitee offer (posting or apply route), and if so its tenant + slug. */
export function recruiteeOfferUrlParts(rawUrl: string): RecruiteeOfferUrlParts | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  const hostname = url.hostname.toLowerCase();
  if (!RECRUITEE_OFFER_HOST.test(hostname)) return undefined;
  const match = url.pathname.match(RECRUITEE_OFFER_PATH);
  if (!match) return undefined;
  const tenant = hostname.slice(0, hostname.length - '.recruitee.com'.length);
  return { tenant, slug: match[1] };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
  middot: '·',
  bull: '•',
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const token = entity.toLowerCase();
    if (token[0] !== '#') return NAMED_ENTITIES[token] ?? match;
    const code = token[1] === 'x'
      ? Number.parseInt(token.slice(2), 16)
      : Number.parseInt(token.slice(1), 10);
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return match;
    // Same drop-not-emit rule as jobMonitor.ts's decodeEntities: these code points cannot round
    // trip and do not belong in a job description either way.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return '';
    if (code >= 0x7f && code <= 0x9f) return '';
    if (code >= 0xd800 && code <= 0xdfff) return '';
    return String.fromCodePoint(code);
  });
}

/**
 * Recruitee's own editor happened to wrap every bullet's text in its own inner `<p>` on every live
 * posting checked (greenflux, envipco), which would make `</p>` alone enough to line-break a list.
 * Nothing in Recruitee's public contract promises that nesting, so `<li>` gets its own explicit
 * line-break rule rather than relying on it - the one property this converter exists to guarantee is
 * that a list item can never merge onto its neighbor's line regardless of what is nested inside it.
 */
export function recruiteeHtmlToText(html: string): string {
  const withLineBreaks = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|h[1-6]|div|tr)>/gi, '\n')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
  return decodeHtmlEntities(withLineBreaks)
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

type RecruiteeJsonLdJobPosting = {
  description: string;
  title?: string;
  companyName?: string;
};

/** The `JobPosting` block schema.org markup, if the page carries one with a non-empty description. */
function jsonLdJobPostingFromHtml(html: string): RecruiteeJsonLdJobPosting | undefined {
  // Function-local (not module-level) specifically because it carries `g` + `.exec` state: a
  // shared regex here would let two concurrent requests interleave through the same `lastIndex`.
  const scriptPattern = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign -- straightforward regex scan
  while ((match = scriptPattern.exec(html))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const record = candidate as Record<string, unknown>;
      const type = record['@type'];
      const isJobPosting = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
      if (!isJobPosting) continue;
      const description = typeof record.description === 'string' ? record.description : '';
      if (!description.trim()) continue;
      const title = typeof record.title === 'string' ? record.title : undefined;
      const org = record.hiringOrganization;
      const companyName = (org && typeof org === 'object' && typeof (org as Record<string, unknown>).name === 'string')
        ? (org as Record<string, unknown>).name as string
        : undefined;
      return { description, title, companyName };
    }
  }
  return undefined;
}

type RecruiteeOfferApiPayload = {
  description: string;
  requirements: string;
  title?: string;
  companyName?: string;
};

/** `{ offer: {...} }` from `GET /api/offers/<slug>`, if it carries a non-empty description or
 *  requirements field. */
function offerFromApiPayload(payload: unknown): RecruiteeOfferApiPayload | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const offer = (payload as Record<string, unknown>).offer;
  if (!offer || typeof offer !== 'object') return undefined;
  const record = offer as Record<string, unknown>;
  const description = typeof record.description === 'string' ? record.description : '';
  const requirements = typeof record.requirements === 'string' ? record.requirements : '';
  if (!description.trim() && !requirements.trim()) return undefined;
  const title = typeof record.title === 'string' ? record.title : undefined;
  const companyName = typeof record.company_name === 'string' ? record.company_name : undefined;
  return { description, requirements, title, companyName };
}

// Generous enough for a plain unauthenticated GET, short enough that a slow/hanging tenant cannot
// meaningfully delay the existing managed-browser fallback this sits in front of.
const RECRUITEE_FETCH_TIMEOUT_MS = 6_000;
const RECRUITEE_FETCH_USER_AGENT = 'LitosJobExtract/1.0';

/** `undefined` on ANY failure - network error, timeout, non-2xx, or a signal-ignoring test double -
 *  never a thrown error, so callers can treat this as pure best-effort without their own try/catch
 *  for this step specifically. */
async function fetchText(url: string, fetchImpl: typeof fetch, accept: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECRUITEE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: accept, 'User-Agent': RECRUITEE_FETCH_USER_AGENT },
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

export type RecruiteeJobDescription = {
  jdText: string;
  pageTitle: string;
  companyName: string;
};

/**
 * Best-effort structured job description for a Recruitee offer URL. `undefined` when `rawUrl` is
 * not a Recruitee offer, when neither source is reachable, or when what both sources returned still
 * states no requirement - every one of those is the caller's cue to fall through to the existing
 * managed-browser extraction unchanged, exactly as findMonitoredJobDescription already does above.
 */
export async function fetchRecruiteeJobDescription(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RecruiteeJobDescription | undefined> {
  const parts = recruiteeOfferUrlParts(rawUrl);
  if (!parts) return undefined;

  const postingUrl = `https://${parts.tenant}.recruitee.com/o/${parts.slug}`;
  const html = await fetchText(postingUrl, fetchImpl, 'text/html');
  if (html) {
    const jsonLd = jsonLdJobPostingFromHtml(html);
    if (jsonLd) {
      const jdText = recruiteeHtmlToText(jsonLd.description);
      if (jdText) {
        return {
          jdText,
          pageTitle: (jsonLd.title ?? '').trim(),
          companyName: (jsonLd.companyName ?? '').trim(),
        };
      }
    }
  }

  const apiUrl = `https://${parts.tenant}.recruitee.com/api/offers/${parts.slug}`;
  const apiBody = await fetchText(apiUrl, fetchImpl, 'application/json');
  if (!apiBody) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(apiBody);
  } catch {
    return undefined;
  }
  const offer = offerFromApiPayload(payload);
  if (!offer) return undefined;
  const jdText = [recruiteeHtmlToText(offer.description), recruiteeHtmlToText(offer.requirements)]
    .filter(Boolean)
    .join('\n\n');
  if (!jdText) return undefined;
  return {
    jdText,
    pageTitle: (offer.title ?? '').trim(),
    companyName: (offer.companyName ?? '').trim(),
  };
}
