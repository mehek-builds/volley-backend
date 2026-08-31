import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import {
  type CanonicalApplicationHealDependencies,
  canonicalApplicationHealRoutes,
} from './canonicalApplicationHeal';

const secret = 'heal-route-test-secret';
const previousInternalSecret = process.env.INTERNAL_CRON_SECRET;
const previousCronSecret = process.env.CRON_SECRET;

before(() => {
  process.env.INTERNAL_CRON_SECRET = secret;
  delete process.env.CRON_SECRET;
});

after(() => {
  if (previousInternalSecret === undefined) delete process.env.INTERNAL_CRON_SECRET;
  else process.env.INTERNAL_CRON_SECRET = previousInternalSecret;
  if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousCronSecret;
});

// The before() hook sets the secret for the whole file, so a test that needs the unconfigured
// refusal borrows the environment for its duration and hands it back.
async function withEnv(
  overrides: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const USER_ID = 'a18f774b-a306-4804-93f3-cd6020c27fb3';

function dependencyHarness(outcome = { scanned: 4, healed: 3, unchanged: 1, failed: 0 }) {
  const calls: Array<{ userId?: string; limit?: number } | undefined> = [];
  const dependencies: CanonicalApplicationHealDependencies = {
    reconcile: async (input) => {
      calls.push(input);
      return outcome;
    },
  };
  return { calls, dependencies };
}

async function healTestApp(dependencies: CanonicalApplicationHealDependencies) {
  const app = Fastify({ logger: false });
  await app.register(canonicalApplicationHealRoutes, { dependencies });
  return app;
}

test('an unconfigured deployment refuses rather than running unauthenticated', async () => {
  const { calls, dependencies } = dependencyHarness();
  const app = await healTestApp(dependencies);
  try {
    await withEnv({ INTERNAL_CRON_SECRET: undefined, CRON_SECRET: undefined }, async () => {
      const response = await app.inject({ method: 'POST', url: '/internal/canonical-application-heal' });
      assert.equal(response.statusCode, 503);
    });
    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});

test('a caller with no valid secret is refused before anything is scanned', async () => {
  const { calls, dependencies } = dependencyHarness();
  const app = await healTestApp(dependencies);
  try {
    const bare = await app.inject({ method: 'POST', url: '/internal/canonical-application-heal' });
    assert.equal(bare.statusCode, 401);
    const wrong = await app.inject({
      method: 'POST',
      url: '/internal/canonical-application-heal',
      headers: { 'x-internal-secret': 'not-the-secret' },
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});

test('an authorized call runs the sweep and answers with its counters', async () => {
  const { calls, dependencies } = dependencyHarness();
  const app = await healTestApp(dependencies);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/canonical-application-heal',
      headers: { 'x-internal-secret': secret },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as Record<string, unknown>;
    assert.equal(body.scanned, 4);
    assert.equal(body.healed, 3);
    assert.equal(body.unchanged, 1);
    assert.equal(body.failed, 0);
    assert.ok(typeof body.checked_at === 'string' && !Number.isNaN(new Date(body.checked_at).getTime()));
    assert.deepEqual(calls, [{ userId: undefined, limit: undefined }]);
  } finally {
    await app.close();
  }
});

test('the optional narrowing reaches the sweep, and bad narrowing is a 400 rather than a wider pass', async () => {
  const { calls, dependencies } = dependencyHarness();
  const app = await healTestApp(dependencies);
  try {
    const narrowed = await app.inject({
      method: 'POST',
      url: `/internal/canonical-application-heal?user_id=${USER_ID}&limit=50`,
      headers: { 'x-internal-secret': secret },
    });
    assert.equal(narrowed.statusCode, 200);
    assert.deepEqual(calls, [{ userId: USER_ID, limit: 50 }]);
    // A typo'd user_id that silently widened to "everyone" would heal rows the operator was
    // deliberately not touching yet, so it must refuse instead.
    const typo = await app.inject({
      method: 'POST',
      url: '/internal/canonical-application-heal?user_id=not-a-uuid',
      headers: { 'x-internal-secret': secret },
    });
    assert.equal(typo.statusCode, 400);
    const zero = await app.inject({
      method: 'POST',
      url: '/internal/canonical-application-heal?limit=0',
      headers: { 'x-internal-secret': secret },
    });
    assert.equal(zero.statusCode, 400);
    // A typo'd KEY is the same mistake as a typo'd value: `?userId=` must refuse, not quietly
    // drop the narrowing and heal every account.
    const wrongKey = await app.inject({
      method: 'POST',
      url: `/internal/canonical-application-heal?userId=${USER_ID}`,
      headers: { 'x-internal-secret': secret },
    });
    assert.equal(wrongKey.statusCode, 400);
    assert.equal(calls.length, 1);
  } finally {
    await app.close();
  }
});

/* The counters ride in the body either way, but the status code is all an unattended caller
 * reads, and a pass that left rows split must not record as success anywhere that only sees
 * the code. */
test('a pass that could not heal every row answers 500 with its counters intact', async () => {
  const { dependencies } = dependencyHarness({ scanned: 3, healed: 1, unchanged: 0, failed: 2 });
  const app = await healTestApp(dependencies);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/canonical-application-heal',
      headers: { 'x-internal-secret': secret },
    });
    assert.equal(response.statusCode, 500);
    const body = response.json() as Record<string, unknown>;
    assert.equal(body.healed, 1);
    assert.equal(body.failed, 2);
  } finally {
    await app.close();
  }
});

// GET exists so that deliberately scheduling this later needs no code change: Vercel Cron issues
// GET only and authenticates with `Authorization: Bearer <CRON_SECRET>`.
test('GET answers the same way for a Vercel-Cron-shaped caller', async () => {
  const { calls, dependencies } = dependencyHarness();
  const app = await healTestApp(dependencies);
  try {
    await withEnv({ CRON_SECRET: 'vercel-cron-secret' }, async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/canonical-application-heal',
        headers: { authorization: 'Bearer vercel-cron-secret' },
      });
      assert.equal(response.statusCode, 200);
    });
    assert.equal(calls.length, 1);
  } finally {
    await app.close();
  }
});
