#!/usr/bin/env node

import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
const client = new pg.Client({
  connectionString,
  ssl: isLocal ? undefined : { rejectUnauthorized: true },
});

await client.connect();
try {
  await client.query('begin');
  await client.query('create extension if not exists pg_trgm');
  await client.query(`
    create table if not exists job_board_group_projection_state (
      singleton boolean primary key default true,
      generation uuid not null unique,
      previous_generation uuid,
      projection_as_of timestamptz not null,
      certification_started_at timestamptz not null,
      surfaced_postings integer not null,
      surfaced_grouped_roles integer not null,
      surfaced_sponsor_only_jobs integer not null,
      surfaced_internships integer not null,
      certified_unique_jobs integer not null,
      certified_unique_grouped_roles integer not null,
      certified_unique_sponsor_jobs integer not null,
      certified_unique_internships integer not null,
      refreshed_at timestamptz not null default now(),
      constraint job_board_group_projection_state_singleton_check check (singleton = true),
      constraint job_board_group_projection_state_metrics_check check (
        surfaced_postings >= 0
        and surfaced_grouped_roles >= 0
        and surfaced_sponsor_only_jobs >= 0
        and surfaced_internships >= 0
        and certified_unique_jobs >= 0
        and certified_unique_grouped_roles >= 0
        and certified_unique_sponsor_jobs >= 0
        and certified_unique_internships >= 0
      )
    )
  `);
  await client.query(`
    create table if not exists job_board_group_projection (
      generation uuid not null,
      id uuid not null,
      cursor_tie_id uuid not null,
      company_name text not null,
      title text not null,
      locations text[] not null,
      openings integer not null,
      apply_url text not null,
      remote boolean not null,
      posted_at timestamptz,
      first_seen_at timestamptz not null,
      ats_name text not null,
      career_url text not null,
      company_domain text,
      company_logo_url text,
      logo_verification_status text not null,
      logo_verification_method text,
      logo_verified_at timestamptz,
      salary_min double precision,
      salary_max double precision,
      salary_currency text,
      salary_interval text,
      employment_type text,
      posting_offers jsonb not null,
      employer_sponsors boolean not null,
      constraint job_board_group_projection_generation_id_pk primary key (generation, id)
    )
  `);
  await client.query(`
    create or replace function refresh_job_board_group_projection(p_certified_since timestamptz)
    returns uuid
    language plpgsql
    security invoker
    set search_path = public, pg_temp
    as $function$
    declare
      v_generation uuid := gen_random_uuid();
      v_previous_generation uuid;
      v_as_of timestamptz := statement_timestamp();
      v_surfaced_postings integer;
      v_surfaced_grouped_roles integer;
      v_surfaced_sponsor_only_jobs integer;
      v_surfaced_internships integer;
      v_certified_unique_jobs integer;
      v_certified_unique_grouped_roles integer;
      v_certified_unique_sponsor_jobs integer;
      v_certified_unique_internships integer;
    begin
      if p_certified_since is null then
        raise exception 'certification start time is required' using errcode = '22004';
      end if;

      perform pg_advisory_xact_lock(hashtext('refresh_job_board_group_projection'));
      select generation
        into v_previous_generation
        from job_board_group_projection_state
        where singleton = true
        for update;

      insert into job_board_group_projection (
        generation,
        id,
        cursor_tie_id,
        company_name,
        title,
        locations,
        openings,
        apply_url,
        remote,
        posted_at,
        first_seen_at,
        ats_name,
        career_url,
        company_domain,
        company_logo_url,
        logo_verification_status,
        logo_verification_method,
        logo_verified_at,
        salary_min,
        salary_max,
        salary_currency,
        salary_interval,
        employment_type,
        posting_offers,
        employer_sponsors
      )
      select
        v_generation,
        (array_agg(j.id order by j.posted_at desc nulls last, j.id desc))[1],
        (array_agg(j.id order by j.id))[1],
        j.company_name,
        j.title,
        array_remove(array_agg(distinct j.location), null),
        count(*)::int,
        (array_agg(j.apply_url order by j.posted_at desc nulls last, j.id desc))[1],
        bool_or(j.remote),
        max(j.posted_at),
        min(j.first_seen_at),
        s.ats_name,
        min(s.career_url),
        (array_agg(s.company_domain order by s.logo_verified_at desc, s.id desc))[1],
        (array_agg(s.company_logo_url order by s.logo_verified_at desc, s.id desc))[1],
        (array_agg(s.logo_verification_status order by s.logo_verified_at desc, s.id desc))[1],
        (array_agg(s.logo_verification_method order by s.logo_verified_at desc, s.id desc))[1],
        max(s.logo_verified_at),
        case when count(distinct j.salary_currency) = 1
          and count(distinct j.salary_interval) = 1 then min(j.salary_min) end,
        case when count(distinct j.salary_currency) = 1
          and count(distinct j.salary_interval) = 1 then max(j.salary_max) end,
        case when count(distinct j.salary_currency) = 1
          and count(distinct j.salary_interval) = 1 then min(j.salary_currency) end,
        case when count(distinct j.salary_currency) = 1
          and count(distinct j.salary_interval) = 1 then min(j.salary_interval) end,
        case when count(distinct j.employment_type) = 1 then min(j.employment_type) end,
        coalesce(
          jsonb_agg(jsonb_build_object(
            'sponsorship_scope', j.sponsorship_scope,
            'job_country', j.job_country,
            'location', j.location,
            'raw_json', j.raw_json
          )) filter (where j.sponsorship_status = 'offers'),
          '[]'::jsonb
        ),
        bool_or(
          s.sponsor_employer_id is not null
          and s.portal_name_mismatch = false
          and j.sponsorship_status <> 'refuses'
          and j.job_country <> 'non_us'
        )
      from monitored_jobs j
      inner join career_page_sources s on s.id = j.source_id
      where j.is_active = true
        and j.ingest_eligible = true
        and j.last_seen_at >= v_as_of - interval '7 days'
        and j.first_seen_at <= v_as_of
        and s.enabled = true
        and s.ats_name in (
          'greenhouse', 'lever', 'ashby', 'workable',
          'rippling', 'breezy', 'recruitee', 'crelate'
        )
        and s.portal_name_mismatch = false
        and nullif(btrim(s.portal_company_name), '') is not null
        and s.logo_verification_status = 'verified'
        and s.logo_verified_at is not null
        and s.logo_verified_at >= v_as_of - interval '30 days'
        and s.logo_verified_at <= v_as_of + interval '5 minutes'
        and nullif(btrim(s.logo_verification_method), '') is not null
        and s.logo_verification_method in (
          'first_party_ats_employer_logo',
          'first_party_ats_employer_logo_durable_copy',
          'first_party_ats_identity_and_homepage_logo_asset'
        )
        and s.company_logo_url ~ '^https://[^[:space:]]+$'
      group by j.company_name, j.title, s.ats_name;

      select count(*)::int, coalesce(sum(openings), 0)::int
        into v_surfaced_grouped_roles, v_surfaced_postings
        from job_board_group_projection
        where generation = v_generation;

      with eligible as materialized (
        select
          j.certification_fingerprint,
          split_part(j.certification_fingerprint, ':', 2) as grouped_fingerprint,
          j.employment_type = 'Internship' as is_internship,
          j.sponsorship_status <> 'refuses'
            and (
              (
                j.sponsorship_status = 'offers'
                and (
                  j.sponsorship_scope is null
                  or j.sponsorship_scope <> 'us_h1b'
                  or j.job_country <> 'non_us'
                )
              )
              or (s.sponsor_employer_id is not null and j.job_country <> 'non_us')
            ) as is_sponsor,
          j.last_seen_at >= p_certified_since
            and s.last_successful_poll_at >= p_certified_since
            and j.certification_fingerprint ~ '^v1:[0-9a-f]{64}:[0-9a-f]{64}$' as is_certified
        from monitored_jobs j
        inner join career_page_sources s on s.id = j.source_id
        where j.is_active = true
          and j.ingest_eligible = true
          and j.last_seen_at >= v_as_of - interval '7 days'
          and s.enabled = true
          and s.ats_name in (
            'greenhouse', 'lever', 'ashby', 'workable',
            'rippling', 'breezy', 'recruitee', 'crelate'
          )
          and s.portal_name_mismatch = false
          and nullif(btrim(s.portal_company_name), '') is not null
          and s.logo_verification_status = 'verified'
          and s.logo_verified_at is not null
          and s.logo_verified_at >= v_as_of - interval '30 days'
          and s.logo_verified_at <= v_as_of + interval '5 minutes'
          and nullif(btrim(s.logo_verification_method), '') is not null
          and s.logo_verification_method in (
            'first_party_ats_employer_logo',
            'first_party_ats_employer_logo_durable_copy',
            'first_party_ats_identity_and_homepage_logo_asset'
          )
          and s.company_logo_url ~ '^https://[^[:space:]]+$'
      ), certified_jobs as materialized (
        select
          certification_fingerprint,
          min(grouped_fingerprint) as grouped_fingerprint,
          bool_or(is_sponsor) as is_sponsor,
          bool_or(is_internship) as is_internship
        from eligible
        where is_certified
        group by certification_fingerprint
      )
      select
        count(*) filter (where eligible.is_sponsor)::int,
        count(*) filter (where eligible.is_internship)::int,
        (select count(*)::int from certified_jobs),
        (select count(distinct grouped_fingerprint)::int from certified_jobs),
        (select count(*) filter (where is_sponsor)::int from certified_jobs),
        (select count(*) filter (where is_internship)::int from certified_jobs)
      into
        v_surfaced_sponsor_only_jobs,
        v_surfaced_internships,
        v_certified_unique_jobs,
        v_certified_unique_grouped_roles,
        v_certified_unique_sponsor_jobs,
        v_certified_unique_internships
      from eligible;

      insert into job_board_group_projection_state (
        singleton,
        generation,
        previous_generation,
        projection_as_of,
        certification_started_at,
        surfaced_postings,
        surfaced_grouped_roles,
        surfaced_sponsor_only_jobs,
        surfaced_internships,
        certified_unique_jobs,
        certified_unique_grouped_roles,
        certified_unique_sponsor_jobs,
        certified_unique_internships,
        refreshed_at
      ) values (
        true,
        v_generation,
        v_previous_generation,
        v_as_of,
        p_certified_since,
        v_surfaced_postings,
        v_surfaced_grouped_roles,
        v_surfaced_sponsor_only_jobs,
        v_surfaced_internships,
        v_certified_unique_jobs,
        v_certified_unique_grouped_roles,
        v_certified_unique_sponsor_jobs,
        v_certified_unique_internships,
        clock_timestamp()
      )
      on conflict (singleton) do update set
        previous_generation = job_board_group_projection_state.generation,
        generation = excluded.generation,
        projection_as_of = excluded.projection_as_of,
        certification_started_at = excluded.certification_started_at,
        surfaced_postings = excluded.surfaced_postings,
        surfaced_grouped_roles = excluded.surfaced_grouped_roles,
        surfaced_sponsor_only_jobs = excluded.surfaced_sponsor_only_jobs,
        surfaced_internships = excluded.surfaced_internships,
        certified_unique_jobs = excluded.certified_unique_jobs,
        certified_unique_grouped_roles = excluded.certified_unique_grouped_roles,
        certified_unique_sponsor_jobs = excluded.certified_unique_sponsor_jobs,
        certified_unique_internships = excluded.certified_unique_internships,
        refreshed_at = excluded.refreshed_at;

      delete from job_board_group_projection
        where generation <> v_generation
          and (v_previous_generation is null or generation <> v_previous_generation);
      return v_generation;
    end
    $function$
  `);
  await client.query('commit');

  const indexes = [
    `create index concurrently if not exists monitored_jobs_cursor_idx
      on monitored_jobs (posted_at desc nulls last, first_seen_at desc, id desc)
      where is_active = true and ingest_eligible = true`,
    `create index concurrently if not exists monitored_jobs_group_member_idx
      on monitored_jobs (
        company_name, title, source_id,
        posted_at desc nulls last, first_seen_at desc, id desc
      ) where is_active = true and ingest_eligible = true`,
    `create index concurrently if not exists monitored_jobs_title_trgm_idx
      on monitored_jobs using gin (title gin_trgm_ops)
      where is_active = true and ingest_eligible = true`,
    `create index concurrently if not exists monitored_jobs_description_trgm_idx
      on monitored_jobs using gin (description gin_trgm_ops)
      where is_active = true and ingest_eligible = true`,
    `create index concurrently if not exists job_board_group_projection_cursor_idx
      on job_board_group_projection (
        generation,
        posted_at desc nulls last,
        first_seen_at desc,
        cursor_tie_id desc
      )`,
    `create index concurrently if not exists job_board_group_projection_group_key_idx
      on job_board_group_projection (generation, company_name, title, ats_name)`,
  ];
  for (const statement of indexes) await client.query(statement);

  console.log('Job board performance schema is ready.');
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  console.error(
    'Job board performance schema failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
