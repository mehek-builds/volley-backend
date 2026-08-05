import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const previousDatabaseUrl = process.env.DATABASE_URL;

let socketDir: string;
let pglite: PGlite;
let server: PGLiteSocketServer;
let pool: typeof import('../db/index')['pool'];
let quota: typeof import('./quota');

before(async () => {
  socketDir = mkdtempSync(join(tmpdir(), 'litos-quota-legacy-'));
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({ db: pglite, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;

  await pglite.exec(`
    create table usage_counters (
      "key" text not null,
      period text not null,
      kind text not null,
      count integer default 0 not null
    );
  `);

  quota = await import('./quota');
  ({ pool } = await import('../db/index'));
});

after(async () => {
  await pool?.end();
  await server?.stop();
  await pglite?.close();
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

test('bumpCounter does not require a usage_counters primary key', async () => {
  const first = await quota.bumpCounter('mehekman@usc.edu', '2026-08-05T14', 'rate:request-code');
  const second = await quota.bumpCounter('mehekman@usc.edu', '2026-08-05T14', 'rate:request-code');

  assert.equal(first, 1);
  assert.equal(second, 2);

  const { rows } = await pglite.query(
    `select "key", period, kind, count
       from usage_counters
      where "key" = 'mehekman@usc.edu'
        and period = '2026-08-05T14'
        and kind = 'rate:request-code'`,
  );
  assert.deepEqual(rows, [{
    key: 'mehekman@usc.edu',
    period: '2026-08-05T14',
    kind: 'rate:request-code',
    count: 2,
  }]);
});

test('claimCounterSlot respects the limit without relying on on conflict', async () => {
  const first = await quota.claimCounterSlot('user-1', '2026-08', 'resumes', 2);
  const second = await quota.claimCounterSlot('user-1', '2026-08', 'resumes', 2);
  const third = await quota.claimCounterSlot('user-1', '2026-08', 'resumes', 2);

  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(third, null);
});

test('getCount conservatively sums duplicate logical counters on a legacy table', async () => {
  await pglite.query(`
    insert into usage_counters ("key", period, kind, count)
    values
      ('dupe-user', '2026-08', 'resumes', 3),
      ('dupe-user', '2026-08', 'resumes', 4),
      ('dupe-user', '2026-08', 'drafts', 8)
  `);

  assert.equal(await quota.getCount('dupe-user', '2026-08', 'resumes'), 7);
});

test('bumpCounter normalizes existing duplicate rows before incrementing', async () => {
  await pglite.query(`
    insert into usage_counters ("key", period, kind, count)
    values
      ('dupe-bump', '2026-08-05T15', 'rate:request-code', 2),
      ('dupe-bump', '2026-08-05T15', 'rate:request-code', 5)
  `);

  const bumped = await quota.bumpCounter('dupe-bump', '2026-08-05T15', 'rate:request-code');

  assert.equal(bumped, 8);

  const { rows } = await pglite.query(
    `select "key", period, kind, count
       from usage_counters
      where "key" = 'dupe-bump'
        and period = '2026-08-05T15'
        and kind = 'rate:request-code'`,
  );
  assert.deepEqual(rows, [{
    key: 'dupe-bump',
    period: '2026-08-05T15',
    kind: 'rate:request-code',
    count: 8,
  }]);
});

test('claimCounterSlot refuses duplicate rows that are already over the limit and normalizes them', async () => {
  await pglite.query(`
    insert into usage_counters ("key", period, kind, count)
    values
      ('dupe-claim', '2026-08', 'resumes', 1),
      ('dupe-claim', '2026-08', 'resumes', 2)
  `);

  const claimed = await quota.claimCounterSlot('dupe-claim', '2026-08', 'resumes', 3);

  assert.equal(claimed, null);

  const { rows } = await pglite.query(
    `select "key", period, kind, count
       from usage_counters
      where "key" = 'dupe-claim'
        and period = '2026-08'
        and kind = 'resumes'`,
  );
  assert.deepEqual(rows, [{
    key: 'dupe-claim',
    period: '2026-08',
    kind: 'resumes',
    count: 3,
  }]);
});

test('releaseCounterSlot normalizes duplicate rows while refunding', async () => {
  await pglite.query(`
    insert into usage_counters ("key", period, kind, count)
    values
      ('dupe-release', '2026-08', 'resumes', 4),
      ('dupe-release', '2026-08', 'resumes', 3)
  `);

  await quota.releaseCounterSlot('dupe-release', '2026-08', 'resumes', 2);

  const { rows } = await pglite.query(
    `select "key", period, kind, count
       from usage_counters
      where "key" = 'dupe-release'
        and period = '2026-08'
        and kind = 'resumes'`,
  );
  assert.deepEqual(rows, [{
    key: 'dupe-release',
    period: '2026-08',
    kind: 'resumes',
    count: 5,
  }]);
});
