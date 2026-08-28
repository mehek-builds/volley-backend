import { FastifyReply } from 'fastify';
import { sql, and, eq } from 'drizzle-orm';
import { db, withDedicatedDatabase } from '../db/index';
import { usage_counters } from '../db/schema';
import { withReadOnlyRetry } from '../db/readOnlyRetry';
import { PRODUCT_NAME } from '../lib/product';
import { lemonSqueezyCheckoutReadyUrl } from '../lib/lemonSqueezy';
import { getEntitlementSnapshot, usesV2TrialMetering } from '../lib/entitlements';

// Compatibility allowances for grandfathered Free accounts and pre-cutover trials. Current
// Litos+ paid subscriptions are unlimited at the product layer and bypass these calendar-month
// counters. Rolling hourly controls below remain the plan-independent abuse boundary.
export const LIMITS = {
  free: {
    monthlyContacts: parseInt(process.env.FREE_MONTHLY_CONTACTS || '30', 10),
    monthlyDrafts: parseInt(process.env.FREE_MONTHLY_DRAFTS || '60', 10),
    monthlyResumes: parseInt(process.env.FREE_MONTHLY_RESUMES || '20', 10),
  },
  // Kept only so an already-granted legacy reverse trial retains its original allowance.
  pro: {
    monthlyContacts: parseInt(process.env.PRO_MONTHLY_CONTACTS || '500', 10),
    monthlyDrafts: parseInt(process.env.PRO_MONTHLY_DRAFTS || '1000', 10),
    monthlyResumes: parseInt(process.env.PRO_MONTHLY_RESUMES || '1000', 10),
  },
  // Abuse protection (rolling hour, per user or per email). resolve/draft/auth are
  // uncapped by request (2026-08-29); the remaining LLM-cost-bearing routes below
  // still meter through allowHourly().
  perHour: {
    // The dashboard prepares the user's top 30 daily matches as soon as the session opens.
    // Keep a small retry margin above that batch while preserving the per-user abuse ceiling.
    resume: parseInt(process.env.RATE_RESUME_PER_HOUR || '40', 10),
    jobExtract: parseInt(process.env.RATE_JOB_EXTRACT_PER_HOUR || '15', 10),
    /* The Apply-time pre-script scan (GET /postings/:jobId/questions), which is a managed browser
       run on a cache miss. Sized against the measured behaviour it has to support: a batch of 25
       applications in one sitting, each a first scan of a posting nobody has applied to yet, plus
       headroom for retries. Every later apply to the same posting is a cache hit and never reaches
       this counter. */
    postingQuestions: parseInt(process.env.RATE_POSTING_QUESTIONS_PER_HOUR || '60', 10),
    /* The requirement breakdown, which is a Sonnet call on a cache miss. Generous because a
       student reading a day's packets opens many and the cache makes most of them free; this is
       here to stop a loop, not to ration ordinary use. */
    jdRequirements: parseInt(process.env.RATE_JD_REQUIREMENTS_PER_HOUR || '60', 10),
    packetAudit: parseInt(process.env.RATE_PACKET_AUDIT_PER_HOUR || '30', 10),
  },
} as const;

export const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '7', 10);

export function monthPeriod(d = new Date()): string {
  return d.toISOString().slice(0, 7); // YYYY-MM
}

export function hourPeriod(d = new Date()): string {
  return d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

function counterLockKey(key: string, period: string, kind: string): string {
  return `${key}\x1f${period}\x1f${kind}`;
}

type CounterTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function counterWhere(key: string, period: string, kind: string) {
  return and(eq(usage_counters.key, key), eq(usage_counters.period, period), eq(usage_counters.kind, kind));
}

async function counterTransaction<T>(operation: (tx: CounterTx) => Promise<T>): Promise<T> {
  return withReadOnlyRetry(
    () => db.transaction(operation),
    {
      onRetry: (attempt) =>
        console.warn(
          `[quota] transaction rejected by a read-only backend, retrying on a fresh connection (attempt ${attempt})`,
        ),
      onExhausted: () =>
        withDedicatedDatabase((directDb) => {
          console.warn('[quota] pooled transaction stayed read-only; retrying on the direct database endpoint');
          return directDb.transaction(operation);
        }),
    },
  );
}

async function lockCounterRow(
  tx: CounterTx,
  key: string,
  period: string,
  kind: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${counterLockKey(key, period, kind)}, 0::bigint))`);
}

async function readCounterTotal(tx: CounterTx, key: string, period: string, kind: string): Promise<number> {
  const rows = await tx
    .select({ count: usage_counters.count })
    .from(usage_counters)
    .where(counterWhere(key, period, kind));
  return rows.reduce((total, row) => total + row.count, 0);
}

async function replaceCounterRows(tx: CounterTx, key: string, period: string, kind: string, count: number): Promise<number> {
  const normalizedCount = Math.max(0, count);
  await tx.delete(usage_counters).where(counterWhere(key, period, kind));
  if (normalizedCount === 0) return 0;
  const inserted = await tx
    .insert(usage_counters)
    .values({ key, period, kind, count: normalizedCount })
    .returning({ count: usage_counters.count });
  return inserted[0]?.count ?? normalizedCount;
}

// Atomic upsert-increment; returns the post-increment count.
export async function bumpCounter(key: string, period: string, kind: string, by = 1): Promise<number> {
  return counterTransaction(async (tx) => {
    await lockCounterRow(tx, key, period, kind);
    const nextCount = await readCounterTotal(tx, key, period, kind) + by;
    return replaceCounterRows(tx, key, period, kind, nextCount);
  });
}

// Atomically reserves one or more units without ever crossing the supplied cap.
// A null result means another request consumed the final slot first.
export async function claimCounterSlot(key: string, period: string, kind: string, limit: number, by = 1): Promise<number | null> {
  return counterTransaction(async (tx) => {
    await lockCounterRow(tx, key, period, kind);
    const currentCount = await readCounterTotal(tx, key, period, kind);
    if (currentCount + by > limit) {
      await replaceCounterRows(tx, key, period, kind, currentCount);
      return null;
    }
    return replaceCounterRows(tx, key, period, kind, currentCount + by);
  });
}

export async function releaseCounterSlot(key: string, period: string, kind: string, by = 1): Promise<void> {
  await counterTransaction(async (tx) => {
    await lockCounterRow(tx, key, period, kind);
    const nextCount = await readCounterTotal(tx, key, period, kind) - by;
    await replaceCounterRows(tx, key, period, kind, nextCount);
  });
}

export async function getCount(key: string, period: string, kind: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`coalesce(sum(${usage_counters.count}), 0)` })
    .from(usage_counters)
    .where(counterWhere(key, period, kind));
  return Number(rows[0]?.count ?? 0);
}

// Rolling-hour rate limit. Increments and returns true when the call is allowed.
export async function allowHourly(key: string, kind: string, limit: number): Promise<boolean> {
  const count = await bumpCounter(key, hourPeriod(), `rate:${kind}`);
  return count <= limit;
}

export interface Entitlements {
  tier: 'trial' | 'free' | 'pro';
  monthlyContacts: number;
  monthlyDrafts: number;
  monthlyResumes: number;
}

export async function getEntitlements(userId: string): Promise<Entitlements> {
  const snapshot = await getEntitlementSnapshot(userId);
  if (snapshot.access_class === 'plus_paid' || snapshot.access_class === 'legacy_paid') {
    return { tier: 'pro', ...LIMITS.pro };
  }
  if (snapshot.access_class === 'trial_plus') {
    return usesV2TrialMetering(snapshot)
      ? { tier: 'trial', monthlyContacts: 10, monthlyDrafts: 10, monthlyResumes: 5 }
      : { tier: 'trial', ...LIMITS.pro };
  }
  if (snapshot.access_class === 'free_grandfathered') {
    return { tier: 'free', ...LIMITS.free };
  }
  return { tier: 'free', monthlyContacts: 0, monthlyDrafts: 0, monthlyResumes: 0 };
}

// R-043: prod served the quota upsell with a Stripe TEST-mode checkout (buy.stripe.com/test_...),
// so a real quota'd student landed on a fake checkout that takes no money and grants nothing.
// A test-mode link is strictly worse than no link, so it is refused here rather than trusting
// every future env edit to get it right: the upsell then reads exactly as if no link were
// configured (quota info + reset date, no Upgrade sentence). Unset means the same thing, which
// is the intended state until a real payment rail exists. Live links pass through untouched.
export function upgradeUrl(): string | undefined {
  const lemonLink = lemonSqueezyCheckoutReadyUrl();
  if (lemonLink) return lemonLink;
  const link = process.env.UPGRADE_URL;
  if (!link) return undefined;
  if (/stripe\.com\/(c\/pay\/)?test_|cs_test_/.test(link)) return undefined;
  return link;
}

export function quotaExceededPayload(ent: Entitlements, used: number, what: 'contacts' | 'drafts' | 'resumes') {
  const upgradeLink = upgradeUrl();

  if (what === 'resumes') {
    const cap = ent.monthlyResumes;
    const base =
      ent.tier === 'free'
        ? `You've used your ${cap} free resume generations this month. ${PRODUCT_NAME}+ starts at $19.99/week and includes unlimited resume tailoring and autofill. Resets on the 1st.`
        : `You've hit this month's resume limit (${cap}). It resets on the 1st.`;
    return {
      error: upgradeLink && ent.tier === 'free' ? `${base} Upgrade: ${upgradeLink}` : base,
      code: 'quota_exceeded',
      used,
      limit: cap,
      tier: ent.tier,
      ...(upgradeLink && ent.tier === 'free' ? { upgrade_url: upgradeLink } : {}),
    };
  }

  const cap = what === 'contacts' ? ent.monthlyContacts : ent.monthlyDrafts;
  const base =
    ent.tier === 'pro'
      ? `You've hit this month's Pro limit (${cap} ${what}). It resets on the 1st.`
      : `You've used your ${cap} free verified ${what} this month. ${PRODUCT_NAME}+ unlocks unlimited ${what}.`;
  return {
    error: upgradeLink && ent.tier !== 'pro' ? `${base} Upgrade: ${upgradeLink}` : base,
    code: 'quota_exceeded',
    used,
    limit: cap,
    tier: ent.tier,
    ...(upgradeLink && ent.tier !== 'pro' ? { upgrade_url: upgradeLink } : {}),
  };
}

export function rateLimitedReply(reply: FastifyReply) {
  const now = new Date();
  const retryAfterSeconds = 60 * 60 - (now.getUTCMinutes() * 60 + now.getUTCSeconds());
  return reply
    .header('Retry-After', String(retryAfterSeconds))
    .header('Cache-Control', 'private, no-store')
    .status(429)
    .send({
      error: 'Slow down a little: too many requests. Try again in a few minutes.',
      code: 'rate_limited',
      retry_after_seconds: retryAfterSeconds,
    });
}

export function paidSafetyLimitPayload(used: number, limit: number, what: 'contacts' | 'drafts' | 'resumes', now = new Date()) {
  const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));
  return {
    error: `This account reached the monthly ${what} safety limit. It resets on the 1st. No plan change is needed.`,
    code: 'rate_limited' as const,
    reason: 'paid_safety_limit' as const,
    used,
    limit,
    retry_after_seconds: retryAfterSeconds,
    retry_at: resetAt.toISOString(),
  };
}

export function paidSafetyLimitedReply(
  reply: FastifyReply,
  used: number,
  limit: number,
  what: 'contacts' | 'drafts' | 'resumes',
) {
  const payload = paidSafetyLimitPayload(used, limit, what);
  return reply
    .header('Retry-After', String(payload.retry_after_seconds))
    .header('Cache-Control', 'private, no-store')
    .status(429)
    .send(payload);
}
