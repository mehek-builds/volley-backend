import { FastifyReply } from 'fastify';
import { sql, and, eq } from 'drizzle-orm';
import { db, withDedicatedDatabase } from '../db/index';
import { usage_counters, users } from '../db/schema';
import { withReadOnlyRetry } from '../db/readOnlyRetry';
import { PRODUCT_NAME } from '../lib/product';
import { lemonSqueezyCheckoutReadyUrl } from '../lib/lemonSqueezy';

// Pricing model per PRD Section 10 (v0) + product decision 2026-07-02, revised same day
// to a recurring-credits model (Apollo.io-style, not a one-time lifetime trial): every
// feature - outreach AND resume-gen/autofill - is available on the free tier, including
// 20 resume generations per month that reset like everything else. This keeps free
// students coming back every month (job searches run for months, not a single session),
// rather than a one-time trial that either converts immediately or churns the student
// out entirely. Crossing 20/month is what moves a student onto the $49.99/mo paid tier,
// which includes 1,000 resume generations per month. Gate volume, not discovery. All enforcement is server-side so
// every client version is covered. Limits are env-tunable without a redeploy of intent.
export const LIMITS = {
  free: {
    monthlyContacts: parseInt(process.env.FREE_MONTHLY_CONTACTS || '30', 10),
    monthlyDrafts: parseInt(process.env.FREE_MONTHLY_DRAFTS || '60', 10),
    monthlyResumes: parseInt(process.env.FREE_MONTHLY_RESUMES || '20', 10),
  },
  pro: {
    monthlyContacts: parseInt(process.env.PRO_MONTHLY_CONTACTS || '500', 10),
    monthlyDrafts: parseInt(process.env.PRO_MONTHLY_DRAFTS || '1000', 10),
    monthlyResumes: parseInt(process.env.PRO_MONTHLY_RESUMES || '1000', 10),
  },
  // Abuse protection (rolling hour, per user or per email)
  perHour: {
    resolve: parseInt(process.env.RATE_RESOLVE_PER_HOUR || '15', 10),
    draft: parseInt(process.env.RATE_DRAFT_PER_HOUR || '40', 10),
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
    /* Reading back a stored employer-portal password. Sized to be generous for the real use (open
       the portal, copy the password, occasionally re-copy it) and mean to anything that wants to
       walk a session's credentials in bulk. Every reveal is also counted on the row itself, so the
       owner can see how often it happened. */
    portalCredentialReveal: parseInt(process.env.RATE_PORTAL_CREDENTIAL_REVEAL_PER_HOUR || '20', 10),
    requestCode: parseInt(process.env.RATE_CODE_PER_HOUR || '5', 10),
    session: parseInt(process.env.RATE_SESSION_PER_HOUR || '10', 10),
    requestCodePerIp: parseInt(process.env.RATE_CODE_IP_PER_HOUR || '50', 10),
    verifyCodePerIp: parseInt(process.env.RATE_VERIFY_IP_PER_HOUR || '200', 10),
    sessionPerIp: parseInt(process.env.RATE_SESSION_IP_PER_HOUR || '100', 10),
    passwordLogin: parseInt(process.env.RATE_PASSWORD_LOGIN_PER_HOUR || '10', 10),
    passwordLoginPerIp: parseInt(process.env.RATE_PASSWORD_LOGIN_IP_PER_HOUR || '100', 10),
    passwordChange: parseInt(process.env.RATE_PASSWORD_CHANGE_PER_HOUR || '5', 10),
    passwordChangePerIp: parseInt(process.env.RATE_PASSWORD_CHANGE_IP_PER_HOUR || '30', 10),
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
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  // 'plus' is a legacy value from the short-lived 2026-07-01 Plus-tier resolution -
  // treated identically to 'pro' now that resume-gen isn't a separate paid add-on.
  if (user?.plan === 'pro' || user?.plan === 'plus') {
    return { tier: 'pro', ...LIMITS.pro };
  }
  // Reverse trial: full (pro-level) limits for the first TRIAL_DAYS after signup.
  // trial_ends_at is set at signup; users created before this field existed fall
  // back to created_at + TRIAL_DAYS.
  const trialEnd = user?.trial_ends_at
    ? new Date(user.trial_ends_at)
    : user?.created_at
      ? new Date(new Date(user.created_at).getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000)
      : new Date(0);
  if (trialEnd > new Date()) {
    return { tier: 'trial', ...LIMITS.pro };
  }
  return { tier: 'free', ...LIMITS.free };
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
        ? `You've used your ${cap} free resume generations this month. ${PRODUCT_NAME} Pro ($49.99/mo) includes ${LIMITS.pro.monthlyResumes.toLocaleString()} resume generations + autofill. Resets on the 1st.`
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
      : `You've used your ${cap} free verified ${what} this month. ${PRODUCT_NAME} Pro unlocks ${what === 'contacts' ? LIMITS.pro.monthlyContacts : LIMITS.pro.monthlyDrafts} per month.`;
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
