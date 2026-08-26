import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { ApplicationReviewState } from './applicationReview';
import {
  expiredAttendedHandoffClaimIsReleasable,
  releaseExpiredAttendedHandoffClaim,
} from './expiredHandoffClaimRelease';
import { preparedRunHandoffExpired, submitRequestDisposition } from './submissionSafety';

/* The Fully (teamtailor) packet as measured live on 2026-08-20: a managed run claimed the send,
 * filled the whole form, and parked at the attended consent handoff without pressing send. The
 * handoff window is long past, and managed runs write browser_session_id undefined. */
const FULLY_NOW = Date.parse('2026-08-20T09:00:00.000Z');

const parkedRow = (over: Partial<ApplicationReviewState> = {}): ApplicationReviewState => ({
  jd_text: 'Senior Frontend Engineer, Fully',
  ats_name: 'teamtailor',
  status: 'needs_attention',
  edited_terms: [],
  questions: [],
  skipped_reasons: [],
  updated_at: '2026-08-19T22:35:00.000Z',
  submission_claimed_at: '2026-08-19T22:34:30.915Z',
  submission_claim_id: 'fully-claim-id',
  handoff_expires_at: '2026-08-19T23:29:30.825Z',
  attention_reason: 'This company asks you to confirm its applicant privacy terms before sending. '
    + 'Litos filled the form but left that choice and the send button to you.',
  ...over,
});

test('the measured Fully row is releasable: parked before the press, window over, no evidence of a send', () => {
  const row = parkedRow();
  // The run's own record of never pressing: all four evidence fields absent, submitted_at absent.
  assert.equal(row.submitted_at, undefined);
  assert.equal(row.submission_attempted_at, undefined);
  assert.equal(row.unverified_submission, undefined);
  assert.equal(row.receipt, undefined);
  assert.equal(expiredAttendedHandoffClaimIsReleasable(row, FULLY_NOW), true);
});

test('browser_session_id is not required: managed runs write it undefined, and preparedRunHandoffExpired must not be reused here', () => {
  const row = parkedRow();
  assert.equal(row.browser_session_id, undefined);
  /* preparedRunHandoffExpired answers a different question - "is there a live session worth
   * reconnecting to" - and its browser_session_id guard makes it answer false forever on exactly
   * the managed rows this release exists for. The divergence is the point of this test: if the
   * release were ever rewritten on top of that predicate, the trap would silently return. */
  assert.equal(preparedRunHandoffExpired(row, FULLY_NOW), false);
  assert.equal(expiredAttendedHandoffClaimIsReleasable(row, FULLY_NOW), true);
});

test('a row with an unverified submission keeps its claim, and its resolution key is untouched', () => {
  const row = parkedRow({
    unverified_submission: {
      at: '2026-08-19T22:40:00.000Z',
      cause: 'no_confirmation_state' as const,
    },
  });
  assert.equal(expiredAttendedHandoffClaimIsReleasable(row, FULLY_NOW), false);
  // Nothing is written on a refusal, so the applicant's own answer remains the only key.
  assert.equal(row.unverified_submission?.resolution, undefined);
  assert.equal(row.submission_claimed_at, '2026-08-19T22:34:30.915Z');
});

test('a row with a recorded attempt keeps its claim', () => {
  assert.equal(
    expiredAttendedHandoffClaimIsReleasable(
      parkedRow({ submission_attempted_at: '2026-08-19T22:40:00.000Z' }),
      FULLY_NOW,
    ),
    false,
  );
});

test('a row whose handoff has not expired keeps its claim', () => {
  const stillOpen = Date.parse('2026-08-19T23:00:00.000Z');
  assert.equal(expiredAttendedHandoffClaimIsReleasable(parkedRow(), stillOpen), false);
});

test('a submitted row is untouched', () => {
  assert.equal(
    expiredAttendedHandoffClaimIsReleasable(
      parkedRow({ status: 'submitted', submitted_at: '2026-08-19T22:40:00.000Z' }),
      FULLY_NOW,
    ),
    false,
  );
  // And a needs_attention row that somehow carries submitted_at is refused on the evidence alone.
  assert.equal(
    expiredAttendedHandoffClaimIsReleasable(parkedRow({ submitted_at: '2026-08-19T22:40:00.000Z' }), FULLY_NOW),
    false,
  );
});

test('a receipt or a standing security code each refuse the release on their own', () => {
  assert.equal(
    expiredAttendedHandoffClaimIsReleasable(
      parkedRow({
        receipt: { confirmation_text: 'Thanks', final_url: 'https://x.example', captured_at: '2026-08-19T22:41:00.000Z' },
      }),
      FULLY_NOW,
    ),
    false,
  );
  assert.equal(
    expiredAttendedHandoffClaimIsReleasable(
      parkedRow({ security_code: { requested_at: '2026-08-19T22:41:00.000Z' } as ApplicationReviewState['security_code'] }),
      FULLY_NOW,
    ),
    false,
  );
});

test('no handoff stamp means no release: the window being over is part of the proof, not a default', () => {
  assert.equal(
    expiredAttendedHandoffClaimIsReleasable(parkedRow({ handoff_expires_at: undefined }), FULLY_NOW),
    false,
  );
  assert.equal(
    expiredAttendedHandoffClaimIsReleasable(parkedRow({ handoff_expires_at: 'not a date' }), FULLY_NOW),
    false,
  );
});

test('the release clears the claim and what rode with it, keeps status and attention, and records the trace', () => {
  const row = parkedRow({
    submission_authorization: { source: 'per_application_approval', authorized_at: '2026-08-19T22:34:00.000Z' },
    browser_context_id: 'ctx-1',
  });
  const released = releaseExpiredAttendedHandoffClaim(row, '2026-08-20T09:00:00.000Z');
  assert.equal(released.submission_claimed_at, undefined);
  assert.equal(released.submission_claim_id, undefined);
  assert.equal(released.submission_packet_version, undefined);
  assert.equal(released.submission_authorization, undefined);
  assert.equal(released.handoff_expires_at, undefined);
  assert.equal(released.browser_session_id, undefined);
  assert.equal(released.browser_context_id, undefined);
  // The choice the run honestly left to the applicant is still hers, word for word.
  assert.equal(released.status, 'needs_attention');
  assert.equal(released.attention_reason, row.attention_reason);
  // The machine-readable trace names the cause and the exact claim it lifted.
  assert.deepEqual(released.claim_released, {
    cause: 'attended_handoff_expired',
    claim_id: 'fully-claim-id',
    released_at: '2026-08-20T09:00:00.000Z',
  });
});

test('the released row can be audited and re-run: both gates read it as unclaimed needs_attention', () => {
  const released = releaseExpiredAttendedHandoffClaim(parkedRow(), '2026-08-20T09:00:00.000Z');
  // The packet-audit gate refuses on submission_claimed_at; the released row no longer has one.
  assert.equal(Boolean(released.submission_claimed_at), false);
  assert.equal(
    submitRequestDisposition(released.status, Boolean(released.submission_claimed_at), released.unverified_submission?.resolution, released),
    'start',
  );
});

test('a double release is idempotent: the released row has no claim, so it is not releasable again', () => {
  const released = releaseExpiredAttendedHandoffClaim(parkedRow(), '2026-08-20T09:00:00.000Z');
  assert.equal(expiredAttendedHandoffClaimIsReleasable(released, FULLY_NOW), false);
});

/* ---- The routes actually run the repair, ahead of the gates that made the trap ---- */

const applications = readFileSync('src/routes/applications.ts', 'utf8');

function routeSlice(start: string, end: string): string {
  const from = applications.indexOf(start);
  const to = applications.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `route slice ${start} was not found`);
  return applications.slice(from, to);
}

test('packet-audit repairs the expired handoff claim before its claim gate refuses the row', () => {
  const route = routeSlice("'/applications/:id/packet-audit'", "'/applications/:id/submission/extension-packet'");
  const repair = route.indexOf('repairExpiredAttendedHandoffClaim(row');
  const gate = route.indexOf('This application can no longer be audited before submission');
  assert.ok(repair >= 0, 'packet-audit must attempt the release');
  assert.ok(gate > repair, 'the release must run before the claim gate reads the row');
});

test('submit-request repairs the expired handoff claim before submitRequestDisposition reads the row', () => {
  const route = routeSlice("'/applications/:id/submit-request'", 'const duplicateVerdict');
  const repair = route.indexOf('repairExpiredAttendedHandoffClaim(row');
  const gate = route.indexOf('submitRequestDisposition(');
  assert.ok(repair >= 0, 'submit-request must attempt the release');
  assert.ok(gate > repair, 'the release must run before the disposition reads the row');
});

test('the repair locks the user, proves the exact attempt never pressed, and releases with one atomic ledger fact', () => {
  const helper = routeSlice('async function repairExpiredAttendedHandoffClaim', 'function editableResumeSpec');
  const lock = helper.indexOf('lockSubmissionAttemptUser(tx, userId)');
  const latest = helper.indexOf('tx.select().from(generated_resumes)', lock);
  const proof = helper.indexOf('expiredAttendedHandoffClaimIsReleasable(current)', latest);
  const events = helper.indexOf('submissionAttemptEventsForPacket(userId, latest.id', proof);
  const extensionOutcome = helper.indexOf('application_submission_events', events);
  const update = helper.indexOf('tx.update(generated_resumes)', extensionOutcome);
  const ledger = helper.indexOf("appendApplicationAttemptFact(\n      submissionAttemptBindingFromEvent(opening),\n      'not_sent_proven'", update);
  assert.ok(lock >= 0 && latest > lock && proof > latest && events > proof
    && extensionOutcome > events && update > extensionOutcome && ledger > update,
  'the evidence check, row release, and immutable fact must share the user-locked transaction');
  assert.match(
    helper,
    /event\.event_kind === 'boundary_authorized'[\s\S]*event\.event_kind === 'press_observed'[\s\S]*event\.event_kind === 'submission_confirmed'/,
  );
  assert.match(helper, /proofKind: 'typed_pre_click_stop'/);
  assert.match(helper, /evidenceCode: 'expired_attended_handoff_proven_before_press'/);
  assert.match(helper, /JSON\.stringify\(latest\.spec\)/);
  assert.match(helper, /submission_claim_id' = \$\{current\.submission_claim_id\}/);
  assert.match(helper, /return healed\.row/,
    'callers must continue with the persisted row whose retry safety is now safe_not_sent');
});
