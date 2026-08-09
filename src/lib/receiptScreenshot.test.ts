import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { afterEach } from 'node:test';
import { storeReceiptScreenshot } from './receiptScreenshot';

const ENV_KEYS = [
  'NODE_ENV',
  'LITOS_QA_RECEIPT_CAPTURE_ENABLED',
  'LITOS_QA_RECEIPT_CAPTURE_URL',
  'LITOS_QA_RECEIPT_CAPTURE_TOKEN',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const key = 'users/user-1/submission-runs/run-1/receipt.png';
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('controlled-receipt-evidence'),
]);
const digest = createHash('sha256').update(png).digest('hex');
const token = '0123456789abcdef0123456789abcdef';

afterEach(() => {
  for (const envKey of ENV_KEYS) {
    const value = saved[envKey];
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
});

function enableCapture(url = 'http://127.0.0.1:4318/receipts') {
  process.env.NODE_ENV = 'development';
  process.env.LITOS_QA_RECEIPT_CAPTURE_ENABLED = 'true';
  process.env.LITOS_QA_RECEIPT_CAPTURE_URL = url;
  process.env.LITOS_QA_RECEIPT_CAPTURE_TOKEN = token;
}

test('controlled QA capture sends PNG bytes and accepts only matching opaque evidence', async () => {
  enableCapture();
  let blobCalled = false;
  const result = await storeReceiptScreenshot(key, png, {
    blobPut: async () => {
      blobCalled = true;
      return { url: 'https://blob.example/should-not-run.png' };
    },
    fetchImpl: async (input, init) => {
      assert.equal(String(input), 'http://127.0.0.1:4318/receipts');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      assert.equal((init?.headers as Record<string, string>)['X-Litos-QA-Receipt-Token'], token);
      assert.equal((init?.headers as Record<string, string>)['X-Litos-QA-Receipt-Key'], key);
      assert.equal((init?.headers as Record<string, string>)['X-Litos-QA-Receipt-SHA256'], digest);
      assert.deepEqual(Buffer.from(init?.body as Buffer), png);
      return new Response(JSON.stringify({
        source: 'controlled_qa_loopback',
        url: `urn:litos:qa-receipt:${digest}`,
        bytes: png.length,
        sha256: digest,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.equal(blobCalled, false);
  assert.deepEqual(result, {
    source: 'controlled_qa_loopback',
    url: `urn:litos:qa-receipt:${digest}`,
    bytes: png.length,
    sha256: digest,
  });
});

test('controlled QA capture rejects a remote endpoint before making a request', async () => {
  enableCapture('https://qa.example/receipts');
  let requested = false;
  await assert.rejects(storeReceiptScreenshot(key, png, {
    fetchImpl: async () => {
      requested = true;
      return new Response();
    },
  }), /must be http:\/\/127\.0\.0\.1:<port>\/receipts/);
  assert.equal(requested, false);
});

test('controlled QA capture rejects every environment except exact development', async () => {
  for (const environment of ['production', 'test', 'staging', 'preview', undefined]) {
    enableCapture();
    if (environment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = environment;
    let fetched = false;
    let blobCalled = false;
    await assert.rejects(storeReceiptScreenshot(key, png, {
      fetchImpl: async () => {
        fetched = true;
        return new Response();
      },
      blobPut: async () => {
        blobCalled = true;
        return { url: 'https://blob.example/should-not-run.png' };
      },
    }), /requires NODE_ENV=development/);
    assert.equal(fetched, false);
    assert.equal(blobCalled, false);
  }
});

test('controlled QA capture rejects a missing or weak per-run token', async () => {
  enableCapture();
  delete process.env.LITOS_QA_RECEIPT_CAPTURE_TOKEN;
  await assert.rejects(storeReceiptScreenshot(key, png), /must contain 32 to 128 safe characters/);
  process.env.LITOS_QA_RECEIPT_CAPTURE_TOKEN = 'too-short';
  await assert.rejects(storeReceiptScreenshot(key, png), /must contain 32 to 128 safe characters/);
});

test('controlled QA capture rejects malformed and mismatched responses', async () => {
  enableCapture();
  for (const body of [
    'not-json',
    JSON.stringify({ source: 'controlled_qa_loopback', url: 'https://public.example/receipt.png', bytes: png.length, sha256: digest }),
    JSON.stringify({ source: 'controlled_qa_loopback', url: `urn:litos:qa-receipt:${digest}`, bytes: png.length + 1, sha256: digest }),
  ]) {
    await assert.rejects(storeReceiptScreenshot(key, png, {
      fetchImpl: async () => new Response(body, { status: 200 }),
    }), /malformed or mismatched evidence/);
  }
});

test('production path keeps the public Vercel Blob receipt upload contract', async () => {
  process.env.NODE_ENV = 'production';
  delete process.env.LITOS_QA_RECEIPT_CAPTURE_ENABLED;
  let call: unknown[] | null = null;
  const result = await storeReceiptScreenshot(key, png, {
    blobPut: async (...args) => {
      call = args;
      return { url: 'https://blob.vercel-storage.com/receipt-random.png' };
    },
  });
  assert.deepEqual(call, [key, png, {
    access: 'public',
    contentType: 'image/png',
    addRandomSuffix: true,
  }]);
  assert.equal(result.url, 'https://blob.vercel-storage.com/receipt-random.png');
  assert.equal(result.source, 'vercel_blob');
  assert.equal(result.bytes, png.length);
  assert.equal(result.sha256, digest);
});
