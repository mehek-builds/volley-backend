import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountIsCardGateLocked,
  cardGateRouteReachable,
  isCardGateAllowedPath,
  isCardGateProfilePath,
} from './cardGate';
import { db } from '../db/index';

const GATE = { CARD_GATE_FROM: '2026-08-19T00:00:00.000Z' } as NodeJS.ProcessEnv;
const after = new Date('2026-08-20T00:00:00.000Z');
const before = new Date('2026-08-18T00:00:00.000Z');

test('accountIsCardGateLocked', async (t) => {
  await t.test('is never locked when CARD_GATE_FROM is unset, however complete onboarding is', () => {
    assert.equal(
      accountIsCardGateLocked({ created_at: after }, {} as NodeJS.ProcessEnv),
      false,
    );
  });

  /* THE FINDING #1 FIX. This used to require onboarding_completed_at as well, and that was the bug:
     onboarding_completed_at is written only by POST /onboarding/complete, called only from the
     /start flow's terminal screen -- reachable only after the 'plan' (payment) step has already
     resolved. So a gated, never-paid account NEVER carried a set onboarding_completed_at, which made
     the old condition a no-op for the exact account it exists to stop. Locked now means
     requiresPaymentMethodFor alone, from the moment the account is created. */
  await t.test('locks a freshly created gated account immediately, mid-setup, with no card', () => {
    assert.equal(
      accountIsCardGateLocked({ created_at: after, onboarding_completed_at: null }, GATE),
      true,
    );
  });

  await t.test('locks a gated, onboarding-complete account with no card, same as before', () => {
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

  await t.test('a guest is locked exactly like anyone else, immediately, once gated', () => {
    assert.equal(
      accountIsCardGateLocked({ created_at: after, onboarding_completed_at: null }, GATE),
      true,
    );
  });
});

test('isCardGateAllowedPath (TIER A: standing, always reachable while locked)', async (t) => {
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
    // FINDING #4: /account was missing from the allowlist, so a locked account could not export
    // its own data or delete its account without paying first.
    '/account',
    '/account/export',
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
    '/jobs',
  ];
  for (const path of blocked) {
    await t.test(`blocks ${path} at TIER A (it may still be reachable at another tier)`, () => {
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

  await t.test('a namespace prefix collision is not a match: /accountant is not /account', () => {
    assert.equal(isCardGateAllowedPath('/accountant'), false);
  });

  await t.test('trailing slash normalizes the same as the bare root', () => {
    assert.equal(isCardGateAllowedPath('/billing/'), true);
  });

  await t.test('FINDING #5: a fragment does not defeat the allowlist match either', () => {
    // cardGate's own normalizer used to drop only the query string, not a fragment, while
    // submissionCutover's dropped both -- the same literal path got two different answers
    // depending which allowlist asked. Both now share lib/httpPath.ts.
    assert.equal(isCardGateAllowedPath('/onboarding/state#section'), true);
  });
});

test('isCardGateProfilePath (TIER B1: the account\'s own intake facts, open for the whole locked lifetime)', async (t) => {
  const allowed = [
    '/profile',
    '/profile/application',
    '/profile/targeting',
    '/profile/recent-experience',
  ];
  for (const path of allowed) {
    await t.test(`allows ${path}`, () => {
      assert.equal(isCardGateProfilePath(path), true);
    });
  }

  const blocked = [
    // Dashboard-only sibling under the same /profile namespace: never part of /start's own flow,
    // and TIER B1 is an exact-template set for exactly this reason -- a prefix would have let it in.
    '/profile/recruiter-visibility',
    '/dashboard/bootstrap',
    '/network/people',
    '/documents',
    '/applications',
    '/jobs',
  ];
  for (const path of blocked) {
    await t.test(`blocks ${path}`, () => {
      assert.equal(isCardGateProfilePath(path), false);
    });
  }
});

/** A ledger .where() result that is both awaitable directly (the acknowledgements query, which
 *  chains no .limit()) and chainable with .limit() (the run query, which does). Mirrors the shape
 *  a real drizzle query builder result has, which is what lets one mock serve both call sites. */
function whereResult<T>(value: T[], failure?: Error): Promise<T[]> & { limit: (n: number) => Promise<T[]> } {
  // ONE promise instance, reused for both call shapes (`await x` and `await x.limit(1)`), never
  // two: a second, separately-constructed rejected promise for .limit() to return would leave the
  // FIRST one (the base object itself) permanently unconsumed whenever only .limit() was called on
  // it, which is exactly an unhandled rejection.
  const promise = failure ? Promise.reject<T[]>(failure) : Promise.resolve(value);
  return Object.assign(promise, { limit: () => promise });
}

/** Mocks db.select() for lib/onboardingFlowLedger.ts's two-query Promise.all, keyed off which
 *  table .from() names -- the run row is never read by these tests, only the acknowledged steps. */
function mockLedgerDb(options: { available?: boolean; acknowledgedSteps?: string[] } = {}) {
  const { available = true, acknowledgedSteps = [] } = options;
  return mock.method(db, 'select', ((_columns?: unknown) => ({
    from: (_table: unknown) => ({
      where: () => {
        if (!available) {
          return whereResult([], Object.assign(new Error('relation does not exist'), { code: '42P01' }));
        }
        // The acknowledgements query is the only one these tests read; the run query can answer
        // empty (no run row) without changing anything `cardGateRouteReachable` cares about.
        const isAcknowledgementsQuery = _columns !== undefined;
        return whereResult(isAcknowledgementsQuery ? acknowledgedSteps.map((step) => ({ step })) : []);
      },
    }),
  })) as unknown as typeof db.select);
}

const NO_DB_CALL_ALLOWED = () => {
  throw new Error('cardGateRouteReachable must not query the database for a path a pure tier already answers');
};

test('cardGateRouteReachable (folds TIER A, TIER B1 and TIER B2 together)', async (t) => {
  await t.test('a TIER A path is reachable with no DB call at all', async () => {
    const select = mock.method(db, 'select', NO_DB_CALL_ALLOWED as unknown as typeof db.select);
    try {
      assert.equal(await cardGateRouteReachable('/onboarding/state', 'user-1'), true);
    } finally {
      select.mock.restore();
    }
  });

  await t.test('a TIER B1 profile path is reachable with no DB call at all', async () => {
    const select = mock.method(db, 'select', NO_DB_CALL_ALLOWED as unknown as typeof db.select);
    try {
      assert.equal(await cardGateRouteReachable('/profile', 'user-1'), true);
    } finally {
      select.mock.restore();
    }
  });

  await t.test('a path on none of the three tiers is blocked with no DB call at all', async () => {
    const select = mock.method(db, 'select', NO_DB_CALL_ALLOWED as unknown as typeof db.select);
    try {
      assert.equal(await cardGateRouteReachable('/dashboard/bootstrap', 'user-1'), false);
      assert.equal(await cardGateRouteReachable('/network/people', 'user-1'), false);
      assert.equal(await cardGateRouteReachable('/documents', 'user-1'), false);
      assert.equal(await cardGateRouteReachable('/applications', 'user-1'), false);
    } finally {
      select.mock.restore();
    }
  });

  await t.test('a TIER B2 build path is reachable before notifications has been acknowledged', async () => {
    const select = mockLedgerDb({ acknowledgedSteps: ['match', 'questions'] });
    try {
      assert.equal(await cardGateRouteReachable('/jobs', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/jobs/:id', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/resume/generate', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/resume/base', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/resume/base/stream', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/postings/:jobId/questions', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/applications/from-job', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/applications/:id/submit-request', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/notifications/preferences', 'user-1'), true);
    } finally {
      select.mock.restore();
    }
  });

  await t.test('a TIER B2 build path is BLOCKED once notifications has been acknowledged: the account has already built and sent its one application and is only waiting on payment', async () => {
    const select = mockLedgerDb({ acknowledgedSteps: ['match', 'questions', 'review', 'trial', 'notifications'] });
    try {
      assert.equal(await cardGateRouteReachable('/jobs', 'user-1'), false);
      assert.equal(await cardGateRouteReachable('/resume/generate', 'user-1'), false);
      assert.equal(await cardGateRouteReachable('/applications/from-job', 'user-1'), false);
      assert.equal(await cardGateRouteReachable('/applications/:id/submit-request', 'user-1'), false);
      assert.equal(await cardGateRouteReachable('/notifications/preferences', 'user-1'), false);
    } finally {
      select.mock.restore();
    }
  });

  await t.test('/jobs/grouped and /jobs/facets are never TIER B2, even mid-build: only the exact board and single-job templates are, matching the match screen and BuildStep\'s own calls', async () => {
    const select = mockLedgerDb({ acknowledgedSteps: [] });
    try {
      assert.equal(await cardGateRouteReachable('/jobs/grouped', 'user-1'), false);
      assert.equal(await cardGateRouteReachable('/jobs/facets', 'user-1'), false);
      assert.equal(await cardGateRouteReachable('/jobs', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/jobs/:id', 'user-1'), true);
    } finally {
      select.mock.restore();
    }
  });

  await t.test('TIER B2 fails OPEN when the acknowledgement ledger table has not migrated yet, same posture onboarding.ts itself takes', async () => {
    const select = mockLedgerDb({ available: false });
    try {
      assert.equal(await cardGateRouteReachable('/resume/generate', 'user-1'), true);
    } finally {
      select.mock.restore();
    }
  });
});
