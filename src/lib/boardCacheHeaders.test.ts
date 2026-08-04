/**
 * These are mostly not tests about caching. They are tests about a LEAK.
 *
 * The public board response varies by account (accountRequiresSponsor is OR-ed in server-side), so
 * the failure mode of getting this wrong is not a stale page, it is one visitor's board served to
 * another. The direction that matters: an anonymous, unfiltered response replayed to a
 * sponsor-required account fills their board with the exact postings the filter exists to hide,
 * silently. So the assertions below are about which responses may be STORED by a shared cache, and
 * the header values are checked mainly to prove that.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  BOARD_SHARED_MAX_AGE_S,
  BOARD_STALE_WHILE_REVALIDATE_S,
  applyBoardCacheHeaders,
} from './boardCacheHeaders';

/**
 * The header fields the CDN actually reads back, captured off a fake reply.
 *
 * `preset` seeds headers another plugin already set. It exists because the first version of this
 * fake had NO getHeader at all, which made an overwrite indistinguishable from an append and let a
 * real bug through: @fastify/cors sets `Vary: Origin`, and `reply.header('Vary', ...)` replaced it.
 */
function run(jwtPayload: unknown, preset: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...preset };
  const reply = {
    header(name: string, value: string) {
      headers[name] = value;
      return reply;
    },
    getHeader(name: string) {
      return headers[name];
    },
  };
  const returned = applyBoardCacheHeaders(
    { jwtPayload } as never,
    reply as never,
  );
  return { headers, returned, reply };
}

/** Vary as a set of lowercase tokens, which is how a cache reads it. */
const varyTokens = (headers: Record<string, string>) =>
  String(headers['Vary'] ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

const anonymous = () => run(undefined);
const signedIn = () => run({ userId: 'u1' });

describe('an anonymous board response is shareable', () => {
  test('is public, which is what lets the CDN answer without touching Neon', () => {
    const { headers } = anonymous();
    assert.match(headers['Cache-Control'], /(^|,\s*)public\b/);
  });

  test('carries the shared window and a stale-while-revalidate longer than the poll cadence', () => {
    const { headers } = anonymous();
    assert.match(headers['Cache-Control'], new RegExp(`s-maxage=${BOARD_SHARED_MAX_AGE_S}\\b`));
    assert.match(
      headers['Cache-Control'],
      new RegExp(`stale-while-revalidate=${BOARD_STALE_WHILE_REVALIDATE_S}\\b`),
    );
    /* The herd is the failure mode worth preventing on a database that gets suspended for
       transfer: at expiry the CDN must keep answering from stale rather than letting every waiting
       visitor through to the origin at once. */
    assert.ok(
      BOARD_STALE_WHILE_REVALIDATE_S > BOARD_SHARED_MAX_AGE_S,
      'a stale window at or under the fresh window does not prevent a thundering herd',
    );
  });
});

describe('a signed-in board response is NOT shareable', () => {
  test('is private, so a shared cache may not store it', () => {
    const { headers } = signedIn();
    assert.match(headers['Cache-Control'], /(^|,\s*)private\b/);
  });

  test('is never public and never carries a shared-cache directive', () => {
    const { headers } = signedIn();
    assert.ok(!/\bpublic\b/.test(headers['Cache-Control']), headers['Cache-Control']);
    assert.ok(
      !/\bs-maxage\b/.test(headers['Cache-Control']),
      's-maxage on a per-account response is the leak this file exists to prevent',
    );
  });
});

describe('Vary keeps the two apart', () => {
  /* Without this, a cache holding the anonymous entry could satisfy a later authenticated request
     for the same URL straight from that entry. The `private` on the authenticated branch would
     never get a chance to prevent it, because that request would not reach the origin at all. */
  test('is sent on the anonymous response, which is the one that gets stored', () => {
    assert.strictEqual(anonymous().headers['Vary'], 'Authorization');
  });

  test('is sent on the authenticated response too', () => {
    assert.strictEqual(signedIn().headers['Vary'], 'Authorization');
  });

  /* THE BUG THIS BLOCK EXISTS FOR. @fastify/cors is registered with a dynamic `origin` function, so
     it sets `Vary: Origin` on every response. reply.header REPLACES, so setting Vary here dropped
     it. Combined with marking the response `public`, a shared cache would key the entry WITHOUT
     Origin and could serve one origin's Access-Control-Allow-Origin to a different allowed origin. */
  test('does not discard a Vary another plugin already set', () => {
    const { headers } = run(undefined, { Vary: 'Origin' });
    const tokens = varyTokens(headers);
    assert.ok(tokens.includes('origin'), `CORS Vary was dropped, header is "${headers['Vary']}"`);
    assert.ok(tokens.includes('authorization'), 'and ours must still be there');
  });

  test('preserves an existing Vary on the authenticated branch too', () => {
    const tokens = varyTokens(run({ userId: 'u1' }, { Vary: 'Origin' }).headers);
    assert.deepStrictEqual(tokens.sort(), ['authorization', 'origin']);
  });

  test('does not duplicate a field that is already listed, in any case', () => {
    for (const preset of ['Authorization', 'authorization', 'Origin, Authorization']) {
      const tokens = varyTokens(run(undefined, { Vary: preset }).headers);
      const authCount = tokens.filter((t) => t === 'authorization').length;
      assert.strictEqual(authCount, 1, `"${preset}" produced "${tokens.join(', ')}"`);
    }
  });

  test('leaves Vary: * alone, because adding a field to it would weaken it', () => {
    // `*` already means "never reuse this entry for another request".
    assert.strictEqual(run(undefined, { Vary: '*' }).headers['Vary'], '*');
  });
});

describe('mechanics', () => {
  test('returns the reply so it can be chained straight into .send()', () => {
    const { returned, reply } = anonymous();
    assert.strictEqual(returned, reply, 'the call sites are applyBoardCacheHeaders(...).send(...)');
  });

  test('presence of jwtPayload is the test, not the shape of it', () => {
    /* optionalAuth sets jwtPayload only on a VALID token: an expired one 401s before any handler
       runs, and a missing one leaves this undefined. So truthiness here is the whole question. */
    assert.match(run(null).headers['Cache-Control'], /public/);
    assert.match(run({ userId: 'anything' }).headers['Cache-Control'], /private/);
  });
});
