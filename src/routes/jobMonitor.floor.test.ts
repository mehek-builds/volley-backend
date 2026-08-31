import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  CLOSED_POSTING_RETENTION_DAYS,
  PURGE_UNVERIFIED_POSTINGS_AFTER_DAYS,
  VERIFIED_ACTIVE_WINDOW_DAYS,
  MINIMUM_SPONSOR_SURFACED_JOBS,
  MONITOR_METRICS_STATEMENT_TIMEOUT_MS,
  TARGET_ROLE_COVERAGE_STATEMENT_TIMEOUT_MS,
  MINIMUM_SURFACED_GROUPED_ROLES,
  MINIMUM_SURFACED_JOBS,
  GROUPED_ROLE_ALERT_THRESHOLD,
  REQUIRED_HEADROOM_MULTIPLE,
  REQUIRED_SURFACED_GROUPED_ROLES,
  REQUIRED_SURFACED_JOBS,
  TARGET_SURFACED_GROUPED_ROLES,
  TARGET_SURFACED_POSTINGS,
  boardHealth,
  boardIsBelowFloor,
  completedPollFields,
  detailCursorFromLastError,
  detailCursorKeyFromLastError,
  detailRefreshStatus,
  groupedRoleAlertTriggered,
  inventoryTargetMet,
  jobMonitorDrainShouldInitialize,
  pollingQueueStatus,
  publicVerifiedEvidenceGateEnabled,
  mergeJobSources,
  monitorQuerySchema,
  shouldKeepPostingsOnEmptyFetch,
  targetRoleCoverageMetrics,
  groupedSponsorshipFor,
  sponsorOnlyPredicate,
  sponsorshipCountryCodeFor,
  withVerifiedCompanyLogo,
} from './jobMonitor';
import type { JobSourceInput } from '../lib/jobMonitor';
import { AUTONOMOUS_PORTAL_FAMILIES, portalCanAutoSubmit } from '../lib/portalSubmission';
import { hasUsableDescription, POLLABLE_JOB_BOARDS } from '../lib/jobMonitor';
import { POLL_TIME_BUDGET_MS } from '../lib/jobPollScheduler';

test('the board has independent five-hundred-thousand posting and fifty-thousand grouped-role floors', () => {
  // Pinned as a value, not just a comparison. If someone "fixes" a breach by lowering the number,
  // this test is what makes that show up as a deliberate edit in a diff rather than a quiet tweak.
  assert.equal(MINIMUM_SURFACED_JOBS, 500_000);
  assert.equal(MINIMUM_SURFACED_GROUPED_ROLES, 50_000);
  assert.equal(MINIMUM_SPONSOR_SURFACED_JOBS, 5_000);
  assert.equal(boardIsBelowFloor(499_999), true);
  assert.equal(boardIsBelowFloor(500_000), false, 'exactly at the floor is not below it');
  assert.equal(boardIsBelowFloor(500_001), false);
  assert.equal(boardIsBelowFloor(0), true, 'an empty board is the case this exists for');
});

test('the manual monitor fallback summary always reports postings and grouped roles', () => {
  const workflow = readFileSync('.github/workflows/job-monitor.yml', 'utf8');
  assert.match(workflow, /surfaced_postings/);
  assert.match(workflow, /surfaced_grouped_roles/);
  assert.match(workflow, /certified_unique_jobs/);
  assert.match(workflow, /certified_unique_grouped_roles/);
  assert.match(workflow, /certified_unique_sponsor_jobs/);
  assert.match(workflow, /target_surfaced_postings/);
  assert.match(workflow, /target_surfaced_grouped_roles/);
  assert.match(workflow, /inventory_target_met/);
  assert.match(workflow, /grouped_role_alert_triggered/);
  assert.match(workflow, /classification_coverage/);
  assert.match(workflow, /target_role_coverage/);
  assert.match(workflow, /poll_segment_size/);
  assert.match(workflow, /structured_monitor_response=false/);
  assert.match(workflow, /\(\.polling_complete \| type\) == "boolean"/);
});

test('the logo gate measures every counted row against its exact employer board', () => {
  const route = readFileSync('src/routes/jobMonitor.ts', 'utf8');
  const gate = readFileSync('scripts/check-logo-coverage.mjs', 'utf8');
  assert.match(route, /company_logo_sources: companyLogoSources/);
  assert.match(route, /groupBy\(monitored_jobs\.company_name, career_page_sources\.career_url\)/);
  assert.match(gate, /miss: '404'/, 'a monogram must not pass as a verified logo');
  assert.match(gate, /Every surfaced posting has a verified company logo/);
});

test('the scheduled catalog includes reviewed sources and deduplicated operator overrides', () => {
  const reviewed: JobSourceInput[] = [
    { company_name: 'Reviewed', ats_name: 'workable', board_token: 'same', career_url: 'https://example.com/reviewed' },
    { company_name: 'Kept', ats_name: 'greenhouse', board_token: 'kept', career_url: 'https://example.com/kept' },
  ];
  const configured: JobSourceInput[] = [
    { company_name: 'Override', ats_name: 'workable', board_token: 'SAME', career_url: 'https://example.com/override', enabled: false },
  ];
  assert.deepEqual(mergeJobSources(reviewed, configured), [
    { ...configured[0], board_token: 'same' },
    reviewed[1],
  ]);
});

test('source identity normalization uses the provider executable-token contract', () => {
  assert.equal(mergeJobSources([], [{
    company_name: 'Encoded',
    ats_name: 'greenhouse',
    board_token: 'Acme%2DJobs',
    career_url: 'https://example.com/jobs',
  }])[0]?.board_token, 'acme-jobs');
  assert.throws(() => mergeJobSources([], [{
    company_name: 'Unsafe',
    ats_name: 'breezy',
    board_token: 'tenant.example',
    career_url: 'https://example.com/jobs',
  }]), /Invalid breezy board token/);
});

test('the monitor never retires the persisted source fleet from a smaller static catalog', () => {
  const source = readFileSync('src/routes/jobMonitor.ts', 'utf8');
  assert.doesNotMatch(source, /await retireUnlistedSources\(allSources\)/);
  assert.match(source, /const retired: string\[\] = \[\]/);
});

test('post-poll metric statements leave time for the cron to answer', () => {
  assert.equal(MONITOR_METRICS_STATEMENT_TIMEOUT_MS, 30_000);
  assert.equal(TARGET_ROLE_COVERAGE_STATEMENT_TIMEOUT_MS, 5_000);
  assert.equal(POLL_TIME_BUDGET_MS, 9 * 60_000);
  assert.ok(TARGET_ROLE_COVERAGE_STATEMENT_TIMEOUT_MS < MONITOR_METRICS_STATEMENT_TIMEOUT_MS);
  assert.ok(MONITOR_METRICS_STATEMENT_TIMEOUT_MS < 14 * 60_000 - POLL_TIME_BUDGET_MS);
});

test('source 401 completes on the second pass of the same drain run', () => {
  assert.deepEqual(pollingQueueStatus(401), { deferredSources: 401, pollingComplete: false });
  assert.deepEqual(pollingQueueStatus(1), { deferredSources: 1, pollingComplete: false });
  assert.deepEqual(pollingQueueStatus(0), { deferredSources: 0, pollingComplete: true });

  const workflow = readFileSync('.github/workflows/job-monitor.yml', 'utf8');
  assert.match(workflow, /drain_started_at="\$\(date -u/);
  assert.match(workflow, /\?drain_started_at=\$\{drain_started_at\}/);
  assert.match(workflow, /initialize_drain=true/);
  assert.match(workflow, /--max-time 900/);
  assert.match(workflow, /retrying the same cursor/);
});

test('a client-owned cursor can initialize discovery exactly for the first logical drain call', () => {
  const drainStartedAt = '2026-08-30T10:15:00.000Z';
  assert.equal(jobMonitorDrainShouldInitialize(undefined, false), true,
    'the manual no-cursor path remains a fresh drain');
  assert.equal(jobMonitorDrainShouldInitialize(drainStartedAt, true), true,
    'the worker can initialize discovery while supplying its own cursor');
  assert.equal(jobMonitorDrainShouldInitialize(drainStartedAt, false), false,
    'subsequent segments skip discovery for the same cursor');
  assert.equal(monitorQuerySchema.safeParse({
    drain_started_at: drainStartedAt,
    initialize_drain: 'true',
  }).success, true);
  assert.equal(monitorQuerySchema.safeParse({
    drain_started_at: drainStartedAt,
    initialize_drain: 'false',
  }).success, false, 'only the explicit true initialization signal is accepted');

  const route = readFileSync('src/routes/jobMonitor.ts', 'utf8');
  assert.match(route, /if \(initializeDrain\) \{/);
  assert.match(route, /const brandedSources = initializeDrain/);
});

test('target-role database aggregates are shaped without exposing literal role text', async () => {
  const executor = {
    execute: async () => ({ rows: [{ distinct_target_roles: 5, covered_target_roles: 3 }] }),
  };
  const result = await targetRoleCoverageMetrics(executor as never);
  assert.deepEqual(result, {
    distinct_target_roles: 5,
    covered_target_roles: 3,
    zero_result_target_roles: 2,
    zero_result_share: 0.4,
    minimum_matches_per_target_role: 1,
    coverage_threshold_met: false,
    measurement_available: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /role_samples/);
});

test('an empty poll response never deactivates a board that currently has postings', () => {
  // The single-run path to an empty board: the poll sweep flips every one of a source's jobs
  // inactive and re-inserts what came back. Two or three big boards answering empty clears the
  // floor in one cron run, and every check still reports success.
  assert.equal(shouldKeepPostingsOnEmptyFetch(0, 600), true, 'a rotated token must not wipe 600 jobs');
  assert.equal(shouldKeepPostingsOnEmptyFetch(0, 1), true);
  // A genuinely new or already-empty source has nothing to protect, so the normal path runs.
  assert.equal(shouldKeepPostingsOnEmptyFetch(0, 0), false);
  // A non-empty response is always allowed to replace what is there, including a shrink.
  assert.equal(shouldKeepPostingsOnEmptyFetch(5, 600), false, 'a real shrink is still honoured');
  assert.equal(shouldKeepPostingsOnEmptyFetch(600, 600), false);
});

test('multi-request provider cursor progress survives between source polls', () => {
  const status = detailRefreshStatus({
    cursor: 0,
    total: 900,
    attempted: 600,
    succeeded: 597,
    failed: 3,
    remaining_in_cycle: 300,
    next_cursor: 600,
    cycle_complete: false,
    deadline_reached: false,
  });
  assert.match(status ?? '', /next_detail_cursor=600/);
  assert.equal(detailCursorFromLastError(status), 600);
  assert.equal(detailCursorFromLastError('unrelated provider error'), 0);
  assert.equal(detailRefreshStatus({
    cursor: 600,
    total: 900,
    attempted: 300,
    succeeded: 300,
    failed: 0,
    remaining_in_cycle: 0,
    next_cursor: 0,
    cycle_complete: true,
    deadline_reached: false,
  }), null);
});

test('keyset detail progress survives diagnostics without exposing the raw provider id', () => {
  const status = detailRefreshStatus({
    cursor: 0,
    cursor_key: null,
    total: 900,
    attempted: 600,
    succeeded: 600,
    failed: 0,
    remaining_in_cycle: 300,
    next_cursor: 600,
    next_cursor_key: 'provider/job id 600',
    cycle_complete: false,
    deadline_reached: false,
  });
  assert.doesNotMatch(status ?? '', /provider\/job id 600/);
  assert.equal(detailCursorKeyFromLastError(status), 'provider/job id 600');
  assert.equal(detailCursorKeyFromLastError('next_detail_cursor_key=%%%'), undefined);
});

test('a partial detail window remains eligible in the same drain', () => {
  const completedAt = new Date('2026-08-30T00:00:00.000Z');
  assert.deepEqual(completedPollFields({
    cursor: 0,
    total: 900,
    attempted: 600,
    succeeded: 600,
    failed: 0,
    remaining_in_cycle: 300,
    next_cursor: 600,
    cycle_complete: false,
    deadline_reached: false,
  }, completedAt), {});
  assert.deepEqual(completedPollFields(undefined, completedAt), {
    last_polled_at: completedAt,
    last_successful_poll_at: completedAt,
  });
  assert.deepEqual(completedPollFields({
    cursor: 600,
    total: 900,
    attempted: 300,
    succeeded: 300,
    failed: 0,
    remaining_in_cycle: 0,
    next_cursor: 0,
    cycle_complete: true,
    deadline_reached: false,
  }, completedAt), {
    last_polled_at: completedAt,
    last_successful_poll_at: completedAt,
  });
});

test('list-confirmed IDs with failed details are reactivated before successful upserts', () => {
  const source = readFileSync('src/routes/jobMonitor.ts', 'utf8');
  const poll = source.slice(source.indexOf('export async function pollSource'), source.indexOf('/* The board\'s filter set'));
  assert.match(poll, /fetched\.preserve_external_ids/);
  assert.match(poll, /set\(\{ is_active: true \}\)/);
  assert.doesNotMatch(poll, /set\(\{ is_active: true, last_seen_at:/,
    'a list-only observation must not refresh detail evidence');
  assert.match(poll, /inArray\(monitored_jobs\.external_id, ids\)/);
  assert.match(poll, /detailCursorFromLastError\(source\.last_error\)/);
  assert.match(poll, /tx\.update\(career_page_sources\)/,
    'job writes and cursor advancement must share one transaction');
});

test('a completed cursor cycle cannot certify detail failures preserved by an earlier window', () => {
  const completedAt = new Date('2026-08-30T00:00:00.000Z');
  assert.deepEqual(completedPollFields({
    cursor: 600,
    total: 900,
    attempted: 300,
    succeeded: 300,
    failed: 0,
    remaining_in_cycle: 0,
    next_cursor: 0,
    cycle_complete: true,
    deadline_reached: false,
  }, completedAt), {
    last_polled_at: completedAt,
    last_successful_poll_at: completedAt,
  });

  const source = readFileSync('src/routes/jobMonitor.ts', 'utf8');
  const metrics = source.slice(
    source.indexOf('export async function boardInventoryMetrics'),
    source.indexOf('export async function boardMonitoringSnapshot'),
  );
  assert.match(metrics, /gte\(monitored_jobs\.last_seen_at, certifiedSince\)/,
    'only a successful detail upsert may provide current-drain certification');
});

test('the floor and the autonomy rule are enforced against the same set of portals', () => {
  // The two constraints pull against each other: every portal removed from AUTONOMOUS_PORTAL_FAMILIES
  // subtracts its boards from the number the floor is measured on. This asserts they cannot drift
  // apart - a board may only be polled from a portal that is both autonomous and pollable, so the
  // floor is always counted over exactly the jobs the board is allowed to show.
  for (const board of POLLABLE_JOB_BOARDS) {
    assert.equal(portalCanAutoSubmit(board), true, `${board} is polled but cannot be completed`);
    assert.ok(
      (AUTONOMOUS_PORTAL_FAMILIES as readonly string[]).includes(board),
      `${board} is polled but is not in the set the floor counts over`,
    );
  }
  assert.ok(POLLABLE_JOB_BOARDS.length > 0, 'no pollable boards means the floor can never be met');
});

test('current inventory is verified by a recent successful ATS observation', () => {
  assert.equal(VERIFIED_ACTIVE_WINDOW_DAYS, 7);
  const source = readFileSync('src/routes/jobMonitor.ts', 'utf8');
  assert.match(source, /freshnessPredicate[\s\S]{0,300}monitored_jobs\.last_seen_at/);
  assert.doesNotMatch(source, /freshnessPredicate[\s\S]{0,300}monitored_jobs\.posted_at/);
});

test('posting and grouped-role warnings are evaluated together', () => {
  assert.equal(REQUIRED_HEADROOM_MULTIPLE, 1.2);
  assert.equal(REQUIRED_SURFACED_JOBS, 600_000);
  assert.equal(REQUIRED_SURFACED_GROUPED_ROLES, 55_000);
  assert.equal(GROUPED_ROLE_ALERT_THRESHOLD, 55_000);
  assert.equal(groupedRoleAlertTriggered(55_000), false, 'the threshold itself is healthy');
  assert.equal(groupedRoleAlertTriggered(54_999), true, 'the alert fires before the hard floor');
  assert.equal(groupedRoleAlertTriggered(50_000), true, 'the hard-floor boundary remains alerted');
  assert.equal(boardHealth(600_001, 55_001), 'ok');
  assert.equal(boardHealth(600_000, 55_000), 'ok', 'exactly at both warning lines is healthy');
  assert.equal(boardHealth(599_999, 55_000), 'low', 'posting headroom warns');
  assert.equal(boardHealth(600_000, 54_999), 'low', 'grouped-role headroom warns');
  assert.equal(boardHealth(500_000, 50_000), 'low', 'exactly at both floors is not a breach');
  assert.equal(boardHealth(499_999, 60_000), 'breached', 'postings can breach independently');
  assert.equal(boardHealth(600_000, 49_999), 'breached', 'grouped roles can breach independently');
  assert.equal(boardHealth(0, 0), 'breached');
});

test('supply targets remain above both early warning lines', () => {
  assert.equal(TARGET_SURFACED_POSTINGS, 625_000);
  assert.equal(TARGET_SURFACED_GROUPED_ROLES, 60_000);
  assert.ok(TARGET_SURFACED_POSTINGS > REQUIRED_SURFACED_JOBS);
  assert.ok(TARGET_SURFACED_GROUPED_ROLES > REQUIRED_SURFACED_GROUPED_ROLES);
  assert.equal(inventoryTargetMet(625_000, 60_000), true, 'exactly at both targets passes');
  assert.equal(inventoryTargetMet(624_999, 60_000), false, 'posting target is independent');
  assert.equal(inventoryTargetMet(625_000, 59_999), false, 'grouped-role target is independent');
});

test('a thin board warns without failing the run, so the 5xx keeps meaning "broken now"', () => {
  // Encoded as a property of the two predicates rather than of the route: 'low' must never satisfy
  // boardIsBelowFloor, or the early warning would page someone and the real breach signal would be
  // trained away.
  for (const n of [54_999, 52_000, 50_000]) {
    assert.equal(boardHealth(600_000, n), 'low', String(n));
    assert.ok(n >= MINIMUM_SURFACED_GROUPED_ROLES, `${n} must warn, not 5xx`);
  }
});

test('an old publication still counts when the employer live feed returns it', () => {
  const source = readFileSync('src/routes/jobMonitor.ts', 'utf8');
  assert.doesNotMatch(source, /const cutoff = new Date/);
  assert.doesNotMatch(source, /job\.posted_at\s*>=/);
});

test('a board whose postings are all placeholders is NOT mistaken for a board that returned nothing', () => {
  /* The same trap as the freshness one above, and Disney is the live case: its board is exactly two
     postings, "MASTER TEMPLATE" -> "PLACEHOLDER" and "prospecting test" -> "afdsfasdfasdf". Feeding
     the usability-filtered count to the empty-response guard would read as "the API returned
     nothing", protect those two rows from the sweep, and leave the junk on the board permanently -
     the rule would be a no-op for the very worst board it exists to clean. So the guard keys off the
     RAW fetch here too, and the filter runs after it. */
  const disneyBoard = [
    { title: 'MASTER TEMPLATE', description: 'PLACEHOLDER' },
    { title: 'prospecting test', description: 'afdsfasdfasdf' },
  ];
  const usable = disneyBoard.filter(hasUsableDescription);
  assert.equal(usable.length, 0, 'neither posting may be stored');
  assert.equal(shouldKeepPostingsOnEmptyFetch(disneyBoard.length, 2), false,
    'the board ANSWERED, so its rows must still be swept and the placeholders must disappear');
  assert.equal(shouldKeepPostingsOnEmptyFetch(usable.length, 2), true,
    'and this is the wrong count to guard on: it would pin the junk forever');
});

test('closed postings leave the product immediately, and the row lingers only briefly', () => {
  // Two different clocks, and conflating them is the mistake worth guarding against. A posting is
  // gone from the product the moment is_active flips (every board query filters on it); retention
  // governs only how long the dead ROW survives so "why did these vanish" is still answerable.
  assert.equal(CLOSED_POSTING_RETENTION_DAYS, 2);
  assert.ok(CLOSED_POSTING_RETENTION_DAYS > 0,
    'zero would delete the evidence on the same run that created it');
  assert.ok(CLOSED_POSTING_RETENTION_DAYS < VERIFIED_ACTIVE_WINDOW_DAYS,
    'a closed posting must not outlive the verification window');
});

test('the purge keeps a full verification window of slack, so it cannot fight the poller', () => {
  // Reads the constant the purge query actually uses. Recomputing the value locally would let a
  // boundary regression stay green because the test would only assert its own arithmetic.
  assert.ok(PURGE_UNVERIFIED_POSTINGS_AFTER_DAYS > VERIFIED_ACTIVE_WINDOW_DAYS,
    'purging at or inside the window churns rows the poller keeps restoring');
  // Fourteen days gives a complete seven-day verification cycle of slack.
  assert.equal(PURGE_UNVERIFIED_POSTINGS_AFTER_DAYS, 14);
});

test('the internship commitment is pinned at 2,000 and is not yet a 5xx', async () => {
  const { MINIMUM_SURFACED_INTERNSHIPS } = await import('./jobMonitor');
  // Pinned as a value for the same reason the board floor is: a commitment that can be edged
  // downward to match whatever the board happens to hold is not a commitment.
  assert.equal(MINIMUM_SURFACED_INTERNSHIPS, 2_000);

  // Repo-relative, matching the workflow reads above; import.meta is not available under this tsconfig.
  const source = readFileSync('src/routes/jobMonitor.ts', 'utf8');
  /* The internship shortfall must WARN, never fail the run. The board floor's 5xx means "the
     board is broken now"; the internship number is ~8x under its commitment on the day it was
     set, so wiring it to the same 5xx would make the cron permanently red and retire the alarm
     that still means something. If this ever becomes an error path, it should be because the
     supply arrived first - and then this test is the thing that has to be deliberately changed. */
  assert.ok(
    !/surfacedInternships\s*<\s*MINIMUM_SURFACED_INTERNSHIPS[\s\S]{0,400}?reply\.status\(5/.test(source),
    'the internship shortfall must not return a 5xx while the board is this far under it',
  );
  assert.ok(
    /surfaced_internships:/.test(source),
    'the internship count is reported on every cron run, including while it is far short',
  );
});

test('internship supply is never grown by loosening what counts as an internship', async () => {
  const { resolveEmploymentType } = await import('../lib/compensation');
  /* All three are live full-time postings that a broader early-career pattern picks up. Measured
     2026-08-03 across 36,435 postings while looking for a way to close the gap to 2,000: widening
     the pattern to university/campus/early-career adds 198 titles, and these are what it adds. */
  for (const title of [
    'University Recruiter',
    'Campus Recruiter',
    'Early Career - Family Medicine Physician',
    'Trainee Spa Therapist',
  ]) {
    assert.notEqual(resolveEmploymentType(title), 'Internship', `${title} is not an internship`);
  }
  // And the genuine ones still resolve.
  assert.equal(resolveEmploymentType('Platform Engineer Intern, Summer 2027'), 'Internship');
  assert.equal(resolveEmploymentType('Software Engineering Co-Op'), 'Internship');
});

test('country-aware sponsorship evidence names the jurisdiction', () => {
  assert.equal(sponsorshipCountryCodeFor({
    sponsorship_status: 'offers',
    sponsorship_scope: 'job_country',
    employer_sponsors: false,
    raw_json: { portal_country: 'Germany' },
    location: 'Berlin',
  }), 'DE');
  assert.equal(sponsorshipCountryCodeFor({
    sponsorship_status: 'offers',
    sponsorship_scope: 'us_h1b',
    employer_sponsors: false,
    job_country: 'non_us',
    raw_json: { portal_country: 'Germany' },
    location: 'Berlin',
  }), null, 'an H-1B clause is not German work-permit sponsorship');
  assert.equal(sponsorshipCountryCodeFor({
    sponsorship_status: 'offers',
    sponsorship_scope: 'us_h1b',
    employer_sponsors: false,
    job_country: 'us',
    location: 'New York, NY',
  }), 'US');
  assert.equal(sponsorshipCountryCodeFor({
    sponsorship_status: 'unstated',
    employer_sponsors: true,
    location: 'New York, NY',
  }), 'US');
  assert.equal(sponsorshipCountryCodeFor({
    sponsorship_status: 'refuses',
    employer_sponsors: true,
    location: 'New York, NY',
  }), null);
  assert.equal(sponsorshipCountryCodeFor({
    sponsorship_status: 'unstated',
    employer_sponsors: true,
    job_country: 'non_us',
    location: 'Berlin, Germany',
  }), null, 'US filing history is not evidence for a German posting');
  assert.equal(sponsorshipCountryCodeFor({
    sponsorship_status: 'unstated',
    employer_sponsors: true,
    job_country: 'us',
    portal_name_mismatch: true,
    location: 'New York, NY',
  }), null, 'a mismatched portal identity cannot carry employer-level evidence');
});

test('grouped sponsorship keeps every offer attached to its own country', () => {
  assert.deepEqual(groupedSponsorshipFor({
    postingOffers: [
      {
        sponsorship_scope: 'job_country',
        job_country: 'us',
        location: 'New York, NY',
      },
      {
        sponsorship_scope: 'us_h1b',
        job_country: 'non_us',
        raw_json: { portal_country: 'Germany' },
        location: 'Berlin',
      },
    ],
    employerFilesH1b: false,
  }), {
    evidence: 'posting_offers',
    countryCodes: ['US'],
  }, 'Berlin cannot inherit the US offer, and its H-1B-only clause contributes no German code');

  assert.deepEqual(groupedSponsorshipFor({
    postingOffers: [{
      sponsorship_scope: 'job_country',
      job_country: 'non_us',
      raw_json: { portal_country: 'Germany' },
      location: 'Berlin',
    }],
    employerFilesH1b: true,
  }), {
    evidence: 'posting_offers',
    countryCodes: ['DE'],
  }, 'a generic Berlin offer falls back to the posting country and outranks US filing history');
});

test('the SQL sponsorship gate makes H-1B offers US-only', async () => {
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const query = new PgDialect().sqlToQuery(sponsorOnlyPredicate()!);
  assert.match(query.sql, /"monitored_jobs"\."sponsorship_scope" is null/);
  assert.match(query.sql, /"monitored_jobs"\."sponsorship_scope" <> \$/);
  assert.match(query.sql, /"monitored_jobs"\."job_country" <> \$/);
  assert.ok(query.params.includes('us_h1b'));
  assert.ok(query.params.includes('non_us'));
});

test('the 500,000-job inventory definition includes persisted verified logo evidence', () => {
  const source = readFileSync('src/routes/jobMonitor.ts', 'utf8');
  const conditions = source.slice(
    source.indexOf('export function boardConditions('),
    source.indexOf('type PersistedCompanyLogoEvidence', source.indexOf('export function boardConditions(')),
  );
  assert.match(conditions, /verifiedLogoEvidencePredicate\(\)/);
  assert.match(conditions, /monitored_jobs\.ingest_eligible/);
  assert.match(conditions, /career_page_sources\.portal_company_name/);
  assert.match(source, /logo_verification_status, 'verified'/);
  assert.match(source, /career_page_sources\.logo_verified_at/);
  assert.match(source, /career_page_sources\.company_domain/);
  assert.match(source, /career_page_sources\.company_logo_url/);

  const migration = readFileSync('scripts/apply-job-logo-evidence-schema.mjs', 'utf8');
  for (const column of [
    'company_domain',
    'company_logo_url',
    'logo_verification_status',
    'logo_verification_method',
    'logo_verified_at',
  ]) {
    assert.match(migration, new RegExp(`add column if not exists ${column}`));
  }
  assert.match(migration, /reviewed_company_domain_candidate/);
  assert.match(migration, /career_page_sources_logo_evidence_check/);
});

test('the public evidence gate fails closed and has one explicit rollout bypass', () => {
  assert.equal(publicVerifiedEvidenceGateEnabled({}), true);
  assert.equal(publicVerifiedEvidenceGateEnabled({ JOB_BOARD_VERIFIED_EVIDENCE_GATE: 'enabled' }), true);
  assert.equal(publicVerifiedEvidenceGateEnabled({ JOB_BOARD_VERIFIED_EVIDENCE_GATE: 'disabled' }), false);
  assert.equal(publicVerifiedEvidenceGateEnabled({ JOB_BOARD_VERIFIED_EVIDENCE_GATE: 'false' }), true,
    'a typo must not silently disable verified inventory enforcement');

  const source = readFileSync('src/routes/jobMonitor.ts', 'utf8');
  assert.match(source, /boardInventoryMetrics[\s\S]{0,500}requireVerifiedEvidence: true/);
});

test('public logo evidence uses persisted proof and never a response-time name guess', () => {
  const direct = withVerifiedCompanyLogo({
    company_name: 'Employer',
    company_domain: 'employer.example',
    company_logo_url: 'https://cdn.example/employer-logo.png',
    logo_verification_status: 'verified',
    logo_verification_method: 'first_party_ats_employer_logo',
    logo_verified_at: '2026-08-30T00:00:00.000Z',
  });
  assert.equal(direct.company_logo_url, 'https://cdn.example/employer-logo.png');
  assert.equal(direct.company_domain, 'employer.example');
  assert.equal(direct.company_logo_verification_status, 'verified');
  assert.equal(direct.company_logo_verification_method, 'first_party_ats_employer_logo');
  assert.equal(direct.company_logo_verified_at, '2026-08-30T00:00:00.000Z');

  const domainOnly = withVerifiedCompanyLogo({
    company_name: 'Employer',
    company_domain: 'employer.example',
    company_logo_url: null,
    logo_verification_status: 'verified',
    logo_verification_method: 'board_backlink',
    logo_verified_at: new Date('2026-08-30T00:00:00.000Z'),
  });
  assert.equal(domainOnly.company_domain, null);
  assert.equal(domainOnly.company_logo_url, null, 'a domain alone is not fetched image proof');

  const stale = withVerifiedCompanyLogo({
    company_name: 'Employer',
    company_domain: 'employer.example',
    company_logo_url: 'https://cdn.example/old-logo.png',
    logo_verification_status: 'verified',
    logo_verification_method: 'first_party_ats_employer_logo',
    logo_verified_at: new Date('2020-01-01T00:00:00.000Z'),
  });
  assert.equal(stale.company_logo_url, null, 'expired image proof fails closed');

  const future = withVerifiedCompanyLogo({
    company_name: 'Employer',
    company_domain: 'employer.example',
    company_logo_url: 'https://cdn.example/future-logo.png',
    logo_verification_status: 'verified',
    logo_verification_method: 'first_party_ats_employer_logo',
    logo_verified_at: new Date(Date.now() + 60 * 60 * 1000),
  });
  assert.equal(future.company_logo_url, null, 'future-dated proof fails closed');

  /* Even image-shaped candidate fields return null until proof is verified, which prevents a
     query mistake from exposing the same uncounted logo the inventory gate excluded. */
  const absent = withVerifiedCompanyLogo({
    company_name: 'Airbnb',
    company_domain: 'airbnb.com',
    company_logo_url: 'https://airbnb.com/favicon.ico',
    logo_verification_status: 'unverified',
    logo_verification_method: 'catalog_company_domain_candidate',
    logo_verified_at: null,
  });
  assert.equal(absent.company_domain, null);
  assert.equal(absent.company_logo_url, null);
});

test('employment type is filterable, and an unstated type is not swept into Full-time', async () => {
  const { boardConditions } = await import('./jobMonitor');
  const withFilter = boardConditions({ employmentType: 'Internship' });
  const without = boardConditions({});
  assert.equal(
    withFilter.length,
    without.length + 1,
    'the filter adds exactly one predicate, and only when asked for',
  );

  const source = readFileSync('src/routes/jobMonitor.ts', 'utf8');
  /* eq, never ilike. "Internship" is the value a student filters on expecting a complete and honest
     set, and a substring match would quietly widen it as the vocabulary grows. */
  assert.ok(
    /if \(f\.employmentType\) conditions\.push\(eq\(monitored_jobs\.employment_type, f\.employmentType\)\)/
      .test(source),
    'employment type filters on an exact match',
  );
});
