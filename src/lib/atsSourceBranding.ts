import type { JobSourceInput, SupportedJobBoard } from './jobMonitor';
import { normalizeExecutableAtsBoardToken } from './atsBoardToken';
import { logoVerificationErrorReason } from './logoVerificationRetry';
import type { DurableAtsLogoAsset } from './durableAtsLogo';

export const VERIFIED_ATS_SOURCE_LOGO_METHOD = 'first_party_ats_employer_logo';
export const VERIFIED_ATS_DURABLE_COPY_LOGO_METHOD =
  'first_party_ats_employer_logo_durable_copy';

export type AtsSourceBrandingCandidate = Pick<
  JobSourceInput,
  'ats_name' | 'board_token' | 'company_name'
> & {
  /**
   * Discovery-only sources often carry a board slug in company_name. In that case the employer
   * identity returned by the first-party ATS is authoritative. Reviewed or operator-supplied
   * identities stay asserted and must agree with the provider before promotion.
   */
  identity_mode?: 'asserted' | 'provisional';
};

export type AtsSourceBrandingResult =
  | {
    verified: true;
    company_name: string;
    company_logo_url: string;
    method: typeof VERIFIED_ATS_SOURCE_LOGO_METHOD
      | typeof VERIFIED_ATS_DURABLE_COPY_LOGO_METHOD;
  }
  | { verified: false; reason: string; identity_verified?: true; company_name?: string };

type ExtractedBranding = {
  companyName: string;
  logoUrl: string | null;
  provider: SupportedJobBoard;
  copyLogo?: true;
};

export type DurableAtsLogoPersister = (asset: DurableAtsLogoAsset) => Promise<string>;

export type AtsSourceBrandingOptions = {
  signal?: AbortSignal;
};

const USER_AGENT = 'LitosAtsBrandingVerifier/1.0';
const REQUEST_TIMEOUT_MS = 10_000;
/* Bounded because a provider that answers 301 with itself forever must cost three requests, not a
   worker slot. Measured 2026-08-31: 2,234 enabled sources sat failed on ats:http_301/302/307 alone,
   almost all of them token renames and regional migrations the provider itself announces via the
   redirect - recoverable inventory as long as the target stays on provider-owned hosts. */
const MAX_PROVIDER_REDIRECTS = 3;
const MAX_HTML_BYTES = 4_000_000;
const MAX_JSON_BYTES = 6_000_000;
const MAX_IMAGE_BYTES = 1_000_000;
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

class BrandingFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function fail(reason: string): never {
  throw new BrandingFailure(reason);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (match, code: string) => {
      const value = Number.parseInt(code, 16);
      return Number.isInteger(value) && value <= 0x10ffff ? String.fromCodePoint(value) : match;
    })
    .replace(/&#(\d+);/g, (match, code: string) => {
      const value = Number.parseInt(code, 10);
      return Number.isInteger(value) && value <= 0x10ffff ? String.fromCodePoint(value) : match;
    });
}

function tagAttribute(tag: string, attribute: string): string | null {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  const raw = match?.[1] ?? match?.[2];
  return raw === undefined ? null : decodeHtml(raw).trim();
}

function htmlTags(html: string, name: 'img' | 'link' | 'meta'): string[] {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]{0,4000}>`, 'gi'))].map((match) => match[0]);
}

function metaContent(html: string, key: string): string | null {
  for (const tag of htmlTags(html, 'meta')) {
    const marker = tagAttribute(tag, 'property') ?? tagAttribute(tag, 'name');
    if (marker?.toLowerCase() === key.toLowerCase()) return tagAttribute(tag, 'content');
  }
  return null;
}

function pageTitle(html: string): string | null {
  const match = html.match(/<title\b[^>]*>([\s\S]{1,500}?)<\/title>/i);
  return match ? decodeHtml(match[1]).replace(/\s+/g, ' ').trim() : null;
}

function firstElementText(html: string, element: string): string | null {
  const escaped = element.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]{1,1000}?)<\\/${escaped}>`, 'i'));
  if (!match) return null;
  return decodeHtml(match[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() || null;
}

const TRAILING_NAME_WORDS = new Set([
  'ag', 'bv', 'co', 'company', 'corp', 'corporation', 'gmbh', 'group', 'inc', 'incorporated',
  'limited', 'llc', 'ltd', 'plc', 'pte', 'technologies', 'technology',
]);

function normalizedNameParts(value: string): string[] {
  const parts = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
  while (parts.length > 1 && TRAILING_NAME_WORDS.has(parts[parts.length - 1])) parts.pop();
  return parts;
}

function namesAgree(expected: string, observed: string): boolean {
  const expectedParts = normalizedNameParts(expected);
  const observedParts = normalizedNameParts(observed);
  if (expectedParts.length === 0 || observedParts.length === 0) return false;
  const expectedName = expectedParts.join('');
  const observedName = observedParts.join('');
  if (expectedName.length < 2 || observedName.length < 2) return false;
  return expectedName === observedName;
}

function contentLength(response: Response): number | null {
  const raw = response.headers.get('content-length');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = contentLength(response);
  if (declared !== null && declared > maxBytes) {
    await response.body?.cancel();
    fail('response_too_large');
  }
  if (!response.body) fail('empty_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        fail('response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function responseType(response: Response): string {
  return (response.headers.get('content-type') ?? '').toLowerCase();
}

/* The next hop, only when the provider redirects WITHIN ITSELF - a token rename, a trailing-slash
 * canonicalization, an EU-cluster migration. Anywhere else returns null and the caller preserves
 * the original 3xx as the failure reason, exactly as if the redirect had not been followed: the
 * whole point of fetching fixed provider hosts is that the response author is known, and a hop to
 * an arbitrary host would let that author be whoever the redirect names. */
function providerInternalRedirect(
  location: string,
  currentUrl: string,
  allowedRedirectHost: (hostname: string) => boolean,
): string | null {
  try {
    const target = new URL(location, currentUrl);
    if (target.protocol !== 'https:' || target.username || target.password || target.port) return null;
    if (!allowedRedirectHost(target.hostname.toLowerCase())) return null;
    return target.toString();
  } catch {
    return null;
  }
}

async function fetchText(
  fetcher: typeof fetch,
  url: string,
  expectedType: 'html' | 'json',
  maxBytes: number,
  allowedRedirectHost?: (hostname: string) => boolean,
): Promise<string> {
  let target = url;
  for (let hop = 0; hop <= MAX_PROVIDER_REDIRECTS; hop += 1) {
    const response = await fetcher(target, {
      headers: {
        Accept: expectedType === 'json' ? 'application/json' : 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      const next = location && allowedRedirectHost
        ? providerInternalRedirect(location, target, allowedRedirectHost)
        : null;
      if (!next || hop === MAX_PROVIDER_REDIRECTS) fail(`http_${response.status}`);
      target = next;
      continue;
    }
    if (!response.ok) fail(`http_${response.status}`);
    const type = responseType(response);
    if (expectedType === 'json' ? !type.includes('json') : !type.includes('html')) {
      fail('unexpected_content_type');
    }
    return new TextDecoder().decode(await readBounded(response, maxBytes));
  }
  /* Unreachable: the final iteration either returns a body or fails on the redirect above.
     TypeScript needs the terminal statement; a reason is still named in case that ever changes. */
  return fail('redirect_limit');
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return fail('malformed_response');
  }
}

function safeAssetUrl(
  raw: string,
  hostname: string | readonly string[],
  pathPattern: RegExp,
): string | null {
  try {
    const url = new URL(raw);
    const allowedHosts = Array.isArray(hostname) ? hostname : [hostname];
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !allowedHosts.includes(url.hostname.toLowerCase())
      || !pathPattern.test(url.pathname)
      || url.toString().length > 4000) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function hasImageSignature(bytes: Uint8Array, contentType: string): boolean {
  const declaredImage = contentType.startsWith('image/');
  const genericBinary = contentType.includes('octet-stream');
  if (bytes.byteLength < 4 || (!declaredImage && !genericBinary)) return false;
  const prefix = [...bytes.slice(0, 12)];
  if (prefix[0] === 0x89 && prefix[1] === 0x50 && prefix[2] === 0x4e && prefix[3] === 0x47) return true;
  if (prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return true;
  const ascii = String.fromCharCode(...prefix);
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return true;
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return true;
  if (prefix[0] === 0 && prefix[1] === 0 && (prefix[2] === 1 || prefix[2] === 2) && prefix[3] === 0) return true;
  const opening = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, 600))).trimStart();
  return declaredImage && contentType.includes('svg') && /^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(opening);
}

async function proveImage(
  fetcher: typeof fetch,
  url: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const response = await fetcher(url, {
    headers: { Accept: 'image/*', 'User-Agent': USER_AGENT },
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  /* Keep the status so 429 and 5xx responses can be retried without treating a permanent 404 as
     provider pressure. The URL itself is never included in the persisted reason. */
  if (!response.ok) fail(`http_${response.status}`);
  const bytes = await readBounded(response, MAX_IMAGE_BYTES);
  const contentType = responseType(response).split(';', 1)[0];
  if (!hasImageSignature(bytes, contentType)) fail('invalid_logo_asset');
  return { bytes, contentType };
}

async function greenhouseBranding(token: string, fetcher: typeof fetch): Promise<ExtractedBranding> {
  const html = await fetchText(
    fetcher,
    `https://job-boards.greenhouse.io/embed/job_board?for=${encodeURIComponent(token)}`,
    'html',
    MAX_HTML_BYTES,
    (host) => host === 'job-boards.greenhouse.io' || host === 'boards.greenhouse.io',
  );
  for (const tag of htmlTags(html, 'img')) {
    const classes = tagAttribute(tag, 'class')?.split(/\s+/) ?? [];
    const alt = tagAttribute(tag, 'alt');
    const src = tagAttribute(tag, 'src');
    if (!classes.includes('logo') || !alt || !src || !/\slogo$/i.test(alt)) continue;
    const logoUrl = safeAssetUrl(
      src,
      'recruiting.cdn.greenhouse.io',
      /^\/external_greenhouse_job_boards\/logos\/(?:\d+\/){3}original\/[^/]+$/i,
    );
    if (logoUrl) return { companyName: alt.replace(/\s+logo$/i, '').trim(), logoUrl, provider: 'greenhouse' };
  }
  const companyName = metaContent(html, 'og:title')?.replace(/^jobs\s+at\s+|\s+jobs$/gi, '').trim()
    ?? pageTitle(html)?.replace(/^jobs\s+at\s+|\s+jobs$/gi, '').trim();
  if (!companyName) return fail('logo_missing');
  return { companyName, logoUrl: null, provider: 'greenhouse' };
}

async function leverBranding(token: string, fetcher: typeof fetch): Promise<ExtractedBranding> {
  const html = await fetchText(
    fetcher,
    `https://jobs.lever.co/${encodeURIComponent(token)}`,
    'html',
    MAX_HTML_BYTES,
    (host) => host === 'jobs.lever.co' || host === 'jobs.eu.lever.co',
  );
  const companyName = pageTitle(html);
  const ogTitle = metaContent(html, 'og:title')?.replace(/\s+jobs$/i, '').trim();
  const rawLogo = metaContent(html, 'og:image');
  if (!companyName || !ogTitle || !namesAgree(companyName, ogTitle)) fail('malformed_response');
  const logoUrl = rawLogo ? safeAssetUrl(
    rawLogo,
    [
      'lever-client-logos.s3-us-west-2.amazonaws.com',
      'lever-client-logos.s3.us-west-2.amazonaws.com',
      'lever-client-logos.s3.amazonaws.com',
    ],
    /^\/[a-z0-9._%+-]+\.(?:gif|jpe?g|png|svg|webp)$/i,
  ) : null;
  return { companyName, logoUrl, provider: 'lever' };
}

async function ashbyBranding(token: string, fetcher: typeof fetch): Promise<ExtractedBranding> {
  const html = await fetchText(
    fetcher,
    `https://jobs.ashbyhq.com/${encodeURIComponent(token)}`,
    'html',
    MAX_HTML_BYTES,
    (host) => host === 'jobs.ashbyhq.com',
  );
  const title = pageTitle(html);
  const ogTitle = metaContent(html, 'og:title');
  if (!title || !ogTitle || !namesAgree(title.replace(/\s+jobs$/i, ''), ogTitle.replace(/\s+jobs$/i, ''))) {
    fail('malformed_response');
  }
  const companyName = title.replace(/\s+jobs$/i, '').trim();
  for (const tag of htmlTags(html, 'link')) {
    if (tagAttribute(tag, 'rel')?.toLowerCase() !== 'preload'
      || tagAttribute(tag, 'as')?.toLowerCase() !== 'image') continue;
    const href = tagAttribute(tag, 'href');
    if (!href) continue;
    const logoUrl = safeAssetUrl(
      href,
      'app.ashbyhq.com',
      new RegExp(`^/api/images/org-theme-logo/${UUID_RE}/${UUID_RE}/${UUID_RE}\\.(?:gif|jpe?g|png|svg|webp)$`, 'i'),
    );
    if (logoUrl) return { companyName, logoUrl, provider: 'ashby' };
  }
  return { companyName, logoUrl: null, provider: 'ashby' };
}

async function workableBranding(token: string, fetcher: typeof fetch): Promise<ExtractedBranding> {
  const html = await fetchText(
    fetcher,
    `https://apply.workable.com/${encodeURIComponent(token)}/`,
    'html',
    MAX_HTML_BYTES,
    (host) => host === 'apply.workable.com',
  );
  const titleName = pageTitle(html)?.replace(/\s+-\s+current openings$/i, '').trim();
  const companyName = metaContent(html, 'og:title');
  const rawLogo = metaContent(html, 'og:image');
  if (!titleName || !companyName || !namesAgree(titleName, companyName)) fail('malformed_response');
  const logoUrl = rawLogo ? safeAssetUrl(
    rawLogo,
    'workablehr.s3.amazonaws.com',
    /^\/uploads\/account\/open_graph_logo\/\d+\/social$/i,
  ) : null;
  return { companyName, logoUrl, provider: 'workable' };
}

async function breezyBranding(token: string, fetcher: typeof fetch): Promise<ExtractedBranding> {
  const raw = await fetchText(
    fetcher,
    `https://${token}.breezy.hr/json`,
    'json',
    MAX_JSON_BYTES,
    (host) => /^[a-z0-9-]+\.breezy\.hr$/.test(host),
  );
  const payload = parseJson(raw);
  if (!Array.isArray(payload) || payload.length === 0) fail('malformed_response');
  const companies = payload.map((item) => (
    item && typeof item === 'object' ? (item as Record<string, unknown>).company : null
  ));
  if (companies.some((company) => !company || typeof company !== 'object')) fail('malformed_response');
  const records = companies as Record<string, unknown>[];
  const companyName = text(records[0].name);
  const friendlyId = text(records[0].friendly_id)?.toLowerCase();
  const rawLogo = text(records[0].logo_url);
  if (!companyName || friendlyId !== token) fail('malformed_response');
  if (records.some((company) => !namesAgree(companyName, text(company.name) ?? '')
    || text(company.friendly_id)?.toLowerCase() !== token
    || text(company.logo_url) !== rawLogo)) fail('identity_mismatch');
  const logoUrl = rawLogo ? safeAssetUrl(
    rawLogo,
    'gallery-cdn.breezy.hr',
    new RegExp(`^/${UUID_RE}/[^/]+$`, 'i'),
  ) : null;
  return { companyName, logoUrl, provider: 'breezy' };
}

async function recruiteeBranding(token: string, fetcher: typeof fetch): Promise<ExtractedBranding> {
  const html = await fetchText(
    fetcher,
    `https://${token}.recruitee.com`,
    'html',
    MAX_HTML_BYTES,
    (host) => /^[a-z0-9-]+\.recruitee\.com$/.test(host),
  );
  for (const tag of htmlTags(html, 'img')) {
    const classes = tagAttribute(tag, 'class')?.split(/\s+/) ?? [];
    const dataCy = tagAttribute(tag, 'data-cy');
    if (!classes.some((value) => value === 'custom-css-style-navigation-logo-image')
      && dataCy !== 'navigation-section-logo-image') continue;
    const alt = tagAttribute(tag, 'alt');
    const src = tagAttribute(tag, 'src');
    if (!alt || !src || !/\slogo$/i.test(alt)) continue;
    const logoUrl = safeAssetUrl(
      src,
      'careers.recruiteecdn.com',
      /^\/image\/upload\/(?:[^/]+\/)*production\/images\/[^/]+\/[^/]+\.(?:gif|jpe?g|png|svg|webp)$/i,
    );
    if (logoUrl) return { companyName: alt.replace(/\s+logo$/i, '').trim(), logoUrl, provider: 'recruitee' };
  }
  /* Many Recruitee tenants publish a first-party employer title but no navigation image. Preserve
     that identity so a catalog domain can still be verified against the employer homepage instead
     of discarding the entire source merely because the ATS theme omitted a logo. */
  const rawName = metaContent(html, 'og:title') ?? pageTitle(html);
  const companyName = rawName
    ?.replace(/^careers\s+at\s+/i, '')
    .replace(/\s+(?:careers|jobs)$/i, '')
    .replace(/\s*[|:-]\s*recruitee$/i, '')
    .trim();
  if (!companyName) return fail('identity_missing');
  return { companyName, logoUrl: null, provider: 'recruitee' };
}

function crelateClientVarsUrl(token: string): string {
  const encoded = Buffer.from(token, 'utf8').toString('base64');
  return `https://jobs.crelate.com/api/candidateportal/getclientvars?onv=${encodeURIComponent(encoded)}`;
}

function crelateSettingsUrl(organizationId: string): string {
  const envelope = encodeURIComponent(JSON.stringify({ OrganizationId: organizationId }));
  return `https://app.crelate.com/api/candidateportal/Settings?requestEnvelope=${envelope}`;
}

async function crelateBranding(token: string, fetcher: typeof fetch): Promise<ExtractedBranding> {
  const vars = parseJson(await fetchText(fetcher, crelateClientVarsUrl(token), 'json', MAX_JSON_BYTES));
  if (!vars || typeof vars !== 'object') fail('malformed_response');
  const client = vars as Record<string, unknown>;
  const organizationId = text(client.ORG_ID);
  const orgName = text(client.ORG_NAME)?.toLowerCase();
  const displayName = text(client.ORG_DISPLAY_NAME);
  if (!organizationId || !new RegExp(`^${UUID_RE}$`, 'i').test(organizationId)
    || orgName !== token.toLowerCase() || !displayName
    || text(client.BASE_URL)?.toLowerCase() !== 'jobs.crelate.com') fail('malformed_response');

  const settingsPayload = parseJson(await fetchText(fetcher, crelateSettingsUrl(organizationId), 'json', MAX_JSON_BYTES));
  if (!settingsPayload || typeof settingsPayload !== 'object') fail('malformed_response');
  const settings = settingsPayload as Record<string, unknown>;
  const companyName = text(settings.Title);
  const rawLogo = text(settings.HeaderLogoUrl);
  if (!companyName || !namesAgree(displayName, companyName)) fail('identity_mismatch');
  /* Crelate reuses HeaderLogoUrl for four header modes. Only mode 3 is explicitly a Logo.
     Mode 1 is a 2000x350 banner, mode 2 is arbitrary custom HTML, and neither is valid evidence. */
  if (settings.HeaderType !== 3 || !rawLogo) {
    return { companyName, logoUrl: null, provider: 'crelate' };
  }
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const logoUrl = safeAssetUrl(
    rawLogo,
    'jobs.crelate.com',
    new RegExp(`^/portal/v2/${escapedToken}/logo/${UUID_RE}$`, 'i'),
  );
  return { companyName, logoUrl, provider: 'crelate' };
}

async function ripplingBranding(token: string, fetcher: typeof fetch): Promise<ExtractedBranding> {
  const html = await fetchText(
    fetcher,
    `https://ats.rippling.com/${encodeURIComponent(token)}/jobs`,
    'html',
    MAX_HTML_BYTES,
    (host) => host === 'ats.rippling.com',
  );
  const rawName = firstElementText(html, 'h1') ?? pageTitle(html);
  if (!rawName) fail('identity_missing');
  const companyName = rawName
    .replace(/^careers\s+at\s+/i, '')
    .replace(/\s+careers$/i, '')
    .replace(/\s*[|:-]\s*rippling$/i, '')
    .trim();
  if (!companyName) fail('identity_missing');
  let logoUrl: string | null = null;
  for (const tag of htmlTags(html, 'link')) {
    const rel = tagAttribute(tag, 'rel')?.toLowerCase();
    const href = tagAttribute(tag, 'href');
    if ((rel !== 'prefetch' && rel !== 'preload') || !href) continue;
    let candidate: URL;
    try {
      candidate = new URL(href);
    } catch {
      continue;
    }
    const queryKeys = [...candidate.searchParams.keys()];
    const expires = candidate.searchParams.getAll('Expires');
    const signatures = candidate.searchParams.getAll('Signature');
    const keyPairs = candidate.searchParams.getAll('Key-Pair-Id');
    if (candidate.protocol !== 'https:' || candidate.hostname.toLowerCase() !== 'prod-images.rippling.com'
      || candidate.username || candidate.password || candidate.port || candidate.hash
      || !/^\/[a-f0-9]{40}\.(?:gif|jpe?g|png|webp)$/i.test(candidate.pathname)
      || expires.length !== 1 || !/^\d{10,}$/.test(expires[0])
      || Number(expires[0]) * 1000 <= Date.now()
      || signatures.length !== 1 || !/^[a-z0-9_~.-]{40,2000}$/i.test(signatures[0])
      || keyPairs.length !== 1 || !/^[a-z0-9-]{6,100}$/i.test(keyPairs[0])
      || queryKeys.length !== 3
      || !queryKeys.every((key) => ['Expires', 'Signature', 'Key-Pair-Id'].includes(key))) continue;
    logoUrl = candidate.toString();
    break;
  }
  /* The signed provider URL is proof input only. The persister copies the verified bytes before
     the URL expires, and only the controlled durable URL can enter public inventory. */
  return { companyName, logoUrl, provider: 'rippling', ...(logoUrl ? { copyLogo: true as const } : {}) };
}

async function extractBranding(
  source: AtsSourceBrandingCandidate,
  fetcher: typeof fetch,
): Promise<ExtractedBranding> {
  const token = normalizeExecutableAtsBoardToken(source.ats_name, source.board_token);
  if (!token) return fail('invalid_source');
  switch (source.ats_name) {
    case 'greenhouse': return greenhouseBranding(token, fetcher);
    case 'lever': return leverBranding(token, fetcher);
    case 'ashby': return ashbyBranding(token, fetcher);
    case 'workable': return workableBranding(token, fetcher);
    case 'breezy': return breezyBranding(token, fetcher);
    case 'recruitee': return recruiteeBranding(token, fetcher);
    case 'crelate': return crelateBranding(token, fetcher);
    case 'rippling': return ripplingBranding(token, fetcher);
    default: return fail('unsupported_family');
  }
}

function fetcherWithSignal(fetcher: typeof fetch, signal: AbortSignal | undefined): typeof fetch {
  if (!signal) return fetcher;
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const requestSignal = init?.signal
      ? AbortSignal.any([init.signal, signal])
      : signal;
    return fetcher(input, { ...init, signal: requestSignal });
  }) as typeof fetch;
}

/**
 * Prove the employer identity and logo from an ATS-owned public board response.
 *
 * The verifier only requests fixed provider endpoints derived from a constrained board token. It
 * follows a bounded number of redirects only while they stay on that provider's own hosts (token
 * renames, EU-cluster migrations), and refuses every other redirect, generic vendor artwork,
 * social banners, arbitrary third-party image hosts, and any provider identity that disagrees
 * with the source catalog. A candidate is promoted only after the returned image also answers as
 * a bounded, recognizable image payload.
 */
export async function verifyAtsSourceBranding(
  source: AtsSourceBrandingCandidate,
  fetcher: typeof fetch = fetch,
  persistDurableLogo?: DurableAtsLogoPersister,
  options: AtsSourceBrandingOptions = {},
): Promise<AtsSourceBrandingResult> {
  const boundedFetcher = fetcherWithSignal(fetcher, options.signal);
  let extracted: ExtractedBranding;
  try {
    const expectedName = source.company_name.trim();
    if (!expectedName || expectedName.length > 200) fail('invalid_source');
    extracted = await extractBranding(source, boundedFetcher);
    if (source.identity_mode !== 'provisional' && !namesAgree(expectedName, extracted.companyName)) {
      fail('identity_mismatch');
    }
  } catch (error) {
    if (error instanceof BrandingFailure) return { verified: false, reason: error.reason };
    return { verified: false, reason: logoVerificationErrorReason(error) };
  }

  if (!extracted.logoUrl) {
    return {
      verified: false,
      reason: 'logo_missing',
      identity_verified: true,
      company_name: extracted.companyName,
    };
  }
  let provenImage: { bytes: Uint8Array; contentType: string };
  try {
    provenImage = await proveImage(boundedFetcher, extracted.logoUrl);
  } catch (error) {
    const reason = error instanceof BrandingFailure
      ? error.reason
      : logoVerificationErrorReason(error);
    return {
      verified: false,
      reason,
      identity_verified: true,
      company_name: extracted.companyName,
    };
  }
  if (extracted.copyLogo) {
    if (!persistDurableLogo) {
      return {
        verified: false,
        reason: 'verification_failed',
        identity_verified: true,
        company_name: extracted.companyName,
      };
    }
    try {
      const companyLogoUrl = await persistDurableLogo({
        provider: extracted.provider,
        board_token: source.board_token,
        bytes: provenImage.bytes,
        content_type: provenImage.contentType,
      });
      return {
        verified: true,
        company_name: extracted.companyName,
        company_logo_url: companyLogoUrl,
        method: VERIFIED_ATS_DURABLE_COPY_LOGO_METHOD,
      };
    } catch (error) {
      return {
        verified: false,
        reason: logoVerificationErrorReason(error),
        identity_verified: true,
        company_name: extracted.companyName,
      };
    }
  }
  return {
    verified: true,
    company_name: extracted.companyName,
    company_logo_url: extracted.logoUrl,
    method: VERIFIED_ATS_SOURCE_LOGO_METHOD,
  };
}
