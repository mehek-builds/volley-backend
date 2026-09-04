/* THE DATABRICKS BLOCK, AND WHY IT NEEDED NEITHER A CLOCK NOR THE APPLICANT.
 *
 * MEASURED 2026-09-03. Databricks "Software Engineering Intern (2027 Start) - Winter", canonical
 * application 1d4c8113. The send was refused because an earlier attempt on the same posting folds
 * to blocked_unverified/'opened', and the refusal told the applicant to open that attempt in her
 * Tracker, check the employer's page, and report back. The Tracker had been removed, so the remedy
 * named a surface that did not exist; but the deeper defect is that the errand was never real. The
 * attempt carries `attempt_opened` and nothing else, which is the ledger PROVING no application
 * reached that employer. There was nothing on the page to find.
 *
 * WHAT THESE TESTS REFUSE TO ASSERT. They do not assert that an old block comes off. A boundary
 * authorization is durable employer risk and must keep blocking at any age, and an attempt that is
 * still the packet's live claim belongs to stalledSubmittingClaimIsReleasable, which pays a
 * wall-clock bound for its certainty. Both are pinned here beside the closable cases so a later
 * change cannot widen one without breaking the other.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { application_submission_attempt_events, generated_resumes } from '../db/schema';
import {
  abandonedPreBoundaryAttemptIsClosable,
  closeAbandonedPreBoundaryAttempts,
  type AbandonedAttemptClosurePacketReview,
} from './abandonedAttemptClosure';
import { STALLED_FILL_RUN_RELEASE_MS } from './stalledFillRunRelease';
import {
  attemptNeverReachedEmployer,
  type SubmissionAttemptEventKind,
  type SubmissionAttemptEventRecord,
  type SubmissionAttemptLedgerExecutor,
} from './submissionAttemptLedger';

const ATTEMPT = '7b3c1e88-4a2d-4f19-9c50-2e6a7d41b0c3';
const OTHER_ATTEMPT = 'e2f4a900-1c6b-4d83-8a17-5b0c93de7f24';
const PACKET = '1d4c8113-6d99-4df8-9fcb-d6ae638e90bc';

/* Fixtures default to a fixed date safely more than STALLED_FILL_RUN_RELEASE_MS in the past, so
 * every test that does not care about the time margin (almost all of them) still clears it against
 * the real clock without saying so. Tests that DO care pass their own created_at/observed_at and
 * `now` explicitly - see "the time margin" below. */
const FIXTURE_BASE_MS = new Date('2020-01-01T00:00:00.000Z').getTime();
let fixtureSequence = 0;

function event(
  kind: SubmissionAttemptEventKind,
  over: Partial<SubmissionAttemptEventRecord> = {},
): SubmissionAttemptEventRecord {
  fixtureSequence += 1;
  // Distinct and strictly increasing across calls, so submissionAttemptRetrySafety's sort (by
  // created_at, then by id) and its ordering checks (e.g. "authorized before opened") both have
  // real values to work with instead of crashing on `undefined.getTime()` / `undefined.localeCompare`.
  const at = new Date(FIXTURE_BASE_MS + fixtureSequence * 1000);
  return {
    id: `00000000-0000-0000-0000-${String(fixtureSequence).padStart(12, '0')}`,
    user_id: 'test-user',
    application_id: null,
    event_id: `00000000-0000-0000-0001-${String(fixtureSequence).padStart(12, '0')}`,
    event_kind: kind,
    attempt_id: ATTEMPT,
    parent_attempt_id: null,
    packet_id: PACKET,
    source: 'managed_browser',
    operation: 'initial_submission',
    submission_run_id: null,
    submission_claim_id: null,
    packet_version: null,
    posting_key: null,
    job_id: null,
    company_role: null,
    company_name: 'Acme',
    role: 'Software Engineer',
    portal_url: null,
    portal_identity: null,
    // `undefined` here reads as "not null" to the vocabulary check below, exactly like `null` would
    // NOT: submissionAttemptRetrySafety requires these explicitly null on every event kind other
    // than the one that owns them (not_sent_proven for proof_kind, boundary_authorized for the
    // other two). Leaving them unset silently misclassified every fixture in this file as
    // 'invalid_sequence' the moment a test folded them through that function instead of through
    // attemptNeverReachedEmployer alone - which is exactly what the orchestration test below does.
    proof_kind: null,
    evidence_code: null,
    boundary_activation_id: null,
    boundary_expires_at: null,
    created_at: at,
    observed_at: at,
    ...over,
  } as unknown as SubmissionAttemptEventRecord;
}

const OPENED_ONLY = [event('attempt_opened')];
const OPENED_AND_AUTHORIZED = [event('attempt_opened'), event('boundary_authorized')];
const OPENED_AND_PRESSED = [
  event('attempt_opened'),
  event('boundary_authorized'),
  event('press_observed'),
];

/* A review with no status opinion of its own and no send evidence at all - the shape that must
 * never be the thing standing between a provably-dead attempt and closing it. */
const BENIGN_REVIEW: AbandonedAttemptClosurePacketReview = { status: 'needs_attention' };
const SUBMITTED_REVIEW: AbandonedAttemptClosurePacketReview = { status: 'submitted' };

const NO_CLAIM = { claimId: null, review: BENIGN_REVIEW };
const MOVED_TO_OTHER_ATTEMPT = { claimId: OTHER_ATTEMPT, review: BENIGN_REVIEW };
const STILL_THIS_ATTEMPT = { claimId: ATTEMPT, review: BENIGN_REVIEW };

describe('the Databricks class closes with no applicant and no clock', () => {
  test('an opened-only attempt whose packet has dropped the claim is closable', () => {
    assert.equal(attemptNeverReachedEmployer(OPENED_ONLY), true);
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({ attemptEvents: OPENED_ONLY, packet: NO_CLAIM }),
      true,
    );
  });

  test('an opened-only attempt whose packet has moved on to a different claim is closable', () => {
    /* The run that opened this one ended when the packet took a new claim. Nothing is executing it,
     * and nothing ever will, so the block it casts over the posting is pure residue. */
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: OPENED_ONLY,
        packet: MOVED_TO_OTHER_ATTEMPT,
      }),
      true,
    );
  });
});

describe('an unknown packet refuses, and is never read as "no claim"', () => {
  test('a packet row that could not be read - deleted, or its spec unparseable - is refused', () => {
    /* Review round 1: the first cut of this predicate took `packetClaimId: string | null | undefined`
     * and folded a missing or unreadable row down to `null`, which read exactly like a packet that
     * was read fine and simply holds no claim. Those are not the same fact. A row this function
     * could not read says nothing about whether some other run still holds it, so `packet: null` has
     * to refuse - the opposite of what a dropped claim proves - or a deleted packet row would close
     * an attempt that may still be live. */
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({ attemptEvents: OPENED_ONLY, packet: null }),
      false,
    );
  });
});

describe('a legacy_backfill opening needs the packet review to prove it too', () => {
  /* attemptNeverReachedEmployer is arithmetic over event kinds: one attempt_opened, nothing else.
   * That is true of every legacy_backfill row by CONSTRUCTION of the 2026-08-27T14:11:35.408Z
   * migration that wrote them, whether or not the run it describes ever crossed the boundary. The
   * packet's own current review is the second, independent proof. */
  const LEGACY_OPENED_ONLY = [event('attempt_opened', { source: 'legacy_backfill' })];

  test('a legacy_backfill opening on a packet whose review says submitted is not closable', () => {
    assert.equal(attemptNeverReachedEmployer(LEGACY_OPENED_ONLY), true, 'the event vocabulary alone still reads as pre-boundary');
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: LEGACY_OPENED_ONLY,
        packet: { claimId: null, review: SUBMITTED_REVIEW },
      }),
      false,
    );
  });

  test('a legacy_backfill opening on a packet whose review is needs_attention with no attempted_at is closable', () => {
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: LEGACY_OPENED_ONLY,
        packet: { claimId: null, review: BENIGN_REVIEW },
      }),
      true,
    );
  });

  test('a standing submission_attempted_at refuses even when unverified_submission resolves not_sent', () => {
    /* employerMayHoldApplication alone would read this as safe - her own look neutralises the
     * unverified record and its sibling attempted_at together. This closure is not her look, so it
     * asks submission_attempted_at again on its own and refuses regardless of the resolution. */
    const review: AbandonedAttemptClosurePacketReview = {
      status: 'needs_attention',
      submission_attempted_at: '2026-08-20T10:00:00.000Z',
      unverified_submission: {
        resolution: 'not_sent',
      } as unknown as AbandonedAttemptClosurePacketReview['unverified_submission'],
    };
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: LEGACY_OPENED_ONLY,
        packet: { claimId: null, review },
      }),
      false,
    );
  });

  test('a security_code wall refuses, even though it never touched this run', () => {
    const review: AbandonedAttemptClosurePacketReview = {
      status: 'needs_attention',
      security_code: {} as unknown as AbandonedAttemptClosurePacketReview['security_code'],
    };
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: LEGACY_OPENED_ONLY,
        packet: { claimId: null, review },
      }),
      false,
    );
  });
});

describe('the time margin: a claim that just moved on could still be a live browser', () => {
  /* Every other proof holds for this fixture - never reached the employer, packet claim dropped,
   * benign review - so the bound below is the ONLY thing standing between it and closing. */
  const OPENED_AT = new Date('2026-09-01T00:00:00.000Z');
  const JUST_DROPPED = [event('attempt_opened', { created_at: OPENED_AT, observed_at: OPENED_AT })];
  const AT_BOUND = OPENED_AT.getTime() + STALLED_FILL_RUN_RELEASE_MS;

  test('well within the margin, it is not closable even though every other proof holds', () => {
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: JUST_DROPPED,
        packet: NO_CLAIM,
        now: OPENED_AT.getTime() + 60_000,
      }),
      false,
    );
  });

  test('the edge is pinned in both directions, so the polarity cannot be flipped silently', () => {
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({ attemptEvents: JUST_DROPPED, packet: NO_CLAIM, now: AT_BOUND }),
      false,
      'exactly at the bound is not yet old enough',
    );
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: JUST_DROPPED,
        packet: NO_CLAIM,
        now: AT_BOUND + 1,
      }),
      true,
      'one millisecond past the bound, it is',
    );
  });

  test('a legacy_backfill opening days old clears the margin with room to spare', () => {
    /* The actual target: a migration-written row is days old by the time anything reads it, so this
     * bound costs the real goal nothing. Uses the module default `now` (the real clock) rather than
     * an explicit one, the same way every non-time-margin test above does. */
    const daysOld = [event('attempt_opened', {
      source: 'legacy_backfill',
      created_at: new Date('2026-08-27T14:11:35.408Z'),
      observed_at: new Date('2026-08-27T14:11:35.408Z'),
    })];
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({ attemptEvents: daysOld, packet: NO_CLAIM }),
      true,
    );
  });
});

describe('the live claim is left to the predicate that pays a clock for it', () => {
  test('an attempt that is still the packet claim is never closed here', () => {
    /* claimSubmission writes submission_claim_id and appends attempt_opened in one transaction, so
     * a matching claim means a run may still be executing this attempt. Closing it here would be
     * the poll-kills-the-send defect, arrived at from a different direction. */
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({ attemptEvents: OPENED_ONLY, packet: STILL_THIS_ATTEMPT }),
      false,
    );
  });
});

describe('the ledger proof is never relaxed', () => {
  test('a boundary authorization keeps blocking however abandoned the attempt is', () => {
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: OPENED_AND_AUTHORIZED,
        packet: NO_CLAIM,
      }),
      false,
    );
  });

  test('an observed press keeps blocking', () => {
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({ attemptEvents: OPENED_AND_PRESSED, packet: NO_CLAIM }),
      false,
    );
  });

  test('a confirmed attempt is not this closure to touch', () => {
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: [event('attempt_opened'), event('submission_confirmed')],
        packet: NO_CLAIM,
      }),
      false,
    );
  });

  test('an already closed attempt is a no-op, which is what makes the heal idempotent', () => {
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: [event('attempt_opened'), event('not_sent_proven')],
        packet: NO_CLAIM,
      }),
      false,
    );
  });

  test('an empty ledger and a malformed attempt are both refused', () => {
    assert.equal(abandonedPreBoundaryAttemptIsClosable({ attemptEvents: [], packet: NO_CLAIM }), false);
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: [event('attempt_opened'), event('attempt_opened')],
        packet: NO_CLAIM,
      }),
      false,
    );
  });

  test('events from two attempts are never folded into one closure', () => {
    /* Refused, though not by the coherence check itself: two openings already fail
     * attemptNeverReachedEmployer. Asserted anyway because the OUTCOME is the contract, and the
     * belt-and-braces check in the predicate is declared as a mutation survivor rather than
     * pretended to be load-bearing. */
    assert.equal(
      abandonedPreBoundaryAttemptIsClosable({
        attemptEvents: [event('attempt_opened'), event('attempt_opened', { attempt_id: OTHER_ATTEMPT })],
        packet: NO_CLAIM,
      }),
      false,
    );
  });
});

/* THE ORCHESTRATOR'S OWN SAVEPOINT ISOLATION, WHICH abandonedAttemptClosure.db.test.ts COULD NOT
 * REACH WITH A REAL POSTGRES.
 *
 * The scenario needs a candidate that is genuinely selected (reason 'opened') and genuinely passes
 * abandonedPreBoundaryAttemptIsClosable, and THEN fails while appendSubmissionAttemptEvent tries to
 * write its closing fact. Two real-data constructions were tried against the PGlite harness and both
 * are unreachable: a self-parented opening is refused by a DATABASE check constraint before it can
 * even be seeded, and a pre-planted conflicting not_sent_proven fact removes the attempt from
 * candidate selection entirely (submissionAttemptRetrySafety only ever returns reason 'opened' when
 * NO not_sent_proven event already exists - see the db test file for the full argument). So this one
 * controls the failure directly with a minimal fake SubmissionAttemptLedgerExecutor instead: real
 * closeAbandonedPreBoundaryAttempts and real submissionAttemptRetrySafety, a hand-rolled in-memory
 * table standing in for the two queries this module issues (the packet select, and everything
 * appendSubmissionAttemptEvent itself does).
 */
function fakeSubmissionAttemptExecutor(store: {
  events: SubmissionAttemptEventRecord[];
  packets: { id: string; spec: unknown }[];
  failForAttemptId?: string;
}): SubmissionAttemptLedgerExecutor {
  // The real table objects, compared by reference: production code's own .from(...) calls pass
  // exactly these, so identity is enough to tell the two queries apart without interpreting SQL.
  function chain(kind: 'select' | 'insert') {
    const c: {
      _table?: unknown;
      _limit?: number;
      _values?: Record<string, unknown>;
      from: (table: unknown) => typeof c;
      where: () => typeof c;
      limit: (n: number) => typeof c;
      orderBy: () => typeof c;
      values: (v: Record<string, unknown>) => typeof c;
      onConflictDoNothing: () => typeof c;
      returning: () => typeof c;
      then: (resolve: (value: unknown) => void, reject: (error: unknown) => void) => void;
    } = {
      from(table) { c._table = table; return c; },
      where() { return c; },
      limit(n) { c._limit = n; return c; },
      orderBy() { return c; },
      values(v) { c._values = v; return c; },
      onConflictDoNothing() { return c; },
      returning() { return c; },
      then(resolve, reject) {
        try {
          if (kind === 'insert') {
            const v = c._values!;
            if (store.failForAttemptId && v.attempt_id === store.failForAttemptId) {
              throw new Error(`simulated append failure for attempt ${v.attempt_id as string}`);
            }
            const row = {
              id: `generated-${store.events.length}`,
              created_at: new Date(),
              observed_at: new Date(),
              ...v,
            } as unknown as SubmissionAttemptEventRecord;
            store.events.push(row);
            resolve([row]);
            return;
          }
          if (c._table === application_submission_attempt_events) {
            // appendSubmissionAttemptEvent's own existence check always calls .limit(1); answering
            // "not found" is safe here precisely because it is always true for a fresh not_sent_proven
            // fact keyed on this closure's own factKey - see the comment at the call site.
            resolve(c._limit === 1 ? [] : [...store.events]);
            return;
          }
          if (c._table === generated_resumes) {
            resolve([...store.packets]);
            return;
          }
          resolve([]);
        } catch (error) {
          reject(error);
        }
      },
    };
    return c;
  }

  // Drizzle's own select/insert signatures are generic over the exact columns and table types, and
  // a plain object literal can never implement that generality - only a real QueryBuilder can. Cast
  // the whole fake at once rather than fighting each member's type individually; every other
  // db.test.ts harness in this repo takes the same way out (see e.g. `backendDb: any` in
  // canonicalPacketBinding.db.test.ts) for the identical reason.
  const fake = {
    select: () => chain('select'),
    insert: () => chain('insert'),
    execute: async () => ({ rows: [] }),
    transaction: async (callback: (tx: SubmissionAttemptLedgerExecutor) => unknown) => callback(executor),
  };
  const executor = fake as unknown as SubmissionAttemptLedgerExecutor;
  return executor;
}

describe('the savepoint isolates one candidate\'s failure from another\'s success', () => {
  test('a failing candidate does not roll back a passing one closed in the same call', async () => {
    const USER_ID = 'orchestration-user';
    const GOOD_PACKET = 'packet-good';
    const BAD_PACKET = 'packet-bad';
    const GOOD_ATTEMPT = 'attempt-good';
    const BAD_ATTEMPT = 'attempt-bad';
    const OPENED_AT = new Date('2026-08-20T00:00:00.000Z');

    const events = [
      event('attempt_opened', {
        user_id: USER_ID, attempt_id: GOOD_ATTEMPT, packet_id: GOOD_PACKET,
        created_at: OPENED_AT, observed_at: OPENED_AT,
      }),
      event('attempt_opened', {
        user_id: USER_ID, attempt_id: BAD_ATTEMPT, packet_id: BAD_PACKET,
        created_at: OPENED_AT, observed_at: OPENED_AT,
      }),
    ];
    const packets = [
      { id: GOOD_PACKET, spec: { _review: BENIGN_REVIEW } },
      { id: BAD_PACKET, spec: { _review: BENIGN_REVIEW } },
    ];
    const warnings: { details: Record<string, unknown>; message: string }[] = [];
    const executor = fakeSubmissionAttemptExecutor({ events, packets, failForAttemptId: BAD_ATTEMPT });

    const result = await closeAbandonedPreBoundaryAttempts({
      userId: USER_ID,
      executor,
      log: { warn: (details, message) => { warnings.push({ details, message }); } },
    });

    assert.deepEqual(result.closedAttemptIds, [GOOD_ATTEMPT]);
    assert.deepEqual(result.failedAttemptIds, [BAD_ATTEMPT]);
    assert.equal(warnings.length, 1, 'the failure is reported, not swallowed');
    assert.equal(warnings[0]!.details.attemptId, BAD_ATTEMPT);

    assert.ok(
      events.some((stored) => stored.attempt_id === GOOD_ATTEMPT && stored.event_kind === 'not_sent_proven'),
      'the healthy candidate closed even though it shared the call with a failing one',
    );
    assert.equal(
      events.filter((stored) => stored.attempt_id === BAD_ATTEMPT).length,
      1,
      'the failed candidate is left exactly as it was - only its original opening',
    );
  });
});
