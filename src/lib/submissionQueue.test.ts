import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SUBMISSION_BATCH_TIME_BUDGET_MS,
  autoRunShouldPrepare,
  dailySubmissionCap,
  hasTimeForAnotherApplication,
  submissionBatchSize,
  withinDailyCap,
} from './submissionQueue';

const env = (values: Record<string, string> = {}) => values as unknown as NodeJS.ProcessEnv;

test('an auto-submittable portal is prepared with or without standing consent', () => {
  assert.equal(autoRunShouldPrepare({ canAutoSubmit: true, standingConsentEnabled: true }), true);
  assert.equal(autoRunShouldPrepare({ canAutoSubmit: true, standingConsentEnabled: false }), true);
});

test('an unattended run spends nothing on a portal it could never submit', () => {
  assert.equal(autoRunShouldPrepare({ canAutoSubmit: false, standingConsentEnabled: true }), false);
});

test('fill-and-hand-off survives for a user who is there to finish it', () => {
  assert.equal(autoRunShouldPrepare({ canAutoSubmit: false, standingConsentEnabled: false }), true);
});

test('the batch starts another application inside its time budget and stops at it', () => {
  assert.equal(hasTimeForAnotherApplication(0), true);
  assert.equal(hasTimeForAnotherApplication(SUBMISSION_BATCH_TIME_BUDGET_MS - 1), true);
  assert.equal(hasTimeForAnotherApplication(SUBMISSION_BATCH_TIME_BUDGET_MS), false);
});

test('the time budget leaves headroom under the 300s function limit', () => {
  assert.ok(SUBMISSION_BATCH_TIME_BUDGET_MS < 300_000);
});

test('the daily cap allows up to the cap and not past it', () => {
  assert.equal(withinDailyCap(0, 40), true);
  assert.equal(withinDailyCap(39, 40), true);
  assert.equal(withinDailyCap(40, 40), false);
  assert.equal(withinDailyCap(41, 40), false);
});

test('the defaults sit well above the old two-per-day ceiling', () => {
  assert.ok(submissionBatchSize(env()) > 2);
  assert.ok(dailySubmissionCap(env()) > 2);
});

test('both limits read an env override', () => {
  assert.equal(submissionBatchSize(env({ SUBMISSION_BATCH_SIZE: '25' })), 25);
  assert.equal(dailySubmissionCap(env({ DAILY_SUBMISSION_CAP: '100' })), 100);
});

test('junk in the env falls back instead of dropping a limit to zero', () => {
  assert.equal(submissionBatchSize(env({ SUBMISSION_BATCH_SIZE: '0' })), 12);
  assert.equal(dailySubmissionCap(env({ DAILY_SUBMISSION_CAP: 'lots' })), 40);
  assert.equal(dailySubmissionCap(env({ DAILY_SUBMISSION_CAP: '-5' })), 40);
});
