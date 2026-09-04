import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db';
import { generated_resumes as generatedResumesTable, users as usersTable } from '../db/schema';
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

  /** A .where() result shaped like drizzle's: awaitable directly and chainable with .limit()
   *  (both the user-row query and hasApprovedSubmittedApplication's generated_resumes query use
   *  .limit()). */
  function chainable<T>(value: T[]) {
    // ONE promise instance for both call shapes (`await x` and `await x.limit(1)`): a second,
    // separately-constructed promise for .limit() to return would leave this one permanently
    // unconsumed whenever only .limit() was called on it -- an unhandled rejection risk.
    const promise = Promise.resolve(value);
    return Object.assign(promise, { limit: () => promise });
  }

  /**
   * Mocks db.select() for BOTH queries requireAuth/optionalAuth can now issue per request:
   * resolveToken's user-row read (dispatched by table identity against `users`) and, only when the
   * path actually needs it, hasApprovedSubmittedApplication's generated_resumes lookup
   * (lib/approvedApplicationSubmissions.ts) -- THE FINDING #1 FIX's server-owned TIER B2 signal,
   * replacing the old client-driven acknowledgement ledger this suite used to mock here.
   */
  const withMockedUser = async (
    row: Record<string, unknown>,
    fn: () => Promise<void>,
    options: { hasSubmittedApplication?: boolean } = {},
  ) => {
    const { hasSubmittedApplication = false } = options;
    const select = mock.method(db, 'select', ((..._args: unknown[]) => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === usersTable) return chainable([row]);
          if (table === generatedResumesTable) return chainable(hasSubmittedApplication ? [{ id: 'resume-1' }] : []);
          throw new Error('unexpected db.select().from() table in THE CARD GATE test mock');
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

    await t.test('TIER B1: the account can read and edit its own profile facts, and its notification settings, for its whole locked lifetime', async () => {
      const token = await signToken('user-gated-3');
      await withMockedUser(userRow(), async () => {
        for (const url of [
          '/profile', '/profile/application', '/profile/targeting', '/profile/recent-experience',
          // FINDING #1 (round 2): moved here from TIER B2, they are ordinary account settings.
          // FINDING #2: push/subscribe and /unsubscribe used to be on no tier at all.
          '/notifications/preferences', '/notifications/push/subscribe', '/notifications/push/unsubscribe',
        ]) {
          const request = requestFor(token, url);
          const { reply, calls } = outcome();
          await requireAuth(request, reply);
          assert.equal(calls.length, 0, `expected ${url} to be reachable while gated`);
        }
      }, { hasSubmittedApplication: true }); // even past the build window
    });

    await t.test('TIER B2: the build routes are reachable before any application has been submitted...', async () => {
      const token = await signToken('user-gated-4');
      await withMockedUser(userRow(), async () => {
        // Fastify template strings, not a literal id substituted in -- request.routeOptions.url
        // (what requestPathForCardGate actually reads) is always the registered template by the
        // time a preHandler runs, never the resolved literal path. See lib/cardGate.ts's TIER B2
        // comment for why exact-set matching depends on that.
        for (const url of ['/jobs', '/jobs/:id', '/resume/generate', '/applications/managed-prepare', '/applications/from-job', '/applications/:id/submit-request']) {
          const request = requestFor(token, url);
          const { reply, calls } = outcome();
          await requireAuth(request, reply);
          assert.equal(calls.length, 0, `expected ${url} to be reachable mid-build`);
        }
      }, { hasSubmittedApplication: false });
    });

    await t.test('...and are blocked once a real submission exists: the account has already spent its one free build (THE FINDING #1 FIX)', async () => {
      const token = await signToken('user-gated-5');
      await withMockedUser(userRow(), async () => {
        for (const url of ['/jobs', '/resume/generate', '/applications/managed-prepare', '/applications/from-job']) {
          const request = requestFor(token, url);
          const { reply, calls } = outcome();
          await requireAuth(request, reply);
          assert.equal(calls.length, 1, `expected ${url} to be blocked past the build window`);
          assert.equal(calls[0].status, 402);
        }
      }, { hasSubmittedApplication: true });
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
      }, { hasSubmittedApplication: false });

      await withMockedUser(userRow(), async () => {
        // /jobs/grouped is never TIER B2 -- ordinary board browsing, blocked even mid-build.
        const request = requestFor(token, '/jobs/grouped');
        const { reply, calls } = outcome();
        await optionalAuth(request, reply);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].status, 402);
      }, { hasSubmittedApplication: false });

      await withMockedUser(userRow(), async () => {
        // Past the build window, even the bare board closes.
        const request = requestFor(token, '/jobs');
        const { reply, calls } = outcome();
        await optionalAuth(request, reply);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].status, 402);
      }, { hasSubmittedApplication: true });
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
      }, { hasSubmittedApplication: false });
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

/**
 * Written 2026-09-04 investigating live dashboard sign-outs: a token that had not reached its own
 * exp claim, was not epoch-revoked, and was not version-stale was still rejected, and the old bare
 * `catch { return invalid }` left no way to tell which of the six checks actually fired. These
 * tests pin that every rejection now logs its own reason (with the token's own claims decoded for
 * cross-reference, even when the signature itself is what failed) and, just as importantly, that
 * the response a caller sees is byte-for-byte the same 401 as before -- this is an observability
 * fix, not a behaviour change. Each one fails loudly if `logRejectedToken` is ever deleted or its
 * call sites drift: there is no source-text pin here, only "did the right structured line appear".
 */
test('token rejections are diagnosable: each invalid path logs its own reason without changing what the caller sees', async (t) => {
  const previousSecret = process.env.JWT_SIGNING_SECRET;
  const secret = 'test-signing-secret-32-chars-minimum!!';
  process.env.JWT_SIGNING_SECRET = secret;
  const secretBytes = new TextEncoder().encode(secret);

  const requestWithLog = (token: string): { request: FastifyRequest; warnCalls: Array<{ fields: unknown; msg: string }> } => {
    const warnCalls: Array<{ fields: unknown; msg: string }> = [];
    const request = {
      headers: { authorization: `Bearer ${token}` },
      log: {
        warn: (fields: unknown, msg: string) => { warnCalls.push({ fields, msg }); },
        error: () => {},
      },
    } as unknown as FastifyRequest;
    return { request, warnCalls };
  };

  const outcome = () => {
    const calls: Array<{ status: number; body: unknown }> = [];
    const reply = {
      status(status: number) {
        return { send(body: unknown) { calls.push({ status, body }); } };
      },
    } as unknown as FastifyReply;
    return { reply, calls };
  };

  /** Asserts exactly one structured rejection line was logged and returns its `tokenRejection`
   *  payload, so each sub-test can check both the reason and whatever claims it decoded. */
  const soleRejection = (warnCalls: Array<{ fields: unknown; msg: string }>) => {
    assert.equal(warnCalls.length, 1, 'expected exactly one token-rejection log line');
    assert.equal(warnCalls[0].msg, 'requireAuth rejected a presented token');
    return (warnCalls[0].fields as { tokenRejection: Record<string, unknown> }).tokenRejection;
  };

  const chainableRow = (row: Record<string, unknown>) => {
    const promise = Promise.resolve([row]);
    return Object.assign(promise, { limit: () => promise });
  };

  try {
    await t.test('a token signed with a different secret: verify_threw, claims still decoded for cross-reference, still an ordinary 401', async () => {
      const foreignToken = await new SignJWT({ userId: 'user-log-1', isGuest: false, authMethod: 'password', sessionVersion: 0 })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .sign(new TextEncoder().encode('a-completely-different-secret-32-chars!!'));
      const { request, warnCalls } = requestWithLog(foreignToken);
      const { reply, calls } = outcome();
      await requireAuth(request, reply);

      const rejection = soleRejection(warnCalls);
      assert.equal(rejection.reason, 'verify_threw');
      assert.equal(rejection.verifyErrorName, 'JWSSignatureVerificationFailed');
      // The payload is base64url, not encryption, so decodeJwt still reads it even though the
      // signature is exactly what failed -- this is the fact that makes the log line useful for
      // cross-referencing against the account's live DB row after the fact.
      assert.equal(rejection.claimUserId, 'user-log-1');
      assert.equal(rejection.claimSessionVersion, 0);
      assert.equal(typeof rejection.claimIat, 'number');

      assert.deepEqual(calls, [{ status: 401, body: { error: 'Invalid or expired token' } }]);
      assert.equal(request.jwtPayload, undefined);
    });

    /* Measured on litos-api 2026-09-04 15:39:03Z: the signature held, the user-row select threw
       "Failed query: select session_valid_from, ..." with the pool's connect timeout on its cause,
       and the old catch answered 401. The dashboard reads a 401 as an expired session, clears the
       stored token and sends the applicant to /login mid-flow. A check that could not run is an
       outage, not a rejection: 503, Retry-After, and the token stays. */
    const outcomeWithHeaders = () => {
      const calls: Array<{ status: number; headers: Record<string, string>; body: unknown }> = [];
      const reply = {
        status(status: number) {
          const headers: Record<string, string> = {};
          const chain = {
            header(name: string, value: string) { headers[name] = value; return chain; },
            send(body: unknown) { calls.push({ status, headers, body }); },
          };
          return chain;
        },
      } as unknown as FastifyReply;
      return { reply, calls };
    };
    const poolTimeout = () => {
      const cause = Object.assign(new Error('timeout exceeded when trying to connect'), { code: 'ETIMEDOUT' });
      const failure = new Error('Failed query: select "session_valid_from", "session_version" from "users" where "users"."id" = $1 limit $2');
      (failure as Error & { cause?: unknown }).cause = cause;
      return failure;
    };
    const selectThatThrows = (failure: Error) => mock.method(db, 'select', (() => ({
      from: () => ({ where: () => ({ limit: () => Promise.reject(failure) }) }),
    })) as unknown as typeof db.select);

    await t.test('a valid token whose user-row read throws: lookup_unavailable, 503 with Retry-After, and NOT a 401', async () => {
      const token = await new SignJWT({ userId: 'user-log-db', isGuest: false, authMethod: 'password', sessionVersion: 0 })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .sign(secretBytes);
      const select = selectThatThrows(poolTimeout());
      try {
        const { request, warnCalls } = requestWithLog(token);
        const { reply, calls } = outcomeWithHeaders();
        await requireAuth(request, reply);
        const rejection = soleRejection(warnCalls);
        assert.equal(rejection.reason, 'lookup_unavailable');
        assert.equal(rejection.verifyErrorName, 'Error');
        assert.match(String(rejection.verifyErrorMessage), /^Failed query: select/u);
        // The driver's own fault travels with the line, code first, so the next reader sees the
        // pool timeout and not only the query it interrupted.
        assert.equal(rejection.verifyErrorCause, 'ETIMEDOUT timeout exceeded when trying to connect');
        assert.equal(rejection.claimUserId, 'user-log-db');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].status, 503);
        assert.equal(calls[0].headers['Retry-After'], '2');
        assert.deepEqual(calls[0].body, { error: 'Your session could not be checked right now. Try again in a moment.' });
        assert.equal(request.jwtPayload, undefined);
      } finally {
        select.mock.restore();
      }
    });

    await t.test('optionalAuth answers the same 503 for a presented token it could not check, never the anonymous page', async () => {
      const token = await new SignJWT({ userId: 'user-log-db-2', isGuest: false, authMethod: 'password', sessionVersion: 0 })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .sign(secretBytes);
      const select = selectThatThrows(poolTimeout());
      try {
        const { request, warnCalls } = requestWithLog(token);
        const { reply, calls } = outcomeWithHeaders();
        await optionalAuth(request, reply);
        assert.equal(soleRejection(warnCalls).reason, 'lookup_unavailable');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].status, 503);
        assert.equal(request.jwtPayload, undefined);
      } finally {
        select.mock.restore();
      }
    });

    await t.test('a signature that fails is still verify_threw and still 401: the split changes nothing for a bad token', async () => {
      const foreignToken = await new SignJWT({ userId: 'user-log-3', isGuest: false, authMethod: 'password', sessionVersion: 0 })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .sign(new TextEncoder().encode('a-completely-different-secret-32-chars!!'));
      // The DB is never reached for a bad signature, so a throwing select proves the order too.
      const select = selectThatThrows(new Error('must not be reached'));
      try {
        const { request, warnCalls } = requestWithLog(foreignToken);
        const { reply, calls } = outcomeWithHeaders();
        await requireAuth(request, reply);
        const rejection = soleRejection(warnCalls);
        assert.equal(rejection.reason, 'verify_threw');
        assert.equal(rejection.verifyErrorCause, undefined);
        assert.equal(calls[0].status, 401);
        assert.equal(select.mock.callCount(), 0);
      } finally {
        select.mock.restore();
      }
    });

    await t.test('a token missing userId: no_user_id, still an ordinary 401', async () => {
      const token = await new SignJWT({ isGuest: false, authMethod: 'password', sessionVersion: 0 })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .sign(secretBytes);
      const { request, warnCalls } = requestWithLog(token);
      const { reply, calls } = outcome();
      await requireAuth(request, reply);
      assert.equal(soleRejection(warnCalls).reason, 'no_user_id');
      assert.deepEqual(calls, [{ status: 401, body: { error: 'Invalid or expired token' } }]);
    });

    await t.test('a token for a userId with no row: user_not_found, still an ordinary 401', async () => {
      const token = await new SignJWT({ userId: 'user-deleted', isGuest: false, authMethod: 'password', sessionVersion: 0 })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .sign(secretBytes);
      const select = mock.method(db, 'select', (() => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      })) as unknown as typeof db.select);
      try {
        const { request, warnCalls } = requestWithLog(token);
        const { reply, calls } = outcome();
        await requireAuth(request, reply);
        assert.equal(soleRejection(warnCalls).reason, 'user_not_found');
        assert.deepEqual(calls, [{ status: 401, body: { error: 'Invalid or expired token' } }]);
      } finally {
        select.mock.restore();
      }
    });

    await t.test('a token minted before the account epoch: issued_before_epoch, still an ordinary 401', async () => {
      const token = await new SignJWT({ userId: 'user-epoch', isGuest: false, authMethod: 'password', sessionVersion: 0 })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
        .sign(secretBytes);
      const select = mock.method(db, 'select', (() => ({
        from: () => ({
          where: () => ({
            limit: async () => [{
              session_valid_from: new Date(),
              session_version: 0,
              email: 'epoch@example.com',
              is_guest: false,
              guest_expires_at: null,
            }],
          }),
        }),
      })) as unknown as typeof db.select);
      try {
        const { request, warnCalls } = requestWithLog(token);
        const { reply, calls } = outcome();
        await requireAuth(request, reply);
        assert.equal(soleRejection(warnCalls).reason, 'issued_before_epoch');
        assert.deepEqual(calls, [{ status: 401, body: { error: 'Invalid or expired token' } }]);
      } finally {
        select.mock.restore();
      }
    });

    await t.test('a token whose sessionVersion is behind the stored one: session_version_stale, still an ordinary 401', async () => {
      const token = await new SignJWT({ userId: 'user-version', isGuest: false, authMethod: 'password', sessionVersion: 0 })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .sign(secretBytes);
      const select = mock.method(db, 'select', (() => ({
        from: () => ({
          where: () => ({
            limit: async () => [{
              session_valid_from: null,
              session_version: 1,
              email: 'version@example.com',
              is_guest: false,
              guest_expires_at: null,
            }],
          }),
        }),
      })) as unknown as typeof db.select);
      try {
        const { request, warnCalls } = requestWithLog(token);
        const { reply, calls } = outcome();
        await requireAuth(request, reply);
        const rejection = soleRejection(warnCalls);
        assert.equal(rejection.reason, 'session_version_stale');
        assert.equal(rejection.claimSessionVersion, 0);
        assert.deepEqual(calls, [{ status: 401, body: { error: 'Invalid or expired token' } }]);
      } finally {
        select.mock.restore();
      }
    });

    await t.test('a guest token past its own expiry: guest_expired, still an ordinary 401', async () => {
      const token = await new SignJWT({ userId: 'user-guest', isGuest: true, authMethod: 'guest', sessionVersion: 0 })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .sign(secretBytes);
      const select = mock.method(db, 'select', (() => ({
        from: () => ({
          where: () => ({
            limit: async () => [{
              session_valid_from: null,
              session_version: 0,
              email: null,
              is_guest: true,
              guest_expires_at: new Date(Date.now() - 1000),
            }],
          }),
        }),
      })) as unknown as typeof db.select);
      try {
        const { request, warnCalls } = requestWithLog(token);
        const { reply, calls } = outcome();
        await requireAuth(request, reply);
        assert.equal(soleRejection(warnCalls).reason, 'guest_expired');
        assert.deepEqual(calls, [{ status: 401, body: { error: 'Invalid or expired token' } }]);
      } finally {
        select.mock.restore();
      }
    });

    await t.test('a non-guest token for a row that is now a guest: guest_flag_mismatch, still an ordinary 401', async () => {
      const token = await new SignJWT({ userId: 'user-flag', isGuest: false, authMethod: 'password', sessionVersion: 0 })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .sign(secretBytes);
      const select = mock.method(db, 'select', (() => ({
        from: () => ({
          where: () => ({
            limit: async () => [{
              session_valid_from: null,
              session_version: 0,
              email: null,
              is_guest: true,
              guest_expires_at: new Date(Date.now() + 60_000),
            }],
          }),
        }),
      })) as unknown as typeof db.select);
      try {
        const { request, warnCalls } = requestWithLog(token);
        const { reply, calls } = outcome();
        await requireAuth(request, reply);
        assert.equal(soleRejection(warnCalls).reason, 'guest_flag_mismatch');
        assert.deepEqual(calls, [{ status: 401, body: { error: 'Invalid or expired token' } }]);
      } finally {
        select.mock.restore();
      }
    });

    await t.test('a session that verifies cleanly logs nothing at all', async () => {
      const token = await new SignJWT({ userId: 'user-ok', isGuest: false, authMethod: 'password', sessionVersion: 0 })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .sign(secretBytes);
      const select = mock.method(db, 'select', (() => ({
        from: () => ({
          where: () => chainableRow({
            session_valid_from: null,
            session_version: 0,
            email: 'ok@example.com',
            is_guest: false,
            guest_expires_at: null,
            billing_provider: null,
            billing_customer_id: null,
            created_at: new Date('2020-01-01T00:00:00.000Z'),
            onboarding_completed_at: new Date('2020-01-01T00:00:00.000Z'),
          }),
        }),
      })) as unknown as typeof db.select);
      try {
        const { request, warnCalls } = requestWithLog(token);
        const { reply, calls } = outcome();
        await requireAuth(request, reply);
        assert.equal(warnCalls.length, 0, 'a valid session must not log a rejection');
        assert.equal(calls.length, 0);
        assert.equal(request.jwtPayload?.userId, 'user-ok');
      } finally {
        select.mock.restore();
      }
    });
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SIGNING_SECRET;
    else process.env.JWT_SIGNING_SECRET = previousSecret;
  }
});
