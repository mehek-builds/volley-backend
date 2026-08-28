import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db';
import { issuedBeforeEpoch, requireAuth, sessionVersionIsStale } from './auth';

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

test('THE CARD GATE, enforced through requireAuth', async (t) => {
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

  /** A user row shaped like resolveToken's SELECT, with card-gate columns overridable per test. */
  const userRow = (overrides: Record<string, unknown> = {}) => ({
    session_valid_from: null,
    session_version: 0,
    email: 'student@example.com',
    is_guest: false,
    guest_expires_at: null,
    billing_provider: null,
    billing_customer_id: null,
    created_at: new Date('2026-08-20T00:00:00.000Z'),
    onboarding_completed_at: new Date('2026-08-21T00:00:00.000Z'),
    ...overrides,
  });

  const requestFor = (token: string, url: string): FastifyRequest => ({
    headers: { authorization: `Bearer ${token}` },
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

  const withMockedUser = async (row: Record<string, unknown>, fn: () => Promise<void>) => {
    const select = mock.method(db, 'select', (() => ({
      from: () => ({
        where: () => ({
          limit: async () => [row],
        }),
      }),
    })) as unknown as typeof db.select);
    try {
      await fn();
    } finally {
      select.mock.restore();
    }
  };

  try {
    await t.test('a gated, onboarding-complete account is turned away from a dashboard data route', async () => {
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

    await t.test('the same account still reaches its onboarding and billing routes', async () => {
      const token = await signToken('user-gated-2');
      await withMockedUser(userRow(), async () => {
        for (const url of ['/onboarding/state', '/billing/checkout', '/billing/state', '/me', '/auth/session']) {
          const request = requestFor(token, url);
          const { reply, calls } = outcome();
          await requireAuth(request, reply);
          assert.equal(calls.length, 0, `expected ${url} to be reachable while gated`);
          assert.equal(request.jwtPayload?.userId, 'user-gated-2');
        }
      });
    });

    await t.test('mid-setup (onboarding_completed_at still null) the same data route is not blocked', async () => {
      const token = await signToken('user-mid-setup');
      await withMockedUser(userRow({ onboarding_completed_at: null }), async () => {
        const request = requestFor(token, '/applications');
        const { reply, calls } = outcome();
        await requireAuth(request, reply);
        assert.equal(calls.length, 0);
        assert.equal(request.jwtPayload?.userId, 'user-mid-setup');
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

    await t.test('a paid account (billing_customer_id on file) is unaffected even when gated and complete', async () => {
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
