import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  browser_provider_resource_cleanups,
  generated_resumes,
} from '../db/schema';
import { readApplicationReview } from './applicationReview';
import {
  browserSessionIsConfirmedGone,
  browserSessionsForResourceReservation,
  createReservedBrowserSession,
  deleteBrowserContext,
  releaseBrowserSession,
  type BrowserProvider,
  type SessionResponse,
} from './browserbase';
import {
  assertSubmissionAccountNotDraining,
  lockSubmissionAttemptUser,
  SubmissionAccountDeletionDrainError,
} from './submissionAttemptLedger';

const RESOURCE_CREATION_RECOVERY_MS = 6 * 60 * 1000;

type PersistentBrowserProvider = Exclude<BrowserProvider, 'stratus-managed'>;
type BrowserProviderResourceType = 'session' | 'context';

/** One database clock read for every provider gate, so the row shape is corrected in one place. */
export async function databaseNow(executor: Pick<typeof db, 'execute'>): Promise<Date> {
  const result = await executor.execute(sql`select clock_timestamp() as now`);
  const value = (result.rows[0] as { now?: Date | string } | undefined)?.now;
  const parsed = value instanceof Date ? value : new Date(value ?? Number.NaN);
  if (Number.isNaN(parsed.getTime())) throw new Error('Database provider-resource clock was unavailable');
  return parsed;
}

export async function reserveBrowserProviderResource(input: {
  userId: string;
  provider: PersistentBrowserProvider;
  resourceType: BrowserProviderResourceType;
}): Promise<{ reservationId: string; creationExpiresAt: string }> {
  return db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, input.userId);
    await assertSubmissionAccountNotDraining(tx, input.userId);
    const now = await databaseNow(tx);
    const reservationId = randomUUID();
    const creationExpiresAt = new Date(now.getTime() + RESOURCE_CREATION_RECOVERY_MS);
    await tx.insert(browser_provider_resource_cleanups).values({
      id: reservationId,
      user_id: input.userId,
      provider: input.provider,
      resource_type: input.resourceType,
      creation_expires_at: creationExpiresAt,
      created_at: now,
      updated_at: now,
    });
    return { reservationId, creationExpiresAt: creationExpiresAt.toISOString() };
  });
}

/** Reserve before POST, then hold the user fence from the final drain check through exact binding. */
export async function createFencedBrowserSession(input: {
  userId: string;
  provider: PersistentBrowserProvider;
  portalUrl: string;
}): Promise<SessionResponse> {
  const reservation = await reserveBrowserProviderResource({
    userId: input.userId,
    provider: input.provider,
    resourceType: 'session',
  });
  const result = await db.transaction(async (tx): Promise<
    { kind: 'created'; session: SessionResponse } | { kind: 'deletion_draining' }
  > => {
    // Keep the shared user lock across the external POST and exact-id binding. If deletion won the
    // gap after the durable reservation commit, no POST occurs. If this process dies during or
    // after the POST, the earlier committed reservation remains recoverable by provider metadata.
    await lockSubmissionAttemptUser(tx, input.userId);
    try {
      await assertSubmissionAccountNotDraining(tx, input.userId);
    } catch (error) {
      if (!(error instanceof SubmissionAccountDeletionDrainError)) throw error;
      const now = await databaseNow(tx);
      await tx.update(browser_provider_resource_cleanups).set({
        provider_confirmed_gone_at: now,
        updated_at: now,
      }).where(and(
        eq(browser_provider_resource_cleanups.id, reservation.reservationId),
        eq(browser_provider_resource_cleanups.user_id, input.userId),
        isNull(browser_provider_resource_cleanups.provider_resource_id),
      ));
      return { kind: 'deletion_draining' };
    }
    const [durableReservation] = await tx.select({
      id: browser_provider_resource_cleanups.id,
    }).from(browser_provider_resource_cleanups).where(and(
      eq(browser_provider_resource_cleanups.id, reservation.reservationId),
      eq(browser_provider_resource_cleanups.user_id, input.userId),
      eq(browser_provider_resource_cleanups.provider, input.provider),
      eq(browser_provider_resource_cleanups.resource_type, 'session'),
      isNull(browser_provider_resource_cleanups.provider_resource_id),
      isNull(browser_provider_resource_cleanups.provider_confirmed_gone_at),
    )).limit(1);
    if (!durableReservation) {
      throw new Error('Browser provider resource reservation changed before creation');
    }
    const session = await createReservedBrowserSession(
      input.portalUrl,
      reservation.reservationId,
      input.provider,
    );
    if (typeof session.id !== 'string' || !session.id.trim()) {
      throw new Error('Browser provider created a session without an exact resource id');
    }
    const now = await databaseNow(tx);
    const [bound] = await tx.update(browser_provider_resource_cleanups).set({
      provider_resource_id: session.id,
      updated_at: now,
    }).where(and(
      eq(browser_provider_resource_cleanups.id, reservation.reservationId),
      eq(browser_provider_resource_cleanups.user_id, input.userId),
      isNull(browser_provider_resource_cleanups.provider_resource_id),
      isNull(browser_provider_resource_cleanups.provider_confirmed_gone_at),
    )).returning({ id: browser_provider_resource_cleanups.id });
    if (!bound) throw new Error('Browser provider resource reservation changed before binding');
    return { kind: 'created', session };
  });
  if (result.kind === 'deletion_draining') throw new SubmissionAccountDeletionDrainError();
  return result.session;
}

async function markResourceGone(userId: string, cleanupId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, userId);
    const now = await databaseNow(tx);
    await tx.update(browser_provider_resource_cleanups).set({
      provider_confirmed_gone_at: now,
      updated_at: now,
    }).where(and(
      eq(browser_provider_resource_cleanups.id, cleanupId),
      eq(browser_provider_resource_cleanups.user_id, userId),
      isNull(browser_provider_resource_cleanups.provider_confirmed_gone_at),
    ));
  });
}

async function markReleaseRequested(userId: string, cleanupId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, userId);
    const now = await databaseNow(tx);
    await tx.update(browser_provider_resource_cleanups).set({
      release_requested_at: now,
      updated_at: now,
    }).where(and(
      eq(browser_provider_resource_cleanups.id, cleanupId),
      eq(browser_provider_resource_cleanups.user_id, userId),
      isNull(browser_provider_resource_cleanups.release_requested_at),
    ));
  });
}

async function bindRecoveredSession(userId: string, cleanupId: string, sessionId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, userId);
    const [current] = await tx.select({
      providerResourceId: browser_provider_resource_cleanups.provider_resource_id,
      confirmedGoneAt: browser_provider_resource_cleanups.provider_confirmed_gone_at,
    }).from(browser_provider_resource_cleanups).where(and(
      eq(browser_provider_resource_cleanups.id, cleanupId),
      eq(browser_provider_resource_cleanups.user_id, userId),
    )).limit(1);
    if (!current || current.confirmedGoneAt) return null;
    if (current.providerResourceId) return current.providerResourceId;
    const now = await databaseNow(tx);
    const [bound] = await tx.update(browser_provider_resource_cleanups).set({
      provider_resource_id: sessionId,
      updated_at: now,
    }).where(and(
      eq(browser_provider_resource_cleanups.id, cleanupId),
      eq(browser_provider_resource_cleanups.user_id, userId),
      isNull(browser_provider_resource_cleanups.provider_resource_id),
      isNull(browser_provider_resource_cleanups.provider_confirmed_gone_at),
    )).returning({ providerResourceId: browser_provider_resource_cleanups.provider_resource_id });
    return bound?.providerResourceId ?? null;
  });
}

/** Atomically turn an ambiguous provider query into one exact cleanup obligation per result. */
async function expandRecoveredSessions(input: {
  userId: string;
  cleanupId: string;
  provider: PersistentBrowserProvider;
  sessions: SessionResponse[];
}): Promise<boolean> {
  const sessionIds = [...new Set(input.sessions
    .map((session) => session.id?.trim())
    .filter((sessionId): sessionId is string => Boolean(sessionId)))];
  if (sessionIds.length !== input.sessions.length || sessionIds.length < 2) return false;
  return db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, input.userId);
    const now = await databaseNow(tx);
    const [original] = await tx.select({ id: browser_provider_resource_cleanups.id })
      .from(browser_provider_resource_cleanups).where(and(
        eq(browser_provider_resource_cleanups.id, input.cleanupId),
        eq(browser_provider_resource_cleanups.user_id, input.userId),
        isNull(browser_provider_resource_cleanups.provider_resource_id),
        isNull(browser_provider_resource_cleanups.provider_confirmed_gone_at),
      )).limit(1);
    if (!original) return false;
    for (const sessionId of sessionIds) {
      const [existing] = await tx.select({
        userId: browser_provider_resource_cleanups.user_id,
      }).from(browser_provider_resource_cleanups).where(and(
        eq(browser_provider_resource_cleanups.provider, input.provider),
        eq(browser_provider_resource_cleanups.resource_type, 'session'),
        eq(browser_provider_resource_cleanups.provider_resource_id, sessionId),
      )).limit(1);
      if (existing && existing.userId !== input.userId) return false;
      if (existing) {
        await tx.update(browser_provider_resource_cleanups).set({
          release_requested_at: null,
          provider_confirmed_gone_at: null,
          updated_at: now,
        }).where(and(
          eq(browser_provider_resource_cleanups.provider, input.provider),
          eq(browser_provider_resource_cleanups.resource_type, 'session'),
          eq(browser_provider_resource_cleanups.provider_resource_id, sessionId),
          eq(browser_provider_resource_cleanups.user_id, input.userId),
        ));
      } else {
        await tx.insert(browser_provider_resource_cleanups).values({
          id: randomUUID(),
          user_id: input.userId,
          provider: input.provider,
          resource_type: 'session',
          provider_resource_id: sessionId,
          creation_expires_at: now,
          created_at: now,
          updated_at: now,
        });
      }
    }
    await tx.update(browser_provider_resource_cleanups).set({
      provider_confirmed_gone_at: now,
      updated_at: now,
    }).where(and(
      eq(browser_provider_resource_cleanups.id, input.cleanupId),
      eq(browser_provider_resource_cleanups.user_id, input.userId),
      isNull(browser_provider_resource_cleanups.provider_resource_id),
      isNull(browser_provider_resource_cleanups.provider_confirmed_gone_at),
    ));
    return true;
  });
}

async function seedLegacyResourceObligations(userId: string): Promise<void> {
  const packets = await db.select({ spec: generated_resumes.spec }).from(generated_resumes)
    .where(eq(generated_resumes.user_id, userId));
  const legacy = new Map<string, BrowserProviderResourceType>();
  for (const packet of packets) {
    const review = readApplicationReview(packet.spec);
    if (review?.browser_session_id) legacy.set(review.browser_session_id, 'session');
    if (review?.browser_context_id) legacy.set(review.browser_context_id, 'context');
  }
  if (legacy.size === 0) return;
  await db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, userId);
    const now = await databaseNow(tx);
    for (const [providerResourceId, resourceType] of legacy) {
      await tx.insert(browser_provider_resource_cleanups).values({
        id: randomUUID(),
        user_id: userId,
        provider: 'browserbase',
        resource_type: resourceType,
        provider_resource_id: providerResourceId,
        creation_expires_at: now,
        created_at: now,
        updated_at: now,
      }).onConflictDoNothing();
    }
  });
}

export async function drainBrowserProviderResourcesBeforeAccountDeletion(
  userId: string,
): Promise<{ ready: boolean; pending: number; confirmed: number }> {
  await seedLegacyResourceObligations(userId);
  const rows = await db.select().from(browser_provider_resource_cleanups).where(and(
    eq(browser_provider_resource_cleanups.user_id, userId),
    isNull(browser_provider_resource_cleanups.provider_confirmed_gone_at),
  ));
  let confirmed = 0;
  let sessionPending = false;
  const orderedRows = [...rows].sort((left, right) => (
    left.resource_type === right.resource_type ? 0 : left.resource_type === 'session' ? -1 : 1
  ));
  for (const row of orderedRows) {
    if (row.provider !== 'browserbase' && row.provider !== 'stratus') continue;
    const provider = row.provider;
    let providerResourceId = row.provider_resource_id;
    if (!providerResourceId) {
      if (row.resource_type !== 'session') {
        // No production path creates an unbound context. Keep an unexpected historical row as an
        // explicit quarantine rather than using a session query to claim the context is gone.
        sessionPending = true;
        continue;
      }
      const sessions = await browserSessionsForResourceReservation(row.id, provider);
      if (sessions.length > 1) {
        // One POST should yield one result, but if the provider reports several, persist every
        // exact remote id atomically before retiring the abstract reservation.
        await expandRecoveredSessions({
          userId,
          cleanupId: row.id,
          provider,
          sessions,
        });
        sessionPending = true;
        continue;
      }
      if (sessions[0]?.id) {
        providerResourceId = await bindRecoveredSession(userId, row.id, sessions[0].id);
        if (!providerResourceId) continue;
      } else {
        const now = await databaseNow(db);
        if (now.getTime() < row.creation_expires_at.getTime()) {
          sessionPending = true;
          continue;
        }
        // An authoritative metadata query after the provider creation window found no resource.
        await markResourceGone(userId, row.id);
        confirmed += 1;
        continue;
      }
    }
    if (row.resource_type === 'context') {
      if (sessionPending) continue;
      await deleteBrowserContext(providerResourceId, provider);
      await markResourceGone(userId, row.id);
      confirmed += 1;
      continue;
    }
    let gone = await browserSessionIsConfirmedGone(providerResourceId, provider);
    if (!gone && !row.release_requested_at) {
      await releaseBrowserSession(providerResourceId, provider);
      await markReleaseRequested(userId, row.id);
      gone = await browserSessionIsConfirmedGone(providerResourceId, provider);
    }
    if (!gone) {
      sessionPending = true;
      continue;
    }
    await markResourceGone(userId, row.id);
    confirmed += 1;
  }
  const [remaining] = await db.select({ count: sql<number>`count(*)::int` })
    .from(browser_provider_resource_cleanups).where(and(
      eq(browser_provider_resource_cleanups.user_id, userId),
      isNull(browser_provider_resource_cleanups.provider_confirmed_gone_at),
    ));
  const pending = remaining?.count ?? 0;
  return { ready: pending === 0, pending, confirmed };
}
