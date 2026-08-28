/* THE APPLICATION LITOS COULD NOT FINISH AND COULD NOT LET GO OF.
 *
 * POST /applications/:id/documents/ordered writes `ordered_at` and nothing else, correctly: Litos
 * cannot make a registrar mail a sealed transcript, and a send offered on the strength of "I have
 * ordered it" is a send the employer refuses. The dashboard's send gate reads `attached_at`, so it
 * stayed shut, and the modal that put her there said "This application then finishes with you rather
 * than with Litos" about a screen that had no control which finished anything. The packet sat at
 * ready_for_final_approval behind a permanently grey Send button.
 *
 * `transcript_supported === false` reaches the same dead end from the other direction: the run looked
 * at the form for somewhere to put the file and found nothing, so no upload she makes can change it.
 *
 * These are source-text assertions, in the shape extensionSubmissionRoutes.test.ts uses, because the
 * route needs a database, a signed token and an owned row to reach over HTTP. What they hold is the
 * three things that decide whether this is a door or a hole: it is authenticated, it answers only for
 * the state that is genuinely stranded, and the record it writes does not claim Litos saw anything.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/routes/applications.ts', 'utf8');
const passiveSubmissionRoute = source.slice(
  source.indexOf("'/applications/:id/submission',"),
  source.indexOf("'/applications/:id/submission/self-submit-start'"),
);
const selfSubmitStartRoute = source.slice(
  source.indexOf("'/applications/:id/submission/self-submit-start'"),
  source.indexOf("'/applications/:id/submission/handoff-complete'"),
);
const route = source.slice(
  source.indexOf("'/applications/:id/submission/self-submitted'"),
  source.indexOf("'/applications/:id/submission/approve'"),
);

test('passive submission reads never reserve or authorize an employer attempt', () => {
  assert.doesNotMatch(passiveSubmissionRoute, /reserveAttendedManualAttempt/);
  assert.doesNotMatch(passiveSubmissionRoute, /finalApplicationBoundaryGate/);
  assert.doesNotMatch(passiveSubmissionRoute, /appendApplicationAttemptFact|handoff_url/);
});

test('passive reads recover only the exact already-authorized manual attempt id', () => {
  assert.match(passiveSubmissionRoute, /retrySafety\.attemptId === claimedAttemptId/);
  assert.match(passiveSubmissionRoute, /retrySafety\.reason === 'boundary_authorized'/);
  assert.match(passiveSubmissionRoute, /attendedManualAttemptBinding\(row, claimedAttemptId\)/);
  assert.match(passiveSubmissionRoute, /attendedManualAttemptMatchesCurrent\(row, review, binding\)/);
  assert.match(passiveSubmissionRoute, /retrySafety\.leaseId === authorization\.leaseId/);
  assert.match(passiveSubmissionRoute, /manual_handoff_resume_available: recoverableManualBoundary\?\.active === true/);
  assert.match(passiveSubmissionRoute, /manual_attempt_id: recoverableManualBoundary\.attemptId/);
  assert.match(passiveSubmissionRoute, /boundary_lease_id: recoverableManualBoundary\.leaseId/);
  assert.match(passiveSubmissionRoute, /boundary_activation_id: recoverableManualBoundary\.activationId/);
  assert.match(passiveSubmissionRoute, /review: passiveSubmissionReview\(review\)/);
  assert.doesNotMatch(passiveSubmissionRoute, /portal_url: portalUrl/);
  assert.doesNotMatch(passiveSubmissionRoute, /manual_handoff:\s*\{|url,|portal_url:\s*review\.portal_url/);
});

test('a user-pressed self-submit start owns reservation and the final duplicate gate', () => {
  assert.match(selfSubmitStartRoute, /preHandler: requireAuth/);
  assert.match(selfSubmitStartRoute, /attendedBoundaryRequestSchema\.safeParse\([\s\S]*request\.body === undefined \? \{\} : request\.body/);
  assert.match(selfSubmitStartRoute, /const replay = attendedBoundaryReplay\(parsedBoundaryRequest\.data\)/);
  assert.match(selfSubmitStartRoute, /review = await repairReviewPortalFromMonitoredJob\(row, review\)/);
  assert.match(selfSubmitStartRoute, /documentAsksLitosCannotResolve/);
  assert.match(selfSubmitStartRoute, /reserveAttendedManualAttempt/);
  assert.match(selfSubmitStartRoute, /finalApplicationBoundaryGate/);
  assert.match(selfSubmitStartRoute, /self-submit-start-final-duplicate-recheck/);
  assert.match(selfSubmitStartRoute, /replay,/);
  assert.match(selfSubmitStartRoute, /manual_attempt_id: reservation\.binding\.attemptId/);
  assert.match(selfSubmitStartRoute, /boundary_lease_id: finalized\.authorization\.leaseId/);
  assert.match(selfSubmitStartRoute, /boundary_activation_id: finalized\.authorization\.activationId/);
  assert.match(selfSubmitStartRoute, /manual_handoff_resume_available: true/);
  assert.match(selfSubmitStartRoute, /replay: boundaryGate\.replay/);
  assert.match(selfSubmitStartRoute, /finalizeAttendedHandoffCapability\(\{/);
  assert.match(selfSubmitStartRoute, /attended_handoff_capability: finalized\.attendedHandoffCapability/);
  assert.match(selfSubmitStartRoute, /portal_url: finalized\.url/);
});

test('attended replay input is an all-or-none strict authorization tuple', () => {
  assert.match(source, /const attendedBoundaryReplaySchema = z\.object\(\{[\s\S]*attempt_id: z\.string\(\)\.uuid\(\)[\s\S]*boundary_lease_id: z\.string\(\)\.uuid\(\)[\s\S]*boundary_activation_id: z\.string\(\)\.uuid\(\)[\s\S]*\}\)\.strict\(\)/);
  assert.match(source, /const attendedBoundaryRequestSchema = z\.union\(\[[\s\S]*z\.object\(\{\}\)\.strict\(\)[\s\S]*attendedBoundaryReplaySchema/);
});

test('the exit is authenticated and owner-scoped, like every other route in this file', () => {
  /* There is no global auth hook and no auth decorator in this app, so a route declared without a
     preHandler is silently public - and this one writes a terminal status. */
  assert.match(route, /preHandler: requireAuth/);
  assert.match(route, /const row = await ownedResume\(request, reply\)/);
  assert.match(route, /eq\(generated_resumes\.user_id, request\.jwtPayload!\.userId\)/);
});

test('it answers only for a packet that is genuinely stranded', () => {
  /* THE GATE IS WHAT KEEPS THIS FROM BECOMING A QUIET WAY PAST A SEND GATE THAT IS DOING ITS JOB.
     An application she could still finish inside Litos has a working control already, and gets a 409
     here rather than a terminal write. */
  assert.match(route, /current\.status !== 'ready_for_final_approval'/);
  assert.match(route, /documentAsksLitosCannotResolve\(current, storedDocuments\(row\)\)/);
  assert.match(route, /unresolvable\.length === 0[\s\S]{0,200}status\(409\)/);
  assert.match(route, /Litos can still finish this one/);
  // And the write is conditional on the status it answered for, so a send that started somewhere
  // else in the meantime is not overwritten by an answer about the screen before it.
  assert.match(route, /'_review'->>'status' = 'ready_for_final_approval'/);
  assert.match(route, /submitted\.length === 0[\s\S]{0,300}status\(202\)/);
});

test('it writes an existing state through the shared merge, and never invents one', () => {
  /* applyReviewPatch rather than a spread: the shared merge is where withTerminalCause enforces that
     a terminal state carries a cause, and three production rows reached 'failed' with no stated
     reason when a route built its own review object. */
  assert.match(route, /applyReviewPatch\(current, \{/);
  assert.match(route, /status: 'submitted'/);
  assert.match(route, /pipeline_stage: 'applied'/);
  assert.doesNotMatch(route, /status: '(?!submitted')/, 'no new status belongs to this answer');
});

test('the receipt names her as the witness rather than claiming Litos watched it land', () => {
  /* The same discipline the unverified-submission route states: Litos does not manufacture a
     confirmation it never saw. 'attended_handoff' is the source the two existing "a person saw this"
     answers already use, so the tracker and the receipt screen need no new case. */
  assert.match(route, /source: 'attended_handoff'/);
  assert.match(route, /confirmation_text: 'Confirmed by you/);
  assert.match(route, /you sent this application yourself/);
});
