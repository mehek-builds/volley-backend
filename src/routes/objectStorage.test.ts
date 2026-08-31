import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerObjectStorageRoutes, type ObjectStorageRouteDependencies } from './objectStorage';

const digest = 'a'.repeat(64);
const logoKey = `company-logos/rippling/acme~west/${digest}.png`;

async function harness(overrides: Partial<ObjectStorageRouteDependencies> = {}) {
  const fastify = Fastify({ logger: false, routerOptions: { maxParamLength: 128 } });
  const reads: string[] = [];
  registerObjectStorageRoutes(fastify, {
    readObject: async (key) => {
      reads.push(key);
      return Buffer.from('logo-bytes');
    },
    readObjectReadToken: (token) => token === 'valid' ? 'users/user-1/resume.pdf' : null,
    ...overrides,
  });
  await fastify.ready();
  return { fastify, reads };
}

function assertPublicLogoHeaders(headers: Record<string, string | string[] | number | undefined>) {
  assert.equal(headers['content-type'], 'image/png');
  assert.equal(headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(headers['x-content-type-options'], 'nosniff');
}

test('current and compatibility public logo routes serve the exact key with immutable headers', async () => {
  const { fastify, reads } = await harness();
  const longestTenant = `a${'b'.repeat(126)}z`;
  try {
    const current = await fastify.inject({
      method: 'GET',
      url: `/storage/logo/rippling/acme~west/${digest}.png`,
    });
    assert.equal(current.statusCode, 200);
    assertPublicLogoHeaders(current.headers);

    const compatibility = await fastify.inject({
      method: 'GET',
      url: `/storage/public/${logoKey}`,
    });
    assert.equal(compatibility.statusCode, 200);
    assertPublicLogoHeaders(compatibility.headers);

    const boundary = await fastify.inject({
      method: 'GET',
      url: `/storage/logo/rippling/${longestTenant}/${digest}.png`,
    });
    assert.equal(boundary.statusCode, 200);
    assertPublicLogoHeaders(boundary.headers);
    assert.deepEqual(reads, [
      logoKey,
      logoKey,
      `company-logos/rippling/${longestTenant}/${digest}.png`,
    ]);
  } finally {
    await fastify.close();
  }
});

test('public logo routes reject unsupported keys before reading storage', async () => {
  const { fastify, reads } = await harness();
  const longestTenant = `a${'b'.repeat(126)}z`;
  const invalidUrls = [
    `/storage/logo/lever/utility/${digest}.png`,
    `/storage/logo/rippling/utility./${digest}.png`,
    `/storage/logo/rippling/utility~/${digest}.png`,
    `/storage/logo/rippling/%2E%2E/${digest}.png`,
    `/storage/logo/rippling/tenant%2Fother/${digest}.png`,
    `/storage/logo/rippling/utility/${digest}.svg`,
    '/storage/logo/rippling/utility/not-a-digest.png',
    '/storage/public/users/user-1/resume.pdf',
  ];
  try {
    for (const url of invalidUrls) {
      const response = await fastify.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 404, url);
    }
    const tooLong = await fastify.inject({
      method: 'GET',
      url: `/storage/logo/rippling/${longestTenant}z/${digest}.png`,
    });
    assert.equal(tooLong.statusCode, 414);
    assert.deepEqual(reads, []);
  } finally {
    await fastify.close();
  }
});

test('private object route keeps no-store headers and requires a valid capability', async () => {
  const { fastify, reads } = await harness();
  try {
    assert.equal((await fastify.inject({ method: 'GET', url: '/storage/object?t=invalid' })).statusCode, 403);
    const response = await fastify.inject({ method: 'GET', url: '/storage/object?t=valid' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/pdf');
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(reads, ['users/user-1/resume.pdf']);
  } finally {
    await fastify.close();
  }
});
