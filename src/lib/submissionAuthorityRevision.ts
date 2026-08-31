import { sql } from 'drizzle-orm';
import { db } from '../db';
import { lockSubmissionAttemptUser } from './submissionAttemptLedger';
import { DATABASE_PROBE_TIMEOUT_MS } from './healthProbe';

export const SUBMISSION_AUTHORITY_SCHEMA_VERSION = 'submission-authority-v1' as const;

declare const submissionAuthorityRevisionBrand: unique symbol;

/** A nonnegative PostgreSQL bigint serialized without losing precision. */
export type SubmissionAuthorityRevision = string & {
  readonly [submissionAuthorityRevisionBrand]: true;
};

export type SubmissionAuthorityRevisionExecutor = Pick<typeof db, 'execute'>;

export type SubmissionAuthorityRevisionReadiness = {
  ready: boolean;
  reason: 'schema_ready' | 'not_migrated' | 'catalog_incomplete' | 'unreadable';
};

const CANONICAL_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

export function parseSubmissionAuthorityRevision(value: unknown): SubmissionAuthorityRevision {
  const serialized = typeof value === 'bigint' ? value.toString(10) : value;
  if (typeof serialized !== 'string' || !CANONICAL_DECIMAL_PATTERN.test(serialized)) {
    throw new Error('Submission authority revision must be a canonical nonnegative decimal bigint');
  }
  if (BigInt(serialized) > POSTGRES_BIGINT_MAX) {
    throw new Error('Submission authority revision exceeds the PostgreSQL bigint range');
  }
  return serialized as SubmissionAuthorityRevision;
}

function revisionFromResult(
  result: Awaited<ReturnType<SubmissionAuthorityRevisionExecutor['execute']>>,
): SubmissionAuthorityRevision {
  const raw = (result.rows[0] as { revision?: unknown } | undefined)?.revision;
  if (raw === undefined) throw new Error('Submission authority revision row is missing');
  return parseSubmissionAuthorityRevision(raw);
}

/**
 * Read the revision while owning the same transaction lock as the authority snapshot.
 * The executor must be an active transaction. The lock is reentrant for callers that acquired it
 * before reading the projection, which is the required ordering for a passive snapshot.
 */
export async function readSubmissionAuthorityRevision(
  userId: string,
  executor: SubmissionAuthorityRevisionExecutor,
): Promise<SubmissionAuthorityRevision> {
  await lockSubmissionAttemptUser(executor, userId);
  await executor.execute(sql`
    insert into submission_authority_revisions (user_id, schema_version, revision)
    values (${userId}::uuid, ${SUBMISSION_AUTHORITY_SCHEMA_VERSION}, 0)
    on conflict (user_id) do nothing
  `);
  const result = await executor.execute(sql`
    select revision::text as revision
    from submission_authority_revisions
    where user_id = ${userId}::uuid
      and schema_version = ${SUBMISSION_AUTHORITY_SCHEMA_VERSION}
  `);
  return revisionFromResult(result);
}

/**
 * Explicitly bump through the same database primitive used by the migration-installed triggers.
 * Trigger-covered table writes do not call this helper separately because their trigger already
 * performs the bump in the write transaction.
 */
export async function bumpSubmissionAuthorityRevision(
  userId: string,
  executor: SubmissionAuthorityRevisionExecutor,
): Promise<SubmissionAuthorityRevision> {
  await lockSubmissionAttemptUser(executor, userId);
  const result = await executor.execute(sql`
    select bump_submission_authority_revision(${userId}::uuid)::text as revision
  `);
  return revisionFromResult(result);
}

const DIRECT_OWNER_TABLES = [
  'managed_submission_account_deletion_drains',
  'browser_provider_resource_cleanups',
  'managed_prepare_object_cleanups',
  'application_submission_attempt_events',
  'application_submission_events',
  'generated_resumes',
  'applications',
  'artifacts',
  'application_email_aliases',
] as const;

const DERIVED_OWNER_TABLES = [
  ['users', 'user_self'],
  ['billing_subscriptions', 'direct'],
  ['artifact_versions', 'artifact_version'],
  ['application_artifacts', 'application_artifact'],
] as const;

function normalizedCatalogDefinition(value: unknown): string {
  return String(value ?? '').replaceAll('"', '').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function catalogRowsAreReady(rows: readonly { kind: unknown; name: unknown; definition: unknown }[]): boolean {
  const catalog = new Map(rows.map((row) => [
    `${String(row.kind)}:${String(row.name)}`,
    normalizedCatalogDefinition(row.definition),
  ]));
  const schemaVersion = catalog.get('column:schema_version');
  const revision = catalog.get('column:revision');
  const userId = catalog.get('column:user_id');
  const updatedAt = catalog.get('column:updated_at');
  if (!schemaVersion?.startsWith(`text|no|'${SUBMISSION_AUTHORITY_SCHEMA_VERSION}'::text`)
    || !revision?.startsWith('bigint|no|0')
    || userId !== 'uuid|no|'
    || !updatedAt?.startsWith('timestamp with time zone|no|now()')) return false;
  const constraintContract = new Map<string, RegExp>([
    ['submission_authority_revisions_pkey', /primary key \(user_id\)/u],
    ['submission_authority_revisions_user_id_fkey', /foreign key \(user_id\) references (?:public\.)?users\(id\) on delete cascade/u],
    ['submission_authority_revisions_schema_version_check', /check \(\(schema_version = 'submission-authority-v1'::text\)\)/u],
    ['submission_authority_revisions_nonnegative_check', /check \(\(revision >= 0\)\)/u],
  ]);
  for (const [name, pattern] of constraintContract) {
    if (!pattern.test(catalog.get(`constraint:${name}`) ?? '')) return false;
  }

  const functionContract = new Map<string, RegExp>([
    ['lock_submission_authority_revision_user', /pg_try_advisory_xact_lock\(\s*hashtextextended\('submission-attempt:' \|\| p_user_id::text, 0::bigint\)\s*\).*if acquired is not true.*errcode = '40001'/u],
    ['bump_submission_authority_revision', /revision = submission_authority_revisions\.revision \+ 1/u],
    ['enforce_submission_authority_revision_monotonicity', /new\.revision <= old\.revision/u],
    ['submission_authority_application_artifact_owner', /application artifact ownership mismatch/u],
    ['submission_authority_revision_row_trigger', /tg_op = 'delete'.*pg_trigger_depth\(\) > 1.*owner_mode = 'user_self'.*action_mode = 'lock'.*action_mode = 'bump'/u],
  ]);
  for (const [name, pattern] of functionContract) {
    if (!pattern.test(catalog.get(`function:${name}`) ?? '')) return false;
  }

  const tables: ReadonlyArray<readonly [string, string]> = [
    ...DIRECT_OWNER_TABLES.map((table) => [table, 'direct'] as const),
    ...DERIVED_OWNER_TABLES,
  ];
  for (const [table, ownerMode] of tables) {
    for (const [trigger, timing, action] of [
      ['aa_submission_authority_revision_lock', 'before', 'lock'],
      ['zz_submission_authority_revision_bump', 'after', 'bump'],
    ] as const) {
      const definition = catalog.get(`trigger:${table}:${trigger}`) ?? '';
      if (!new RegExp(`${timing} insert or delete or update on (?:public\\.)?${table}`, 'u').test(definition)
        || !definition.includes(
          `execute function submission_authority_revision_row_trigger('${ownerMode}', '${action}')`,
        )) return false;
    }
  }
  return /before update on (?:public\.)?submission_authority_revisions for each row execute function enforce_submission_authority_revision_monotonicity\(\)/u
    .test(catalog.get('trigger:submission_authority_revisions:submission_authority_revisions_monotonic') ?? '');
}

/** Bounded, public-safe readiness proof for the separately applied revision migration. */
export async function submissionAuthorityRevisionReadiness(
  executor: SubmissionAuthorityRevisionExecutor = db,
  timeoutMs: number = DATABASE_PROBE_TIMEOUT_MS,
): Promise<SubmissionAuthorityRevisionReadiness> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('probe timeout')), timeoutMs);
    });
    const result = await Promise.race([
      executor.execute(sql`
        select 'column'::text as kind, column_name::text as name,
          data_type || '|' || is_nullable || '|' || coalesce(column_default, '') as definition
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'submission_authority_revisions'
          and column_name in ('user_id', 'schema_version', 'revision', 'updated_at')
        union all
        select 'constraint'::text as kind, constraint_row.conname::text as name,
          pg_get_constraintdef(constraint_row.oid) as definition
        from pg_constraint constraint_row
        inner join pg_class table_row on table_row.oid = constraint_row.conrelid
        inner join pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
        where namespace_row.nspname = current_schema()
          and table_row.relname = 'submission_authority_revisions'
          and constraint_row.conname in (
            'submission_authority_revisions_pkey',
            'submission_authority_revisions_user_id_fkey',
            'submission_authority_revisions_schema_version_check',
            'submission_authority_revisions_nonnegative_check'
          )
        union all
        select 'function'::text as kind, procedure_row.proname::text as name,
          pg_get_functiondef(procedure_row.oid) as definition
        from pg_proc procedure_row
        inner join pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
        where namespace_row.nspname = current_schema()
          and procedure_row.proname in (
            'lock_submission_authority_revision_user',
            'bump_submission_authority_revision',
            'enforce_submission_authority_revision_monotonicity',
            'submission_authority_application_artifact_owner',
            'submission_authority_revision_row_trigger'
          )
        union all
        select 'trigger'::text as kind,
          table_row.relname || ':' || trigger_row.tgname as name,
          pg_get_triggerdef(trigger_row.oid) as definition
        from pg_trigger trigger_row
        inner join pg_class table_row on table_row.oid = trigger_row.tgrelid
        inner join pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
        where namespace_row.nspname = current_schema()
          and not trigger_row.tgisinternal
          and trigger_row.tgname in (
            'aa_submission_authority_revision_lock',
            'zz_submission_authority_revision_bump',
            'submission_authority_revisions_monotonic'
          )
      `),
      timeout,
    ]);
    const rows = result.rows as Array<{ kind: unknown; name: unknown; definition: unknown }>;
    const migrated = rows.some((row) => row.kind === 'column' && row.name === 'schema_version');
    if (!migrated) return { ready: false, reason: 'not_migrated' };
    return catalogRowsAreReady(rows)
      ? { ready: true, reason: 'schema_ready' }
      : { ready: false, reason: 'catalog_incomplete' };
  } catch {
    return { ready: false, reason: 'unreadable' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
