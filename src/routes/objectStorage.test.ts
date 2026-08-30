import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { objectStorageRoutes } from './objectStorage';

const DIGEST = 'a'.repeat(64);

test('public logo route serves only the exact constrained key assembled from route parameters', async () => {
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 128 } });
  const reads: string[] = [];
  const longestTenant = `a${'b'.repeat(126)}z`;
  await objectStorageRoutes(app, {
    readStoredObject: async (key) => {
      reads.push(key);
      return Buffer.from('logo');
    },
  });
  await app.ready();

  try {
    const response = await app.inject({
      method: 'GET',
      url: `/storage/logo/rippling/acme_co.v2~west/${DIGEST}.webp`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'logo');
    assert.equal(response.headers['content-type'], 'image/webp');
    assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    const boundary = await app.inject({
      method: 'GET',
      url: `/storage/logo/rippling/${longestTenant}/${DIGEST}.png`,
    });
    assert.equal(boundary.statusCode, 200);
    assert.deepEqual(reads, [
      `company-logos/rippling/acme_co.v2~west/${DIGEST}.webp`,
      `company-logos/rippling/${longestTenant}/${DIGEST}.png`,
    ]);
  } finally {
    await app.close();
  }
});

test('public logo route rejects parameter injection before reading object storage', async () => {
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 128 } });
  const reads: string[] = [];
  await objectStorageRoutes(app, {
    readStoredObject: async (key) => {
      reads.push(key);
      return Buffer.from('should not be read');
    },
  });
  await app.ready();

  const longestTenant = `a${'b'.repeat(126)}z`;
  const invalidUrls = [
    `/storage/logo/lever/utility/${DIGEST}.png`,
    `/storage/logo/rippling/utility./${DIGEST}.png`,
    `/storage/logo/rippling/utility~/${DIGEST}.png`,
    `/storage/logo/rippling/%2E%2E/${DIGEST}.png`,
    `/storage/logo/rippling/tenant%2Fother/${DIGEST}.png`,
    `/storage/logo/rippling/utility/${DIGEST}.svg`,
    '/storage/logo/rippling/utility/not-a-digest.png',
  ];

  try {
    for (const url of invalidUrls) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 404, url);
    }
    const tooLong = await app.inject({
      method: 'GET',
      url: `/storage/logo/rippling/${longestTenant}z/${DIGEST}.png`,
    });
    assert.equal(tooLong.statusCode, 414);
    assert.deepEqual(reads, []);
  } finally {
    await app.close();
  }
});
