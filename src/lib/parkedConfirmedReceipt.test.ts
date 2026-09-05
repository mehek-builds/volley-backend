/* THE ROW THAT HOLDS ITS RECEIPT AND CANNOT SAY SO - named exactly, and projected again on read.
 *
 * Fixture: Bear Robotics b822b998 as it stood on 2026-09-05 after its Breezy send: needs_attention,
 * the employer's receipt kept on the row, the claim still on the row, the parked sentence, and the
 * confirmation already in the ledger. */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { describe } from 'node:test';
import type { ApplicationReviewState } from './applicationReview';
import {
  PARKED_CONFIRMED_PROJECTION_REASON,
  PARKED_CONFIRMED_PROJECTION_RETRY_MS,
  parkedConfirmedProjectionMayRetry,
  parkedConfirmedReceipt,
} from './parkedConfirmedReceipt';

const CAPTURED_AT = '2026-09-05T01:50:46.285Z';
const RECEIPT: NonNullable<ApplicationReviewState['receipt']> = {
  confirmation_text: 'Application Submitted Your application has been submitted successfully. Good luck!',
  final_url: 'https://bear-robotics.breezy.hr/p/b8d4995f6d23-software-engineering-intern-developer-productivity/apply/submitted',
  captured_at: CAPTURED_AT,
  source: 'managed_browser',
};

function bearParked(extra: Partial<ApplicationReviewState> = {}): ApplicationReviewState {
  return {
    jd_text: 'Software Engineering Intern, Developer Productivity',
    status: 'needs_attention',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: CAPTURED_AT,
    portal_url: 'https://bear-robotics.breezy.hr/p/b8d4995f6d23-software-engineering-intern-developer-productivity',
    ats_name: 'breezy',
    submission_run_id: '09dbd4fa-5492-4892-8cc3-a442c239f764',
    submission_claimed_at: '2026-09-05T01:50:35.102Z',
    submission_claim_id: '28f6cd3b-13bc-41c5-ac57-76fa2ef46a2b',
    receipt: RECEIPT,
    verification: { status: 'not_needed' },
    attention_reason: PARKED_CONFIRMED_PROJECTION_REASON,
    attention_categories: ['unverified_submission'],
    unverified_submission: {
      at: CAPTURED_AT,
      cause: 'no_confirmation_state',
      portal_url: 'https://bear-robotics.breezy.hr/p/b8d4995f6d23-software-engineering-intern-developer-productivity',
      submission_run_id: '09dbd4fa-5492-4892-8cc3-a442c239f764',
    },
    ...extra,
  };
}

describe('the parked receipt is named exactly', () => {
  test('Bear Robotics b822b998 is the shape', () => {
    assert.deepEqual(parkedConfirmedReceipt(bearParked()), {
      claimId: '28f6cd3b-13bc-41c5-ac57-76fa2ef46a2b',
      receipt: RECEIPT,
    });
  });

  test('every other parked row is left alone', () => {
    assert.equal(parkedConfirmedReceipt(bearParked({ status: 'submitted', submitted_at: CAPTURED_AT })), null, 'already projected');
    assert.equal(parkedConfirmedReceipt(bearParked({ receipt: undefined })), null, 'a press with no receipt is the unverified question, not this one');
    assert.equal(parkedConfirmedReceipt(bearParked({ submission_claim_id: undefined })), null, 'no claim, no exact attempt to project');
    assert.equal(
      parkedConfirmedReceipt(bearParked({ attention_reason: 'Employer verification is pending in the retained managed session' })),
      null,
      'a different sentence is a different stop',
    );
    assert.equal(
      parkedConfirmedReceipt(bearParked({
        unverified_submission: { at: CAPTURED_AT, cause: 'no_confirmation_state', resolution: 'not_sent', resolved_at: CAPTURED_AT },
      })),
      null,
      'her own answer stands',
    );
    assert.equal(
      parkedConfirmedReceipt(bearParked({ receipt: { ...RECEIPT, source: 'attended_handoff' } })),
      null,
      'only the runner’s own receipt is re-projected by the runner’s own commit',
    );
  });

  test('a parked row rests between re-projections', () => {
    const last = Date.parse(CAPTURED_AT);
    assert.equal(parkedConfirmedProjectionMayRetry(bearParked(), last + 2_500), false, 'the next poll does not write again');
    assert.equal(parkedConfirmedProjectionMayRetry(bearParked(), last + PARKED_CONFIRMED_PROJECTION_RETRY_MS), true);
    assert.equal(parkedConfirmedProjectionMayRetry(bearParked({ updated_at: 'not a date' }), last), true);
  });
});

describe('the runner and the read use the same shape', () => {
  test('the runner parks with the sentence this file owns, and the read projects that shape again', async () => {
    const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
    assert.match(runner, /attention_reason: PARKED_CONFIRMED_PROJECTION_REASON,/);
    assert.doesNotMatch(runner, /its saved application projection/, 'the sentence lives in one place');
    const repair = runner.slice(runner.indexOf('export async function repairParkedConfirmedProjection('));
    const body = repair.slice(0, repair.indexOf('\n}\n'));
    assert.match(body, /parkedConfirmedReceipt\(review\)/);
    assert.match(body, /parkedConfirmedProjectionMayRetry\(review, now\(\)\)/);
    assert.match(body, /event\.event_kind === 'boundary_authorized'/);
    assert.match(body, /event\.event_kind === 'press_observed'/);
    assert.match(body, /submissionAttemptEventId\(parked\.claimId, 'submission_confirmed', 'managed-receipt'\)/);
    assert.match(body, /commitVerifiedSubmissionConfirmed\(row, attemptBinding, \{/);
    assert.match(body, /factKey: 'managed-receipt',/);
    assert.match(body, /const evidenceCode = confirmation\.evidence_code;/);
    assert.match(body, /evidenceCode,\n\s*\}\);/);
    const routes = await readFile('src/routes/applications.ts', 'utf8');
    const read = routes.slice(routes.indexOf("'/applications/:id/submission',"));
    const readBody = read.slice(0, read.indexOf('return reply.send({'));
    const claimRepair = readBody.indexOf('repairExpiredAttendedHandoffClaim(row');
    const parkedRepair = readBody.indexOf('repairParkedConfirmedProjection(row, request.log)');
    assert.ok(claimRepair >= 0 && parkedRepair > claimRepair, 'the second projection runs on the read, after the claim repair');
    assert.match(readBody, /if \(parkedRepair\.kind === 'repaired'\) row = parkedRepair\.row;/);
    assert.match(read, /projection_repair_reasons: parkedRepair\.reasons/);
  });
});
