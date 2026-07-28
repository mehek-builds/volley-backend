import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JOB_FRESHNESS_DAYS,
  MINIMUM_SURFACED_JOBS,
  REQUIRED_HEADROOM_MULTIPLE,
  REQUIRED_SURFACED_JOBS,
  boardHealth,
  boardIsBelowFloor,
  shouldKeepPostingsOnEmptyFetch,
} from './jobMonitor';
import { AUTONOMOUS_PORTAL_FAMILIES, portalCanAutoSubmit } from '../lib/portalSubmission';
import { POLLABLE_JOB_BOARDS } from '../lib/jobMonitor';

test('the board floor is a thousand surfaced jobs, and it is not a suggestion', () => {
  // Pinned as a value, not just a comparison. If someone "fixes" a breach by lowering the number,
  // this test is what makes that show up as a deliberate edit in a diff rather than a quiet tweak.
  assert.equal(MINIMUM_SURFACED_JOBS, 1_000);
  assert.equal(boardIsBelowFloor(999), true);
  assert.equal(boardIsBelowFloor(1_000), false, 'exactly at the floor is not below it');
  assert.equal(boardIsBelowFloor(1_001), false);
  assert.equal(boardIsBelowFloor(0), true, 'an empty board is the case this exists for');
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

test('the freshness window is seven days, and seven is load-bearing', () => {
  // Not a round number. Hiring is weekday work - measured 2026-07-28, weekdays carried 700-3,500
  // postings a day against Saturday 143 and Sunday 22 - so any window SHORTER than a week changes
  // size with the day it is measured on. A 3-day window read 3,917 on a Tuesday and would hold
  // roughly 2,000 on a Monday, when it spans Sat+Sun+Mon. Seven always contains exactly one
  // Saturday and one Sunday, which is what stops the count swinging.
  assert.equal(JOB_FRESHNESS_DAYS, 7);
  assert.ok(JOB_FRESHNESS_DAYS >= 7, 'a sub-week window is not stable against the weekend dip');
});

test('the headroom target is 5x the floor, and the two are not the same alarm', () => {
  assert.equal(REQUIRED_HEADROOM_MULTIPLE, 5);
  assert.equal(REQUIRED_SURFACED_JOBS, 5_000);
  // Three distinct states. Alarming only at the floor would mean the first warning arrives when
  // the board is already unusable.
  assert.equal(boardHealth(9_664), 'ok', 'the measured launch figure must read healthy');
  assert.equal(boardHealth(5_000), 'ok', 'exactly at the target is not thin');
  assert.equal(boardHealth(4_999), 'low', 'thin: warn, do not page');
  assert.equal(boardHealth(1_000), 'low', 'at the floor exactly is still not a breach');
  assert.equal(boardHealth(999), 'breached');
  assert.equal(boardHealth(0), 'breached');
});

test('a thin board warns without failing the run, so the 5xx keeps meaning "broken now"', () => {
  // Encoded as a property of the two predicates rather than of the route: 'low' must never satisfy
  // boardIsBelowFloor, or the early warning would page someone and the real breach signal would be
  // trained away.
  for (const n of [4_999, 3_000, 1_500, 1_000]) {
    assert.equal(boardHealth(n), 'low', String(n));
    assert.equal(boardIsBelowFloor(n), false, `${n} must warn, not 5xx`);
  }
});
