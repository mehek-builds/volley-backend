import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import {
  isTransientLogoVerificationReason,
  logoVerificationErrorReason,
} from './logoVerificationRetry';
import type { DurableHomepageLogoPersister } from './durableAtsLogo';

export const VERIFIED_HOMEPAGE_LOGO_METHOD = 'homepage_identity_and_logo_asset';
/* The same proof, served from our own storage instead of the employer's. Distinct so the method
   column keeps saying where the bytes a job seeker receives actually come from. */
export const VERIFIED_HOMEPAGE_DURABLE_COPY_LOGO_METHOD =
  'homepage_identity_and_logo_asset_durable_copy';

export type LogoVerificationCandidate = {
  company_name: string;
  company_domain: string;
};

export type LogoVerificationResult =
  | {
    verified: true;
    company_logo_url: string;
    method: typeof VERIFIED_HOMEPAGE_LOGO_METHOD | typeof VERIFIED_HOMEPAGE_DURABLE_COPY_LOGO_METHOD;
  }
  | { verified: false; reason: string };

type ResolveHost = (hostname: string) => Promise<string[]>;

type VerificationOptions = {
  fetcher?: typeof fetch;
  resolveHost?: ResolveHost;
  signal?: AbortSignal;
  /* Given bytes this verifier has already fetched and signature-checked, keep a copy and answer
     with our own URL. Optional so every existing caller and test keeps its current behaviour. */
  persistDurableLogo?: DurableHomepageLogoPersister;
};

const USER_AGENT = 'LitosCompanyLogoVerifier/1.0';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 4;
const MAX_HTML_BYTES = 200_000;
const MAX_IMAGE_BYTES = 1_000_000;
const BARE_DOMAIN_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

const BLOCKED_HOSTS = [
  'localhost', 'local', 'internal',
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'breezy.hr', 'recruitee.com',
  'crelate.com', 'myworkdayjobs.com', 'myworkdaysite.com', 'dayforcehcm.com', 'paylocity.com',
  'smartrecruiters.com', 'jobvite.com', 'indeed.com', 'linkedin.com', 'glassdoor.com',
  'godaddy.com', 'sedo.com', 'hugedomains.com', 'afternic.com',
];

const PARKED_MARKERS = [
  'domain for sale', 'buy this domain', 'this domain may be for sale', 'parked domain',
  'hugedomains', 'afternic', 'sedo domain parking',
];

function blockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

function ipv4Blocked(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function ipBlocked(address: string): boolean {
  if (isIP(address) === 4) return ipv4Blocked(address);
  if (isIP(address) !== 6) return true;
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return ipv4Blocked(normalized.slice(7));
  return normalized === '::' || normalized === '::1'
    || normalized.startsWith('fc') || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:');
}

const defaultResolveHost: ResolveHost = async (hostname) => (
  await lookup(hostname, { all: true, verbatim: true })
).map((entry) => entry.address);

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

async function publicAddresses(
  hostname: string,
  resolveHost: ResolveHost,
  signal?: AbortSignal,
): Promise<string[]> {
  if (blockedHostname(hostname) || isIP(hostname)) throw new Error('blocked_host');
  signal?.throwIfAborted();
  const lookupPromise = resolveHost(hostname);
  const addresses = signal
    ? await new Promise<string[]>((resolve, reject) => {
      const onAbort = () => reject(abortError(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      void lookupPromise.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    })
    : await lookupPromise;
  signal?.throwIfAborted();
  if (addresses.length === 0 || addresses.some(ipBlocked)) throw new Error('non_public_host');
  return addresses;
}

function safeHttpsUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('unsafe_url');
  return url;
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('response_too_large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
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

type PinnedHttpsResponse = {
  status: number;
  contentType: string;
  location: string | null;
  bytes: Uint8Array;
};

/**
 * Fetch through a prevalidated IP while retaining the original hostname for TLS SNI and Host.
 * This closes the DNS-rebinding gap between checking an address and asking a separate resolver to
 * connect. The response body is bounded while streaming, before it can accumulate in memory.
 */
async function fetchPinnedHttps(
  url: URL,
  address: string,
  accept: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<PinnedHttpsResponse> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let settled = false;
    let absoluteTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = <T>(callback: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      if (absoluteTimer) clearTimeout(absoluteTimer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const fail = (error: Error) => settle(reject, error);
    const onAbort = () => request.destroy(abortError(signal!));
    const request = httpsRequest({
      protocol: 'https:',
      hostname: address,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      servername: url.hostname,
      rejectUnauthorized: true,
      headers: {
        Accept: accept,
        Host: url.hostname,
        'User-Agent': USER_AGENT,
      },
    }, (response) => {
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.destroy(new Error('response_too_large'));
        return;
      }
      const chunks: Uint8Array[] = [];
      let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.byteLength;
        if (length > maxBytes) {
          response.destroy(new Error('response_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', fail);
      response.on('end', () => {
        settle(resolve, {
          status: response.statusCode ?? 0,
          contentType: String(response.headers['content-type'] ?? '').toLowerCase(),
          location: typeof response.headers.location === 'string' ? response.headers.location : null,
          bytes: Buffer.concat(chunks, length),
        });
      });
    });
    /* setTimeout is only an inactivity timer and resets whenever a server dribbles a byte. This
       wall-clock timer bounds the whole request even when data keeps arriving below the byte cap. */
    absoluteTimer = setTimeout(() => request.destroy(new Error('timeout')), REQUEST_TIMEOUT_MS);
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('timeout')));
    request.on('error', fail);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    request.end();
  });
}

async function fetchPublic(
  initialUrl: URL,
  accept: string,
  maxBytes: number,
  fetcher: typeof fetch | undefined,
  resolveHost: ResolveHost,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; contentType: string; finalUrl: URL }> {
  let url = initialUrl;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const requestSignal = signal
      ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const addresses = await publicAddresses(url.hostname, resolveHost, requestSignal);
    const response = fetcher
      ? await (async () => {
        const fetched = await fetcher(url, {
          redirect: 'manual',
          signal: requestSignal,
          headers: { Accept: accept, 'User-Agent': USER_AGENT },
        });
        return {
          status: fetched.status,
          contentType: (fetched.headers.get('content-type') ?? '').toLowerCase(),
          location: fetched.headers.get('location'),
          /* Preserve a non-success status as the failure reason. Error bodies are not evidence and
             reading one first could replace a retryable 429 or 5xx with response_too_large. */
          bytes: fetched.status >= 200 && fetched.status < 400
            ? await readBounded(fetched, maxBytes)
            : new Uint8Array(),
        };
      })()
      : await fetchPinnedHttps(url, addresses[0], accept, maxBytes, requestSignal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const { location } = response;
      if (!location || redirect === MAX_REDIRECTS) throw new Error('bad_redirect');
      url = safeHttpsUrl(new URL(location, url).toString());
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`http_${response.status}`);
    return {
      bytes: response.bytes,
      contentType: response.contentType,
      finalUrl: url,
    };
  }
  throw new Error('redirect_limit');
}

function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(?:inc|llc|ltd|limited|corp|corporation|co|plc|gmbh|ag|bv|sa|pte)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/* Two classes of separator, split differently on purpose. Hyphen, slash, backslash and colon
   appear INSIDE real brands ("Rent-A-Center", "TCP/IP Labs", "Re:Build"), so they only separate
   when whitespace flanks them. Pipes, middle dots (u00b7, u2022) and en/em dashes (u2013, u2014)
   appear in no brand, and title templates routinely set them tight ("Home", em dash, "Acme"), so
   they separate with or without spaces. The dash and dot characters are written as escapes: they
   are match data here, not prose, and prose em dashes are banned in this codebase. Measured
   2026-08-31: 1,896 enabled sources sat failed on homepage:identity_mismatch, and the dominant
   shape was a brand named in a title segment the old lead-only split never reached -
   anthropic.com's "Home \ Anthropic" being the canonical example (backslash was not a separator
   at all, and the brand trails). */
const TITLE_SEGMENT_SEPARATOR_RE = /\s+[:\\/-]\s+|\s*[|\u00b7\u2022\u2013\u2014]\s*/;
const TRAILING_TITLE_NOISE_RE = /\s+(?:careers|jobs|official site)$/i;

function homepageIdentityAgrees(companyName: string, originalDomain: string, html: string, finalUrl: URL): boolean {
  const title = decodeHtml(html.match(/<title[^>]*>([\s\S]{0,400}?)<\/title>/i)?.[1] ?? '')
    .replace(/\s+/g, ' ').trim();
  const ogSiteName = decodeHtml(
    html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{1,200})["']/i)?.[1]
      ?? html.match(/<meta[^>]+content=["']([^"']{1,200})["'][^>]+property=["']og:site_name["']/i)?.[1]
      ?? '',
  );
  const applicationName = decodeHtml(
    html.match(/<meta[^>]+name=["']application-name["'][^>]+content=["']([^"']{1,200})["']/i)?.[1]
      ?? html.match(/<meta[^>]+content=["']([^"']{1,200})["'][^>]+name=["']application-name["']/i)?.[1]
      ?? '',
  );
  const openingText = `${title} ${ogSiteName} ${html.slice(0, 6_000)}`.toLowerCase();
  if (!title || PARKED_MARKERS.some((marker) => openingText.includes(marker))) return false;

  const target = normalizeName(companyName);
  const originalLabel = normalizeName(originalDomain.split('.')[0] ?? '');
  const finalLabel = normalizeName(finalUrl.hostname.replace(/^www\./, '').split('.')[0] ?? '');
  if (target.length < 2 || originalLabel.length < 2 || finalLabel.length < 2) return false;
  const hostAgrees = target === originalLabel || target === finalLabel;
  /* The LEAD or the TRAIL segment, never the middle. Brands lead their titles or trail them
     ("Home \ Anthropic"); the middle segments are where taglines, marketing copy and
     domain-marketplace boilerplate live. Accepting ANY segment (review finding 2026-09-01) let an
     expired domain's marketplace lander pass: "acme.co - Acme - available at Brandpa" names the
     brand in its middle segment, the host signal still agrees because the label of the DEAD
     domain matches, and the lander's favicon would have become the verified logo. This stays a
     two-signal check either way; the edge rule is what keeps a page that merely mentions the
     brand from completing it.

     The careers/jobs suffix strip applies to each edge segment too, not only the whole title:
     "Home | Acme Careers" trails with "Acme Careers", and stripping only the full title left
     exactly that shape failing (same review).

     A DOMAIN-SHAPED candidate never counts as the page naming the company. normalizeName strips
     legal suffixes, so the lander's lead segment "acme.co" would normalize straight to "acme":
     a page naming the dead domain is not a page naming the employer, and the marketplace title
     leads with exactly that. The cost of this rule is a monogram for a site whose title names
     only its own hostname, which is the conservative direction. */
  const segments = title.split(TITLE_SEGMENT_SEPARATOR_RE).map((value) => value.trim()).filter(Boolean);
  const edgeSegments = segments.length ? [...new Set([segments[0], segments[segments.length - 1]])] : [];
  const pageAgrees = [
    ogSiteName,
    applicationName,
    title,
    title.replace(TRAILING_TITLE_NOISE_RE, ''),
    ...edgeSegments,
    ...edgeSegments.map((segment) => segment.replace(TRAILING_TITLE_NOISE_RE, '')),
  ]
    .map((value) => value.trim())
    .filter((value) => Boolean(value) && !BARE_DOMAIN_RE.test(value.toLowerCase()))
    .some((value) => normalizeName(value) === target);
  return hostAgrees && pageAgrees;
}

function iconCandidates(html: string, homeUrl: URL, originalDomain: string): URL[] {
  const hrefs = [...html.matchAll(/<link\b[^>]*\brel=["'][^"']*icon[^"']*["'][^>]*\bhref=["']([^"']+)["']/gi)]
    .map((match) => match[1]);
  const reverseHrefs = [...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["'][^"']*icon[^"']*["']/gi)]
    .map((match) => match[1]);
  const urls: URL[] = [];
  for (const raw of [...hrefs, ...reverseHrefs, '/favicon.ico', `https://${originalDomain}/favicon.ico`]) {
    try {
      const url = safeHttpsUrl(new URL(raw, homeUrl).toString());
      if (!urls.some((existing) => existing.toString() === url.toString())) urls.push(url);
    } catch {
      // Ignore malformed or non-HTTPS icon hints and continue to the fixed favicon path.
    }
  }
  return urls.slice(0, 3);
}

function hasImageSignature(bytes: Uint8Array, contentType: string): boolean {
  if (bytes.byteLength < 8 || !contentType.startsWith('image/')) return false;
  const prefix = [...bytes.slice(0, 12)];
  if (prefix[0] === 0x89 && prefix[1] === 0x50 && prefix[2] === 0x4e && prefix[3] === 0x47) return true;
  if (prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return true;
  if (String.fromCharCode(...prefix.slice(0, 6)) === 'GIF87a'
    || String.fromCharCode(...prefix.slice(0, 6)) === 'GIF89a') return true;
  if (String.fromCharCode(...prefix.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...prefix.slice(8, 12)) === 'WEBP') return true;
  if (prefix[0] === 0 && prefix[1] === 0 && (prefix[2] === 1 || prefix[2] === 2) && prefix[3] === 0) return true;
  const opening = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, 500))).trimStart();
  return contentType.includes('svg') && /^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(opening);
}

function transientReasonOr(reasons: readonly string[], fallback: string): string {
  return reasons.find(isTransientLogoVerificationReason) ?? fallback;
}

/**
 * Prove a catalog domain belongs to the named employer and serves a real image asset.
 *
 * The verifier fails closed, checks every redirect target against public DNS to prevent SSRF, and
 * never accepts a favicon alone. The company's name must appear in homepage identity metadata and
 * the hostname must agree too. This is the same two-signal standard used by the reviewed map.
 */
export async function verifyCatalogSourceLogo(
  candidate: LogoVerificationCandidate,
  options: VerificationOptions = {},
): Promise<LogoVerificationResult> {
  const domain = candidate.company_domain.trim().toLowerCase().replace(/^www\./, '');
  if (!BARE_DOMAIN_RE.test(domain) || blockedHostname(domain)) return { verified: false, reason: 'invalid_domain' };
  const fetcher = options.fetcher;
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const signal = options.signal;
  try {
    let home: Awaited<ReturnType<typeof fetchPublic>> | null = null;
    const homeFailures: string[] = [];
    for (const raw of [`https://${domain}/`, `https://www.${domain}/`]) {
      try {
        home = await fetchPublic(
          safeHttpsUrl(raw),
          'text/html,application/xhtml+xml',
          MAX_HTML_BYTES,
          fetcher,
          resolveHost,
          signal,
        );
        break;
      } catch (error) {
        homeFailures.push(logoVerificationErrorReason(error));
        // Try the www spelling only after the exact catalog domain fails.
      }
    }
    if (!home) {
      return {
        verified: false,
        reason: transientReasonOr(homeFailures, 'homepage_unreachable'),
      };
    }
    const html = new TextDecoder().decode(home.bytes);
    if (!homepageIdentityAgrees(candidate.company_name, domain, html, home.finalUrl)) {
      return { verified: false, reason: 'identity_mismatch' };
    }
    const iconFailures: string[] = [];
    for (const iconUrl of iconCandidates(html, home.finalUrl, domain)) {
      try {
        const image = await fetchPublic(
          iconUrl,
          'image/*',
          MAX_IMAGE_BYTES,
          fetcher,
          resolveHost,
          signal,
        );
        if (hasImageSignature(image.bytes, image.contentType)) {
          /* KEEP THE BYTES WE JUST PROVED, when a store is wired.
           *
           * Proving an asset and then persisting the employer's URL assumes everyone else can
           * fetch what this verifier fetched, and for a real class of employers that is false:
           * measured 2026-09-01, D.A. Davidson, Truecaller and Life Trading each answered here
           * and refused the website, CI and the public, so the row said verified and rendered a
           * monogram. Our own copy makes the mark independent of that employer's WAF, geo rules
           * and hotlink policy.
           *
           * It also lifts the query-string restriction below, for these assets only: that rule
           * exists because a signed or cache-busting URL expires, and an expiring URL is exactly
           * what a copy stops being. A store that fails or refuses the type (SVG) falls through
           * to the remote URL, so this can only add coverage, never remove it. */
          if (options.persistDurableLogo) {
            try {
              const durableUrl = await options.persistDurableLogo({
                company_domain: domain,
                bytes: image.bytes,
                content_type: image.contentType,
              });
              return {
                verified: true,
                company_logo_url: durableUrl,
                method: VERIFIED_HOMEPAGE_DURABLE_COPY_LOGO_METHOD,
              };
            } catch {
              /* Storage said no. The employer's own URL is still proven, so fall through. */
            }
          }
          /* A signed or cache-busting query can expire. Do not prove one URL and persist a
             different guessed path, and do not put an ephemeral asset into every job response. */
          if (!iconUrl.search && iconUrl.toString().length <= 4000) {
            return {
              verified: true,
              company_logo_url: iconUrl.toString(),
              method: VERIFIED_HOMEPAGE_LOGO_METHOD,
            };
          }
        }
      } catch (error) {
        iconFailures.push(logoVerificationErrorReason(error));
        // Keep trying bounded icon candidates. No candidate means no verified source.
      }
    }
    return {
      verified: false,
      reason: transientReasonOr(iconFailures, 'logo_missing'),
    };
  } catch (error) {
    return { verified: false, reason: logoVerificationErrorReason(error) };
  }
}
