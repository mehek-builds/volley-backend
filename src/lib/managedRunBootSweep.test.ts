/* THE AGE FLOOR: item 1 of the second-reviewer pass on #978. Nothing here touches a database - the
 * two DB-backed orchestration functions (findOrphanedManagedRunCandidates, runManagedRunBootSweep)
 * are exercised structurally by tsc and by the round-2 dry-run described in the PR body, same as
 * before. What IS newly a pure function, and fully testable without one, is the floor itself:
 * orphanedManagedRunCandidateIsOldEnough, which is the guard a zero-downtime Railway rollout needs
 * that a purely single-instance hard-cutover deploy did not.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MANAGED_PREPARE_FILL_DEADLINE_MS } from './browserbase';
import {
  MANAGED_RUN_BOOT_SWEEP_AGE_FLOOR_MS,
  MANAGED_RUN_BOOT_SWEEP_DELAY_MS,
  orphanedManagedRunCandidateIsOldEnough,
} from './managedRunBootSweep';

describe('MANAGED_RUN_BOOT_SWEEP_AGE_FLOOR_MS', () => {
  test('is MANAGED_PREPARE_FILL_DEADLINE_MS plus a one-minute margin - 8 minutes total', () => {
    assert.equal(MANAGED_RUN_BOOT_SWEEP_AGE_FLOOR_MS, MANAGED_PREPARE_FILL_DEADLINE_MS + 60_000);
    assert.equal(MANAGED_RUN_BOOT_SWEEP_AGE_FLOOR_MS, 480_000, 'pinned: 480_000ms (8 minutes)');
  });

  test('is far short of the three-hour stalled-fill-run bound it is not trying to replace', () => {
    const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
    assert.ok(MANAGED_RUN_BOOT_SWEEP_AGE_FLOOR_MS < THREE_HOURS_MS / 10);
  });
});

describe('MANAGED_RUN_BOOT_SWEEP_DELAY_MS', () => {
  test('is a short, positive delay - long enough to matter, short enough not to stall recovery', () => {
    assert.ok(MANAGED_RUN_BOOT_SWEEP_DELAY_MS > 0);
    assert.ok(MANAGED_RUN_BOOT_SWEEP_DELAY_MS < MANAGED_RUN_BOOT_SWEEP_AGE_FLOOR_MS,
      'the courtesy delay before the sweep runs must not by itself approach the age floor - the ' +
      'floor is the actual safety net, not the delay');
  });
});

describe('orphanedManagedRunCandidateIsOldEnough', () => {
  const FROZEN_AT = '2026-09-05T00:00:00.000Z';
  const FROZEN_MS = Date.parse(FROZEN_AT);

  test('refuses a candidate whose last activity is exactly at the floor - strictly less than, not less-or-equal', () => {
    /* Same edge convention as stalledFillRunIsReleasable's own `lastActivityAt + boundMs < now`:
     * the instant the floor is reached is still refused, one millisecond later is admitted. */
    assert.equal(
      orphanedManagedRunCandidateIsOldEnough(
        { updated_at: FROZEN_AT, progress_updated_at: null },
        FROZEN_MS + MANAGED_RUN_BOOT_SWEEP_AGE_FLOOR_MS,
      ),
      false,
    );
    assert.equal(
      orphanedManagedRunCandidateIsOldEnough(
        { updated_at: FROZEN_AT, progress_updated_at: null },
        FROZEN_MS + MANAGED_RUN_BOOT_SWEEP_AGE_FLOOR_MS + 1,
      ),
      true,
    );
  });

  test('refuses a candidate written seconds ago - the exact shape a zero-downtime overlap produces', () => {
    assert.equal(
      orphanedManagedRunCandidateIsOldEnough(
        { updated_at: FROZEN_AT, progress_updated_at: FROZEN_AT },
        FROZEN_MS + 5_000,
      ),
      false,
      'a row written 5s ago must not be released - it reads exactly like an old instance still draining',
    );
  });

  test('admits a candidate silent for three hours, same as it always would have been', () => {
    assert.equal(
      orphanedManagedRunCandidateIsOldEnough(
        { updated_at: FROZEN_AT, progress_updated_at: null },
        FROZEN_MS + 3 * 60 * 60 * 1000,
      ),
      true,
    );
  });

  test('takes the LATER of updated_at and progress_updated_at, same polarity as stalledFillRunLastActivityAt', () => {
    const earlier = FROZEN_AT;
    const later = '2026-09-05T00:05:00.000Z'; // 5 minutes after FROZEN_AT
    const nowMs = Date.parse(later) + MANAGED_RUN_BOOT_SWEEP_AGE_FLOOR_MS; // exactly at the floor from the LATER stamp
    assert.equal(
      orphanedManagedRunCandidateIsOldEnough({ updated_at: earlier, progress_updated_at: later }, nowMs),
      false,
      'must measure from the later (progress_updated_at) stamp, not the earlier updated_at one',
    );
  });

  test('refuses a candidate with neither stamp readable, rather than treating it as infinitely old', () => {
    assert.equal(
      orphanedManagedRunCandidateIsOldEnough(
        { updated_at: null, progress_updated_at: null },
        FROZEN_MS + 3 * 60 * 60 * 1000,
      ),
      false,
      'an unreadable stamp proves nothing about idle time - fail closed, leave it to the three-hour bound',
    );
  });

  test('refuses a candidate whose only stamp fails to parse', () => {
    assert.equal(
      orphanedManagedRunCandidateIsOldEnough(
        { updated_at: 'not a date', progress_updated_at: null },
        FROZEN_MS + 3 * 60 * 60 * 1000,
      ),
      false,
    );
  });

  test('accepts an explicit floorMs override, for a caller that wants to test a different bound', () => {
    assert.equal(
      orphanedManagedRunCandidateIsOldEnough(
        { updated_at: FROZEN_AT, progress_updated_at: null },
        FROZEN_MS + 1000,
        500,
      ),
      true,
      'a 500ms floor is cleared by 1000ms of silence',
    );
  });
});
