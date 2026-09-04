/* THE FILL RUN THAT DIED WITHOUT WRITING A TERMINAL STATE.
 *
 * MEASURED LIVE 2026-09-04, account mehekmandal05@gmail.com. Palantir (lever), packet
 * f1cfb841-7a59-4314-9ef1-84581ccb373a, created that morning and never sent. A managed fill run
 * started, stopped, and left the row at `filling` with submission_claimed_at null, no ledger
 * attempt at all (`retry_safety: no_evidence`) and updated_at frozen at 06:53:50.899Z. The cron
 * selects `submit_requested` and `submitting` only, submitRequestDisposition answers `in_flight`
 * for `filling` unconditionally, and repairExpiredAttendedHandoffClaim's precondition refuses a
 * claimless row on its first line, so nothing anywhere could move it again.
 *
 * WHAT THESE TESTS ASSERT, AND WHAT THEY REFUSE TO. They do not assert "a filling row comes off".
 * The risk of adding this arm is that a poll tears down a fill that is merely slow, and a live
 * managed fill carries byte-for-byte the evidence this dead one carries. So every release below is
 * gated on elapsed time AND on the ledger's own packet projection proving nothing reached an
 * employer, and the live-run, claimed, session-holding and ledger-blocked cases are pinned beside
 * them so a future change cannot loosen one without breaking the other.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { ApplicationReviewState } from './applicationReview';
import type { SubmissionAttemptRetrySafety } from './submissionAttemptLedger';
import {
  STALLED_FILL_RUN_ATTENTION_REASON,
  STALLED_FILL_RUN_RELEASE_MS,
  releaseStalledFillRun,
  stalledFillRunIsReleasable,
  stalledFillRunLastActivityAt,
  stalledFillRunLedgerProvesNoEmployerContact,
  stalledFillRunReleaseIsAdmissible,
} from './stalledFillRunRelease';
import { submitRequestDisposition } from './submissionSafety';
import { attentionCategoriesForReasons } from './submissionTerminalCause';

/** The measured Palantir stamps. The run wrote its last progress frame and then said nothing. */
const PALANTIR_FROZEN_AT = '2026-09-04T06:53:50.899Z';
const PALANTIR_FROZEN_MS = Date.parse(PALANTIR_FROZEN_AT);
const NO_EVIDENCE: SubmissionAttemptRetrySafety = { kind: 'no_evidence' };

const stalledRow = (over: Partial<ApplicationReviewState> = {}): ApplicationReviewState => ({
  jd_text: 'Software Engineer, Palantir',
  ats_name: 'lever',
  status: 'filling',
  edited_terms: [],
  questions: [],
  skipped_reasons: [],
  updated_at: PALANTIR_FROZEN_AT,
  progress_updated_at: PALANTIR_FROZEN_AT,
  progress_stage: 'Filling your answers',
  submission_run_id: 'cd12b343-a0af-4ea4-b43a-232a55faa58e',
  ...over,
});

/** Any instant strictly past the bound, and the instant one millisecond before it. */
const PAST_BOUND = PALANTIR_FROZEN_MS + STALLED_FILL_RUN_RELEASE_MS + 1;
const AT_BOUND = PALANTIR_FROZEN_MS + STALLED_FILL_RUN_RELEASE_MS;

describe('the measured Palantir row', () => {
  test('is exactly the shape the live packet had: filling, no claim, nothing attempted', () => {
    const row = stalledRow();
    assert.equal(row.status, 'filling');
    assert.equal(row.submission_claimed_at, undefined);
    assert.equal(row.submission_claim_id, undefined);
    assert.equal(row.submission_attempted_at, undefined);
    assert.equal(row.submitted_at, undefined);
    assert.equal(row.receipt, undefined);
    assert.equal(row.unverified_submission, undefined);
  });

  test('was unreachable before this rule: every re-run route answered in_flight', () => {
    /* The trap itself, pinned so the fix cannot be mistaken for a change to this answer. The
     * disposition is deliberately NOT loosened - `filling` still means in_flight - and what the
     * release buys is that the row stops being `filling`. */
    assert.equal(submitRequestDisposition('filling'), 'in_flight');
    assert.equal(submitRequestDisposition('preparing'), 'in_flight');
  });

  test('is released once the bound has passed', () => {
    assert.equal(stalledFillRunReleaseIsAdmissible(stalledRow(), NO_EVIDENCE, PAST_BOUND), true);
  });

  test('is NOT released while it could still be a live fill', () => {
    assert.equal(
      stalledFillRunReleaseIsAdmissible(stalledRow(), NO_EVIDENCE, PALANTIR_FROZEN_MS + 60_000),
      false,
    );
  });

  test('the edge is pinned in both directions, so the polarity cannot be flipped silently', () => {
    assert.equal(stalledFillRunIsReleasable(stalledRow(), AT_BOUND), false);
    assert.equal(stalledFillRunIsReleasable(stalledRow(), AT_BOUND + 1), true);
  });

  test('the release buys a restart, which is the only reason to do it at all', () => {
    /* The property that matters. A release that left the packet unsendable would be pure
     * churn: submitRequestDisposition has to answer `start` for the row this produces, and it
     * does so for an UNCLAIMED needs_attention row, which is why the release must not invent a
     * claim. */
    const released = releaseStalledFillRun(stalledRow(), '2026-09-04T10:00:00.000Z');
    assert.equal(released.status, 'needs_attention');
    assert.equal(released.submission_claimed_at, undefined);
    assert.equal(released.submission_claim_id, undefined);
    assert.equal(
      submitRequestDisposition(released.status, Boolean(released.submission_claimed_at)),
      'start',
    );
  });
});

describe('a run that might still be executing is never torn down', () => {
  test('a claimed row belongs to the claim rules, not to this one, however old it is', () => {
    /* claimSubmission writes submission_claim_id and appends attempt_opened in ONE transaction, so
     * a claim means an attempt exists and the employer boundary is in play. That row is
     * repairExpiredAttendedHandoffClaim's, and after #912 the stalled-submitting arm's. Two rules
     * releasing one row is how a guard gets routed around without anyone editing it. */
    const claimed = stalledRow({
      submission_claim_id: '2f1a9d20-6c33-4c7e-9a51-8de0f4b62a17',
      submission_claimed_at: PALANTIR_FROZEN_AT,
    });
    assert.equal(stalledFillRunIsReleasable(claimed, PAST_BOUND), false);
    assert.equal(
      stalledFillRunIsReleasable(stalledRow({ submission_claimed_at: PALANTIR_FROZEN_AT }), PAST_BOUND),
      false,
    );
  });

  test('a row holding a provider session is left to the path that owns that session', () => {
    /* prepareManaged writes browser_session_id undefined; only the direct/attended path stores one,
     * and it has a real session preparedRunHandoffExpired can still ask about. Clearing the id
     * would orphan the resource browserProviderResourceCleanup is holding. */
    assert.equal(
      stalledFillRunIsReleasable(stalledRow({ browser_session_id: 'bb-session-9f21' }), PAST_BOUND),
      false,
    );
  });

  test('a status the pipeline is not stuck in is refused', () => {
    for (const status of ['submitting', 'submission_claimed', 'ready_for_final_approval',
      'needs_attention', 'submitted', 'failed', 'awaiting_security_code', 'submit_requested'] as const) {
      assert.equal(
        stalledFillRunIsReleasable(stalledRow({ status }), PAST_BOUND),
        false,
        `${status} must not be released by the stalled-fill rule`,
      );
    }
  });

  test('preparing is covered as well as filling: the same death, one write earlier', () => {
    /* claimPreparation writes `preparing` and no progress stamp; prepare() then writes `filling`.
     * A process that dies between them leaves `preparing`, which the cron selector, the runner
     * step and submitRequestDisposition all treat exactly as they treat `filling`. */
    const preparing = stalledRow({ status: 'preparing', progress_updated_at: undefined, progress_stage: undefined });
    assert.equal(stalledFillRunIsReleasable(preparing, PAST_BOUND), true);
  });
});

describe('stored send evidence vetoes, one field at a time', () => {
  /* Each of these is written by a path that runs after a claim, so its presence on a claimless
   * `filling` row means the row is not the shape this rule was measured on. The honest answer is to
   * leave it alone rather than to reason about how it got there. */
  const evidence: Array<[string, Partial<ApplicationReviewState>]> = [
    ['submitted_at', { submitted_at: '2026-09-04T06:55:00.000Z' }],
    ['submission_attempted_at', { submission_attempted_at: '2026-09-04T06:55:00.000Z' }],
    ['receipt', {
      receipt: {
        confirmation_text: 'Thanks for applying',
        final_url: 'https://jobs.lever.co/palantir/thanks',
        captured_at: PALANTIR_FROZEN_AT,
      },
    }],
    ['security_code', {
      security_code: { requested_at: PALANTIR_FROZEN_AT } as unknown as ApplicationReviewState['security_code'],
    }],
    ['unverified_submission', {
      unverified_submission: {
        at: PALANTIR_FROZEN_AT,
        cause: 'run_timed_out',
      } as ApplicationReviewState['unverified_submission'],
    }],
  ];
  for (const [field, over] of evidence) {
    test(`${field} refuses the release`, () => {
      assert.equal(stalledFillRunIsReleasable(stalledRow(over), PAST_BOUND), false);
    });
  }
});

describe('the ledger proof is the safety half and is never relaxed', () => {
  test('no_evidence and safe_not_sent are admitted, and they are the same two the send gate admits', () => {
    assert.equal(stalledFillRunLedgerProvesNoEmployerContact(NO_EVIDENCE), true);
    assert.equal(
      stalledFillRunLedgerProvesNoEmployerContact({
        kind: 'safe_not_sent',
        attemptId: '5c8e1b44-2a70-4f36-9d18-6b3ac0f72e91',
        proofKind: 'typed_pre_click_stop',
        resolvedAt: '2026-09-03T11:00:00.000Z',
      }),
      true,
    );
  });

  test('a blocked_unverified attempt refuses the release at any age', () => {
    /* An attempt that authorized the boundary, or was observed pressed, is durable employer risk.
     * The clock says nothing about that and must never be allowed to out-argue it. */
    for (const reason of ['opened', 'boundary_authorized', 'pressed', 'invalid_sequence'] as const) {
      const blocked: SubmissionAttemptRetrySafety = {
        kind: 'blocked_unverified',
        attemptId: '5c8e1b44-2a70-4f36-9d18-6b3ac0f72e91',
        at: PALANTIR_FROZEN_AT,
        reason,
      };
      assert.equal(stalledFillRunLedgerProvesNoEmployerContact(blocked), false);
      assert.equal(
        stalledFillRunReleaseIsAdmissible(stalledRow(), blocked, PAST_BOUND + 365 * 24 * 3600_000),
        false,
        `blocked_unverified/${reason} must keep blocking`,
      );
    }
  });

  test('a confirmed submission refuses the release at any age', () => {
    const confirmed: SubmissionAttemptRetrySafety = {
      kind: 'blocked_confirmed',
      attemptId: '5c8e1b44-2a70-4f36-9d18-6b3ac0f72e91',
      confirmedAt: PALANTIR_FROZEN_AT,
    };
    assert.equal(stalledFillRunLedgerProvesNoEmployerContact(confirmed), false);
    assert.equal(stalledFillRunReleaseIsAdmissible(stalledRow(), confirmed, PAST_BOUND), false);
  });

  test('neither half implies the other, so both are required', () => {
    // Ledger clear, clock not yet: refused.
    assert.equal(
      stalledFillRunReleaseIsAdmissible(stalledRow(), NO_EVIDENCE, PALANTIR_FROZEN_MS + 1000),
      false,
    );
    // Clock past, ledger blocked: refused.
    assert.equal(
      stalledFillRunReleaseIsAdmissible(stalledRow(), {
        kind: 'blocked_unverified',
        attemptId: '5c8e1b44-2a70-4f36-9d18-6b3ac0f72e91',
        at: PALANTIR_FROZEN_AT,
        reason: 'opened',
      }, PAST_BOUND),
      false,
    );
  });
});

describe('the clock is read off the run, and taking the later stamp can only delay a release', () => {
  test('the later of updated_at and progress_updated_at wins', () => {
    const later = '2026-09-04T08:00:00.000Z';
    assert.equal(
      stalledFillRunLastActivityAt({ updated_at: PALANTIR_FROZEN_AT, progress_updated_at: later }),
      Date.parse(later),
    );
    assert.equal(
      stalledFillRunLastActivityAt({ updated_at: later, progress_updated_at: PALANTIR_FROZEN_AT }),
      Date.parse(later),
    );
  });

  test('a missing progress stamp falls back to updated_at rather than to null', () => {
    assert.equal(
      stalledFillRunLastActivityAt({ updated_at: PALANTIR_FROZEN_AT, progress_updated_at: undefined }),
      PALANTIR_FROZEN_MS,
    );
  });

  test('an unparsable pair answers null, and null refuses the release', () => {
    assert.equal(
      stalledFillRunLastActivityAt({ updated_at: 'not a date', progress_updated_at: undefined }),
      null,
    );
    assert.equal(
      stalledFillRunIsReleasable(stalledRow({ updated_at: 'not a date', progress_updated_at: undefined }), PAST_BOUND),
      false,
    );
  });

  test('a fresh progress frame under a stale updated_at keeps a working run alive', () => {
    /* The direction that matters: a run still writing progress is never torn down because some
     * other stamp is old. */
    const working = stalledRow({
      updated_at: PALANTIR_FROZEN_AT,
      progress_updated_at: new Date(PAST_BOUND - 1000).toISOString(),
    });
    assert.equal(stalledFillRunIsReleasable(working, PAST_BOUND), false);
  });
});

describe('the released review', () => {
  const released = releaseStalledFillRun(stalledRow(), '2026-09-04T10:00:00.000Z');

  test('says what actually happened and files under the bucket that offers a retry', () => {
    assert.equal(released.attention_reason, STALLED_FILL_RUN_ATTENTION_REASON);
    /* The category is derived, not asserted by hand: the sentence has to contain the clause
     * attentionCategoriesForReasons matches, or the packet lands in a bucket with no next step. */
    assert.deepEqual(released.attention_categories, ['run_failed']);
    assert.deepEqual(attentionCategoriesForReasons([STALLED_FILL_RUN_ATTENTION_REASON]), ['run_failed']);
  });

  test('never claims an application reached the employer', () => {
    assert.match(released.attention_reason!, /Nothing has gone to the employer/);
    assert.equal(released.submitted_at, undefined);
    assert.equal(released.submission_attempted_at, undefined);
  });

  test('clears the dead run\'s transient fields and keeps the work it finished', () => {
    assert.equal(released.submission_run_id, undefined);
    assert.equal(released.progress_stage, undefined);
    assert.equal(released.progress_updated_at, undefined);
    assert.equal(released.progress_screenshot_url, undefined);
    // The questions, the edited terms and the packet audit are the dead run's OUTPUT, not its
    // scaffolding, and a restart must not have to re-derive them.
    assert.deepEqual(released.questions, []);
    assert.equal(released.jd_text, 'Software Engineer, Palantir');
  });

  test('is idempotent: the released row is no longer this rule\'s to release', () => {
    assert.equal(stalledFillRunIsReleasable(released, PAST_BOUND), false);
    assert.equal(stalledFillRunReleaseIsAdmissible(released, NO_EVIDENCE, PAST_BOUND), false);
  });
});

/* ---- The route actually runs the repair, and runs the composed gate rather than a copy of it ---- */

const applications = readFileSync('src/routes/applications.ts', 'utf8');

function routeSlice(start: string, end: string): string {
  const from = applications.indexOf(start);
  const to = applications.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `route slice ${start} was not found`);
  return applications.slice(from, to);
}

describe('the route', () => {
  test('repairs the stalled fill before submitRequestDisposition reads the row', () => {
    const route = routeSlice("'/applications/:id/submit-request'", 'const duplicateVerdict');
    const repair = route.indexOf('repairStalledFillRun(row');
    const gate = route.indexOf('submitRequestDisposition(');
    assert.ok(repair >= 0, 'submit-request must attempt the release');
    assert.ok(gate > repair, 'the release must run before the disposition reads the row');
  });

  test('repairs the stalled fill on the dashboard poll, so the packet frees itself', () => {
    /* Without this the release would need somebody to press the very control the trap disables.
     * GET /applications/:id/submission is the 2.5s poll the review screen already makes. */
    const route = routeSlice("'/applications/:id/submission'", "'/applications/:id/submission/approve'");
    assert.ok(route.indexOf('repairStalledFillRun(row') >= 0);
  });

  test('calls the composed gate, and calls it with the database clock', () => {
    /* THE ROUTE HAS TO CALL THE RULE, NOT MERELY AGREE WITH IT. Every behavioural test above
     * reaches the gate through the library; none reaches it through the route, so an inline
     * re-implementation here would leave the whole suite green. The clock argument is inside the
     * pin for the same reason: a stamp captured before the row read cannot be substituted
     * silently. */
    const helper = routeSlice('async function repairStalledFillRun', 'function editableResumeSpec');
    assert.match(helper, /stalledFillRunReleaseIsAdmissible\(current, retrySafety, databaseNow\.getTime\(\)\)/);
    assert.match(helper, /submissionAttemptRetrySafetyForPacketEvents\(events\)/);
    assert.match(helper, /submissionAttemptEventsForPacket\(userId, locked\.id, \{ executor: tx \}\)/);
    // TRY-locked, never waiting: a managed provider call can hold this user's ledger key for 280s,
    // and this helper runs on every dashboard poll.
    assert.match(helper, /if \(!await tryLockSubmissionAttemptUser\(tx, userId\)\) return null;/);
    assert.ok(!/await lockSubmissionAttemptUser\(/u.test(helper));
    assert.match(helper, /\.limit\(1\)\.for\('update'\)/);
    // Exact-spec CAS, and null on a miss: a concurrent writer wins and the stored gates keep
    // refusing, which is the failure direction that cannot cost a duplicate application.
    assert.match(helper, /JSON\.stringify\(locked\.spec\)/);
    assert.match(helper, /if \(!updated\) return null;/);
  });

  test('writes NOTHING to the attempt ledger, which is what makes the clock affordable', () => {
    /* #912's release wrote not_sent_proven, and a live run's own late fold is then refused by
     * recordManagedAuthorizedAttemptUnverified - so firing early there killed the send and
     * destroyed the record. This helper has no attempt to write a fact against, and must never
     * grow one: with no ledger write, a fill that was merely slow simply overwrites this row on its
     * next progress frame. */
    const helper = routeSlice('async function repairStalledFillRun', 'function editableResumeSpec');
    assert.ok(!/appendSubmissionAttemptEvent\(/u.test(helper));
    assert.ok(!/not_sent_proven/u.test(helper));
  });

  test('the released status is one the submission-authority envelope is published for', () => {
    /* The second half of the live defect. /applications/:id/submission attaches the envelope only
     * for FIRST_SEND_REVIEW_STATUSES, and a status outside that set leaves the response with no
     * envelope, which the dashboard quarantines - refusing every send with a sentence about
     * evidence the packet does not have. Releasing to a status outside this set would trade one
     * dead end for another. */
    const set = routeSlice('const FIRST_SEND_REVIEW_STATUSES', ']);');
    assert.match(set, /'needs_attention'/);
    assert.equal(releaseStalledFillRun(stalledRow()).status, 'needs_attention');
  });
});
