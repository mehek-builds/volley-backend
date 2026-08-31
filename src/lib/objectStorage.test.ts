import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  mintObjectReadToken,
  isPublicObjectKey,
  isPublicLogoObjectReadUrlForKey,
  isPublicObjectReadUrlForKey,
  objectReadUrl,
  objectStorageConfigured,
  objectStorageUsesRailway,
  publicObjectReadUrl,
  publicLogoContentType,
  publicLogoObjectKey,
  publicLogoObjectUrl,
  putPublicLogoObject,
  readObjectReadToken,
} from './objectStorage';

const storageVariables = [
  'ACCESS_KEY_ID',
  'BLOB_READ_WRITE_TOKEN',
  'BUCKET',
  'ENDPOINT',
  'ENCRYPTION_KEY',
  'OBJECT_STORAGE_ACCESS_KEY_ID',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_PUBLIC_BASE_URL',
  'OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'PUBLIC_API_BASE',
  'SECRET_ACCESS_KEY',
] as const;

async function withStorageEnv(
  values: Partial<Record<(typeof storageVariables)[number], string | undefined>>,
  run: () => void | Promise<void>,
) {
  const previous = Object.fromEntries(storageVariables.map((key) => [key, process.env[key]]));
  try {
    for (const key of storageVariables) delete process.env[key];
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) process.env[key] = value;
    }
    await run();
  } finally {
    for (const key of storageVariables) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('Railway native bucket credentials configure the private object store', async () => {
  await withStorageEnv({
    BUCKET: 'litos-files',
    ACCESS_KEY_ID: 'access-key',
    SECRET_ACCESS_KEY: 'secret-key',
    ENDPOINT: 'https://storage.railway.app',
  }, () => {
    assert.equal(objectStorageConfigured(), true);
    assert.equal(objectStorageUsesRailway(), true);
  });
});

test('Vercel Blob remains a rollback provider when Railway credentials are absent', async () => {
  await withStorageEnv({ BLOB_READ_WRITE_TOKEN: 'rollback-token' }, () => {
    assert.equal(objectStorageConfigured(), true);
    assert.equal(objectStorageUsesRailway(), false);
  });
});

test('private object links are opaque, authenticated, and bound to the exact key', async () => {
  await withStorageEnv({
    ENCRYPTION_KEY: 'migration-test-encryption-key',
    PUBLIC_API_BASE: 'https://api.trylitos.com',
  }, () => {
    const key = 'users/user-1/resumes/resume.pdf';
    const token = mintObjectReadToken(key);
    assert.equal(readObjectReadToken(token), key);
    assert.equal(readObjectReadToken(`${token.slice(0, -1)}x`), null);
    assert.match(objectReadUrl(key), /^https:\/\/api\.trylitos\.com\/storage\/object\?t=/);
    assert.doesNotMatch(objectReadUrl(key), /users|resume\.pdf/);
  });
});

test('object tokens refuse traversal-shaped keys', async () => {
  await withStorageEnv({ ENCRYPTION_KEY: 'migration-test-encryption-key' }, () => {
    assert.equal(readObjectReadToken(mintObjectReadToken('../private.pdf')), null);
    assert.equal(readObjectReadToken(mintObjectReadToken('users\\private.pdf')), null);
    assert.equal(readObjectReadToken(mintObjectReadToken('/absolute.pdf')), null);
  });
});

test('public logo links accept only content-addressed Rippling image keys', async () => {
  await withStorageEnv({ PUBLIC_API_BASE: 'https://api.trylitos.com' }, () => {
    const digest = 'a'.repeat(64);
    const tenant = `a${'b'.repeat(125)}~z`;
    const key = `company-logos/rippling/${tenant}/${digest}.webp`;
    const canonicalUrl = `https://api.trylitos.com/storage/logo/rippling/${tenant}/${digest}.webp`;
    const compatibilityUrl = `https://api.trylitos.com/storage/public/${key}`;
    assert.equal(
      publicLogoObjectUrl(key),
      canonicalUrl,
    );
    assert.equal(publicLogoContentType(key), 'image/webp');
    assert.equal(publicLogoObjectKey({ provider: 'rippling', tenant, file: `${digest}.webp` }), key);
    assert.equal(
      publicLogoObjectKey({ provider: 'rippling', tenant: 'acme_co.v2~west', file: `${digest}.png` }),
      `company-logos/rippling/acme_co.v2~west/${digest}.png`,
    );
    assert.equal(isPublicObjectKey(key), true);
    assert.equal(publicObjectReadUrl(key), compatibilityUrl);
    assert.equal(isPublicObjectReadUrlForKey(compatibilityUrl, key), true);
    assert.equal(isPublicLogoObjectReadUrlForKey(canonicalUrl, key), true);
    assert.equal(isPublicLogoObjectReadUrlForKey(compatibilityUrl, key), true);
    assert.equal(
      isPublicLogoObjectReadUrlForKey(`https://litos.public.blob.vercel-storage.com/${key}`, key),
      true,
    );
    assert.equal(isPublicLogoObjectReadUrlForKey(`${canonicalUrl}?download=1`, key), false);
    assert.equal(isPublicObjectReadUrlForKey(`${compatibilityUrl}?download=1`, key), false);
    assert.equal(publicLogoObjectKey({ provider: 'rippling', tenant: '..', file: `${digest}.png` }), null);
    assert.equal(publicLogoObjectKey({ provider: 'rippling', tenant: 'utility~', file: `${digest}.png` }), null);
    assert.equal(publicLogoObjectKey({ provider: 'rippling', tenant: 'utility.', file: `${digest}.png` }), null);
    assert.equal(publicLogoObjectKey({ provider: 'lever', tenant: 'utility', file: `${digest}.png` }), null);
    assert.equal(
      publicLogoObjectKey({
        provider: 'rippling',
        tenant: `a${'b'.repeat(127)}z`,
        file: `${digest}.png`,
      }),
      null,
    );
    assert.equal(isPublicObjectKey('users/user-1/resumes/private.pdf'), false);
    assert.throws(() => publicLogoObjectUrl('users/user-1/resume.pdf'), /Invalid public logo object key/);
    assert.throws(() => publicObjectReadUrl('../private.pdf'), /not public/);
  });
});

test('public logo URLs remain stable across private capability key rotation', async () => {
  await withStorageEnv({
    ENCRYPTION_KEY: 'old-private-capability-key',
    PUBLIC_API_BASE: 'https://api.trylitos.com',
  }, () => {
    const key = `company-logos/rippling/utility/${'b'.repeat(64)}.png`;
    const before = publicLogoObjectUrl(key);
    process.env.ENCRYPTION_KEY = 'new-private-capability-key';
    assert.equal(publicLogoObjectUrl(key), before);
    assert.equal(publicObjectReadUrl(key), `https://api.trylitos.com/storage/public/${key}`);
  });
});

test('Railway public logo writes use the exact key, MIME type, and immutable cache policy', async () => {
  await withStorageEnv({
    BUCKET: 'litos-files',
    ACCESS_KEY_ID: 'access-key',
    SECRET_ACCESS_KEY: 'secret-key',
    ENDPOINT: 'https://storage.railway.app',
    PUBLIC_API_BASE: 'https://api.trylitos.com',
  }, async () => {
    const body = Buffer.from('logo');
    const digest = createHash('sha256').update(body).digest('hex');
    const key = `company-logos/rippling/utility/${digest}.png`;
    let command: PutObjectCommand | undefined;
    let requestOptions: { abortSignal?: AbortSignal } | undefined;
    const controller = new AbortController();
    const stored = await putPublicLogoObject(key, body, 'image/png', {
      railwayPut: async (input, options) => {
        command = input;
        requestOptions = options;
      },
    }, controller.signal);

    assert.ok(command);
    assert.equal(command.input.Bucket, 'litos-files');
    assert.equal(command.input.Key, key);
    assert.deepEqual(command.input.Body, body);
    assert.equal(command.input.ContentType, 'image/png');
    assert.equal(command.input.CacheControl, 'public, max-age=31536000, immutable');
    assert.equal(requestOptions?.abortSignal, controller.signal);
    assert.deepEqual(stored, {
      pathname: key,
      url: `https://api.trylitos.com/storage/logo/rippling/utility/${digest}.png`,
    });
  });
});

test('Vercel public logo fallback disables suffixes and validates the exact returned path', async () => {
  await withStorageEnv({ BLOB_READ_WRITE_TOKEN: 'rollback-token' }, async () => {
    const body = Buffer.from('logo');
    const digest = createHash('sha256').update(body).digest('hex');
    const key = `company-logos/rippling/utility/${digest}.webp`;
    const url = `https://litos.public.blob.vercel-storage.com/${key}`;
    let receivedOptions: unknown;
    const stored = await putPublicLogoObject(key, body, 'image/webp', {
      vercelPut: async (_pathname, _body, options) => {
        receivedOptions = options;
        return { pathname: key, url };
      },
    });

    assert.deepEqual(receivedOptions, {
      access: 'public',
      contentType: 'image/webp',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 365 * 24 * 60 * 60,
    });
    assert.deepEqual(stored, { pathname: key, url });

    await assert.rejects(() => putPublicLogoObject(key, body, 'image/webp', {
      vercelPut: async () => ({ pathname: `${key}-wrong`, url }),
    }), /mismatched object path/);
    await assert.rejects(() => putPublicLogoObject(key, body, 'image/webp', {
      vercelPut: async () => ({ pathname: key, url: `${url}?download=1` }),
    }), /mismatched object path/);
  });
});

test('public logo writes reject extension and MIME disagreement before touching either provider', async () => {
  await withStorageEnv({ BLOB_READ_WRITE_TOKEN: 'rollback-token' }, async () => {
    const body = Buffer.from('logo');
    const digest = createHash('sha256').update(body).digest('hex');
    const key = `company-logos/rippling/utility/${digest}.png`;
    let wrote = false;
    await assert.rejects(() => putPublicLogoObject(key, body, 'image/jpeg', {
      vercelPut: async () => {
        wrote = true;
        return { pathname: key, url: `https://litos.public.blob.vercel-storage.com/${key}` };
      },
    }), /Invalid public logo object/);
    assert.equal(wrote, false);
  });
});

test('public logo writes reject a digest that does not match the body before touching either provider', async () => {
  await withStorageEnv({ BLOB_READ_WRITE_TOKEN: 'rollback-token' }, async () => {
    const key = `company-logos/rippling/utility/${'e'.repeat(64)}.png`;
    let wrote = false;
    await assert.rejects(() => putPublicLogoObject(key, Buffer.from('different logo'), 'image/png', {
      vercelPut: async () => {
        wrote = true;
        return { pathname: key, url: `https://litos.public.blob.vercel-storage.com/${key}` };
      },
    }), /Invalid public logo object/);
    assert.equal(wrote, false);
  });
});
