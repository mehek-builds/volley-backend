import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, stat, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';

const { Client } = pg;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeDatabaseIdentity(value) {
  const url = new URL(value);
  return `${url.hostname.toLowerCase()}:${url.port || '5432'}${url.pathname}`;
}

async function serverMajor(connectionString) {
  const client = new Client({ connectionString, application_name: 'litos-database-migration-check' });
  await client.connect();
  try {
    const result = await client.query("select current_setting('server_version_num')::int as version_num");
    return Math.floor(Number(result.rows[0].version_num) / 10_000);
  } finally {
    await client.end();
  }
}

async function toolMajor(tool) {
  const output = await run(tool, ['--version'], {}, true);
  const match = /\b(\d+)(?:\.\d+)?\b/.exec(output);
  if (!match) throw new Error(`Could not read ${tool} version`);
  return Number(match[1]);
}

function run(command, args, environment, capture = false) {
  return new Promise((resolve, reject) => {
    const childEnvironment = { ...process.env };
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete childEnvironment[key];
      else childEnvironment[key] = value;
    }
    const child = spawn(command, args, {
      env: childEnvironment,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    }
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

function libpqEnvironment(applicationName) {
  return {
    PGDATABASE: undefined,
    PGAPPNAME: applicationName,
    PGHOST: undefined,
    PGPORT: undefined,
    PGUSER: undefined,
    PGPASSWORD: undefined,
    PGSSLMODE: undefined,
    PGCHANNELBINDING: undefined,
    PGSERVICE: undefined,
    PGSERVICEFILE: undefined,
  };
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function backupPath() {
  const value = required('MIGRATION_BACKUP_PATH');
  if (!isAbsolute(value) || !value.endsWith('.dump')) {
    throw new Error('MIGRATION_BACKUP_PATH must be an absolute path ending in .dump');
  }
  return value;
}

async function backup() {
  const source = required('MIGRATION_SOURCE_DATABASE_URL');
  const output = backupPath();
  const pgDump = process.env.PG_DUMP_BIN?.trim() || 'pg_dump';
  if (existsSync(output)) throw new Error(`Refusing to overwrite existing backup: ${output}`);
  const [sourceMajor, clientMajor] = await Promise.all([serverMajor(source), toolMajor(pgDump)]);
  if (clientMajor < sourceMajor) {
    throw new Error(`pg_dump ${clientMajor} is older than PostgreSQL ${sourceMajor}; install a matching or newer client first`);
  }
  await run(pgDump, [
    '--format=custom',
    '--compress=6',
    '--no-owner',
    '--no-acl',
    '--serializable-deferrable',
    '--dbname', source,
    '--file', output,
  ], libpqEnvironment('litos-neon-backup'));
  await chmod(output, 0o600);
  const [details, digest] = await Promise.all([stat(output), sha256(output)]);
  await writeFile(`${output}.sha256`, `${digest}  ${output}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ backup: output, bytes: details.size, sha256: digest }));
}

async function restore() {
  const source = required('MIGRATION_SOURCE_DATABASE_URL');
  const target = required('MIGRATION_TARGET_DATABASE_URL');
  const input = backupPath();
  const pgRestore = process.env.PG_RESTORE_BIN?.trim() || 'pg_restore';
  if (safeDatabaseIdentity(source) === safeDatabaseIdentity(target)) {
    throw new Error('Source and target databases must be different');
  }
  if (!existsSync(input)) throw new Error(`Backup does not exist: ${input}`);
  const [targetMajor, clientMajor] = await Promise.all([serverMajor(target), toolMajor(pgRestore)]);
  if (clientMajor < targetMajor) {
    throw new Error(`pg_restore ${clientMajor} is older than PostgreSQL ${targetMajor}; install a matching or newer client first`);
  }
  await run(pgRestore, [
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-acl',
    '--exit-on-error',
    '--single-transaction',
    '--dbname', target,
    input,
  ], libpqEnvironment('litos-railway-restore'));
  console.log(JSON.stringify({ restored: input, target: safeDatabaseIdentity(target) }));
}

const mode = process.argv[2];
if (mode === 'backup') await backup();
else if (mode === 'restore') await restore();
else throw new Error('Usage: node scripts/migrate-postgres.mjs <backup|restore>');
