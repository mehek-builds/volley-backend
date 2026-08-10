import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';

/* THE MIGRATION IS RUN, NOT READ.
 *
 * This repo pushes schema rather than committing migrations, so an apply script is the only thing
 * standing between a declared table and a production database that does not have it. A test that
 * only greps the script for the word "create" proves nothing about whether Postgres accepts it.
 *
 * So: a real Postgres (PGlite over a unix socket), seeded with every OTHER table from schema.ts,
 * then the actual script, run as a child process exactly as an operator runs it. Then run again,
 * because an apply script that is not idempotent is one nobody can safely re-run after a failure.
 */

const exec = promisify(execFile);
const SCRIPT = join(process.cwd(), 'scripts', 'apply-portal-credentials-schema.mjs');

let socketDir: string;
let pglite: PGlite;
let server: PGLiteSocketServer;
let databaseUrl: string;

before(async () => {
  socketDir = mkdtempSync(join(tmpdir(), 'litos-portal-cred-migrate-'));
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({ db: pglite, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();
  databaseUrl = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;

  // Everything schema.ts declares EXCEPT the new table, which is the state a database is in the
  // moment before this migration runs.
  const schema = await import('./schema');
  const { portal_credentials: _pending, ...rest } = schema as unknown as Record<string, unknown>;
  const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(rest));
  for (const statement of statements) await pglite.exec(statement);
});

after(async () => {
  await server?.stop();
  await pglite?.close();
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
});

test('the table does not exist until the migration runs', async () => {
  const { rows } = await pglite.query(
    "select table_name from information_schema.tables where table_name = 'portal_credentials'",
  );
  assert.equal(rows.length, 0);
});

test('the apply script creates the table, its columns, and the one-account-per-tenant index', async () => {
  const { stdout } = await exec(process.execPath, [SCRIPT], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  assert.match(stdout, /Ready: portal credentials schema is present\./);

  const { rows: columns } = await pglite.query<{ column_name: string; is_nullable: string }>(
    "select column_name, is_nullable from information_schema.columns where table_name = 'portal_credentials' order by column_name",
  );
  assert.deepEqual(columns.map((column) => column.column_name), [
    'created_at',
    'id',
    'last_revealed_at',
    'last_used_at',
    'password_encrypted',
    'portal_family',
    'reveal_count',
    'tenant',
    'updated_at',
    'user_id',
    'username',
  ]);
  const nullable = Object.fromEntries(columns.map((column) => [column.column_name, column.is_nullable]));
  assert.equal(nullable.user_id, 'NO');
  assert.equal(nullable.password_encrypted, 'NO');
  assert.equal(nullable.tenant, 'NO');

  const { rows: indexes } = await pglite.query<{ indexname: string }>(
    "select indexname from pg_indexes where tablename = 'portal_credentials'",
  );
  const names = indexes.map((index) => index.indexname);
  assert.ok(names.includes('portal_credentials_user_family_tenant_unique'));
  assert.ok(names.includes('portal_credentials_user_id_idx'));
});

test('one account per tenant is enforced by the database, not only by the code', async () => {
  const { rows } = await pglite.query<{ id: string }>(
    "insert into users (email) values ('migration-owner@example.com') returning id",
  );
  const userId = rows[0].id;
  const values = `('${userId}', 'icims', 'careers-acme', 'alias@example.com', 'ciphertext')`;
  const columns = '(user_id, portal_family, tenant, username, password_encrypted)';
  await pglite.exec(`insert into portal_credentials ${columns} values ${values}`);
  await assert.rejects(
    pglite.exec(`insert into portal_credentials ${columns} values ${values}`),
    /duplicate key|unique/i,
    'a second account on the same tenant is how an applicant gets locked out of the first',
  );
  await pglite.exec("delete from portal_credentials where username = 'alias@example.com'");
});

test('running the migration a second time changes nothing and still succeeds', async () => {
  const { stdout } = await exec(process.execPath, [SCRIPT], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  assert.match(stdout, /Ready: portal credentials schema is present\./);
  const { rows } = await pglite.query(
    "select table_name from information_schema.tables where table_name = 'portal_credentials'",
  );
  assert.equal(rows.length, 1);
});

test('the script refuses to run without a database, rather than guessing one', async () => {
  const { DATABASE_URL: _unset, ...env } = process.env;
  await assert.rejects(
    exec(process.execPath, [SCRIPT], { env }),
    (error: { code?: number; stderr?: string }) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr ?? '', /DATABASE_URL is not set/);
      return true;
    },
  );
});
