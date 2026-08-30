import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { get, list } from '@vercel/blob';

const bucket = process.env.OBJECT_STORAGE_BUCKET?.trim() || process.env.BUCKET?.trim();
const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim() || process.env.ACCESS_KEY_ID?.trim();
const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim() || process.env.SECRET_ACCESS_KEY?.trim();
const endpoint = process.env.OBJECT_STORAGE_ENDPOINT?.trim() || process.env.ENDPOINT?.trim();
const missing = [
  ['BLOB_READ_WRITE_TOKEN', process.env.BLOB_READ_WRITE_TOKEN?.trim()],
  ['OBJECT_STORAGE_BUCKET or BUCKET', bucket],
  ['OBJECT_STORAGE_ACCESS_KEY_ID or ACCESS_KEY_ID', accessKeyId],
  ['OBJECT_STORAGE_SECRET_ACCESS_KEY or SECRET_ACCESS_KEY', secretAccessKey],
  ['OBJECT_STORAGE_ENDPOINT or ENDPOINT', endpoint],
].filter(([, value]) => !value).map(([name]) => name);
if (missing.length > 0) {
  console.error(`Missing migration variables: ${missing.join(', ')}`);
  process.exit(2);
}

const client = new S3Client({
  endpoint,
  region: process.env.OBJECT_STORAGE_REGION || process.env.REGION || 'auto',
  forcePathStyle: (process.env.OBJECT_STORAGE_URL_STYLE || 'virtual').trim().toLowerCase() === 'path',
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

async function allVercelBlobs() {
  const blobs = [];
  let cursor;
  do {
    const result = await list({ cursor, limit: 1000 });
    blobs.push(...result.blobs);
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);
  return blobs;
}

async function readVercelBlob(blob) {
  const access = new URL(blob.url).hostname.endsWith('.private.blob.vercel-storage.com')
    ? 'private'
    : 'public';
  const result = await get(blob.pathname, { access });
  if (!result || result.statusCode !== 200 || !result.stream) {
    throw new Error(`Could not read ${blob.pathname}: ${result?.statusCode ?? 404}`);
  }
  return {
    body: Buffer.from(await new Response(result.stream).arrayBuffer()),
    contentType: result.blob.contentType || 'application/octet-stream',
  };
}

const blobs = await allVercelBlobs();
let copied = 0;
let skipped = 0;
for (const [index, blob] of blobs.entries()) {
  const existing = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: blob.pathname })).catch((error) => {
    if (error?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  });
  const { body, contentType } = await readVercelBlob(blob);
  const sourceHash = createHash('sha256').update(body).digest('hex');

  if (existing?.ContentLength === body.length) {
    const stored = await client.send(new GetObjectCommand({ Bucket: bucket, Key: blob.pathname }));
    const existingBody = Buffer.from(await stored.Body.transformToByteArray());
    const existingHash = createHash('sha256').update(existingBody).digest('hex');
    if (sourceHash === existingHash) {
      skipped += 1;
      console.log(`Verified ${index + 1}/${blobs.length}`);
      continue;
    }
  }

  await client.send(new PutObjectCommand({ Bucket: bucket, Key: blob.pathname, Body: body, ContentType: contentType }));
  const stored = await client.send(new GetObjectCommand({ Bucket: bucket, Key: blob.pathname }));
  const copiedBody = Buffer.from(await stored.Body.transformToByteArray());
  const copiedHash = createHash('sha256').update(copiedBody).digest('hex');
  if (sourceHash !== copiedHash) throw new Error(`Checksum mismatch for ${blob.pathname}`);
  copied += 1;
  console.log(`Copied and verified ${index + 1}/${blobs.length}`);
}

console.log(JSON.stringify({ total: blobs.length, copied, skipped, verified: copied + skipped }));
