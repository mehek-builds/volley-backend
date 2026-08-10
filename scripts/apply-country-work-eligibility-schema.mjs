#!/usr/bin/env node

/*
 * Adds the country-scoped work eligibility record and conservatively migrates old US answers.
 *
 * The old columns cannot describe more than the United States and `needs_sponsorship` combines a
 * present need with a future need. The backfill therefore writes only combinations whose full
 * meaning is recoverable:
 *
 *   true / false, no onboarding answer   -> US: authorized, no sponsorship now or later
 *   sponsorship_answer = needs_future    -> US: authorized, no sponsorship now, sponsorship later
 *   sponsorship_answer = no              -> same as true / false
 *
 * `needs_now` and `not_authorized` are intentionally left unmigrated. Neither old shape proves all
 * three required booleans without inventing a future answer. No non-US record is ever inferred.
 */

import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const client = new Client({ connectionString });
await client.connect();

try {
  await client.query('begin');
  await client.query(`
    alter table application_profile
    add column if not exists work_eligibility_by_country jsonb
  `);
  await client.query(`
    update application_profile ap
    set work_eligibility_by_country = jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'country_code', 'US',
      'authorized_now', true,
      'needs_sponsorship_now', false,
      'needs_sponsorship_future',
        case when u.sponsorship_answer = 'needs_future' then true else false end
    )))
    from users u
    where u.id = ap.user_id
      and ap.work_eligibility_by_country is null
      and (
        (
          u.sponsorship_answer = 'needs_future'
          and ap.work_authorized is not false
          and ap.needs_sponsorship is not false
        )
        or (
          u.sponsorship_answer = 'no'
          and ap.work_authorized is not false
          and ap.needs_sponsorship is not true
        )
        or (
          u.sponsorship_answer is null
          and ap.work_authorized is true
          and ap.needs_sponsorship is false
        )
      )
  `);
  const { rows } = await client.query(`
    select data_type
    from information_schema.columns
    where table_schema = current_schema()
      and table_name = 'application_profile'
      and column_name = 'work_eligibility_by_country'
  `);
  if (rows[0]?.data_type !== 'jsonb') {
    throw new Error('application_profile.work_eligibility_by_country is missing or is not jsonb');
  }
  await client.query('commit');
  console.log('Ready: application_profile has country-scoped work eligibility records.');
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  await client.end();
}
