import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import pg from 'pg';

const MIGRATION = 'scripts/apply-logo-provider-circuit-schema.mjs';

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

  const rootDir = mkdtempSync('/tmp/litos-logo-circuit-');
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
  const port = 55443;
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

test('package exposes the provider-circuit migration and its contract test', () => {
  const packageJson = JSON.parse(execFileSync('node', ['-e',
    "process.stdout.write(require('node:fs').readFileSync('package.json','utf8'))"],
  { encoding: 'utf8' }));
  assert.equal(packageJson.scripts['db:logo-provider-circuit'], `node ${MIGRATION}`);
  assert.equal(
    packageJson.scripts['test:logo-provider-circuit-migration'],
    'node --test scripts/apply-logo-provider-circuit-schema.test.mjs',
  );
});

test('migration is idempotent and preserves attempts plus live circuit state', {
  timeout: 60_000,
}, async () => {
  const postgres = await startEphemeralPostgres();
  const client = new pg.Client({ connectionString: postgres.databaseUrl });
  try {
    await client.connect();
    await client.query(`
      create table career_page_sources (
        id uuid primary key,
        company_name text not null
      );
      insert into career_page_sources (id, company_name)
      values ('10000000-0000-4000-8000-000000000001', 'Crelate Co');
    `);

    const first = await runMigration(postgres.databaseUrl);
    assert.match(first.stdout, /Logo provider circuit schema is ready/);
    await client.query(`
      update career_page_sources set logo_provider_429_attempts = 2;
      update logo_verification_provider_circuits
      set circuit_open_until = '2026-09-01T00:15:00Z',
          active_claim_token = 'claim-1',
          active_claim_expires_at = '2026-09-01T00:10:00Z'
      where provider = 'crelate';
    `);

    const second = await runMigration(postgres.databaseUrl);
    assert.match(second.stdout, /Logo provider circuit schema is ready/);
    const source = await client.query(`
      select logo_provider_429_attempts from career_page_sources
    `);
    assert.equal(source.rows[0].logo_provider_429_attempts, 2);
    const circuit = await client.query(`
      select provider, circuit_open_until, active_claim_token, active_claim_expires_at
      from logo_verification_provider_circuits
    `);
    assert.equal(circuit.rowCount, 1);
    assert.equal(circuit.rows[0].provider, 'crelate');
    assert.equal(circuit.rows[0].active_claim_token, 'claim-1');
    assert.equal(circuit.rows[0].circuit_open_until.toISOString(), '2026-09-01T00:15:00.000Z');

    await assert.rejects(
      client.query('update career_page_sources set logo_provider_429_attempts = 4'),
      /career_page_sources_logo_provider_429_attempts_check/,
    );
    await assert.rejects(
      client.query(`
        update logo_verification_provider_circuits
        set active_claim_token = null
        where provider = 'crelate'
      `),
      /logo_verification_provider_circuits_claim_pair_check/,
    );
  } finally {
    await client.end().catch(() => undefined);
    await postgres.stop();
  }
});
