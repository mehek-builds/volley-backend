import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db';
import { onboarding_flow_runs as onboardingFlowRunsTable, users as usersTable } from '../db/schema';
import { issuedBeforeEpoch, optionalAuth, requireAuth, sessionVersionIsStale } from './auth';

test('no epoch set: every token passes', () => {
  assert.equal(issuedBeforeEpoch(1_700_000_000, null), false);
  assert.equal(issuedBeforeEpoch(undefined, null), false);
});

test('token minted in an earlier second than the epoch is rejected', () => {
  const epoch = new Date(1_700_000_010_500); // 10.5s
  assert.equal(issuedBeforeEpoch(1_700_000_009, epoch), true);
  assert.equal(issuedBeforeEpoch(1_700_000_010 - 3600, epoch), true);
});

test('token minted in the same second as the epoch survives', () => {
  // verify-code sets session_valid_from then signs the fresh token within the
  // same second; JWT iat is floored to seconds so both floor to :10.
  const epoch = new Date(1_700_000_010_999);
  assert.equal(issuedBeforeEpoch(1_700_000_010, epoch), false);
});

test('token minted after the epoch survives', () => {
  const epoch = new Date(1_700_000_010_000);
  assert.equal(issuedBeforeEpoch(1_700_000_011, epoch), false);
});

test('token with no iat is treated as stale when an epoch exists', () => {
  assert.equal(issuedBeforeEpoch(undefined, new Date(1_700_000_010_000)), true);
});

test('legacy tokens without a version remain valid until an account rotation', () => {
  assert.equal(sessionVersionIsStale(undefined, 0), false);
  assert.equal(sessionVersionIsStale(undefined, 1), true);
});

test('session versions provide exact immediate revocation', () => {
  assert.equal(sessionVersionIsStale(4, 4), false);
  assert.equal(sessionVersionIsStale(3, 4), true);
  assert.equal(sessionVersionIsStale(5, 4), true);
});

test('session lookups share only while the same token is in flight', async () => {
  const previousSecret = process.env.JWT_SIGNING_SECRET;
  const secret = 'test-signing-secret-32-chars-minimum!!';
  process.env.JWT_SIGNING_SECRET = secret;

  const signToken = (userId: string) => new SignJWT({
    userId,
    isGuest: false,
    authMethod: 'password',
    sessionVersion: 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(secret));
  const [token, otherToken, staleToken] = await Promise.all([
    signToken('user-1'),
    signToken('user-2'),
    signToken('user-3'),
  ]);

  let selectCalls = 0;
  let returnRotatedSession = false;
  let releaseFirstLookup!: () => void;
  const firstLookupPending = new Promise<void>((resolve) => {
    releaseFirstLookup = resolve;
  });
  const select = mock.method(db, 'select', (() => {
    selectCalls += 1;
    const wait = selectCalls === 1 ? firstLookupPending : Promise.resolve();
    return {
      from: () => ({
        where: () => ({
          limit: async () => {
            await wait;
            return [{
              session_valid_from: null,
              session_version: returnRotatedSession ? 1 : 0,
              email: 'person@example.com',
              is_guest: false,
              guest_expires_at: null,
            }];
          },
        }),
      }),
    };
  }) as unknown as typeof db.select);

  const request = (bearerToken = token) => ({
    headers: { authorization: `Bearer ${bearerToken}` },
  }) as FastifyRequest;
  const rejected: Array<{ status: number; error: string }> = [];
  const reply = {
    status(status: number) {
      return {
        send(body: { error: string }) {
          rejected.push({ status, error: body.error });
        },
      };
    },
  } as unknown as FastifyReply;

  try {
    const firstRequest = request();
    const secondRequest = request();
    const first = requireAuth(firstRequest, reply);
    const second = requireAuth(secondRequest, reply);

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(selectCalls, 1);

    const otherRequest = request(otherToken);
    await requireAuth(otherRequest, reply);
    assert.equal(selectCalls, 2);

    releaseFirstLookup();
    await Promise.all([first, second]);
    assert.equal(firstRequest.jwtPayload?.userId, 'user-1');
    assert.equal(secondRequest.jwtPayload?.userId, 'user-1');

    const laterRequest = request();
    await requireAuth(laterRequest, reply);
    assert.equal(selectCalls, 3);
    assert.equal(laterRequest.jwtPayload?.email, 'person@example.com');

    returnRotatedSession = true;
    const firstStaleRequest = request(staleToken);
    const secondStaleRequest = request(staleToken);
    await Promise.all([
      requireAuth(firstStaleRequest, reply),
      requireAuth(secondStaleRequest, reply),
    ]);
    assert.equal(selectCalls, 4);
    assert.equal(firstStaleRequest.jwtPayload, undefined);
    assert.equal(secondStaleRequest.jwtPayload, undefined);
    assert.deepEqual(rejected, [
      { status: 401, error: 'Invalid or expired token' },
      { status: 401, error: 'Invalid or expired token' },
    ]);

    await requireAuth(request(staleToken), reply);
    assert.equal(selectCalls, 5);
    assert.equal(rejected.length, 3);
  } finally {
    select.mock.restore();
    if (previousSecret === undefined) delete process.env.JWT_SIGNING_SECRET;
    else process.env.JWT_SIGNING_SECRET = previousSecret;
  }
});

test('THE CARD GATE, enforced through requireAuth and optionalAuth', async (t) => {
  const previousSecret = process.env.JWT_SIGNING_SECRET;
  const previousGate = process.env.CARD_GATE_FROM;
  const secret = 'test-signing-secret-32-chars-minimum!!';
  process.env.JWT_SIGNING_SECRET = secret;
  process.env.CARD_GATE_FROM = '2026-08-19T00:00:00.000Z';

  const signToken = (userId: string) => new SignJWT({
    userId,
    isGuest: false,
    authMethod: 'password',
    sessionVersion: 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(secret));

  /** A user row shaped like resolveToken's SELECT, with card-gate columns overridable per test.
   *  onboarding_completed_at defaults to null on purpose: FINDING #1's fix means locking no longer
   *  depends on it, and every test below that expects "locked" to hold should hold with it unset,
   *  exactly like a fresh signup that has not reached /start's terminal screen yet. */
  const userRow = (overrides: Record<string, unknown> = {}) => ({
    session_valid_from: null,
    session_version: 0,
    email: 'student@example.com',
    is_guest: false,
    guest_expires_at: null,
    billing_provider: null,
    billing_customer_id: null,
    created_at: new Date('2026-08-20T00:00:00.000Z'),
    onboarding_completed_at: null,
    ...overrides,
  });

  const requestFor = (token: string, url: string): FastifyRequest => ({
    headers: { authorization: `Bearer ${token}` },
    url,
    routeOptions: { url },
  }) as unknown as FastifyRequest;

  const anonymousRequest = (url: string): FastifyRequest => ({
    headers: {},
    url,
    routeOptions: { url },
  }) as unknown as FastifyRequest;

  const outcome = () => {
    const calls: Array<{ status: number; body: unknown }> = [];
    const reply = {
      status(status: number) {
        return {
          send(body: unknown) {
            calls.push({ status, body });
          },
        };
      },
    } as unknown as FastifyReply;
    return { reply, calls };
  };

  /** A .where() result shaped like drizzle's: awaitable directly (the acknowledgements query,
   *  which chains no .limit()) and chainable with .limit() (both the user-row and run-row queries,
   *  which do). */
  function chainable<T>(value: T[], failure?: Error) {
    // ONE promise instance for both call shapes (`await x` and `await x.limit(1)`): a second,
    // separately-constructed rejected promise for .limit() to return would leave this one
    // permanently unconsumed whenever only .limit() was called on it -- an unhandled rejection.
    const promise = failure ? Promise.reject<T[]>(failure) : Promise.resolve(value);
    return Object.assign(promise, { limit: () => promise });
  }

  /**
   * Mocks db.select() for BOTH queries requireAuth/optionalAuth can now issue per request:
   * resolveToken's user-row read (dispatched by table identity against `users`) and, only when the
   * path actually needs it, onboardingFlowLedger's run/acknowledgements pair (lib/onboardingFlowLedger.ts).
   */
  const withMockedUser = async (
    row: Record<string, unknown>,
    fn: () => Promise<void>,
    ledger: { available?: boolean; acknowledgedSteps?: string[] } = {},
  ) => {
    const { available = true, acknowledgedSteps = [] } = ledger;
    const select = mock.method(db, 'select', ((..._args: unknown[]) => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === usersTable) return chainable([row]);
          if (!available) {
            return chainable([], Object.assign(new Error('relation does not exist'), { code: '42P01' }));
          }
          if (table === onboardingFlowRunsTable) return chainable([]);
          return chainable(acknowledgedSteps.map((step) => ({ step })));
        },
      }),
    })) as unknown as typeof db.select);
    try {
      await fn();
    } finally {
      select.mock.restore();
    }
  };

  try {
    await t.test('FINDING #1: a gated account is locked from the moment it exists, mid-setup, before onboarding_completed_at is ever set', async () => {
      const token = await signToken('user-gated');
      await withMockedUser(userRow(), async () => {
        const request = requestFor(token, '/applications');
        const { reply, calls } = outcome();
        await requireAuth(request, reply);
        // The session itself is genuine -- jwtPayload is still set, exactly like a route
        // handler would see it for any other authenticated request. This is a business-rule
        // rejection on top of a valid session, not an authentication failure, and the 402
        // reply is what actually stops the handler from ever running.
        assert.equal(request.jwtPayload?.userId, 'user-gated');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].status, 402);
        assert.equal((calls[0].body as { code: string }).code, 'payment_method_required');
      });
    });

    await t.test('...and is STILL locked once onboarding_completed_at is eventually set (the pre-existing case keeps working)', async () => {
      const token = await signToken('user-gated-complete');
      await withMockedUser(userRow({ onboarding_completed_at: new Date('2026-08-21T00:00:00.000Z') }), async () => {
        const request = requestFor(token, '/applications');
        const { reply, calls } = outcome();
        await requireAuth(request, reply);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].status, 402);
      });
    });

    await t.test('the same account still reaches its onboarding and billing routes (TIER A)', async () => {
      const token = await signToken('user-gated-2');
      await withMockedUser(userRow(), async () => {
        for (const url of ['/onboarding/state', '/billing/checkout', '/billing/state', '/me', '/auth/session', '/account', '/account/export']) {
          const request = requestFor(token, url);
          const { reply, calls } = outcome();
          await requireAuth(request, reply);
          assert.equal(calls.length, 0, `expected ${url} to be reachable while gated`);
          assert.equal(request.jwtPayload?.userId, 'user-gated-2');
        }
      });
    });

    await t.test('TIER B1: the account can read and edit its own profile facts for its whole locked lifetime', async () => {
      const token = await signToken('user-gated-3');
      await withMockedUser(userRow(), async () => {
        for (const url of ['/profile', '/profile/application', '/profile/targeting', '/profile/recent-experience']) {
          const request = requestFor(token, url);
          const { reply, calls } = outcome();
          await requireAuth(request, reply);
          assert.equal(calls.length, 0, `expected ${url} to be reachable while gated`);
        }
      }, { acknowledgedSteps: ['match', 'questions', 'review', 'trial', 'notifications'] }); // even past the build window
    });

    await t.test('TIER B2: the build routes are reachable before notifications is acknowledged...', async () => {
      const token = await signToken('user-gated-4');
      await withMockedUser(userRow(), async () => {
        // Fastify template strings, not a literal id substituted in -- request.routeOptions.url
        // (what requestPathForCardGate actually reads) is always the registered template by the
        // time a preHandler runs, never the resolved literal path. See lib/cardGate.ts's TIER B2
        // comment for why exact-set matching depends on that.
        for (const url of ['/jobs', '/jobs/:id', '/resume/generate', '/applications/from-job', '/applications/:id/submit-request']) {
          const request = requestFor(token, url);
          const { reply, calls } = outcome();
          await requireAuth(request, reply);
          assert.equal(calls.length, 0, `expected ${url} to be reachable mid-build`);
        }
      }, { acknowledgedSteps: ['match', 'questions'] });
    });

    await t.test('...and are blocked once notifications is acknowledged: the account has already built and sent its one application', async () => {
      const token = await signToken('user-gated-5');
      await withMockedUser(userRow(), async () => {
        for (const url of ['/jobs', '/resume/generate', '/applications/from-job']) {
          const request = requestFor(token, url);
          const { reply, calls } = outcome();
          await requireAuth(request, reply);
          assert.equal(calls.length, 1, `expected ${url} to be blocked past the build window`);
          assert.equal(calls[0].status, 402);
        }
      }, { acknowledgedSteps: ['match', 'questions', 'review', 'trial', 'notifications'] });
    });

    await t.test('FINDING #2: optionalAuth enforces THE CARD GATE for a session that resolved, exactly like requireAuth', async () => {
      const token = await signToken('user-gated-optional');
      await withMockedUser(userRow(), async () => {
        // Mid-build: /jobs is reachable through optionalAuth too.
        const midBuild = requestFor(token, '/jobs');
        const { reply: midBuildReply, calls: midBuildCalls } = outcome();
        await optionalAuth(midBuild, midBuildReply);
        assert.equal(midBuildCalls.length, 0);
        assert.equal(midBuild.jwtPayload?.userId, 'user-gated-optional');
      }, { acknowledgedSteps: [] });

      await withMockedUser(userRow(), async () => {
        // /jobs/grouped is never TIER B2 -- ordinary board browsing, blocked even mid-build.
        const request = requestFor(token, '/jobs/grouped');
        const { reply, calls } = outcome();
        await optionalAuth(request, reply);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].status, 402);
      }, { acknowledgedSteps: [] });

      await withMockedUser(userRow(), async () => {
        // Past the build window, even the bare board closes.
        const request = requestFor(token, '/jobs');
        const { reply, calls } = outcome();
        await optionalAuth(request, reply);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].status, 402);
      }, { acknowledgedSteps: ['match', 'questions', 'review', 'trial', 'notifications'] });
    });

    await t.test('FINDING #2: a genuinely anonymous caller is completely unaffected by THE CARD GATE', async () => {
      // No mocked user row is installed at all here -- resolveSession returns 'anonymous' before
      // any database read happens, so optionalAuth must never even ask whether anyone is locked.
      const request = anonymousRequest('/jobs');
      const { reply, calls } = outcome();
      await optionalAuth(request, reply);
      assert.equal(calls.length, 0);
      assert.equal(request.jwtPayload, undefined);
    });

    await t.test('/jobs/grouped and /jobs/facets are never TIER B2 through requireAuth either', async () => {
      const token = await signToken('user-gated-6');
      await withMockedUser(userRow(), async () => {
        for (const url of ['/jobs/grouped', '/jobs/facets']) {
          const request = requestFor(token, url);
          const { reply, calls } = outcome();
          await requireAuth(request, reply);
          assert.equal(calls.length, 1, `expected ${url} to stay blocked`);
        }
      }, { acknowledgedSteps: [] });
    });

    await t.test('FINDING #4: /account and /account/export are reachable while locked', async () => {
      const token = await signToken('user-gated-7');
      await withMockedUser(userRow(), async () => {
        for (const url of ['/account', '/account/export']) {
          const request = requestFor(token, url);
          const { reply, calls } = outcome();
          await requireAuth(request, reply);
          assert.equal(calls.length, 0, `expected ${url} to be reachable while gated`);
        }
      });
    });

    await t.test('an account created before CARD_GATE_FROM is unaffected', async () => {
      const token = await signToken('user-grandfathered');
      await withMockedUser(userRow({ created_at: new Date('2026-08-01T00:00:00.000Z') }), async () => {
        const request = requestFor(token, '/applications');
        const { reply, calls } = outcome();
        await requireAuth(request, reply);
        assert.equal(calls.length, 0);
        assert.equal(request.jwtPayload?.userId, 'user-grandfathered');
      });
    });

    await t.test('a paid account (billing_customer_id on file) is unaffected even when gated', async () => {
      const token = await signToken('user-paid');
      await withMockedUser(userRow({ billing_provider: 'stripe', billing_customer_id: 'cus_123' }), async () => {
        const request = requestFor(token, '/applications');
        const { reply, calls } = outcome();
        await requireAuth(request, reply);
        assert.equal(calls.length, 0);
        assert.equal(request.jwtPayload?.userId, 'user-paid');
      });
    });

    await t.test('CARD_GATE_FROM unset is a complete no-op regardless of onboarding/billing state', async () => {
      delete process.env.CARD_GATE_FROM;
      const token = await signToken('user-no-gate');
      await withMockedUser(userRow(), async () => {
        const request = requestFor(token, '/applications');
        const { reply, calls } = outcome();
        await requireAuth(request, reply);
        assert.equal(calls.length, 0);
        assert.equal(request.jwtPayload?.userId, 'user-no-gate');
      });
    });
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SIGNING_SECRET;
    else process.env.JWT_SIGNING_SECRET = previousSecret;
    if (previousGate === undefined) delete process.env.CARD_GATE_FROM;
    else process.env.CARD_GATE_FROM = previousGate;
  }
});
