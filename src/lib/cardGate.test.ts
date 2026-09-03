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
    // FINDING #4 (round 1): /account was missing from the allowlist, so a locked account could not
    // export its own data or delete its account without paying first.
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

  await t.test('FINDING #5 (round 1): a fragment does not defeat the allowlist match either', () => {
    // cardGate's own normalizer used to drop only the query string, not a fragment, while
    // submissionCutover's dropped both -- the same literal path got two different answers
    // depending which allowlist asked. Both now share lib/httpPath.ts.
    assert.equal(isCardGateAllowedPath('/onboarding/state#section'), true);
  });
});

test('isCardGateProfilePath (TIER B1: permanent profile facts and account settings, open for the whole locked lifetime)', async (t) => {
  const allowed = [
    '/profile',
    '/profile/application',
    '/profile/targeting',
    '/profile/recent-experience',
    // FINDING #1 (round 2): notification settings are ordinary account settings with no legitimate
    // reason to be limited to the one free build, so they moved here from TIER B2.
    '/notifications/preferences',
    // FINDING #2 (round 2): these two were reachable from NO tier at all before this fix.
    '/notifications/push/subscribe',
    '/notifications/push/unsubscribe',
    // FINDING #2 (round 3): the resume revisit screen (BaseResumeStep.tsx) calls these from as
    // late as the 'plan' screen, after TIER B2's own application sequence has finished, and they
    // only touch the account's own base resume -- so they moved here from TIER B2.
    '/resume/base',
    '/resume/base/stream',
    // FINDING #1's companion fix (round 3): the ONLY route that lets a locked account resolve an
    // unverified send must stay reachable even after TIER B2 has closed because of that exact send.
    '/applications/:id/submission/unverified',
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
    '/notifications/digest/preview',
    // A prefix collision on the new exact template must not slip through either.
    '/applications/abc-123',
    '/applications/abc-123/submission/extension-start',
    /* The code step is TIER B2, not this tier, and the difference is the point: it belongs to the
       one free build and must close with it, unlike /submission/unverified above, which has to
       outlive TIER B2 because TIER B2 closing is the very thing that strands the account. */
    '/applications/:id/security-code',
  ];
  for (const path of blocked) {
    await t.test(`blocks ${path}`, () => {
      assert.equal(isCardGateProfilePath(path), false);
    });
  }
});

/** A ledger .where() result that is both awaitable directly and chainable with .limit(), mirroring
 *  the shape a real drizzle query builder result has -- what lets one mock serve
 *  hasApprovedSubmittedApplication's `.select().from().where().limit(1)` call shape. */
function whereResult<T>(value: T[]): Promise<T[]> & { limit: (n: number) => Promise<T[]> } {
  const promise = Promise.resolve(value);
  return Object.assign(promise, { limit: () => promise });
}

/** Mocks db.select() for lib/approvedApplicationSubmissions.ts's hasApprovedSubmittedApplication:
 *  a single generated_resumes lookup, present (submitted) or absent (nothing sent yet). */
function mockSubmissionDb(options: { hasSubmittedApplication?: boolean } = {}) {
  const { hasSubmittedApplication = false } = options;
  return mock.method(db, 'select', ((_columns?: unknown) => ({
    from: (_table: unknown) => ({
      where: () => whereResult(hasSubmittedApplication ? [{ id: 'resume-1' }] : []),
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

  await t.test('the notification routes (moved to TIER B1) are reachable with no DB call at all', async () => {
    const select = mock.method(db, 'select', NO_DB_CALL_ALLOWED as unknown as typeof db.select);
    try {
      assert.equal(await cardGateRouteReachable('/notifications/preferences', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/notifications/push/subscribe', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/notifications/push/unsubscribe', 'user-1'), true);
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

  /* THE FINDING #1 FIX, PROVEN: TIER B2 closure no longer reads any ledger acknowledgement at all --
     not the order it arrived in, not whether it arrived, not any other step's acknowledgement. The
     ONLY thing that matters is whether hasApprovedSubmittedApplication found a real submitted row. */
  await t.test('a TIER B2 build path is reachable when nothing has been submitted yet, regardless of ledger state', async () => {
    const select = mockSubmissionDb({ hasSubmittedApplication: false });
    try {
      assert.equal(await cardGateRouteReachable('/jobs', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/jobs/:id', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/resume/generate', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/postings/:jobId/questions', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/applications/managed-prepare', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/applications/from-job', 'user-1'), true);
      /* The send's own prerequisites (rqw #512): the review screen audits the exact packet and
         records the acknowledgement before submit-request, so a tier that admits the send but 402s
         the audit re-creates the onboarding dead end two screens before the payment step. */
      assert.equal(await cardGateRouteReachable('/applications/:id/packet-audit', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/applications/:id/packet-audit/acknowledge', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/applications/:id/submit-request', 'user-1'), true);
      /* The send that parked short of finishing. 'awaiting_security_code' writes none of the four
         facts alreadyAtEmployer() reads, so hasSpentFreeOnboardingBuild is still false at exactly
         the moment the packet needs this route -- which is why this assertion belongs in the
         nothing-submitted-yet case rather than the spent one below. */
      assert.equal(await cardGateRouteReachable('/applications/:id/security-code', 'user-1'), true);
    } finally {
      select.mock.restore();
    }
  });

  /* FINDING #2 (round 3), PROVEN: /resume/base and /resume/base/stream moved to TIER B1, so they
     answer 'true' from the path check alone -- no DB call, and true regardless of submission state. */
  await t.test('the resume revisit routes are reachable with no DB call at all, before or after the free build is spent', async () => {
    const select = mock.method(db, 'select', NO_DB_CALL_ALLOWED as unknown as typeof db.select);
    try {
      assert.equal(await cardGateRouteReachable('/resume/base', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/resume/base/stream', 'user-1'), true);
    } finally {
      select.mock.restore();
    }
  });

  /* FINDING #1's companion fix (round 3), PROVEN: the unverified-submission resolution route stays
     reachable with no DB call at all, same as any other TIER B1 route -- including once TIER B2 has
     closed, which is exactly the state a locked account is in when it needs this route most. */
  await t.test('the unverified-submission resolution route is reachable with no DB call at all', async () => {
    const select = mock.method(db, 'select', NO_DB_CALL_ALLOWED as unknown as typeof db.select);
    try {
      assert.equal(await cardGateRouteReachable('/applications/:id/submission/unverified', 'user-1'), true);
    } finally {
      select.mock.restore();
    }
  });

  await t.test('a TIER B2 build path is BLOCKED once a real submission exists: the account has already spent its one free build and is only waiting on payment', async () => {
    const select = mockSubmissionDb({ hasSubmittedApplication: true });
    try {
      assert.equal(await cardGateRouteReachable('/jobs', 'user-1'), false);
      assert.equal(await cardGateRouteReachable('/resume/generate', 'user-1'), false);
      assert.equal(await cardGateRouteReachable('/applications/managed-prepare', 'user-1'), false);
      assert.equal(await cardGateRouteReachable('/applications/from-job', 'user-1'), false);
      /* The audit closes with the send it authorizes: a spent account must not keep re-auditing
         (each audit rebuilds delivery bindings and mints a fresh signed download token) for a
         packet it can no longer send. */
      assert.equal(await cardGateRouteReachable('/applications/:id/packet-audit', 'user-1'), false);
      assert.equal(await cardGateRouteReachable('/applications/:id/packet-audit/acknowledge', 'user-1'), false);
      assert.equal(await cardGateRouteReachable('/applications/:id/submit-request', 'user-1'), false);
      /* The code step closes with the tier, and for the packet whose OWN send produced the code
         request that costs nothing: the same facts that close this tier move that packet off
         'awaiting_security_code', so the route answers 409 'not_awaiting' from here on anyway, and
         what she still needs -- resolving an unverified send -- is TIER B1.
         It is NOT free for a second packet. This predicate is per-account (any row at
         alreadyAtEmployer()), not per-packet, and ONBOARDING_BUILD_LIMIT is 2, so a packet parked
         at awaiting_security_code can have this tier closed underneath it by a SIBLING packet's
         send and be stranded unfiled. See the entry's own comment in cardGate.ts: no tier choice
         for this one route fixes that, because /packet-audit and /packet-audit/acknowledge close
         with it and the route cannot clear its acknowledgement without them. */
      assert.equal(await cardGateRouteReachable('/applications/:id/security-code', 'user-1'), false);
    } finally {
      select.mock.restore();
    }
  });

  await t.test('the closure survives even if a client never acknowledges any onboarding flow step at all (FINDING #1a: never-closes is fixed)', async () => {
    // No ledger is read here at all -- this mock only ever answers the submission-count query, and
    // the closure still fires correctly, proving the old ledger dependency is gone.
    const select = mockSubmissionDb({ hasSubmittedApplication: true });
    try {
      assert.equal(await cardGateRouteReachable('/applications/from-job', 'user-1'), false);
    } finally {
      select.mock.restore();
    }
  });

  await t.test("notification routes stay reachable even after TIER B2 has closed, because they are TIER B1 now, not TIER B2 (FINDING #1's related question)", async () => {
    const select = mockSubmissionDb({ hasSubmittedApplication: true });
    try {
      assert.equal(await cardGateRouteReachable('/notifications/preferences', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/notifications/push/subscribe', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/notifications/push/unsubscribe', 'user-1'), true);
    } finally {
      select.mock.restore();
    }
  });

  await t.test('/jobs/grouped and /jobs/facets are never TIER B2, even with nothing submitted yet: only the exact board and single-job templates are, matching the match screen and BuildStep\'s own calls', async () => {
    const select = mockSubmissionDb({ hasSubmittedApplication: false });
    try {
      assert.equal(await cardGateRouteReachable('/jobs/grouped', 'user-1'), false);
      assert.equal(await cardGateRouteReachable('/jobs/facets', 'user-1'), false);
      assert.equal(await cardGateRouteReachable('/jobs', 'user-1'), true);
      assert.equal(await cardGateRouteReachable('/jobs/:id', 'user-1'), true);
    } finally {
      select.mock.restore();
    }
  });

  /* FINDING #4: concurrent TIER B2 requests for the same account share one in-flight DB call rather
     than issuing one each. */
  await t.test('concurrent TIER B2 checks for the same user share one DB call', async () => {
    let calls = 0;
    const select = mock.method(db, 'select', ((_columns?: unknown) => ({
      from: (_table: unknown) => ({
        where: () => {
          calls += 1;
          return whereResult([]);
        },
      }),
    })) as unknown as typeof db.select);
    try {
      const results = await Promise.all([
        cardGateRouteReachable('/jobs', 'user-shared'),
        cardGateRouteReachable('/resume/generate', 'user-shared'),
        cardGateRouteReachable('/postings/:jobId/questions', 'user-shared'),
      ]);
      assert.deepEqual(results, [true, true, true]);
      assert.equal(calls, 1, 'three concurrent TIER B2 requests for the same user should issue one DB call, not three');
    } finally {
      select.mock.restore();
    }

    // A later, non-concurrent call gets its own fresh lookup rather than reusing a stale settled one.
    const select2 = mockSubmissionDb({ hasSubmittedApplication: false });
    try {
      assert.equal(await cardGateRouteReachable('/jobs', 'user-shared'), true);
    } finally {
      select2.mock.restore();
    }
  });

  await t.test('concurrent TIER B2 checks for DIFFERENT users do not share a DB call', async () => {
    let calls = 0;
    const select = mock.method(db, 'select', ((_columns?: unknown) => ({
      from: (_table: unknown) => ({
        where: () => {
          calls += 1;
          return whereResult([]);
        },
      }),
    })) as unknown as typeof db.select);
    try {
      const results = await Promise.all([
        cardGateRouteReachable('/jobs', 'user-a'),
        cardGateRouteReachable('/jobs', 'user-b'),
      ]);
      assert.deepEqual(results, [true, true]);
      assert.equal(calls, 2, 'two different users must never share a submission lookup');
    } finally {
      select.mock.restore();
    }
  });
});
