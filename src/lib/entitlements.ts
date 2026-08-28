import { createHash, randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  applications,
  billing_subscriptions,
  entitlement_usage_reservations,
  outreach_draft_generations,
  usage_counters,
  trial_answer_applications,
  trial_company_usage,
  trial_generation_usage,
  user_contact_unlocks,
  resolve_cache,
  users,
} from '../db/schema';
import { type BillingTerm } from './billingCatalog';
import { chooseCanonicalAccountSubscription, subscriptionGrantsPlus } from './subscriptionState';
import { packetAuditSha256 } from './packetAudit';
import type { OutreachDraftType } from './outreachDraftTypes';

export const ENTITLEMENT_POLICY_VERSION = 'litos-entitlements-v2' as const;
export const TRIAL_DAYS = 7;
export const TRIAL_LIMITS = {
  tailored_resumes: 5,
  cover_letters: 5,
  answer_applications: 5,
  outreach_companies: 5,
  contacts_per_company: 2,
  drafts_per_company: 2,
} as const;

export const LEGACY_FREE_LIMITS = {
  tailored_resumes_monthly: 20,
  contacts_monthly: 30,
  drafts_monthly: 60,
  cover_letters_unmetered: true,
  application_answers_unmetered: true,
} as const;

export type AccessClass =
  | 'free_new'
  | 'trial_plus'
  | 'free_grandfathered'
  | 'plus_paid'
  | 'legacy_paid';

export const FEATURE_KEYS = [
  'application_fill',
  'application_tracking',
  'job_discovery',
  'base_resume_use',
  'saved_profile_use',
  'saved_answer_use',
  'document_management',
  'application_review',
  'manual_submission_controls',
  'account_data_controls',
  'ai_resume_tailoring',
  'hover_generation',
  'ai_resume_feedback',
  'ai_cover_letter_generation',
  'ai_application_answer_generation',
  'saved_generated_versions',
  'contact_discovery',
  'outreach_email_generation',
  'networking_discovery',
  'referral_paths',
  'connected_companies',
  'advanced_job_insights',
  'recruiter_visibility',
  'automatic_submission',
] as const;

export type FeatureKey = typeof FEATURE_KEYS[number];
export type FeatureMap = Record<FeatureKey, boolean>;

export type EntitlementUserPolicy = {
  id: string;
  plan: string;
  created_at: Date | null;
  trial_started_at: Date | null;
  trial_ends_at: Date | null;
  entitlement_policy_version: string;
  grandfather_policy: string | null;
  entitlement_revision: string;
  manual_access_override: string | null;
  manual_access_override_ends_at: Date | null;
  automatic_submission_enabled: boolean;
  automatic_submission_legacy_granted: boolean;
  billing_provider: string | null;
  billing_status: string | null;
  billing_variant_id: string | null;
  billing_renews_at: Date | null;
  billing_ends_at: Date | null;
  billing_customer_id: string | null;
};

export type EntitlementSubscription = {
  provider: string;
  status: string;
  term_code: string;
  cancel_at_period_end: boolean;
  current_period_start: Date | null;
  current_period_end: Date | null;
  access_ends_at: Date | null;
  provider_customer_id: string;
};

export type EntitlementSnapshot = {
  schema_version: 2;
  policy_version: typeof ENTITLEMENT_POLICY_VERSION;
  account_id: string;
  revision: string;
  evaluated_at: string;
  access_class: AccessClass;
  legacy_tier: 'free' | 'trial' | 'pro';
  product: 'litos_plus' | null;
  term: BillingTerm | 'year' | 'manual' | null;
  features: FeatureMap;
  trial: null | {
    meter_policy: 'litos_plus_v2_lifetime';
    starts_at: string;
    ends_at: string;
    active: boolean;
    tailored_resumes_used: number;
    tailored_resumes_limit: 5;
    cover_letters_used: number;
    cover_letters_limit: 5;
    answer_applications_used: number;
    answer_applications_limit: 5;
    outreach_companies_used: number;
    outreach_companies_limit: 5;
    company_usage: Array<{
      company_scope_key: string;
      company_name: string;
      contacts_used: number;
      contacts_limit: 2;
      drafts_used: number;
      drafts_limit: 2;
    }>;
  } | {
    meter_policy: 'legacy_monthly_allowances';
    starts_at: string;
    ends_at: string;
    active: boolean;
  };
  legacy_limits: null | typeof LEGACY_FREE_LIMITS;
  subscription: null | {
    provider: 'stripe' | 'lemonsqueezy' | 'manual';
    status: string;
    cancel_at_period_end: boolean;
    current_period_start: string | null;
    current_period_end: string | null;
    access_ends_at: string | null;
    management_available: boolean;
  };
};

function toIso(value: Date | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function cutoverInstant(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.ENTITLEMENT_V2_CUTOVER_AT?.trim();
  if (!raw) return null;
  const value = Date.parse(raw);
  return Number.isFinite(value) ? value : null;
}

function overrideActive(user: EntitlementUserPolicy, expected: string, now: Date): boolean {
  if (user.manual_access_override !== expected) return false;
  return !user.manual_access_override_ends_at || user.manual_access_override_ends_at > now;
}

function normalizedLegacyBillingStatus(value: string | null): string | null {
  if (value === 'on_trial') return 'trialing';
  if (value === 'cancelled') return 'canceled';
  return value;
}

// Lemon Squeezy and the original manual billing path projected lifecycle state onto users before
// billing_subscriptions existed. Those compatibility fields remain authoritative only when no
// canonical subscription row exists. A terminal or bounded legacy grant must stop at the same
// exact boundary as a canonical subscription, while a truly unbounded manual or active grant can
// remain active until its provider state changes.
function legacyCompatibilityGrantsPlus(user: EntitlementUserPolicy, now: Date): boolean {
  if (user.plan !== 'pro' && user.plan !== 'plus') return false;
  const status = normalizedLegacyBillingStatus(user.billing_status);
  if (!status) {
    const manualProvider = !user.billing_provider || user.billing_provider === 'manual';
    if (!manualProvider) return false;
    return subscriptionGrantsPlus({
      status: 'active',
      cancel_at_period_end: Boolean(user.billing_ends_at),
      current_period_end: user.billing_renews_at,
      access_ends_at: user.billing_ends_at,
    }, now);
  }
  return subscriptionGrantsPlus({
    status,
    cancel_at_period_end: (status === 'active' || status === 'trialing') && Boolean(user.billing_ends_at),
    current_period_end: user.billing_renews_at,
    access_ends_at: user.billing_ends_at,
  }, now);
}

export function inferGrandfathered(user: EntitlementUserPolicy, env: NodeJS.ProcessEnv = process.env): boolean {
  if (user.grandfather_policy === 'legacy_free_v1' || user.grandfather_policy === 'legacy_paid_v1') return true;
  if (user.entitlement_policy_version === ENTITLEMENT_POLICY_VERSION) return false;
  const cutover = cutoverInstant(env);
  return cutover !== null && Boolean(user.created_at && user.created_at.getTime() < cutover);
}

export function resolveAccessClass(input: {
  user: EntitlementUserPolicy;
  subscription?: EntitlementSubscription | null;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): AccessClass {
  const now = input.now ?? new Date();
  const { user, subscription } = input;
  const grandfathered = inferGrandfathered(user, input.env);
  const legacyPaid = user.grandfather_policy === 'legacy_paid_v1';
  if (overrideActive(user, 'plus_paid', now)) return legacyPaid ? 'legacy_paid' : 'plus_paid';
  if (subscription && subscriptionGrantsPlus(subscription, now)) {
    /* A Stripe subscription sitting in `trialing` is the trial, not a purchase.
       It has to land on `trial_plus` and not `plus_paid`, because those two
       classes hand out different products: plus_paid is unmetered, trial_plus is
       the 5/5/5 + 2-per-company meter that the pricing page, the FAQ, and every
       contextual upgrade prompt describe. Reading `trialing` as paid would
       silently give a trialling account unlimited generation and make all of that
       copy wrong.
       legacyPaid still wins, and a non-Stripe provider still falls to
       legacy_paid: neither of those can be a Stripe trial by definition. */
    if (subscription.provider === 'stripe' && subscription.status === 'trialing' && !legacyPaid) {
      return 'trial_plus';
    }
    return legacyPaid || subscription.provider !== 'stripe' ? 'legacy_paid' : 'plus_paid';
  }
  // Preserve old Pro and Plus rows only until a classified subscription exists. Once v2 owns the
  // lifecycle, its inactive state must not be overridden by a stale compatibility projection.
  if (!subscription && legacyCompatibilityGrantsPlus(user, now)) {
    const legacyProvider = Boolean(user.billing_provider && user.billing_provider !== 'stripe');
    return legacyPaid || grandfathered || legacyProvider ? 'legacy_paid' : 'plus_paid';
  }
  // A migration must never cut short a trial that was already granted. Once that exact trial
  // boundary passes, the account falls back to its grandfathered or new-Free policy.
  if (user.trial_ends_at && user.trial_ends_at > now) return 'trial_plus';
  if (overrideActive(user, 'free_grandfathered', now) || grandfathered) return 'free_grandfathered';
  return 'free_new';
}

export function featuresForAccess(input: {
  accessClass: AccessClass;
  automaticSubmissionLegacyGranted?: boolean;
}): FeatureMap {
  const alwaysFree = new Set<FeatureKey>([
    'application_fill',
    'application_tracking',
    'job_discovery',
    'base_resume_use',
    'saved_profile_use',
    'saved_answer_use',
    'document_management',
    'application_review',
    'manual_submission_controls',
    'account_data_controls',
  ]);
  const legacyGeneration = new Set<FeatureKey>([
    'ai_resume_tailoring',
    'ai_resume_feedback',
    'ai_cover_letter_generation',
    'ai_application_answer_generation',
    'saved_generated_versions',
    'contact_discovery',
    'outreach_email_generation',
  ]);
  const fullPlus = input.accessClass === 'trial_plus'
    || input.accessClass === 'plus_paid'
    || input.accessClass === 'legacy_paid';
  const features = Object.fromEntries(FEATURE_KEYS.map((key) => [key, alwaysFree.has(key)])) as FeatureMap;
  if (fullPlus) {
    for (const key of FEATURE_KEYS) features[key] = true;
  } else if (input.accessClass === 'free_grandfathered') {
    for (const key of legacyGeneration) features[key] = true;
    features.automatic_submission = input.automaticSubmissionLegacyGranted === true;
  }
  // Trial generation is intentionally click-only. Hover generation is a paid convenience and
  // never consumes a no-card trial unit in the background.
  features.hover_generation = input.accessClass === 'plus_paid' || input.accessClass === 'legacy_paid';
  return features;
}

export function legacyTierForAccess(accessClass: AccessClass): 'free' | 'trial' | 'pro' {
  if (accessClass === 'trial_plus') return 'trial';
  if (accessClass === 'plus_paid' || accessClass === 'legacy_paid') return 'pro';
  return 'free';
}

function normalizedProvider(value: string | null | undefined): 'stripe' | 'lemonsqueezy' | 'manual' {
  if (value === 'stripe' || value === 'lemonsqueezy') return value;
  return 'manual';
}

function normalizedTerm(value: string | null | undefined): BillingTerm | 'year' | 'manual' | null {
  if (value === 'week' || value === 'weekly') return 'week';
  if (value === 'month' || value === 'monthly') return 'month';
  if (value === 'quarter' || value === 'quarterly') return 'quarter';
  if (value === 'year' || value === 'annual' || value === 'yearly') return 'year';
  return value ? 'manual' : null;
}

export function buildEntitlementSnapshot(input: {
  user: EntitlementUserPolicy;
  subscription?: EntitlementSubscription | null;
  generationUsage?: { tailored_resumes_used: number; cover_letters_used: number; answer_applications_used: number } | null;
  companyUsage?: Array<{ company_scope_key: string; company_name: string; contacts_used: number; drafts_used: number }>;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): EntitlementSnapshot {
  const now = input.now ?? new Date();
  const accessClass = resolveAccessClass({ ...input, now });
  const fullPaid = accessClass === 'plus_paid' || accessClass === 'legacy_paid';
  const trial = accessClass === 'trial_plus';
  const legacyReverseTrial = trial
    && inferGrandfathered(input.user, input.env)
    && input.user.grandfather_policy !== 'legacy_paid_v1';
  const subscription = input.subscription;
  const fallbackSubscription = fullPaid && !subscription
    ? {
      provider: normalizedProvider(input.user.billing_provider),
      status: input.user.billing_status ?? 'active',
      cancel_at_period_end: Boolean(input.user.billing_ends_at),
      current_period_start: null,
      current_period_end: input.user.billing_renews_at,
      access_ends_at: input.user.billing_ends_at,
      management_available: Boolean(input.user.billing_customer_id),
    }
    : null;
  /* WHERE THE TRIAL WINDOW COMES FROM, and it is no longer always the user row.
     A trial granted at signup wrote trial_started_at/trial_ends_at; a trial that lives
     on a Stripe subscription writes neither, so falling back to created_at + 7 days
     would date the window from the ACCOUNT rather than from the trial. A student who
     signs up, walks setup over a fortnight and enters a card on day 10 would be told
     their trial ended on day 8 -- expired two days before Stripe started it -- and
     `active` would read false while they are genuinely trialling and paying for it.
     The subscription carries the true boundary: for a trialling subscription Stripe's
     current_period_end IS the trial end, which is already what subscriptionGrantsPlus
     measures against. */
  const subscriptionTrial = subscription?.status === 'trialing' ? subscription : null;
  const trialStart = subscriptionTrial?.current_period_start
    ?? input.user.trial_started_at ?? input.user.created_at ?? now;
  const trialEnd = subscriptionTrial?.current_period_end
    ?? input.user.trial_ends_at ?? new Date(trialStart.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  const companyUsage = input.companyUsage ?? [];
  return {
    schema_version: 2,
    policy_version: ENTITLEMENT_POLICY_VERSION,
    account_id: input.user.id,
    // Derived access joins the stored revision so a trial or grace-period boundary changes the
    // ETag even when no webhook or usage write occurs at that instant.
    revision: `${input.user.entitlement_revision}:${accessClass}`,
    evaluated_at: now.toISOString(),
    access_class: accessClass,
    legacy_tier: legacyTierForAccess(accessClass),
    product: fullPaid || trial ? 'litos_plus' : null,
    term: normalizedTerm(subscription?.term_code ?? input.user.billing_variant_id),
    features: featuresForAccess({
      accessClass,
      automaticSubmissionLegacyGranted: input.user.automatic_submission_legacy_granted,
    }),
    trial: trial && legacyReverseTrial ? {
      meter_policy: 'legacy_monthly_allowances',
      starts_at: trialStart.toISOString(),
      ends_at: trialEnd.toISOString(),
      active: trialEnd > now,
    } : trial ? {
      meter_policy: 'litos_plus_v2_lifetime',
      starts_at: trialStart.toISOString(),
      ends_at: trialEnd.toISOString(),
      active: trialEnd > now,
      tailored_resumes_used: input.generationUsage?.tailored_resumes_used ?? 0,
      tailored_resumes_limit: TRIAL_LIMITS.tailored_resumes,
      cover_letters_used: input.generationUsage?.cover_letters_used ?? 0,
      cover_letters_limit: TRIAL_LIMITS.cover_letters,
      answer_applications_used: input.generationUsage?.answer_applications_used ?? 0,
      answer_applications_limit: TRIAL_LIMITS.answer_applications,
      outreach_companies_used: companyUsage.length,
      outreach_companies_limit: TRIAL_LIMITS.outreach_companies,
      company_usage: companyUsage.map((row) => ({
        ...row,
        contacts_limit: TRIAL_LIMITS.contacts_per_company,
        drafts_limit: TRIAL_LIMITS.drafts_per_company,
      })),
    } : null,
    legacy_limits: accessClass === 'free_grandfathered' ? LEGACY_FREE_LIMITS : null,
    subscription: subscription ? {
      provider: normalizedProvider(subscription.provider),
      status: subscription.status,
      cancel_at_period_end: subscription.cancel_at_period_end,
      current_period_start: toIso(subscription.current_period_start),
      current_period_end: toIso(subscription.current_period_end),
      access_ends_at: toIso(subscription.access_ends_at),
      management_available: Boolean(subscription.provider_customer_id),
    } : fallbackSubscription ? {
      ...fallbackSubscription,
      current_period_start: null,
      current_period_end: toIso(fallbackSubscription.current_period_end),
      access_ends_at: toIso(fallbackSubscription.access_ends_at),
    } : null,
  };
}

export function usesV2TrialMetering(snapshot: EntitlementSnapshot): boolean {
  return snapshot.access_class === 'trial_plus'
    && snapshot.trial?.meter_policy === 'litos_plus_v2_lifetime';
}

export function usesLegacyMonthlyProductQuota(snapshot: EntitlementSnapshot): boolean {
  if (usesV2TrialMetering(snapshot)) return false;
  return snapshot.access_class !== 'plus_paid' && snapshot.access_class !== 'legacy_paid';
}

export async function getEntitlementSnapshot(
  userId: string,
  now = new Date(),
  executor: Pick<typeof db, 'select'> = db,
): Promise<EntitlementSnapshot> {
  const [user] = await executor.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  // Keep these reads sequential so a transaction-scoped executor never starts concurrent queries
  // on one checked-out pg client. Default callers still receive the same snapshot shape.
  const subscriptions = await executor.select().from(billing_subscriptions)
    .where(eq(billing_subscriptions.user_id, userId));
  const generationRows = await executor.select().from(trial_generation_usage)
    .where(eq(trial_generation_usage.user_id, userId)).limit(1);
  const companyRows = await executor.select().from(trial_company_usage)
    .where(eq(trial_company_usage.user_id, userId))
    .orderBy(trial_company_usage.created_at);
  return buildEntitlementSnapshot({
    user,
    subscription: chooseCanonicalAccountSubscription(subscriptions, now),
    generationUsage: generationRows[0] ?? null,
    companyUsage: companyRows,
    now,
  });
}

export type EntitlementDenialReason =
  | 'trial_expired'
  | 'trial_resume_limit'
  | 'trial_cover_letter_limit'
  | 'trial_answer_application_limit'
  | 'trial_company_limit'
  | 'trial_company_contact_limit'
  | 'trial_company_draft_limit'
  | 'subscription_inactive';

export function entitlementDeniedPayload(input: {
  feature: FeatureKey;
  reason: EntitlementDenialReason;
  trigger: string;
  used?: number;
  limit?: number;
}) {
  return {
    error: 'This action is part of Litos+.',
    code: 'entitlement_required' as const,
    feature: input.feature,
    reason: input.reason,
    trigger: input.trigger,
    ...(input.used === undefined ? {} : { used: input.used }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    billing_state_url: '/billing/state',
    plans_url: '/billing/plans',
  };
}

export async function requireFeature(userId: string, feature: FeatureKey, trigger: string) {
  const snapshot = await getEntitlementSnapshot(userId);
  if (snapshot.features[feature]) return { allowed: true as const, snapshot };
  return {
    allowed: false as const,
    snapshot,
    denial: entitlementDeniedPayload({
      feature,
      reason: snapshot.access_class === 'free_new' ? 'trial_expired' : 'subscription_inactive',
      trigger,
    }),
  };
}

export function canonicalCompanyScope(input: { companyId?: string | null; domain?: string | null; companyName: string }): string {
  const domain = input.domain?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (domain && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return `domain:${domain}`;
  const normalized = input.companyName.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (normalized) return `name:${createHash('sha256').update(normalized).digest('hex').slice(0, 24)}`;
  // A client-supplied UUID is never allowed to split one represented employer into arbitrary
  // trial buckets. It is only a final fallback for internal callers that have no company facts.
  if (input.companyId && /^[0-9a-f-]{36}$/i.test(input.companyId)) return `company:${input.companyId.toLowerCase()}`;
  return `name:${createHash('sha256').update('').digest('hex').slice(0, 24)}`;
}

export type TrialUsageKind = 'tailored_resume' | 'cover_letter' | 'answer_application' | 'contact' | 'draft';

export type UsageReservationResult =
  | {
    allowed: true;
    snapshot: EntitlementSnapshot;
    reservationId: string | null;
    units: number;
    replay?: EntitledUsageReplay;
  }
  | { allowed: false; snapshot: EntitlementSnapshot; denial: ReturnType<typeof entitlementDeniedPayload> };

export type EntitledUsageReplay = {
  statusCode: number;
  body: unknown;
};

const reservationFeature: Record<TrialUsageKind, FeatureKey> = {
  tailored_resume: 'ai_resume_tailoring',
  cover_letter: 'ai_cover_letter_generation',
  answer_application: 'ai_application_answer_generation',
  contact: 'contact_discovery',
  draft: 'outreach_email_generation',
};

const reservationTtlMs = 15 * 60 * 1000;
const reservationCompletionGraceMs = 24 * 60 * 60 * 1000;
const reservationReplayMaxBytes = 1024 * 1024;

export async function purgeExpiredEntitledUsageResults(now = new Date()): Promise<number> {
  const rows = await db.update(entitlement_usage_reservations).set({
    result_status_code: null,
    result_envelope: null,
    result_expires_at: null,
  }).where(lte(entitlement_usage_reservations.result_expires_at, now))
    .returning({ id: entitlement_usage_reservations.id });
  return rows.length;
}

export function entitledUsageRequestHash(kind: TrialUsageKind, request: unknown): string {
  return packetAuditSha256({ usage_kind: kind, request });
}

function reservationConflict(code: 'idempotency_conflict' | 'operation_in_progress' | 'operation_already_committed') {
  const messages = {
    idempotency_conflict: 'This operation id is already bound to a different request.',
    operation_in_progress: 'This operation is already in progress.',
    operation_already_committed: 'This operation already completed and cannot regenerate work.',
  } as const;
  return Object.assign(new Error(messages[code]), { statusCode: 409, code });
}

function assertReservationBinding(
  reservation: typeof entitlement_usage_reservations.$inferSelect,
  input: { scopeKey: string; requestHash: string; requestedUnits?: number },
): void {
  if (
    reservation.scope_key !== input.scopeKey
    || (reservation.request_hash !== '' && reservation.request_hash !== input.requestHash)
    || (input.requestedUnits !== undefined && reservation.requested_units !== input.requestedUnits)
  ) {
    throw reservationConflict('idempotency_conflict');
  }
}

function replayFromReservation(
  reservation: typeof entitlement_usage_reservations.$inferSelect,
  now: Date,
): EntitledUsageReplay | null {
  if (
    reservation.status !== 'committed'
    || reservation.result_envelope === null
    || reservation.result_status_code === null
    || reservation.result_expires_at === null
    || reservation.result_expires_at <= now
  ) return null;
  if (reservation.result_status_code < 200 || reservation.result_status_code > 299) return null;
  return { statusCode: reservation.result_status_code, body: reservation.result_envelope };
}

function normalizedUsageReplay(input: EntitledUsageReplay): EntitledUsageReplay {
  if (!Number.isInteger(input.statusCode) || input.statusCode < 200 || input.statusCode > 299) {
    throw new Error('Usage replay status must be a successful HTTP status');
  }
  const serialized = JSON.stringify(input.body);
  if (serialized === undefined) throw new Error('Usage replay body must be JSON serializable');
  if (Buffer.byteLength(serialized, 'utf8') > reservationReplayMaxBytes) {
    throw new Error('Usage replay body exceeds the bounded receipt size');
  }
  return { statusCode: input.statusCode, body: JSON.parse(serialized) as unknown };
}

export async function getEntitledUsageReplay(input: {
  userId: string;
  kind: TrialUsageKind;
  idempotencyKey: string;
  scopeKey: string;
  requestHash: string;
  requestedUnits?: number;
  now?: Date;
}): Promise<EntitledUsageReplay | null> {
  const now = input.now ?? new Date();
  const [reservation] = await db.select().from(entitlement_usage_reservations).where(and(
    eq(entitlement_usage_reservations.user_id, input.userId),
    eq(entitlement_usage_reservations.usage_kind, input.kind),
    eq(entitlement_usage_reservations.idempotency_key, input.idempotencyKey),
  )).limit(1);
  if (!reservation) return null;
  assertReservationBinding(reservation, input);
  const replay = replayFromReservation(reservation, now);
  if (replay) return replay;
  if (reservation.status === 'reserved') {
    if (reservation.expires_at <= now) {
      await db.update(entitlement_usage_reservations).set({ status: 'expired', released_at: now })
        .where(and(
          eq(entitlement_usage_reservations.id, reservation.id),
          eq(entitlement_usage_reservations.status, 'reserved'),
          lte(entitlement_usage_reservations.expires_at, now),
        ));
      return null;
    }
    throw reservationConflict('operation_in_progress');
  }
  if (reservation.status === 'committed') {
    if (reservation.result_expires_at && reservation.result_expires_at <= now) {
      await db.update(entitlement_usage_reservations).set({
        result_status_code: null,
        result_envelope: null,
        result_expires_at: null,
      }).where(and(
        eq(entitlement_usage_reservations.id, reservation.id),
        lte(entitlement_usage_reservations.result_expires_at, now),
      ));
    }
    throw reservationConflict('operation_already_committed');
  }
  return null;
}

export async function reserveEntitledUsage(input: {
  userId: string;
  kind: TrialUsageKind;
  idempotencyKey: string;
  requestHash?: string;
  trigger: string;
  applicationId?: string;
  companyScopeKey?: string;
  companyName?: string;
  units?: number;
  now?: Date;
}): Promise<UsageReservationResult> {
  const now = input.now ?? new Date();
  const feature = reservationFeature[input.kind];
  const requestedUnits = Math.max(1, input.units ?? 1);
  let scopeKey = input.applicationId ?? 'global';
  if (input.kind === 'answer_application' && !input.applicationId) {
    throw Object.assign(new Error('applicationId is required'), { statusCode: 400 });
  }
  if (input.kind === 'contact' || input.kind === 'draft') {
    if (!input.companyScopeKey || !input.companyName) {
      throw Object.assign(new Error('company scope is required'), { statusCode: 400 });
    }
    scopeKey = input.companyScopeKey;
  }
  const requestHash = input.requestHash ?? entitledUsageRequestHash(input.kind, {
    scope_key: scopeKey,
    requested_units: requestedUnits,
  });
  const priorReplay = await getEntitledUsageReplay({
    userId: input.userId,
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    scopeKey,
    requestHash,
    requestedUnits,
    now,
  });
  if (priorReplay) {
    return {
      allowed: true,
      snapshot: await getEntitlementSnapshot(input.userId, now),
      reservationId: null,
      units: requestedUnits,
      replay: priorReplay,
    };
  }
  const featureVerdict = await requireFeature(input.userId, feature, input.trigger);
  if (!featureVerdict.allowed) return featureVerdict;
  const snapshot = featureVerdict.snapshot;
  const metered = usesV2TrialMetering(snapshot);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`entitlement:${input.userId}`}, 0::bigint))`);
    await tx.update(entitlement_usage_reservations).set({
      result_status_code: null,
      result_envelope: null,
      result_expires_at: null,
    }).where(and(
      eq(entitlement_usage_reservations.user_id, input.userId),
      lte(entitlement_usage_reservations.result_expires_at, now),
    ));
    const reservationBoundary = now;
    await tx.update(entitlement_usage_reservations).set({
      status: 'expired',
      released_at: now,
    }).where(and(
      eq(entitlement_usage_reservations.user_id, input.userId),
      eq(entitlement_usage_reservations.status, 'reserved'),
      sql`${entitlement_usage_reservations.expires_at} <= ${reservationBoundary}`,
    ));
    await tx.execute(sql`
      delete from ${trial_company_usage} company
      where company.user_id = ${input.userId}
        and company.contacts_used = 0
        and company.drafts_used = 0
        and not exists (
          select 1 from ${entitlement_usage_reservations} pending
          where pending.trial_company_usage_id = company.id
            and pending.status in ('reserved', 'committed')
        )
    `);
    const existing = await tx.select().from(entitlement_usage_reservations).where(and(
      eq(entitlement_usage_reservations.user_id, input.userId),
      eq(entitlement_usage_reservations.usage_kind, input.kind),
      eq(entitlement_usage_reservations.idempotency_key, input.idempotencyKey),
    )).limit(1);
    if (existing[0]) {
      assertReservationBinding(existing[0], { scopeKey, requestHash, requestedUnits });
      const replay = replayFromReservation(existing[0], now);
      if (replay) return {
        allowed: true as const,
        snapshot,
        reservationId: existing[0].id,
        units: existing[0].units,
        replay,
      };
      if (existing[0].status === 'reserved') throw reservationConflict('operation_in_progress');
      if (existing[0].status === 'committed') throw reservationConflict('operation_already_committed');
    }

    const reserveOperation = async (meteredReservation: boolean, trialCompanyUsageId: string | null) => {
      const values = {
        feature_key: feature,
        scope_key: scopeKey,
        request_hash: requestHash,
        requested_units: requestedUnits,
        units: requestedUnits,
        metered: meteredReservation,
        status: 'reserved',
        trial_company_usage_id: trialCompanyUsageId,
        expires_at: new Date(now.getTime() + reservationTtlMs),
        committed_at: null,
        released_at: null,
        result_status_code: null,
        result_envelope: null,
        result_expires_at: null,
      } as const;
      const [reservation] = existing[0]
        ? await tx.update(entitlement_usage_reservations).set(values)
          .where(eq(entitlement_usage_reservations.id, existing[0].id)).returning()
        : await tx.insert(entitlement_usage_reservations).values({
          user_id: input.userId,
          usage_kind: input.kind,
          idempotency_key: input.idempotencyKey,
          ...values,
        }).returning();
      return { allowed: true as const, snapshot, reservationId: reservation.id, units: requestedUnits };
    };
    if (!metered) return reserveOperation(false, null);

    let trialCompanyId: string | null = null;
    let used = 0;
    let limit = 0;
    let reason: EntitlementDenialReason = 'trial_expired';
    if (input.kind === 'tailored_resume' || input.kind === 'cover_letter' || input.kind === 'answer_application') {
      const [usage] = await tx.insert(trial_generation_usage).values({ user_id: input.userId })
        .onConflictDoNothing().returning();
      const [current] = usage ? [usage] : await tx.select().from(trial_generation_usage)
        .where(eq(trial_generation_usage.user_id, input.userId)).limit(1);
      if (input.kind === 'tailored_resume') {
        used = current?.tailored_resumes_used ?? 0;
        limit = TRIAL_LIMITS.tailored_resumes;
        reason = 'trial_resume_limit';
      } else if (input.kind === 'cover_letter') {
        used = current?.cover_letters_used ?? 0;
        limit = TRIAL_LIMITS.cover_letters;
        reason = 'trial_cover_letter_limit';
      } else {
        const grant = await tx.select().from(trial_answer_applications).where(and(
          eq(trial_answer_applications.user_id, input.userId),
          eq(trial_answer_applications.application_id, scopeKey),
        )).limit(1);
        if (grant[0]) return reserveOperation(false, null);
        used = current?.answer_applications_used ?? 0;
        limit = TRIAL_LIMITS.answer_applications;
        reason = 'trial_answer_application_limit';
      }
      const pending = input.kind === 'answer_application'
        ? await tx.select({
          units: sql<number>`count(distinct ${entitlement_usage_reservations.scope_key})::int`,
          current_scope_pending: sql<number>`count(*) filter (where ${entitlement_usage_reservations.scope_key} = ${scopeKey})::int`,
        }).from(entitlement_usage_reservations).where(and(
          eq(entitlement_usage_reservations.user_id, input.userId),
          eq(entitlement_usage_reservations.usage_kind, input.kind),
          eq(entitlement_usage_reservations.metered, true),
          eq(entitlement_usage_reservations.status, 'reserved'),
          gt(entitlement_usage_reservations.expires_at, reservationBoundary),
        ))
        : await tx.select({
          units: sql<number>`coalesce(sum(${entitlement_usage_reservations.units}), 0)::int`,
          current_scope_pending: sql<number>`0::int`,
        }).from(entitlement_usage_reservations).where(and(
          eq(entitlement_usage_reservations.user_id, input.userId),
          eq(entitlement_usage_reservations.usage_kind, input.kind),
          eq(entitlement_usage_reservations.metered, true),
          eq(entitlement_usage_reservations.status, 'reserved'),
          gt(entitlement_usage_reservations.expires_at, reservationBoundary),
        ));
      const extraUnits = input.kind === 'answer_application' && Number(pending[0]?.current_scope_pending ?? 0) > 0
        ? 0
        : requestedUnits;
      if (used + Number(pending[0]?.units ?? 0) + extraUnits > limit) {
        return { allowed: false as const, snapshot, denial: entitlementDeniedPayload({ feature, reason, trigger: input.trigger, used, limit }) };
      }
    } else {
      let [company] = await tx.select().from(trial_company_usage).where(and(
        eq(trial_company_usage.user_id, input.userId),
        eq(trial_company_usage.company_scope_key, scopeKey),
      )).limit(1);
      if (!company) {
        const rows = await tx.select({ count: sql<number>`count(*)::int` }).from(trial_company_usage)
          .where(eq(trial_company_usage.user_id, input.userId));
        if (Number(rows[0]?.count ?? 0) >= TRIAL_LIMITS.outreach_companies) {
          return {
            allowed: false as const,
            snapshot,
            denial: entitlementDeniedPayload({
              feature,
              reason: 'trial_company_limit',
              trigger: input.trigger,
              used: Number(rows[0]?.count ?? 0),
              limit: TRIAL_LIMITS.outreach_companies,
            }),
          };
        }
        [company] = await tx.insert(trial_company_usage).values({
          user_id: input.userId,
          company_scope_key: scopeKey,
          company_name: input.companyName!,
        }).returning();
      }
      trialCompanyId = company.id;
      used = input.kind === 'contact' ? company.contacts_used : company.drafts_used;
      limit = input.kind === 'contact' ? TRIAL_LIMITS.contacts_per_company : TRIAL_LIMITS.drafts_per_company;
      reason = input.kind === 'contact' ? 'trial_company_contact_limit' : 'trial_company_draft_limit';
      const pending = await tx.select({ units: sql<number>`coalesce(sum(${entitlement_usage_reservations.units}), 0)` })
        .from(entitlement_usage_reservations).where(and(
          eq(entitlement_usage_reservations.user_id, input.userId),
          eq(entitlement_usage_reservations.usage_kind, input.kind),
          eq(entitlement_usage_reservations.metered, true),
          eq(entitlement_usage_reservations.scope_key, scopeKey),
          eq(entitlement_usage_reservations.status, 'reserved'),
          gt(entitlement_usage_reservations.expires_at, reservationBoundary),
        ));
      if (used + Number(pending[0]?.units ?? 0) + requestedUnits > limit) {
        return { allowed: false as const, snapshot, denial: entitlementDeniedPayload({ feature, reason, trigger: input.trigger, used, limit }) };
      }
    }
    return reserveOperation(true, trialCompanyId);
  });
}

export async function commitEntitledUsage(
  reservationId: string | null,
  actualUnits = 1,
  now = new Date(),
  replayInput?: EntitledUsageReplay,
): Promise<void> {
  if (!reservationId) return;
  const replay = replayInput ? normalizedUsageReplay(replayInput) : null;
  const replayValues = replay ? {
    result_status_code: replay.statusCode,
    result_envelope: replay.body,
    result_expires_at: new Date(now.getTime() + reservationCompletionGraceMs),
  } : {
    result_status_code: null,
    result_envelope: null,
    result_expires_at: null,
  };
  await db.transaction(async (tx) => {
    const [initialReservation] = await tx.select().from(entitlement_usage_reservations)
      .where(eq(entitlement_usage_reservations.id, reservationId)).limit(1);
    if (!initialReservation) return;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`entitlement:${initialReservation.user_id}`}, 0::bigint))`);
    const [reservation] = await tx.select().from(entitlement_usage_reservations)
      .where(eq(entitlement_usage_reservations.id, reservationId)).limit(1);
    if (!reservation) return;
    if (reservation.status === 'committed') {
      if (replay && reservation.result_envelope === null) {
        await tx.update(entitlement_usage_reservations).set(replayValues)
          .where(eq(entitlement_usage_reservations.id, reservationId));
      }
      return;
    }
    if (reservation.status !== 'reserved') throw new Error('Usage reservation is not active');
    const units = Math.min(reservation.units, Math.max(0, actualUnits));
    if (units === 0) {
      await tx.update(entitlement_usage_reservations).set(replay ? {
        status: 'committed',
        committed_at: now,
        released_at: null,
        trial_company_usage_id: null,
        units: 0,
        ...replayValues,
      } : {
        status: 'released',
        released_at: now,
        units: 0,
        ...replayValues,
      })
        .where(eq(entitlement_usage_reservations.id, reservationId));
      if (reservation.trial_company_usage_id) {
        await tx.execute(sql`
          delete from ${trial_company_usage}
          where ${trial_company_usage.id} = ${reservation.trial_company_usage_id}
            and ${trial_company_usage.contacts_used} = 0
            and ${trial_company_usage.drafts_used} = 0
            and not exists (
              select 1 from ${entitlement_usage_reservations} pending
              where pending.trial_company_usage_id = ${reservation.trial_company_usage_id}
                and pending.id <> ${reservationId}
                and pending.status in ('reserved', 'committed')
            )
        `);
      }
      if (replay) {
        await tx.update(users).set({ entitlement_revision: randomUUID() }).where(eq(users.id, reservation.user_id));
      }
      return;
    }
    if (!reservation.metered) {
      await tx.update(entitlement_usage_reservations).set({
        status: 'committed',
        units,
        committed_at: now,
        ...replayValues,
      }).where(eq(entitlement_usage_reservations.id, reservationId));
      return;
    }
    if (reservation.usage_kind === 'tailored_resume') {
      await tx.update(trial_generation_usage).set({
        tailored_resumes_used: sql`${trial_generation_usage.tailored_resumes_used} + ${units}`,
        updated_at: now,
      }).where(eq(trial_generation_usage.user_id, reservation.user_id));
    } else if (reservation.usage_kind === 'cover_letter') {
      await tx.update(trial_generation_usage).set({
        cover_letters_used: sql`${trial_generation_usage.cover_letters_used} + ${units}`,
        updated_at: now,
      }).where(eq(trial_generation_usage.user_id, reservation.user_id));
    } else if (reservation.usage_kind === 'answer_application') {
      const granted = await tx.insert(trial_answer_applications).values({
        user_id: reservation.user_id,
        application_id: reservation.scope_key,
        granted_at: now,
      }).onConflictDoNothing().returning({ application_id: trial_answer_applications.application_id });
      if (granted.length > 0) {
        await tx.update(trial_generation_usage).set({
          answer_applications_used: sql`${trial_generation_usage.answer_applications_used} + ${units}`,
          updated_at: now,
        }).where(eq(trial_generation_usage.user_id, reservation.user_id));
      }
      await tx.update(entitlement_usage_reservations).set({
        status: 'committed',
        units: granted.length > 0 ? units : 0,
        committed_at: now,
        ...replayValues,
      }).where(eq(entitlement_usage_reservations.id, reservationId));
      await tx.update(users).set({ entitlement_revision: randomUUID() }).where(eq(users.id, reservation.user_id));
      return;
    } else if (reservation.trial_company_usage_id) {
      const field = reservation.usage_kind === 'contact' ? trial_company_usage.contacts_used : trial_company_usage.drafts_used;
      await tx.update(trial_company_usage).set({
        [reservation.usage_kind === 'contact' ? 'contacts_used' : 'drafts_used']: sql`${field} + ${units}`,
        updated_at: now,
      }).where(eq(trial_company_usage.id, reservation.trial_company_usage_id));
    }
    await tx.update(entitlement_usage_reservations).set({
      status: 'committed',
      units,
      committed_at: now,
      ...replayValues,
    }).where(eq(entitlement_usage_reservations.id, reservationId));
    await tx.update(users).set({ entitlement_revision: randomUUID() }).where(eq(users.id, reservation.user_id));
  });
}

export type PersistedOutreachDraft = {
  draft_id: string;
  operation_id: string;
  draft_type: OutreachDraftType;
  generation_source: 'ai_generated' | 'user_written';
  contact_id: string;
  contact_email: string | null;
  application_id: string;
  company_scope_key: string;
  company_name: string;
  role: string;
  subject: string;
  body: string;
  word_count: number;
  warnings: string[];
  created_at: string;
  updated_at: string;
};

export function persistedOutreachDraftResponse(row: typeof outreach_draft_generations.$inferSelect): PersistedOutreachDraft {
  return {
    draft_id: row.id,
    operation_id: row.operation_id,
    draft_type: row.draft_type as OutreachDraftType,
    generation_source: row.generation_source as 'ai_generated' | 'user_written',
    contact_id: row.contact_id,
    contact_email: row.contact_email,
    application_id: row.application_id,
    company_scope_key: row.company_scope_key,
    company_name: row.company_name,
    role: row.role,
    subject: row.subject,
    body: row.body,
    word_count: row.word_count,
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// The immutable outreach artifact, its idempotent replay receipt, and every applicable quota
// counter cross the same transaction boundary. No client can receive a draft that is missing its
// canonical row or consume quota without a result it can replay after a lost response.
export async function commitOutreachDraftGeneration(input: {
  reservationId: string;
  userId: string;
  operationId: string;
  requestHash: string;
  contactId: string;
  applicationId: string;
  companyScopeKey: string;
  companyName: string;
  role: string;
  draftType: OutreachDraftType;
  contactEmail?: string | null;
  draft: { subject: string; body: string; word_count: number; warnings: string[] };
  legacyMonthlyCounterPeriod?: string;
  now?: Date;
}): Promise<PersistedOutreachDraft> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`entitlement:${input.userId}`}, 0::bigint))`);
    const [reservation] = await tx.select().from(entitlement_usage_reservations).where(and(
      eq(entitlement_usage_reservations.id, input.reservationId),
      eq(entitlement_usage_reservations.user_id, input.userId),
    )).limit(1);
    if (!reservation) throw new Error('Draft reservation was not found');
    const [application] = await tx.select().from(applications).where(and(
      eq(applications.id, input.applicationId),
      eq(applications.user_id, input.userId),
    )).limit(1);
    if (!application) throw new Error('Draft application is not owned by this account');
    const [contactUnlock] = await tx.select().from(user_contact_unlocks).where(and(
      eq(user_contact_unlocks.user_id, input.userId),
      eq(user_contact_unlocks.contact_id, input.contactId),
    )).limit(1);
    if (!contactUnlock) throw new Error('Draft contact is not unlocked by this account');
    if (
      reservation.usage_kind !== 'draft'
      || reservation.scope_key !== input.companyScopeKey
      || reservation.request_hash !== input.requestHash
      || application.company_scope_key !== input.companyScopeKey
      || application.company_name !== input.companyName
      || application.role !== input.role
      || contactUnlock.company_scope_key !== input.companyScopeKey
    ) throw new Error('Draft reservation does not match its canonical context');

    const [prior] = await tx.select().from(outreach_draft_generations).where(and(
      eq(outreach_draft_generations.user_id, input.userId),
      eq(outreach_draft_generations.operation_id, input.operationId),
    )).limit(1);
    if (prior) {
      if (
        prior.request_hash !== input.requestHash
        || prior.contact_id !== input.contactId
        || prior.application_id !== input.applicationId
        || prior.company_scope_key !== input.companyScopeKey
        || prior.draft_type !== input.draftType
      ) throw reservationConflict('idempotency_conflict');
      return persistedOutreachDraftResponse(prior);
    }
    if (reservation.status !== 'reserved') throw new Error('Draft reservation is not active');

    const [created] = await tx.insert(outreach_draft_generations).values({
      user_id: input.userId,
      operation_id: input.operationId,
      request_hash: input.requestHash,
      contact_id: input.contactId,
      application_id: input.applicationId,
      company_scope_key: input.companyScopeKey,
      company_name: input.companyName,
      role: input.role,
      draft_type: input.draftType,
      generation_source: 'ai_generated',
      contact_email: input.contactEmail ?? null,
      original_subject: input.draft.subject,
      original_body: input.draft.body,
      subject: input.draft.subject,
      body: input.draft.body,
      word_count: input.draft.word_count,
      warnings: input.draft.warnings,
      created_at: now,
      updated_at: now,
    }).returning();
    if (!created) throw new Error('Draft persistence returned no record');
    const response = persistedOutreachDraftResponse(created);
    const replay = normalizedUsageReplay({ statusCode: 200, body: response });

    if (reservation.metered) {
      if (!reservation.trial_company_usage_id) throw new Error('Metered draft is missing its company ledger');
      await tx.update(trial_company_usage).set({
        drafts_used: sql`${trial_company_usage.drafts_used} + 1`,
        updated_at: now,
      }).where(eq(trial_company_usage.id, reservation.trial_company_usage_id));
    }
    if (input.legacyMonthlyCounterPeriod) {
      await tx.insert(usage_counters).values({
        key: input.userId,
        period: input.legacyMonthlyCounterPeriod,
        kind: 'drafts',
        count: 1,
      }).onConflictDoUpdate({
        target: [usage_counters.key, usage_counters.period, usage_counters.kind],
        set: { count: sql`${usage_counters.count} + 1` },
      });
    }
    await tx.update(entitlement_usage_reservations).set({
      status: 'committed',
      units: 1,
      committed_at: now,
      released_at: null,
      result_status_code: replay.statusCode,
      result_envelope: replay.body,
      result_expires_at: new Date(now.getTime() + reservationCompletionGraceMs),
    }).where(eq(entitlement_usage_reservations.id, reservation.id));
    if (reservation.metered) {
      await tx.update(users).set({ entitlement_revision: randomUUID() }).where(eq(users.id, input.userId));
    }
    return response;
  });
}

export async function commitContactUnlocks(input: {
  userId: string;
  companyScopeKey: string;
  contactIds: string[];
  source: string;
  reservationId: string | null;
  replay?: EntitledUsageReplay;
  cache?: { key: string; results: unknown; source: string };
  now?: Date;
}): Promise<number> {
  const now = input.now ?? new Date();
  const contactIds = [...new Set(input.contactIds)];
  if (contactIds.length === 0) {
    await commitEntitledUsage(input.reservationId, 0, now, input.replay);
    return 0;
  }
  const replay = input.replay ? normalizedUsageReplay(input.replay) : null;
  const replayValues = replay ? {
    result_status_code: replay.statusCode,
    result_envelope: replay.body,
    result_expires_at: new Date(now.getTime() + reservationCompletionGraceMs),
  } : {
    result_status_code: null,
    result_envelope: null,
    result_expires_at: null,
  };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`entitlement:${input.userId}`}, 0::bigint))`);
    const reservation = input.reservationId
      ? (await tx.select().from(entitlement_usage_reservations).where(and(
        eq(entitlement_usage_reservations.id, input.reservationId),
        eq(entitlement_usage_reservations.user_id, input.userId),
      )).limit(1))[0]
      : undefined;
    if (input.reservationId && !reservation) throw new Error('Contact reservation was not found');
    if (reservation?.status === 'committed') return 0;
    if (reservation && (
      reservation.status !== 'reserved'
      || reservation.usage_kind !== 'contact'
      || reservation.scope_key !== input.companyScopeKey
    )) {
      throw new Error('Contact reservation is not active for this company');
    }
    const limitedContactIds = reservation ? contactIds.slice(0, reservation.units) : contactIds;
    const inserted = await tx.insert(user_contact_unlocks).values(
      limitedContactIds.map((contactId) => ({
        user_id: input.userId,
        contact_id: contactId,
        company_scope_key: input.companyScopeKey,
        source: input.source,
        unlocked_at: now,
      })),
    ).onConflictDoNothing().returning({ contact_id: user_contact_unlocks.contact_id });
    const insertedCount = inserted.length;
    if (input.cache && (!reservation || reservation.status === 'reserved')) {
      await tx.insert(resolve_cache).values({
        cache_key: input.cache.key,
        results: input.cache.results,
        source: input.cache.source,
        cached_at: now,
      }).onConflictDoUpdate({
        target: resolve_cache.cache_key,
        set: { results: input.cache.results, source: input.cache.source, cached_at: now },
      });
    }
    if (!reservation) return insertedCount;
    if (insertedCount > 0 && reservation.trial_company_usage_id) {
      await tx.update(trial_company_usage).set({
        contacts_used: sql`${trial_company_usage.contacts_used} + ${insertedCount}`,
        updated_at: now,
      }).where(eq(trial_company_usage.id, reservation.trial_company_usage_id));
    }
    await tx.update(entitlement_usage_reservations).set({
      status: insertedCount > 0 || replay ? 'committed' : 'released',
      units: insertedCount,
      committed_at: insertedCount > 0 || replay ? now : null,
      released_at: insertedCount > 0 || replay ? null : now,
      trial_company_usage_id: insertedCount === 0 && replay ? null : reservation.trial_company_usage_id,
      ...replayValues,
    }).where(eq(entitlement_usage_reservations.id, reservation.id));
    if (insertedCount === 0 && reservation.trial_company_usage_id) {
      await tx.execute(sql`
        delete from ${trial_company_usage}
        where ${trial_company_usage.id} = ${reservation.trial_company_usage_id}
          and ${trial_company_usage.contacts_used} = 0
          and ${trial_company_usage.drafts_used} = 0
          and not exists (
            select 1 from ${entitlement_usage_reservations} pending
            where pending.trial_company_usage_id = ${reservation.trial_company_usage_id}
              and pending.id <> ${reservation.id}
              and pending.status in ('reserved', 'committed')
          )
      `);
    }
    await tx.update(users).set({ entitlement_revision: randomUUID() }).where(eq(users.id, input.userId));
    return insertedCount;
  });
}

export async function releaseEntitledUsage(reservationId: string | null, now = new Date()): Promise<void> {
  if (!reservationId) return;
  await db.transaction(async (tx) => {
    const [initialReservation] = await tx.select().from(entitlement_usage_reservations)
      .where(eq(entitlement_usage_reservations.id, reservationId)).limit(1);
    if (!initialReservation) return;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`entitlement:${initialReservation.user_id}`}, 0::bigint))`);
    const [reservation] = await tx.select().from(entitlement_usage_reservations)
      .where(eq(entitlement_usage_reservations.id, reservationId)).limit(1);
    if (!reservation || reservation.status !== 'reserved') return;
    await tx.update(entitlement_usage_reservations).set({ status: 'released', released_at: now })
      .where(eq(entitlement_usage_reservations.id, reservationId));
    if (reservation.trial_company_usage_id) {
      await tx.execute(sql`
        delete from ${trial_company_usage}
        where ${trial_company_usage.id} = ${reservation.trial_company_usage_id}
          and ${trial_company_usage.contacts_used} = 0
          and ${trial_company_usage.drafts_used} = 0
          and not exists (
            select 1 from ${entitlement_usage_reservations} pending
            where pending.trial_company_usage_id = ${reservation.trial_company_usage_id}
              and pending.status in ('reserved', 'committed')
          )
      `);
    }
  });
}
