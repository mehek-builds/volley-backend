import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

const client = new pg.Client({ connectionString });

try {
  await client.connect();
  await client.query('begin transaction read only');
  await client.query("set local statement_timeout = '2min'");

  const { rows } = await client.query(`
    with packets as (
      select id as packet_id, user_id
      from generated_resumes
    ), artifact_counts as (
      select
        packet.packet_id,
        count(distinct artifact.id) filter (
          where artifact.user_id = packet.user_id
        )::int as owned_artifacts,
        count(distinct artifact.id) filter (
          where artifact.user_id <> packet.user_id
        )::int as foreign_artifacts
      from packets packet
      left join artifacts artifact
        on artifact.legacy_generated_resume_id = packet.packet_id
      group by packet.packet_id
    ), link_counts as (
      select
        packet.packet_id,
        count(*) filter (
          where link.purpose = 'resume'
            and artifact.user_id = packet.user_id
            and application.user_id = packet.user_id
        )::int as owned_exact_links,
        count(distinct application.id) filter (
          where link.purpose = 'resume'
            and artifact.user_id = packet.user_id
            and application.user_id = packet.user_id
        )::int as owned_targets,
        count(distinct artifact.id) filter (
          where link.purpose = 'resume'
            and artifact.user_id = packet.user_id
            and application.user_id = packet.user_id
        )::int as linked_owned_artifacts,
        count(*) filter (
          where link.purpose = 'resume'
            and (
              artifact.user_id is distinct from packet.user_id
              or application.user_id is distinct from packet.user_id
            )
        )::int as foreign_links
      from packets packet
      left join artifacts artifact
        on artifact.legacy_generated_resume_id = packet.packet_id
      left join application_artifacts link
        on link.artifact_id = artifact.id
        and link.purpose = 'resume'
      left join applications application
        on application.id = link.application_id
      group by packet.packet_id
    ), audited as (
      select
        packet.packet_id,
        artifact.owned_artifacts,
        artifact.foreign_artifacts,
        link.owned_exact_links,
        link.owned_targets,
        link.linked_owned_artifacts,
        link.foreign_links
      from packets packet
      inner join artifact_counts artifact using (packet_id)
      inner join link_counts link using (packet_id)
    )
    select
      count(*)::int as total_packets,
      count(*) filter (where owned_artifacts = 0)::int as missing_owned_artifact_packets,
      count(*) filter (where owned_artifacts > 1)::int as multiple_owned_artifact_packets,
      count(*) filter (where foreign_artifacts > 0)::int as foreign_artifact_packets,
      count(*) filter (where owned_exact_links = 0)::int as missing_exact_resume_link_packets,
      count(*) filter (where owned_exact_links > 1)::int as multiple_exact_resume_link_packets,
      count(*) filter (where owned_targets = 0)::int as missing_owned_target_packets,
      count(*) filter (where owned_targets > 1)::int as multiple_owned_target_packets,
      count(*) filter (where linked_owned_artifacts <> 1)::int as linked_artifact_cardinality_mismatch_packets,
      count(*) filter (where foreign_links > 0)::int as foreign_resume_link_packets
    from audited
  `);

  await client.query('rollback');
  const result = rows[0];
  console.log(JSON.stringify(result));

  const mismatchKeys = Object.keys(result).filter((key) => key !== 'total_packets');
  if (mismatchKeys.some((key) => Number(result[key]) !== 0)) process.exitCode = 1;
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  const message = String(error?.message ?? error)
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error(message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
