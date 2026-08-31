#!/usr/bin/env node

/* Installs one monotonic per-user revision for submission-authority snapshots.
 *
 * Every covered row mutation first acquires the existing submission user advisory transaction
 * lock, then bumps the durable revision only after the row mutation succeeds. This keeps the
 * authority rows and their cache-coherence token atomic, including on rollback.
 */

import pg from 'pg';

const SCHEMA_VERSION = 'submission-authority-v1';
const MIGRATION_LOCK = [1414090051, 20260828];

const DIRECT_OWNER_TABLES = [
  'application_submission_attempt_events',
  'application_submission_events',
  'generated_resumes',
  'applications',
  'artifacts',
  'application_email_aliases',
];

const DERIVED_OWNER_TABLES = [
  ['artifact_versions', 'artifact_version'],
  ['application_artifacts', 'application_artifact'],
];

const COVERED_TABLES = [
  ...DIRECT_OWNER_TABLES.map((table) => [table, 'direct']),
  ...DERIVED_OWNER_TABLES,
];

function quotedIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function normalizedDefinition(value) {
  return String(value ?? '').replaceAll('"', '').replace(/\s+/gu, ' ').trim().toLowerCase();
}

async function assertPrerequisiteTables(client) {
  const result = await client.query(`
    select table_name
    from information_schema.tables
    where table_schema = current_schema()
      and table_name = any($1::text[])
  `, [COVERED_TABLES.map(([table]) => table).concat('users')]);
  const present = new Set(result.rows.map((row) => row.table_name));
  const missing = COVERED_TABLES.map(([table]) => table).concat('users')
    .filter((table) => !present.has(table));
  if (missing.length) {
    throw new Error(`Submission authority revision prerequisites are missing: ${missing.join(', ')}`);
  }
}

async function assertCatalog(client) {
  const columns = await client.query(`
    select column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = current_schema()
      and table_name = 'submission_authority_revisions'
    order by ordinal_position
  `);
  const byName = new Map(columns.rows.map((row) => [row.column_name, row]));
  for (const column of ['user_id', 'schema_version', 'revision', 'updated_at']) {
    if (!byName.has(column)) throw new Error(`Submission authority revision column is missing: ${column}`);
  }
  if (byName.get('user_id').data_type !== 'uuid'
    || byName.get('schema_version').data_type !== 'text'
    || byName.get('revision').data_type !== 'bigint'
    || byName.get('updated_at').data_type !== 'timestamp with time zone') {
    throw new Error('Submission authority revision column types do not match the contract');
  }
  if ([...byName.values()].some((column) => column.is_nullable !== 'NO')) {
    throw new Error('Submission authority revision columns must all be NOT NULL');
  }
  if (!normalizedDefinition(byName.get('schema_version').column_default)
    .includes(`'${SCHEMA_VERSION}'::text`)
    || normalizedDefinition(byName.get('revision').column_default) !== '0'
    || !normalizedDefinition(byName.get('updated_at').column_default).includes('now()')) {
    throw new Error('Submission authority revision defaults do not match the contract');
  }

  const constraints = await client.query(`
    select conname, contype, pg_get_constraintdef(constraint_row.oid) as definition
    from pg_constraint constraint_row
    inner join pg_class table_row on table_row.oid = constraint_row.conrelid
    inner join pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
    where namespace_row.nspname = current_schema()
      and table_row.relname = 'submission_authority_revisions'
  `);
  const constraintByName = new Map(constraints.rows.map((row) => [row.conname, row]));
  const constraintContract = new Map([
    ['submission_authority_revisions_pkey', /primary key \(user_id\)/u],
    ['submission_authority_revisions_user_id_fkey', /foreign key \(user_id\) references (?:public\.)?users\(id\) on delete cascade/u],
    ['submission_authority_revisions_schema_version_check', /check \(\(schema_version = 'submission-authority-v1'::text\)\)/u],
    ['submission_authority_revisions_nonnegative_check', /check \(\(revision >= 0\)\)/u],
  ]);
  for (const [name, pattern] of constraintContract) {
    const row = constraintByName.get(name);
    if (!row) throw new Error(`Submission authority revision constraint is missing: ${name}`);
    if (!pattern.test(normalizedDefinition(row.definition))) {
      throw new Error(`Submission authority revision constraint does not match the contract: ${name}`);
    }
  }

  const triggers = await client.query(`
    select table_row.relname as table_name, trigger_row.tgname as trigger_name,
      pg_get_triggerdef(trigger_row.oid) as definition
    from pg_trigger trigger_row
    inner join pg_class table_row on table_row.oid = trigger_row.tgrelid
    inner join pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
    where namespace_row.nspname = current_schema()
      and not trigger_row.tgisinternal
      and table_row.relname = any($1::text[])
  `, [COVERED_TABLES.map(([table]) => table).concat('submission_authority_revisions')]);
  const triggerByKey = new Map(triggers.rows.map((row) => [
    `${row.table_name}:${row.trigger_name}`,
    normalizedDefinition(row.definition),
  ]));
  for (const [table, ownerMode] of COVERED_TABLES) {
    for (const [trigger, timing, action] of [
      ['aa_submission_authority_revision_lock', 'before', 'lock'],
      ['zz_submission_authority_revision_bump', 'after', 'bump'],
    ]) {
      const definition = triggerByKey.get(`${table}:${trigger}`);
      if (!definition) throw new Error(`Submission authority revision trigger is missing: ${table}.${trigger}`);
      if (!new RegExp(`${timing} insert or delete or update on (?:public\\.)?${table}`, 'u').test(definition)
        || !definition.includes(
          `execute function submission_authority_revision_row_trigger('${ownerMode}', '${action}')`,
        )) {
        throw new Error(`Submission authority revision trigger does not match the contract: ${table}.${trigger}`);
      }
    }
  }
  const monotonicTrigger = triggerByKey.get(
    'submission_authority_revisions:submission_authority_revisions_monotonic',
  );
  if (!monotonicTrigger
    || !/before update on (?:public\.)?submission_authority_revisions for each row execute function enforce_submission_authority_revision_monotonicity\(\)/u
      .test(monotonicTrigger)) {
    throw new Error('Submission authority monotonic trigger does not match the contract');
  }

  const functions = await client.query(`
    select procedure_row.proname, pg_get_functiondef(procedure_row.oid) as definition
    from pg_proc procedure_row
    inner join pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = current_schema()
      and procedure_row.proname = any($1::text[])
  `, [[
    'lock_submission_authority_revision_user',
    'bump_submission_authority_revision',
    'enforce_submission_authority_revision_monotonicity',
    'submission_authority_application_artifact_owner',
    'submission_authority_revision_row_trigger',
  ]]);
  const functionByName = new Map(functions.rows.map((row) => [
    row.proname,
    normalizedDefinition(row.definition),
  ]));
  const functionContract = new Map([
    ['lock_submission_authority_revision_user', /pg_try_advisory_xact_lock\(\s*hashtextextended\('submission-attempt:' \|\| p_user_id::text, 0::bigint\)\s*\).*if acquired is not true.*errcode = '40001'/u],
    ['bump_submission_authority_revision', /revision = submission_authority_revisions\.revision \+ 1/u],
    ['enforce_submission_authority_revision_monotonicity', /new\.revision <= old\.revision/u],
    ['submission_authority_application_artifact_owner', /application artifact ownership mismatch/u],
    ['submission_authority_revision_row_trigger', /tg_op = 'delete'.*pg_trigger_depth\(\) > 1.*action_mode = 'lock'.*action_mode = 'bump'/u],
  ]);
  for (const [name, pattern] of functionContract) {
    const definition = functionByName.get(name);
    if (!definition) throw new Error(`Submission authority revision function is missing: ${name}`);
    if (!pattern.test(definition)) {
      throw new Error(`Submission authority revision function does not match the contract: ${name}`);
    }
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("set lock_timeout = '2min'");
    await client.query("set statement_timeout = '2min'");
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1, $2)', MIGRATION_LOCK);
    await assertPrerequisiteTables(client);

    const lockedTables = COVERED_TABLES.map(([table]) => quotedIdentifier(table)).join(', ');
    await client.query(`lock table ${lockedTables} in share row exclusive mode`);

    const mismatchedLink = await client.query(`
      select link.application_id, link.artifact_id,
        application.user_id as application_user_id,
        artifact.user_id as artifact_user_id
      from application_artifacts link
      inner join applications application on application.id = link.application_id
      inner join artifacts artifact on artifact.id = link.artifact_id
      where application.user_id is distinct from artifact.user_id
      limit 1
    `);
    if (mismatchedLink.rows[0]) {
      const row = mismatchedLink.rows[0];
      throw new Error(
        `Application artifact ownership mismatch: application ${row.application_id} belongs to `
        + `${row.application_user_id}, artifact ${row.artifact_id} belongs to ${row.artifact_user_id}`,
      );
    }

    await client.query(`
      create table if not exists submission_authority_revisions (
        user_id uuid not null,
        schema_version text not null default '${SCHEMA_VERSION}',
        revision bigint not null default 0,
        updated_at timestamptz not null default now(),
        constraint submission_authority_revisions_pkey primary key (user_id),
        constraint submission_authority_revisions_user_id_fkey
          foreign key (user_id) references users(id) on delete cascade,
        constraint submission_authority_revisions_schema_version_check
          check (schema_version = '${SCHEMA_VERSION}'),
        constraint submission_authority_revisions_nonnegative_check
          check (revision >= 0)
      )
    `);
    await client.query(`
      alter table submission_authority_revisions
        add column if not exists schema_version text,
        add column if not exists revision bigint,
        add column if not exists updated_at timestamptz
    `);
    await client.query(`
      drop trigger if exists submission_authority_revisions_monotonic
      on submission_authority_revisions
    `);
    await client.query(`
      update submission_authority_revisions
      set schema_version = '${SCHEMA_VERSION}'
      where schema_version is null
    `);
    await client.query(`
      update submission_authority_revisions
      set revision = 0
      where revision is null
    `);
    await client.query(`
      update submission_authority_revisions
      set updated_at = now()
      where updated_at is null
    `);
    await client.query(`
      alter table submission_authority_revisions
        alter column schema_version set default '${SCHEMA_VERSION}',
        alter column schema_version set not null,
        alter column revision set default 0,
        alter column revision set not null,
        alter column updated_at set default now(),
        alter column updated_at set not null
    `);
    await client.query(`
      alter table submission_authority_revisions
        drop constraint if exists submission_authority_revisions_schema_version_check,
        drop constraint if exists submission_authority_revisions_nonnegative_check
    `);
    await client.query(`
      alter table submission_authority_revisions
        add constraint submission_authority_revisions_schema_version_check
          check (schema_version = '${SCHEMA_VERSION}'),
        add constraint submission_authority_revisions_nonnegative_check
          check (revision >= 0)
    `);
    await client.query(`
      do $block$
      begin
        if not exists (
          select 1 from pg_constraint
          where conrelid = 'submission_authority_revisions'::regclass
            and conname = 'submission_authority_revisions_pkey'
        ) then
          alter table submission_authority_revisions
            add constraint submission_authority_revisions_pkey primary key (user_id);
        end if;
        if not exists (
          select 1 from pg_constraint
          where conrelid = 'submission_authority_revisions'::regclass
            and conname = 'submission_authority_revisions_user_id_fkey'
        ) then
          alter table submission_authority_revisions
            add constraint submission_authority_revisions_user_id_fkey
            foreign key (user_id) references users(id) on delete cascade;
        end if;
      end
      $block$
    `);
    await client.query(`
      insert into submission_authority_revisions (user_id, schema_version, revision)
      select id, '${SCHEMA_VERSION}', 0 from users
      on conflict (user_id) do nothing
    `);

    await client.query(`
      create or replace function lock_submission_authority_revision_user(p_user_id uuid)
      returns void language plpgsql as $function$
      declare acquired boolean;
      begin
        if p_user_id is null then
          raise exception 'submission authority owner is missing' using errcode = '23502';
        end if;
        select pg_try_advisory_xact_lock(
          hashtextextended('submission-attempt:' || p_user_id::text, 0::bigint)
        ) into acquired;
        if acquired is not true then
          raise exception 'submission authority changed concurrently; retry the request'
            using errcode = '40001';
        end if;
      end
      $function$
    `);
    await client.query(`
      create or replace function bump_submission_authority_revision(p_user_id uuid)
      returns bigint language plpgsql as $function$
      declare next_revision bigint;
      begin
        perform lock_submission_authority_revision_user(p_user_id);
        insert into submission_authority_revisions (
          user_id, schema_version, revision, updated_at
        ) values (
          p_user_id, '${SCHEMA_VERSION}', 1, clock_timestamp()
        )
        on conflict (user_id) do update
          set revision = submission_authority_revisions.revision + 1,
              updated_at = clock_timestamp()
        returning revision into next_revision;
        return next_revision;
      end
      $function$
    `);
    await client.query(`
      create or replace function enforce_submission_authority_revision_monotonicity()
      returns trigger language plpgsql as $function$
      begin
        if new.user_id is distinct from old.user_id
          or new.schema_version is distinct from old.schema_version then
          raise exception 'submission authority revision identity is immutable' using errcode = '55000';
        end if;
        if new.revision <= old.revision then
          raise exception 'submission authority revision must increase' using errcode = '55000';
        end if;
        return new;
      end
      $function$
    `);
    await client.query(`
      create trigger submission_authority_revisions_monotonic
      before update on submission_authority_revisions
      for each row execute function enforce_submission_authority_revision_monotonicity()
    `);
    await client.query(`
      create or replace function submission_authority_application_artifact_owner(
        p_application_id uuid,
        p_artifact_id uuid
      ) returns uuid language plpgsql stable as $function$
      declare application_owner uuid;
      declare artifact_owner uuid;
      begin
        select user_id into application_owner from applications where id = p_application_id;
        select user_id into artifact_owner from artifacts where id = p_artifact_id;
        if application_owner is not null and artifact_owner is not null
          and application_owner is distinct from artifact_owner then
          raise exception 'application artifact ownership mismatch' using errcode = '23514';
        end if;
        return coalesce(application_owner, artifact_owner);
      end
      $function$
    `);
    await client.query(`
      create or replace function submission_authority_revision_row_trigger()
      returns trigger language plpgsql as $function$
      declare old_payload jsonb;
      declare new_payload jsonb;
      declare old_owner uuid;
      declare new_owner uuid;
      declare owner_id uuid;
      declare owner_ids uuid[];
      declare owner_mode text := tg_argv[0];
      declare action_mode text := tg_argv[1];
      begin
        if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
          return old;
        end if;
        if tg_op <> 'INSERT' then old_payload := to_jsonb(old); end if;
        if tg_op <> 'DELETE' then new_payload := to_jsonb(new); end if;

        if owner_mode = 'direct' then
          if old_payload is not null then old_owner := nullif(old_payload->>'user_id', '')::uuid; end if;
          if new_payload is not null then new_owner := nullif(new_payload->>'user_id', '')::uuid; end if;
        elsif owner_mode = 'artifact_version' then
          if old_payload is not null then
            select user_id into old_owner from artifacts
            where id = (old_payload->>'artifact_id')::uuid;
          end if;
          if new_payload is not null then
            select user_id into new_owner from artifacts
            where id = (new_payload->>'artifact_id')::uuid;
          end if;
        elsif owner_mode = 'application_artifact' then
          if old_payload is not null then
            old_owner := submission_authority_application_artifact_owner(
              (old_payload->>'application_id')::uuid,
              (old_payload->>'artifact_id')::uuid
            );
          end if;
          if new_payload is not null then
            new_owner := submission_authority_application_artifact_owner(
              (new_payload->>'application_id')::uuid,
              (new_payload->>'artifact_id')::uuid
            );
          end if;
        else
          raise exception 'unknown submission authority owner mode: %', owner_mode;
        end if;

        select array_agg(candidate.owner_id order by candidate.owner_id::text)
        into owner_ids
        from (
          select distinct unnest(array[old_owner, new_owner]) as owner_id
        ) candidate
        where candidate.owner_id is not null;

        if tg_op = 'DELETE' then
          select array_agg(candidate.owner_id order by candidate.owner_id::text)
          into owner_ids
          from unnest(owner_ids) candidate(owner_id)
          where exists (select 1 from users where id = candidate.owner_id);
          if coalesce(cardinality(owner_ids), 0) = 0 then return old; end if;
        end if;

        if coalesce(cardinality(owner_ids), 0) = 0 then
          raise exception 'submission authority owner could not be derived for %.%', tg_table_name, tg_op
            using errcode = '23514';
        end if;

        foreach owner_id in array owner_ids loop
          if action_mode = 'lock' then
            perform lock_submission_authority_revision_user(owner_id);
          elsif action_mode = 'bump' then
            perform bump_submission_authority_revision(owner_id);
          else
            raise exception 'unknown submission authority trigger action: %', action_mode;
          end if;
        end loop;

        if tg_op = 'DELETE' then return old; else return new; end if;
      end
      $function$
    `);

    for (const [table, ownerMode] of COVERED_TABLES) {
      const quotedTable = quotedIdentifier(table);
      await client.query(`
        drop trigger if exists aa_submission_authority_revision_lock on ${quotedTable}
      `);
      await client.query(`
        create trigger aa_submission_authority_revision_lock
        before insert or update or delete on ${quotedTable}
        for each row execute function submission_authority_revision_row_trigger('${ownerMode}', 'lock')
      `);
      await client.query(`
        drop trigger if exists zz_submission_authority_revision_bump on ${quotedTable}
      `);
      await client.query(`
        create trigger zz_submission_authority_revision_bump
        after insert or update or delete on ${quotedTable}
        for each row execute function submission_authority_revision_row_trigger('${ownerMode}', 'bump')
      `);
    }

    await assertCatalog(client);
    await client.query('commit');
    console.log(`Submission authority revision schema is ready at ${SCHEMA_VERSION}.`);
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
