import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cacheKey } from './competencyCache';

const BULLETS = [
  'Led a 4-person team, analyzing 350 survey responses & conducting 30 user interviews.',
  'Produced a 50-page proposal detailing actionable recommendations.',
];

/**
 * The cache is safe to keep forever ONLY because the key is content-addressed. These pin that
 * property rather than the hashing, because the hash is an implementation detail and the
 * "no stale hit is reachable" claim is the one the never-expire decision rests on.
 */
describe('the cache key changes whenever either input changes', () => {
  test('same clause and same bullets is the same key', () => {
    assert.equal(cacheKey('You communicate well', BULLETS), cacheKey('You communicate well', BULLETS));
  });

  test('a different clause is a different key', () => {
    assert.notEqual(cacheKey('You communicate well', BULLETS), cacheKey('You analyse well', BULLETS));
  });

  test('an EDITED resume is a different key, so a stale hit cannot be served', () => {
    // The whole invalidation story. A student edits a bullet, every key moves, and nothing sweeps.
    const edited = [BULLETS[0], 'Produced a 50-page proposal detailing actionable recommendations and outcomes.'];
    assert.notEqual(cacheKey('You communicate well', BULLETS), cacheKey('You communicate well', edited));
  });

  test('adding a bullet is a different key', () => {
    assert.notEqual(cacheKey('x y z', BULLETS), cacheKey('x y z', [...BULLETS, 'Shipped a thing.']));
  });

  test('surrounding whitespace does not change the key', () => {
    // Trimmed on both sides, so a bullet that gained a trailing space is still a hit.
    assert.equal(cacheKey('  You communicate well  ', BULLETS), cacheKey('You communicate well', BULLETS.map((b) => `${b} `)));
  });

  test('two different bullet lists cannot collide by concatenating the same', () => {
    // ["ab", "c"] and ["a", "bc"] join to different strings under a separator that is not in either.
    assert.notEqual(cacheKey('q', ['ab', 'c']), cacheKey('q', ['a', 'bc']));
  });

  test('the key is not keyed by user, which is what makes the hit rate worth having', () => {
    // Two students with the same bullet get the same verdict; the quote stored is the bullet that
    // produced the hash, so nothing of one student's is shown to another.
    assert.equal(cacheKey('You communicate well', BULLETS), cacheKey('You communicate well', [...BULLETS]));
  });
});

describe('the cache never makes a bad model response permanent', () => {
  const src = readFileSync(path.join(__dirname, 'competencyCache.ts'), 'utf8');

  test('rejected verdicts are excluded from the write', () => {
    // A verdict the grounding gate threw out is a hallucination. Writing it would serve that
    // hallucination to everyone who ever asks the same question, forever.
    assert.match(src, /rejectedIds/);
    assert.match(src, /!rejectedIds\.has\(v\.id\)/);
  });

  test('a racing write is a no-op rather than an error', () => {
    assert.match(src, /onConflictDoNothing\(\)/);
  });

  test('the route reports how many were judged versus served from cache', () => {
    const route = readFileSync(path.join(__dirname, '..', 'routes', 'jdMatch.ts'), 'utf8');
    assert.match(route, /judged,/);
    assert.match(route, /from_cache: fromCache/);
  });
});

describe('the breakdown route is review-screen only', () => {
  const route = readFileSync(path.join(__dirname, '..', 'routes', 'jdMatch.ts'), 'utf8');

  test('it is its own endpoint, so the list path is untouched', () => {
    // /jd-match stays free and synchronous. Putting a model call on the endpoint a 24-row list
    // fans out to is the cost mistake this whole split exists to avoid.
    assert.match(route, /'\/jd-match\/requirements'/);
    const listRoute = route.slice(route.indexOf("fastify.post('/jd-match'"), route.indexOf("'/jd-match/evidence'"));
    assert.doesNotMatch(listRoute, /judgeCompetencies/);
  });

  test('rejected verdicts are surfaced to the caller, not swallowed', () => {
    assert.match(route, /rejected: result\.rejected/);
  });

  test('it falls back to the stored base resume when no spec is sent', () => {
    assert.match(route, /parsed\.data\.spec as ResumeSpec \| undefined\) \?\? stored/);
  });
});
