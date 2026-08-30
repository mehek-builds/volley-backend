#!/usr/bin/env node

import assert from 'node:assert/strict';
import pg from 'pg';

const DEFAULT_ROWS = 500_000;
const DEFAULT_GROUPS = 60_000;
const DEFAULT_SOURCES = 5_000;
const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_WORK_MEM_MB = 64;
const INCLUDE_PLANS = process.argv.includes('--include-plans');

function integerArgument(name, fallback, minimum) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function connectionIsLocal(connectionString) {
  const parsed = new URL(connectionString);
  const queryHost = parsed.searchParams.get('host');
  const host = queryHost || parsed.hostname;
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host.startsWith('/');
}

function collectPlanFacts(node, facts) {
  facts.nodeTypes.add(node['Node Type']);
  if (node['Index Name']) facts.indexes.add(node['Index Name']);
  for (const key of [
    'Shared Hit Blocks',
    'Shared Read Blocks',
    'Shared Dirtied Blocks',
    'Shared Written Blocks',
    'Temp Read Blocks',
    'Temp Written Blocks',
  ]) {
    facts.buffers[key] = (facts.buffers[key] ?? 0) + Number(node[key] ?? 0);
  }
  for (const child of node.Plans ?? []) collectPlanFacts(child, facts);
}

async function explain(client, name, query, parameters, maximumExecutionMs) {
  const result = await client.query(
    `explain (analyze, buffers, settings, summary, format json) ${query}`,
    parameters,
  );
  const document = result.rows[0]['QUERY PLAN'][0];
  const facts = { nodeTypes: new Set(), indexes: new Set(), buffers: {} };
  collectPlanFacts(document.Plan, facts);
  const metric = {
    name,
    planning_ms: Number(document['Planning Time'].toFixed(3)),
    execution_ms: Number(document['Execution Time'].toFixed(3)),
    maximum_execution_ms: maximumExecutionMs,
    within_budget: document['Execution Time'] <= maximumExecutionMs,
    returned_rows: Number(document.Plan['Actual Rows']),
    node_types: [...facts.nodeTypes].sort(),
    indexes: [...facts.indexes].sort(),
    buffers: facts.buffers,
    ...(INCLUDE_PLANS ? { plan: document } : {}),
  };
  assert.ok(
    metric.within_budget,
    `${name} took ${metric.execution_ms}ms, above its ${maximumExecutionMs}ms benchmark budget`,
  );
  return metric;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
if (!connectionIsLocal(connectionString) && !process.argv.includes('--allow-nonlocal')) {
  throw new Error('The benchmark refuses non-local PostgreSQL. Pass --allow-nonlocal explicitly to override.');
}

const rows = integerArgument('rows', DEFAULT_ROWS, DEFAULT_ROWS);
const groups = integerArgument('groups', DEFAULT_GROUPS, 50_000);
const sources = integerArgument('sources', DEFAULT_SOURCES, 1_000);
const pageSize = integerArgument('page-size', DEFAULT_PAGE_SIZE, 1);
const workMemMb = integerArgument('work-mem-mb', DEFAULT_WORK_MEM_MB, 4);
assert.ok(groups <= rows, 'groups cannot exceed rows');
assert.ok(sources <= groups, 'sources cannot exceed groups');

const client = new pg.Client({ connectionString, application_name: 'litos-job-board-500k-benchmark' });
const startedAt = new Date();
await client.connect();

try {
  await client.query('begin');
  await client.query(`set local work_mem = '${workMemMb}MB'`);
  await client.query("set local statement_timeout = '60s'");
  await client.query('set local jit = off');
  await client.query('create extension if not exists pg_trgm');

  await client.query(`
    create temporary table career_page_sources (
      id uuid primary key,
      company_name text not null,
      ats_name text not null,
      board_token text not null,
      career_url text not null,
      company_domain text,
      company_logo_url text,
      logo_verification_status text not null,
      logo_verification_method text,
      logo_verified_at timestamptz,
      enabled boolean not null,
      last_successful_poll_at timestamptz,
      sponsor_employer_id uuid,
      portal_company_name text,
      portal_name_mismatch boolean not null
    ) on commit drop
  `);
  await client.query(`
    create temporary table monitored_jobs (
      id uuid primary key,
      source_id uuid not null references career_page_sources(id),
      external_id text not null,
      company_name text not null,
      title text not null,
      location text,
      department text,
      employment_type text,
      description text not null,
      ingest_eligible boolean not null,
      certification_fingerprint text,
      apply_url text not null,
      posting_url text not null,
      remote boolean not null,
      posted_at timestamptz,
      first_seen_at timestamptz not null,
      last_seen_at timestamptz not null,
      is_active boolean not null,
      sponsorship_status text not null,
      sponsorship_scope text,
      job_country text not null,
      salary_min double precision,
      salary_max double precision,
      salary_currency text,
      salary_interval text,
      raw_json jsonb
    ) on commit drop
  `);

  await client.query(`
    insert into career_page_sources (
      id,
      company_name,
      ats_name,
      board_token,
      career_url,
      company_domain,
      company_logo_url,
      logo_verification_status,
      logo_verification_method,
      logo_verified_at,
      enabled,
      last_successful_poll_at,
      sponsor_employer_id,
      portal_company_name,
      portal_name_mismatch
    )
    select
      ('10000000-0000-4000-8000-' || lpad(source_number::text, 12, '0'))::uuid,
      'Employer ' || source_number,
      (array['greenhouse', 'lever', 'ashby', 'workable', 'rippling', 'breezy', 'recruitee', 'crelate'])[
        1 + ((source_number - 1) % 8)
      ],
      'employer-' || source_number,
      'https://careers.example/employer-' || source_number,
      'employer-' || source_number || '.example',
      'https://assets.example/employer-' || source_number || '/logo.png',
      'verified',
      'first_party_ats_employer_logo',
      clock_timestamp() - interval '1 day',
      true,
      clock_timestamp() - interval '1 hour',
      case when source_number % 5 = 0
        then ('20000000-0000-4000-8000-' || lpad(source_number::text, 12, '0'))::uuid
      end,
      'Employer ' || source_number,
      false
    from generate_series(1, $1::int) source_number
  `, [sources]);

  await client.query(`
    insert into monitored_jobs (
      id,
      source_id,
      external_id,
      company_name,
      title,
      location,
      department,
      employment_type,
      description,
      ingest_eligible,
      certification_fingerprint,
      apply_url,
      posting_url,
      remote,
      posted_at,
      first_seen_at,
      last_seen_at,
      is_active,
      sponsorship_status,
      sponsorship_scope,
      job_country,
      salary_min,
      salary_max,
      salary_currency,
      salary_interval,
      raw_json
    )
    select
      ('30000000-0000-4000-8000-' || lpad(job_number::text, 12, '0'))::uuid,
      ('10000000-0000-4000-8000-' || lpad(source_number::text, 12, '0'))::uuid,
      'posting-' || job_number,
      'Employer ' || source_number,
      'Role ' || role_number,
      (array['New York, NY', 'London, UK', 'Toronto, Canada', 'Dubai, UAE', 'Remote'])[
        1 + ((job_number - 1) % 5)
      ],
      (array['Engineering', 'Product', 'Sales', 'Operations'])[
        1 + ((job_number - 1) % 4)
      ],
      case when job_number % 25 = 0 then 'Internship' else 'Full-time' end,
      case when job_number % 100 = 0 then 'NeedleSearch ' else '' end
        || 'This verified first-party posting describes concrete responsibilities, requirements, '
        || 'qualifications, collaboration expectations, delivery outcomes, and application details. '
        || repeat('Candidates build reliable systems and communicate clearly. ', 6),
      true,
      'v1:' || repeat(md5(group_number::text), 2) || ':' || repeat(md5(job_number::text), 2),
      'https://apply.example/posting-' || job_number,
      'https://jobs.example/posting-' || job_number,
      job_number % 5 = 0,
      case when job_number % 10 = 0 then null
        else transaction_timestamp() - make_interval(secs => ((job_number * 37) % 7776000)::int)
      end,
      transaction_timestamp() - make_interval(secs => ((job_number * 43) % 7776000)::int),
      transaction_timestamp() - interval '1 hour',
      true,
      case when job_number % 20 = 0 then 'offers' else 'unstated' end,
      case when job_number % 20 = 0 then 'job_country' end,
      case when job_number % 3 = 0 then 'non_us' else 'us' end,
      case when job_number % 3 = 0 then null else 90_000 + (job_number % 80_000) end,
      case when job_number % 3 = 0 then null else 120_000 + (job_number % 100_000) end,
      case when job_number % 3 = 0 then null else 'USD' end,
      case when job_number % 3 = 0 then null else 'year' end,
      case when job_number % 20 = 0 then jsonb_build_object('portal_country', 'US') end
    from (
      select
        job_number,
        1 + ((job_number - 1) % $2::int) as group_number,
        1 + ((job_number - 1) % $1::int) as source_number,
        1 + (((job_number - 1) % $2::int) / $1::int) as role_number
      from generate_series(1, $3::int) job_number
    ) fixture
  `, [sources, groups, rows]);

  await client.query(`
    create index monitored_jobs_cursor_idx
      on monitored_jobs (posted_at desc nulls last, first_seen_at desc, id desc)
      where is_active and ingest_eligible
  `);
  await client.query(`
    create index monitored_jobs_group_member_idx
      on monitored_jobs (company_name, title, source_id, posted_at desc nulls last, first_seen_at desc, id desc)
      where is_active and ingest_eligible
  `);
  await client.query(`
    create index monitored_jobs_certification_idx
      on monitored_jobs (last_seen_at, certification_fingerprint)
      where is_active and ingest_eligible and certification_fingerprint is not null
  `);
  await client.query(`
    create index monitored_jobs_title_trgm_idx
      on monitored_jobs using gin (title gin_trgm_ops)
      where is_active and ingest_eligible
  `);
  await client.query(`
    create index monitored_jobs_description_trgm_idx
      on monitored_jobs using gin (description gin_trgm_ops)
      where is_active and ingest_eligible
  `);
  await client.query('analyze career_page_sources');
  await client.query('analyze monitored_jobs');

  const asOfResult = await client.query('select transaction_timestamp() as as_of');
  const asOf = asOfResult.rows[0].as_of;
  const deepPostingResult = await client.query(`
    select j.posted_at, j.first_seen_at, j.id
    from monitored_jobs j
    join career_page_sources s on s.id = j.source_id
    where j.is_active
      and j.ingest_eligible
      and j.last_seen_at >= $1::timestamptz - interval '7 days'
      and j.first_seen_at <= $1::timestamptz
      and s.enabled
      and not s.portal_name_mismatch
      and s.ats_name = any($2::text[])
      and nullif(btrim(s.portal_company_name), '') is not null
      and s.logo_verification_status = 'verified'
      and s.logo_verified_at between $1::timestamptz - interval '30 days' and $1::timestamptz + interval '5 minutes'
      and nullif(btrim(s.logo_verification_method), '') is not null
      and s.company_logo_url ~ '^https://[^[:space:]]+$'
    order by j.posted_at desc nulls last, j.first_seen_at desc, j.id desc
    offset $3::int limit 1
  `, [asOf, ['greenhouse', 'lever', 'ashby', 'workable', 'rippling', 'breezy', 'recruitee', 'crelate'], Math.floor(rows * 0.9)]);
  const postingCursor = deepPostingResult.rows[0];
  assert.ok(postingCursor, 'failed to derive a deep posting cursor');

  const searchCursorResult = await client.query(`
    select
      case when j.title ilike $3::text then 0 else 1 end as q_rank,
      j.posted_at,
      j.first_seen_at,
      j.id
    from monitored_jobs j
    join career_page_sources s on s.id = j.source_id
    where j.is_active
      and j.ingest_eligible
      and (j.title ilike $3::text or j.description ilike $3::text)
      and j.last_seen_at >= $1::timestamptz - interval '7 days'
      and j.first_seen_at <= $1::timestamptz
      and s.enabled
      and not s.portal_name_mismatch
      and s.ats_name = any($2::text[])
      and nullif(btrim(s.portal_company_name), '') is not null
      and s.logo_verification_status = 'verified'
      and s.logo_verified_at between $1::timestamptz - interval '30 days' and $1::timestamptz + interval '5 minutes'
      and nullif(btrim(s.logo_verification_method), '') is not null
      and s.company_logo_url ~ '^https://[^[:space:]]+$'
    order by
      case when j.title ilike $3::text then 0 else 1 end,
      j.posted_at desc nulls last,
      j.first_seen_at desc,
      j.id desc
    offset $4::int limit 1
  `, [asOf, ['greenhouse', 'lever', 'ashby', 'workable', 'rippling', 'breezy', 'recruitee', 'crelate'], '%NeedleSearch%', Math.floor((rows / 100) * 0.9)]);
  const searchCursor = searchCursorResult.rows[0];
  assert.ok(searchCursor, 'failed to derive a deep searched posting cursor');

  await client.query(`
    create temporary table job_board_group_projection on commit drop as
    select
      j.company_name,
      j.title,
      s.ats_name,
      max(j.posted_at) as posted_at,
      min(j.first_seen_at) as first_seen_at,
      (array_agg(j.id order by j.id))[1] as tie_id
    from monitored_jobs j
    join career_page_sources s on s.id = j.source_id
    where j.is_active
      and j.ingest_eligible
      and j.last_seen_at >= $1::timestamptz - interval '7 days'
      and j.first_seen_at <= $1::timestamptz
      and s.enabled
      and not s.portal_name_mismatch
      and s.ats_name = any($2::text[])
      and nullif(btrim(s.portal_company_name), '') is not null
      and s.logo_verification_status = 'verified'
      and s.logo_verified_at between $1::timestamptz - interval '30 days' and $1::timestamptz + interval '5 minutes'
      and nullif(btrim(s.logo_verification_method), '') is not null
      and s.company_logo_url ~ '^https://[^[:space:]]+$'
    group by j.company_name, j.title, s.ats_name
  `, [asOf, ['greenhouse', 'lever', 'ashby', 'workable', 'rippling', 'breezy', 'recruitee', 'crelate']]);
  await client.query(`
    create unique index job_board_group_projection_key_idx
      on job_board_group_projection (company_name, title, ats_name)
  `);
  await client.query(`
    create index job_board_group_projection_cursor_idx
      on job_board_group_projection (posted_at desc nulls last, first_seen_at desc, tie_id desc)
  `);
  await client.query('analyze job_board_group_projection');

  const groupCountResult = await client.query('select count(*)::int as total from job_board_group_projection');
  const actualGroups = groupCountResult.rows[0].total;
  assert.ok(actualGroups >= 50_000, `fixture produced only ${actualGroups} groups`);
  const deepGroupResult = await client.query(`
    select posted_at, first_seen_at, tie_id
    from job_board_group_projection
    order by posted_at desc nulls last, first_seen_at desc, tie_id desc
    offset $1::int limit 1
  `, [Math.floor(actualGroups * 0.9)]);
  const groupCursor = deepGroupResult.rows[0];
  assert.ok(groupCursor, 'failed to derive a deep grouped cursor');

  const autonomousFamilies = ['greenhouse', 'lever', 'ashby', 'workable', 'rippling', 'breezy', 'recruitee', 'crelate'];
  const baseParameters = [asOf, autonomousFamilies];
  const postingParameters = [
    ...baseParameters,
    postingCursor.posted_at,
    postingCursor.first_seen_at,
    postingCursor.id,
    pageSize + 1,
  ];
  const searchParameters = [
    ...baseParameters,
    '%NeedleSearch%',
    Number(searchCursor.q_rank),
    searchCursor.posted_at,
    searchCursor.first_seen_at,
    searchCursor.id,
    pageSize + 1,
  ];
  const groupParameters = [
    ...baseParameters,
    groupCursor.posted_at,
    groupCursor.first_seen_at,
    groupCursor.tie_id,
    pageSize + 1,
  ];

  const postingDeep = await explain(client, 'deep_posting_cursor', `
    select j.id, j.company_name, j.title, j.posted_at, j.first_seen_at
    from monitored_jobs j
    join career_page_sources s on s.id = j.source_id
    where j.is_active
      and j.ingest_eligible
      and j.last_seen_at >= $1::timestamptz - interval '7 days'
      and j.first_seen_at <= $1::timestamptz
      and s.enabled
      and not s.portal_name_mismatch
      and s.ats_name = any($2::text[])
      and nullif(btrim(s.portal_company_name), '') is not null
      and s.logo_verification_status = 'verified'
      and s.logo_verified_at between $1::timestamptz - interval '30 days' and $1::timestamptz + interval '5 minutes'
      and nullif(btrim(s.logo_verification_method), '') is not null
      and s.company_logo_url ~ '^https://[^[:space:]]+$'
      and (
        j.posted_at is null
        or j.posted_at < $3::timestamptz
        or (j.posted_at = $3::timestamptz and j.first_seen_at < $4::timestamptz)
        or (j.posted_at = $3::timestamptz and j.first_seen_at = $4::timestamptz and j.id < $5::uuid)
      )
    order by j.posted_at desc nulls last, j.first_seen_at desc, j.id desc
    limit $6::int
  `, postingParameters, 1_000);

  const postingSearchDeep = await explain(client, 'deep_searched_posting_cursor', `
    select j.id, j.company_name, j.title, j.posted_at, j.first_seen_at
    from monitored_jobs j
    join career_page_sources s on s.id = j.source_id
    where j.is_active
      and j.ingest_eligible
      and (j.title ilike $3::text or j.description ilike $3::text)
      and j.last_seen_at >= $1::timestamptz - interval '7 days'
      and j.first_seen_at <= $1::timestamptz
      and s.enabled
      and not s.portal_name_mismatch
      and s.ats_name = any($2::text[])
      and nullif(btrim(s.portal_company_name), '') is not null
      and s.logo_verification_status = 'verified'
      and s.logo_verified_at between $1::timestamptz - interval '30 days' and $1::timestamptz + interval '5 minutes'
      and nullif(btrim(s.logo_verification_method), '') is not null
      and s.company_logo_url ~ '^https://[^[:space:]]+$'
      and (
        case when j.title ilike $3::text then 0 else 1 end > $4::int
        or (
          case when j.title ilike $3::text then 0 else 1 end = $4::int
          and (
            j.posted_at is null
            or j.posted_at < $5::timestamptz
            or (j.posted_at = $5::timestamptz and j.first_seen_at < $6::timestamptz)
            or (j.posted_at = $5::timestamptz and j.first_seen_at = $6::timestamptz and j.id < $7::uuid)
          )
        )
      )
    order by
      case when j.title ilike $3::text then 0 else 1 end,
      j.posted_at desc nulls last,
      j.first_seen_at desc,
      j.id desc
    limit $8::int
  `, searchParameters, 2_000);

  const groupedDeep = await explain(client, 'deep_grouped_cursor', `
    with selected_groups as materialized (
      select company_name, title, ats_name, posted_at, first_seen_at, tie_id
      from job_board_group_projection
      where posted_at is null
        or posted_at < $3::timestamptz
        or (posted_at = $3::timestamptz and first_seen_at < $4::timestamptz)
        or (posted_at = $3::timestamptz and first_seen_at = $4::timestamptz and tie_id < $5::uuid)
      order by posted_at desc nulls last, first_seen_at desc, tie_id desc
      limit $6::int
    )
    select
      (array_agg(j.id order by j.posted_at desc nulls last, j.id desc))[1] as id,
      j.company_name,
      j.title,
      array_remove(array_agg(distinct j.location), null) as locations,
      count(*)::int as openings,
      (array_agg(j.apply_url order by j.posted_at desc nulls last, j.id desc))[1] as apply_url,
      bool_or(j.remote) as remote,
      max(j.posted_at) as posted_at,
      min(j.first_seen_at) as first_seen_at,
      s.ats_name,
      jsonb_agg(jsonb_build_object(
        'sponsorship_scope', j.sponsorship_scope,
        'job_country', j.job_country,
        'location', j.location,
        'raw_json', j.raw_json
      )) filter (where j.sponsorship_status = 'offers') as posting_offers
    from selected_groups selected
    join monitored_jobs j
      on j.company_name = selected.company_name
      and j.title = selected.title
    join career_page_sources s
      on s.id = j.source_id
      and s.ats_name = selected.ats_name
    where j.is_active
      and j.ingest_eligible
      and j.last_seen_at >= $1::timestamptz - interval '7 days'
      and j.first_seen_at <= $1::timestamptz
      and s.enabled
      and not s.portal_name_mismatch
      and s.ats_name = any($2::text[])
      and nullif(btrim(s.portal_company_name), '') is not null
      and s.logo_verification_status = 'verified'
      and s.logo_verified_at between $1::timestamptz - interval '30 days' and $1::timestamptz + interval '5 minutes'
      and nullif(btrim(s.logo_verification_method), '') is not null
      and s.company_logo_url ~ '^https://[^[:space:]]+$'
    group by j.company_name, j.title, s.ats_name, selected.posted_at, selected.first_seen_at, selected.tie_id
    order by selected.posted_at desc nulls last, selected.first_seen_at desc, selected.tie_id desc
  `, groupParameters, 2_000);

  const certification = await explain(client, 'certification', `
    with eligible as materialized (
      select
        j.certification_fingerprint,
        split_part(j.certification_fingerprint, ':', 2) as grouped_fingerprint,
        j.employment_type = 'Internship' as is_internship,
        j.sponsorship_status <> 'refuses'
          and (j.sponsorship_status = 'offers'
            or (s.sponsor_employer_id is not null and j.job_country <> 'non_us')) as is_sponsor,
        j.last_seen_at >= $1::timestamptz - interval '2 hours'
          and s.last_successful_poll_at >= $1::timestamptz - interval '2 hours'
          and j.certification_fingerprint ~ '^v1:[0-9a-f]{64}:[0-9a-f]{64}$' as is_certified
      from monitored_jobs j
      join career_page_sources s on s.id = j.source_id
      where j.is_active
        and j.ingest_eligible
        and j.last_seen_at >= $1::timestamptz - interval '7 days'
        and j.first_seen_at <= $1::timestamptz
        and s.enabled
        and not s.portal_name_mismatch
        and s.ats_name = any($2::text[])
        and nullif(btrim(s.portal_company_name), '') is not null
        and s.logo_verification_status = 'verified'
        and s.logo_verified_at between $1::timestamptz - interval '30 days' and $1::timestamptz + interval '5 minutes'
        and nullif(btrim(s.logo_verification_method), '') is not null
        and s.company_logo_url ~ '^https://[^[:space:]]+$'
    ), board_counts as (
      select
        count(*)::int as surfaced_postings,
        count(*) filter (where is_sponsor)::int as surfaced_sponsor_only_jobs,
        count(*) filter (where is_internship)::int as surfaced_internships
      from eligible
    ), certified_jobs as materialized (
      select
        certification_fingerprint,
        min(grouped_fingerprint) as grouped_fingerprint,
        bool_or(is_sponsor) as is_sponsor,
        bool_or(is_internship) as is_internship
      from eligible
      where is_certified
      group by certification_fingerprint
    ), certified_counts as (
      select
        count(*)::int as certified_unique_jobs,
        count(distinct grouped_fingerprint)::int as certified_unique_grouped_roles,
        count(*) filter (where is_sponsor)::int as certified_unique_sponsor_jobs,
        count(*) filter (where is_internship)::int as certified_unique_internships
      from certified_jobs
    )
    select
      board_counts.*,
      (select count(*)::int from job_board_group_projection) as surfaced_grouped_roles,
      certified_counts.*
    from board_counts cross join certified_counts
  `, baseParameters, 30_000);

  const report = {
    benchmark: 'litos-job-board-500k',
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    postgres_version: (await client.query('show server_version')).rows[0].server_version,
    settings: {
      work_mem_mb: workMemMb,
      jit: false,
      statement_timeout_ms: 60_000,
    },
    fixture: {
      eligible_jobs: rows,
      grouped_roles: actualGroups,
      sources,
      page_size: pageSize,
      posting_cursor_depth: Math.floor(rows * 0.9),
      grouped_cursor_depth: Math.floor(actualGroups * 0.9),
    },
    metrics: [postingDeep, postingSearchDeep, groupedDeep, certification],
    passed: true,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await client.query('rollback');
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
