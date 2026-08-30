#!/usr/bin/env node
/**
 * Two-phase additive migration for verified job inventory.
 *
 * Run columns before deploying code that reads the new fields:
 *   npm run db:job-logo-evidence:columns
 *
 * Deploy the normalizing writer with the verified-evidence gate enabled. Stop every legacy
 * job-monitor schedule before starting the Railway drain or installing the writer-only constraint,
 * then run:
 *   npm run db:job-logo-evidence:finalize
 *
 * A private maintenance deployment may use the explicit bypass while it receives no public
 * traffic, but unverified rows must never be exposed during the live drain. Never replace this
 * script with db:push, which reconciles the full schema and can drop production-only columns.
 * After finalize validates the sponsorship-scope constraint, only a build that writes
 * sponsorship_scope is a safe code rollback target. The pre-columns compatibility build is not.
 */

import pg from 'pg';
import { companyDomainFor } from '../src/lib/companyDomains.ts';

const SOURCE_TABLE = 'career_page_sources';
const LEGACY_REVIEWED_DOMAIN_METHOD = 'reviewed_company_domain_map';
const REVIEWED_DOMAIN_CANDIDATE_METHOD = 'reviewed_company_domain_candidate';
const ATS_BRAND_CANDIDATE_METHOD = 'first_party_ats_brand_candidate';
const BATCH_SIZE = 2_000;

const phaseArgument = process.argv.find((value) => value.startsWith('--phase='));
const phase = phaseArgument?.slice('--phase='.length);
if (phase !== 'columns' && phase !== 'finalize') {
  console.error('Choose exactly one migration phase: --phase=columns or --phase=finalize.');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

async function configureSession() {
  await client.query("set lock_timeout = '5s'");
  await client.query("set statement_timeout = '10min'");
}

async function applyColumns() {
  const statements = [
    `alter table ${SOURCE_TABLE} add column if not exists company_domain text`,
    `alter table ${SOURCE_TABLE} add column if not exists company_logo_url text`,
    `alter table ${SOURCE_TABLE}
       add column if not exists logo_verification_status text not null default 'unverified'`,
    `alter table ${SOURCE_TABLE} add column if not exists logo_verification_method text`,
    `alter table ${SOURCE_TABLE} add column if not exists logo_verified_at timestamptz`,
    `alter table ${SOURCE_TABLE} add column if not exists logo_last_checked_at timestamptz`,
    `alter table ${SOURCE_TABLE} add column if not exists logo_verification_error text`,
    `alter table ${SOURCE_TABLE} add column if not exists last_successful_poll_at timestamptz`,
    'alter table monitored_jobs add column if not exists ingest_eligible boolean not null default false',
    'alter table monitored_jobs add column if not exists certification_fingerprint text',
    'alter table monitored_jobs add column if not exists sponsorship_scope text',
  ];
  // Every ALTER commits separately. No table lock is held through a backfill or index build.
  for (const statement of statements) await client.query(statement);
  console.log('Verified-inventory columns are ready. Deploy the writer before finalizing.');
}

async function normalizeSourceIdentities() {
  const { rows: conflicts } = await client.query(`
    select lower(btrim(ats_name)) as ats_name, lower(btrim(board_token)) as board_token, count(*)::int
    from ${SOURCE_TABLE}
    group by lower(btrim(ats_name)), lower(btrim(board_token))
    having count(*) > 1
    limit 1
  `);
  if (conflicts.length > 0) {
    throw new Error('Cannot normalize career-page identities because case-insensitive duplicates exist');
  }
  await client.query(`
    update ${SOURCE_TABLE}
    set ats_name = lower(btrim(ats_name)),
        board_token = lower(btrim(board_token))
    where ats_name is distinct from lower(btrim(ats_name))
       or board_token is distinct from lower(btrim(board_token))
  `);
}

async function seedReviewedDomainCandidates() {
  const { rows: sources } = await client.query(`
    select id, company_name
    from ${SOURCE_TABLE}
    where logo_verification_status <> 'verified'
      and company_domain is null
      and company_logo_url is null
      and nullif(btrim(logo_verification_method), '') is null
  `);
  const reviewed = sources
    .map((source) => ({ id: source.id, domain: companyDomainFor(source.company_name) }))
    .filter((source) => source.domain);

  for (let start = 0; start < reviewed.length; start += BATCH_SIZE) {
    const batch = reviewed.slice(start, start + BATCH_SIZE);
    await client.query(`
      update ${SOURCE_TABLE} as source
      set company_domain = evidence.domain,
          logo_verification_method = $2
      from jsonb_to_recordset($1::jsonb) as evidence(id uuid, domain text)
      where source.id = evidence.id
        and source.logo_verification_status <> 'verified'
        and source.company_domain is null
        and source.company_logo_url is null
        and nullif(btrim(source.logo_verification_method), '') is null
    `, [JSON.stringify(batch), REVIEWED_DOMAIN_CANDIDATE_METHOD]);
  }
}

async function backfillSponsorshipScopes() {
  while (true) {
    const { rowCount } = await client.query(`
      with batch as (
        select id
        from monitored_jobs
        where (
          sponsorship_status = 'offers'
          and (sponsorship_scope is null or sponsorship_scope not in ('job_country', 'us_h1b'))
        ) or (
          sponsorship_status <> 'offers' and sponsorship_scope is not null
        )
        order by id
        limit ${BATCH_SIZE}
      )
      update monitored_jobs as job
      set sponsorship_scope = case
        when job.sponsorship_status <> 'offers' then null
        when job.description ~* '(^|[^a-z0-9])h[[:space:]-]*1[[:space:]-]*b([^a-z0-9]|$)'
          then 'us_h1b'
        else 'job_country'
      end
      from batch
      where job.id = batch.id
    `);
    if ((rowCount ?? 0) < BATCH_SIZE) return;
  }
}

async function repairLegacyEvidence() {
  await client.query(`
    update ${SOURCE_TABLE}
    set logo_verification_status = 'unverified'
    where logo_verification_status is null
       or logo_verification_status not in ('unverified', 'verified', 'failed')
  `);
  await client.query(`
    alter table ${SOURCE_TABLE}
      alter column logo_verification_status set default 'unverified',
      alter column logo_verification_status set not null
  `);

  // This predicate is one-shot. Reruns preserve verifier retry timestamps and errors.
  await client.query(`
    update ${SOURCE_TABLE}
    set company_logo_url = null,
        logo_verification_status = 'unverified',
        logo_verification_method = $1,
        logo_verified_at = null,
        logo_last_checked_at = null,
        logo_verification_error = 'legacy_domain_only_proof_revoked'
    where logo_verification_method = $2
  `, [REVIEWED_DOMAIN_CANDIDATE_METHOD, LEGACY_REVIEWED_DOMAIN_METHOD]);

  await client.query(`
    update ${SOURCE_TABLE}
    set logo_last_checked_at = logo_verified_at
    where logo_verification_status = 'verified'
      and logo_last_checked_at is null
  `);
  await client.query(`
    update ${SOURCE_TABLE}
    set logo_verification_method = $1
    where logo_verification_status <> 'verified'
      and nullif(btrim(logo_verification_method), '') is null
  `, [ATS_BRAND_CANDIDATE_METHOD]);

  await client.query(`
    update ${SOURCE_TABLE}
    set company_logo_url = null,
        logo_verification_status = 'failed',
        logo_verified_at = null,
        logo_last_checked_at = null,
        logo_verification_error = 'migration_invalid_legacy_logo_evidence'
    where logo_verification_status = 'verified'
      and (
        logo_verified_at is null
        or logo_verified_at > now() + interval '5 minutes'
        or nullif(btrim(logo_verification_method), '') is null
        or company_logo_url is null
        or company_logo_url !~ '^https://[^[:space:]]+$'
      )
  `);
}

async function replaceCheckConstraint(table, name, expression) {
  await client.query(`alter table ${table} drop constraint if exists ${name}`);
  await client.query(`
    alter table ${table} add constraint ${name}
      check (${expression}) not valid
  `);
  await client.query(`alter table ${table} validate constraint ${name}`);
}

async function ensureConcurrentIndex(name, statement) {
  const existing = await client.query(`
    select indisready, indisvalid
    from pg_index
    where indexrelid = to_regclass($1)
  `, [name]);
  const state = existing.rows[0];
  /* An interrupted CREATE INDEX CONCURRENTLY leaves the name behind with indisvalid=false.
     IF NOT EXISTS would silently keep that unusable artifact and let a rerun report success. */
  if (state && (!state.indisready || !state.indisvalid)) {
    await client.query(`drop index concurrently if exists ${name}`);
  }
  await client.query(statement);
  const verified = await client.query(`
    select indisready, indisvalid
    from pg_index
    where indexrelid = to_regclass($1)
  `, [name]);
  if (!verified.rows[0]?.indisready || !verified.rows[0]?.indisvalid) {
    throw new Error(`Concurrent index ${name} is not ready and valid`);
  }
}

async function installConstraintsAndIndexes() {
  await replaceCheckConstraint(
    SOURCE_TABLE,
    'career_page_sources_logo_status_check',
    "logo_verification_status in ('unverified', 'verified', 'failed')",
  );
  await replaceCheckConstraint(
    SOURCE_TABLE,
    'career_page_sources_logo_evidence_check',
    `logo_verification_status <> 'verified' or (
       logo_verified_at is not null
       and nullif(btrim(logo_verification_method), '') is not null
       and company_logo_url ~ '^https://[^[:space:]]+$'
     )`,
  );
  await replaceCheckConstraint(
    SOURCE_TABLE,
    'career_page_sources_normalized_identity_check',
    `ats_name = lower(btrim(ats_name))
     and board_token = lower(btrim(board_token))
     and ats_name <> ''
     and board_token <> ''`,
  );
  await replaceCheckConstraint(
    'monitored_jobs',
    'monitored_jobs_certification_fingerprint_check',
    `certification_fingerprint is null
     or certification_fingerprint ~ '^v1:[0-9a-f]{64}:[0-9a-f]{64}$'`,
  );
  await replaceCheckConstraint(
    'monitored_jobs',
    'monitored_jobs_sponsorship_scope_check',
    `(
       sponsorship_status = 'offers'
       and sponsorship_scope is not null
       and sponsorship_scope in ('job_country', 'us_h1b')
     ) or (
       sponsorship_status <> 'offers'
       and sponsorship_scope is null
     )`,
  );

  // Concurrent builds cannot run inside a transaction and do not block ordinary reads or writes.
  const indexes = [
    {
      name: 'career_page_sources_verified_logo_idx',
      statement: `create index concurrently if not exists career_page_sources_verified_logo_idx
        on ${SOURCE_TABLE} (enabled, logo_verification_status, logo_verified_at)`,
    },
    {
      name: 'monitored_jobs_active_last_seen_idx',
      statement: `create index concurrently if not exists monitored_jobs_active_last_seen_idx
        on monitored_jobs (is_active, last_seen_at)`,
    },
    {
      name: 'monitored_jobs_verified_inventory_idx',
      statement: `create index concurrently if not exists monitored_jobs_verified_inventory_idx
        on monitored_jobs (is_active, ingest_eligible, last_seen_at)`,
    },
    {
      name: 'monitored_jobs_sponsorship_scope_idx',
      statement: `create index concurrently if not exists monitored_jobs_sponsorship_scope_idx
        on monitored_jobs (is_active, sponsorship_status, sponsorship_scope, job_country)`,
    },
  ];
  for (const index of indexes) await ensureConcurrentIndex(index.name, index.statement);
}

async function reportProofState() {
  const { rows } = await client.query(`
    select
      count(*)::int as total_sources,
      count(*) filter (
        where enabled = true
          and ats_name in ('greenhouse', 'lever', 'ashby', 'workable', 'rippling', 'breezy', 'recruitee', 'crelate')
          and portal_name_mismatch = false
          and nullif(btrim(portal_company_name), '') is not null
          and logo_verification_status = 'verified'
          and logo_verified_at between now() - interval '30 days' and now() + interval '5 minutes'
          and nullif(btrim(logo_verification_method), '') is not null
          and logo_verification_method in (
            'first_party_ats_employer_logo',
            'first_party_ats_employer_logo_durable_copy',
            'first_party_ats_identity_and_homepage_logo_asset'
          )
          and company_logo_url ~ '^https://[^[:space:]]+$'
      )::int as verified_sources
    from ${SOURCE_TABLE}
  `);
  const proof = rows[0];
  console.log('Verified-inventory schema finalization is ready.');
  console.log(
    `${proof.verified_sources} of ${proof.total_sources} sources currently have strict logo proof.`,
  );
  console.log(
    'Rollback guard: do not deploy a writer that omits monitored_jobs.sponsorship_scope after finalization.',
  );
}

async function finalize() {
  await normalizeSourceIdentities();
  /* Seed reviewed domains before the catch-all repair assigns the generic ATS candidate method.
     Otherwise every clean columns-phase row becomes ineligible for domain seeding. */
  await seedReviewedDomainCandidates();
  await repairLegacyEvidence();
  await backfillSponsorshipScopes();
  await installConstraintsAndIndexes();
  await reportProofState();
}

try {
  await configureSession();
  if (phase === 'columns') await applyColumns();
  else await finalize();
} catch (error) {
  const message = String(error?.message ?? error)
    .replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error(`Verified-inventory ${phase} migration failed:`, message);
  process.exitCode = 1;
} finally {
  await client.end();
}
