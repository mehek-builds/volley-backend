import { test, describe } from 'node:test';
import assert from 'node:assert';
import { normalizeCity, splitLocations, rankCities } from './cities';

/* Every case below is a real value off the board, not an invented one. */

describe('normalizeCity', () => {
  test('merges the spellings employers use for one place', () => {
    /* This is the whole point: these three arrived as separate suggestions and
       spent three of the fifty slots on New York. */
    for (const raw of ['New York, NY', 'New York, New York', 'New York, NY, United States']) {
      assert.equal(normalizeCity(raw), 'New York, NY', raw);
    }
    assert.equal(normalizeCity('San Francisco, California'), 'San Francisco, CA');
    assert.equal(normalizeCity('San Mateo, CA, United States'), 'San Mateo, CA');
  });

  test('refuses things that are not cities', () => {
    /* A field labelled City must not offer a country or a working arrangement.
       "United States" and "Hybrid" were both in the top ten. */
    for (const raw of ['United States', 'Remote', 'Hybrid', 'In-Office', 'Worldwide', 'N/A', 'TBD', 'Various']) {
      assert.equal(normalizeCity(raw), null, raw);
    }
  });

  test('keeps the place out of a remote label rather than dropping the row', () => {
    assert.equal(normalizeCity('Remote - US'), null);
    assert.equal(normalizeCity('Remote - Austin, TX'), 'Austin, TX');
    assert.equal(normalizeCity('Remote (London)'), 'London');
  });

  test('leaves non-US regions alone instead of mangling them', () => {
    /* The state map is deliberately partial; an unknown region passes through. */
    assert.equal(normalizeCity('Toronto, Ontario'), 'Toronto, Ontario');
    assert.equal(normalizeCity('Bengaluru, India'), 'Bengaluru, India');
    assert.equal(normalizeCity('Singapore'), 'Singapore');
  });

  test('rejects a value with no letters in it', () => {
    assert.equal(normalizeCity('94105'), null);
    assert.equal(normalizeCity('  '), null);
  });
});

describe('splitLocations', () => {
  test('splits the separators employers actually use', () => {
    assert.deepEqual(splitLocations('Boston; New York City; Pennsylvania'),
      ['Boston', 'New York City', 'Pennsylvania']);
    assert.deepEqual(splitLocations('San Francisco, CA • New York, NY'),
      ['San Francisco, CA', 'New York, NY']);
  });

  test('a single location is left whole, commas and all', () => {
    assert.deepEqual(splitLocations('San Mateo, CA, United States'), ['San Mateo, CA, United States']);
  });
});

describe('rankCities', () => {
  test('sums a city across its spellings, so the true total ranks', () => {
    /* Split three ways, New York would lose to a city spelled consistently.
       Merged, it wins — which is the correct answer. */
    const ranked = rankCities([
      { location: 'New York, NY', n: 40 },
      { location: 'New York, New York', n: 35 },
      { location: 'New York, NY, United States', n: 30 },
      { location: 'Austin, TX', n: 80 },
    ], 5);
    assert.deepEqual(ranked, ['New York, NY', 'Austin, TX']);
  });

  test('counts every city in a multi-city posting', () => {
    const ranked = rankCities([{ location: 'Boston, MA; Denver, CO', n: 5 }], 5);
    assert.deepEqual(ranked.sort(), ['Boston, MA', 'Denver, CO']);
  });

  test('honours the limit and drops the non-cities', () => {
    const rows = [
      { location: 'United States', n: 999 },
      { location: 'Remote', n: 998 },
      { location: 'Paris, France', n: 3 },
      { location: null, n: 500 },
    ];
    assert.deepEqual(rankCities(rows, 50), ['Paris, France']);
  });
});
