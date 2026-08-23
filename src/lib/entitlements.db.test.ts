import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';

const previousDatabaseUrl = process.env.DATABASE_URL;
const previousVercel = process.env.VERCEL;
let socketDir: string;
let pglite: PGlite;
let server: PGLiteSocketServer;
let pool: typeof import('../db/index')['pool'];
let db: typeof import('../db/index')['db'];
let schema: typeof import('../db/schema');
let entitlements: typeof import('./entitlements');
let quota: typeof import('../middleware/quota');
let purgeExpiredNetworkImportPreviews: typeof import('./networkPreviewRetention').purgeExpiredNetworkImportPreviews;

before(async () => {
  socketDir = mkdtempSync(join(tmpdir(), 'litos-entitlements-'));
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({
    db: pglite,
    path: join(socketDir, '.s.PGSQL.5432'),
    maxConnections: 30,
  });
  await server.start();
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  // PGlite's socket adapter loses unnamed prepared statements across concurrent virtual clients.
  // One pooled client still exercises overlapping reservation promises and transaction boundaries,
  // while avoiding an adapter-only protocol failure that real PostgreSQL does not have.
  process.env.VERCEL = '1';
  schema = await import('../db/schema');
  const dbModule = await import('../db/index');
  db = dbModule.db;
  pool = dbModule.pool;
  entitlements = await import('./entitlements');
  quota = await import('../middleware/quota');
  ({ purgeExpiredNetworkImportPreviews } = await import('./networkPreviewRetention'));
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await pglite.exec(statement);
});

after(async () => {
  await pool?.end();
  await server?.stop();
  await pglite?.close();
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = previousVercel;
});

async function trialUser(email: string) {
  const now = new Date();
  const [user] = await db.insert(schema.users).values({
    email,
    email_verified: true,
    entitlement_policy_version: entitlements.ENTITLEMENT_POLICY_VERSION,
    trial_started_at: now,
    trial_ends_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    created_at: now,
  }).returning();
  return user;
}

async function legacyTrialUser(email: string) {
  const now = new Date();
  const [user] = await db.insert(schema.users).values({
    email,
    email_verified: true,
    entitlement_policy_version: 'legacy-v1',
    grandfather_policy: 'legacy_free_v1',
    trial_started_at: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    trial_ends_at: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    created_at: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
  }).returning();
  return user;
}

async function paidUser(email: string) {
  const [user] = await db.insert(schema.users).values({
    email,
    email_verified: true,
    plan: 'pro',
    entitlement_policy_version: entitlements.ENTITLEMENT_POLICY_VERSION,
    created_at: new Date(),
  }).returning();
  return user;
}

async function grandfatheredUser(email: string) {
  const [user] = await db.insert(schema.users).values({
    email,
    email_verified: true,
    plan: 'free',
    entitlement_policy_version: 'legacy-v1',
    grandfather_policy: 'legacy_free_v1',
    created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  }).returning();
  return user;
}

test('legacy reverse trials keep old monthly ceilings and never consume v2 trial meters', async () => {
  const user = await legacyTrialUser('legacy-trial@example.test');
  const active = await entitlements.getEntitlementSnapshot(user.id);
  assert.equal(active.access_class, 'trial_plus');
  assert.equal(active.trial?.meter_policy, 'legacy_monthly_allowances');
  assert.equal(active.features.automatic_submission, true);
  assert.equal(active.features.hover_generation, false);
  assert.deepEqual(await quota.getEntitlements(user.id), { tier: 'trial', ...quota.LIMITS.pro });

  for (let index = 0; index < 6; index += 1) {
    const reservation = await entitlements.reserveEntitledUsage({
      userId: user.id,
      kind: 'tailored_resume',
      idempotencyKey: `legacy-resume-${index}`,
      trigger: 'resume_tailor',
    });
    assert.equal(reservation.allowed, true);
    if (reservation.allowed) {
      assert.ok(reservation.reservationId);
      await entitlements.commitEntitledUsage(
        reservation.reservationId,
        1,
        new Date(),
        { statusCode: 200, body: { packet_id: `legacy-${index}` } },
      );
    }
  }
  const legacyReceipts = (await db.select().from(schema.entitlement_usage_reservations))
    .filter((row) => row.user_id === user.id);
  assert.equal(legacyReceipts.length, 6);
  assert.equal(legacyReceipts.every((row) => row.metered === false), true);
  assert.equal((await db.select().from(schema.trial_generation_usage))
    .filter((row) => row.user_id === user.id).length, 0);

  await db.update(schema.users).set({
    trial_ends_at: new Date(Date.now() - 1),
  }).where(eq(schema.users.id, user.id));
  const expired = await entitlements.getEntitlementSnapshot(user.id);
  assert.equal(expired.access_class, 'free_grandfathered');
  assert.deepEqual(await quota.getEntitlements(user.id), { tier: 'free', ...quota.LIMITS.free });
});

test('trial generation reservations consume only durable successes and stop at five', async () => {
  const user = await trialUser('generation@example.test');
  const failed = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'tailored_resume',
    idempotencyKey: 'failed-operation',
    trigger: 'resume_tailor',
  });
  assert.equal(failed.allowed, true);
  if (!failed.allowed) return;
  await entitlements.releaseEntitledUsage(failed.reservationId);

  const retry = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'tailored_resume',
    idempotencyKey: 'failed-operation',
    trigger: 'resume_tailor',
  });
  assert.equal(retry.allowed, true);
  if (!retry.allowed) return;
  await entitlements.commitEntitledUsage(retry.reservationId);

  for (let index = 1; index < 5; index += 1) {
    const reservation = await entitlements.reserveEntitledUsage({
      userId: user.id,
      kind: 'tailored_resume',
      idempotencyKey: `resume-${index}`,
      trigger: 'resume_tailor',
    });
    assert.equal(reservation.allowed, true);
    if (reservation.allowed) await entitlements.commitEntitledUsage(reservation.reservationId);
  }
  const denied = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'tailored_resume',
    idempotencyKey: 'resume-six',
    trigger: 'resume_tailor',
  });
  assert.equal(denied.allowed, false);
  if (!denied.allowed) {
    assert.equal(denied.denial.reason, 'trial_resume_limit');
    assert.equal(denied.denial.used, 5);
  }
});

test('trial company reservations commit actual units and release empty company slots', async () => {
  const user = await trialUser('contacts@example.test');
  const empty = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'contact',
    idempotencyKey: 'empty-resolve',
    trigger: 'contact_discovery',
    companyScopeKey: 'domain:empty.example',
    companyName: 'Empty',
    units: 2,
  });
  assert.equal(empty.allowed, true);
  if (empty.allowed) await entitlements.commitEntitledUsage(empty.reservationId, 0);

  const first = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'contact',
    idempotencyKey: 'resolve-one',
    trigger: 'contact_discovery',
    companyScopeKey: 'domain:acme.example',
    companyName: 'Acme',
    units: 2,
  });
  assert.equal(first.allowed, true);
  if (first.allowed) await entitlements.commitEntitledUsage(first.reservationId, 1);

  const second = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'contact',
    idempotencyKey: 'resolve-two',
    trigger: 'contact_discovery',
    companyScopeKey: 'domain:acme.example',
    companyName: 'Acme',
    units: 1,
  });
  assert.equal(second.allowed, true);
  if (second.allowed) await entitlements.commitEntitledUsage(second.reservationId, 1);

  const denied = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'contact',
    idempotencyKey: 'resolve-three',
    trigger: 'contact_discovery',
    companyScopeKey: 'domain:acme.example',
    companyName: 'Acme',
    units: 1,
  });
  assert.equal(denied.allowed, false);
  if (!denied.allowed) assert.equal(denied.denial.reason, 'trial_company_contact_limit');

  const snapshot = await entitlements.getEntitlementSnapshot(user.id);
  assert.equal(snapshot.trial?.meter_policy, 'litos_plus_v2_lifetime');
  if (snapshot.trial?.meter_policy !== 'litos_plus_v2_lifetime') {
    assert.fail('expected a v2 lifetime-metered trial');
  }
  assert.equal(snapshot.trial.outreach_companies_used, 1);
  assert.equal(snapshot.trial.company_usage[0]?.contacts_used, 2);
});

test('six simultaneous company claims can create only five trial slots', async () => {
  const user = await trialUser('concurrent@example.test');
  const reservations = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
    try {
      return await entitlements.reserveEntitledUsage({
        userId: user.id,
        kind: 'draft',
        idempotencyKey: `company-${index}`,
        trigger: 'outreach_draft_generate',
        companyScopeKey: `domain:company-${index}.example`,
        companyName: `Company ${index}`,
        units: 1,
      });
    } catch (error) {
      throw (error as { cause?: unknown }).cause ?? error;
    }
  }));
  assert.equal(reservations.filter((reservation) => reservation.allowed).length, 5);
  const denied = reservations.find((reservation) => !reservation.allowed);
  assert.equal(denied?.allowed, false);
  if (denied && !denied.allowed) assert.equal(denied.denial.reason, 'trial_company_limit');
  await Promise.all(reservations.map((reservation) => reservation.allowed
    ? entitlements.releaseEntitledUsage(reservation.reservationId)
    : Promise.resolve()));
});

test('concurrent answer operations for one application consume one trial unit', async () => {
  const user = await trialUser('answer-concurrent@example.test');
  const applicationId = randomUUID();
  const reservations = await Promise.all(['answer-a', 'answer-b'].map((idempotencyKey) =>
    entitlements.reserveEntitledUsage({
      userId: user.id,
      kind: 'answer_application',
      idempotencyKey,
      trigger: 'application_answer_generate',
      applicationId,
    })));
  assert.equal(reservations.every((reservation) => reservation.allowed), true);
  const reservationIds = reservations.flatMap((reservation) => reservation.allowed && reservation.reservationId
    ? [reservation.reservationId]
    : []);
  assert.equal(reservationIds.length, 2);

  await Promise.all(reservationIds.map((reservationId) => entitlements.commitEntitledUsage(reservationId)));

  const usageRows = await db.select().from(schema.trial_generation_usage);
  assert.equal(usageRows.find((row) => row.user_id === user.id)?.answer_applications_used, 1);
  const grants = await db.select().from(schema.trial_answer_applications);
  assert.equal(grants.filter((row) => row.user_id === user.id && row.application_id === applicationId).length, 1);
  const committed = await db.select().from(schema.entitlement_usage_reservations);
  const answerReservations = committed.filter((row) => row.user_id === user.id && row.usage_kind === 'answer_application');
  assert.equal(answerReservations.reduce((sum, row) => sum + row.units, 0), 1);
});

test('one resolved company and its two drafts share one trial company row', async () => {
  const user = await trialUser('company-scope@example.test');
  const companyScopeKey = entitlements.canonicalCompanyScope({
    companyName: 'Acme',
    domain: 'https://www.acme.example/jobs',
  });
  const contact = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'contact',
    idempotencyKey: 'resolve-acme',
    trigger: 'contact_discovery',
    companyScopeKey,
    companyName: 'Acme',
    units: 2,
  });
  assert.equal(contact.allowed, true);
  if (contact.allowed) await entitlements.commitEntitledUsage(contact.reservationId, 2);

  for (const idempotencyKey of ['draft-acme-one', 'draft-acme-two']) {
    const draft = await entitlements.reserveEntitledUsage({
      userId: user.id,
      kind: 'draft',
      idempotencyKey,
      trigger: 'outreach_draft_generate',
      companyScopeKey,
      companyName: 'Acme',
    });
    assert.equal(draft.allowed, true);
    if (draft.allowed) await entitlements.commitEntitledUsage(draft.reservationId);
  }

  const rows = (await db.select().from(schema.trial_company_usage)).filter((row) => row.user_id === user.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contacts_used, 2);
  assert.equal(rows[0].drafts_used, 2);
});

test('contact unlock ownership and trial charging commit once across an exact concurrent retry', async () => {
  const user = await trialUser('contact-unlock-retry@example.test');
  await db.insert(schema.companies).values({ domain: 'unlock.example', name: 'Unlock' });
  const contactIds = [randomUUID(), randomUUID()];
  await db.insert(schema.contacts).values(contactIds.map((id, index) => ({
    id,
    full_name: `Contact ${index}`,
    company_domain: 'unlock.example',
  })));
  const reservation = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'contact',
    idempotencyKey: 'lost-response-contact-operation',
    trigger: 'contact_discovery',
    companyScopeKey: 'domain:unlock.example',
    companyName: 'Unlock',
    units: 2,
  });
  assert.equal(reservation.allowed, true);
  if (!reservation.allowed) return;
  const commits = await Promise.all([
    entitlements.commitContactUnlocks({
      userId: user.id,
      companyScopeKey: 'domain:unlock.example',
      contactIds,
      source: 'test-cache',
      reservationId: reservation.reservationId,
      cache: { key: 'unlock.example|engineer', results: [], source: 'test-cache' },
    }),
    entitlements.commitContactUnlocks({
      userId: user.id,
      companyScopeKey: 'domain:unlock.example',
      contactIds,
      source: 'test-cache',
      reservationId: reservation.reservationId,
      cache: { key: 'unlock.example|engineer', results: [], source: 'test-cache' },
    }),
  ]);
  assert.deepEqual(commits.sort(), [0, 2]);
  const unlocks = (await db.select().from(schema.user_contact_unlocks)).filter((row) => row.user_id === user.id);
  assert.equal(unlocks.length, 2);
  const companyUsage = (await db.select().from(schema.trial_company_usage))
    .find((row) => row.user_id === user.id && row.company_scope_key === 'domain:unlock.example');
  assert.equal(companyUsage?.contacts_used, 2);

  const replay = await entitlements.commitContactUnlocks({
    userId: user.id,
    companyScopeKey: 'domain:unlock.example',
    contactIds,
    source: 'test-cache',
    reservationId: reservation.reservationId,
  });
  assert.equal(replay, 0);
  assert.equal((await db.select().from(schema.user_contact_unlocks))
    .filter((row) => row.user_id === user.id).length, 2);
});

test('contact unlock batch charges only rows inserted when one contact already exists', async () => {
  const user = await trialUser('contact-unlock-partial-conflict@example.test');
  await db.insert(schema.companies).values({ domain: 'partial-unlock.example', name: 'Partial Unlock' });
  const existingContactId = randomUUID();
  const newContactId = randomUUID();
  await db.insert(schema.contacts).values([
    { id: existingContactId, full_name: 'Existing Contact', company_domain: 'partial-unlock.example' },
    { id: newContactId, full_name: 'New Contact', company_domain: 'partial-unlock.example' },
  ]);
  await db.insert(schema.user_contact_unlocks).values({
    user_id: user.id,
    contact_id: existingContactId,
    company_scope_key: 'domain:partial-unlock.example',
    source: 'earlier-operation',
    unlocked_at: new Date(),
  });
  const reservation = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'contact',
    idempotencyKey: 'partial-conflict-contact-operation',
    trigger: 'contact_discovery',
    companyScopeKey: 'domain:partial-unlock.example',
    companyName: 'Partial Unlock',
    units: 2,
  });
  assert.equal(reservation.allowed, true);
  if (!reservation.allowed) return;

  const inserted = await entitlements.commitContactUnlocks({
    userId: user.id,
    companyScopeKey: 'domain:partial-unlock.example',
    contactIds: [existingContactId, newContactId],
    source: 'partial-conflict-test',
    reservationId: reservation.reservationId,
  });

  assert.equal(inserted, 1);
  const unlocks = (await db.select().from(schema.user_contact_unlocks))
    .filter((row) => row.user_id === user.id);
  assert.equal(unlocks.length, 2);
  const companyUsage = (await db.select().from(schema.trial_company_usage))
    .find((row) => row.user_id === user.id && row.company_scope_key === 'domain:partial-unlock.example');
  assert.equal(companyUsage?.contacts_used, 1);
  const savedReservation = (await db.select().from(schema.entitlement_usage_reservations))
    .find((row) => row.id === reservation.reservationId);
  assert.equal(savedReservation?.status, 'committed');
  assert.equal(savedReservation?.units, 1);
});

test('one operation id cannot cross company or application scope', async () => {
  const user = await trialUser('idempotency-scope@example.test');
  const companyReservation = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'contact',
    idempotencyKey: 'shared-company-operation',
    trigger: 'contact_discovery',
    companyScopeKey: 'domain:first.example',
    companyName: 'First',
  });
  assert.equal(companyReservation.allowed, true);
  await assert.rejects(entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'contact',
    idempotencyKey: 'shared-company-operation',
    trigger: 'contact_discovery',
    companyScopeKey: 'domain:second.example',
    companyName: 'Second',
  }), (error: Error & { code?: string }) => error.code === 'idempotency_conflict');
  if (companyReservation.allowed) await entitlements.releaseEntitledUsage(companyReservation.reservationId);

  const firstApplicationId = randomUUID();
  const answerReservation = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'answer_application',
    idempotencyKey: 'shared-answer-operation',
    trigger: 'application_answer_generate',
    applicationId: firstApplicationId,
  });
  assert.equal(answerReservation.allowed, true);
  await assert.rejects(entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'answer_application',
    idempotencyKey: 'shared-answer-operation',
    trigger: 'application_answer_generate',
    applicationId: randomUUID(),
  }), (error: Error & { code?: string }) => error.code === 'idempotency_conflict');
  if (answerReservation.allowed) await entitlements.releaseEntitledUsage(answerReservation.reservationId);
});

test('a committed trial operation replays its exact success and rejects changed content', async () => {
  const user = await trialUser('committed-replay@example.test');
  const applicationId = randomUUID();
  const requestHash = entitlements.entitledUsageRequestHash('cover_letter', {
    application_id: applicationId,
    packet_id: 'packet-one',
  });
  const reservation = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'cover_letter',
    idempotencyKey: 'committed-cover-letter',
    trigger: 'cover_letter_generate',
    applicationId,
    requestHash,
  });
  assert.equal(reservation.allowed, true);
  if (!reservation.allowed) return;
  const success = { application_id: applicationId, packet_id: 'packet-one', download_url: '/download/original' };
  await entitlements.commitEntitledUsage(
    reservation.reservationId,
    1,
    new Date(),
    { statusCode: 200, body: success },
  );
  const replay = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'cover_letter',
    idempotencyKey: 'committed-cover-letter',
    trigger: 'cover_letter_generate',
    applicationId,
    requestHash,
  });
  assert.equal(replay.allowed, true);
  if (replay.allowed) assert.deepEqual(replay.replay, { statusCode: 200, body: success });
  await assert.rejects(entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'cover_letter',
    idempotencyKey: 'committed-cover-letter',
    trigger: 'cover_letter_generate',
    applicationId,
    requestHash: entitlements.entitledUsageRequestHash('cover_letter', {
      application_id: applicationId,
      packet_id: 'packet-two',
    }),
  }), (error: Error & { code?: string }) => error.code === 'idempotency_conflict');
  const usage = (await db.select().from(schema.trial_generation_usage)).find((row) => row.user_id === user.id);
  assert.equal(usage?.cover_letters_used, 1);
});

test('paid and grandfathered successes use unmetered receipts and replay without duplicate work', async () => {
  const users = [
    { user: await paidUser('paid-replay@example.test'), expectedAccess: 'plus_paid' },
    { user: await grandfatheredUser('grandfathered-replay@example.test'), expectedAccess: 'free_grandfathered' },
  ] as const;
  for (const [index, entry] of users.entries()) {
    const companyScopeKey = `domain:replay-${index}.example`;
    const requestHash = entitlements.entitledUsageRequestHash('draft', {
      company_scope_key: companyScopeKey,
      contact_id: `contact-${index}`,
      role: 'Engineer',
    });
    const first = await entitlements.reserveEntitledUsage({
      userId: entry.user.id,
      kind: 'draft',
      idempotencyKey: `unmetered-draft-${index}`,
      requestHash,
      trigger: 'outreach_draft_generate',
      companyScopeKey,
      companyName: `Replay ${index}`,
    });
    assert.equal(first.allowed, true);
    if (!first.allowed) continue;
    assert.ok(first.reservationId);
    const body = { subject: `Hello ${index}`, body: `Original result ${index}` };
    await entitlements.commitEntitledUsage(
      first.reservationId,
      1,
      new Date(),
      { statusCode: 200, body },
    );
    const replay = await entitlements.reserveEntitledUsage({
      userId: entry.user.id,
      kind: 'draft',
      idempotencyKey: `unmetered-draft-${index}`,
      requestHash,
      trigger: 'outreach_draft_generate',
      companyScopeKey,
      companyName: `Replay ${index}`,
    });
    assert.equal(replay.allowed, true);
    if (replay.allowed) assert.deepEqual(replay.replay, { statusCode: 200, body });
    assert.equal((await entitlements.getEntitlementSnapshot(entry.user.id)).access_class, entry.expectedAccess);
    const [stored] = (await db.select().from(schema.entitlement_usage_reservations))
      .filter((row) => row.user_id === entry.user.id);
    assert.equal(stored.metered, false);
    assert.equal((await db.select().from(schema.trial_company_usage))
      .filter((row) => row.user_id === entry.user.id).length, 0);
  }
});

test('a different later reservation purges expired replay payloads but retains audit metadata', async () => {
  const user = await trialUser('replay-retention@example.test');
  const startedAt = new Date();
  const firstHash = entitlements.entitledUsageRequestHash('tailored_resume', { role: 'First' });
  const first = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'tailored_resume',
    idempotencyKey: 'retained-result-one',
    requestHash: firstHash,
    trigger: 'resume_tailor',
    applicationId: randomUUID(),
    now: startedAt,
  });
  assert.equal(first.allowed, true);
  if (!first.allowed) return;
  await entitlements.commitEntitledUsage(
    first.reservationId,
    1,
    startedAt,
    { statusCode: 200, body: { packet_id: 'packet-sensitive-result' } },
  );
  const later = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'tailored_resume',
    idempotencyKey: 'retained-result-two',
    requestHash: entitlements.entitledUsageRequestHash('tailored_resume', { role: 'Second' }),
    trigger: 'resume_tailor',
    applicationId: randomUUID(),
    now: new Date(startedAt.getTime() + 24 * 60 * 60 * 1000 + 1),
  });
  assert.equal(later.allowed, true);
  if (later.allowed) await entitlements.releaseEntitledUsage(later.reservationId);
  const [stored] = (await db.select().from(schema.entitlement_usage_reservations))
    .filter((row) => row.id === first.reservationId);
  assert.equal(stored.status, 'committed');
  assert.equal(stored.request_hash, firstHash);
  assert.equal(stored.result_envelope, null);
  assert.equal(stored.result_status_code, null);
  assert.equal(stored.result_expires_at, null);
});

test('the global retention sweep clears dormant replay payloads without another user request', async () => {
  const user = await trialUser('dormant-replay-retention@example.test');
  const startedAt = new Date();
  const requestHash = entitlements.entitledUsageRequestHash('tailored_resume', { role: 'Dormant' });
  const reservation = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'tailored_resume',
    idempotencyKey: 'dormant-result',
    requestHash,
    trigger: 'resume_tailor',
    applicationId: randomUUID(),
    now: startedAt,
  });
  assert.equal(reservation.allowed, true);
  if (!reservation.allowed) return;
  await entitlements.commitEntitledUsage(
    reservation.reservationId,
    1,
    startedAt,
    { statusCode: 200, body: { packet_id: 'dormant-sensitive-result' } },
  );
  const purged = await entitlements.purgeExpiredEntitledUsageResults(
    new Date(startedAt.getTime() + 24 * 60 * 60 * 1000 + 1),
  );
  assert.equal(purged >= 1, true);
  const [stored] = (await db.select().from(schema.entitlement_usage_reservations))
    .filter((row) => row.id === reservation.reservationId);
  assert.equal(stored.status, 'committed');
  assert.equal(stored.request_hash, requestHash);
  assert.equal(stored.result_envelope, null);
  assert.equal(stored.result_status_code, null);
  assert.equal(stored.result_expires_at, null);
});

test('the global retention sweep deletes abandoned LinkedIn preview rows after their TTL', async () => {
  const user = await trialUser('abandoned-network-preview@example.test');
  const now = new Date();
  const [expired] = await db.insert(schema.network_imports).values({
    user_id: user.id,
    source: 'linkedin_csv',
    file_sha256: 'a'.repeat(64),
    consent_version: 'linkedin_csv_v1',
    disclosure_hash: 'b'.repeat(64),
    row_count: 1,
    accepted_rows: 1,
    rejected_rows: 0,
    validation_result: {},
    preview_rows: [{ full_name: 'Private Person' }],
    status: 'previewed',
    expires_at: new Date(now.getTime() - 1),
    raw_deleted_at: new Date(now.getTime() - 31 * 60 * 1000),
  }).returning();
  const [live] = await db.insert(schema.network_imports).values({
    user_id: user.id,
    source: 'linkedin_csv',
    file_sha256: 'c'.repeat(64),
    consent_version: 'linkedin_csv_v1',
    disclosure_hash: 'd'.repeat(64),
    row_count: 1,
    accepted_rows: 1,
    rejected_rows: 0,
    validation_result: {},
    preview_rows: [{ full_name: 'Still Previewing' }],
    status: 'previewed',
    expires_at: new Date(now.getTime() + 60_000),
    raw_deleted_at: now,
  }).returning();
  assert.equal(await purgeExpiredNetworkImportPreviews(now), 1);
  const rows = await db.select().from(schema.network_imports);
  const expiredAfter = rows.find((row) => row.id === expired.id)!;
  const liveAfter = rows.find((row) => row.id === live.id)!;
  assert.equal(expiredAfter.status, 'expired');
  assert.equal(expiredAfter.preview_rows, null);
  assert.deepEqual(liveAfter.preview_rows, [{ full_name: 'Still Previewing' }]);
});

test('an expired reservation can rebind the exact operation after its 15-minute lease', async () => {
  const user = await trialUser('stale-operation@example.test');
  const startedAt = new Date();
  const requestHash = entitlements.entitledUsageRequestHash('tailored_resume', { application_id: 'same' });
  const first = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'tailored_resume',
    idempotencyKey: 'stale-resume',
    trigger: 'resume_tailor',
    applicationId: randomUUID(),
    requestHash,
    now: startedAt,
  });
  assert.equal(first.allowed, true);
  if (!first.allowed) return;
  const scope = (await db.select().from(schema.entitlement_usage_reservations))
    .find((row) => row.id === first.reservationId)!.scope_key;
  const retry = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'tailored_resume',
    idempotencyKey: 'stale-resume',
    trigger: 'resume_tailor',
    applicationId: scope,
    requestHash,
    now: new Date(startedAt.getTime() + 16 * 60 * 1000),
  });
  assert.equal(retry.allowed, true);
  if (retry.allowed) assert.equal(retry.reservationId, first.reservationId);
  const rows = (await db.select().from(schema.entitlement_usage_reservations))
    .filter((row) => row.user_id === user.id && row.idempotency_key === 'stale-resume');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'reserved');
  assert.equal(rows[0].expires_at.getTime(), startedAt.getTime() + 31 * 60 * 1000);
});

test('an outreach draft, its trial unit, and replay receipt commit atomically', async () => {
  const user = await trialUser('durable-outreach@example.test');
  const applicationId = randomUUID();
  const contactId = randomUUID();
  const operationId = randomUUID();
  const companyScopeKey = 'domain:acme.example';
  await db.insert(schema.companies).values({ domain: 'acme.example', name: 'Acme' });
  await db.insert(schema.contacts).values({
    id: contactId,
    full_name: 'Alex Recruiter',
    first_name: 'Alex',
    last_name: 'Recruiter',
    company_domain: 'acme.example',
    title: 'Recruiter',
    persona: 'recruiter',
  });
  await db.insert(schema.applications).values({
    id: applicationId,
    user_id: user.id,
    company_scope_key: companyScopeKey,
    company_name: 'Acme',
    role: 'Software Engineer',
    source_surface: 'dashboard',
    application_fingerprint: `test:${applicationId}`,
  });
  await db.insert(schema.user_contact_unlocks).values({
    user_id: user.id,
    contact_id: contactId,
    company_scope_key: companyScopeKey,
    source: 'apollo',
  });
  const requestHash = entitlements.entitledUsageRequestHash('draft', {
    draft_type: 'first_note',
    application_id: applicationId,
    contact_id: contactId,
  });
  const reservation = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'draft',
    idempotencyKey: operationId,
    requestHash,
    trigger: 'outreach_draft_generate',
    applicationId,
    companyScopeKey,
    companyName: 'Acme',
  });
  assert.equal(reservation.allowed, true);
  if (!reservation.allowed || !reservation.reservationId) return;
  const persisted = await entitlements.commitOutreachDraftGeneration({
    reservationId: reservation.reservationId,
    userId: user.id,
    operationId,
    requestHash,
    contactId,
    applicationId,
    companyScopeKey,
    companyName: 'Acme',
    role: 'Software Engineer',
    draftType: 'first_note',
    draft: {
      subject: 'Quick question, Alex',
      body: 'Hi Alex, could I ask two questions about the team?',
      word_count: 10,
      warnings: [],
    },
  });
  assert.equal(persisted.operation_id, operationId);
  assert.equal(persisted.contact_id, contactId);
  assert.equal(persisted.application_id, applicationId);

  const draftRows = (await db.select().from(schema.outreach_draft_generations))
    .filter((row) => row.user_id === user.id);
  assert.equal(draftRows.length, 1);
  assert.equal(draftRows[0].subject, persisted.subject);
  const [companyUsage] = (await db.select().from(schema.trial_company_usage))
    .filter((row) => row.user_id === user.id && row.company_scope_key === companyScopeKey);
  assert.equal(companyUsage.drafts_used, 1);
  const [receipt] = (await db.select().from(schema.entitlement_usage_reservations))
    .filter((row) => row.id === reservation.reservationId);
  assert.equal(receipt.status, 'committed');
  assert.deepEqual(receipt.result_envelope, persisted);

  const replay = await entitlements.reserveEntitledUsage({
    userId: user.id,
    kind: 'draft',
    idempotencyKey: operationId,
    requestHash,
    trigger: 'outreach_draft_generate',
    applicationId,
    companyScopeKey,
    companyName: 'Acme',
  });
  assert.equal(replay.allowed, true);
  if (replay.allowed) assert.deepEqual(replay.replay?.body, persisted);
});

test('outreach persistence rejects a non-owned canonical binding without consuming quota', async () => {
  const owner = await trialUser('durable-outreach-owner@example.test');
  const stranger = await trialUser('durable-outreach-stranger@example.test');
  const applicationId = randomUUID();
  const contactId = randomUUID();
  const operationId = randomUUID();
  const companyScopeKey = 'domain:binding.example';
  await db.insert(schema.companies).values({ domain: 'binding.example', name: 'Binding' });
  await db.insert(schema.contacts).values({
    id: contactId,
    full_name: 'Casey Recruiter',
    company_domain: 'binding.example',
    title: 'Recruiter',
  });
  await db.insert(schema.applications).values({
    id: applicationId,
    user_id: stranger.id,
    company_scope_key: companyScopeKey,
    company_name: 'Binding',
    role: 'Engineer',
    source_surface: 'dashboard',
    application_fingerprint: `test:${applicationId}`,
  });
  await db.insert(schema.user_contact_unlocks).values({
    user_id: owner.id,
    contact_id: contactId,
    company_scope_key: companyScopeKey,
    source: 'manual',
  });
  const requestHash = entitlements.entitledUsageRequestHash('draft', { application_id: applicationId, contact_id: contactId });
  const reservation = await entitlements.reserveEntitledUsage({
    userId: owner.id,
    kind: 'draft',
    idempotencyKey: operationId,
    requestHash,
    trigger: 'outreach_draft_generate',
    applicationId,
    companyScopeKey,
    companyName: 'Binding',
  });
  assert.equal(reservation.allowed, true);
  if (!reservation.allowed || !reservation.reservationId) return;
  await assert.rejects(entitlements.commitOutreachDraftGeneration({
    reservationId: reservation.reservationId,
    userId: owner.id,
    operationId,
    requestHash,
    contactId,
    applicationId,
    companyScopeKey,
    companyName: 'Binding',
    role: 'Engineer',
    draftType: 'first_note',
    draft: { subject: 'Subject', body: 'Body', word_count: 1, warnings: [] },
  }), /application is not owned/);
  assert.equal((await db.select().from(schema.outreach_draft_generations))
    .filter((row) => row.user_id === owner.id).length, 0);
  const [receipt] = (await db.select().from(schema.entitlement_usage_reservations))
    .filter((row) => row.id === reservation.reservationId);
  assert.equal(receipt.status, 'reserved');
});
