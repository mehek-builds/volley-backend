/* Contract test for the POST /jobs/extract inventory-lookup indexes.
 *
 * Runs the real migration against an ephemeral PostgreSQL, so what is asserted is the SQL the
 * script actually issues rather than a restatement of it. Four things matter and none of them are
 * visible from reading the script alone: both indexes exist and are VALID (a CONCURRENTLY build
 * that fails partway leaves an INVALID index the planner silently refuses to use), they are
 * PARTIAL on the predicate the lookup carries, re-running changes nothing, and the planner actually
 * combines them with a BitmapOr for the OR-of-two-columns shape they were built for.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import pg from 'pg';

const MIGRATION = 'scripts/apply-monitored-job-url-lookup-index.mjs';
const APPLY_IDX = 'monitored_jobs_apply_url_lookup_idx';
const POSTING_IDX = 'monitored_jobs_posting_url_lookup_idx';

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function startEphemeralPostgres() {
  const bindir = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
  const initdb = join(bindir, 'initdb');
  const postgres = join(bindir, 'postgres');
  if (!existsSync(initdb) || !existsSync(postgres)) {
    throw new Error(`PostgreSQL server binaries are required in ${bindir}`);
  }

  const rootDir = mkdtempSync('/tmp/litos-url-lookup-idx-');
  const dataDir = join(rootDir, 'data');
  const socketDir = join(rootDir, 'socket');
  mkdirSync(socketDir);
  await runProcess(initdb, [
    '--pgdata', dataDir,
    '--auth=trust',
    '--encoding=UTF8',
    '--no-locale',
    '--username=postgres',
  ]);
  const port = 55447;
  const server = spawn(postgres, [
    '-D', dataDir,
    '-p', String(port),
    '-h', '',
    '-k', socketDir,
    '-F',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  server.stdout.setEncoding('utf8').on('data', (chunk) => { logs += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { logs += chunk; });
  const databaseUrl = `postgresql://postgres@localhost:${port}/postgres?host=${socketDir}`;

  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) break;
    const probe = new pg.Client({ connectionString: databaseUrl });
    try {
      await probe.connect();
      await probe.query('select 1');
      await probe.end();
      ready = true;
      break;
    } catch {
      await probe.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!ready) {
    server.kill('SIGTERM');
    rmSync(rootDir, { recursive: true, force: true });
    throw new Error(`Ephemeral PostgreSQL did not become ready: ${logs}`);
  }
  return {
    databaseUrl,
    async stop() {
      if (server.exitCode === null) {
        const closed = new Promise((resolve) => server.once('close', resolve));
        server.kill('SIGTERM');
        await closed;
      }
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

function runMigration(databaseUrl) {
  return runProcess(process.execPath, [MIGRATION], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

async function createMonitoredJobs(client) {
  await client.query(`
    create table monitored_jobs (
      id uuid primary key default gen_random_uuid(),
      apply_url text not null,
      posting_url text not null,
      is_active boolean not null default true,
      ingest_eligible boolean not null default false,
      last_seen_at timestamptz not null default now()
    );
  `);
  // Enough rows that the planner has a reason to prefer an index over a scan of a toy table.
  await client.query(`
    insert into monitored_jobs (apply_url, posting_url, is_active, ingest_eligible)
    select
      'https://acme.breezy.hr/p/' || g || '-role/apply',
      'https://acme.breezy.hr/p/' || g || '-role',
      true,
      true
    from generate_series(1, 5000) g;
  `);
  await client.query('analyze monitored_jobs');
}

test('package exposes the index migration and its contract test', () => {
  const packageJson = JSON.parse(execFileSync('node', ['-e',
    "process.stdout.write(require('node:fs').readFileSync('package.json','utf8'))"],
  { encoding: 'utf8' }));
  assert.equal(packageJson.scripts['db:monitored-job-url-lookup-index'], `node ${MIGRATION}`);
  assert.equal(
    packageJson.scripts['test:monitored-job-url-lookup-index'],
    `node --test ${MIGRATION.replace('.mjs', '.test.mjs')}`,
  );
});

test('creates both partial indexes, is idempotent, and the planner uses them', {
  timeout: 120_000,
}, async () => {
  const postgres = await startEphemeralPostgres();
  const client = new pg.Client({ connectionString: postgres.databaseUrl });
  try {
    await client.connect();
    await createMonitoredJobs(client);

    const first = await runMigration(postgres.databaseUrl);
    assert.match(first.stdout, /ready: both indexes present and valid/);
    // The row census is reported so an operator can see what is about to be scanned.
    assert.match(first.stdout, /monitored_jobs holds 5000 rows; 5000 match the partial predicate/);

    const { rows: created } = await client.query(
      `select c.relname, i.indisvalid, pg_get_indexdef(i.indexrelid) as def
         from pg_class c join pg_index i on i.indexrelid = c.oid
        where c.relname = any($1) order by c.relname`,
      [[APPLY_IDX, POSTING_IDX]],
    );
    assert.equal(created.length, 2, 'both indexes must exist');

    for (const row of created) {
      assert.equal(row.indisvalid, true, `${row.relname} must be VALID, not a half-built CONCURRENTLY index`);
      /* PARTIAL on the predicate the lookup itself carries. Without the WHERE the index would also
         carry closed and unvalidated rows, which the route can never serve anyway. Matched against
         PostgreSQL's own normalization of the predicate, not the spelling the script sends. */
      assert.match(row.def, /WHERE \(\(is_active = true\) AND \(ingest_eligible = true\)\)/);
    }
    assert.match(created[0].def, /\(apply_url\)/);
    assert.match(created[1].def, /\(posting_url\)/);

    // Re-running must be a no-op rather than an error: CREATE INDEX IF NOT EXISTS, and the script
    // is the documented way to bring any environment up to date whatever state it starts in.
    const second = await runMigration(postgres.databaseUrl);
    assert.match(second.stdout, /ready: both indexes present and valid/);
    const [{ count }] = (await client.query(
      `select count(*)::int as count from pg_class where relname = any($1)`,
      [[APPLY_IDX, POSTING_IDX]],
    )).rows;
    assert.equal(count, 2, 'a second run must not duplicate or drop the indexes');

    /* THE POINT OF THE WHOLE CHANGE. The lookup is an OR across two different columns, which no
       single composite index can serve; this asserts the planner combines the two with a BitmapOr
       instead of falling back to the sequential scan that cost 283 ms against production. */
    const keys = ['https://acme.breezy.hr/p/42-role/apply', 'https://acme.breezy.hr/p/42-role'];
    const { rows: plan } = await client.query(
      `explain (costs off)
       select id from monitored_jobs
        where (apply_url = any($1) or posting_url = any($2))
          and is_active = true and ingest_eligible = true
        order by last_seen_at desc limit 5`,
      [keys, keys],
    );
    const planText = plan.map((r) => r['QUERY PLAN']).join('\n');
    assert.match(planText, /BitmapOr/, `expected a BitmapOr over both indexes, got:\n${planText}`);
    assert.match(planText, new RegExp(APPLY_IDX));
    assert.match(planText, new RegExp(POSTING_IDX));
    assert.doesNotMatch(planText, /Seq Scan on monitored_jobs/, 'the scan this index exists to remove came back');
  } finally {
    await client.end().catch(() => undefined);
    await postgres.stop();
  }
});
