import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../db/schema';

const savedEnv = { ...process.env };
const socketDir = mkdtempSync(join(tmpdir(), 'litos-autofill-submission-evidence-'));

let database: PGlite;
let server: PGLiteSocketServer;
let backendDb: typeof import('../db').db;
let backendPool: typeof import('../db').pool;
let duplicateApplicationVerdict: typeof import('../lib/duplicateApplication').duplicateApplicationVerdict;
let persistAutofillEventWithSubmissionEvidence:
  typeof import('./resume').persistAutofillEventWithSubmissionEvidence;
let submissionAttemptEventId: typeof import('../lib/submissionAttemptLedger').submissionAttemptEventId;
let resolveSubmissionOrphanRisk: typeof import('./submissionOrphanRisks').resolveSubmissionOrphanRisk;
let submissionOrphanRisksFromEvents: typeof import('./submissionOrphanRisks').submissionOrphanRisksFromEvents;

async function createUser(label: string): Promise<string> {
  const userId = randomUUID();
  await backendDb.insert(schema.users).values({
    id: userId,
    email: `${label}-${userId}@example.test`,
  });
  return userId;
}

async function telemetryFor(userId: string) {
  return backendDb.select().from(schema.autofill_events)
    .where(eq(schema.autofill_events.user_id, userId))
    .orderBy(asc(schema.autofill_events.created_at), asc(schema.autofill_events.id));
}

async function attemptEventsFor(userId: string) {
  return backendDb.select().from(schema.application_submission_attempt_events)
    .where(eq(schema.application_submission_attempt_events.user_id, userId))
    .orderBy(
      asc(schema.application_submission_attempt_events.created_at),
      asc(schema.application_submission_attempt_events.id),
    );
}

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
  process.env.VERCEL = '1';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  process.env.ENCRYPTION_KEY = 'autofill-submission-evidence-test-key';

  ({ db: backendDb, pool: backendPool } = await import('../db'));
  ({ duplicateApplicationVerdict } = await import('../lib/duplicateApplication'));
  ({ submissionAttemptEventId } = await import('../lib/submissionAttemptLedger'));
  ({ persistAutofillEventWithSubmissionEvidence } = await import('./resume'));
  ({ resolveSubmissionOrphanRisk, submissionOrphanRisksFromEvents }
    = await import('./submissionOrphanRisks'));
});

after(async () => {
  await backendPool?.end();
  await server?.stop();
  await database?.close();
  rmSync(socketDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

test('false and omitted auto-submit telemetry create no submission-attempt facts', async () => {
  const userId = await createUser('autofill-no-submit');
  await persistAutofillEventWithSubmissionEvidence(userId, {
    ats_name: 'greenhouse',
    job_context: { company: 'Example One', role: 'Engineer' },
    fields_filled: 4,
    fields_skipped: 1,
    auto_submitted: false,
  });
  await persistAutofillEventWithSubmissionEvidence(userId, {
    ats_name: 'workable',
    job_context: { company: 'Example Two', role: 'Analyst' },
    fields_filled: 2,
    fields_skipped: 0,
  });

  const telemetry = await telemetryFor(userId);
  assert.equal(telemetry.length, 2);
  assert.deepEqual(telemetry.map((row) => row.auto_submitted), [false, false]);
  assert.equal((await attemptEventsFor(userId)).length, 0);
});

test('true telemetry writes one frozen attempt opening and press even with zero filled fields', async () => {
  const userId = await createUser('autofill-submit-zero-fields');
  await persistAutofillEventWithSubmissionEvidence(userId, {
    ats_name: 'workable',
    job_context: { company: '  Acme, Inc.  ', role: ' Platform Engineer ' },
    fields_filled: 0,
    fields_skipped: 3,
    auto_submitted: true,
  });

  const telemetry = await telemetryFor(userId);
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0]?.fields_filled, 0);
  assert.equal(telemetry[0]?.auto_submitted, true);

  const events = await attemptEventsFor(userId);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.event_kind), ['attempt_opened', 'press_observed']);
  assert.ok(events[0]);
  assert.ok(events[1]);
  assert.equal(events[0].attempt_id, events[1].attempt_id);
  assert.equal(events[0].packet_id, events[1].packet_id);
  assert.equal(events[0].source, 'chrome_extension');
  assert.equal(events[0].operation, 'initial_submission');
  assert.equal(events[0].application_id, null);
  assert.equal(events[0].submission_run_id, null);
  assert.equal(events[0].submission_claim_id, null);
  assert.equal(events[0].packet_version, null);
  assert.equal(events[0].company_name, 'Acme, Inc.');
  assert.equal(events[0].role, 'Platform Engineer');
  assert.equal(events[0].company_role, 'acme inc|platform engineer');
  assert.equal(events[0].evidence_code, 'autofill_auto_submit_report');
  assert.equal(events[1].evidence_code, 'autofill_auto_submit_click');
  assert.equal(events[0].observed_at.getTime(), events[1].observed_at.getTime());
  assert.equal(events[1].created_at.getTime(), events[0].created_at.getTime() + 1);

  const telemetryId = telemetry[0]!.id;
  const expectedPacketId = submissionAttemptEventId(
    telemetryId,
    'attempt_opened',
    `autofill-synthetic-packet:${userId}`,
  );
  const expectedAttemptId = submissionAttemptEventId(
    telemetryId,
    'attempt_opened',
    `autofill-auto-submit-attempt:${userId}`,
  );
  assert.equal(events[0].packet_id, expectedPacketId);
  assert.equal(events[0].attempt_id, expectedAttemptId);
  assert.notEqual(events[0].packet_id, telemetryId);
  assert.notEqual(events[0].attempt_id, telemetryId);
  assert.notEqual(events[0].packet_id, events[0].attempt_id);
});

test('orphan risks without a durable posting key stay user-wide', async () => {
  const userId = await createUser('autofill-orphan-list');
  await persistAutofillEventWithSubmissionEvidence(userId, {
    ats_name: 'workable',
    job_context: { company: 'Visible Risk Co', role: 'Safety Engineer' },
    fields_filled: 0,
    fields_skipped: 0,
    auto_submitted: true,
  });
  await persistAutofillEventWithSubmissionEvidence(userId, {
    ats_name: 'custom',
    job_context: { company: '', role: '' },
    fields_filled: 0,
    fields_skipped: 0,
    auto_submitted: true,
  });

  const risks = submissionOrphanRisksFromEvents(await attemptEventsFor(userId));
  assert.equal(risks.length, 2);
  assert.equal(risks[0]?.scope, 'user');
  assert.equal(risks[0]?.company, 'Visible Risk Co');
  assert.equal(risks[0]?.resolution_available, true);
  assert.equal(risks[1]?.scope, 'user');
  assert.equal(risks[1]?.company, '');
  assert.equal(new Set(risks.map((risk) => risk.attempt_id)).size, 2);
});

test('a live extension press can be confirmed but never cleared by a later negative answer', async () => {
  const userId = await createUser('autofill-orphan-negative');
  const otherUserId = await createUser('autofill-orphan-negative-other');
  await persistAutofillEventWithSubmissionEvidence(userId, {
    ats_name: 'workable',
    job_context: { company: 'Negative Risk Co', role: 'Platform Engineer' },
    fields_filled: 0,
    fields_skipped: 0,
    auto_submitted: true,
  });
  const [risk] = submissionOrphanRisksFromEvents(await attemptEventsFor(userId));
  assert.ok(risk);

  const concealed = await resolveSubmissionOrphanRisk({
    userId: otherUserId,
    attemptId: risk.attempt_id,
    found: false,
  });
  assert.equal(concealed.kind, 'not_found');

  const beforeResolution = await attemptEventsFor(userId);
  const refusedNegative = await resolveSubmissionOrphanRisk({
    userId,
    attemptId: risk.attempt_id,
    found: false,
    checkedAllPossibleDestinations: true,
  });
  assert.equal(refusedNegative.kind, 'conflict');
  assert.deepEqual(await attemptEventsFor(userId), beforeResolution);
  const stillBlocked = submissionOrphanRisksFromEvents(await attemptEventsFor(userId));
  assert.equal(stillBlocked.length, 1);
  assert.equal(stillBlocked[0]?.blocks_sends, true);
  const missingAttribution = await resolveSubmissionOrphanRisk({
    userId,
    attemptId: risk.attempt_id,
    found: true,
  });
  assert.equal(missingAttribution.kind, 'attribution_required');
  const promoted = await resolveSubmissionOrphanRisk({
    userId,
    attemptId: risk.attempt_id,
    found: true,
    posting: {
      company: 'Negative Risk Co',
      role: 'Platform Engineer',
      portal_url: 'https://apply.workable.com/negative-risk/j/NEGATIVE1/apply/',
    },
  });
  assert.equal(promoted.kind, 'resolved');
  assert.equal(promoted.kind === 'resolved' && promoted.retrySafety.kind, 'blocked_confirmed');

  const downgrade = await resolveSubmissionOrphanRisk({
    userId,
    attemptId: risk.attempt_id,
    found: false,
  });
  assert.equal(downgrade.kind, 'conflict');

  const terminalFacts = (await attemptEventsFor(userId))
    .filter((event) => event.attempt_id === risk.attempt_id
      && event.event_kind === 'not_sent_proven');
  assert.equal(terminalFacts.length, 0);
  const confirmations = (await attemptEventsFor(userId))
    .filter((event) => event.attempt_id === risk.attempt_id
      && event.event_kind === 'submission_confirmed');
  assert.equal(confirmations.length, 1);
});

test('positive orphan resolution confirms only the selected attempt', async () => {
  const userId = await createUser('autofill-orphan-positive');
  for (const role of ['First Engineer', 'Second Engineer']) {
    await persistAutofillEventWithSubmissionEvidence(userId, {
      ats_name: 'workable',
      job_context: { company: 'Independent Risk Co', role },
      fields_filled: 0,
      fields_skipped: 0,
      auto_submitted: true,
    });
  }
  const risks = submissionOrphanRisksFromEvents(await attemptEventsFor(userId));
  assert.equal(risks.length, 2);
  const resolved = await resolveSubmissionOrphanRisk({
    userId,
    attemptId: risks[0]!.attempt_id,
    found: true,
    posting: {
      company: risks[0]!.company,
      role: risks[0]!.role,
      portal_url: 'https://apply.workable.com/independent-risk/j/INDEPENDENT1/apply/',
    },
  });
  assert.equal(resolved.kind, 'resolved');
  assert.equal(
    resolved.kind === 'resolved' && resolved.retrySafety.kind,
    'blocked_confirmed',
  );
  const remaining = submissionOrphanRisksFromEvents(await attemptEventsFor(userId));
  assert.equal(remaining.length, 2);
  const selected = remaining.find((risk) => risk.attempt_id === risks[0]!.attempt_id);
  const untouched = remaining.find((risk) => risk.attempt_id === risks[1]!.attempt_id);
  assert.equal(selected?.reason, 'attributed_confirmed');
  assert.equal(selected?.scope, 'posting');
  assert.equal(selected?.resolution_available, false);
  assert.equal(untouched?.reason, 'pressed');
  assert.equal(untouched?.scope, 'user');
  assert.equal(untouched?.resolution_available, true);
  const opposite = await resolveSubmissionOrphanRisk({
    userId,
    attemptId: risks[0]!.attempt_id,
    found: false,
  });
  assert.equal(opposite.kind, 'conflict');
});

test('blank employer identity creates a user-wide fail-closed duplicate-risk hold', async () => {
  const userId = await createUser('autofill-blank-identity');
  await persistAutofillEventWithSubmissionEvidence(userId, {
    ats_name: 'unknown',
    job_context: { company: '   ', role: '' },
    fields_filled: 0,
    fields_skipped: 0,
    auto_submitted: true,
  });

  const events = await attemptEventsFor(userId);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.company_role, null);
  assert.equal(events[0]?.posting_key, null);
  assert.equal(events[0]?.job_id, null);

  const verdict = await duplicateApplicationVerdict({
    userId,
    applicationId: randomUUID(),
    jobContext: { company: 'Different Company', role: 'Different Role' },
    portalUrl: 'https://jobs.example.test/different-role',
  });
  assert.equal(verdict.kind, 'unidentifiable');
  if (verdict.kind === 'unidentifiable') {
    assert.equal(verdict.application_id, events[0]?.packet_id);
    assert.match(verdict.reason, /cannot be safely compared/i);
  }
});

test('separate true telemetry rows create separate attempt and packet identities', async () => {
  const userId = await createUser('autofill-distinct-attempts');
  const body = {
    ats_name: 'lever',
    job_context: { company: 'Distinct Co', role: 'Developer' },
    fields_filled: 5,
    fields_skipped: 0,
    auto_submitted: true as const,
  };
  await persistAutofillEventWithSubmissionEvidence(userId, body);
  await persistAutofillEventWithSubmissionEvidence(userId, body);

  const telemetry = await telemetryFor(userId);
  const events = await attemptEventsFor(userId);
  assert.equal(telemetry.length, 2);
  assert.equal(events.length, 4);
  assert.equal(new Set(events.map((event) => event.attempt_id)).size, 2);
  assert.equal(new Set(events.map((event) => event.packet_id)).size, 2);
  assert.equal(new Set(events.map((event) => event.event_id)).size, 4);
});

test('an exact stable client event replay writes one telemetry row and one ledger attempt', async () => {
  const userId = await createUser('autofill-stable-replay');
  const clientEventId = randomUUID();
  const body = {
    client_event_id: clientEventId,
    ats_name: 'workable',
    job_context: { company: 'Stable Retry Co', role: 'Systems Engineer' },
    fields_filled: 6,
    fields_skipped: 1,
    auto_submitted: true as const,
    r030_candidate_labels: ['Portfolio URL'],
  };

  await persistAutofillEventWithSubmissionEvidence(userId, body);
  await persistAutofillEventWithSubmissionEvidence(userId, body);

  const telemetry = await telemetryFor(userId);
  const events = await attemptEventsFor(userId);
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0]?.id, clientEventId);
  assert.equal(events.length, 2);
  assert.equal(new Set(events.map((event) => event.attempt_id)).size, 1);
  assert.equal(new Set(events.map((event) => event.packet_id)).size, 1);
});

test('a stable client event replay also deduplicates non-submission telemetry', async () => {
  const userId = await createUser('autofill-stable-no-submit');
  const body = {
    client_event_id: randomUUID(),
    ats_name: 'greenhouse',
    job_context: { company: 'Stable No Submit Co', role: 'Analyst' },
    fields_filled: 3,
    fields_skipped: 2,
    auto_submitted: false as const,
  };

  await persistAutofillEventWithSubmissionEvidence(userId, body);
  await persistAutofillEventWithSubmissionEvidence(userId, body);

  assert.equal((await telemetryFor(userId)).length, 1);
  assert.equal((await attemptEventsFor(userId)).length, 0);
});

test('a reused client event ID with different data is rejected without mutating telemetry or ledger', async () => {
  const userId = await createUser('autofill-stable-conflict');
  const otherUserId = await createUser('autofill-stable-conflict-other');
  const clientEventId = randomUUID();
  const body = {
    client_event_id: clientEventId,
    ats_name: 'lever',
    job_context: { company: 'Conflict Co', role: 'Developer' },
    fields_filled: 5,
    fields_skipped: 0,
    auto_submitted: true as const,
  };
  await persistAutofillEventWithSubmissionEvidence(userId, body);

  await assert.rejects(
    persistAutofillEventWithSubmissionEvidence(userId, {
      ...body,
      fields_filled: body.fields_filled + 1,
    }),
    (error: unknown) => error instanceof Error
      && error.name === 'AutofillEventIdConflictError'
      && 'code' in error
      && error.code === 'AUTOFILL_EVENT_ID_CONFLICT',
  );
  await assert.rejects(
    persistAutofillEventWithSubmissionEvidence(otherUserId, body),
    (error: unknown) => error instanceof Error
      && error.name === 'AutofillEventIdConflictError',
  );

  assert.equal((await telemetryFor(userId)).length, 1);
  assert.equal((await attemptEventsFor(userId)).length, 2);
  assert.equal((await telemetryFor(otherUserId)).length, 0);
  assert.equal((await attemptEventsFor(otherUserId)).length, 0);
});

test('a ledger append failure rolls back the true telemetry insert', async () => {
  const userId = await createUser('autofill-atomic-rollback');
  const before = await telemetryFor(userId);
  assert.equal(before.length, 0);

  await database.exec('drop table application_submission_attempt_events cascade');
  await assert.rejects(
    persistAutofillEventWithSubmissionEvidence(userId, {
      ats_name: 'workable',
      job_context: { company: 'Rollback Co', role: 'Safety Engineer' },
      fields_filled: 1,
      fields_skipped: 0,
      auto_submitted: true,
    }),
    /application_submission_attempt_events/i,
  );

  const afterFailure = await telemetryFor(userId);
  assert.equal(afterFailure.length, 0, 'telemetry and submission evidence must commit or roll back together');
});
