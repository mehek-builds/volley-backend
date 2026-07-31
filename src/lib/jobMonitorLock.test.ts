import assert from 'node:assert/strict';
import test from 'node:test';
import { tryAcquireJobMonitorLock } from './jobMonitorLock';

function fakeConnector(acquired: boolean) {
  const queries: string[] = [];
  let releases = 0;
  return {
    connect: async () => ({
        query: async (text: string) => {
          queries.push(text);
          return { rows: [text.includes('unlock') ? { released: true } : { acquired }] };
        },
        end: () => { releases += 1; },
      }),
    queries,
    releaseCount: () => releases,
  };
}

test('holds one database session until the monitor run releases its lock', async () => {
  const fake = fakeConnector(true);
  const release = await tryAcquireJobMonitorLock(fake.connect);
  assert.ok(release);
  assert.equal(fake.releaseCount(), 0);
  await release();
  await release();
  assert.deepEqual(fake.queries, [
    'select pg_try_advisory_lock($1) as acquired',
    'select pg_advisory_unlock($1) as released',
  ]);
  assert.equal(fake.releaseCount(), 1, 'cleanup must be idempotent');
});

test('declines an overlapping monitor run and immediately returns its connection', async () => {
  const fake = fakeConnector(false);
  assert.equal(await tryAcquireJobMonitorLock(fake.connect), null);
  assert.deepEqual(fake.queries, ['select pg_try_advisory_lock($1) as acquired']);
  assert.equal(fake.releaseCount(), 1);
});
