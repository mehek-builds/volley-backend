/* THE URGENT RELEASE: A RUN THIS PROCESS KNOWS IS OVER, NOT ONE IT INFERS IS OVER.
 *
 * Modelled directly on stalledFillRunRelease.test.ts's own fixture style. Where that file measures
 * against the Palantir row (a run that went silent and had to be timed out after three hours), this
 * one measures against the Celerant row: run d471dcf1, packet 4b66641d, `filling` since
 * 22:21:47Z with progress_stage "Opening the company form" - one of the two runs measured stranded
 * by a deploy on 2026-09-04, the defect this whole feature answers. The difference this file has to
 * prove is urgency without laxity: restartReleaseIsAdmissible must release that row on THIS SAME
 * INSTANT (bound zero) while refusing every single thing stalledFillRunReleaseIsAdmissible already
 * refused - a claim, a browser session, stored send evidence, a blocked ledger, and above all any
 * status that may already be at the employer boundary.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ApplicationReviewState } from './applicationReview';
import type { SubmissionAttemptRetrySafety } from './submissionAttemptLedger';
import { attentionCategoriesForReasons } from './submissionTerminalCause';
import {
  MANAGED_RUN_RESTART_ATTENTION_REASON,
  releaseManagedRunForRestart,
  restartReleaseIsAdmissible,
} from './managedRunRestartRelease';

const CELERANT_FROZEN_AT = '2026-09-04T22:21:47.000Z';
const CELERANT_FROZEN_MS = Date.parse(CELERANT_FROZEN_AT);
const NO_EVIDENCE: SubmissionAttemptRetrySafety = { kind: 'no_evidence' };

const celerantRow = (over: Partial<ApplicationReviewState> = {}): ApplicationReviewState => ({
  jd_text: 'Software Engineer, Celerant',
  ats_name: 'greenhouse',
  status: 'filling',
  edited_terms: [],
  questions: [],
  skipped_reasons: [],
  updated_at: CELERANT_FROZEN_AT,
  progress_updated_at: CELERANT_FROZEN_AT,
  progress_stage: 'Opening the company form',
  submission_run_id: 'd471dcf1-0000-4000-8000-000000000000',
  run_owner: 'deploy-941:replica-1:11111111-1111-4111-8111-111111111111',
  ...over,
});

describe('MANAGED_RUN_RESTART_ATTENTION_REASON', () => {
  test('classifies to run_failed - the "Litos broke, try again" bucket - and to nothing else', () => {
    assert.deepEqual(attentionCategoriesForReasons([MANAGED_RUN_RESTART_ATTENTION_REASON]), ['run_failed']);
  });

  test('says a restart, not a silent stall - the fact this run actually has, unlike its sibling', () => {
    assert.match(MANAGED_RUN_RESTART_ATTENTION_REASON, /restarted/i);
  });

  test('says nothing reached the employer', () => {
    assert.match(MANAGED_RUN_RESTART_ATTENTION_REASON, /nothing has gone to the employer/i);
  });

  test('offers a next step', () => {
    assert.match(MANAGED_RUN_RESTART_ATTENTION_REASON, /try again/i);
  });
});

describe('restartReleaseIsAdmissible releases immediately, with no elapsed-time wait', () => {
  test('the edge is pinned exactly like the three-hour rule\'s own, just moved to zero', () => {
    /* stalledFillRunIsReleasable's comparison is `lastActivityAt + boundMs < now` - strictly less
     * than, not less-or-equal - and passing boundMs 0 does not change that shape, only the
     * threshold. So the very instant of the last write (now === lastActivityAt) is still refused,
     * and any instant after it - a single millisecond is enough - is admitted. This is the whole
     * of the "immediately" this file's header promises: no THREE-HOUR wait, not no wait at all,
     * because a database-clock read taken inside a real release transaction is definitionally
     * later than the write it is being compared against. */
    assert.equal(restartReleaseIsAdmissible(celerantRow(), NO_EVIDENCE, CELERANT_FROZEN_MS), false);
    assert.equal(restartReleaseIsAdmissible(celerantRow(), NO_EVIDENCE, CELERANT_FROZEN_MS + 1), true);
  });

  test('admits it 500ms later, nowhere near the three-hour bound stalledFillRunReleaseIsAdmissible would require', () => {
    assert.equal(restartReleaseIsAdmissible(celerantRow(), NO_EVIDENCE, CELERANT_FROZEN_MS + 500), true);
  });

  test('preparing is covered as well as filling - the same run, one write earlier', () => {
    const preparing = celerantRow({ status: 'preparing', progress_updated_at: undefined, progress_stage: undefined });
    assert.equal(restartReleaseIsAdmissible(preparing, NO_EVIDENCE, CELERANT_FROZEN_MS + 1), true);
  });

  test('safe_not_sent is admitted, exactly like no_evidence', () => {
    const safeNotSent: SubmissionAttemptRetrySafety = {
      kind: 'safe_not_sent',
      attemptId: '5c8e1b44-2a70-4f36-9d18-6b3ac0f72e91',
      proofKind: 'typed_pre_click_stop',
      resolvedAt: '2026-09-04T20:00:00.000Z',
    };
    assert.equal(restartReleaseIsAdmissible(celerantRow(), safeNotSent, CELERANT_FROZEN_MS + 1), true);
  });
});

describe('boundary rows are untouched, however urgent the caller is', () => {
  test('every status that is not preparing/filling is refused, however little time has passed', () => {
    for (const status of ['submitting', 'submission_claimed', 'ready_for_final_approval',
      'needs_attention', 'submitted', 'failed', 'awaiting_security_code', 'submit_requested'] as const) {
      assert.equal(
        restartReleaseIsAdmissible(celerantRow({ status }), NO_EVIDENCE, CELERANT_FROZEN_MS + 1),
        false,
        `${status} must not be released by the restart rule - the #912 stalled-submitting arm owns any boundary-adjacent row`,
      );
    }
  });

  test('a claimed row is left to the claim rules, immediacy included', () => {
    const claimed = celerantRow({
      submission_claim_id: '2f1a9d20-6c33-4c7e-9a51-8de0f4b62a17',
      submission_claimed_at: CELERANT_FROZEN_AT,
    });
    assert.equal(restartReleaseIsAdmissible(claimed, NO_EVIDENCE, CELERANT_FROZEN_MS + 1), false);
  });

  test('a row holding a provider session is left to the path that owns that session', () => {
    const withSession = celerantRow({ browser_session_id: 'bb-session-9f21' });
    assert.equal(restartReleaseIsAdmissible(withSession, NO_EVIDENCE, CELERANT_FROZEN_MS + 1), false);
  });

  for (const [field, over] of [
    ['submitted_at', { submitted_at: CELERANT_FROZEN_AT }],
    ['submission_attempted_at', { submission_attempted_at: CELERANT_FROZEN_AT }],
    ['receipt', {
      receipt: {
        confirmation_text: 'Thanks for applying',
        final_url: 'https://jobs.greenhouse.io/celerant/thanks',
        captured_at: CELERANT_FROZEN_AT,
      },
    }],
  ] as const) {
    test(`stored send evidence (${field}) refuses the release however little time has passed`, () => {
      assert.equal(
        restartReleaseIsAdmissible(celerantRow(over as Partial<ApplicationReviewState>), NO_EVIDENCE, CELERANT_FROZEN_MS + 1),
        false,
      );
    });
  }

  test('a blocked ledger refuses the release at any age, including almost none', () => {
    for (const reason of ['opened', 'boundary_authorized', 'pressed', 'invalid_sequence'] as const) {
      const blocked: SubmissionAttemptRetrySafety = {
        kind: 'blocked_unverified',
        attemptId: '5c8e1b44-2a70-4f36-9d18-6b3ac0f72e91',
        reason,
        at: CELERANT_FROZEN_AT,
      };
      assert.equal(
        restartReleaseIsAdmissible(celerantRow(), blocked, CELERANT_FROZEN_MS + 1),
        false,
        `blocked_unverified/${reason} must refuse the release`,
      );
    }
  });
});

describe('releaseManagedRunForRestart', () => {
  test('parks the row at needs_attention with no claim, so it is immediately re-runnable', () => {
    const released = releaseManagedRunForRestart(celerantRow(), '2026-09-04T22:30:00.000Z');
    assert.equal(released.status, 'needs_attention');
    assert.equal(released.submission_claimed_at, undefined);
    assert.equal(released.submission_claim_id, undefined);
  });

  test('clears the run identity fields, including run_owner, so nothing looks like a live run', () => {
    const released = releaseManagedRunForRestart(celerantRow());
    assert.equal(released.submission_run_id, undefined);
    assert.equal(released.run_owner, undefined);
    assert.equal(released.progress_stage, undefined);
    assert.equal(released.progress_screenshot_url, undefined);
    assert.equal(released.progress_updated_at, undefined);
    assert.equal(released.handoff_expires_at, undefined);
    assert.equal(released.browser_context_id, undefined);
    assert.equal(released.submission_authorization, undefined);
  });

  test('writes the restart sentence and its derived category onto the row', () => {
    const released = releaseManagedRunForRestart(celerantRow());
    assert.equal(released.attention_reason, MANAGED_RUN_RESTART_ATTENTION_REASON);
    assert.deepEqual(released.attention_categories, ['run_failed']);
  });

  test('stamps the supplied clock, defaulting to the real one when none is given', () => {
    const released = releaseManagedRunForRestart(celerantRow(), '2026-09-04T22:30:00.000Z');
    assert.equal(released.updated_at, '2026-09-04T22:30:00.000Z');
    const defaulted = releaseManagedRunForRestart(celerantRow());
    assert.equal(typeof defaulted.updated_at, 'string');
    assert.ok(Date.parse(defaulted.updated_at) > CELERANT_FROZEN_MS);
  });

  test('leaves the work the dead run already did untouched - filled_fields, questions, the audit', () => {
    const withWork = celerantRow({
      filled_fields: ['email', 'first_name'],
      questions: [{ id: 'q1', question: 'Why us?', answer: 'Because', kind: 'essay', required: true }],
    });
    const released = releaseManagedRunForRestart(withWork);
    assert.deepEqual(released.filled_fields, ['email', 'first_name']);
    assert.equal(released.questions.length, 1);
  });
});
