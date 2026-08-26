import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { advanceCanonicalApplicationFromPacketSubmission } from './canonicalApplicationSync';

const PACKET_ID = '8e29df51-09ed-4c67-b2fc-153966471473';
const USER_ID = 'a18f774b-a306-4804-93f3-cd6020c27fb3';

test('the advance hands the packet and its owner to the canonical write, unchanged', async () => {
  const calls: Array<{ packetId: string; userId: string }> = [];
  await advanceCanonicalApplicationFromPacketSubmission({ packetId: PACKET_ID, userId: USER_ID }, {
    sync: async (input) => {
      calls.push(input);
    },
  });
  assert.deepEqual(calls, [{ packetId: PACKET_ID, userId: USER_ID }]);
});

/* Every caller stamps its packet first and tells the canonical row second, and the packet write is
 * the one an applicant's outcome hangs on - a webhook delivery, a submit run holding a live
 * browser, a dashboard answer. None of those may be failed by the tracker table having a bad day,
 * so the advance swallows its own failure by contract rather than at nine call sites. */
test('a canonical write failure never escapes to the packet writer', async () => {
  await advanceCanonicalApplicationFromPacketSubmission({ packetId: PACKET_ID, userId: USER_ID }, {
    sync: async () => {
      throw new Error('the applications table is having a bad day');
    },
  });
});

// ---- the shape of the live wiring, which no fake can check ----

const sync = readFileSync('src/lib/canonicalApplicationSync.ts', 'utf8');

/* The one statement every writer shares. Keyed by packet AND owner, states taken from the shared
 * lifecycle constant, updated_at stamped now rather than backdated, and guarded so a row already
 * submitted is never rewritten - two writers racing may both read 'not submitted', and only one of
 * them may write. */
test('the canonical write is keyed by packet and owner and can only move a row forward', () => {
  assert.match(sync, /eq\(applications\.legacy_generated_resume_id, input\.packetId\)/);
  assert.match(sync, /eq\(applications\.user_id, input\.userId\)/);
  assert.match(sync, /submission_state\} <> 'submitted'/);
  assert.match(sync, /submission_state: confirmedSubmissionLifecycle\.submissionState/);
  assert.match(sync, /tracker_state: confirmedSubmissionLifecycle\.trackerState/);
  assert.match(sync, /updated_at: new Date\(\)/);
});

/* The email confirmation path was fixed first and must stay on the shared wrapper rather than
 * growing its own copy of the statement or of the swallow contract back. */
test('the email confirmation writer advances the canonical row through the shared wrapper', () => {
  const email = readFileSync('src/lib/applicationEmail.ts', 'utf8');
  assert.match(email, /import \{ advanceCanonicalApplicationFromPacketSubmission \} from '\.\/canonicalApplicationSync'/);
  assert.doesNotMatch(email, /db\.update\(applications\)/);
});

/* All four server submit paths - ATS API, managed, retained-session, controlled - stamp 'submitted'
 * through writeReview, so the advance lives there once instead of four times. The status check is
 * what keeps a claim, a hold or a failure write from ever touching the canonical row. */
test('every runner submit stamp advances the canonical row through writeReview', () => {
  const runner = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  const start = runner.indexOf('async function writeReview');
  const end = runner.indexOf('\nasync function standingAuthorization', start);
  assert.ok(start >= 0 && end > start, 'could not bound writeReview');
  const writeReview = runner.slice(start, end);
  assert.match(writeReview, /updated\.length > 0 && review\.status === 'submitted'/);
  assert.match(
    writeReview,
    /advanceCanonicalApplicationFromPacketSubmission\(\{ packetId: row\.id, userId: row\.user_id \}\)/,
  );
});

/* Each dashboard route that stamps a packet submitted tells the canonical row, AFTER its own
 * guarded update has been confirmed to land - a 409'd or 202'd write must not advance anything. */
test('each dashboard writer that stamps a packet submitted advances the canonical row', () => {
  const routes = readFileSync('src/routes/applications.ts', 'utf8');
  // A route's text runs from its registration to the next one; `fastify.log` inside a handler must
  // not end the slice early, so the boundary is the registration call itself.
  const registrations = [...routes.matchAll(/fastify\.(?:get|post|patch|put|delete)\(\s*'([^']+)'/g)];
  const routeSlice = (path: string) => {
    const at = registrations.findIndex((match) => match[1] === path);
    assert.ok(at >= 0, `${path} is not registered`);
    return routes.slice(registrations[at].index, registrations[at + 1]?.index);
  };
  for (const path of [
    '/applications/:id/submission/extension-outcome',
    '/applications/:id/submit-request',
    '/applications/:id/submission/handoff-complete',
    '/applications/:id/submission/self-submitted',
    '/applications/:id/submission/unverified',
  ]) {
    assert.ok(
      routeSlice(path).includes('advanceCanonicalApplicationFromPacketSubmission('),
      `${path} does not advance the canonical row`,
    );
  }
  // On the unconditional arms the advance runs only after the route's own guarded update landed;
  // a 409'd or 202'd write must not advance anything.
  for (const path of [
    '/applications/:id/submit-request',
    '/applications/:id/submission/handoff-complete',
    '/applications/:id/submission/self-submitted',
  ]) {
    const route = routeSlice(path);
    const advance = route.indexOf('advanceCanonicalApplicationFromPacketSubmission(');
    assert.ok(
      route.lastIndexOf('.length === 0', advance) > 0,
      `${path} advances the canonical row before its own write is confirmed`,
    );
  }
  // The outcome-shaped routes gate on the status the persisted review actually landed on, the
  // same predicate the runner's writeReview uses, never a re-derivation from request inputs.
  // Their idempotent retry arms heal an already-submitted packet, which is what makes a retry
  // the recovery path for a canonical advance that failed the first time.
  for (const [path, persistedStatus, idempotentAdvancePrecedesGuard] of [
    ['/applications/:id/submission/extension-outcome', "result.review.status === 'submitted'", false],
    ['/applications/:id/submission/unverified', "next.status === 'submitted'", true],
  ] as const) {
    const route = routeSlice(path);
    const advanceAt = route.indexOf('advanceCanonicalApplicationFromPacketSubmission(');
    const persistedStatusAt = route.indexOf(persistedStatus);
    assert.ok(
      persistedStatusAt >= 0,
      `${path} does not gate the advance on the persisted status`,
    );
    if (idempotentAdvancePrecedesGuard) {
      assert.ok(
        advanceAt < persistedStatusAt,
        `${path} does not heal the canonical row on its idempotent retry arm`,
      );
    } else {
      assert.ok(
        persistedStatusAt < advanceAt,
        `${path} advances the canonical row before checking the persisted result`,
      );
    }
  }
});
