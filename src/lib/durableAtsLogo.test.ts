import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  persistDurableAtsLogo,
  persistDurableHomepageLogo,
  type DurableLogoUploader,
} from './durableAtsLogo';

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test('durable Rippling copies use a content-addressed public path with immutable caching', async () => {
  const previousBase = process.env.OBJECT_STORAGE_PUBLIC_BASE_URL;
  process.env.OBJECT_STORAGE_PUBLIC_BASE_URL = 'https://api.trylitos.com';
  let uploadedPath = '';
  let uploadedBody: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let uploadedOptions: unknown;
  const uploader: DurableLogoUploader = async (pathname, body, options) => {
    uploadedPath = pathname;
    uploadedBody = body;
    uploadedOptions = options;
    return { url: `https://api.trylitos.com/storage/logo/rippling/utility/${pathname.split('/').at(-1)}` };
  };
  try {
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
      addRandomSuffix: false,
      contentType: 'image/png',
      cacheControlMaxAge: 365 * 24 * 60 * 60,
    });
    assert.equal(result, `https://api.trylitos.com/storage/logo/rippling/utility/${digest}.png`);
  } finally {
    if (previousBase === undefined) delete process.env.OBJECT_STORAGE_PUBLIC_BASE_URL;
    else process.env.OBJECT_STORAGE_PUBLIC_BASE_URL = previousBase;
  }
});

test('durable Rippling copies accept only an exact Vercel rollback object path', async () => {
  const digest = createHash('sha256').update(png).digest('hex');
  const pathname = `company-logos/rippling/utility/${digest}.png`;
  const result = await persistDurableAtsLogo({
    provider: 'rippling',
    board_token: 'Utility',
    bytes: png,
    content_type: 'image/png',
  }, async () => ({ url: `https://litos.public.blob.vercel-storage.com/${pathname}` }));
  assert.equal(result, `https://litos.public.blob.vercel-storage.com/${pathname}`);

  await assert.rejects(() => persistDurableAtsLogo({
    provider: 'rippling',
    board_token: 'Utility',
    bytes: png,
    content_type: 'image/png',
  }, async () => ({ url: `https://litos.public.blob.vercel-storage.com/${pathname}-wrong` })), /unsafe_url/);
});

test('durable copy rejects unsupported providers, media types, and returned hosts', async () => {
  const previousBase = process.env.OBJECT_STORAGE_PUBLIC_BASE_URL;
  process.env.OBJECT_STORAGE_PUBLIC_BASE_URL = 'https://api.trylitos.com';
  const uploader: DurableLogoUploader = async () => ({ url: 'https://attacker.example/logo.png' });
  try {
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
  } finally {
    if (previousBase === undefined) delete process.env.OBJECT_STORAGE_PUBLIC_BASE_URL;
    else process.env.OBJECT_STORAGE_PUBLIC_BASE_URL = previousBase;
  }
});

test('durable homepage copies key on the proven domain and keep an ico servable', async () => {
  /* The class this exists for: employers whose infrastructure answers the verifier and refuses
     everyone else (D.A. Davidson, Truecaller, Life Trading, measured 2026-09-01), and whose asset
     is very often a favicon. */
  const previousBase = process.env.OBJECT_STORAGE_PUBLIC_BASE_URL;
  process.env.OBJECT_STORAGE_PUBLIC_BASE_URL = 'https://api.trylitos.com';
  const ico = Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0]);
  let uploadedPath = '';
  let uploadedOptions: { contentType?: string } = {};
  const uploader: DurableLogoUploader = async (pathname, _body, options) => {
    uploadedPath = pathname;
    uploadedOptions = options;
    return { url: `https://api.trylitos.com/storage/logo/homepage/dadavidson.com/${pathname.split('/').at(-1)}` };
  };
  try {
    const result = await persistDurableHomepageLogo({
      company_domain: 'WWW.DaDavidson.com',
      bytes: ico,
      content_type: 'image/vnd.microsoft.icon',
    }, uploader);
    const digest = createHash('sha256').update(ico).digest('hex');
    assert.equal(uploadedPath, `company-logos/homepage/dadavidson.com/${digest}.ico`);
    /* Stored under the type the key's extension maps back to, so the read route and the bytes
       cannot disagree about what is being served. */
    assert.equal(uploadedOptions.contentType, 'image/x-icon');
    assert.equal(result, `https://api.trylitos.com/storage/logo/homepage/dadavidson.com/${digest}.ico`);
  } finally {
    if (previousBase === undefined) delete process.env.OBJECT_STORAGE_PUBLIC_BASE_URL;
    else process.env.OBJECT_STORAGE_PUBLIC_BASE_URL = previousBase;
  }
});

test('durable homepage copies refuse SVG, because our origin would execute it', async () => {
  /* The homepage lane proves SVGs, and this store serves from our own origin, where an SVG opened
     directly runs its own script. Such an asset keeps the employer's URL, exactly as today. */
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  await assert.rejects(
    () => persistDurableHomepageLogo({
      company_domain: 'acme.example',
      bytes: svg,
      content_type: 'image/svg+xml',
    }, async () => ({ url: 'https://api.trylitos.com/storage/logo/homepage/acme.example/x.svg' })),
    /unsafe_url/,
  );
});

test('durable homepage copies refuse anything that is not a bare employer domain', async () => {
  const png2 = png;
  const uploader: DurableLogoUploader = async () => ({ url: 'https://api.trylitos.com/x' });
  for (const domain of [
    'https://acme.example',
    'acme.example/logo.png',
    'acme.example:8443',
    '169.254.169.254',
    'localhost',
    'acme',
    '',
    `${'a'.repeat(200)}.example`,
  ]) {
    await assert.rejects(
      () => persistDurableHomepageLogo({ company_domain: domain, bytes: png2, content_type: 'image/png' }, uploader),
      /unsafe_url/,
      `${domain} must not become a storage key`,
    );
  }
});

test('durable homepage copies refuse an oversized or empty payload', async () => {
  const uploader: DurableLogoUploader = async () => ({ url: 'https://api.trylitos.com/x' });
  for (const bytes of [new Uint8Array(0), new Uint8Array(1_000_001)]) {
    await assert.rejects(
      () => persistDurableHomepageLogo({ company_domain: 'acme.example', bytes, content_type: 'image/png' }, uploader),
      /unsafe_url/,
    );
  }
});

test('durable homepage copies refuse a stored URL that is not our own read path', async () => {
  /* The same rule the Rippling path holds: whatever the uploader answers has to be the public
     read URL for the exact key we wrote, or the copy is not usable evidence. */
  await assert.rejects(
    () => persistDurableHomepageLogo({
      company_domain: 'acme.example',
      bytes: png,
      content_type: 'image/png',
    }, async () => ({ url: 'https://attacker.example/storage/logo/homepage/acme.example/x.png' })),
    /unsafe_url/,
  );
});
