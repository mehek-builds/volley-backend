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
let submissionBoundaryAuthorization:
  typeof import('../lib/submissionAttemptLedger').submissionBoundaryAuthorization;
let freezePostingIdentity: typeof import('../lib/submissionAttemptLedger').freezePostingIdentity;
let submissionAttemptEventId: typeof import('../lib/submissionAttemptLedger').submissionAttemptEventId;
let lockSubmissionAttemptUser: typeof import('../lib/submissionAttemptLedger').lockSubmissionAttemptUser;
let duplicateApplicationVerdict: typeof import('../lib/duplicateApplication').duplicateApplicationVerdict;
let canonicalApplicationForNewPacketAttempt:
  typeof import('../lib/canonicalPacketBinding').canonicalApplicationForNewPacketAttempt;
let reserveBrowserProviderResource:
  typeof import('../lib/browserProviderResourceCleanup').reserveBrowserProviderResource;
let createFencedBrowserSession:
  typeof import('../lib/browserProviderResourceCleanup').createFencedBrowserSession;
let drainBrowserProviderResourcesBeforeAccountDeletion:
  typeof import('../lib/browserProviderResourceCleanup').drainBrowserProviderResourcesBeforeAccountDeletion;

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
    submissionBoundaryAuthorization,
    freezePostingIdentity,
    submissionAttemptEventId,
    lockSubmissionAttemptUser,
  } = await import('../lib/submissionAttemptLedger'));
  ({ duplicateApplicationVerdict } = await import('../lib/duplicateApplication'));
  ({ canonicalApplicationForNewPacketAttempt } = await import('../lib/canonicalPacketBinding'));
  ({
    reserveBrowserProviderResource,
    createFencedBrowserSession,
    drainBrowserProviderResourcesBeforeAccountDeletion,
  } = await import('../lib/browserProviderResourceCleanup'));
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

test('the database clock expires the exact retained capability lease before disclosure', async () => {
  const binding = await openedBinding();
  const opened = await backendDb.transaction((tx: any) => authorizeFinalSubmissionBoundary(binding, {
    executor: tx,
    factKey: 'retained-debugger-boundary',
    activationId: randomUUID(),
    evidenceCode: 'retained_debugger_boundary_authorized',
    ttlMs: 5,
  }));
  assert.equal(opened.kind, 'fresh');
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  const current = await backendDb.transaction(async (tx: any) => {
    await lockSubmissionAttemptUser(tx, binding.userId);
    return submissionBoundaryAuthorization(binding.userId, binding.attemptId, { executor: tx });
  });
  assert.ok(current);
  assert.equal(current.active, false);
  if (opened.kind === 'fresh') {
    assert.equal(current.leaseId, opened.authorization.leaseId);
    assert.equal(current.activationId, opened.authorization.activationId);
    assert.ok(Date.parse(current.serverNow) >= Date.parse(current.expiresAt));
  }
});

test('an account-deletion drain fences opened and future employer capabilities under the user lock', async () => {
  const opened = await openedBinding();
  await backendDb.transaction(async (tx: any) => {
    await lockSubmissionAttemptUser(tx, opened.userId);
    await tx.insert(schema.managed_submission_account_deletion_drains).values({
      user_id: opened.userId,
    });
  });
  const isDeletionDrain = (error: unknown) => (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'SUBMISSION_ACCOUNT_DELETION_DRAINING'
  );
  await assert.rejects(
    backendDb.transaction((tx: any) => authorizeFinalSubmissionBoundary(opened, {
      executor: tx,
      factKey: 'managed-final-boundary',
      activationId: randomUUID(),
      evidenceCode: 'managed_browser_employer_boundary_authorized',
    })),
    isDeletionDrain,
  );

  const nextAttemptId = randomUUID();
  await assert.rejects(appendSubmissionAttemptEvent({
    ...opened,
    attemptId: nextAttemptId,
    submissionClaimId: nextAttemptId,
    eventId: submissionAttemptEventId(nextAttemptId, 'attempt_opened', 'reservation'),
    eventKind: 'attempt_opened',
    evidenceCode: 'atomic_claim_reserved',
  }), isDeletionDrain);
  const events = await backendDb.select().from(schema.application_submission_attempt_events).where(and(
    eq(schema.application_submission_attempt_events.user_id, opened.userId),
    eq(schema.application_submission_attempt_events.attempt_id, opened.attemptId),
  ));
  assert.deepEqual(events.map((event: { event_kind: string }) => event.event_kind), ['attempt_opened']);
});

test('a provider creation reservation survives its crash window and a queued creator loses to deletion', async () => {
  const userId = randomUUID();
  await backendDb.insert(schema.users).values({
    id: userId,
    email: `provider-cleanup-${userId}@example.test`,
  });
  const durable = await reserveBrowserProviderResource({
    userId,
    provider: 'browserbase',
    resourceType: 'session',
  });
  const [cleanup] = await backendDb.select().from(schema.browser_provider_resource_cleanups)
    .where(eq(schema.browser_provider_resource_cleanups.id, durable.reservationId)).limit(1);
  assert.equal(cleanup.user_id, userId);
  assert.equal(cleanup.provider_resource_id, null);
  assert.equal(cleanup.provider_confirmed_gone_at, null);

  let reportLocked!: () => void;
  let releaseLock!: () => void;
  const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
  const lockGate = new Promise<void>((resolve) => { releaseLock = resolve; });
  const deletion = backendDb.transaction(async (tx: any) => {
    await lockSubmissionAttemptUser(tx, userId);
    reportLocked();
    await lockGate;
    await tx.insert(schema.managed_submission_account_deletion_drains).values({ user_id: userId });
  });
  await locked;
  const queuedCreation = reserveBrowserProviderResource({
    userId,
    provider: 'browserbase',
    resourceType: 'session',
  });
  const queuedRefusal = assert.rejects(
    queuedCreation,
    (error: unknown) => typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'SUBMISSION_ACCOUNT_DELETION_DRAINING',
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseLock();
  await deletion;
  await queuedRefusal;
  const obligations = await backendDb.select().from(schema.browser_provider_resource_cleanups)
    .where(eq(schema.browser_provider_resource_cleanups.user_id, userId));
  assert.equal(obligations.length, 1, 'the pre-POST cleanup obligation must remain independently durable');
});

test('provider POST binds its exact durable cleanup obligation before returning the capability', async () => {
  const userId = randomUUID();
  const sessionId = `provider-session-${userId}`;
  await backendDb.insert(schema.users).values({
    id: userId,
    email: `provider-post-fence-${userId}@example.test`,
  });
  const previousKey = process.env.BROWSERBASE_API_KEY;
  const previousProvider = process.env.BROWSER_PROVIDER;
  const previousFetch = globalThis.fetch;
  process.env.BROWSERBASE_API_KEY = 'browserbase-create-fence-test-key';
  process.env.BROWSER_PROVIDER = 'browserbase';
  let providerPostObserved = false;
  try {
    globalThis.fetch = (async (input, init) => {
      assert.match(String(input), /\/sessions$/);
      assert.equal(init?.method, 'POST');
      providerPostObserved = true;
      return new Response(JSON.stringify({ id: sessionId }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const session = await createFencedBrowserSession({
      userId,
      provider: 'browserbase',
      portalUrl: 'https://boards.greenhouse.io/example/jobs/123',
    });
    assert.equal(session.id, sessionId);
    assert.equal(providerPostObserved, true);
    const [cleanup] = await backendDb.select().from(schema.browser_provider_resource_cleanups)
      .where(eq(schema.browser_provider_resource_cleanups.user_id, userId)).limit(1);
    assert.equal(cleanup.provider_resource_id, sessionId);
    assert.equal(cleanup.provider_confirmed_gone_at, null);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.BROWSERBASE_API_KEY;
    else process.env.BROWSERBASE_API_KEY = previousKey;
    if (previousProvider === undefined) delete process.env.BROWSER_PROVIDER;
    else process.env.BROWSER_PROVIDER = previousProvider;
  }
});

test('account cleanup stays pending until the provider confirms the exact session is gone', async () => {
  const userId = randomUUID();
  const cleanupId = randomUUID();
  const sessionId = 'browserbase-session-for-deletion';
  await backendDb.insert(schema.users).values({
    id: userId,
    email: `provider-release-${userId}@example.test`,
  });
  await backendDb.insert(schema.browser_provider_resource_cleanups).values({
    id: cleanupId,
    user_id: userId,
    provider: 'browserbase',
    resource_type: 'session',
    provider_resource_id: sessionId,
    creation_expires_at: new Date(),
  });
  const previousKey = process.env.BROWSERBASE_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.BROWSERBASE_API_KEY = 'browserbase-cleanup-test-key';
  let terminal = false;
  const requests: Array<{ method: string; url: string }> = [];
  try {
    globalThis.fetch = (async (input, init) => {
      const method = init?.method ?? 'GET';
      requests.push({ method, url: String(input) });
      if (method === 'POST') {
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        id: sessionId,
        status: terminal ? 'COMPLETED' : 'REQUEST_RELEASE',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const pending = await drainBrowserProviderResourcesBeforeAccountDeletion(userId);
    assert.deepEqual(pending, { ready: false, pending: 1, confirmed: 0 });
    const [stillOutstanding] = await backendDb.select().from(schema.browser_provider_resource_cleanups)
      .where(eq(schema.browser_provider_resource_cleanups.id, cleanupId)).limit(1);
    assert.ok(stillOutstanding.release_requested_at);
    assert.equal(stillOutstanding.provider_confirmed_gone_at, null);

    terminal = true;
    const completed = await drainBrowserProviderResourcesBeforeAccountDeletion(userId);
    assert.deepEqual(completed, { ready: true, pending: 0, confirmed: 1 });
    const [gone] = await backendDb.select().from(schema.browser_provider_resource_cleanups)
      .where(eq(schema.browser_provider_resource_cleanups.id, cleanupId)).limit(1);
    assert.ok(gone.provider_confirmed_gone_at);
    assert.equal(requests.some((request) => request.method === 'POST'), true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.BROWSERBASE_API_KEY;
    else process.env.BROWSERBASE_API_KEY = previousKey;
  }
});

test('a crashed create is cleared only after an expired reservation query finds no provider session', async () => {
  const userId = randomUUID();
  const cleanupId = randomUUID();
  await backendDb.insert(schema.users).values({
    id: userId,
    email: `provider-create-crash-${userId}@example.test`,
  });
  await backendDb.insert(schema.browser_provider_resource_cleanups).values({
    id: cleanupId,
    user_id: userId,
    provider: 'browserbase',
    resource_type: 'session',
    creation_expires_at: new Date('2020-01-01T00:00:00.000Z'),
  });
  const previousKey = process.env.BROWSERBASE_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.BROWSERBASE_API_KEY = 'browserbase-cleanup-test-key';
  try {
    globalThis.fetch = (async (input) => {
      assert.match(String(input), /\/sessions\?q=/);
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    assert.deepEqual(
      await drainBrowserProviderResourcesBeforeAccountDeletion(userId),
      { ready: true, pending: 0, confirmed: 1 },
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.BROWSERBASE_API_KEY;
    else process.env.BROWSERBASE_API_KEY = previousKey;
  }
});

test('an ambiguous recovered create atomically persists every exact remote cleanup obligation', async () => {
  const userId = randomUUID();
  const cleanupId = randomUUID();
  await backendDb.insert(schema.users).values({
    id: userId,
    email: `provider-create-multiple-${userId}@example.test`,
  });
  await backendDb.insert(schema.browser_provider_resource_cleanups).values({
    id: cleanupId,
    user_id: userId,
    provider: 'browserbase',
    resource_type: 'session',
    creation_expires_at: new Date('2020-01-01T00:00:00.000Z'),
  });
  const previousKey = process.env.BROWSERBASE_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.BROWSERBASE_API_KEY = 'browserbase-multiple-cleanup-test-key';
  try {
    globalThis.fetch = (async (input) => {
      assert.match(String(input), /\/sessions\?q=/);
      return new Response(JSON.stringify([
        { id: 'ambiguous-session-a' },
        { id: 'ambiguous-session-b' },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    assert.deepEqual(
      await drainBrowserProviderResourcesBeforeAccountDeletion(userId),
      { ready: false, pending: 2, confirmed: 0 },
    );
    const cleanups = await backendDb.select().from(schema.browser_provider_resource_cleanups)
      .where(eq(schema.browser_provider_resource_cleanups.user_id, userId));
    const abstractReservation = cleanups.find((cleanup: any) => cleanup.id === cleanupId);
    assert.ok(abstractReservation?.provider_confirmed_gone_at);
    assert.deepEqual(
      cleanups
        .filter((cleanup: any) => cleanup.id !== cleanupId)
        .map((cleanup: any) => cleanup.provider_resource_id)
        .sort(),
      ['ambiguous-session-a', 'ambiguous-session-b'],
    );
    assert.equal(
      cleanups.filter((cleanup: any) => cleanup.id !== cleanupId)
        .every((cleanup: any) => cleanup.provider_confirmed_gone_at === null),
      true,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.BROWSERBASE_API_KEY;
    else process.env.BROWSERBASE_API_KEY = previousKey;
  }
});

test('a retained-session capability commits duplicate clearance, canonical binding, claim, opening, and boundary together', async () => {
  const userId = randomUUID();
  const packetId = randomUUID();
  const applicationId = randomUUID();
  const jobId = randomUUID();
  const attemptId = randomUUID();
  const portalUrl = 'https://job-boards.greenhouse.io/example/jobs/24680';
  const review = {
    jd_text: 'Build reliable systems',
    status: 'needs_attention',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: '2026-08-31T10:00:00.000Z',
    portal_url: portalUrl,
    browser_session_id: 'retained-browserbase-session',
  };
  await backendDb.insert(schema.users).values({
    id: userId,
    email: `retained-${userId}@example.test`,
  });
  await backendDb.insert(schema.generated_resumes).values({
    id: packetId,
    user_id: userId,
    job_context: { company: 'Example Company', role: 'Engineer', job_id: jobId },
    spec: { _review: review },
    resume_object_key: `users/${userId}/resumes/${packetId}.pdf`,
  });
  await backendDb.insert(schema.applications).values({
    id: applicationId,
    user_id: userId,
    legacy_generated_resume_id: packetId,
    job_id: jobId,
    company_scope_key: 'domain:example.test',
    company_name: 'Example Company',
    role: 'Engineer',
    portal_url: portalUrl,
    source_surface: 'dashboard',
    application_fingerprint: `retained-${applicationId}`,
  });
  const postingIdentity = freezePostingIdentity(
    { company: 'Example Company', role: 'Engineer', job_id: jobId },
    portalUrl,
  );
  const binding = await backendDb.transaction(async (tx: any) => {
    await lockSubmissionAttemptUser(tx, userId);
    const duplicate = await duplicateApplicationVerdict({
      userId,
      applicationId: packetId,
      jobContext: { company: 'Example Company', role: 'Engineer', job_id: jobId },
      portalUrl,
    }, tx);
    assert.equal(duplicate.kind, 'clear');
    const canonical = await canonicalApplicationForNewPacketAttempt(tx, {
      userId,
      packetId,
      postingIdentity,
    });
    assert.equal(canonical.id, applicationId);
    const claimedReview = {
      ...review,
      submission_claimed_at: '2026-08-31T10:00:01.000Z',
      submission_claim_id: attemptId,
      submission_packet_version: 'packet-v1',
    };
    const [claimed] = await tx.update(schema.generated_resumes).set({
      spec: { _review: claimedReview },
    }).where(and(
      eq(schema.generated_resumes.id, packetId),
      eq(schema.generated_resumes.user_id, userId),
    )).returning();
    assert.ok(claimed);
    const exactBinding: SubmissionAttemptBinding = {
      attemptId,
      userId,
      packetId,
      applicationId,
      parentAttemptId: null,
      source: 'attended_handoff',
      operation: 'manual_submission',
      postingIdentity,
      submissionRunId: null,
      submissionClaimId: attemptId,
      packetVersion: 'packet-v1',
    };
    await appendSubmissionAttemptEvent({
      ...exactBinding,
      eventId: submissionAttemptEventId(attemptId, 'attempt_opened', 'manual-handoff-reservation'),
      eventKind: 'attempt_opened',
      evidenceCode: 'attended_handoff_capability_v1:manual_handoff:test:packet-v1',
    }, { executor: tx });
    const authorization = await authorizeFinalSubmissionBoundary(exactBinding, {
      executor: tx,
      factKey: 'manual-handoff-boundary',
      evidenceCode: 'attended_handoff_employer_boundary_authorized',
    });
    assert.equal(authorization.kind, 'fresh');
    return exactBinding;
  });

  const [stored] = await backendDb.select().from(schema.generated_resumes)
    .where(eq(schema.generated_resumes.id, packetId)).limit(1);
  const storedReview = (stored.spec as { _review: Record<string, unknown> })._review;
  assert.equal(storedReview.submission_claim_id, attemptId);
  const events = await backendDb.select().from(schema.application_submission_attempt_events).where(and(
    eq(schema.application_submission_attempt_events.user_id, userId),
    eq(schema.application_submission_attempt_events.attempt_id, binding.attemptId),
  ));
  assert.deepEqual(events.map((event: { event_kind: string }) => event.event_kind).sort(), [
    'attempt_opened',
    'boundary_authorized',
  ]);
});
