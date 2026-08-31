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
import type { SubmissionAttemptBinding } from '../lib/submissionAttemptLedger';

const savedEnv = { ...process.env };
const socketDir = mkdtempSync(join(tmpdir(), 'litos-boundary-ledger-'));
let database: PGlite;
let server: PGLiteSocketServer;
let backendDb: any;
let backendPool: { end(): Promise<void> };
let appendSubmissionAttemptEvent:
  typeof import('../lib/submissionAttemptLedger').appendSubmissionAttemptEvent;
let authorizeFinalSubmissionBoundary:
  typeof import('../lib/submissionAttemptLedger').authorizeFinalSubmissionBoundary;
let freezePostingIdentity: typeof import('../lib/submissionAttemptLedger').freezePostingIdentity;
let submissionAttemptEventId: typeof import('../lib/submissionAttemptLedger').submissionAttemptEventId;

before(async () => {
  database = await PGlite.create();
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await database.exec(statement);
  server = new PGLiteSocketServer({
    db: database,
    path: join(socketDir, '.s.PGSQL.5432'),
    maxConnections: 10,
  });
  await server.start();
  process.env.NODE_ENV = 'test';
  process.env.VERCEL = '1';
  process.env.LOG_LEVEL = 'silent';
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  ({ db: backendDb, pool: backendPool } = await import('../db'));
  ({
    appendSubmissionAttemptEvent,
    authorizeFinalSubmissionBoundary,
    freezePostingIdentity,
    submissionAttemptEventId,
  } = await import('../lib/submissionAttemptLedger'));
});

after(async () => {
  await backendPool?.end();
  await server?.stop();
  await database.close();
  rmSync(socketDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

async function openedBinding(): Promise<SubmissionAttemptBinding> {
  const userId = randomUUID();
  await backendDb.insert(schema.users).values({
    id: userId,
    email: `boundary-${userId}@example.test`,
  });
  const attemptId = randomUUID();
  const binding: SubmissionAttemptBinding = {
    attemptId,
    userId,
    packetId: randomUUID(),
    applicationId: randomUUID(),
    source: 'managed_browser',
    operation: 'initial_submission',
    postingIdentity: freezePostingIdentity({
      company: 'Example Company',
      role: 'Example Role',
      job_id: randomUUID(),
    }, 'https://apply.workable.com/example/j/A1B2C3D4E5/apply/'),
    submissionRunId: randomUUID(),
    submissionClaimId: attemptId,
    packetVersion: 'packet-v1',
  };
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(attemptId, 'attempt_opened', 'reservation'),
    eventKind: 'attempt_opened',
    evidenceCode: 'atomic_claim_reserved',
  });
  return binding;
}

test('one database-clock boundary activation wins and exact retries reuse only that lease', async () => {
  const binding = await openedBinding();
  const activationId = randomUUID();
  const first = await backendDb.transaction((tx: any) => authorizeFinalSubmissionBoundary(binding, {
    executor: tx,
    factKey: 'managed-final-boundary',
    activationId,
    evidenceCode: 'managed_browser_employer_boundary_authorized',
  }));
  assert.equal(first.kind, 'fresh');

  const replay = await backendDb.transaction((tx: any) => authorizeFinalSubmissionBoundary(binding, {
    executor: tx,
    factKey: 'managed-final-boundary',
    activationId,
    evidenceCode: 'managed_browser_employer_boundary_authorized',
  }));
  assert.equal(replay.kind, 'existing');
  if (first.kind !== 'fresh' || replay.kind !== 'existing') return;
  assert.equal(replay.authorization.activationId, first.authorization.activationId);
  assert.equal(replay.authorization.leaseId, first.authorization.leaseId);

  const rows = await backendDb.select().from(schema.application_submission_attempt_events).where(and(
    eq(schema.application_submission_attempt_events.user_id, binding.userId),
    eq(schema.application_submission_attempt_events.attempt_id, binding.attemptId),
    eq(schema.application_submission_attempt_events.event_kind, 'boundary_authorized'),
  ));
  assert.equal(rows.length, 1);
});

test('a different execution activation cannot reuse an existing boundary lease', async () => {
  const binding = await openedBinding();
  await backendDb.transaction((tx: any) => authorizeFinalSubmissionBoundary(binding, {
    executor: tx,
    factKey: 'managed-final-boundary',
    activationId: randomUUID(),
    evidenceCode: 'managed_browser_employer_boundary_authorized',
  }));
  const conflict = await backendDb.transaction((tx: any) => authorizeFinalSubmissionBoundary(binding, {
    executor: tx,
    factKey: 'managed-final-boundary',
    activationId: randomUUID(),
    evidenceCode: 'managed_browser_employer_boundary_authorized',
  }));
  assert.equal(conflict.kind, 'activation_conflict');
});
