import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { withinDailyCap } from '../lib/submissionQueue';

function orderedReservation(source: string, labels: string[]): void {
  let cursor = -1;
  for (const label of labels) {
    const next = source.indexOf(label, cursor + 1);
    assert.ok(next > cursor, `reservation is missing or misorders ${label}`);
    cursor = next;
  }
}

test('every automatic reservation checks the durable cap under the user lock', () => {
  const runner = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  const claim = runner.slice(
    runner.indexOf('async function claimSubmission('),
    runner.indexOf('export function submissionClaimIsHeld('),
  );
  orderedReservation(claim, [
    'lockSubmissionAttemptUser(tx, row.user_id)',
    'submissionAttemptsOpenedToday(row.user_id, { executor: tx })',
    'withinDailyCap(openedToday, dailySubmissionCap())',
    'tx.update(generated_resumes)',
    "eventKind: 'attempt_opened'",
  ]);

  const security = runner.slice(
    runner.indexOf('async function claimSecurityCodeSubmission('),
    runner.indexOf('async function claimPreparation('),
  );
  orderedReservation(security, [
    'lockSubmissionAttemptUser(tx, row.user_id)',
    'submissionAttemptsOpenedToday(row.user_id, { executor: tx })',
    'withinDailyCap(openedToday, dailySubmissionCap())',
    'tx.update(generated_resumes)',
    "eventKind: 'attempt_opened'",
  ]);

  const applications = readFileSync('src/routes/applications.ts', 'utf8');
  const extension = applications.slice(
    applications.indexOf("'/applications/:id/submission/extension-start'"),
    applications.indexOf("'/applications/:id/submission/extension-outcome'"),
  );
  orderedReservation(extension, [
    'lockSubmissionAttemptUser(tx, userId)',
    'submissionAttemptsOpenedToday(userId, { executor: tx, since: startOfDay })',
    'withinDailyCap(openedToday, dailySubmissionCap())',
    'tx.update(generated_resumes)',
    "appendApplicationAttemptFact(attemptBinding, 'attempt_opened'",
  ]);

  const submitRequest = applications.slice(
    applications.indexOf("'/applications/:id/submit-request'"),
    applications.indexOf("'/applications/:id/submission/channels'"),
  );
  const email = submitRequest.slice(
    submitRequest.indexOf('if (current.portal_url && !isPortalSupported(current.portal_url))'),
    submitRequest.indexOf("const controlledTest = process.env.LITOS_ENABLE_TEST_PORTAL"),
  );
  orderedReservation(email, [
    'lockSubmissionAttemptUser(tx, request.jwtPayload!.userId)',
    'submissionAttemptsOpenedToday(request.jwtPayload!.userId, { executor: tx })',
    'withinDailyCap(openedToday, dailySubmissionCap())',
    'tx.update(generated_resumes)',
    "appendApplicationAttemptFact(attemptBinding, 'attempt_opened'",
  ]);
});

test('two serialized reservations at cap minus one admit exactly one', async () => {
  const cap = 40;
  let opened = cap - 1;
  let held = Promise.resolve();
  const reserve = async (): Promise<boolean> => {
    let release!: () => void;
    const prior = held;
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      if (!withinDailyCap(opened, cap)) return false;
      opened += 1;
      return true;
    } finally {
      release();
    }
  };
  const results = await Promise.all([reserve(), reserve()]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(opened, cap);
});
