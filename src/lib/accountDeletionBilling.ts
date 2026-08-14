import { createHash } from 'node:crypto';
import { cancelStripeSubscriptionOrThrow, secureLegacyBillingPortalUrl } from './stripeBilling';

const TERMINAL_SUBSCRIPTION_STATUSES = new Set([
  'canceled',
  'cancelled',
  'expired',
  'refunded',
]);

export function billingSubscriptionTombstoneHash(provider: string, subscriptionId: string): string {
  return createHash('sha256').update(`litos-billing-deletion-v1\0${provider}\0${subscriptionId}`).digest('hex');
}

export type DeletionBillingSubscription = {
  provider: string;
  provider_subscription_id: string;
  status: string;
};

export type DeletionBillingAccount = {
  plan: string;
  billing_provider: string | null;
  billing_subscription_id: string | null;
  billing_status: string | null;
  billing_portal_url: string | null;
};

export type AccountDeletionBillingBlock = {
  code: 'billing_management_required' | 'billing_support_required';
  provider: string;
  message: string;
  management_url: string | null;
};

export function accountDeletionBillingPlan(input: {
  account: DeletionBillingAccount;
  subscriptions: DeletionBillingSubscription[];
}): { stripeSubscriptionIds: string[]; block: AccountDeletionBillingBlock | null } {
  const candidates = new Map<string, { provider: string; subscriptionId: string; status: string }>();
  for (const subscription of input.subscriptions) {
    if (TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status.toLowerCase())) continue;
    if (subscription.provider.toLowerCase() === 'manual') continue;
    candidates.set(`${subscription.provider}:${subscription.provider_subscription_id}`, {
      provider: subscription.provider.toLowerCase(),
      subscriptionId: subscription.provider_subscription_id,
      status: subscription.status,
    });
  }

  const legacyProvider = input.account.billing_provider?.toLowerCase() ?? null;
  const legacySubscriptionId = input.account.billing_subscription_id;
  const legacyStatus = input.account.billing_status?.toLowerCase() ?? null;
  const legacyLooksRenewable = Boolean(
    legacyProvider
    && legacyProvider !== 'manual'
    && (legacySubscriptionId || input.account.plan === 'pro' || input.account.plan === 'plus')
    && (!legacyStatus || !TERMINAL_SUBSCRIPTION_STATUSES.has(legacyStatus)),
  );
  if (legacyLooksRenewable) {
    candidates.set(`${legacyProvider}:${legacySubscriptionId ?? 'missing'}`, {
      provider: legacyProvider!,
      subscriptionId: legacySubscriptionId ?? '',
      status: legacyStatus ?? 'unknown',
    });
  }

  const unsupported = Array.from(candidates.values()).find((candidate) => candidate.provider !== 'stripe');
  if (unsupported) {
    const isLemon = unsupported.provider === 'lemonsqueezy';
    return {
      stripeSubscriptionIds: [],
      block: {
        code: isLemon ? 'billing_management_required' : 'billing_support_required',
        provider: unsupported.provider,
        message: isLemon
          ? 'Cancel the legacy Lemon Squeezy subscription before deleting this account.'
          : 'Contact support to cancel the active legacy subscription before deleting this account.',
        management_url: isLemon ? secureLegacyBillingPortalUrl(input.account.billing_portal_url) : null,
      },
    };
  }

  const stripeSubscriptionIds = Array.from(candidates.values()).map((candidate) => candidate.subscriptionId);
  if (stripeSubscriptionIds.some((subscriptionId) => !subscriptionId.startsWith('sub_'))) {
    return {
      stripeSubscriptionIds: [],
      block: {
        code: 'billing_support_required',
        provider: 'stripe',
        message: 'Contact support to identify and cancel the active Stripe subscription before deleting this account.',
        management_url: null,
      },
    };
  }
  return { stripeSubscriptionIds: [...new Set(stripeSubscriptionIds)], block: null };
}

export async function cancelBillingBeforeAccountDeletion(input: {
  userId: string;
  account: DeletionBillingAccount;
  subscriptions: DeletionBillingSubscription[];
  cancelStripe?: (input: { subscriptionId: string; idempotencyKey: string }) => Promise<void>;
}): Promise<{ canceledStripeSubscriptions: string[]; block: AccountDeletionBillingBlock | null }> {
  const plan = accountDeletionBillingPlan(input);
  if (plan.block) return { canceledStripeSubscriptions: [], block: plan.block };
  const cancelStripe = input.cancelStripe ?? cancelStripeSubscriptionOrThrow;
  for (const subscriptionId of plan.stripeSubscriptionIds) {
    await cancelStripe({
      subscriptionId,
      idempotencyKey: `litos-account-delete:${input.userId}:${subscriptionId}`,
    });
  }
  return { canceledStripeSubscriptions: plan.stripeSubscriptionIds, block: null };
}
