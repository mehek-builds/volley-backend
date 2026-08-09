import { createHash } from 'node:crypto';
import { put } from '@vercel/blob';

const RECEIPT_CAPTURE_PATH = '/receipts';
const MAX_RECEIPT_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type ReceiptScreenshotEvidence = {
  url: string;
  source: 'vercel_blob' | 'controlled_qa_loopback';
  bytes: number;
  sha256: string;
};

type BlobPut = (
  objectKey: string,
  body: Buffer,
  options: { access: 'public'; contentType: 'image/png'; addRandomSuffix: true },
) => Promise<{ url: string }>;

function receiptCaptureTarget(): { url: string; token: string } | null {
  const enabled = process.env.LITOS_QA_RECEIPT_CAPTURE_ENABLED === 'true';
  if (!enabled) return null;
  if (process.env.NODE_ENV !== 'development') {
    throw new Error('Controlled QA receipt capture requires NODE_ENV=development');
  }
  const rawUrl = process.env.LITOS_QA_RECEIPT_CAPTURE_URL?.trim();
  const token = process.env.LITOS_QA_RECEIPT_CAPTURE_TOKEN?.trim();
  if (!rawUrl) throw new Error('LITOS_QA_RECEIPT_CAPTURE_URL is required when controlled receipt capture is enabled');
  if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    throw new Error('LITOS_QA_RECEIPT_CAPTURE_TOKEN must contain 32 to 128 safe characters');
  }
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new Error('LITOS_QA_RECEIPT_CAPTURE_URL must be a valid URL');
  }
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port
    || target.pathname !== RECEIPT_CAPTURE_PATH || target.search || target.hash
    || target.username || target.password) {
    throw new Error('Controlled QA receipt capture must be http://127.0.0.1:<port>/receipts');
  }
  return { url: target.toString(), token };
}

function receiptBytes(body: Buffer): { bytes: number; sha256: string } {
  if (body.length < PNG_SIGNATURE.length || body.length > MAX_RECEIPT_BYTES
    || !body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Receipt screenshot must be a non-empty PNG no larger than 20 MiB');
  }
  return { bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
}

export async function storeReceiptScreenshot(
  objectKey: string,
  body: Buffer,
  dependencies: { fetchImpl?: typeof fetch; blobPut?: BlobPut } = {},
): Promise<ReceiptScreenshotEvidence> {
  if (!/^users\/[A-Za-z0-9_-]+\/submission-runs\/[A-Za-z0-9_-]+\/receipt\.png$/.test(objectKey)) {
    throw new Error('Receipt screenshot object key is invalid');
  }
  const expected = receiptBytes(body);
  const capture = receiptCaptureTarget();
  if (!capture) {
    const blobPut = dependencies.blobPut ?? (put as BlobPut);
    const blob = await blobPut(objectKey, body, {
      access: 'public',
      contentType: 'image/png',
      addRandomSuffix: true,
    });
    if (typeof blob?.url !== 'string' || !/^https:\/\//.test(blob.url)) {
      throw new Error('Vercel Blob did not return a valid HTTPS receipt URL');
    }
    return { url: blob.url, source: 'vercel_blob', ...expected };
  }

  const response = await (dependencies.fetchImpl ?? fetch)(capture.url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(body.length),
      'X-Litos-QA-Receipt-Token': capture.token,
      'X-Litos-QA-Receipt-Key': objectKey,
      'X-Litos-QA-Receipt-SHA256': expected.sha256,
    },
    body: Uint8Array.from(body).buffer,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Controlled QA receipt capture ${response.status}: ${detail}`);
  }
  const result = await response.json().catch(() => null) as Record<string, unknown> | null;
  const expectedUrl = `urn:litos:qa-receipt:${expected.sha256}`;
  if (result?.source !== 'controlled_qa_loopback' || result.url !== expectedUrl
    || result.bytes !== expected.bytes || result.sha256 !== expected.sha256) {
    throw new Error('Controlled QA receipt capture returned malformed or mismatched evidence');
  }
  return { url: expectedUrl, source: 'controlled_qa_loopback', ...expected };
}
