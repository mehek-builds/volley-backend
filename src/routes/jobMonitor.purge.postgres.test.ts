import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';

function runProcess(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

  const rootDir = mkdtempSync('/tmp/litos-purge-postgres-');
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
  const port = 55445;
  const server = spawn(postgres, [
    '-D', dataDir,
    '-p', String(port),
    '-h', '',
    '-k', socketDir,
    '-F',
    '-c', 'synchronous_commit=off',
    '-c', 'full_page_writes=off',
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

test('purge lock contention cancels server-side, releases the monitor lock and retries once', {
  timeout: 30_000,
}, async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const postgres = await startEphemeralPostgres();
  process.env.DATABASE_URL = postgres.databaseUrl;
  const client = new pg.Client({ connectionString: postgres.databaseUrl });
  const blocker = new pg.Client({ connectionString: postgres.databaseUrl });
  let pool: typeof import('../db/index')['pool'] | undefined;
  try {
    await client.connect();
    await blocker.connect();
    await client.query(`
      create table monitored_jobs (
        id uuid primary key,
        is_active boolean not null,
        last_seen_at timestamptz not null
      );
      insert into monitored_jobs (id, is_active, last_seen_at)
      values ('92000000-0000-4000-8000-000000000001', false, '2020-01-01T00:00:00Z');
    `);

    const dbModule = await import('../db/index');
    pool = dbModule.pool;
    const monitor = await import('./jobMonitor');
    const { tryAcquireJobMonitorLock } = await import('../lib/jobMonitorLock');

    await blocker.query('begin');
    await blocker.query('lock table monitored_jobs in access exclusive mode');
    const releaseMonitorLock = await tryAcquireJobMonitorLock();
    assert.ok(releaseMonitorLock);
    const startedAt = Date.now();
    try {
      await assert.rejects(
        monitor.purgeExpiredPostings(),
        (error: unknown) => {
          assert.ok(error instanceof monitor.JobBoardPurgeTimeoutError);
          assert.equal(error.stage, 'purge_delete');
          assert.equal(error.timeoutMs, monitor.PURGE_POSTINGS_LOCK_TIMEOUT_MS);
          return true;
        },
      );
    } finally {
      await releaseMonitorLock();
    }
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= monitor.PURGE_POSTINGS_LOCK_TIMEOUT_MS - 500);
    assert.ok(elapsedMs < monitor.PURGE_POSTINGS_LOCK_TIMEOUT_MS + 3_000,
      'PostgreSQL must cancel the blocked DELETE before the worker client timeout');
    assert.equal((await blocker.query('select count(*)::int as total from monitored_jobs')).rows[0].total, 1,
      'the lock-owning transaction must still see the row after the canceled DELETE');

    const reacquiredMonitorLock = await tryAcquireJobMonitorLock();
    assert.ok(reacquiredMonitorLock, 'the route cleanup path must make the shared lock acquirable');
    await reacquiredMonitorLock();

    await blocker.query('rollback');
    assert.equal(await monitor.purgeExpiredPostings(), 1);
    assert.equal((await client.query('select count(*)::int as total from monitored_jobs')).rows[0].total, 0);
  } finally {
    await blocker.query('rollback').catch(() => undefined);
    await blocker.end().catch(() => undefined);
    await client.end().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await postgres.stop();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
