/* A STOP RECORD MUST NOT SURVIVE THE CLAIM OF THE NEXT RUN.
 *
 * THE CHAIN THIS EXISTS FOR, which review caught after the first version of submission_stop cleared
 * the field inline at three claim sites under a comment claiming there were only three. There are
 * four: POST /applications/:id/submission/extension-start takes the claim over a `...current`
 * spread. What that buys, end to end:
 *
 *   1. A managed run stops pre-click with no_submit_control, which the runner's own comment calls
 *      "the routine outcome on a multi-step first page, not an edge case". Claim released,
 *      before_click:true left on the row. Correct so far.
 *   2. canStartExtensionSubmission says 'start', so she retries through the extension. The claim is
 *      taken and the stale stop survives.
 *   3. She presses Submit in her own browser. The employer now holds the application.
 *   4. The confirmation cannot be read, so extensionOutcomePatch('unknown') writes needs_attention,
 *      keeps the claim, and writes no receipt, no submission_attempted_at, no unverified record and
 *      no submission_error.
 *   5. Nothing on the row contradicts the stale record, so the packet reads as provably-not-sent and
 *      becomes runnable - while its own attention_reason says "Litos clicked Submit".
 *
 * That is a duplicate application at an employer, produced by the field added to prevent one. It is
 * a NEW hole rather than a pre-existing one: without the record the row falls through to the string
 * match over submission_error, which the 'unknown' arm leaves undefined, so the gates refuse.
 *
 * TWO TESTS, ASKING TWO DIFFERENT QUESTIONS. The first drives the real chain with the real functions
 * and proves the semantics. The second ENUMERATES the claim sites, which is a property about the
 * whole codebase that no single behavioural test can establish: a fifth claim site added next month
 * is invisible to any test that only exercises the four that exist today.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import type { ApplicationReviewState } from './applicationReview';
import { classifySubmissionStop, stopReasonPrecedesClick, submissionClaimPatch, submissionStopRecord } from './submissionStop';
import { canStartExtensionSubmission, extensionOutcomePatch } from './extensionSubmission';
import { submissionProvablyNotSent } from './managedSubmitOutcome';
import { submitRequestDisposition } from './submissionSafety';

const AT = '2026-08-11T12:00:00.000Z';

/** A packet stopped pre-click, exactly as submissionFailureReview leaves it: no claim, stop kept. */
function afterPreClickStop(): ApplicationReviewState {
  return {
    jd_text: 'Backend engineer at kos',
    status: 'needs_attention',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: AT,
    portal_url: 'https://jobs.ashbyhq.com/kos/application',
    submission_run_id: 'run-1',
    submission_stop: submissionStopRecord('no_submit_control', AT, 'run-1'),
    attention_reason: 'Litos could not find the button that sends this application.',
  };
}

describe('a stale stop cannot survive into the run that presses Send', () => {
  test('the extension retry after a pre-click stop does not reopen a clicked application', () => {
    const stopped = afterPreClickStop();
    assert.equal(canStartExtensionSubmission(stopped, 'user_initiated', true), 'start',
      'the pre-click stop is genuinely re-runnable, which is what puts her on this path');

    // The claim, written the way the extension-start route writes it: over a spread of the row.
    const claimed: ApplicationReviewState = {
      ...stopped,
      status: 'submitting',
      ...submissionClaimPatch(AT, 'claim-2'),
    };
    assert.equal(claimed.submission_stop, undefined,
      'the previous run stopped before ITS click, which says nothing about the one about to happen');

    // She presses Submit herself and the confirmation cannot be read.
    const unknown: ApplicationReviewState = {
      ...claimed,
      ...extensionOutcomePatch('unknown', AT, { finalUrl: 'https://jobs.ashbyhq.com/kos/application' }),
    };
    assert.match(unknown.attention_reason!, /clicked Submit/,
      'the row itself records that a click happened, which is what makes reopening it unsafe');
    assert.equal(unknown.submission_claimed_at, AT, 'and the outcome keeps the claim');

    assert.equal(submissionProvablyNotSent(unknown), false,
      'nothing here proves a no-send, and absence of evidence is not the proof');
    assert.equal(submitRequestDisposition(unknown.status, true, undefined, unknown), 'reject',
      'the ordinary send path must refuse a packet the employer may already hold');
    assert.equal(canStartExtensionSubmission(unknown, 'user_initiated', true), 'reject',
      'and so must the extension, which is the door she just came through');
  });

  test('the same chain from a captcha stop and from an action-budget stop', () => {
    for (const reason of ['captcha_at_submit', 'action_budget'] as const) {
      const stopped: ApplicationReviewState = {
        ...afterPreClickStop(),
        submission_stop: submissionStopRecord(reason, AT, 'run-1'),
      };
      const claimed: ApplicationReviewState = {
        ...stopped,
        status: 'submitting',
        ...submissionClaimPatch(AT, 'claim-2'),
      };
      const unknown: ApplicationReviewState = {
        ...claimed,
        ...extensionOutcomePatch('unknown', AT, { finalUrl: 'https://x.test' }),
      };
      assert.equal(submissionProvablyNotSent(unknown), false, `${reason} must not reopen a clicked application`);
      assert.equal(submitRequestDisposition(unknown.status, true, undefined, unknown), 'reject', `${reason} must stay locked`);
    }
  });

  test('a genuine pre-click stop is still re-runnable, so the fix is not just "refuse everything"', () => {
    const stopped = afterPreClickStop();
    assert.equal(submissionProvablyNotSent(stopped), true);
    assert.equal(submitRequestDisposition(stopped.status, false, undefined, stopped), 'start');
  });
});

/* THE ENUMERATION, AND WHY THIS ONE READS THE SOURCE.
 *
 * Every other test in this change drives real functions, and that is the right default: a source
 * grep cannot tell a correct branch from a deleted one, and two greps in this repo passed for the
 * whole life of the defects they were guarding. This test asks a question of a different shape.
 * "Does every claim site clear the stop" is a statement about all present and future call sites, and
 * behaviour can only ever demonstrate it for the sites someone remembered to exercise - which is
 * precisely the failure being fixed, since the site that was missed was missed by a human reading
 * the same list. Enumeration is the property under test, so enumeration is what is asserted.
 *
 * It is deliberately narrow: it does not check what the claim does, only that no site writes the
 * claim field by hand instead of going through the one helper that welds the two writes together.
 */
describe('every claim site goes through the one helper', () => {
  const SOURCES = [
    'src/routes/submissionRunner.ts',
    'src/routes/applications.ts',
    'src/lib/extensionSubmission.ts',
    'src/lib/submissionStop.ts',
  ];

  test('no site sets submission_claimed_at to a value outside submissionClaimPatch', async () => {
    const offenders: string[] = [];
    for (const path of SOURCES) {
      const source = await readFile(path, 'utf8');
      source.split('\n').forEach((line, index) => {
        // Only assignments to a real value. Releases write `undefined` and are not claims.
        if (!/^\s*submission_claimed_at:\s*(?!undefined)\S/.test(line)) return;
        // The helper is where the field is legitimately written.
        if (path === 'src/lib/submissionStop.ts') return;
        offenders.push(`${path}:${index + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, [],
      'a claim written by hand does not clear the previous run\'s stop record; spread submissionClaimPatch instead');
  });

  test('and the helper is actually used, so the check above cannot pass by deleting every claim', async () => {
    let uses = 0;
    for (const path of SOURCES.filter((candidate) => candidate !== 'src/lib/submissionStop.ts')) {
      uses += (await readFile(path, 'utf8')).match(/submissionClaimPatch\(/g)?.length ?? 0;
    }
    assert.equal(uses, 6,
      'the six claim sites: claimSubmission, claimSecurityCodeSubmission, extension-start, unsupported email, manual handoff, self-submitted');
  });

  test('the helper clears the stop, which is the whole reason it exists', () => {
    const patch = submissionClaimPatch(AT, 'claim-1');
    assert.equal(patch.submission_claimed_at, AT);
    assert.equal(patch.submission_claim_id, 'claim-1');
    assert.ok('submission_stop' in patch, 'the key must be PRESENT and undefined, so a spread overwrites');
    assert.equal(patch.submission_stop, undefined);
  });
});

/* A drift refusal is structurally ahead of the click: assertVerifiedBuiltPacket runs before
   transportVerifiedBuiltPacket calls transport(), and before the managed send opens a session. It
   was classifying as 'unclassified', which is deliberately NOT pre-click, so the row kept its claim
   and took the unverified exit for a run that never opened a browser. */
test('a packet drift before the send classifies as a pre-click stop', () => {
  const reason = classifySubmissionStop({
    captchaStop: null,
    noSubmitControl: false,
    regenerationRequired: false,
    packetDocumentExpired: false,
    actionBudget: false,
    packetDriftBeforeSend: true,
    confirmationUnproven: false,
    providerSessionFailureBeforeSubmit: false,
    providerSessionFailure: false,
    runTimedOut: false,
    providerUnconfigured: false,
  });
  assert.equal(reason, 'packet_drift_before_send');
  assert.equal(stopReasonPrecedesClick(reason), true);
  assert.equal(submissionStopRecord(reason, '2026-09-02T11:38:20.465Z').before_click, true);
});

/* The run budget and the provider are read from a run that HAPPENED, so they outrank nothing here -
   but a drift stop must never be reported as one of them, because those keep the claim. */
test('a run that timed out is still a timeout even if a drift flag is set', () => {
  assert.equal(classifySubmissionStop({
    captchaStop: null,
    noSubmitControl: false,
    regenerationRequired: false,
    packetDocumentExpired: false,
    actionBudget: false,
    packetDriftBeforeSend: true,
    confirmationUnproven: false,
    providerSessionFailureBeforeSubmit: false,
    providerSessionFailure: false,
    runTimedOut: true,
    providerUnconfigured: false,
  }), 'run_timed_out');
});
