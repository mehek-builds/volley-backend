import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  CLOSED_POSTING_RETENTION_DAYS,
  PURGE_POSTINGS_OLDER_THAN_DAYS,
  JOB_FRESHNESS_DAYS,
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
  groupedRoleAlertTriggered,
  inventoryTargetMet,
  pollingQueueStatus,
  mergeJobSources,
  shouldKeepPostingsOnEmptyFetch,
  targetRoleCoverageMetrics,
} from './jobMonitor';
import type { JobSourceInput } from '../lib/jobMonitor';
import { AUTONOMOUS_PORTAL_FAMILIES, portalCanAutoSubmit } from '../lib/portalSubmission';
import { hasUsableDescription, POLLABLE_JOB_BOARDS } from '../lib/jobMonitor';
import { POLL_TIME_BUDGET_MS } from '../lib/jobPollScheduler';

test('the board has independent hundred-thousand posting and ten-thousand grouped-role floors', () => {
  // Pinned as a value, not just a comparison. If someone "fixes" a breach by lowering the number,
  // this test is what makes that show up as a deliberate edit in a diff rather than a quiet tweak.
  assert.equal(MINIMUM_SURFACED_JOBS, 100_000);
  assert.equal(MINIMUM_SURFACED_GROUPED_ROLES, 10_000);
  assert.equal(MINIMUM_SPONSOR_SURFACED_JOBS, 5_000);
  assert.equal(boardIsBelowFloor(99_999), true);
  assert.equal(boardIsBelowFloor(100_000), false, 'exactly at the floor is not below it');
  assert.equal(boardIsBelowFloor(100_001), false);
  assert.equal(boardIsBelowFloor(0), true, 'an empty board is the case this exists for');
});

test('the scheduled cron summary always reports postings and grouped roles', () => {
  const workflow = readFileSync('.github/workflows/job-monitor.yml', 'utf8');
  assert.match(workflow, /surfaced_postings/);
  assert.match(workflow, /surfaced_grouped_roles/);
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

test('the scheduled catalog includes reviewed sources and deduplicated operator overrides', () => {
  const reviewed: JobSourceInput[] = [
    { company_name: 'Reviewed', ats_name: 'workable', board_token: 'same', career_url: 'https://example.com/reviewed' },
    { company_name: 'Kept', ats_name: 'greenhouse', board_token: 'kept', career_url: 'https://example.com/kept' },
  ];
  const configured: JobSourceInput[] = [
    { company_name: 'Override', ats_name: 'workable', board_token: 'same', career_url: 'https://example.com/override', enabled: false },
  ];
  assert.deepEqual(mergeJobSources(reviewed, configured), [configured[0], reviewed[1]]);
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
  assert.match(workflow, /drain_started_at=""/);
  assert.match(workflow, /\?drain_started_at=\$\{drain_started_at\}/);
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

test('the freshness window is three months', () => {
  assert.equal(JOB_FRESHNESS_DAYS, 90);
  /* The floor under the value, not a restatement of it. Hiring is weekday work - Saturday carries
     143 postings against a weekday 700-3,500 - so any window that does not span whole weeks changes
     size depending on which days it covers. Fourteen was the smallest number that absorbed that;
     nothing may take the window back under it without deliberately editing this line. */
  assert.ok(JOB_FRESHNESS_DAYS >= 14, 'a window under two weeks is resized by the weekend it covers');
});

test('posting and grouped-role warnings are evaluated together', () => {
  assert.equal(REQUIRED_HEADROOM_MULTIPLE, 1.2);
  assert.equal(REQUIRED_SURFACED_JOBS, 120_000);
  assert.equal(REQUIRED_SURFACED_GROUPED_ROLES, 11_000);
  assert.equal(GROUPED_ROLE_ALERT_THRESHOLD, 11_000);
  assert.equal(groupedRoleAlertTriggered(11_000), false, 'the threshold itself is healthy');
  assert.equal(groupedRoleAlertTriggered(10_999), true, 'the alert fires before the hard floor');
  assert.equal(groupedRoleAlertTriggered(10_000), true, 'the hard-floor boundary remains alerted');
  assert.equal(boardHealth(120_001, 11_001), 'ok');
  assert.equal(boardHealth(120_000, 11_000), 'ok', 'exactly at both warning lines is healthy');
  assert.equal(boardHealth(119_999, 11_000), 'low', 'posting headroom warns');
  assert.equal(boardHealth(120_000, 10_999), 'low', 'grouped-role headroom warns');
  assert.equal(boardHealth(100_000, 10_000), 'low', 'exactly at both floors is not a breach');
  assert.equal(boardHealth(99_999, 12_000), 'breached', 'postings can breach independently');
  assert.equal(boardHealth(120_000, 9_999), 'breached', 'grouped roles can breach independently');
  assert.equal(boardHealth(0, 0), 'breached');
});

test('supply targets remain above both early warning lines', () => {
  assert.equal(TARGET_SURFACED_POSTINGS, 125_000);
  assert.equal(TARGET_SURFACED_GROUPED_ROLES, 12_000);
  assert.ok(TARGET_SURFACED_POSTINGS > REQUIRED_SURFACED_JOBS);
  assert.ok(TARGET_SURFACED_GROUPED_ROLES > REQUIRED_SURFACED_GROUPED_ROLES);
  assert.equal(inventoryTargetMet(125_000, 12_000), true, 'exactly at both targets passes');
  assert.equal(inventoryTargetMet(124_999, 12_000), false, 'posting target is independent');
  assert.equal(inventoryTargetMet(125_000, 11_999), false, 'grouped-role target is independent');
});

test('a thin board warns without failing the run, so the 5xx keeps meaning "broken now"', () => {
  // Encoded as a property of the two predicates rather than of the route: 'low' must never satisfy
  // boardIsBelowFloor, or the early warning would page someone and the real breach signal would be
  // trained away.
  for (const n of [10_999, 10_500, 10_000]) {
    assert.equal(boardHealth(120_000, n), 'low', String(n));
    assert.ok(n >= MINIMUM_SURFACED_GROUPED_ROLES, `${n} must warn, not 5xx`);
  }
});

test('a board whose postings are all stale is NOT mistaken for a board that returned nothing', () => {
  // The subtle one. The ingest filter drops postings outside the window, so it is tempting to feed
  // the filtered count to the empty-response guard. That would make "the API returned nothing" and
  // "the API returned nothing FRESH" indistinguishable, and the run would refuse to deactivate
  // postings that genuinely aged out - the board would then keep showing them forever.
  // Only the first of those is a fault, so the guard must key off the RAW fetch count.
  const rawFetched = 400;   // the board answered with 400 postings...
  const freshOfThem = 0;    // ...none from the last 14 days
  assert.equal(shouldKeepPostingsOnEmptyFetch(rawFetched, 600), false,
    'a board that answered with postings must still be swept, even if none are fresh');
  assert.equal(shouldKeepPostingsOnEmptyFetch(freshOfThem, 600), true,
    'and a genuinely empty answer must still be protected');
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
  assert.ok(CLOSED_POSTING_RETENTION_DAYS < JOB_FRESHNESS_DAYS,
    'a closed posting must not outlive the window it could have been shown in');
});

test('the purge keeps a full window of slack, so it cannot fight the poller', () => {
  // Reads the constant the purge query actually uses. An earlier version of this test recomputed
  // JOB_FRESHNESS_DAYS * 2 locally, which meant changing the query to purge at the boundary kept the
  // test green - it was asserting its own arithmetic rather than the code's.
  assert.ok(PURGE_POSTINGS_OLDER_THAN_DAYS > JOB_FRESHNESS_DAYS,
    'purging at or inside the window churns rows the poller keeps restoring');
  // 180, because the slack is a full window and the window is now 90. This is the storage cost of
  // the longer board window, pinned as a number so it is noticed rather than inferred.
  assert.equal(PURGE_POSTINGS_OLDER_THAN_DAYS, 180);
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

test('internships get a window twice the board\'s, and the purge honours it', async () => {
  const {
    INTERNSHIP_FRESHNESS_DAYS,
    PURGE_INTERNSHIPS_OLDER_THAN_DAYS,
    JOB_FRESHNESS_DAYS: boardWindow,
  } = await import('./jobMonitor');
  assert.equal(INTERNSHIP_FRESHNESS_DAYS, 180);
  /* STRICTLY longer, which is the whole reason the branch exists. It briefly was not: the board
     window moved 14 -> 90 on 2026-08-26 while this still read 90, and for those minutes the branch
     admitted nothing the general one did not. 180 restored the gap. If a later change makes these
     equal again, this line should fail rather than quietly pass - an inert branch reads like a rule
     that is being enforced. */
  assert.ok(INTERNSHIP_FRESHNESS_DAYS > boardWindow, 'the whole point is that it is longer');

  /* The purge must keep a full internship window of slack, exactly as the board window does.
     Purging internships on the BOARD's schedule would delete the row nightly and re-fetch it each
     morning, so the 90 would be true in the read path and false in production. */
  assert.equal(PURGE_INTERNSHIPS_OLDER_THAN_DAYS, INTERNSHIP_FRESHNESS_DAYS * 2);

  const source = readFileSync('src/routes/jobMonitor.ts', 'utf8');
  /* Enforced in all THREE places or it is enforced in none: the read predicate, the ingest gate,
     and the purge. An internship the poll refuses to store cannot be shown by any read window. */
  assert.ok(/freshnessPredicate[\s\S]{0,600}INTERNSHIP_FRESHNESS_DAYS/.test(source), 'read path');
  assert.ok(/internshipCutoff/.test(source), 'ingest gate');
  assert.ok(/PURGE_INTERNSHIPS_OLDER_THAN_DAYS/.test(source), 'purge');
  /* Untyped postings are the majority of the board (Greenhouse states no type) and `ne` does not
     match NULL, so a two-branch purge would leave every untyped row immortal. */
  assert.ok(/isNull\(monitored_jobs\.employment_type\)/.test(source), 'the NULL branch of the purge');
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
