import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * The dashboard installs submission-state responses from applications.ts as its live submission
 * state and re-derives the employer-send gate from `response.submission_authority` alone,
 * fail-closing when the envelope is absent. /resume/history attaches the envelope for a genuinely
 * un-attempted packet; these tests pin that the application routes whose responses overwrite that
 * state attach the same envelope through the same helper, so selecting or editing an application
 * cannot re-quarantine a packet that has never opened an attempt.
 */

const applications = readFileSync('src/routes/applications.ts', 'utf8');

function routeSlice(from: string, to: string): string {
  const start = applications.indexOf(from);
  const end = applications.indexOf(to);
  assert.ok(start >= 0, `route marker ${from} exists`);
  assert.ok(end > start, `route marker ${to} follows ${from}`);
  return applications.slice(start, end);
}

const SPREAD = /\.\.\.\(await unattemptedPacketSubmissionAuthority\(request\.jwtPayload!\.userId, row\.id, [^,]+\.status, request\.log\)\)/;

test('GET /applications/:id/submission carries the unattempted-packet authority envelope', () => {
  const slice = routeSlice("'/applications/:id/submission'", "'/applications/:id/submission/handoff-complete'");
  assert.match(slice, SPREAD);
});

test('POST /applications/:id/review responses carry the envelope on both exits', () => {
  const slice = routeSlice("'/applications/:id/review'", "'/applications/:id/review/answers'");
  const sites = slice.split('unattemptedPacketSubmissionAuthority(').length - 1;
  assert.equal(sites, 2, 'the contention 202 and the success response both attach the envelope');
});

test('submit-request 202s carry the envelope on both exits', () => {
  const slice = routeSlice("'/applications/:id/submit-request'", "'/applications/:id/submission/channels'");
  // The contention 202 AND the end-of-run 202: a packet-drift hold ends the run through the main
  // 202 with no attempt opened, so that response must also carry the unattempted-packet envelope.
  const sites = slice.split('unattemptedPacketSubmissionAuthority(').length - 1;
  assert.equal(sites, 2, 'the contention 202 and the end-of-run 202 both attach the envelope');
});

test('the helper is fail-closed: same envelope builder as /resume/history, nothing on read failure', () => {
  const helper = applications.slice(
    applications.indexOf('async function unattemptedPacketSubmissionAuthority('),
    applications.indexOf('const questionSchema'),
  );
  assert.ok(helper.length > 0, 'helper exists in applications.ts');
  // Delegates the none/no_evidence-only decision to the one shared builder, so this route family
  // can never mint an envelope shape the history route would not.
  assert.match(helper, /submissionAuthorityEnvelopeForUnattemptedPacket\(\{/);
  // A projection read failure attaches nothing rather than throwing the whole response away.
  assert.match(helper, /catch \(error\) \{[\s\S]*?return \{\};/);
  // And an absent envelope attaches nothing, so a packet with attempt history is untouched.
  assert.match(helper, /envelope \? \{ submission_authority: envelope \} : \{\}/);
  // Statuses with an attempt open (or opening) skip the projection transaction entirely, keeping
  // the dashboard's fill-run polling off the per-user submission-attempt advisory lock.
  assert.match(helper, /if \(!FIRST_SEND_REVIEW_STATUSES\.has\(reviewStatus\)\) return \{\};/);
});
