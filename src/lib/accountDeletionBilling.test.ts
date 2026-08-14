import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  accountDeletionBillingPlan,
  billingSubscriptionTombstoneHash,
  cancelBillingBeforeAccountDeletion,
  type DeletionBillingAccount,
} from './accountDeletionBilling';

const freeAccount: DeletionBillingAccount = {
  plan: 'free',
  billing_provider: null,
  billing_subscription_id: null,
  billing_status: null,
  billing_portal_url: null,
};

describe('account deletion recurring-billing precondition', () => {
  test('cancels every renewable Stripe subscription with a stable idempotency key', async () => {
    const calls: Array<{ subscriptionId: string; idempotencyKey: string }> = [];
    const result = await cancelBillingBeforeAccountDeletion({
      userId: '7e8de6fb-236b-4e9b-863a-7b4f2952e1a7',
      account: freeAccount,
      subscriptions: [{ provider: 'stripe', provider_subscription_id: 'sub_active', status: 'active' }],
      cancelStripe: async (input) => { calls.push(input); },
    });
    assert.deepEqual(result, { canceledStripeSubscriptions: ['sub_active'], block: null });
    assert.deepEqual(calls, [{
      subscriptionId: 'sub_active',
      idempotencyKey: 'litos-account-delete:7e8de6fb-236b-4e9b-863a-7b4f2952e1a7:sub_active',
    }]);
  });

  test('surfaces cancellation failure so the route cannot continue to deletion', async () => {
    await assert.rejects(cancelBillingBeforeAccountDeletion({
      userId: '7e8de6fb-236b-4e9b-863a-7b4f2952e1a7',
      account: freeAccount,
      subscriptions: [{ provider: 'stripe', provider_subscription_id: 'sub_active', status: 'past_due' }],
      cancelStripe: async () => { throw new Error('provider unavailable'); },
    }), /provider unavailable/);
  });

  test('preserves a legacy Lemon account until the customer manages billing', () => {
    const plan = accountDeletionBillingPlan({
      account: {
        plan: 'pro',
        billing_provider: 'lemonsqueezy',
        billing_subscription_id: 'legacy-subscription',
        billing_status: 'active',
        billing_portal_url: 'https://litos.lemonsqueezy.com/billing',
      },
      subscriptions: [],
    });
    assert.equal(plan.block?.code, 'billing_management_required');
    assert.equal(plan.block?.management_url, 'https://litos.lemonsqueezy.com/billing');
    assert.deepEqual(plan.stripeSubscriptionIds, []);
  });

  test('does not block an already terminal legacy subscription', () => {
    assert.deepEqual(accountDeletionBillingPlan({
      account: {
        ...freeAccount,
        plan: 'pro',
        billing_provider: 'lemonsqueezy',
        billing_subscription_id: 'legacy-subscription',
        billing_status: 'expired',
      },
      subscriptions: [],
    }), { stripeSubscriptionIds: [], block: null });
  });

  test('manual grants have no external renewal to orphan', () => {
    assert.deepEqual(accountDeletionBillingPlan({
      account: {
        ...freeAccount,
        plan: 'pro',
        billing_provider: 'manual',
        billing_subscription_id: 'operator-grant',
        billing_status: 'active',
      },
      subscriptions: [{ provider: 'manual', provider_subscription_id: 'operator-grant', status: 'active' }],
    }), { stripeSubscriptionIds: [], block: null });
  });

  test('uses a stable pseudonymous subscription receipt without retaining the provider id', () => {
    const hash = billingSubscriptionTombstoneHash('stripe', 'sub_private_value');
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(hash.includes('sub_private_value'), false);
    assert.equal(hash, billingSubscriptionTombstoneHash('stripe', 'sub_private_value'));
    assert.notEqual(hash, billingSubscriptionTombstoneHash('lemonsqueezy', 'sub_private_value'));
  });

  test('provider cancellation and blockers occur before any irreversible delete work', () => {
    const source = readFileSync('src/routes/account.ts', 'utf8');
    const cancel = source.indexOf('await cancelBillingBeforeAccountDeletion');
    const blobs = source.indexOf('deletedFiles = await deleteBlobsForUser', cancel);
    const userDelete = source.indexOf('await tx.delete(users)', cancel);
    assert.ok(cancel > 0);
    assert.ok(blobs > cancel);
    assert.ok(userDelete > blobs);
    assert.match(source, /code: 'billing_cancellation_failed'/);
    assert.match(source, /account_preserved: true/);
    assert.match(source, /billing_account_deletion_tombstones/);
    assert.match(source, /account_deleted_at: new Date\(\)/);
  });
});
