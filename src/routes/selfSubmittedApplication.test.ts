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
const route = source.slice(
  source.indexOf("'/applications/:id/submission/self-submitted'"),
  source.indexOf("'/applications/:id/submission/approve'"),
);

test('the exit is authenticated and owner-scoped, like every other route in this file', () => {
  /* There is no global auth hook and no auth decorator in this app, so a route declared without a
     preHandler is silently public - and this one writes a terminal status. */
  assert.match(route, /preHandler: requireAuth/);
  assert.match(route, /const row = await ownedResume\(request, reply\)/);
  // The write is owner-scoped through the shared transition, which keys its guarded UPDATE by
  // packet AND owner; the route's job is to hand it the authenticated owner, not a stored one.
  assert.match(route, /userId: request\.jwtPayload!\.userId/);
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
  assert.match(route, /if \(!persisted\) \{[\s\S]{0,300}status\(202\)/);
});

test('it writes an existing state through the shared merge, and never invents one', () => {
  /* applyReviewPatch rather than a spread: the shared merge is where withTerminalCause enforces that
     a terminal state carries a cause, and three production rows reached 'failed' with no stated
     reason when a route built its own review object. */
  assert.match(route, /applyReviewPatch\(current, \{/);
  assert.match(route, /status: 'submitted'/);
  // The 'applied' pipeline stamp is persistReviewTransition's to write; the route asks for it.
  assert.match(route, /appliedAt: new Date\(now\)/);
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
