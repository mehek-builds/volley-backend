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
const socketDir = mkdtempSync(join(tmpdir(), 'litos-orphan-attribution-'));

let database: PGlite;
let server: PGLiteSocketServer;
let backendDb: typeof import('../db').db;
let backendPool: typeof import('../db').pool;
let appendSubmissionAttemptEvent:
  typeof import('../lib/submissionAttemptLedger').appendSubmissionAttemptEvent;
let duplicateApplicationVerdict:
  typeof import('../lib/duplicateApplication').duplicateApplicationVerdict;
let freezePostingIdentity:
  typeof import('../lib/submissionAttemptLedger').freezePostingIdentity;
let submissionAttemptEventId:
  typeof import('../lib/submissionAttemptLedger').submissionAttemptEventId;
let resolveSubmissionOrphanRisk:
  typeof import('./submissionOrphanRisks').resolveSubmissionOrphanRisk;
let submissionOrphanRisksFromEvents:
  typeof import('./submissionOrphanRisks').submissionOrphanRisksFromEvents;

type SubmissionAttemptBinding = import('../lib/submissionAttemptLedger').SubmissionAttemptBinding;

const ORPHAN_OPENING_EVIDENCE = 'applicant_attributed_orphan_opening';
const ORPHAN_CONFIRMATION_EVIDENCE = 'applicant_attributed_orphan_confirmation';

async function createUser(label: string): Promise<string> {
  const userId = randomUUID();
  await backendDb.insert(schema.users).values({
    id: userId,
    email: `${label}-${userId}@example.test`,
  });
  return userId;
}

async function eventsFor(userId: string) {
  return backendDb.select().from(schema.application_submission_attempt_events)
    .where(eq(schema.application_submission_attempt_events.user_id, userId))
    .orderBy(
      asc(schema.application_submission_attempt_events.created_at),
      asc(schema.application_submission_attempt_events.id),
    );
}

async function blankLegacyParent(
  userId: string,
  confirmed = true,
  labels?: { company: string; role: string },
) {
  const attemptId = randomUUID();
  const packetId = randomUUID();
  const baseTime = Date.now();
  const binding: SubmissionAttemptBinding = {
    attemptId,
    userId,
    packetId,
    applicationId: null,
    parentAttemptId: null,
    source: 'legacy_backfill',
    operation: 'initial_submission',
    postingIdentity: labels
      ? freezePostingIdentity(labels, null)
      : {
        postingKey: null,
        jobId: null,
        companyRole: null,
        company: '',
        role: '',
        portalUrl: null,
        portalIdentity: null,
      },
    submissionRunId: null,
    submissionClaimId: null,
    packetVersion: null,
  };
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(attemptId, 'attempt_opened', 'legacy-blank-opening'),
    eventKind: 'attempt_opened',
    evidenceCode: 'legacy_autofill_auto_submit_report',
    observedAt: new Date(baseTime),
    createdAt: new Date(baseTime),
  });
  if (confirmed) {
    await appendSubmissionAttemptEvent({
      ...binding,
      eventId: submissionAttemptEventId(attemptId, 'submission_confirmed', 'legacy-blank-confirmation'),
      eventKind: 'submission_confirmed',
      evidenceCode: 'legacy_autofill_auto_submit_confirmation',
      observedAt: new Date(baseTime + 1),
      createdAt: new Date(baseTime + 1),
    });
  }
  return { binding, attemptId, packetId };
}

function posting(company: string, role: string, tenant: string, jobId: string) {
  return {
    company,
    role,
    portal_url: `https://apply.workable.com/${tenant}/j/${jobId}/apply/`,
    job_id: jobId,
  };
}

async function appendAttributionChild(input: {
  parent: SubmissionAttemptBinding;
  posting: ReturnType<typeof posting>;
  userId?: string;
  includeConfirmation?: boolean;
  attemptId?: string;
}) {
  const attemptId = input.attemptId ?? randomUUID();
  const userId = input.userId ?? input.parent.userId;
  const baseTime = Date.now();
  const identity = freezePostingIdentity(
    {
      company: input.posting.company,
      role: input.posting.role,
      job_id: input.posting.job_id,
    },
    input.posting.portal_url,
  );
  const binding: SubmissionAttemptBinding = {
    attemptId,
    userId,
    packetId: input.parent.packetId,
    applicationId: null,
    parentAttemptId: input.parent.attemptId,
    source: 'attended_handoff',
    operation: 'initial_submission',
    postingIdentity: identity,
    submissionRunId: null,
    submissionClaimId: null,
    packetVersion: null,
  };
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(attemptId, 'attempt_opened', 'attribution-opening'),
    eventKind: 'attempt_opened',
    evidenceCode: ORPHAN_OPENING_EVIDENCE,
    observedAt: new Date(baseTime),
    createdAt: new Date(baseTime),
  });
  if (input.includeConfirmation !== false) {
    await appendSubmissionAttemptEvent({
      ...binding,
      eventId: submissionAttemptEventId(attemptId, 'submission_confirmed', 'attribution-confirmation'),
      eventKind: 'submission_confirmed',
      evidenceCode: ORPHAN_CONFIRMATION_EVIDENCE,
      observedAt: new Date(baseTime + 1),
      createdAt: new Date(baseTime + 1),
    });
  }
  return binding;
}

async function assertUserWideHold(userId: string, parentAttemptId: string) {
  const events = await eventsFor(userId);
  const risks = submissionOrphanRisksFromEvents(events);
  const parentRisk = risks.find((risk) => risk.attempt_id === parentAttemptId);
  assert.ok(parentRisk, 'the identity-less parent must remain visible');
  assert.equal(parentRisk.scope, 'user');
  if (events.some((event) => event.parent_attempt_id === parentAttemptId)) {
    assert.equal(
      parentRisk.resolution_available,
      false,
      'a malformed existing attribution must not offer controls that can only conflict',
    );
  }

  const verdict = await duplicateApplicationVerdict({
    userId,
    applicationId: randomUUID(),
    jobContext: { company: 'Completely Unrelated Co', role: 'Unrelated Role' },
    portalUrl: 'https://apply.workable.com/unrelated/j/UNRELATED01/apply/',
  });
  assert.equal(verdict.kind, 'unidentifiable', 'malformed attribution must not clear the user-wide hold');
}

async function rawInconsistentFact(input: {
  binding: SubmissionAttemptBinding;
  eventKind: 'press_observed' | 'submission_confirmed';
  parentAttemptId?: string | null;
  companyRole?: string | null;
  evidenceCode: string;
}) {
  const identity = input.binding.postingIdentity;
  await backendDb.insert(schema.application_submission_attempt_events).values({
    user_id: input.binding.userId,
    application_id: input.binding.applicationId ?? null,
    packet_id: input.binding.packetId,
    event_id: randomUUID(),
    attempt_id: input.binding.attemptId,
    parent_attempt_id: input.parentAttemptId === undefined
      ? input.binding.parentAttemptId ?? null
      : input.parentAttemptId,
    event_kind: input.eventKind,
    source: input.binding.source,
    operation: input.binding.operation,
    submission_run_id: null,
    submission_claim_id: null,
    packet_version: null,
    posting_key: identity.postingKey,
    job_id: identity.jobId,
    company_role: input.companyRole === undefined ? identity.companyRole : input.companyRole,
    company_name: identity.company,
    role: identity.role,
    portal_url: identity.portalUrl,
    portal_identity: identity.portalIdentity,
    proof_kind: null,
    evidence_code: input.evidenceCode,
  });
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
    maxConnections: 12,
  });
  await server.start();
  process.env.VERCEL = '1';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  process.env.ENCRYPTION_KEY = 'orphan-attribution-test-key';

  ({ db: backendDb, pool: backendPool } = await import('../db'));
  ({ duplicateApplicationVerdict } = await import('../lib/duplicateApplication'));
  ({
    appendSubmissionAttemptEvent,
    freezePostingIdentity,
    submissionAttemptEventId,
  } = await import('../lib/submissionAttemptLedger'));
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

test('a blank legacy confirmed attempt remains surfaced as a user-wide risk', async () => {
  const userId = await createUser('blank-confirmed');
  const parent = await blankLegacyParent(userId);

  const risks = submissionOrphanRisksFromEvents(await eventsFor(userId));
  assert.deepEqual(risks.map((risk) => ({
    attemptId: risk.attempt_id,
    reason: risk.reason,
    scope: risk.scope,
    resolutionAvailable: risk.resolution_available,
  })), [{
    attemptId: parent.attemptId,
    reason: 'confirmed_unattributed',
    scope: 'user',
    resolutionAvailable: true,
  }]);
  await assertUserWideHold(userId, parent.attemptId);
});

test('company and title alone remain user-wide until an exact posting child is recorded', async () => {
  const userId = await createUser('labels-are-not-scope');
  const parent = await blankLegacyParent(userId, true, {
    company: 'Acme',
    role: 'Software Engineer',
  });
  const before = await eventsFor(userId);
  const risks = submissionOrphanRisksFromEvents(before);
  assert.equal(risks.length, 1);
  assert.equal(risks[0]?.scope, 'user');
  assert.equal(risks[0]?.reason, 'confirmed_unattributed');

  const renamedBeforeAttribution = await duplicateApplicationVerdict({
    userId,
    applicationId: randomUUID(),
    jobContext: { company: 'Acme', role: 'Senior Software Engineer' },
    portalUrl: 'https://apply.workable.com/acme/j/ACMEPOST1/apply/',
  });
  assert.equal(renamedBeforeAttribution.kind, 'unidentifiable');

  const missingPosting = await resolveSubmissionOrphanRisk({
    userId,
    attemptId: parent.attemptId,
    found: true,
  });
  assert.equal(missingPosting.kind, 'attribution_required');
  assert.deepEqual(await eventsFor(userId), before);

  const resolved = await resolveSubmissionOrphanRisk({
    userId,
    attemptId: parent.attemptId,
    found: true,
    posting: {
      company: 'Acme',
      role: 'Software Engineer',
      portal_url: 'https://apply.workable.com/acme/j/ACMEPOST1/apply/',
    },
  });
  assert.equal(resolved.kind, 'resolved');
  assert.ok(resolved.kind === 'resolved' && resolved.attributedAttemptId);

  const renamedAfterAttribution = await duplicateApplicationVerdict({
    userId,
    applicationId: randomUUID(),
    jobContext: { company: 'Acme', role: 'Senior Software Engineer' },
    portalUrl: 'https://apply.workable.com/acme/j/ACMEPOST1/apply/',
  });
  assert.equal(renamedAfterAttribution.kind, 'duplicate');
  assert.equal(
    renamedAfterAttribution.kind === 'duplicate' && renamedAfterAttribution.match.basis,
    'ats_posting',
  );
});

test('a regular confirmed weak row with an application id is surfaced and narrowed append-only', async () => {
  const userId = await createUser('regular-confirmed-weak');
  const applicationId = randomUUID();
  const attemptId = randomUUID();
  const packetId = randomUUID();
  const binding: SubmissionAttemptBinding = {
    attemptId,
    userId,
    packetId,
    applicationId,
    parentAttemptId: null,
    source: 'managed_browser',
    operation: 'initial_submission',
    postingIdentity: freezePostingIdentity(
      { company: 'Historical Co', role: 'Platform Engineer' },
      'https://careers.example.com/jobs',
    ),
    submissionRunId: 'historical-run',
    submissionClaimId: 'historical-claim',
    packetVersion: 'historical-packet',
  };
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(attemptId, 'attempt_opened', 'regular-weak-opening'),
    eventKind: 'attempt_opened',
    evidenceCode: 'legacy_current_confirmed',
  });
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(attemptId, 'submission_confirmed', 'regular-weak-confirmed'),
    eventKind: 'submission_confirmed',
    evidenceCode: 'legacy_current_confirmation',
  });

  const before = submissionOrphanRisksFromEvents(await eventsFor(userId));
  assert.equal(before.length, 1);
  assert.equal(before[0]?.attempt_id, attemptId);
  assert.equal(before[0]?.reason, 'confirmed_unattributed');
  assert.equal(before[0]?.scope, 'user');
  assert.equal(before[0]?.resolution_available, true);

  const negative = await resolveSubmissionOrphanRisk({
    userId,
    attemptId,
    found: false,
    checkedAllPossibleDestinations: true,
  });
  assert.equal(negative.kind, 'conflict', 'a confirmed fact can be attributed but never erased');

  const exact = posting('Historical Co', 'Platform Engineer', 'historical-co', 'HISTORICAL1');
  const resolved = await resolveSubmissionOrphanRisk({
    userId,
    attemptId,
    found: true,
    posting: exact,
  });
  assert.equal(resolved.kind, 'resolved');

  const childEvents = (await eventsFor(userId)).filter((event) => event.parent_attempt_id === attemptId);
  assert.equal(childEvents.length, 2);
  assert.equal(childEvents.every((event) => event.application_id === applicationId), true);
  assert.equal(childEvents.every((event) => event.packet_id === packetId), true);

  const same = await duplicateApplicationVerdict({
    userId,
    applicationId: randomUUID(),
    jobContext: { company: exact.company, role: exact.role, job_id: exact.job_id },
    portalUrl: exact.portal_url,
  });
  assert.equal(same.kind, 'duplicate');

  const adjacent = await duplicateApplicationVerdict({
    userId,
    applicationId: randomUUID(),
    jobContext: { company: exact.company, role: 'Product Engineer', job_id: 'HISTORICAL2' },
    portalUrl: 'https://apply.workable.com/historical-co/j/HISTORICAL2/apply/',
  });
  assert.equal(adjacent.kind, 'clear');
});

test('incomplete, malformed, wrong-user, grandchild, cyclic, and competing attribution stay fail-closed', async (t) => {
  await t.test('incomplete child', async () => {
    const userId = await createUser('incomplete-child');
    const parent = await blankLegacyParent(userId);
    await appendAttributionChild({
      parent: parent.binding,
      posting: posting('Incomplete Co', 'Engineer', 'incomplete', 'INCOMPLETE1'),
      includeConfirmation: false,
    });
    await assertUserWideHold(userId, parent.attemptId);
  });

  await t.test('malformed child binding', async () => {
    const userId = await createUser('malformed-child');
    const parent = await blankLegacyParent(userId);
    const child = await appendAttributionChild({
      parent: parent.binding,
      posting: posting('Malformed Co', 'Engineer', 'malformed', 'MALFORMED1'),
      includeConfirmation: false,
    });
    await rawInconsistentFact({
      binding: child,
      eventKind: 'submission_confirmed',
      companyRole: 'tampered|identity',
      evidenceCode: ORPHAN_CONFIRMATION_EVIDENCE,
    });
    await assertUserWideHold(userId, parent.attemptId);
  });

  await t.test('wrong-user child', async () => {
    const userId = await createUser('wrong-user-parent');
    const otherUserId = await createUser('wrong-user-child');
    const parent = await blankLegacyParent(userId);
    await appendAttributionChild({
      parent: parent.binding,
      posting: posting('Wrong User Co', 'Engineer', 'wrong-user', 'WRONGUSER1'),
      userId: otherUserId,
    });
    await assertUserWideHold(userId, parent.attemptId);
  });

  await t.test('grandchild beneath an otherwise valid child', async () => {
    const userId = await createUser('grandchild');
    const parent = await blankLegacyParent(userId);
    const child = await appendAttributionChild({
      parent: parent.binding,
      posting: posting('Grandchild Co', 'Engineer', 'grandchild', 'GRANDCHILD1'),
    });
    await appendAttributionChild({
      parent: child,
      posting: posting('Nested Co', 'Engineer', 'nested', 'NESTED1'),
      includeConfirmation: false,
    });
    await assertUserWideHold(userId, parent.attemptId);
  });

  await t.test('two-node cycle represented by contradictory historical facts', async () => {
    const userId = await createUser('cycle');
    const parent = await blankLegacyParent(userId);
    const child = await appendAttributionChild({
      parent: parent.binding,
      posting: posting('Cycle Co', 'Engineer', 'cycle', 'CYCLE1'),
    });
    await rawInconsistentFact({
      binding: parent.binding,
      eventKind: 'press_observed',
      parentAttemptId: child.attemptId,
      evidenceCode: 'corrupt-cycle-fact',
    });
    await assertUserWideHold(userId, parent.attemptId);
  });

  await t.test('multiple competing direct children', async () => {
    const userId = await createUser('competing-children');
    const parent = await blankLegacyParent(userId);
    await appendAttributionChild({
      parent: parent.binding,
      posting: posting('First Candidate Co', 'Engineer', 'first-child', 'FIRSTCHILD1'),
    });
    await appendAttributionChild({
      parent: parent.binding,
      posting: posting('Second Candidate Co', 'Engineer', 'second-child', 'SECONDCHILD1'),
    });
    await assertUserWideHold(userId, parent.attemptId);
  });
});

test('blanket negative requires a global check and can later be promoted by positive attribution', async () => {
  const userId = await createUser('negative-promoted');
  const parent = await blankLegacyParent(userId, false);

  const refused = await resolveSubmissionOrphanRisk({
    userId,
    attemptId: parent.attemptId,
    found: false,
  });
  assert.equal(refused.kind, 'global_check_required');
  assert.equal((await eventsFor(userId)).length, 1, 'a refused blanket negative must append no fact');

  const blanketNegative = await resolveSubmissionOrphanRisk({
    userId,
    attemptId: parent.attemptId,
    found: false,
    checkedAllPossibleDestinations: true,
  });
  assert.equal(blanketNegative.kind, 'resolved');
  assert.equal(
    blanketNegative.kind === 'resolved' && blanketNegative.retrySafety.kind === 'safe_not_sent'
      ? blanketNegative.retrySafety.proofKind
      : null,
    'applicant_checked_all_possible_destinations_not_sent',
  );

  const foundPosting = posting('Recovered Co', 'Platform Engineer', 'recovered', 'RECOVERED1');
  const promoted = await resolveSubmissionOrphanRisk({
    userId,
    attemptId: parent.attemptId,
    found: true,
    posting: foundPosting,
  });
  assert.equal(promoted.kind, 'resolved');
  assert.equal(
    promoted.kind === 'resolved' && promoted.retrySafety.kind,
    'blocked_confirmed',
    'later positive evidence must outrank an earlier blanket negative',
  );
  assert.ok(promoted.kind === 'resolved' && promoted.attributedAttemptId);
});

test('exact positive replay is idempotent and different re-attribution fails closed', async () => {
  const userId = await createUser('positive-replay');
  const parent = await blankLegacyParent(userId);
  const foundPosting = posting('Replay Co', 'AI Engineer', 'replay-co', 'REPLAYPOST1');

  const first = await resolveSubmissionOrphanRisk({
    userId,
    attemptId: parent.attemptId,
    found: true,
    posting: foundPosting,
  });
  assert.equal(first.kind, 'resolved');
  assert.equal(first.kind === 'resolved' && first.alreadyResolved, false);
  const eventCount = (await eventsFor(userId)).length;

  const replay = await resolveSubmissionOrphanRisk({
    userId,
    attemptId: parent.attemptId,
    found: true,
    posting: foundPosting,
  });
  assert.equal(replay.kind, 'resolved');
  assert.equal(replay.kind === 'resolved' && replay.alreadyResolved, true);
  assert.equal((await eventsFor(userId)).length, eventCount);
  assert.equal(
    replay.kind === 'resolved' ? replay.attributedAttemptId : null,
    first.kind === 'resolved' ? first.attributedAttemptId : null,
  );

  const conflict = await resolveSubmissionOrphanRisk({
    userId,
    attemptId: parent.attemptId,
    found: true,
    posting: posting('Different Co', 'Different Role', 'different-co', 'DIFFERENT1'),
  });
  assert.equal(conflict.kind, 'conflict');
  assert.equal((await eventsFor(userId)).length, eventCount);
});

test('positive attribution blocks the same posting and cross-tenant differences stay fail-closed', async () => {
  const userId = await createUser('posting-scope');
  const parent = await blankLegacyParent(userId);
  const foundPosting = posting('Scoped Co', 'Automation Engineer', 'scoped-co', 'SCOPEDPOST1');
  const resolved = await resolveSubmissionOrphanRisk({
    userId,
    attemptId: parent.attemptId,
    found: true,
    posting: foundPosting,
  });
  assert.equal(resolved.kind, 'resolved');
  const readable = submissionOrphanRisksFromEvents(await eventsFor(userId));
  assert.equal(readable.length, 1);
  assert.equal(readable[0]?.reason, 'attributed_confirmed');
  assert.equal(readable[0]?.scope, 'posting');
  assert.equal(readable[0]?.company, foundPosting.company);
  assert.equal(readable[0]?.role, foundPosting.role);

  const same = await duplicateApplicationVerdict({
    userId,
    applicationId: randomUUID(),
    jobContext: {
      company: foundPosting.company,
      role: foundPosting.role,
      job_id: foundPosting.job_id,
    },
    portalUrl: foundPosting.portal_url,
  });
  assert.equal(same.kind, 'duplicate');
  if (same.kind === 'duplicate') {
    assert.equal(same.match.basis, 'ats_posting');
    assert.equal(same.match.certainty, 'submitted');
  }

  const unrelated = await duplicateApplicationVerdict({
    userId,
    applicationId: randomUUID(),
    jobContext: { company: 'Unrelated Co', role: 'Product Manager', job_id: 'UNRELATED2' },
    portalUrl: 'https://apply.workable.com/unrelated-two/j/UNRELATED2/apply/',
  });
  assert.equal(unrelated.kind, 'unidentifiable');
});

test('a posting-scoped autofill confirmation stays visible as a read-only risk', async () => {
  const userId = await createUser('posting-confirmed-visible');
  const attemptId = randomUUID();
  const packetId = randomUUID();
  const foundPosting = posting(
    'Visible Confirmation Co',
    'Reliability Engineer',
    'visible-confirmation',
    'VISIBLECONFIRM1',
  );
  const binding: SubmissionAttemptBinding = {
    attemptId,
    userId,
    packetId,
    applicationId: null,
    parentAttemptId: null,
    source: 'chrome_extension',
    operation: 'initial_submission',
    postingIdentity: freezePostingIdentity({
      company: foundPosting.company,
      role: foundPosting.role,
      job_id: foundPosting.job_id,
    }, foundPosting.portal_url),
    submissionRunId: null,
    submissionClaimId: null,
    packetVersion: null,
  };
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(attemptId, 'attempt_opened', 'posting-autofill-opening'),
    eventKind: 'attempt_opened',
    evidenceCode: 'autofill_auto_submit_report',
  });
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(attemptId, 'press_observed', 'posting-autofill-press'),
    eventKind: 'press_observed',
    evidenceCode: 'autofill_auto_submit_click',
  });

  const promoted = await resolveSubmissionOrphanRisk({
    userId,
    attemptId,
    found: true,
  });
  assert.equal(promoted.kind, 'resolved');
  assert.equal(
    promoted.kind === 'resolved' && promoted.retrySafety.kind,
    'blocked_confirmed',
  );

  const risks = submissionOrphanRisksFromEvents(await eventsFor(userId));
  assert.equal(risks.length, 1);
  assert.deepEqual(risks[0], {
    attempt_id: attemptId,
    packet_id: packetId,
    company: foundPosting.company,
    role: foundPosting.role,
    observed_at: promoted.kind === 'resolved'
      && promoted.retrySafety.kind === 'blocked_confirmed'
      ? promoted.retrySafety.confirmedAt
      : '',
    reason: 'attributed_confirmed',
    scope: 'posting',
    blocks_sends: true,
    resolution_available: false,
  });
  assert.equal(Object.hasOwn(risks[0]!, 'application_id'), false);
});

test('query-identified ATS attribution keeps same-title Taleo requisitions separate', async () => {
  const userId = await createUser('taleo-posting-scope');
  const parent = await blankLegacyParent(userId);
  const company = 'Taleo Scope Co';
  const role = 'Software Engineer';
  const resolved = await resolveSubmissionOrphanRisk({
    userId,
    attemptId: parent.attemptId,
    found: true,
    posting: {
      company,
      role,
      portal_url: 'https://acme.taleo.net/careersection/ext/jobdetail.ftl?job=456&utm_source=secret',
    },
  });
  assert.equal(resolved.kind, 'resolved');

  const same = await duplicateApplicationVerdict({
    userId,
    applicationId: randomUUID(),
    jobContext: { company, role },
    portalUrl: 'https://acme.taleo.net/careersection/ext/jobdetail.ftl?job=456',
  });
  assert.equal(same.kind, 'duplicate');
  if (same.kind === 'duplicate') assert.equal(same.match.basis, 'ats_posting');

  const adjacent = await duplicateApplicationVerdict({
    userId,
    applicationId: randomUUID(),
    jobContext: { company, role },
    portalUrl: 'https://acme.taleo.net/careersection/ext/jobdetail.ftl?job=457',
  });
  assert.equal(adjacent.kind, 'clear');
});

test('unknown-provider attribution uses one exact clean public URL despite name drift', async () => {
  const userId = await createUser('exact-url-posting-scope');
  const parent = await blankLegacyParent(userId);
  const resolved = await resolveSubmissionOrphanRisk({
    userId,
    attemptId: parent.attemptId,
    found: true,
    posting: {
      company: 'Original Exact URL Co',
      role: 'Original Engineer Title',
      portal_url: 'https://careers.example.com/openings/123/?utm_source=tracker',
    },
  });
  assert.equal(resolved.kind, 'resolved');

  const renamedSameUrl = await duplicateApplicationVerdict({
    userId,
    applicationId: randomUUID(),
    jobContext: { company: 'Renamed Exact URL Co', role: 'Renamed Engineer Title' },
    portalUrl: 'http://www.careers.example.com/openings/123/application-form',
  });
  assert.equal(renamedSameUrl.kind, 'duplicate');
  if (renamedSameUrl.kind === 'duplicate') {
    assert.equal(renamedSameUrl.match.basis, 'portal_url');
    assert.equal(renamedSameUrl.match.tracker_available, false);
  }

  const adjacentSameNames = await duplicateApplicationVerdict({
    userId,
    applicationId: randomUUID(),
    jobContext: { company: 'Original Exact URL Co', role: 'Original Engineer Title' },
    portalUrl: 'https://careers.example.com/openings/456',
  });
  assert.equal(adjacentSameNames.kind, 'unidentifiable');
});

test('unknown-provider attribution refuses a query-only identity that canonicalization would erase', async () => {
  const userId = await createUser('unsafe-query-posting-scope');
  const parent = await blankLegacyParent(userId);
  const before = await eventsFor(userId);
  await assert.rejects(
    resolveSubmissionOrphanRisk({
      userId,
      attemptId: parent.attemptId,
      found: true,
      posting: {
        company: 'Query Identity Co',
        role: 'Engineer',
        portal_url: 'https://careers.example.com/jobdetail?job_id=123',
      },
    }),
    /clean job-specific URL/,
  );
  assert.deepEqual(await eventsFor(userId), before, 'the rejected attribution must roll back every fact');

  const fragmentUserId = await createUser('fragment-url-posting-scope');
  const fragmentParent = await blankLegacyParent(fragmentUserId);
  await assert.rejects(
    resolveSubmissionOrphanRisk({
      userId: fragmentUserId,
      attemptId: fragmentParent.attemptId,
      found: true,
      posting: {
        company: 'Fragment Identity Co',
        role: 'Engineer',
        portal_url: 'https://careers.example.com/openings/view#job-123',
      },
    }),
    /clean job-specific URL/,
  );

  const aggregateUserId = await createUser('aggregate-url-posting-scope');
  const aggregateParent = await blankLegacyParent(aggregateUserId);
  await assert.rejects(
    resolveSubmissionOrphanRisk({
      userId: aggregateUserId,
      attemptId: aggregateParent.attemptId,
      found: true,
      posting: {
        company: 'Aggregate Careers Co',
        role: 'Engineer',
        portal_url: 'https://careers.example.com/jobs/application',
      },
    }),
    /clean job-specific URL/,
  );
});

test('concurrent positive and blanket-negative resolution never clear the recovered posting', async () => {
  const userId = await createUser('resolution-race');
  const parent = await blankLegacyParent(userId, false);
  const foundPosting = posting('Race Co', 'Safety Engineer', 'race-co', 'RACEPOST1');

  const outcomes = await Promise.allSettled([
    resolveSubmissionOrphanRisk({
      userId,
      attemptId: parent.attemptId,
      found: true,
      posting: foundPosting,
    }),
    resolveSubmissionOrphanRisk({
      userId,
      attemptId: parent.attemptId,
      found: false,
      checkedAllPossibleDestinations: true,
    }),
  ]);
  assert.equal(outcomes.every((outcome) => outcome.status === 'fulfilled'), true);

  const finalEvents = await eventsFor(userId);
  const risks = submissionOrphanRisksFromEvents(finalEvents);
  const same = await duplicateApplicationVerdict({
    userId,
    applicationId: randomUUID(),
    jobContext: {
      company: foundPosting.company,
      role: foundPosting.role,
      job_id: foundPosting.job_id,
    },
    portalUrl: foundPosting.portal_url,
  });
  assert.notEqual(same.kind, 'clear', 'positive evidence must win, or ambiguity must remain blocked');
  assert.equal(
    same.kind === 'duplicate' || risks.some((risk) => risk.scope === 'user'),
    true,
    'the race may converge to exact duplicate evidence or a user-wide ambiguity block, never safety',
  );

  const parentEvents = finalEvents.filter((event) => event.attempt_id === parent.attemptId);
  assert.equal(parentEvents.filter((event) => event.event_kind === 'submission_confirmed').length, 1);
  assert.ok(
    parentEvents.filter((event) => event.event_kind === 'not_sent_proven').length <= 1,
    'the append-only history must contain at most one blanket-negative fact',
  );
});
