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
import { and, eq } from 'drizzle-orm';
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

/* THE FOURTH CASE - "a failing candidate does not roll back a passing one" - IS NOT HERE.
 *
 * It needs a candidate that is selected as a real 'blocked_unverified'/'opened' attempt, passes
 * abandonedPreBoundaryAttemptIsClosable, and only THEN fails while appendSubmissionAttemptEvent
 * tries to write its closing fact. Two ways to construct one were tried against this exact harness
 * and both are unreachable through real data:
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
 * hard to hit. The isolation property is instead covered by a fake-executor unit test right next to
 * the predicate tests - see 'the savepoint isolates one candidate's failure from another's success'
 * in abandonedAttemptClosure.test.ts - which controls exactly one candidate's append to fail without
 * needing an otherwise-unreachable row shape.
 */
