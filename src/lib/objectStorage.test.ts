import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mock, test } from 'node:test';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  mintObjectReadToken,
  objectReadUrl,
  objectStorageConfigured,
  objectStorageUsesRailway,
  putPublicLogoObject,
  publicLogoContentType,
  publicLogoObjectKey,
  publicLogoObjectUrl,
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
    const key = `company-logos/rippling/utility/${digest}.webp`;
    const longestTenant = `a${'b'.repeat(126)}z`;
    assert.equal(
      publicLogoObjectUrl(key),
      `https://api.trylitos.com/storage/logo/rippling/utility/${digest}.webp`,
    );
    assert.equal(publicLogoContentType(key), 'image/webp');
    assert.equal(publicLogoObjectKey({ provider: 'rippling', tenant: 'utility', file: `${digest}.webp` }), key);
    assert.equal(
      publicLogoObjectKey({ provider: 'rippling', tenant: 'acme_co.v2~west', file: `${digest}.png` }),
      `company-logos/rippling/acme_co.v2~west/${digest}.png`,
    );
    assert.equal(
      publicLogoObjectKey({ provider: 'rippling', tenant: longestTenant, file: `${digest}.png` }),
      `company-logos/rippling/${longestTenant}/${digest}.png`,
    );
    assert.equal(publicLogoObjectKey({ provider: 'rippling', tenant: `${longestTenant}z`, file: `${digest}.png` }), null);
    assert.equal(publicLogoObjectKey({ provider: 'rippling', tenant: 'utility~', file: `${digest}.png` }), null);
    assert.equal(publicLogoObjectKey({ provider: 'rippling', tenant: 'utility.', file: `${digest}.png` }), null);
    assert.equal(publicLogoObjectKey({ provider: 'rippling', tenant: '..', file: `${digest}.png` }), null);
    assert.equal(publicLogoObjectKey({ provider: 'lever', tenant: 'utility', file: `${digest}.png` }), null);
    assert.throws(() => publicLogoObjectUrl('users/user-1/resume.pdf'), /Invalid public logo object key/);
  });
});

test('public logo upload verifies its digest and sends immutable S3 cache metadata', async () => {
  const body = Buffer.from('verified logo bytes');
  const digest = createHash('sha256').update(body).digest('hex');
  const objectKey = `company-logos/rippling/acme~west/${digest}.png`;
  const commands: unknown[] = [];
  const send = mock.method(S3Client.prototype, 'send', async (command: unknown) => {
    commands.push(command);
    return {};
  });

  try {
    await withStorageEnv({
      BUCKET: 'litos-files',
      ACCESS_KEY_ID: 'access-key',
      SECRET_ACCESS_KEY: 'secret-key',
      ENDPOINT: 'https://storage.railway.app',
      BLOB_READ_WRITE_TOKEN: 'rollback-token',
      PUBLIC_API_BASE: 'https://api.trylitos.com',
    }, async () => {
      const stored = await putPublicLogoObject(objectKey, body, 'image/png');
      assert.deepEqual(stored, {
        url: `https://api.trylitos.com/storage/logo/rippling/acme~west/${digest}.png`,
        pathname: objectKey,
      });
      assert.equal(commands.length, 1);
      assert.ok(commands[0] instanceof PutObjectCommand);
      assert.equal(commands[0].input.Bucket, 'litos-files');
      assert.equal(commands[0].input.Key, objectKey);
      assert.equal(commands[0].input.ContentType, 'image/png');
      assert.equal(commands[0].input.CacheControl, 'public, max-age=31536000, immutable');
      await assert.rejects(
        putPublicLogoObject(
          `company-logos/rippling/acme~west/${'0'.repeat(64)}.png`,
          body,
          'image/png',
        ),
        /Invalid public logo object/,
      );
      assert.equal(commands.length, 1);
    });
  } finally {
    send.mock.restore();
  }
});
