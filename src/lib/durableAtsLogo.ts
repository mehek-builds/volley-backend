import { createHash } from 'node:crypto';
import { normalizeExecutableAtsBoardToken } from './atsBoardToken';
import type { SupportedJobBoard } from './jobMonitor';
import { isPublicObjectReadUrlForKey, putObject } from './objectStorage';

export type DurableAtsLogoAsset = {
  provider: SupportedJobBoard;
  board_token: string;
  bytes: Uint8Array;
  content_type: string;
};

type DurableLogoPutOptions = {
  addRandomSuffix: false;
  allowOverwrite: true;
  contentType: string;
  cacheControlMaxAge: number;
  publicRead: true;
};

export type DurableLogoUploader = (
  pathname: string,
  body: Buffer,
  options: DurableLogoPutOptions,
) => Promise<{ url: string }>;

const MAX_DURABLE_LOGO_BYTES = 1_000_000;
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
const EXTENSION_BY_CONTENT_TYPE = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

function defaultUploader(
  pathname: string,
  body: Buffer,
  options: DurableLogoPutOptions,
): Promise<{ url: string }> {
  return putObject(pathname, body, options);
}

/** Copy a proven expiring ATS image to the same durable public store used by Litos documents. */
export async function persistDurableAtsLogo(
  asset: DurableAtsLogoAsset,
  uploader: DurableLogoUploader = defaultUploader,
): Promise<string> {
  /* Rippling is the only current provider whose first-party logo URL expires. Keeping this narrow
     prevents a future caller from laundering an arbitrary provider URL through controlled storage. */
  if (asset.provider !== 'rippling') throw new Error('unsafe_url');
  const token = normalizeExecutableAtsBoardToken(asset.provider, asset.board_token);
  const contentType = asset.content_type.trim().toLowerCase().split(';', 1)[0];
  const extension = EXTENSION_BY_CONTENT_TYPE.get(contentType);
  if (!token || !extension || asset.bytes.byteLength < 4
    || asset.bytes.byteLength > MAX_DURABLE_LOGO_BYTES) throw new Error('unsafe_url');

  const digest = createHash('sha256').update(asset.bytes).digest('hex');
  const pathname = `company-logos/rippling/${encodeURIComponent(token)}/${digest}.${extension}`;
  const stored = await uploader(pathname, Buffer.from(asset.bytes), {
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType,
    cacheControlMaxAge: ONE_YEAR_SECONDS,
    publicRead: true,
  });

  let url: URL;
  try {
    url = new URL(stored.url);
  } catch {
    throw new Error('unsafe_url');
  }
  const vercelPath = (() => {
    try {
      return decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    } catch {
      return '';
    }
  })();
  const verifiedVercelUrl = url.protocol === 'https:'
    && !url.username
    && !url.password
    && !url.port
    && /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i.test(url.hostname)
    && !url.search
    && !url.hash
    && vercelPath === pathname;
  if (url.toString().length > 4000
    || (!verifiedVercelUrl && !isPublicObjectReadUrlForKey(url.toString(), pathname))) {
    throw new Error('unsafe_url');
  }
  return url.toString();
}
