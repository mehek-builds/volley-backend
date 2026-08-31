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
  assert.match(sync, /eq\(applications\.submission_state, current\.submission_state\)/);
  assert.match(sync, /eq\(applications\.tracker_state, current\.tracker_state\)/);
  assert.match(sync, /submission_state: nextSubmissionState/);
  assert.match(sync, /tracker_state: nextTrackerState/);
  assert.match(sync, /updated_at: new Date\(\)/);
});

/* The email confirmation path was fixed first and must stay on the shared wrapper rather than
 * growing its own copy of the statement or of the swallow contract back. */
test('the email confirmation writer advances the canonical row through the shared wrapper', () => {
  const email = readFileSync('src/lib/applicationEmail.ts', 'utf8');
  assert.match(
    email,
    /import \{\s*advanceCanonicalApplicationFromPacketSubmission,[\s\S]*?\} from '\.\/canonicalApplicationSync'/,
  );
  assert.doesNotMatch(email, /db\.update\(applications\)/);
});

/* All four server submit paths - ATS API, managed, retained-session, controlled - stamp 'submitted'
 * through writeReview, so the advance lives there once instead of four times. The status check is
 * what keeps a claim, a hold or a failure write from ever touching the canonical row. */
test('every runner submit stamp advances the canonical row through writeReview', () => {
  const runner = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  const writeReview = runner.slice(
    runner.indexOf('async function writeReview'),
    runner.indexOf('async function standingAuthorization'),
  );
  assert.match(writeReview, /review\.status === 'submitted'/);
  assert.match(
    writeReview,
    /advanceCanonicalApplicationFromPacketSubmission\(\{[\s\S]*?packetId: row\.id,[\s\S]*?userId: row\.user_id,/,
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
    const route = routeSlice(path);
    assert.ok(
      route.includes('advanceCanonicalApplicationFromPacketSubmission(')
        || route.includes('syncCanonicalApplicationRow('),
      `${path} does not advance the canonical row`,
    );
  }
  // On the unconditional arms the advance runs only after the route's own guarded update landed;
  // a 409'd or 202'd write must not advance anything.
  for (const path of [
    '/applications/:id/submission/handoff-complete',
    '/applications/:id/submission/self-submitted',
  ]) {
    const route = routeSlice(path);
    const advance = route.indexOf('syncCanonicalApplicationRow(');
    assert.ok(
      advance > 0
        && route.lastIndexOf('.returning({ id: generated_resumes.id })', advance) > 0
        && route.lastIndexOf("if (!updated) throw new Error('", advance) > 0,
      `${path} advances the canonical row before its own write is confirmed`,
    );
  }
  for (const path of [
    '/applications/:id/submission/extension-outcome',
    '/applications/:id/submit-request',
  ]) {
    const route = routeSlice(path);
    const syncAt = route.indexOf('syncCanonicalApplicationRow(');
    assert.ok(syncAt > 0 && route.lastIndexOf("throw new Error('", syncAt) > 0,
      `${path} must project only after its exact guarded packet write lands`);
  }
  // The outcome-shaped routes gate on the status the persisted review actually landed on, the
  // same predicate the runner's writeReview uses, never a re-derivation from request inputs.
  // Their idempotent retry arms heal an already-submitted packet, which is what makes a retry
  // the recovery path for a canonical advance that failed the first time.
  const extensionOutcome = routeSlice('/applications/:id/submission/extension-outcome');
  assert.ok(extensionOutcome.indexOf('advanceCanonicalApplicationFromPacketSubmission(')
    < extensionOutcome.indexOf("current.submission_claim_id !== parsed.data.claim_id"),
  'extension outcome must heal the canonical row on its idempotent retry arm');
  const unverified = routeSlice('/applications/:id/submission/unverified');
  const notFoundBranch = unverified.indexOf('if (!parsed.data.found)');
  const unverifiedSync = unverified.indexOf('syncCanonicalApplicationRow(');
  assert.ok(notFoundBranch > 0
    && unverifiedSync > notFoundBranch
    && unverified.lastIndexOf('.returning({ id: generated_resumes.id })', unverifiedSync) > notFoundBranch,
  'the found arm must confirm its packet write before projecting the canonical row');
});
