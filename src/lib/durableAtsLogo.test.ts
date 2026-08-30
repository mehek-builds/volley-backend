import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { persistDurableAtsLogo, type DurableLogoUploader } from './durableAtsLogo';

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test('durable Rippling copies use a content-addressed public path with immutable caching', async () => {
  let uploadedPath = '';
  let uploadedBody: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let uploadedOptions: unknown;
  const uploader: DurableLogoUploader = async (pathname, body, options) => {
    uploadedPath = pathname;
    uploadedBody = body;
    uploadedOptions = options;
    return { url: `https://litos.public.blob.vercel-storage.com/${pathname}` };
  };

  const result = await persistDurableAtsLogo({
    provider: 'rippling',
    board_token: 'Utility',
    bytes: png,
    content_type: 'image/png',
  }, uploader);
  const digest = createHash('sha256').update(png).digest('hex');
  assert.equal(uploadedPath, `company-logos/rippling/utility/${digest}.png`);
  assert.deepEqual(uploadedBody, Buffer.from(png));
  assert.deepEqual(uploadedOptions, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'image/png',
    cacheControlMaxAge: 365 * 24 * 60 * 60,
  });
  assert.equal(result, `https://litos.public.blob.vercel-storage.com/${uploadedPath}`);
});

test('durable copy rejects unsupported providers, media types, and returned hosts', async () => {
  const uploader: DurableLogoUploader = async () => ({ url: 'https://attacker.example/logo.png' });
  await assert.rejects(() => persistDurableAtsLogo({
    provider: 'lever',
    board_token: 'acme',
    bytes: png,
    content_type: 'image/png',
  }, uploader), /unsafe_url/);
  await assert.rejects(() => persistDurableAtsLogo({
    provider: 'rippling',
    board_token: 'acme',
    bytes: png,
    content_type: 'image/svg+xml',
  }, uploader), /unsafe_url/);
  await assert.rejects(() => persistDurableAtsLogo({
    provider: 'rippling',
    board_token: 'acme',
    bytes: png,
    content_type: 'image/png',
  }, uploader), /unsafe_url/);
});
