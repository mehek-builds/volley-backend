import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildEntitlementSnapshot,
  canonicalCompanyScope,
  featuresForAccess,
  resolveAccessClass,
  usesLegacyMonthlyProductQuota,
  type EntitlementUserPolicy,
} from './entitlements';

function user(overrides: Partial<EntitlementUserPolicy> = {}): EntitlementUserPolicy {
  return {
    id: '7e8de6fb-236b-4e9b-863a-7b4f2952e1a7',
    plan: 'free',
    created_at: new Date('2026-08-14T00:00:00.000Z'),
    trial_started_at: new Date('2026-08-14T00:00:00.000Z'),
    trial_ends_at: new Date('2026-08-21T00:00:00.000Z'),
    entitlement_policy_version: 'litos-entitlements-v2',
    grandfather_policy: null,
    entitlement_revision: '6d58c1f5-e885-41f7-a16a-dac37f98ab17',
    manual_access_override: null,
    manual_access_override_ends_at: null,
    automatic_submission_enabled: false,
    automatic_submission_legacy_granted: false,
    billing_provider: null,
    billing_status: null,
    billing_variant_id: null,
    billing_renews_at: null,
    billing_ends_at: null,
    billing_customer_id: null,
    ...overrides,
  };
}

describe('Litos entitlement resolver', () => {
  test('uses an exact seven-day boundary', () => {
    const row = user();
    assert.equal(resolveAccessClass({ user: row, now: new Date('2026-08-20T23:59:59.999Z') }), 'trial_plus');
    assert.equal(resolveAccessClass({ user: row, now: new Date('2026-08-21T00:00:00.000Z') }), 'free_new');
    assert.equal(resolveAccessClass({ user: row, now: new Date('2026-08-21T00:00:00.001Z') }), 'free_new');
  });

  test('keeps an existing grandfathered account trial active until its own expiry', () => {
    const row = user({
      grandfather_policy: 'legacy_free_v1',
      entitlement_policy_version: 'legacy-v1',
    });
    assert.equal(resolveAccessClass({
      user: row,
      now: new Date('2026-08-20T23:59:59.999Z'),
    }), 'trial_plus');
    assert.equal(resolveAccessClass({
      user: row,
      now: new Date('2026-08-21T00:00:00.000Z'),
    }), 'free_grandfathered');

    const active = buildEntitlementSnapshot({
      user: row,
      now: new Date('2026-08-20T23:59:59.999Z'),
    });
    assert.equal(active.trial?.meter_policy, 'legacy_monthly_allowances');
    assert.equal(active.features.automatic_submission, true);
    assert.equal(active.features.hover_generation, false);
    assert.equal('tailored_resumes_limit' in (active.trial ?? {}), false);

    const expired = buildEntitlementSnapshot({
      user: row,
      now: new Date('2026-08-21T00:00:00.000Z'),
    });
    assert.equal(expired.access_class, 'free_grandfathered');
    assert.equal(expired.trial, null);
    assert.equal(expired.legacy_limits?.tailored_resumes_monthly, 20);
  });

  test('does not turn mutable automation consent into a permanent grandfather grant', () => {
    const row = user({
      grandfather_policy: 'legacy_free_v1',
      entitlement_policy_version: 'legacy-v1',
      automatic_submission_enabled: true,
      automatic_submission_legacy_granted: false,
    });
    const active = buildEntitlementSnapshot({
      user: row,
      now: new Date('2026-08-20T23:59:59.999Z'),
    });
    assert.equal(active.access_class, 'trial_plus');
    assert.equal(active.features.automatic_submission, true);
    const expired = buildEntitlementSnapshot({
      user: row,
      now: new Date('2026-08-21T00:00:00.000Z'),
    });
    assert.equal(expired.access_class, 'free_grandfathered');
    assert.equal(expired.features.automatic_submission, false);
  });

  test('a Stripe trial is the metered trial, not an unmetered purchase', () => {
    /* The trial moved onto the subscription when it started requiring a card, so
       `trialing` is now a state a real subscription sits in. It must resolve to
       trial_plus: plus_paid is unmetered, and reading a trialling account as paid
       would hand it unlimited generation while the pricing page, the FAQ, and
       every upgrade prompt still say 5 resumes, 5 cover letters, 5 applications.
       The account row itself carries no trial any more -- signup stopped granting
       one -- so the subscription is the only thing that can say "on trial", which
       is exactly why this branch has to exist. */
    const row = user({ trial_started_at: null, trial_ends_at: null });
    const subscription = {
      provider: 'stripe',
      status: 'trialing',
      term_code: 'month',
      cancel_at_period_end: false,
      current_period_start: new Date('2026-08-14T00:00:00.000Z'),
      current_period_end: new Date('2026-08-21T00:00:00.000Z'),
      access_ends_at: null,
      provider_customer_id: 'cus_trialing',
    };
    assert.equal(resolveAccessClass({
      user: row,
      subscription,
      now: new Date('2026-08-16T00:00:00.000Z'),
    }), 'trial_plus');
    // The same subscription once it converts is the unmetered product.
    assert.equal(resolveAccessClass({
      user: row,
      subscription: { ...subscription, status: 'active' },
      now: new Date('2026-08-16T00:00:00.000Z'),
    }), 'plus_paid');
  });

  test('a trial already granted under the old signup grant still runs to its own boundary', () => {
    /* The migration safety net. Accounts created before the card requirement hold
       a real trial_ends_at, and removing the signup grant must not reach back and
       cut those short: they keep trial_plus until their exact boundary, then fall
       to Free like everyone else. Nothing new grants these columns, so this set
       only ever shrinks. */
    const row = user({
      trial_started_at: new Date('2026-08-14T00:00:00.000Z'),
      trial_ends_at: new Date('2026-08-21T00:00:00.000Z'),
    });
    assert.equal(resolveAccessClass({ user: row, now: new Date('2026-08-20T23:59:59.999Z') }), 'trial_plus');
    assert.equal(resolveAccessClass({ user: row, now: new Date('2026-08-21T00:00:00.000Z') }), 'free_new');
  });

  test('a brand-new account created after the change starts on Free, not on trial', () => {
    const row = user({ trial_started_at: null, trial_ends_at: null });
    assert.equal(resolveAccessClass({ user: row, now: new Date('2026-08-14T00:00:01.000Z') }), 'free_new');
  });

  test('never lets a stale legacy plan projection override an inactive v2 subscription', () => {
    const row = user({
      plan: 'pro',
      trial_started_at: new Date('2026-08-01T00:00:00.000Z'),
      trial_ends_at: new Date('2026-08-08T00:00:00.000Z'),
    });
    const subscription = {
      provider: 'stripe',
      status: 'past_due',
      term_code: 'month',
      cancel_at_period_end: false,
      current_period_start: new Date('2026-07-14T00:00:00.000Z'),
      current_period_end: new Date('2026-08-14T00:00:00.000Z'),
      access_ends_at: null,
      provider_customer_id: 'cus_existing',
    };
    assert.equal(resolveAccessClass({
      user: row,
      subscription,
      now: new Date('2026-08-16T23:59:59.999Z'),
    }), 'plus_paid');
    assert.equal(resolveAccessClass({
      user: row,
      subscription,
      now: new Date('2026-08-17T00:00:00.000Z'),
    }), 'free_new');
    assert.equal(resolveAccessClass({
      user: row,
      subscription: { ...subscription, status: 'unpaid' },
      now: new Date('2026-08-15T00:00:00.000Z'),
    }), 'free_new');
  });

  test('honors exact legacy paid cancellation boundaries without a canonical subscription row', () => {
    const row = user({
      plan: 'pro',
      grandfather_policy: 'legacy_paid_v1',
      entitlement_policy_version: 'legacy-v1',
      trial_ends_at: null,
      billing_provider: 'lemonsqueezy',
      billing_status: 'cancelled',
      billing_renews_at: new Date('2026-08-21T00:00:00.000Z'),
      billing_ends_at: new Date('2026-08-21T00:00:00.000Z'),
    });
    assert.equal(resolveAccessClass({
      user: row,
      now: new Date('2026-08-20T23:59:59.999Z'),
    }), 'legacy_paid');
    assert.equal(resolveAccessClass({
      user: row,
      now: new Date('2026-08-21T00:00:00.000Z'),
    }), 'free_grandfathered');
    assert.equal(resolveAccessClass({
      user: row,
      now: new Date('2026-08-21T00:00:00.001Z'),
    }), 'free_grandfathered');
  });

  test('applies legacy past-due grace and keeps only genuine unbounded grants indefinite', () => {
    const pastDue = user({
      plan: 'pro',
      grandfather_policy: 'legacy_paid_v1',
      entitlement_policy_version: 'legacy-v1',
      trial_ends_at: null,
      billing_provider: 'lemonsqueezy',
      billing_status: 'past_due',
      billing_renews_at: new Date('2026-08-18T00:00:00.000Z'),
    });
    assert.equal(resolveAccessClass({
      user: pastDue,
      now: new Date('2026-08-20T23:59:59.999Z'),
    }), 'legacy_paid');
    assert.equal(resolveAccessClass({
      user: pastDue,
      now: new Date('2026-08-21T00:00:00.000Z'),
    }), 'free_grandfathered');

    const active = { ...pastDue, billing_status: 'active', billing_renews_at: null };
    assert.equal(resolveAccessClass({ user: active, now: new Date('2030-01-01T00:00:00.000Z') }), 'legacy_paid');
    const manual = { ...pastDue, billing_provider: null, billing_status: null, billing_renews_at: null };
    assert.equal(resolveAccessClass({ user: manual, now: new Date('2030-01-01T00:00:00.000Z') }), 'legacy_paid');
    const unknownProviderState = { ...pastDue, billing_status: null, billing_renews_at: null };
    assert.equal(resolveAccessClass({
      user: unknownProviderState,
      now: new Date('2026-08-20T00:00:00.000Z'),
    }), 'free_grandfathered');
  });

  test('keeps Free factual filling but denies new-Free automatic submission and premium writing', () => {
    const features = featuresForAccess({ accessClass: 'free_new' });
    assert.equal(features.application_fill, true);
    assert.equal(features.application_review, true);
    assert.equal(features.ai_resume_tailoring, false);
    assert.equal(features.ai_application_answer_generation, false);
    assert.equal(features.contact_discovery, false);
    assert.equal(features.outreach_email_generation, false);
    assert.equal(features.automatic_submission, false);
  });

  test('allows trial, paid, and qualifying grandfathered automatic submission only', () => {
    assert.equal(featuresForAccess({ accessClass: 'trial_plus' }).automatic_submission, true);
    assert.equal(featuresForAccess({ accessClass: 'plus_paid' }).automatic_submission, true);
    assert.equal(featuresForAccess({ accessClass: 'free_grandfathered' }).automatic_submission, false);
    assert.equal(featuresForAccess({
      accessClass: 'free_grandfathered',
      automaticSubmissionLegacyGranted: true,
    }).automatic_submission, true);
  });

  test('makes hover generation paid-only and keeps the trial click-only', () => {
    assert.equal(featuresForAccess({ accessClass: 'free_new' }).hover_generation, false);
    assert.equal(featuresForAccess({ accessClass: 'trial_plus' }).hover_generation, false);
    assert.equal(featuresForAccess({ accessClass: 'free_grandfathered' }).hover_generation, false);
    assert.equal(featuresForAccess({ accessClass: 'plus_paid' }).hover_generation, true);
    assert.equal(featuresForAccess({ accessClass: 'legacy_paid' }).hover_generation, true);
  });

  test('never applies calendar-month product quotas to paid access', () => {
    const plus = buildEntitlementSnapshot({
      user: user({ plan: 'plus', trial_ends_at: null }),
      now: new Date('2026-08-22T00:00:00.000Z'),
    });
    const legacyPaid = buildEntitlementSnapshot({
      user: user({ plan: 'pro', grandfather_policy: 'legacy_paid_v1', trial_ends_at: null }),
      now: new Date('2026-08-22T00:00:00.000Z'),
    });
    assert.equal(usesLegacyMonthlyProductQuota(plus), false);
    assert.equal(usesLegacyMonthlyProductQuota(legacyPaid), false);
    assert.equal(usesLegacyMonthlyProductQuota(buildEntitlementSnapshot({
      user: user({ grandfather_policy: 'legacy_free_v1', trial_ends_at: null }),
      now: new Date('2026-08-22T00:00:00.000Z'),
    })), true);
  });

  test('preserves exact legacy Free allowances and publishes independent trial meters', () => {
    const legacy = buildEntitlementSnapshot({
      user: user({ grandfather_policy: 'legacy_free_v1' }),
      now: new Date('2026-08-22T00:00:00.000Z'),
    });
    assert.equal(legacy.access_class, 'free_grandfathered');
    assert.equal(legacy.legacy_limits?.tailored_resumes_monthly, 20);
    assert.equal(legacy.legacy_limits?.contacts_monthly, 30);
    assert.equal(legacy.legacy_limits?.drafts_monthly, 60);

    const trial = buildEntitlementSnapshot({
      user: user(),
      generationUsage: { tailored_resumes_used: 2, cover_letters_used: 3, answer_applications_used: 4 },
      companyUsage: [{ company_scope_key: 'domain:example.com', company_name: 'Example', contacts_used: 2, drafts_used: 1 }],
      now: new Date('2026-08-15T00:00:00.000Z'),
    });
    assert.equal(trial.account_id, user().id);
    assert.equal(trial.trial?.meter_policy, 'litos_plus_v2_lifetime');
    if (trial.trial?.meter_policy !== 'litos_plus_v2_lifetime') {
      assert.fail('expected a v2 lifetime-metered trial');
    }
    assert.equal(trial.trial.tailored_resumes_limit, 5);
    assert.equal(trial.trial.cover_letters_used, 3);
    assert.equal(trial.trial.answer_applications_used, 4);
    assert.equal(trial.trial.company_usage[0]?.contacts_limit, 2);
  });

  test('normalizes stable company scope without trusting display name casing', () => {
    assert.equal(canonicalCompanyScope({ companyName: 'Acme', domain: 'https://www.acme.com/jobs' }), 'domain:acme.com');
    assert.equal(
      canonicalCompanyScope({ companyName: 'ACME, Inc.' }),
      canonicalCompanyScope({ companyName: 'acme inc' }),
    );
    assert.equal(
      canonicalCompanyScope({
        companyName: 'Acme',
        domain: 'acme.com',
        companyId: '7e8de6fb-236b-4e9b-863a-7b4f2952e1a7',
      }),
      canonicalCompanyScope({
        companyName: 'Acme',
        domain: 'acme.com',
        companyId: '8f9ef70c-347c-4f9c-974b-8c5f3a63f2b8',
      }),
    );
  });
});
