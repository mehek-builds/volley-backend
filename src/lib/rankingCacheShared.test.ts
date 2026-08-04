/**
 * The L2 (Upstash) tier of the ranking cache.
 *
 * Every case here is about ONE property: a miss must cost a re-rank and nothing worse. The tier
 * exists to keep description text from being re-read out of Neon on every cold start, so the
 * failure modes that matter are the ones where it stops serving hits silently, or where it takes
 * the request down with it.
 *
 * Upstash is stubbed by replacing globalThis.fetch. No network, and the assertions are on the
 * actual command bodies sent, because "we called Redis" is not the claim being made anywhere in
 * this file. The claim is which command, with which TTL, carrying which payload.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  RANKING_CACHE_MAX,
  RANKING_CACHE_TTL_MS,
  RANKING_SHARED_TTL_MS,
  clearRankingCache,
  rankingCacheSize,
  readRankingShared,
  sharedRankingConfigured,
  writeRankingShared,
} from './rankingCache';

const KEY = 'u1|123.abc|filters';
const list = (ids: string[]) => ({
  ids,
  scores: new Map(ids.map((id, i) => [id, 100 - i] as const)),
  poolExhausted: false,
});

const realFetch = globalThis.fetch;
const realUrl = process.env.UPSTASH_REDIS_REST_URL;
const realToken = process.env.UPSTASH_REDIS_REST_TOKEN;

/** Every command the stub was asked to run, in order, already JSON-parsed. */
let sent: unknown[][] = [];

/** The value the stubbed GET should return, or null for a Redis-side miss. */
let stored: string | null = null;

/** When set, the stub throws it instead of answering. Stands in for an Upstash outage. */
let failWith: Error | null = null;

function stubUpstash() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash.io/';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const command = JSON.parse(init.body) as unknown[];
    sent.push(command);
    if (failWith) throw failWith;
    if (command[0] === 'GET') return { ok: true, json: async () => ({ result: stored }) };
    if (command[0] === 'SET') {
      stored = String(command[2]);
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    return { ok: true, json: async () => ({ result: null }) };
  }) as unknown as typeof fetch;
}

function unconfigure() {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

beforeEach(() => {
  clearRankingCache();
  sent = [];
  stored = null;
  failWith = null;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = realUrl;
  if (realToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = realToken;
});

describe('when Upstash is not configured', () => {
  /* This is the shipped-today behaviour and it has to survive verbatim, because the deploy that
     carries this file may land before the Upstash database exists. */
  test('reports itself unconfigured', () => {
    unconfigure();
    assert.strictEqual(sharedRankingConfigured(), false);
  });

  test('still caches in process memory, and touches no network at all', async () => {
    unconfigure();
    globalThis.fetch = (() => {
      throw new Error('the unconfigured path must not make a request');
    }) as unknown as typeof fetch;

    await writeRankingShared(KEY, list(['a', 'b']));
    const found = await readRankingShared(KEY);
    assert.deepStrictEqual(found?.ids, ['a', 'b']);
  });

  test('a cold instance misses, which is exactly the behaviour that motivated L2', async () => {
    unconfigure();
    await writeRankingShared(KEY, list(['a']));
    clearRankingCache(); // stands in for a new lambda
    assert.strictEqual(await readRankingShared(KEY), null);
  });
});

describe('when Upstash is configured', () => {
  test('reports itself configured', () => {
    stubUpstash();
    assert.strictEqual(sharedRankingConfigured(), true);
  });

  test('a cold instance is served from L2 instead of re-ranking', async () => {
    stubUpstash();
    await writeRankingShared(KEY, list(['a', 'b', 'c']));

    clearRankingCache(); // a brand new serverless instance: L1 is empty
    const found = await readRankingShared(KEY);

    assert.ok(found, 'the whole point of the tier: this must not be a miss');
    assert.deepStrictEqual(found.ids, ['a', 'b', 'c'], 'the ORDER is what survives the cold start');
  });

  test('scores survive the round trip, including a null that is not a zero', async () => {
    stubUpstash();
    await writeRankingShared(KEY, {
      ids: ['a', 'b'],
      scores: new Map([
        ['a', 87],
        ['b', null],
      ]),
      poolExhausted: true,
    });
    clearRankingCache();

    const found = await readRankingShared(KEY);
    assert.strictEqual(found?.scores.get('a'), 87);
    assert.strictEqual(found?.scores.get('b'), null, 'unscorable must not come back as 0');
    assert.strictEqual(found?.poolExhausted, true, 'the list must still be able to say it stopped');
  });

  test('an L1 hit does not call Upstash', async () => {
    stubUpstash();
    await writeRankingShared(KEY, list(['a']));
    sent = [];

    await readRankingShared(KEY);
    assert.deepStrictEqual(sent, [], 'the warm path must stay a memory read');
  });

  test('writes with the L2 TTL, in whole seconds, not the L1 one', async () => {
    stubUpstash();
    await writeRankingShared(KEY, list(['a']));

    const set = sent.find((command) => command[0] === 'SET');
    assert.ok(set, 'a write must reach Upstash');
    assert.strictEqual(set[3], 'EX');
    assert.strictEqual(set[4], String(RANKING_SHARED_TTL_MS / 1000));
    assert.strictEqual(set[4], '900', 'fifteen minutes, the number that decides the Neon bill');
  });

  test('namespaces its keys so a shared Upstash database cannot collide', async () => {
    stubUpstash();
    await writeRankingShared(KEY, list(['a']));

    const set = sent.find((command) => command[0] === 'SET');
    assert.match(String(set?.[1]), /^litos:ranking:v1:/);
    assert.ok(String(set?.[1]).endsWith(KEY));
  });
});

describe('freshness', () => {
  test('an L2 hit keeps its ORIGINAL age, so a hot key cannot outlive its own TTL', async () => {
    stubUpstash();
    const t0 = 1_000_000;
    await writeRankingShared(KEY, list(['a']), t0);

    /* Hand the entry from instance to instance, each hop late in the window. If promotion into L1
       reset createdAt, this ranking would be immortal and would silently go stale. */
    for (const hop of [1, 2, 3]) {
      clearRankingCache();
      const found = await readRankingShared(KEY, t0 + hop * (RANKING_SHARED_TTL_MS - 1_000));
      if (hop === 1) assert.ok(found, 'still inside the window on the first hop');
      else assert.strictEqual(found, null, `hop ${hop} is past the window and must be a miss`);
    }
  });

  test('an entry older than the L2 window is a miss even if Upstash still holds it', async () => {
    stubUpstash();
    const t0 = 1_000_000;
    await writeRankingShared(KEY, list(['a']), t0);
    clearRankingCache();

    /* Upstash's own EX would normally have dropped this. It is re-checked on read so that a deploy
       SHORTENING the window takes effect at once rather than when the last long entry expires. */
    assert.strictEqual(await readRankingShared(KEY, t0 + RANKING_SHARED_TTL_MS + 1), null);
    assert.ok(await readRankingShared(KEY, t0 + RANKING_SHARED_TTL_MS - 1), 'just inside is a hit');
  });

  test('L1 still expires on its own shorter window, falling through to L2', async () => {
    stubUpstash();
    const t0 = 1_000_000;
    await writeRankingShared(KEY, list(['a']), t0);
    sent = [];

    const found = await readRankingShared(KEY, t0 + RANKING_CACHE_TTL_MS + 1);
    assert.ok(found, 'L2 is younger than L1 here, so this is still a hit');
    assert.ok(
      sent.some((command) => command[0] === 'GET'),
      'an expired L1 entry must fall through rather than being served',
    );
  });
});

describe('promoting an L2 hit respects the L1 size bound', () => {
  /* THE BUG THIS BLOCK EXISTS FOR. readRankingShared promoted L2 hits with a bare cache.set, which
     skipped the RANKING_CACHE_MAX eviction that writeRanking enforces. On a warm instance serving
     many distinct keys out of L2 the map grew without any bound, in a serverless process whose
     memory is shared with resume generation. */
  test('L1 never exceeds RANKING_CACHE_MAX no matter how many L2 hits are promoted', async () => {
    stubUpstash();

    /* One Upstash entry per key. The stub holds a single slot, so each key is written then read
       back on a cleared L1, which is exactly the cold-instance promotion path. */
    for (let i = 0; i < RANKING_CACHE_MAX + 50; i++) {
      const key = `key-${i}`;
      stored = null;
      await writeRankingShared(key, list([`job-${i}`]));
      const held = stored;
      clearRankingCache(); // a fresh instance
      stored = held;
      const found = await readRankingShared(key);
      assert.ok(found, `key-${i} should have come back from L2`);
      // Re-seed L1 the way a real sequence of requests would, without clearing between them.
      if (i % 10 === 0) {
        assert.ok(
          rankingCacheSize() <= RANKING_CACHE_MAX,
          `L1 held ${rankingCacheSize()} entries, over the ${RANKING_CACHE_MAX} bound`,
        );
      }
    }
  });

  test('promotions accumulate in L1 but stay bounded', async () => {
    stubUpstash();
    const payloads: string[] = [];
    for (let i = 0; i < RANKING_CACHE_MAX + 50; i++) {
      stored = null;
      await writeRankingShared(`k-${i}`, list([`j-${i}`]));
      payloads.push(stored!);
    }
    clearRankingCache();
    assert.strictEqual(rankingCacheSize(), 0);

    // Now promote every one of them into a single warm instance, back to back.
    for (let i = 0; i < payloads.length; i++) {
      stored = payloads[i]!;
      await readRankingShared(`k-${i}`);
    }
    assert.ok(
      rankingCacheSize() <= RANKING_CACHE_MAX,
      `L1 grew to ${rankingCacheSize()} entries from L2 promotions alone, ` +
        `over the ${RANKING_CACHE_MAX} bound`,
    );
  });
});

describe('an Upstash outage degrades, it does not break', () => {
  test('a throwing read is a miss, not an exception', async () => {
    stubUpstash();
    failWith = new Error('ECONNRESET');
    assert.strictEqual(await readRankingShared(KEY), null);
  });

  test('a throwing write still returns the L1 entry', async () => {
    stubUpstash();
    failWith = new Error('ECONNRESET');

    const entry = await writeRankingShared(KEY, list(['a', 'b']));
    assert.deepStrictEqual(entry.ids, ['a', 'b'], 'the caller must get its ranking regardless');

    failWith = null;
    const warm = await readRankingShared(KEY);
    assert.deepStrictEqual(warm?.ids, ['a', 'b'], 'and L1 must have been written anyway');
  });

  test('a non-200 from Upstash is a miss, not a parse error', async () => {
    stubUpstash();
    globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    assert.strictEqual(await readRankingShared(KEY), null);
  });

  test('a corrupt stored payload is a miss, not a crash', async () => {
    stubUpstash();
    stored = 'not json at all';
    assert.strictEqual(await readRankingShared(KEY), null);

    stored = JSON.stringify({ ids: 'not an array' });
    assert.strictEqual(await readRankingShared(KEY), null);
  });
});
