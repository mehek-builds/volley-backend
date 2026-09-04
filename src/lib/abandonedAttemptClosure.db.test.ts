/* THE DATABASE HALF OF #913: SAVEPOINT ISOLATION AND THE ROW-LEVEL "UNKNOWN" CASES.
 *
 * The predicate itself is exercised purely in abandonedAttemptClosure.test.ts. What only a real
 * Postgres can prove is closeAbandonedPreBoundaryAttempts' own orchestration: that it actually reads
 * a packet row and its ledger through the query builder, that a missing packet row and a
 * legacy_backfill opening on a still-submitted packet both come out unclosed end to end, and -
 * review round 1's robustness fix - that one candidate's failure inside its own savepoint does not
 * roll back a different candidate's successful close in the same call. Same PGlite harness as
 * src/lib/canonicalPacketBinding.db.test.ts.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { SubmissionAttemptSource } from './submissionAttemptLedger';

const savedEnv = { ...process.env };
const socketDir = mkdtempSync(join(tmpdir(), 'litos-abandoned-attempt-'));
let database: PGlite;
let server: PGLiteSocketServer;
let backendDb: any;
let backendPool: { end(): Promise<void> };
let closure: typeof import('./abandonedAttemptClosure');
let ledger: typeof import('./submissionAttemptLedger');

before(async () => {
  database = await PGlite.create();
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await database.exec(statement);
  server = new PGLiteSocketServer({ db: database, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();
  process.env.NODE_ENV = 'test';
  process.env.VERCEL = '1';
  process.env.LOG_LEVEL = 'silent';
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  ({ db: backendDb, pool: backendPool } = await import('../db'));
  closure = await import('./abandonedAttemptClosure');
  ledger = await import('./submissionAttemptLedger');
});

after(async () => {
  await backendPool?.end();
  await server?.stop();
  await database.close();
  rmSync(socketDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

/* Comfortably older than STALLED_FILL_RUN_RELEASE_MS (3 hours) relative to the real clock, the
 * same way a legacy_backfill row - days old by the time anything reads it - always is. */
const OLD = new Date('2026-08-27T14:11:35.408Z');

async function seedUser(): Promise<string> {
  const userId = randomUUID();
  await backendDb.insert(schema.users).values({ id: userId, email: `abandoned-${userId}@example.test` });
  return userId;
}

async function seedPacket(userId: string, review: Record<string, unknown>): Promise<string> {
  const packetId = randomUUID();
  await backendDb.insert(schema.generated_resumes).values({
    id: packetId,
    user_id: userId,
    job_context: { company: 'Acme', role: 'Software Engineer' },
    spec: { _review: review },
    resume_object_key: `k/${packetId}`,
  });
  return packetId;
}

/** `ledger` is only assigned once `before()` has run, so this must stay a function - never a
 * module-level constant - or every call site would capture `undefined`. */
function freeze() {
  return ledger.freezePostingIdentity({ company: 'Acme', role: 'Software Engineer' }, null);
}

/** Opens an attempt through the real ledger API, backdated so it clears the time margin. */
async function openOldAttempt(input: {
  userId: string;
  packetId: string;
  source?: SubmissionAttemptSource;
  createdAt?: Date;
}): Promise<string> {
  const attemptId = randomUUID();
  await ledger.appendSubmissionAttemptEvent({
    attemptId,
    userId: input.userId,
    packetId: input.packetId,
    source: input.source ?? 'legacy_backfill',
    operation: 'initial_submission',
    postingIdentity: freeze(),
    eventId: ledger.submissionAttemptEventId(attemptId, 'attempt_opened', 'reservation'),
    eventKind: 'attempt_opened',
    evidenceCode: 'atomic_claim_reserved',
    createdAt: input.createdAt ?? OLD,
    observedAt: input.createdAt ?? OLD,
  });
  return attemptId;
}

async function eventsForAttempt(userId: string, attemptId: string) {
  return backendDb.select().from(schema.application_submission_attempt_events).where(and(
    eq(schema.application_submission_attempt_events.user_id, userId),
    eq(schema.application_submission_attempt_events.attempt_id, attemptId),
  ));
}

test('closes a qualifying legacy_backfill attempt and writes the not-sent fact', async () => {
  const userId = await seedUser();
  const packetId = await seedPacket(userId, { status: 'needs_attention' });
  const attemptId = await openOldAttempt({ userId, packetId });

  const result = await backendDb.transaction((tx: any) =>
    closure.closeAbandonedPreBoundaryAttempts({ userId, executor: tx }));
  assert.deepEqual(result, { closedAttemptIds: [attemptId], failedAttemptIds: [] });

  const events = await eventsForAttempt(userId, attemptId);
  const closingFact = events.find((event: any) => event.event_kind === 'not_sent_proven');
  assert.ok(closingFact, 'the closing fact was actually written');
  assert.equal(closingFact.proof_kind, 'typed_pre_click_stop');
  assert.equal(closingFact.evidence_code, ledger.ATTEMPT_NEVER_REACHED_EMPLOYER_EVIDENCE);

  // Idempotent: a second call finds nothing left to do.
  const again = await backendDb.transaction((tx: any) =>
    closure.closeAbandonedPreBoundaryAttempts({ userId, executor: tx }));
  assert.deepEqual(again, { closedAttemptIds: [], failedAttemptIds: [] });
});

test('skips an attempt whose packet row is missing entirely', async () => {
  const userId = await seedUser();
  // No generated_resumes row is ever created for this packet id - packet_id carries no foreign key,
  // so the ledger accepts the open fine, exactly like a row that has since been deleted.
  const orphanPacketId = randomUUID();
  const attemptId = await openOldAttempt({ userId, packetId: orphanPacketId });

  const result = await backendDb.transaction((tx: any) =>
    closure.closeAbandonedPreBoundaryAttempts({ userId, executor: tx }));
  assert.deepEqual(result, { closedAttemptIds: [], failedAttemptIds: [] });

  const events = await eventsForAttempt(userId, attemptId);
  assert.equal(events.length, 1, 'still just the original opening; nothing was appended');
});

test('skips a legacy_backfill attempt on a packet whose review says submitted', async () => {
  const userId = await seedUser();
  const packetId = await seedPacket(userId, { status: 'submitted' });
  const attemptId = await openOldAttempt({ userId, packetId });

  const result = await backendDb.transaction((tx: any) =>
    closure.closeAbandonedPreBoundaryAttempts({ userId, executor: tx }));
  assert.deepEqual(result, { closedAttemptIds: [], failedAttemptIds: [] });

  const events = await eventsForAttempt(userId, attemptId);
  assert.equal(events.length, 1, 'the event vocabulary alone was never enough for this packet');
});

/* THE FOURTH CASE - "a failing candidate does not roll back a passing one" - AND WHY IT IS HERE NOW.
 *
 * Review round 1 could not reach this with a candidate built from REAL row data: something has to
 * be selected as an actual 'blocked_unverified'/'opened' attempt, pass
 * abandonedPreBoundaryAttemptIsClosable, and only THEN fail while appendSubmissionAttemptEvent tries
 * to write its closing fact. Two ways to construct one were tried against this exact harness and
 * both are unreachable through real row data:
 *
 *   - A self-parented opening (parent_attempt_id = attempt_id) would trip assertAppendInput when
 *     the closure appends its own fact naming that attempt as its own parent - but the row can
 *     never reach the table to begin with: application_submission_attempt_events_parent_check
 *     enforces `parent_attempt_id is null or parent_attempt_id <> attempt_id` at the DATABASE
 *     level, so the seeding insert itself is rejected.
 *   - Pre-planting a conflicting not_sent_proven fact under the exact event id this closure would
 *     compute (so appendSubmissionAttemptEvent's onConflictDoNothing path finds a mismatched
 *     existing row and throws) requires a not_sent_proven event already present on the attempt. But
 *     submissionAttemptRetrySafety can only classify an attempt as reason 'opened' - the candidate
 *     filter's own requirement - when NO not_sent_proven event exists for it: any that does either
 *     resolves the attempt to 'safe_not_sent' outright, or forces 'invalid_sequence'. Either way the
 *     attempt is never selected as a candidate, so the append this scenario needs to fail is never
 *     reached in the first place.
 *
 * Both are provable from the schema and from submissionAttemptRetrySafety's own logic, not merely
 * hard to hit, and the isolation property itself was already covered by a fake-executor unit test -
 * see 'the savepoint isolates one candidate's failure from another's success' in
 * abandonedAttemptClosure.test.ts - which controls exactly one candidate's append to fail without
 * needing an otherwise-unreachable row shape.
 *
 * WHAT THAT FAKE EXECUTOR CANNOT REACH, and this file exists for. Its `transaction` is a bare
 * passthrough, never a real SAVEPOINT, so it cannot prove ROLLBACK TO SAVEPOINT actually runs - and
 * it cannot prove anything about a real advisory lock, which is review round 2's Finding B: this
 * user's lock acquisition moved to the TOP of closeAbandonedPreBoundaryAttempts specifically because
 * a Postgres transaction-level advisory lock taken for the first time inside a savepoint is released
 * along with everything else ROLLBACK TO SAVEPOINT undoes. Neither unreachable construction above is
 * needed to prove either of those: the test below wraps a REAL transaction/savepoint so that one
 * specific attempt's insert into the ledger throws, while every other call - select, execute, and
 * `.transaction` itself - reaches the real executor untouched. The candidate is real, selected and
 * closable exactly like any other; only its insert is sabotaged, so the SAVEPOINT Drizzle opens for
 * it and the ROLLBACK TO SAVEPOINT it issues on the throw are both genuine Postgres, not simulated.
 */

/** `count(*)` over every currently-granted advisory lock this session holds, the same pg_locks shape
 * src/db/submissionAuthorityRevisionMigration.test.ts already uses to prove two lock acquisitions
 * are the identical key rather than merely "a lock of the same type". */
async function grantedAdvisoryLockCount(executor: { execute: (query: unknown) => Promise<any> }): Promise<number> {
  const result = await executor.execute(sql`
    select count(*)::int as count from pg_locks where locktype = 'advisory' and mode = 'ExclusiveLock' and granted
  `);
  return Number((result.rows[0] as { count?: unknown } | undefined)?.count ?? 0);
}

/** See the file-header comment above. `real` is the actual transaction or SAVEPOINT
 * closeAbandonedPreBoundaryAttempts was handed (or opened for itself); every call this closure makes
 * other than the one poisoned insert passes straight through to it, `.transaction` included - so
 * nesting still opens a real SAVEPOINT on the real connection.
 *
 * `afterSavepointSettles`, IF GIVEN, IS THE TEST'S ONLY WINDOW INTO THE GAP FINDING B CLOSES. A
 * count taken once, after closeAbandonedPreBoundaryAttempts returns, cannot tell "the lock was held
 * continuously" apart from "the lock was dropped and then a LATER candidate's own successful append
 * re-acquired it" - the second candidate's append does exactly that regardless of whether Finding
 * B's own top-of-function lock is present, because RELEASE SAVEPOINT promotes whatever a successful
 * savepoint acquired up into the enclosing transaction either way. Measured directly against this
 * harness with Finding B's fix deliberately commented out: a count taken only at the end still read
 * 1, and the assertion built on it still passed - a false negative that would have shipped this test
 * catching nothing. So this hook fires from the wrapper's OWN `transaction` method, immediately
 * after each per-candidate savepoint settles (released or rolled back) and BEFORE the next
 * candidate's savepoint opens, which is the one place the gap is actually visible. It only ever
 * fires at the top level - nothing in this code path opens a savepoint inside a savepoint - so it
 * runs exactly once per candidate, in the order closeAbandonedPreBoundaryAttempts processes them.
 *
 * Typed loosely and cast at the call site, the same way this repo's other db.test.ts harnesses type
 * their fakes (e.g. `backendDb: any` above): Drizzle's own select/insert signatures are generic over
 * exact column and table types, and a wrapper cannot implement that generality without fighting the
 * type checker for no real benefit here. */
function wrapWithFailingInsert(
  real: any,
  failForAttemptId: string,
  afterSavepointSettles?: (grantedLockCount: number) => void | Promise<void>,
): any {
  return {
    select: (...args: unknown[]) => real.select(...args),
    execute: (...args: unknown[]) => real.execute(...args),
    insert: (table: unknown) => {
      if (table !== schema.application_submission_attempt_events) return real.insert(table);
      return {
        values: (v: Record<string, unknown>) => {
          if (v.attempt_id !== failForAttemptId) return real.insert(table).values(v);
          // Never touches the real builder: the poisoned candidate's insert must not even reach
          // the wire, so there is no question of it partially applying before the throw.
          const poisoned = {
            onConflictDoNothing: () => poisoned,
            returning: () => poisoned,
            then: (_resolve: unknown, reject: (error: unknown) => void) => {
              reject(new Error(`simulated ledger insert failure for attempt ${failForAttemptId}`));
            },
          };
          return poisoned;
        },
      };
    },
    transaction: async (cb: (sp: unknown) => unknown) => {
      try {
        return await real.transaction((sp: unknown) => cb(wrapWithFailingInsert(sp, failForAttemptId)));
      } finally {
        if (afterSavepointSettles) await afterSavepointSettles(await grantedAdvisoryLockCount(real));
      }
    },
  };
}

test('a real SAVEPOINT rollback for one candidate leaves the other closed and the outer lock held', async () => {
  const userId = await seedUser();
  const goodPacketId = await seedPacket(userId, { status: 'needs_attention' });
  const badPacketId = await seedPacket(userId, { status: 'needs_attention' });
  /* submissionAttemptEventsForUser orders by created_at then by the event row's own generated id,
   * so two attempts opened at the identical fixture timestamp OLD would tiebreak on a fresh random
   * uuid - deciding candidate order by coin flip. That would make this test flaky at exactly the
   * property it exists to pin: the BAD candidate has to be the FIRST one closeAbandonedPreBoundaryAttempts
   * opens a savepoint for, because Finding B's defect is specifically a first-candidate failure
   * releasing a lock nothing else has taken yet. A later-candidate failure cannot show it: an earlier
   * candidate's own successful append would already have taken the same lock and RELEASE SAVEPOINT
   * (unlike ROLLBACK TO SAVEPOINT) promotes that hold to the enclosing transaction, masking the bug
   * this test is for regardless of whether Finding B's fix is present. So the bad attempt is
   * deliberately opened strictly before the good one. */
  const badAttemptId = await openOldAttempt({ userId, packetId: badPacketId, createdAt: OLD });
  const goodAttemptId = await openOldAttempt({
    userId, packetId: goodPacketId, createdAt: new Date(OLD.getTime() + 1000),
  });

  let result: { closedAttemptIds: string[]; failedAttemptIds: string[] } | undefined;
  const lockCountsAfterEachCandidate: number[] = [];
  let lockCountAfterExplicitRelock: number | undefined;

  await backendDb.transaction(async (tx: any) => {
    const wrapped = wrapWithFailingInsert(tx, badAttemptId, (count) => {
      lockCountsAfterEachCandidate.push(count);
    });
    result = await closure.closeAbandonedPreBoundaryAttempts({ userId, executor: wrapped });

    // Taken again explicitly, through the exported helper, on the exact key it derives: reentrant
    // within one session, so this must neither block nor add a second row - proving the earlier
    // counts were THIS lock, not merely some other advisory lock the query happened to catch.
    await ledger.lockSubmissionAttemptUser(tx, userId);
    lockCountAfterExplicitRelock = await grantedAdvisoryLockCount(tx);
  });

  assert.deepEqual(result, { closedAttemptIds: [goodAttemptId], failedAttemptIds: [badAttemptId] });
  assert.equal(
    lockCountsAfterEachCandidate.length,
    2,
    'one capture per candidate savepoint - bad, then good - and no more',
  );

  // THE ASSERTION FINDING B IS FOR. Captured immediately after the BAD candidate's real SAVEPOINT
  // rolled back - before the GOOD candidate's own savepoint (and its own reentrant lock call) even
  // opened. Finding B moved this user's advisory lock acquisition to the top of
  // closeAbandonedPreBoundaryAttempts, on the outer `tx`, before either candidate's savepoint opened
  // - so the rollback above must not have released it. Confirmed against this exact harness with
  // Finding B's fix commented out: this specific count reads 0, not 1, and only THIS count catches
  // it - see the wrapper's own comment for why a count taken any later cannot.
  assert.equal(
    lockCountsAfterEachCandidate[0],
    1,
    'the per-user advisory lock survived the first (failing) candidate\'s savepoint rollback',
  );
  assert.equal(
    lockCountsAfterEachCandidate[1],
    1,
    'and is still exactly one lock, not two, once the second (closing) candidate\'s own savepoint releases',
  );
  assert.equal(
    lockCountAfterExplicitRelock,
    1,
    'reacquiring the same key at the very end added no second row, so it really is the same lock',
  );

  const goodEvents = await eventsForAttempt(userId, goodAttemptId);
  assert.ok(
    goodEvents.some((event: any) => event.event_kind === 'not_sent_proven'),
    'the good candidate closed - its own savepoint released rather than rolled back',
  );

  const badEvents = await eventsForAttempt(userId, badAttemptId);
  assert.equal(
    badEvents.length,
    1,
    'the bad candidate is exactly as it was - ROLLBACK TO SAVEPOINT discarded its attempted close',
  );
  assert.equal(badEvents[0]!.event_kind, 'attempt_opened');
});
