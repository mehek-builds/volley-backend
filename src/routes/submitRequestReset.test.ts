/* "I LOOKED AND IT IS NOT THERE" IS TRUE ABOUT ONE ATTEMPT, NOT ABOUT THE PACKET.
 *
 * `POST /applications/:id/submission/unverified` is the only exit from a cut-off submit: the
 * applicant checks the portal, answers found or not-found, and a not-found releases the packet to
 * run again. The route's comment says it is "re-runnable exactly once".
 *
 * Nothing made that true. The resolution was written to the row and never cleared, so:
 *
 *   run 1 is cut off mid-submit          -> unverified_submission, claim held
 *   she answers "not there"              -> resolution: 'not_sent', claim released
 *   run 2 dies on a non-timeout error    -> needs_attention, claim held again
 *   submitRequestDisposition reads the STALE 'not_sent' and returns 'start'
 *
 * and from then on the post-click duplicate lock is off for that posting permanently, after one
 * honest answer. Deepgram refuses a third application inside 60 days and a re-apply to the same role
 * inside 180; Skydio allows one per role per 90 days. This is the guard that has to hold.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { freshSubmitRequestReview } from './applications';
import { submitRequestDisposition } from '../lib/submissionSafety';
import type { ApplicationReviewState } from '../lib/applicationReview';

const RESOLVED_NOT_SENT: ApplicationReviewState = {
  status: 'needs_attention',
  updated_at: '2026-08-09T12:00:00.000Z',
  unverified_submission: {
    at: '2026-08-09T11:00:00.000Z',
    cause: 'run_timeout',
    resolution: 'not_sent',
    resolved_at: '2026-08-09T11:30:00.000Z',
  },
} as unknown as ApplicationReviewState;

describe('a re-run starts from a clean slate', () => {
  test('the resolved unverified record does not survive into the next attempt', () => {
    const next = freshSubmitRequestReview(RESOLVED_NOT_SENT, []);
    assert.equal(next.unverified_submission, undefined);
  });

  test('and so the next uncertain run is locked, not waved through', () => {
    // Exactly the sequence above: the second run ends claimed and uncertain. With the stale answer
    // still on the row this returned 'start'.
    const carried = freshSubmitRequestReview(RESOLVED_NOT_SENT, []);
    const disposition = submitRequestDisposition(
      'needs_attention',
      true,
      (carried.unverified_submission as { resolution?: string } | undefined)?.resolution as never,
    );
    assert.equal(disposition, 'reject');
  });

  test('the one legitimate release still works, so this has not sealed the only exit', () => {
    // The answer is honoured for the run it was given about. That is the case the route exists for.
    assert.equal(submitRequestDisposition('needs_attention', true, 'not_sent'), 'start');
  });

  test('a claimed uncertain packet with no answer stays blocked', () => {
    assert.equal(submitRequestDisposition('needs_attention', true), 'reject');
  });
});
