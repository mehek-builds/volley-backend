import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  RANKING_CACHE_MAX,
  RANKING_CACHE_TTL_MS,
  clearRankingCache,
  rankingCacheKey,
  rankingCacheSize,
  readRanking,
  resumeFingerprint,
  writeRanking,
} from './rankingCache';

const RESUME = 'Frontend engineer. TypeScript, React, PostgreSQL.';
const list = (ids: string[]) => ({
  ids,
  scores: new Map(ids.map((id, i) => [id, 100 - i] as const)),
  poolExhausted: false,
});

beforeEach(() => clearRankingCache());

describe('rankingCacheKey', () => {
  test('the same student, resume and filters share one ranking', () => {
    assert.strictEqual(rankingCacheKey('u1', RESUME, 'f'), rankingCacheKey('u1', RESUME, 'f'));
  });

  test('one student never receives another student ordering', () => {
    assert.notStrictEqual(rankingCacheKey('u1', RESUME, 'f'), rankingCacheKey('u2', RESUME, 'f'));
  });

  test('different filters are different lists', () => {
    assert.notStrictEqual(rankingCacheKey('u1', RESUME, 'remote'), rankingCacheKey('u1', RESUME, 'onsite'));
  });

  test('EDITING THE RESUME MISSES, so a stale ranking is never served', () => {
    // The whole reason the fingerprint is in the key. A student who edits their resume and reloads
    // must see the new ordering, not the one their previous resume produced.
    const before = rankingCacheKey('u1', RESUME, 'f');
    const after = rankingCacheKey('u1', `${RESUME} Added Kubernetes.`, 'f');
    assert.notStrictEqual(before, after);
  });
});

describe('resumeFingerprint', () => {
  test('is stable for the same text and differs for changed text', () => {
    assert.strictEqual(resumeFingerprint(RESUME), resumeFingerprint(RESUME));
    assert.notStrictEqual(resumeFingerprint(RESUME), resumeFingerprint(`${RESUME} `));
    assert.notStrictEqual(resumeFingerprint('abc'), resumeFingerprint('acb'), 'order matters');
  });

  test('an empty resume still fingerprints without throwing', () => {
    assert.strictEqual(typeof resumeFingerprint(''), 'string');
  });
});

describe('reading and writing a ranking', () => {
  test('what was written is what comes back', () => {
    const key = rankingCacheKey('u1', RESUME, 'f');
    writeRanking(key, list(['a', 'b', 'c']));
    const found = readRanking(key);
    assert.deepStrictEqual(found?.ids, ['a', 'b', 'c']);
    assert.strictEqual(found?.scores.get('a'), 100);
  });

  test('a key never written is a miss, not a throw', () => {
    assert.strictEqual(readRanking('never-written'), null);
  });

  test('a ranking past its TTL is a miss and is dropped', () => {
    const key = rankingCacheKey('u1', RESUME, 'f');
    const t0 = 1_000_000;
    writeRanking(key, list(['a']), t0);
    assert.notStrictEqual(readRanking(key, t0 + RANKING_CACHE_TTL_MS - 1), null, 'still fresh');
    assert.strictEqual(readRanking(key, t0 + RANKING_CACHE_TTL_MS + 1), null, 'expired');
    assert.strictEqual(rankingCacheSize(), 0, 'an expired entry is not left occupying the map');
  });

  test('a null score survives the round trip as null, never as zero', () => {
    // The distinction the whole feature rests on: a posting we declined to score is not a posting
    // that scored zero.
    const key = rankingCacheKey('u1', RESUME, 'f');
    writeRanking(key, { ids: ['a'], scores: new Map([['a', null]]), poolExhausted: false });
    assert.strictEqual(readRanking(key)?.scores.get('a'), null);
  });

  test('pool exhaustion is remembered, so every page says the same thing', () => {
    const key = rankingCacheKey('u1', RESUME, 'f');
    writeRanking(key, { ...list(['a']), poolExhausted: true });
    assert.strictEqual(readRanking(key)?.poolExhausted, true);
  });
});

describe('eviction', () => {
  test('the map is bounded', () => {
    for (let i = 0; i < RANKING_CACHE_MAX + 25; i++) writeRanking(`key-${i}`, list(['a']));
    assert.ok(rankingCacheSize() <= RANKING_CACHE_MAX, `size was ${rankingCacheSize()}`);
  });

  test('the oldest entry goes first, and a rewrite counts as new', () => {
    for (let i = 0; i < RANKING_CACHE_MAX; i++) writeRanking(`key-${i}`, list(['a']));
    // Refreshing key-0 must move it to the back of the eviction queue, otherwise the entry being
    // actively used is the one evicted.
    writeRanking('key-0', list(['refreshed']));
    writeRanking('overflow', list(['b']));
    assert.notStrictEqual(readRanking('key-0'), null, 'a just-refreshed entry must survive');
    assert.strictEqual(readRanking('key-1'), null, 'the genuinely oldest entry is the one dropped');
  });
});

describe('the property the cache exists for: pages tile the ranking', () => {
  test('every id appears exactly once across pages, in order', () => {
    // Ranking a live pool per request meant page 2 was cut from a different ordering than page 1,
    // so a posting could arrive on both pages or on neither. Slicing ONE remembered order cannot
    // do either, and this is the assertion that says so.
    const ids = Array.from({ length: 137 }, (_, i) => `job-${i}`);
    const key = rankingCacheKey('u1', RESUME, 'f');
    writeRanking(key, list(ids));

    const seen: string[] = [];
    const limit = 50;
    for (let offset = 0; offset < ids.length; offset += limit) {
      seen.push(...readRanking(key)!.ids.slice(offset, offset + limit));
    }
    assert.deepStrictEqual(seen, ids, 'no gap, no repeat, original order');
    assert.strictEqual(new Set(seen).size, seen.length, 'no id served twice');
  });

  test('paging past the end is empty rather than wrapping or throwing', () => {
    const key = rankingCacheKey('u1', RESUME, 'f');
    writeRanking(key, list(['a', 'b']));
    assert.deepStrictEqual(readRanking(key)!.ids.slice(100_000, 100_050), []);
  });
});
