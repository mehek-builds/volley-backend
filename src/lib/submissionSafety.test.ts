import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  blankRequiredQuestionLabels,
  directPreparationIsSafe,
  preparedRunCanRestart,
  preparedRunHandoffExpired,
  resumeContactRefreshDisposition,
  resumeEditDisposition,
  submitRequestDisposition,
} from './submissionSafety';
import { BROWSER_SESSION_TIMEOUT_SECONDS, HANDOFF_WINDOW_MS } from './browserbase';
import type { ApplicationReviewQuestion, ApplicationReviewState } from './applicationReview';

const question = (over: Partial<ApplicationReviewQuestion>): ApplicationReviewQuestion => ({
  id: 'q',
  question: 'Discipline',
  answer: '',
  kind: 'required',
  required: true,
  ...over,
});

test('a submitted or active application cannot begin another submission run', () => {
  assert.equal(submitRequestDisposition('submitted'), 'submitted');
  assert.equal(submitRequestDisposition('submit_requested', true), 'in_flight');
  assert.equal(submitRequestDisposition('preparing'), 'in_flight');
  assert.equal(submitRequestDisposition('submitting'), 'in_flight');
});

test('pre-submit attention can retry, but a post-click uncertainty cannot risk a duplicate application', () => {
  assert.equal(submitRequestDisposition('submit_requested', false), 'start');
  assert.equal(submitRequestDisposition('ready_to_submit'), 'start');
  assert.equal(submitRequestDisposition('failed'), 'start');
  assert.equal(submitRequestDisposition('needs_attention', false), 'start');
  assert.equal(submitRequestDisposition('needs_attention', true), 'reject');
  assert.equal(submitRequestDisposition('ready_for_final_approval'), 'reject');
});

/* ---- THE LOCK THAT HAD NO KEY, ON THE ROWS THAT WERE ALREADY INSIDE IT ----
 *
 * kos.ai, production, 2026-08-11. Pressing Try again on the dashboard returned "This application
 * cannot start another submission run from its current state". The run behind it had stopped inside
 * the Stratus atomic chooser, which throws before submitHandle.click, and the row it left carried no
 * submission_attempted_at, no receipt, no unverified_submission, no security_code and no
 * browser_session_id. No application exists on the employer side and the row can prove it, yet
 * needs_attention-after-a-claim is a state submitRequestDisposition refuses, and the three other
 * exits need a status, a challenge or an unverified record this row does not have.
 *
 * PR 494 released the claim on this path going forward. A write-time fix cannot reach a row that was
 * already written, so the gate now reads the evidence instead. Every case below drives the real
 * disposition function; the refusals are the point at least as much as the reopen.
 */
const claimedNoSendRow = (over: Partial<ApplicationReviewState> = {}): ApplicationReviewState => ({
  jd_text: 'Software Engineer, kos.ai',
  status: 'needs_attention',
  edited_terms: [],
  questions: [],
  skipped_reasons: [],
  updated_at: '2026-08-11T12:00:00.000Z',
  submission_claimed_at: '2026-08-11T11:58:00.000Z',
  submission_claim_id: 'claim-id',
  submission_error: 'Atomic submit control was missing or ambiguous',
  attention_reason: 'Litos could not find the button that sends this application, so nothing has been sent and there is no confirmation to look for.',
  ...over,
});

const disposition = (review: ApplicationReviewState) => submitRequestDisposition(
  review.status,
  Boolean(review.submission_claimed_at),
  review.unverified_submission?.resolution,
  review,
);

test('the kos.ai row proves nothing was sent, so it can run again', () => {
  const row = claimedNoSendRow();
  // The exact shape production held: the chooser error, and nothing else on the row at all.
  assert.equal(row.submission_attempted_at, undefined);
  assert.equal(row.receipt, undefined);
  assert.equal(row.unverified_submission, undefined);
  assert.equal(row.security_code, undefined);
  assert.equal(disposition(row), 'start');
  // The same row read WITHOUT its evidence is still refused, which is what every caller that holds
  // no row keeps getting, and is what this row got before the evidence was passed.
  assert.equal(submitRequestDisposition(row.status, true), 'reject');
});

test('an empty row is not a proof, so a run killed mid-submit stays locked', () => {
  /* The Skydio shape on a build older than unverified_submission: the same four fields empty, and an
     employer who may really hold the application. Absence of evidence is not evidence, and this is
     the case that separates a positive proof from a convenient one. */
  assert.equal(disposition(claimedNoSendRow({ submission_error: undefined })), 'reject');
  assert.equal(disposition(claimedNoSendRow({
    submission_error: 'Managed browser run timed out before it produced a result',
  })), 'reject');
});

test('a standing security-code wall is an employer-side application and never reopens', () => {
  // The status refusal, claim or no claim. Unchanged, and asserted here so a later edit to the
  // clause below cannot quietly move it.
  assert.equal(disposition(claimedNoSendRow({ status: 'awaiting_security_code' })), 'reject');
  assert.equal(submitRequestDisposition('awaiting_security_code', false, undefined, claimedNoSendRow()), 'reject');
  /* And the harder half: a code wall OBSERVED EARLIER, retained on a row whose current run never
     pressed anything. The chooser proof is true about this run and says nothing about the send that
     produced the wall, so the wall wins. */
  assert.equal(disposition(claimedNoSendRow({
    security_code: { digits: 8, sent_to: 'app@apply.trylitos.com', requested_at: '2026-08-11T11:40:00.000Z', submit_was_authorized: true },
  })), 'reject');
});

test('a receipt of any kind means something was filed, so it never reopens', () => {
  const receipt = {
    confirmation_text: 'Thank you for applying',
    final_url: 'https://jobs.ashbyhq.com/kos/abc/application',
    captured_at: '2026-08-11T11:59:00.000Z',
  };
  assert.equal(disposition(claimedNoSendRow({ receipt })), 'reject');
  assert.equal(disposition(claimedNoSendRow({
    receipt: { ...receipt, confirmation_text: 'This application was not accepted' },
  })), 'reject');
});

test('an unverified submission has its own resolution route and is not reopened around it', () => {
  /* The route that owns this state asks the applicant whether the employer has it, and 'not_sent' is
     the only answer that unlocks a re-run. A row holding an unresolved record must keep reaching that
     question rather than being handed a run by this clause. */
  const unresolved = claimedNoSendRow({
    unverified_submission: { at: '2026-08-11T11:59:00.000Z', cause: 'no_confirmation_state' },
  });
  assert.equal(disposition(unresolved), 'reject');
  // The applicant's own answer still works, and still comes from her rather than from the row.
  assert.equal(disposition(claimedNoSendRow({
    unverified_submission: { at: '2026-08-11T11:59:00.000Z', cause: 'no_confirmation_state', resolution: 'not_sent' },
  })), 'start');
  assert.equal(disposition(claimedNoSendRow({
    unverified_submission: { at: '2026-08-11T11:59:00.000Z', cause: 'no_confirmation_state', resolution: 'sent' },
  })), 'reject');
});

test('a recorded submit attempt outranks the chooser proof', () => {
  // submission_attempted_at means a submit provably reached the employer, whoever made it. A stored
  // pre-click stop alongside it is a contradiction, and the send is the half that must win.
  assert.equal(disposition(claimedNoSendRow({ submission_attempted_at: '2026-08-11T11:59:00.000Z' })), 'reject');
});

test('a pressed click is never reopened, however the outcome describes itself', () => {
  /* The runner's own read, for a caller that still holds the result. pressed:true is the fact this
     clause exists to respect, so it is refused even when the same result contradicts itself by
     reporting state 'not_attempted'. */
  const withOutcome = (submitOutcome: Record<string, unknown>) => submitRequestDisposition(
    'needs_attention', true, undefined, { ...claimedNoSendRow(), submitOutcome },
  );
  assert.equal(withOutcome({ pressed: true, state: 'not_attempted' }), 'reject');
  assert.equal(withOutcome({ pressed: true, state: 'unknown' }), 'reject');
  assert.equal(withOutcome({ pressed: true, state: 'confirmed', message: 'Thanks', formStillPresent: false }), 'reject');
  assert.equal(withOutcome({ pressed: true, state: 'rejected', message: 'Refused', formStillPresent: false }), 'reject');
  // And the arm that does reopen: the runner reporting, in its own words, that it never pressed.
  assert.equal(withOutcome({ pressed: false, state: 'not_attempted' }), 'start');
});

test('the statuses that own another route keep it, evidence or no evidence', () => {
  /* The clause is scoped to needs_attention because that is the only status this stop writes. A
     filled packet waiting to be looked at has an explicit restart flag, and a sent one has nothing to
     restart, so neither may be reached through a proof about a run that never pressed anything. */
  assert.equal(disposition(claimedNoSendRow({ status: 'ready_for_final_approval' })), 'reject');
  assert.equal(disposition(claimedNoSendRow({ status: 'submitted' })), 'submitted');
  assert.equal(disposition(claimedNoSendRow({ status: 'submitting' })), 'in_flight');
});

test('a not-yet-sent final approval packet can reopen resume editing', () => {
  assert.equal(resumeEditDisposition('ready_to_submit'), 'start');
  assert.equal(resumeEditDisposition('ready_for_final_approval'), 'start');
  assert.equal(resumeEditDisposition('ready_for_final_approval', true), 'reject');
  assert.equal(resumeEditDisposition('submitted'), 'reject');
  assert.equal(resumeEditDisposition('submitting'), 'reject');
});

test('an unclaimed final-approval packet can refresh its contact header, a claimed one cannot', () => {
  assert.equal(resumeContactRefreshDisposition({ status: 'ready_for_final_approval' }), 'save');
  assert.equal(resumeContactRefreshDisposition({
    status: 'ready_for_final_approval',
    submission_claimed_at: '2026-08-20T10:00:00.000Z',
  }), 'reject');
  // Every status reviewAnswerSaveDisposition already saves keeps saving.
  assert.equal(resumeContactRefreshDisposition({ status: 'ready_to_submit' }), 'save');
  assert.equal(resumeContactRefreshDisposition({ status: 'needs_attention' }), 'save');
  // And every status it refuses outright - for a reason that has nothing to do with
  // ready_for_final_approval - keeps refusing.
  assert.equal(resumeContactRefreshDisposition({ status: 'submitted' }), 'reject');
  assert.equal(resumeContactRefreshDisposition({ status: 'filling' }), 'reject');
});

/* THE BRANCH resumeEditDisposition ALONE WOULD HAVE MISSED. needs_attention with no claim is
 * 'start' for resumeEditDisposition regardless of what the row's own evidence says, because a run
 * stopping there is ordinarily safe to retry - but submission_attempted_at with no not_sent
 * resolution is the unverifiedSubmissionPatch shape, and reviewAnswerSaveDisposition already
 * refuses it through employerMayHoldApplication. resumeContactRefreshDisposition has to keep
 * refusing it even though ready_for_final_approval now opens elsewhere. See
 * resumeContactRefresh.test.ts's 'refused when the row itself says an employer may already hold
 * this packet' for the live-measured shape this pins at the route level. */
test('employer-may-hold evidence still refuses, from every status including the one this opens', () => {
  assert.equal(resumeContactRefreshDisposition({
    status: 'needs_attention',
    submission_attempted_at: '2026-08-20T10:00:00.000Z',
  }), 'reject');
  assert.equal(resumeContactRefreshDisposition({
    status: 'ready_for_final_approval',
    submission_attempted_at: '2026-08-20T10:00:00.000Z',
  }), 'reject');
  assert.equal(resumeContactRefreshDisposition({
    status: 'ready_for_final_approval',
    security_code: { digits: 6, requested_at: '2026-08-20T10:00:00.000Z', submit_was_authorized: true },
  }), 'reject');
});

test('verification handoff prevents automatic submission even without native required markup', () => {
  assert.equal(directPreparationIsSafe({ blockerCount: 0, attentionCount: 0, verificationStatus: 'handoff' }), false);
  assert.equal(directPreparationIsSafe({ blockerCount: 0, attentionCount: 0, verificationStatus: 'completed' }), true);
});

test('an unanswered required question stops the direct send without stopping the run', () => {
  // The run has already happened by the time this is consulted. What it withholds is the CLICK.
  assert.equal(directPreparationIsSafe({
    blockerCount: 0,
    attentionCount: 0,
    unansweredRequiredCount: 1,
    verificationStatus: 'completed',
  }), false);
  assert.equal(directPreparationIsSafe({
    blockerCount: 0,
    attentionCount: 0,
    unansweredRequiredCount: 0,
    verificationStatus: 'completed',
  }), true);
  // Defaulted, so an existing caller that does not pass a count keeps its previous meaning.
  assert.equal(directPreparationIsSafe({ blockerCount: 0, attentionCount: 0, verificationStatus: 'completed' }), true);
});

test('only a required question with no answer counts as blank', () => {
  assert.deepEqual(blankRequiredQuestionLabels([
    question({ question: 'Discipline', answer: '' }),
    // Whitespace is not an answer.
    question({ question: 'Personal pronouns', answer: '   ' }),
    question({ question: 'Overall GPA', answer: '3.89' }),
    // Optional and blank is fine: the employer will accept the form without it.
    question({ question: 'LinkedIn', answer: '', required: false }),
  ]), ['Discipline', 'Personal pronouns']);
  assert.deepEqual(blankRequiredQuestionLabels([]), []);
  assert.deepEqual(blankRequiredQuestionLabels(undefined), []);
});

test('a filled but unsent packet can be re-run, a claimed one never can', () => {
  /* The trap this closes: a packet frozen at ready_for_final_approval against an old build, with
     R-066 forbidding a delete and the only escape being a full resume edit that changes nothing
     about the resume. Claimed is the line, because a claim means the employer may already hold it. */
  assert.equal(preparedRunCanRestart('ready_for_final_approval'), true);
  assert.equal(preparedRunCanRestart('ready_for_final_approval', true), false);
  assert.equal(preparedRunCanRestart('submitted'), false);
  assert.equal(preparedRunCanRestart('submitting'), false);
  // States that can already start a run have no need of a restart flag and must not imply one.
  assert.equal(preparedRunCanRestart('ready_to_submit'), false);
  assert.equal(preparedRunCanRestart('needs_attention'), false);
});

/* R: THE SEND BUTTON THE SERVER REFUSED, AND THE SESSION IT WAS PROTECTING THAT DID NOT EXIST.
 *
 * Cresta packet 8142004c-3358-4538-8778-16df5e31c5bb, production, 2026-08-09 03:06:19:
 * POST /applications/8142004c.../submission/approve -> 409, "That took too long and timed out."
 * A complete Greenhouse application, no screener questions, filled at 22:10 with a stamp of 23:05.
 *
 * Measured on prod the same hour: of the 11 packets sitting at ready_for_final_approval, ALL 11 had
 * browser_session_id null and 10 were past their stamp. The provider is stratus-managed, whose
 * prepare path writes `browser_session_id: undefined` and whose submit path re-navigates and
 * refills from buildPacket. There was no session for the stamp to be about.
 *
 * Against the pre-fix predicate every case below with a null session id came back true. RED.
 */
const SESSION = 'bb_sess_9f1c';
const past = new Date('2026-08-08T23:05:10.431Z').toISOString();
const future = new Date('2026-08-09T04:05:10.431Z').toISOString();
const at = Date.parse('2026-08-09T03:06:19.000Z');

test('an expiry with no session behind it refuses nothing', () => {
  // The Cresta packet, exactly as production held it.
  assert.equal(preparedRunHandoffExpired({ handoff_expires_at: past }, at), false);
  assert.equal(preparedRunHandoffExpired({ handoff_expires_at: past, browser_session_id: undefined }, at), false);
  assert.equal(preparedRunHandoffExpired({ handoff_expires_at: past, browser_session_id: '' }, at), false);
});

test('a live session past its window is still a real refusal', () => {
  // submit() does getBrowserSession then connectToSession on this path. The session is gone.
  assert.equal(preparedRunHandoffExpired({ handoff_expires_at: past, browser_session_id: SESSION }, at), true);
  assert.equal(preparedRunHandoffExpired({ handoff_expires_at: future, browser_session_id: SESSION }, at), false);
});

test('a missing or unparseable stamp is not an expiry', () => {
  assert.equal(preparedRunHandoffExpired({ browser_session_id: SESSION }, at), false);
  assert.equal(preparedRunHandoffExpired({ handoff_expires_at: 'soon', browser_session_id: SESSION }, at), false);
});

test('the window is the session timeout minus a margin, not a number somebody picked', () => {
  assert.equal(BROWSER_SESSION_TIMEOUT_SECONDS, 3600);
  assert.equal(HANDOFF_WINDOW_MS, 55 * 60_000);
  // Derived, not restated. A bare literal here would let the two drift apart again.
  assert.equal(HANDOFF_WINDOW_MS, (BROWSER_SESSION_TIMEOUT_SECONDS - 300) * 1_000);
});

test('every prepare path stamps the window from the constant', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  assert.doesNotMatch(runner, /55 \* 60_000/);
  assert.equal(runner.match(/handoff_expires_at: new Date\(Date\.now\(\) \+ HANDOFF_WINDOW_MS\)/g)?.length, 3);
});

test('the approve route asks the predicate, and says a restart is the way out', async () => {
  const routes = await readFile('src/routes/applications.ts', 'utf8');
  const approve = routes.slice(routes.indexOf("'/applications/:id/submission/approve'"));
  const gate = approve.indexOf('preparedRunHandoffExpired(current)');
  assert.ok(gate >= 0, 'approve must consult the session-scoped predicate');
  // The raw stamp read is what shipped the defect and must not come back.
  assert.doesNotMatch(routes, /current\.handoff_expires_at && Date\.parse\(current\.handoff_expires_at\)/);
  // A refusal whose advice is "start it again" has to be machine-readable, or the dashboard can
  // only guess which of the several 409s on this route it is looking at.
  assert.match(approve.slice(gate, gate + 600), /code: 'PREPARED_RUN_HANDOFF_EXPIRED'/);
  assert.match(approve.slice(gate, gate + 600), /restartable: preparedRunCanRestart\(/);
});
