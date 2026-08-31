import pg from 'pg';

const { Client } = pg;
const sourceUrl = process.env.MIGRATION_SOURCE_DATABASE_URL?.trim();
const targetUrl = process.env.MIGRATION_TARGET_DATABASE_URL?.trim();
if (!sourceUrl || !targetUrl) {
  throw new Error('MIGRATION_SOURCE_DATABASE_URL and MIGRATION_TARGET_DATABASE_URL are required');
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function stable(value) {
  return JSON.stringify(value);
}

async function connect(connectionString, name, readOnly) {
  const client = new Client({ connectionString, application_name: `litos-migration-${name}` });
  await client.connect();
  await client.query("set statement_timeout = '10min'");
  await client.query("set lock_timeout = '10s'");
  await client.query("set timezone = 'UTC'");
  if (readOnly) await client.query('set default_transaction_read_only = on');
  return client;
}

async function rows(client, text) {
  return (await client.query(text)).rows;
}

async function catalog(client) {
  const version = await rows(client, "select current_setting('server_version_num')::int as version_num, version() as version");
  const size = await rows(client, 'select pg_database_size(current_database())::text as bytes');
  const tables = await rows(client, `select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`);
  const columns = await rows(client, `select table_name, column_name, data_type, udt_schema, udt_name,
    is_nullable, column_default, character_maximum_length, numeric_precision, numeric_scale,
    datetime_precision, is_identity, identity_generation, is_generated, generation_expression
    from information_schema.columns where table_schema = 'public'
    order by table_name, column_name`);
  const constraints = await rows(client, `select c.relname as table_name, con.conname as constraint_name,
    con.contype as constraint_type, pg_get_constraintdef(con.oid, true) as definition
    from pg_constraint con join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
    and con.contype <> 'n'
    order by c.relname, con.conname`);
  const indexes = await rows(client, `select tablename as table_name, indexname as index_name, indexdef as definition
    from pg_indexes where schemaname = 'public' order by tablename, indexname`);
  const triggers = await rows(client, `select event_object_table as table_name, trigger_name, action_timing,
    event_manipulation, action_statement, action_orientation
    from information_schema.triggers where trigger_schema = 'public'
    order by event_object_table, trigger_name, event_manipulation`);
  const views = await rows(client, `select table_name as view_name, view_definition
    from information_schema.views where table_schema = 'public' order by table_name`);
  const sequences = await rows(client, `select sequencename as sequence_name, data_type, start_value::text, min_value::text,
    max_value::text, increment_by::text, cycle, cache_size::text, last_value::text
    from pg_sequences where schemaname = 'public' order by sequencename`);
  const extensions = await rows(client, 'select extname as name, extversion as version from pg_extension order by extname');
  return {
    version: version[0],
    databaseBytes: size[0].bytes,
    tables: tables.map((row) => row.table_name),
    columns,
    constraints,
    indexes,
    triggers,
    views,
    sequences,
    extensions,
  };
}

async function tableFingerprint(client, table) {
  const qualified = `${quoteIdentifier('public')}.${quoteIdentifier(table)}`;
  const result = await client.query(
    `select count(*)::text as row_count,
      md5(coalesce(string_agg(row_digest, '' order by row_digest), '')) as content_fingerprint
      from (select md5(row_to_json(t)::text) as row_digest from ${qualified} t) digests`,
  );
  return result.rows[0];
}

function compare(label, source, target, failures) {
  if (stable(source) !== stable(target)) failures.push(label);
}

const source = await connect(sourceUrl, 'source', true);
const target = await connect(targetUrl, 'target', false);
const failures = [];
try {
  const [sourceCatalog, targetCatalog] = await Promise.all([catalog(source), catalog(target)]);
  const sourceMajor = Math.floor(Number(sourceCatalog.version.version_num) / 10_000);
  const targetMajor = Math.floor(Number(targetCatalog.version.version_num) / 10_000);
  if (targetMajor < sourceMajor) failures.push(`target PostgreSQL ${targetMajor} is older than source ${sourceMajor}`);

  for (const key of ['tables', 'columns', 'constraints', 'indexes', 'triggers', 'views', 'sequences']) {
    compare(`catalog mismatch: ${key}`, sourceCatalog[key], targetCatalog[key], failures);
  }
  const targetExtensions = new Map(targetCatalog.extensions.map((item) => [item.name, item.version]));
  for (const extension of sourceCatalog.extensions) {
    if (!targetExtensions.has(extension.name)) failures.push(`missing extension: ${extension.name}`);
  }

  const fingerprints = {};
  for (const table of sourceCatalog.tables) {
    const [sourceFingerprint, targetFingerprint] = await Promise.all([
      tableFingerprint(source, table),
      tableFingerprint(target, table),
    ]);
    fingerprints[table] = { source: sourceFingerprint, target: targetFingerprint };
    compare(`data mismatch: public.${table}`, sourceFingerprint, targetFingerprint, failures);
    console.error(`[verify] public.${table}: ${sourceFingerprint.row_count} rows`);
  }

  await target.query('begin');
  await target.query('create temp table litos_migration_write_probe (id integer) on commit drop');
  await target.query('insert into litos_migration_write_probe values (1)');
  await target.query('rollback');

  const report = {
    verifiedAt: new Date().toISOString(),
    source: { version: sourceCatalog.version.version, databaseBytes: sourceCatalog.databaseBytes },
    target: { version: targetCatalog.version.version, databaseBytes: targetCatalog.databaseBytes },
    tableCount: sourceCatalog.tables.length,
    fingerprints,
    writableTarget: true,
    ok: failures.length === 0,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await Promise.allSettled([source.end(), target.end()]);
}
