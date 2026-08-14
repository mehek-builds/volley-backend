import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync('src/routes/billing.ts', 'utf8');

test('checkout prevents recovery-state duplicates and preserves surface and customer ownership', () => {
  const checkout = source.slice(
    source.indexOf("fastify.post<{ Body: CheckoutBody }>('/billing/checkout'"),
    source.indexOf("fastify.post('/billing/portal'"),
  );
  assert.match(checkout, /subscriptionNeedsPortalRecovery\(billingStatus\)/);
  assert.match(checkout, /code: 'billing_recovery_required'/);
  assert.ok(
    checkout.indexOf('subscriptionNeedsPortalRecovery(billingStatus)')
      < checkout.indexOf("snapshot.access_class === 'plus_paid'"),
  );
  assert.match(checkout, /surface: expectedOffer\.surface/);
  assert.match(checkout, /actionNonce: body\.action_nonce/);
  assert.match(checkout, /pendingActionId: action\?\.id/);
  assert.match(source, /prior\.pending_action_id \?\? undefined/);
  assert.match(checkout, /existingCustomerId: account\?\.billing_provider === 'stripe'/);
  assert.match(checkout, /expiresAt: offer\.expires_at/);
  assert.match(checkout, /Date\.now\(\) \+ 31 \* 60 \* 1000/);
  assert.match(checkout, /liveOfferStatuses = \['creating', 'checkout_created'\]/);
  assert.match(checkout, /checkout_in_progress/);
  assert.match(checkout, /\.onConflictDoNothing\(\)\.returning\(\)/);
});

test('webhooks reconcile provider state while failed invoices retain their first failure boundary', () => {
  const webhook = source.slice(
    source.indexOf("fastify.post('/billing/stripe-webhook'"),
    source.indexOf("fastify.post('/billing/lemonsqueezy-webhook'"),
  );
  assert.match(webhook, /const authority = await retrieveStripeBillingAuthority\(\{ event \}\)/);
  assert.match(webhook, /const nextStatus = event\.status/);
  assert.match(webhook, /const invoiceAccessEndsAt = subscriptionEventAccessBoundary\(/);
  assert.match(webhook, /incomingAccessEndsAt: nextStatus === 'past_due' \? event\.createdAt : event\.accessEndsAt/);
  assert.match(webhook, /access_ends_at: invoiceAccessEndsAt/);
  assert.match(webhook, /shouldApplySubscriptionEvent\(/);
  assert.match(webhook, /!applySubscriptionState && !isCheckout/);
  assert.match(webhook, /if \(applySubscriptionState\) \{[\s\S]*?tx\.insert\(billing_subscriptions\)/);
  assert.ok(
    webhook.indexOf("status: 'paid'")
      > webhook.indexOf('if (applySubscriptionState)'),
  );
  assert.match(webhook, /cancelStripeSubscriptionOrThrow\(/);
  const refundFinalize = webhook.indexOf('if (!cancelAfterRefund)');
  const cancellation = webhook.indexOf('await cancelStripeSubscriptionOrThrow');
  const finalProcessed = webhook.indexOf("set({ result: 'processed'", cancellation);
  assert.ok(refundFinalize > 0);
  assert.ok(cancellation > refundFinalize);
  assert.ok(finalProcessed > cancellation);
});

test('checkout session persistence and pending-action linkage share a transaction and replay repairs gaps', () => {
  const persist = source.slice(
    source.indexOf('async function persistStripeCheckoutSession'),
    source.indexOf('async function replayCheckoutOffer'),
  );
  const replay = source.slice(
    source.indexOf('async function replayCheckoutOffer'),
    source.indexOf('async function createLitosCheckoutOffer'),
  );
  assert.match(persist, /return db\.transaction\(async \(tx\) =>/);
  assert.match(persist, /tx\.update\(pricing_offers\)/);
  assert.match(persist, /tx\.update\(pending_premium_actions\)/);
  assert.match(persist, /expires_at: input\.session\.expiresAt/);
  assert.match(replay, /repairCreating/);
  assert.match(replay, /repairCheckoutActionBinding/);
  assert.equal((replay.match(/expires_at: replayed\.expires_at\.toISOString\(\)/g) ?? []).length, 2);
});

test('an exact terminal event for a provider-confirmed deleted account is acknowledged narrowly', () => {
  const webhook = source.slice(
    source.indexOf("fastify.post('/billing/stripe-webhook'"),
    source.indexOf("fastify.post('/billing/lemonsqueezy-webhook'"),
  );
  assert.match(webhook, /event\.eventName === 'customer\.subscription\.deleted'/);
  assert.match(webhook, /billingSubscriptionTombstoneHash\('stripe', event\.subscriptionId\)/);
  assert.match(webhook, /deletionTombstone\?\.cancellation_confirmed_at && deletionTombstone\.account_deleted_at/);
  assert.match(webhook, /state: 'deleted_account_cancellation_confirmed'/);
  assert.match(webhook, /provider_object_id: null/);
  assert.ok(
    webhook.indexOf("event.eventName === 'customer.subscription.deleted'")
      < webhook.indexOf("if (!user) throw new Error('Stripe billing event did not map to a Litos account')"),
  );
});
