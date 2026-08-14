import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PAST_DUE_GRACE_MS,
  chooseCanonicalAccountSubscription,
  statusAfterDisputeClosed,
  shouldApplySubscriptionEvent,
  subscriptionEventAccessBoundary,
  subscriptionGrantsPlus,
  subscriptionNeedsPortalRecovery,
} from './subscriptionState';

describe('Litos+ subscription state', () => {
  const boundary = new Date('2026-08-14T12:00:00.000Z');

  test('keeps active access and applies the disclosed three-day past-due grace', () => {
    assert.equal(subscriptionGrantsPlus({ status: 'active' }, boundary), true);
    assert.equal(subscriptionGrantsPlus({ status: 'past_due', current_period_end: boundary }, new Date(boundary.getTime() + PAST_DUE_GRACE_MS - 1)), true);
    assert.equal(subscriptionGrantsPlus({ status: 'past_due', current_period_end: boundary }, new Date(boundary.getTime() + PAST_DUE_GRACE_MS)), false);
    const futureRenewalPeriod = new Date('2026-09-14T12:00:00.000Z');
    assert.equal(subscriptionGrantsPlus({
      status: 'past_due',
      current_period_end: futureRenewalPeriod,
      access_ends_at: boundary,
    }, new Date(boundary.getTime() + PAST_DUE_GRACE_MS)), false);
  });

  test('scheduled cancellation grants active or trialing access only before its stored boundary', () => {
    const beforeBoundary = new Date(boundary.getTime() - 1);
    const afterBoundary = new Date(boundary.getTime() + 1);
    for (const status of ['active', 'trialing']) {
      assert.equal(subscriptionGrantsPlus({
        status,
        cancel_at_period_end: true,
        current_period_end: boundary,
      }, beforeBoundary), true);
      assert.equal(subscriptionGrantsPlus({
        status,
        cancel_at_period_end: true,
        current_period_end: boundary,
      }, boundary), false);
      assert.equal(subscriptionGrantsPlus({
        status,
        cancel_at_period_end: true,
        current_period_end: boundary,
      }, afterBoundary), false);
      assert.equal(subscriptionGrantsPlus({ status, cancel_at_period_end: true }, beforeBoundary), false);
    }
  });

  test('an ended scheduled cancellation does not outrank a currently paid replacement', () => {
    const selected = chooseCanonicalAccountSubscription([{
      provider_subscription_id: 'sub_old',
      status: 'active',
      cancel_at_period_end: true,
      access_ends_at: boundary,
      provider_event_created_at: new Date('2026-08-14T11:00:00.000Z'),
    }, {
      provider_subscription_id: 'sub_new',
      status: 'active',
      cancel_at_period_end: false,
      provider_event_created_at: new Date('2026-08-14T11:30:00.000Z'),
    }], new Date(boundary.getTime() + 1));
    assert.equal(selected?.provider_subscription_id, 'sub_new');
  });

  test('an ended scheduled cancellation does not outrank a newer terminal state', () => {
    const selected = chooseCanonicalAccountSubscription([{
      provider_subscription_id: 'sub_scheduled',
      status: 'trialing',
      cancel_at_period_end: true,
      current_period_end: boundary,
      provider_event_created_at: new Date('2026-08-14T11:00:00.000Z'),
    }, {
      provider_subscription_id: 'sub_terminal',
      status: 'canceled',
      access_ends_at: boundary,
      provider_event_created_at: new Date('2026-08-14T12:00:01.000Z'),
    }], new Date(boundary.getTime() + 1));
    assert.equal(selected?.provider_subscription_id, 'sub_terminal');
  });

  test('ends refunded and disputed access while preserving a won dispute transition', () => {
    assert.equal(subscriptionGrantsPlus({ status: 'refunded', current_period_end: '2099-01-01T00:00:00Z' }), false);
    assert.equal(subscriptionGrantsPlus({ status: 'disputed', current_period_end: '2099-01-01T00:00:00Z' }), false);
    assert.equal(statusAfterDisputeClosed('won', 'active'), 'active');
    assert.equal(statusAfterDisputeClosed('lost', 'active'), 'canceled');
  });

  test('routes recoverable billing states to Portal instead of duplicate checkout', () => {
    assert.equal(subscriptionNeedsPortalRecovery('past_due'), true);
    assert.equal(subscriptionNeedsPortalRecovery('unpaid'), true);
    assert.equal(subscriptionNeedsPortalRecovery('paused'), true);
    assert.equal(subscriptionNeedsPortalRecovery('incomplete'), true);
    assert.equal(subscriptionNeedsPortalRecovery('disputed'), true);
    assert.equal(subscriptionNeedsPortalRecovery('canceled'), false);
    assert.equal(subscriptionNeedsPortalRecovery('refunded'), false);
    assert.equal(subscriptionNeedsPortalRecovery(null), false);
  });

  test('uses a restrictive deterministic tie-break for same-second lifecycle events', () => {
    const sameSecond = new Date('2026-08-14T12:00:00.000Z');
    assert.equal(shouldApplySubscriptionEvent({
      storedCreatedAt: sameSecond,
      storedStatus: 'refunded',
      incomingCreatedAt: sameSecond,
      incomingStatus: 'active',
      eventName: 'customer.subscription.updated',
    }), false);
    assert.equal(shouldApplySubscriptionEvent({
      storedCreatedAt: sameSecond,
      storedStatus: 'active',
      incomingCreatedAt: sameSecond,
      incomingStatus: 'canceled',
      eventName: 'customer.subscription.deleted',
    }), true);
    assert.equal(shouldApplySubscriptionEvent({
      storedCreatedAt: sameSecond,
      storedStatus: 'past_due',
      incomingCreatedAt: sameSecond,
      incomingStatus: 'active',
      eventName: 'invoice.paid',
    }), true);
  });

  test('preserves the first past-due failure boundary across either webhook order', () => {
    const invoiceFailure = new Date('2026-08-14T12:00:00.000Z');
    const laterSubscriptionUpdate = new Date('2026-08-14T12:01:00.000Z');
    assert.equal(subscriptionEventAccessBoundary({
      incomingStatus: 'past_due',
      incomingCreatedAt: laterSubscriptionUpdate,
      incomingAccessEndsAt: null,
      storedStatus: 'past_due',
      storedAccessEndsAt: invoiceFailure,
    })?.toISOString(), invoiceFailure.toISOString());

    const subscriptionUpdateFirst = subscriptionEventAccessBoundary({
      incomingStatus: 'past_due',
      incomingCreatedAt: invoiceFailure,
      incomingAccessEndsAt: null,
      storedStatus: 'active',
      storedAccessEndsAt: null,
    });
    assert.equal(subscriptionUpdateFirst?.toISOString(), invoiceFailure.toISOString());
    const invoiceArrivesLater = new Date('2026-08-14T12:00:30.000Z');
    assert.equal(subscriptionEventAccessBoundary({
      incomingStatus: 'past_due',
      incomingCreatedAt: invoiceArrivesLater,
      incomingAccessEndsAt: invoiceArrivesLater,
      storedStatus: 'past_due',
      storedAccessEndsAt: subscriptionUpdateFirst,
    })?.toISOString(), subscriptionUpdateFirst?.toISOString());
  });

  test('an active replacement outranks a later terminal event for the prior subscription', () => {
    const selected = chooseCanonicalAccountSubscription([{
      provider_subscription_id: 'sub_new',
      status: 'active',
      provider_event_created_at: new Date('2026-08-14T12:00:00.000Z'),
      updated_at: new Date('2026-08-14T12:00:00.000Z'),
    }, {
      provider_subscription_id: 'sub_old',
      status: 'canceled',
      access_ends_at: new Date('2026-08-14T11:00:00.000Z'),
      provider_event_created_at: new Date('2026-08-14T12:10:00.000Z'),
      updated_at: new Date('2026-08-14T12:10:00.000Z'),
    }], new Date('2026-08-14T12:20:00.000Z'));
    assert.equal(selected?.provider_subscription_id, 'sub_new');
  });
});
