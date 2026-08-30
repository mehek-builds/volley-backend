import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { list } from '@vercel/blob';

const required = [
  'BLOB_READ_WRITE_TOKEN',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ACCESS_KEY_ID',
  'OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'OBJECT_STORAGE_ENDPOINT',
];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(`Missing migration variables: ${missing.join(', ')}`);
  process.exit(2);
}

const bucket = process.env.OBJECT_STORAGE_BUCKET;
const client = new S3Client({
  endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
  region: process.env.OBJECT_STORAGE_REGION || 'auto',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
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

const blobs = await allVercelBlobs();
let copied = 0;
let skipped = 0;
for (const [index, blob] of blobs.entries()) {
  const existing = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: blob.pathname })).catch((error) => {
    if (error?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  });
  if (existing?.ContentLength === blob.size) {
    skipped += 1;
    continue;
  }

  const response = await fetch(blob.url);
  if (!response.ok) throw new Error(`Could not read ${blob.pathname}: ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: blob.pathname, Body: body, ContentType: contentType }));
  const stored = await client.send(new GetObjectCommand({ Bucket: bucket, Key: blob.pathname }));
  const copiedBody = Buffer.from(await stored.Body.transformToByteArray());
  const sourceHash = createHash('sha256').update(body).digest('hex');
  const copiedHash = createHash('sha256').update(copiedBody).digest('hex');
  if (sourceHash !== copiedHash) throw new Error(`Checksum mismatch for ${blob.pathname}`);
  copied += 1;
  console.log(`Copied ${index + 1}/${blobs.length}: ${blob.pathname}`);
}

console.log(JSON.stringify({ total: blobs.length, copied, skipped, verified: copied + skipped }));
