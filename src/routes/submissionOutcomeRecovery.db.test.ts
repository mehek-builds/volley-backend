import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { SubmissionAttemptBinding } from '../lib/submissionAttemptLedger';
const savedEnv = { ...process.env };
const directory = mkdtempSync(join(tmpdir(), 'litos-outcome-recovery-'));
const app = Fastify({ logger: false });
let database: PGlite;
let server: PGLiteSocketServer;
let db: any;
let pool: { end(): Promise<void> };
let ledger: typeof import('../lib/submissionAttemptLedger');
let recover: typeof import('./submissionRunner').recoverUnverifiedSubmission;
before(async () => {
  database = await PGlite.create();
  for (const statement of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await database.exec(statement);
  server = new PGLiteSocketServer({ db: database, path: join(directory, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();
  process.env.NODE_ENV = 'test';
  process.env.VERCEL = '1';
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${directory}`;
  ({ db, pool } = await import('../db'));
  ledger = await import('../lib/submissionAttemptLedger');
  ({ recoverUnverifiedSubmission: recover } = await import('./submissionRunner'));
});
after(async () => {
  await app.close(); await pool?.end(); await server?.stop(); await database?.close();
  rmSync(directory, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});
async function seed(withBoundary = true) {
  const userId = randomUUID(), packetId = randomUUID(), attemptId = randomUUID(), runId = randomUUID();
  const at = new Date().toISOString();
  await db.insert(schema.users).values({ id: userId, email: `${userId}@example.test` });
  await db.insert(schema.generated_resumes).values({ id: packetId, user_id: userId,
    job_context: { company: 'Example', role: 'Intern' }, resume_object_key: 'test.pdf',
    spec: { _review: { jd_text: 'Intern', questions: [], edited_terms: [], skipped_reasons: [], updated_at: at,
      status: 'needs_attention', submission_claim_id: attemptId, submission_run_id: runId, submission_claimed_at: at,
      unverified_submission: { at, cause: 'no_confirmation_state' } } } });
  const binding: SubmissionAttemptBinding = { userId, packetId, attemptId, submissionRunId: runId,
    submissionClaimId: attemptId, source: 'managed_browser', operation: 'initial_submission',
    postingIdentity: ledger.freezePostingIdentity({ company: 'Example', role: 'Intern' }, 'https://jobs.lever.co/example/job/apply') };
  await ledger.appendSubmissionAttemptEvent({ ...binding, eventKind: 'attempt_opened',
    eventId: ledger.submissionAttemptEventId(attemptId, 'attempt_opened', 'reservation'), evidenceCode: 'atomic_claim_reserved' });
  if (withBoundary) await db.transaction((tx: any) => ledger.authorizeFinalSubmissionBoundary(binding, {
    executor: tx, factKey: 'managed-final-boundary', activationId: randomUUID(), evidenceCode: 'managed_browser_employer_boundary_authorized' }));
  return { packetId, binding, at };
}
async function review(packetId: string) {
  const [row] = await db.select().from(schema.generated_resumes).where(eq(schema.generated_resumes.id, packetId));
  return row.spec._review;
}
test('two workers lease one attempt, preserve original uncertainty, and never authorize another send', async () => {
  const { packetId, binding, at } = await seed();
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const deps = { recoverTerminal: async (...args: Parameters<typeof import('./submissionRunner').recoverManagedSubmissionTerminalResult>) => {
    calls++; assert.equal(args[2].attemptId, binding.attemptId); entered(); await held; return 'folded' as const;
  } };
  const first = recover(packetId, app, deps);
  await started;
  await recover(packetId, app, deps);
  release(); await first;
  assert.equal(calls, 1);
  const current = await review(packetId);
  assert.equal(current.status, 'needs_attention');
  assert.equal(current.submission_claim_id, binding.attemptId);
  assert.equal(current.unverified_submission.at, at);
  assert.equal(current.outcome_recovery.checks, 1);
  await recover(packetId, app, deps);
  assert.equal(calls, 1, 'backoff persists across calls');
  const events = await ledger.submissionAttemptEventsForPacket(binding.userId, packetId);
  assert.deepEqual(events.map((event) => event.event_kind).sort(), ['attempt_opened', 'boundary_authorized']);
});
test('a concurrent confirmation wins over the recovery finalizer', async () => {
  const { packetId } = await seed();
  await recover(packetId, app, { recoverTerminal: async () => {
    await db.update(schema.generated_resumes).set({ spec: sql`jsonb_set(${schema.generated_resumes.spec}, '{_review,status}', '"submitted"'::jsonb)` }).where(eq(schema.generated_resumes.id, packetId));
    return 'folded';
  } });
  assert.equal((await review(packetId)).status, 'submitted');
});
test('no boundary evidence means no provider call', async () => {
  const { packetId } = await seed(false);
  await recover(packetId, app, { recoverTerminal: async () => { assert.fail('must not contact provider'); } });
  assert.equal((await review(packetId)).outcome_recovery, undefined);
});
