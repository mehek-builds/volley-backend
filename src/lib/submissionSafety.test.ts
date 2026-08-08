import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  blankRequiredQuestionLabels,
  directPreparationIsSafe,
  preparedRunCanRestart,
  preparedRunHandoffExpired,
  resumeEditDisposition,
  submitRequestDisposition,
} from './submissionSafety';
import { BROWSER_SESSION_TIMEOUT_SECONDS, HANDOFF_WINDOW_MS } from './browserbase';
import type { ApplicationReviewQuestion } from './applicationReview';

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

test('a not-yet-sent final approval packet can reopen resume editing', () => {
  assert.equal(resumeEditDisposition('ready_to_submit'), 'start');
  assert.equal(resumeEditDisposition('ready_for_final_approval'), 'start');
  assert.equal(resumeEditDisposition('ready_for_final_approval', true), 'reject');
  assert.equal(resumeEditDisposition('submitted'), 'reject');
  assert.equal(resumeEditDisposition('submitting'), 'reject');
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
