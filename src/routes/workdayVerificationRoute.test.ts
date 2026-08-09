import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerWorkdayVerificationRoute, type WorkdayVerificationDependencies } from './workdayVerification';

const APPLICATION_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ALIAS = 'app-1111111111-abcdef123456@litos-test.resend.app';

function spec(input: { portalUrl?: string; source?: 'litos_alias' | 'contact_email'; tracked?: boolean } = {}) {
  return {
    _review: { portal_url: input.portalUrl ?? 'https://acme.myworkdayjobs.com/en-US/jobs/job/1/apply' },
    _applicant_email: {
      address: ALIAS,
      source: input.source ?? 'litos_alias',
      reason: 'deliverable',
      tracked: input.tracked ?? true,
      decided_at: '2026-08-09T00:00:00.000Z',
    },
  };
}

async function harness(overrides: Partial<WorkdayVerificationDependencies> = {}) {
  const fastify = Fastify({ logger: false });
  const calls: Array<Parameters<WorkdayVerificationDependencies['findCode']>[0]> = [];
  const deps: WorkdayVerificationDependencies = {
    requireAuth: async (request, reply) => {
      if (request.headers.authorization !== 'Bearer valid') return reply.status(401).send({ error: 'Unauthorized' });
      request.jwtPayload = {
        userId: USER_ID,
        isGuest: false,
        authMethod: 'google',
        sessionVersion: 1,
        authenticatedAt: Date.now(),
      };
    },
    ownedApplication: async () => ({ id: APPLICATION_ID, spec: spec() }),
    resolveActiveAlias: async () => ({ address: ALIAS }),
    findCode: async (input) => { calls.push(input); return { code: '482913', provider: 'composio' }; },
    ...overrides,
  };
  registerWorkdayVerificationRoute(fastify, deps);
  await fastify.ready();
  return { fastify, calls };
}

function request(fastify: Awaited<ReturnType<typeof harness>>['fastify'], requestedAt = new Date().toISOString()) {
  return fastify.inject({
    method: 'POST',
    url: `/applications/${APPLICATION_ID}/workday-verification-code`,
    headers: { authorization: 'Bearer valid' },
    payload: { requested_at: requestedAt },
  });
}

function identityRequest(fastify: Awaited<ReturnType<typeof harness>>['fastify']) {
  return fastify.inject({
    method: 'GET',
    url: `/applications/${APPLICATION_ID}/workday-account-identity`,
    headers: { authorization: 'Bearer valid' },
  });
}

test('Workday account identity is derived from the authenticated owner and exact active packet alias', async () => {
  const { fastify } = await harness();
  const response = await identityRequest(fastify);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    user_id: USER_ID,
    application_id: APPLICATION_ID,
    email: ALIAS,
    portal_host: 'acme.myworkdayjobs.com',
  });
  await fastify.close();
});

test('Workday account identity cannot be read by a different application owner', async () => {
  const { fastify } = await harness({
    ownedApplication: async (_request, reply) => { reply.status(404).send({ error: 'Application not found' }); return null; },
  });
  assert.equal((await identityRequest(fastify)).statusCode, 404);
  await fastify.close();
});

test('Workday verification requires an owned application', async () => {
  const { fastify, calls } = await harness({
    ownedApplication: async (_request, reply) => { reply.status(404).send({ error: 'Application not found' }); return null; },
  });
  const response = await request(fastify);
  assert.equal(response.statusCode, 404);
  assert.equal(calls.length, 0);
  await fastify.close();
});

test('Workday alias verification does not require connected-inbox consent', async () => {
  const { fastify, calls } = await harness();
  const response = await request(fastify);
  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  await fastify.close();
});

test('Workday verification uses only the exact current active Litos alias recipient', async () => {
  const { fastify, calls } = await harness();
  const response = await request(fastify);
  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].expectedRecipient, ALIAS);
  assert.equal(calls[0].applicationId, APPLICATION_ID);
  await fastify.close();

  const mismatch = await harness({ resolveActiveAlias: async () => ({ address: 'other@apply.example.com' }) });
  assert.equal((await request(mismatch.fastify)).statusCode, 409);
  assert.equal(mismatch.calls.length, 0);
  await mismatch.fastify.close();
});

test('Workday verification refuses a tracked fallback address that is not source=litos_alias', async () => {
  const { fastify, calls } = await harness({
    ownedApplication: async () => ({ id: APPLICATION_ID, spec: spec({ source: 'contact_email', tracked: true }) }),
  });
  assert.equal((await request(fastify)).statusCode, 409);
  assert.equal(calls.length, 0);
  await fastify.close();
});

test('Workday verification refuses a custom-domain Litos alias without reading either inbox', async () => {
  const customAlias = 'app-1111111111-abcdef123456@apply.trylitos.com';
  const { fastify, calls } = await harness({
    ownedApplication: async () => ({
      id: APPLICATION_ID,
      spec: {
        ...spec(),
        _applicant_email: {
          ...spec()._applicant_email,
          address: customAlias,
        },
      },
    }),
    resolveActiveAlias: async () => ({ address: customAlias }),
  });
  assert.equal((await request(fastify)).statusCode, 409);
  assert.equal(calls.length, 0);
  await fastify.close();
});

test('Workday verification refuses a non-Workday portal host', async () => {
  const { fastify, calls } = await harness({
    ownedApplication: async () => ({ id: APPLICATION_ID, spec: spec({ portalUrl: 'https://jobs.example.com/apply' }) }),
  });
  assert.equal((await request(fastify)).statusCode, 409);
  assert.equal(calls.length, 0);
  await fastify.close();
});

test('Workday verification refuses stale and future request timestamps', async () => {
  const { fastify, calls } = await harness();
  assert.equal((await request(fastify, new Date(Date.now() - 11 * 60_000).toISOString())).statusCode, 400);
  assert.equal((await request(fastify, new Date(Date.now() + 61_000).toISOString())).statusCode, 400);
  assert.equal(calls.length, 0);
  await fastify.close();
});

test('Workday verification returns 202 while the exact alias has no matching code', async () => {
  const { fastify, calls } = await harness({ findCode: async (input) => { calls.push(input); return null; } });
  const response = await request(fastify);
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { status: 'pending' });
  assert.equal(calls[0].expectedRecipient, ALIAS);
  await fastify.close();
});
