import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { del as vercelDelete, list as vercelList, put as vercelPut } from '@vercel/blob';

export type StoredObject = {
  url: string;
  pathname: string;
  uploadedAt: Date;
};

export type PutObjectOptions = {
  contentType: string;
  addRandomSuffix?: boolean;
  allowOverwrite?: boolean;
};

type PublicLogoVercelPut = (
  pathname: string,
  body: Buffer,
  options: {
    access: 'public';
    contentType: string;
    addRandomSuffix: false;
    allowOverwrite: true;
    cacheControlMaxAge: number;
  },
) => Promise<{ url: string; pathname: string }>;

export type PublicLogoPutDependencies = {
  railwayPut?: (
    command: PutObjectCommand,
    options?: { abortSignal?: AbortSignal },
  ) => Promise<unknown>;
  vercelPut?: PublicLogoVercelPut;
};

/* This tenant grammar intentionally matches normalizeExecutableAtsBoardToken's path-segment
   branch: 1 to 128 lowercase ASCII slug characters, with punctuation only in the interior. The
   same grammar admits a bare employer domain, which is what the `homepage` provider stores under.
 *
 * TWO PROVIDERS, ONE REASON EACH. `rippling` copies an asset whose first-party URL EXPIRES.
 * `homepage` copies one the employer's own infrastructure refuses to serve to anybody but the
 * verifier: measured 2026-09-01, D.A. Davidson, Truecaller and Life Trading all answer the
 * verifier (which reaches them from the API's egress) and 403 or time out for the website, for
 * CI, and for the public, so their rows rendered a monogram while their evidence said verified.
 * Both cases are the same shape of problem, an asset that is proven but not durably servable, so
 * both take the same remedy: keep the bytes we already proved.
 *
 * SVG IS DELIBERATELY ABSENT. The homepage lane will prove an SVG (its signature check accepts
 * one), but an SVG served from our OWN origin is a script that runs when the URL is opened
 * directly, and this store's whole purpose is to serve from our origin. An SVG asset keeps its
 * remote URL, which is exactly what it does today. `ico` is here because it is inert, and because
 * it is what the WAF-blocked class overwhelmingly serves. */
const PUBLIC_LOGO_KEY_RE = /^company-logos\/(rippling|homepage)\/([a-z0-9](?:[a-z0-9._~-]{0,126}[a-z0-9])?)\/([a-f0-9]{64})\.(png|jpg|gif|webp|ico)$/;
const PUBLIC_LOGO_CONTENT_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['ico', 'image/x-icon'],
]);
const PUBLIC_LOGO_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const PUBLIC_LOGO_CACHE_SECONDS = 365 * 24 * 60 * 60;

function railwayConfigured(): boolean {
  return Boolean(
    (process.env.OBJECT_STORAGE_BUCKET?.trim() || process.env.BUCKET?.trim())
    && (process.env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim() || process.env.ACCESS_KEY_ID?.trim())
    && (process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim() || process.env.SECRET_ACCESS_KEY?.trim())
    && (process.env.OBJECT_STORAGE_ENDPOINT?.trim() || process.env.ENDPOINT?.trim()),
  );
}

export function objectStorageConfigured(): boolean {
  return railwayConfigured() || Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
}

export function objectStorageUsesRailway(): boolean {
  return railwayConfigured();
}

function provider(): 'railway' | 'vercel' {
  if (railwayConfigured()) return 'railway';
  if (process.env.BLOB_READ_WRITE_TOKEN?.trim()) return 'vercel';
  throw new Error('Object storage is not configured');
}

let cachedClient: S3Client | null = null;

function client(): S3Client {
  if (cachedClient) return cachedClient;
  cachedClient = new S3Client({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT || process.env.ENDPOINT,
    region: process.env.OBJECT_STORAGE_REGION || process.env.REGION || 'auto',
    forcePathStyle: (process.env.OBJECT_STORAGE_URL_STYLE || 'virtual').trim().toLowerCase() === 'path',
    credentials: {
      accessKeyId: (process.env.OBJECT_STORAGE_ACCESS_KEY_ID || process.env.ACCESS_KEY_ID)!,
      secretAccessKey: (process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY || process.env.SECRET_ACCESS_KEY)!,
    },
  });
  return cachedClient;
}

function bucket(): string {
  const value = process.env.OBJECT_STORAGE_BUCKET?.trim() || process.env.BUCKET?.trim();
  if (!value) throw new Error('OBJECT_STORAGE_BUCKET is not configured');
  return value;
}

function randomizeKey(key: string): string {
  const slash = key.lastIndexOf('/');
  const dot = key.lastIndexOf('.');
  const suffix = randomBytes(8).toString('hex');
  if (dot > slash) return `${key.slice(0, dot)}-${suffix}${key.slice(dot)}`;
  return `${key}-${suffix}`;
}

function tokenKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error('ENCRYPTION_KEY not configured');
  return scryptSync(secret, 'litos-object-storage-capability', 32);
}

export function mintObjectReadToken(objectKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(objectKey, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function readObjectReadToken(token: string): string | null {
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.toString('base64url') !== token) return null;
    if (raw.length <= 28) return null;
    const decipher = createDecipheriv('aes-256-gcm', tokenKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const key = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    if (!key || key.startsWith('/') || key.includes('..') || key.includes('\\')) return null;
    return key;
  } catch {
    return null;
  }
}

function publicBaseUrl(): string {
  const configured = process.env.OBJECT_STORAGE_PUBLIC_BASE_URL?.trim()
    || process.env.PUBLIC_API_BASE?.trim();
  if (!configured) throw new Error('OBJECT_STORAGE_PUBLIC_BASE_URL or PUBLIC_API_BASE is required');
  const url = new URL(configured);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('Object storage public base URL must use HTTPS');
  }
  return url.toString().replace(/\/+$/, '');
}

export function objectReadUrl(objectKey: string): string {
  return `${publicBaseUrl()}/storage/object?t=${encodeURIComponent(mintObjectReadToken(objectKey))}`;
}

/** Only content-addressed, non-sensitive logo objects may receive a stable public path. */
export function isPublicObjectKey(objectKey: string): boolean {
  return PUBLIC_LOGO_KEY_RE.test(objectKey);
}

/** Compatibility URL for public logo links minted before the Railway route migration. */
export function publicObjectReadUrl(objectKey: string): string {
  if (!isPublicObjectKey(objectKey)) throw new Error('Object key is not public');
  return `${publicBaseUrl()}/storage/public/${objectKey}`;
}

export function isPublicObjectReadUrlForKey(rawUrl: string, objectKey: string): boolean {
  if (!isPublicObjectKey(objectKey)) return false;
  try {
    const actual = new URL(rawUrl);
    const expected = new URL(publicObjectReadUrl(objectKey));
    return actual.protocol === 'https:'
      && !actual.username
      && !actual.password
      && !actual.port
      && !actual.search
      && !actual.hash
      && actual.origin === expected.origin
      && actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

export function publicLogoObjectUrl(objectKey: string): string {
  const match = PUBLIC_LOGO_KEY_RE.exec(objectKey);
  if (!match) throw new Error('Invalid public logo object key');
  const [, providerName, tenant, digest, extension] = match;
  return `${publicBaseUrl()}/storage/logo/${providerName}/${encodeURIComponent(tenant)}/${digest}.${extension}`;
}

export function publicLogoObjectKey(input: {
  provider?: string;
  tenant?: string;
  file?: string;
}): string | null {
  const providerName = input.provider ?? '';
  const tenant = input.tenant ?? '';
  const file = input.file ?? '';
  const candidate = `company-logos/${providerName}/${tenant}/${file}`;
  return PUBLIC_LOGO_KEY_RE.test(candidate) ? candidate : null;
}

export function publicLogoContentType(objectKey: string): string | null {
  const match = PUBLIC_LOGO_KEY_RE.exec(objectKey);
  return match ? PUBLIC_LOGO_CONTENT_TYPES.get(match[4]) ?? null : null;
}

function isVercelPublicLogoUrlForKey(rawUrl: string, objectKey: string): boolean {
  try {
    const url = new URL(rawUrl);
    let decodedPath = '';
    try {
      decodedPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    } catch {
      return false;
    }
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.port
      && !url.search
      && !url.hash
      && /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i.test(url.hostname)
      && decodedPath === objectKey;
  } catch {
    return false;
  }
}

/** Accept only an exact current, compatibility, or Vercel rollback URL for this public logo key. */
export function isPublicLogoObjectReadUrlForKey(rawUrl: string, objectKey: string): boolean {
  if (!isPublicObjectKey(objectKey)) return false;
  if (isVercelPublicLogoUrlForKey(rawUrl, objectKey)) return true;
  try {
    const actual = new URL(rawUrl);
    const canonical = new URL(publicLogoObjectUrl(objectKey));
    const compatibility = new URL(publicObjectReadUrl(objectKey));
    return actual.protocol === 'https:'
      && !actual.username
      && !actual.password
      && !actual.port
      && !actual.search
      && !actual.hash
      && actual.origin === canonical.origin
      && (actual.pathname === canonical.pathname || actual.pathname === compatibility.pathname);
  } catch {
    return false;
  }
}

export async function putPublicLogoObject(
  objectKey: string,
  body: Buffer,
  contentType: string,
  dependencies: PublicLogoPutDependencies = {},
  signal?: AbortSignal,
): Promise<{ url: string; pathname: string }> {
  signal?.throwIfAborted();
  const match = PUBLIC_LOGO_KEY_RE.exec(objectKey);
  const expectedContentType = publicLogoContentType(objectKey);
  const actualDigest = createHash('sha256').update(body).digest('hex');
  if (!match || !expectedContentType || expectedContentType !== contentType || match[3] !== actualDigest) {
    throw new Error('Invalid public logo object');
  }

  if (provider() === 'vercel') {
    const upload = dependencies.vercelPut ?? vercelPut;
    const blob = await upload(objectKey, body, {
      access: 'public',
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: PUBLIC_LOGO_CACHE_SECONDS,
    });
    signal?.throwIfAborted();
    if (blob.pathname !== objectKey || !isVercelPublicLogoUrlForKey(blob.url, objectKey)) {
      throw new Error('Public logo storage returned a mismatched object path');
    }
    return { url: blob.url, pathname: objectKey };
  }

  const command = new PutObjectCommand({
    Bucket: bucket(),
    Key: objectKey,
    Body: body,
    ContentType: contentType,
    CacheControl: PUBLIC_LOGO_CACHE_CONTROL,
  });
  const requestOptions = signal ? { abortSignal: signal } : undefined;
  await (dependencies.railwayPut
    ? dependencies.railwayPut(command, requestOptions)
    : client().send(command, requestOptions));
  signal?.throwIfAborted();
  return { url: publicLogoObjectUrl(objectKey), pathname: objectKey };
}

export async function putObject(
  requestedKey: string,
  body: Buffer,
  options: PutObjectOptions,
): Promise<{ url: string; pathname: string }> {
  if (provider() === 'vercel') {
    const blob = await vercelPut(requestedKey, body, {
      access: 'public',
      contentType: options.contentType,
      ...(options.addRandomSuffix === undefined ? {} : { addRandomSuffix: options.addRandomSuffix }),
      ...(options.allowOverwrite === undefined ? {} : { allowOverwrite: options.allowOverwrite }),
    });
    return { url: blob.url, pathname: blob.pathname };
  }

  const pathname = options.addRandomSuffix === false ? requestedKey : randomizeKey(requestedKey);
  await client().send(new PutObjectCommand({
    Bucket: bucket(),
    Key: pathname,
    Body: body,
    ContentType: options.contentType,
  }));
  return { url: objectReadUrl(pathname), pathname };
}

export async function readObject(objectKey: string): Promise<Buffer | null> {
  if (provider() === 'vercel') {
    const url = await resolveObjectUrl(objectKey);
    if (!url) return null;
    const response = await fetch(url);
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new Error(`object fetch ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  try {
    const response = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: objectKey }));
    if (!response.Body) return null;
    return Buffer.from(await response.Body.transformToByteArray());
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return null;
    throw error;
  }
}

export async function listObjects(prefix: string): Promise<StoredObject[]> {
  if (provider() === 'vercel') {
    const out: StoredObject[] = [];
    let cursor: string | undefined;
    do {
      const result = await vercelList({ prefix, cursor, limit: 1000 });
      out.push(...result.blobs.map((item) => ({
        url: item.url,
        pathname: item.pathname,
        uploadedAt: item.uploadedAt,
      })));
      cursor = result.hasMore ? result.cursor : undefined;
    } while (cursor);
    return out;
  }

  const out: StoredObject[] = [];
  let continuationToken: string | undefined;
  do {
    const result = await client().send(new ListObjectsV2Command({
      Bucket: bucket(),
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));
    out.push(...(result.Contents ?? []).flatMap((item) => item.Key ? [{
      url: objectReadUrl(item.Key),
      pathname: item.Key,
      uploadedAt: item.LastModified ?? new Date(0),
    }] : []));
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return out;
}

export async function resolveObjectUrl(objectKey: string): Promise<string | null> {
  if (provider() === 'railway') {
    const objects = await listObjects(objectKey);
    return objects.some((item) => item.pathname === objectKey) ? objectReadUrl(objectKey) : null;
  }
  const objects = await listObjects(objectKey);
  return objects.find((item) => item.pathname === objectKey)?.url ?? null;
}

export async function deleteObjects(objectKeysOrUrls: string | string[]): Promise<void> {
  const targets = Array.isArray(objectKeysOrUrls) ? objectKeysOrUrls : [objectKeysOrUrls];
  if (targets.length === 0) return;
  if (provider() === 'vercel') {
    await vercelDelete(targets);
    return;
  }
  const keys = targets.map((target) => {
    if (!/^https?:\/\//i.test(target)) return target;
    const parsed = new URL(target);
    const token = parsed.searchParams.get('t');
    const key = token ? readObjectReadToken(token) : null;
    if (key) return key;
    if (parsed.hostname.endsWith('.public.blob.vercel-storage.com')) {
      const legacyKey = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
      if (legacyKey && !legacyKey.startsWith('/') && !legacyKey.includes('..') && !legacyKey.includes('\\')) {
        return legacyKey;
      }
    }
    throw new Error('Refusing to delete an unrecognized object URL');
  });
  for (let offset = 0; offset < keys.length; offset += 1000) {
    await client().send(new DeleteObjectsCommand({
      Bucket: bucket(),
      Delete: { Objects: keys.slice(offset, offset + 1000).map((Key) => ({ Key })), Quiet: true },
    }));
  }
}
