import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
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
};

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
