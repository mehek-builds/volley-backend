import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import { verifyUnverifiedSubmissionsRoutes, type VerifyUnverifiedSubmissionsDependencies } from './verifyUnverifiedSubmissions';

const secret = 'verify-sweep-route-test-secret';
const previous = process.env.INTERNAL_CRON_SECRET;
before(() => { process.env.INTERNAL_CRON_SECRET = secret; });
after(() => { if (previous === undefined) delete process.env.INTERNAL_CRON_SECRET; else process.env.INTERNAL_CRON_SECRET = previous; });

const summary = { scanned: 1, outcomes: { confirmed_from_response: 1, page_checked: 0, page_check_failed: 0, not_due: 0, skipped: 0, error: 0 } };

async function withApp(run: (app: ReturnType<typeof Fastify>, calls: unknown[]) => Promise<void>) {
  const calls: unknown[] = [];
  const dependencies: VerifyUnverifiedSubmissionsDependencies = { sweep: async (input) => { calls.push(input); return summary; } };
  const app = Fastify({ logger: false });
  await app.register(verifyUnverifiedSubmissionsRoutes, { dependencies });
  await app.ready();
  try { await run(app, calls); } finally { await app.close(); }
}

test('an authorized call runs the sweep and returns its summary; a limit is forwarded', async () => {
  await withApp(async (app, calls) => {
    const response = await app.inject({ method: 'GET', url: '/internal/verify-unverified-submissions?limit=25', headers: { 'x-internal-secret': secret } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), summary);
    assert.deepEqual(calls, [{ limit: 25 }]);
  });
});

test('an unauthorized call never reaches the sweep', async () => {
  await withApp(async (app, calls) => {
    const response = await app.inject({ method: 'POST', url: '/internal/verify-unverified-submissions' });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(calls, []);
  });
});
