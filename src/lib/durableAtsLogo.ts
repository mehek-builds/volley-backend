import { createHash } from 'node:crypto';
import { normalizeExecutableAtsBoardToken } from './atsBoardToken';
import type { SupportedJobBoard } from './jobMonitor';
import { isPublicLogoObjectReadUrlForKey, putPublicLogoObject } from './objectStorage';

export type DurableAtsLogoAsset = {
  provider: SupportedJobBoard;
  board_token: string;
  bytes: Uint8Array;
  content_type: string;
};

export type DurableHomepageLogoAsset = {
  company_domain: string;
  bytes: Uint8Array;
  content_type: string;
};

type DurableLogoPutOptions = {
  addRandomSuffix: false;
  contentType: string;
  cacheControlMaxAge: number;
  signal?: AbortSignal;
};

export type DurableLogoUploader = (
  pathname: string,
  body: Buffer,
  options: DurableLogoPutOptions,
) => Promise<{ url: string }>;

export type DurableHomepageLogoPersister = (
  asset: DurableHomepageLogoAsset,
) => Promise<string>;

const MAX_DURABLE_LOGO_BYTES = 1_000_000;
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
/* No SVG, on purpose: see the provider note in objectStorage.ts. An SVG served from our own
   origin executes its own script when the URL is opened directly, and serving from our origin is
   the entire point of this store. */
const EXTENSION_BY_CONTENT_TYPE = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/x-icon', 'ico'],
  ['image/vnd.microsoft.icon', 'ico'],
]);

/** The employer domain shape this store will key on: bare, lowercase, no port, no path. */
const STORABLE_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function defaultUploader(
  pathname: string,
  body: Buffer,
  options: DurableLogoPutOptions,
): Promise<{ url: string }> {
  return putPublicLogoObject(pathname, body, options.contentType, {}, options.signal);
}

/** Is this content type one this store is willing to serve back from our own origin? */
export function durableLogoExtension(contentType: string): string | null {
  return EXTENSION_BY_CONTENT_TYPE.get(contentType.trim().toLowerCase().split(';', 1)[0]) ?? null;
}

/**
 * Store already-proven bytes under a content-addressed key and return our own read URL.
 *
 * THE BYTES ARE THE INPUT, NEVER A URL. Nothing here fetches: every caller hands over a payload
 * its own bounded, DNS-pinned, size-capped lane already fetched and signature-checked, so this
 * function cannot be turned into a fetch of anything, and a caller cannot launder an arbitrary
 * URL through controlled storage by calling it.
 */
async function persistProvenLogoBytes(
  provider: 'rippling' | 'homepage',
  tenant: string,
  bytes: Uint8Array,
  contentType: string,
  uploader: DurableLogoUploader,
  signal?: AbortSignal,
): Promise<string> {
  const normalizedType = contentType.trim().toLowerCase().split(';', 1)[0];
  const extension = durableLogoExtension(normalizedType);
  if (!extension || bytes.byteLength < 4 || bytes.byteLength > MAX_DURABLE_LOGO_BYTES) {
    throw new Error('unsafe_url');
  }

  const digest = createHash('sha256').update(bytes).digest('hex');
  const pathname = `company-logos/${provider}/${encodeURIComponent(tenant)}/${digest}.${extension}`;
  const stored = await uploader(pathname, Buffer.from(bytes), {
    addRandomSuffix: false,
    /* The stored object declares the type the key's extension maps back to, so what the read
       route serves and what the bytes are can never disagree. */
    contentType: extension === 'ico' ? 'image/x-icon' : normalizedType,
    cacheControlMaxAge: ONE_YEAR_SECONDS,
    ...(signal ? { signal } : {}),
  });

  let url: URL;
  try {
    url = new URL(stored.url);
  } catch {
    throw new Error('unsafe_url');
  }
  if (url.toString().length > 4000
    || !isPublicLogoObjectReadUrlForKey(url.toString(), pathname)) throw new Error('unsafe_url');
  return url.toString();
}

/** Copy a proven expiring ATS image to the same durable public store used by Litos documents. */
export async function persistDurableAtsLogo(
  asset: DurableAtsLogoAsset,
  uploader: DurableLogoUploader = defaultUploader,
  signal?: AbortSignal,
): Promise<string> {
  /* Rippling is the only current provider whose first-party logo URL expires. Keeping this narrow
     prevents a future caller from laundering an arbitrary provider URL through controlled storage. */
  if (asset.provider !== 'rippling') throw new Error('unsafe_url');
  const token = normalizeExecutableAtsBoardToken(asset.provider, asset.board_token);
  if (!token) throw new Error('unsafe_url');
  return persistProvenLogoBytes(
    'rippling',
    token,
    asset.bytes,
    asset.content_type,
    uploader,
    signal,
  );
}

/**
 * Copy a proven employer-homepage image so serving it stops depending on that employer.
 *
 * The verifier can reach an asset the rest of the world cannot: measured 2026-09-01, D.A.
 * Davidson, Truecaller and Life Trading each answered the verifier and refused the website, CI
 * and the public, so the source was honestly verified and still rendered a monogram, and the
 * coverage floor could never close. Keeping the bytes we already proved makes what a job seeker
 * sees independent of an employer's WAF, geo rules and hotlink policy, permanently and for every
 * future employer with the same posture.
 */
export async function persistDurableHomepageLogo(
  asset: DurableHomepageLogoAsset,
  uploader: DurableLogoUploader = defaultUploader,
  signal?: AbortSignal,
): Promise<string> {
  const domain = asset.company_domain.trim().toLowerCase().replace(/^www\./, '');
  /* The tenant is the domain the verifier just proved, not anything a page said about itself. */
  if (!STORABLE_DOMAIN_RE.test(domain) || domain.length > 128) throw new Error('unsafe_url');
  return persistProvenLogoBytes(
    'homepage',
    domain,
    asset.bytes,
    asset.content_type,
    uploader,
    signal,
  );
}
