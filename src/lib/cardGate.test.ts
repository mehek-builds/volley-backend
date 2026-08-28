import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountIsCardGateLocked, isCardGateAllowedPath } from './cardGate';

const GATE = { CARD_GATE_FROM: '2026-08-19T00:00:00.000Z' } as NodeJS.ProcessEnv;
const after = new Date('2026-08-20T00:00:00.000Z');
const before = new Date('2026-08-18T00:00:00.000Z');

test('accountIsCardGateLocked', async (t) => {
  await t.test('is never locked when CARD_GATE_FROM is unset, however complete onboarding is', () => {
    assert.equal(
      accountIsCardGateLocked({ created_at: after, onboarding_completed_at: after }, {} as NodeJS.ProcessEnv),
      false,
    );
  });

  await t.test('is not locked mid-setup even for a gated account with no card', () => {
    // This is the load-bearing case: onboarding.ts's own data routes (profile, resume,
    // applications) have to stay reachable while onboarding_completed_at is still null, or
    // setup itself cannot finish. See lib/cardGate.ts's accountIsCardGateLocked comment.
    assert.equal(
      accountIsCardGateLocked({ created_at: after, onboarding_completed_at: null }, GATE),
      false,
    );
  });

  await t.test('locks the instant onboarding_completed_at is set on an unpaid post-cutover account', () => {
    assert.equal(
      accountIsCardGateLocked({ created_at: after, onboarding_completed_at: after }, GATE),
      true,
    );
  });

  await t.test('never locks an account created before the cutover, complete or not', () => {
    assert.equal(
      accountIsCardGateLocked({ created_at: before, onboarding_completed_at: before }, GATE),
      false,
    );
  });

  await t.test('does not lock once a Stripe card is actually on file', () => {
    assert.equal(
      accountIsCardGateLocked({
        created_at: after,
        onboarding_completed_at: after,
        billing_provider: 'stripe',
        billing_customer_id: 'cus_123',
      }, GATE),
      false,
    );
  });

  await t.test('a guest is locked exactly like anyone else once onboarding is complete', () => {
    assert.equal(
      accountIsCardGateLocked({ created_at: after, onboarding_completed_at: after }, GATE),
      true,
    );
  });
});

test('isCardGateAllowedPath', async (t) => {
  const allowed = [
    '/onboarding/state',
    '/onboarding/answers',
    '/onboarding/flow/steps',
    '/billing/checkout',
    '/billing/state',
    '/billing/actions/abc-123/consume',
    '/auth/session',
    '/auth/request-code',
    '/me',
    '/v1/meta',
  ];
  for (const path of allowed) {
    await t.test(`allows ${path}`, () => {
      assert.equal(isCardGateAllowedPath(path), true);
    });
  }

  const blocked = [
    '/applications',
    '/applications/abc-123/documents',
    '/profile',
    '/dashboard/bootstrap',
    '/resume/generate',
    '/documents',
    '/network/contacts',
  ];
  for (const path of blocked) {
    await t.test(`blocks ${path}`, () => {
      assert.equal(isCardGateAllowedPath(path), false);
    });
  }

  await t.test('a query string does not defeat the allowlist match', () => {
    assert.equal(isCardGateAllowedPath('/onboarding/state?refresh=1'), true);
  });

  await t.test('a namespace prefix collision is not a match: /onboardingX is not /onboarding', () => {
    assert.equal(isCardGateAllowedPath('/onboardingX/state'), false);
  });

  await t.test('a namespace prefix collision is not a match: /mean is not /me', () => {
    assert.equal(isCardGateAllowedPath('/mean'), false);
  });

  await t.test('trailing slash normalizes the same as the bare root', () => {
    assert.equal(isCardGateAllowedPath('/billing/'), true);
  });
});
