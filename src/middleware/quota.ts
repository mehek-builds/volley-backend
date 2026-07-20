import { FastifyReply } from 'fastify';
import { sql, and, eq } from 'drizzle-orm';
import { db } from '../db/index';
import { usage_counters, users } from '../db/schema';
import { PRODUCT_NAME } from '../lib/product';

// Pricing model per PRD Section 10 (v0) + product decision 2026-07-02, revised same day
// to a recurring-credits model (Apollo.io-style, not a one-time lifetime trial): every
// feature - outreach AND resume-gen/autofill - is available on the free tier, including
// 20 resume generations per month that reset like everything else. This keeps free
// students coming back every month (job searches run for months, not a single session),
// rather than a one-time trial that either converts immediately or churns the student
// out entirely. Crossing 20/month - or wanting it removed entirely - is what moves a
// student onto the $49.99/mo paid tier, which sets an effectively-unlimited monthly
// resume quota instead. Gate volume, not discovery. All enforcement is server-side so
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
    // Effectively unlimited (bounded, not Infinity, so it round-trips cleanly through
    // JSON/DB) - the $49.99/mo tier's whole point is no meaningful resume cap.
    monthlyResumes: parseInt(process.env.PRO_MONTHLY_RESUMES || '100000', 10),
  },
  // Abuse protection (rolling hour, per user or per email)
  perHour: {
    resolve: parseInt(process.env.RATE_RESOLVE_PER_HOUR || '15', 10),
    draft: parseInt(process.env.RATE_DRAFT_PER_HOUR || '40', 10),
    resume: parseInt(process.env.RATE_RESUME_PER_HOUR || '15', 10),
    requestCode: parseInt(process.env.RATE_CODE_PER_HOUR || '5', 10),
    session: parseInt(process.env.RATE_SESSION_PER_HOUR || '10', 10),
  },
} as const;

export const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '7', 10);

export function monthPeriod(d = new Date()): string {
  return d.toISOString().slice(0, 7); // YYYY-MM
}

export function hourPeriod(d = new Date()): string {
  return d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

// Atomic upsert-increment; returns the post-increment count.
export async function bumpCounter(key: string, period: string, kind: string, by = 1): Promise<number> {
  const rows = await db
    .insert(usage_counters)
    .values({ key, period, kind, count: by })
    .onConflictDoUpdate({
      target: [usage_counters.key, usage_counters.period, usage_counters.kind],
      set: { count: sql`${usage_counters.count} + ${by}` },
    })
    .returning({ count: usage_counters.count });
  return rows[0]?.count ?? by;
}

export async function getCount(key: string, period: string, kind: string): Promise<number> {
  const rows = await db
    .select({ count: usage_counters.count })
    .from(usage_counters)
    .where(and(eq(usage_counters.key, key), eq(usage_counters.period, period), eq(usage_counters.kind, kind)))
    .limit(1);
  return rows[0]?.count ?? 0;
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

export function quotaExceededPayload(ent: Entitlements, used: number, what: 'contacts' | 'drafts' | 'resumes') {
  const upgradeLink = process.env.UPGRADE_URL || process.env.STRIPE_PAYMENT_LINK;

  if (what === 'resumes') {
    const cap = ent.monthlyResumes;
    const base =
      ent.tier === 'free'
        ? `You've used your ${cap} free resume generations this month. ${PRODUCT_NAME} Pro ($49.99/mo) unlocks unlimited resume generation + autofill. Resets on the 1st.`
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
  return reply.status(429).send({ error: 'Slow down a little: too many requests. Try again in a few minutes.', code: 'rate_limited' });
}
