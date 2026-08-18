import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  advanceCanonicalApplicationFromPacketSubmission,
  reconcileCanonicalApplicationRows,
  type CanonicalSplitPacket,
} from './canonicalApplicationSync';

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

// ---- the reader-side heal ----

test('the sweep hands every split packet to the shared statement and counts what it moved', async () => {
  const synced: CanonicalSplitPacket[] = [];
  const rows: CanonicalSplitPacket[] = [
    { packetId: PACKET_ID, userId: USER_ID },
    { packetId: '13bccb2d-95a1-4a63-90d4-52cf30f8a41e', userId: USER_ID },
    { packetId: '8142004c-3358-4538-8778-16df5e31c5bb', userId: USER_ID },
  ];
  const outcome = await reconcileCanonicalApplicationRows({}, {
    listSplitPackets: async () => rows,
    // false is the guarded WHERE finding nothing left to fix - a writer got there between the
    // list and the statement - which the sweep must report as unchanged, never as an error.
    sync: async (input) => {
      synced.push(input);
      return input.packetId !== rows[1].packetId;
    },
  });
  assert.deepEqual(synced, rows);
  assert.deepEqual(outcome, { scanned: 3, healed: 2, unchanged: 1, failed: 0 });
});

/* The rows iterate in a stable order, so an uncaught throw would not just lose one pass's
 * counters - it would deterministically kill every future pass at the same row. Same contract as
 * reconcileSubmissionConfirmations, for the same reason. */
test('one failing packet does not abort the heal pass', async () => {
  const synced: string[] = [];
  const outcome = await reconcileCanonicalApplicationRows({}, {
    listSplitPackets: async () => [
      { packetId: PACKET_ID, userId: USER_ID },
      { packetId: '13bccb2d-95a1-4a63-90d4-52cf30f8a41e', userId: USER_ID },
    ],
    sync: async (input) => {
      if (input.packetId === PACKET_ID) throw new Error('the applications table is having a bad day');
      synced.push(input.packetId);
      return true;
    },
  });
  assert.deepEqual(synced, ['13bccb2d-95a1-4a63-90d4-52cf30f8a41e']);
  assert.deepEqual(outcome, { scanned: 2, healed: 1, unchanged: 0, failed: 1 });
});

test('the sweep clamps its limit and passes the user scope through', async () => {
  const queries: Array<{ userId?: string; limit: number }> = [];
  const deps = {
    listSplitPackets: async (query: { userId?: string; limit: number }) => {
      queries.push(query);
      return [];
    },
    sync: async () => true,
  };
  await reconcileCanonicalApplicationRows({}, deps);
  await reconcileCanonicalApplicationRows({ userId: USER_ID, limit: 5000 }, deps);
  await reconcileCanonicalApplicationRows({ limit: 0 }, deps);
  assert.deepEqual(queries, [
    { userId: undefined, limit: 200 },
    { userId: USER_ID, limit: 1000 },
    { userId: undefined, limit: 1 },
  ]);
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
  const writeReview = runner.slice(runner.indexOf('async function writeReview'));
  assert.match(writeReview.slice(0, 900), /review\.status === 'submitted'/);
  assert.match(
    writeReview.slice(0, 900),
    /advanceCanonicalApplicationFromPacketSubmission\(\{ packetId: row\.id, userId: row\.user_id \}\)/,
  );
});

/* Each dashboard route that stamps a packet submitted persists through ONE shared transition,
 * persistReviewTransition, and the canonical advance lives inside it: after the guarded update is
 * confirmed to land - a 409'd or 202'd write must not advance anything - and gated on the status
 * the persisted review actually landed on, the same predicate the runner's writeReview uses. The
 * choke point is the fix for the finding this file used to only describe: with five separate
 * writers, a sixth route could stamp a packet submitted and silently skip the sync. */
test('each dashboard writer that stamps a packet submitted advances the canonical row', () => {
  const routes = readFileSync('src/routes/applications.ts', 'utf8');
  const helperStart = routes.indexOf('async function persistReviewTransition');
  assert.ok(helperStart >= 0, 'the shared persist transition is missing');
  const helper = routes.slice(helperStart, routes.indexOf('export function freshSubmitRequestReview'));
  assert.match(helper, /if \(updated\.length === 0\) return false;/);
  assert.match(helper, /input\.next\.status === 'submitted'/);
  assert.match(helper, /advanceCanonicalApplicationFromPacketSubmission\(\{ packetId: input\.packetId, userId: input\.userId \}\)/);
  // The 'applied' pipeline stamp lives only inside the helper, so a future route that wants to
  // mark a packet applied cannot write its own UPDATE without failing here first - which is what
  // walks its author into the transition that carries the canonical advance.
  assert.equal(
    [...routes.matchAll(/pipeline_stage: 'applied'/g)].length,
    1,
    "pipeline_stage 'applied' must be stamped only by persistReviewTransition",
  );
  assert.match(helper, /pipeline_stage: 'applied'/);

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
      routeSlice(path).includes('persistReviewTransition('),
      `${path} does not persist through the shared transition`,
    );
  }
  // The outcome-shaped routes keep their idempotent retry arms, which heal an already-submitted
  // packet directly - that is what makes a retry the recovery path for a canonical advance that
  // failed the first time - so the direct advance appears there BEFORE the shared transition.
  for (const path of [
    '/applications/:id/submission/extension-outcome',
    '/applications/:id/submission/unverified',
  ]) {
    const route = routeSlice(path);
    const advance = route.indexOf('advanceCanonicalApplicationFromPacketSubmission(');
    assert.ok(advance >= 0, `${path} does not heal the canonical row on its idempotent retry arm`);
    assert.ok(
      advance < route.indexOf('persistReviewTransition('),
      `${path}'s direct advance should be its retry arm, ahead of the shared transition`,
    );
  }
});

/* The sweep reads the split state with the same two keys the guarded UPDATE writes by, and heals
 * it by replaying the one shared statement per packet rather than a bulk copy of it: a second
 * phrasing of that statement, however faithful today, is the drift this module exists to stop. */
test('the live sweep reads the split state by the writers’ own keys and replays their statement', () => {
  assert.match(sync, /eq\(applications\.legacy_generated_resume_id, generated_resumes\.id\)/);
  assert.match(sync, /eq\(applications\.user_id, generated_resumes\.user_id\)/);
  assert.match(sync, /generated_resumes\.spec\}->'_review'->>'status' = 'submitted'/);
  assert.match(sync, /deps\.sync \?\? syncCanonicalApplicationRow/);
  // The healed counter is the guarded statement's own answer, not a re-read.
  assert.match(sync, /\.returning\(\{ id: applications\.id \}\)/);
});

/* Hosted, deliberately, the way reconcileSubmissionConfirmations is hosted: an exported function
 * behind an authorized route, runnable on demand, and NOT on a schedule. Adding a cron entry is a
 * separate decision with its own blast radius, so this pins its absence. */
test('the heal is hosted by an authorized route and not a scheduler', () => {
  const route = readFileSync('src/routes/canonicalApplicationHeal.ts', 'utf8');
  assert.match(route, /isCronConfigured\(\)/);
  assert.match(route, /isCronAuthorized\(request\)/);
  assert.match(route, /reconcile: reconcileCanonicalApplicationRows/);
  const index = readFileSync('src/index.ts', 'utf8');
  assert.match(index, /register\(canonicalApplicationHealRoutes\)/);
  const crons = (require('../../vercel.json') as { crons: Array<{ path: string }> }).crons;
  assert.ok(
    crons.every((cron) => !cron.path.includes('canonical-application-heal')),
    'the heal must stay on-demand: scheduling it is a separate decision, not a side effect',
  );
});
