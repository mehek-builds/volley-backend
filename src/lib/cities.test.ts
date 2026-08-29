import { test, describe } from 'node:test';
import assert from 'node:assert';
import { normalizeCity, splitLocations, rankCities, parsePlace, fold } from './cities';

/* Every string below is a real value off the live board, not an invented one. */

describe('splitLocations', () => {
  test('splits the separators employers use', () => {
    assert.deepEqual(splitLocations('Boston; New York City; Pennsylvania'),
      ['Boston', 'New York City', 'Pennsylvania']);
    assert.deepEqual(splitLocations('San Francisco, CA • New York, NY'),
      ['San Francisco, CA', 'New York, NY']);
    assert.deepEqual(splitLocations('San Francisco, CA or Remote'),
      ['San Francisco, CA', 'Remote']);
  });

  test('drops parentheticals and arrangement prefixes', () => {
    assert.deepEqual(splitLocations('New York, NY (HQ)'), ['New York, NY']);
    assert.deepEqual(splitLocations('London, UK (Hybrid)'), ['London, UK']);
    assert.deepEqual(splitLocations('Hybrid - San Francisco'), ['San Francisco']);
  });
});

describe('normalizeCity', () => {
  test('canonicalises the region however it is spelled', () => {
    for (const raw of ['London, United Kingdom', 'London, UK', 'London, England']) {
      assert.equal(normalizeCity(raw), 'London, UK', raw);
    }
    for (const raw of ['Toronto, Ontario', 'Toronto, ON']) {
      assert.equal(normalizeCity(raw), 'Toronto, ON', raw);
    }
    assert.equal(normalizeCity('San Francisco, California'), 'San Francisco, CA');
  });

  test('drops a country that a state already implies', () => {
    assert.equal(normalizeCity('San Mateo, CA United States'), 'San Mateo, CA');
    assert.equal(normalizeCity('Mountain View, CA USA'), 'Mountain View, CA');
    assert.equal(normalizeCity('New York, NY, United States'), 'New York, NY');
  });

  test('drops a region that only repeats the city', () => {
    assert.equal(normalizeCity('Singapore, Singapore'), 'Singapore');
    assert.equal(normalizeCity('Dublin, Dublin'), 'Dublin');
    assert.equal(normalizeCity('Berlin, Berlin'), 'Berlin');
    assert.equal(normalizeCity('Hong Kong, Hong Kong'), 'Hong Kong');
  });

  test('drops a working arrangement used as a region', () => {
    assert.equal(normalizeCity('New York, Remote'), 'New York');
    assert.equal(normalizeCity('Washington, Remote'), 'Washington');
  });

  test('applies city aliases, accents included', () => {
    assert.equal(normalizeCity('Bangalore, India'), 'Bengaluru, India');
    assert.equal(normalizeCity('Gurgaon'), 'Gurugram');
    assert.equal(normalizeCity('Sao Paulo, Brazil'), 'São Paulo, Brazil');
    assert.equal(normalizeCity('Washington, D.C.'), 'Washington, DC');
  });

  test('keeps a sub-national region we have not enumerated', () => {
    /* Karnataka IS mapped to India; this proves the fallback for one that is
       not: an unknown region is kept, never mangled or dropped. */
    assert.equal(normalizeCity('Warsaw, Masovian Voivodeship'), 'Warsaw, Poland');
    assert.equal(normalizeCity('Springfield, Somewhereshire'), 'Springfield, Somewhereshire');
  });

  test('a country standing alone is not a city', () => {
    /* "Canada" and "India" both reached the live suggestion list. */
    for (const raw of ['Canada', 'India', 'Australia', 'Germany', 'Brazil']) {
      assert.equal(normalizeCity(raw), null, raw);
    }
  });

  test('but a city-state still is', () => {
    /* Singapore is both, and accounts for 200 postings. Losing it to the rule
       above would be the rule doing more harm than the bug it fixes. */
    assert.equal(normalizeCity('Singapore'), 'Singapore');
    assert.equal(normalizeCity('Hong Kong'), 'Hong Kong');
  });

  test('an arrangement dressed as a place is refused', () => {
    for (const raw of ['US Remote', 'Remote within Canada', 'BLANK', 'Remote - US']) {
      assert.equal(normalizeCity(raw), null, raw);
    }
  });

  test('refuses things that are not cities', () => {
    for (const raw of ['United States', 'Remote', 'Hybrid', 'EMEA', 'Worldwide', 'N/A', 'TBD', 'United Kingdom']) {
      assert.equal(normalizeCity(raw), null, raw);
    }
    assert.equal(normalizeCity('94105'), null);
  });
});

describe('parsePlace with the board vocabulary', () => {
  const known = new Set(['seattle', 'chicago', 'newyork', 'sanfrancisco', 'barcelona'].map(fold));

  test('a comma between two CITIES yields both', () => {
    assert.deepEqual(parsePlace('San Francisco, Seattle', known).map((p) => p.city),
      ['San Francisco', 'Seattle']);
    assert.deepEqual(parsePlace('New York, Chicago', known).map((p) => p.city),
      ['New York', 'Chicago']);
    assert.deepEqual(parsePlace('Berlin, Barcelona', known).map((p) => p.city),
      ['Berlin', 'Barcelona']);
  });

  test('a comma before a REGION still yields one place', () => {
    assert.deepEqual(parsePlace('New York, NY', known), [{ city: 'New York', region: 'NY' }]);
  });

  test('a city-state named after the comma is a second city, not a region', () => {
    /* Found live: "Dubai, Hong Kong, London" is three postings' worth of city, not Dubai filed
       under the region "Hong Kong". Hong Kong and Singapore are both a country name AND a real
       city on the board, so REGION_CANON alone cannot tell this case from "New York, NY". */
    const withCityStates = new Set([...known, 'hongkong', 'singapore', 'dubai'].map(fold));
    assert.deepEqual(parsePlace('Dubai, Hong Kong', withCityStates).map((p) => p.city),
      ['Dubai', 'Hong Kong']);
    assert.deepEqual(parsePlace('London, Singapore', withCityStates).map((p) => p.city),
      ['London', 'Singapore']);
  });
});

describe('rankCities', () => {
  test('merges every spelling of one city onto one entry', () => {
    /* The London case, verbatim from production: four spellings, 298 postings,
       four of the fifty slots. */
    const ranked = rankCities([
      { location: 'London', n: 111 },
      { location: 'London, United Kingdom', n: 81 },
      { location: 'London, UK', n: 67 },
      { location: 'London, England', n: 39 },
      { location: 'Paris, France', n: 5 },
    ], 10);
    assert.deepEqual(ranked, ['London, UK', 'Paris, France']);
  });

  test('folds a bare city into its regioned form when there is only one', () => {
    const ranked = rankCities([
      { location: 'Austin, TX', n: 107 },
      { location: 'Austin', n: 15 },
    ], 10);
    assert.deepEqual(ranked, ['Austin, TX']);
  });

  test('NEVER merges two different cities that share a name', () => {
    /* Vancouver WA and Vancouver BC are different places. The bare "Vancouver"
       stays bare because merging it would mean choosing one of them. */
    const ranked = rankCities([
      { location: 'Vancouver, WA', n: 28 },
      { location: 'Vancouver, BC', n: 27 },
      { location: 'Vancouver, British Columbia', n: 23 },
      { location: 'Vancouver', n: 16 },
    ], 10);
    assert.ok(ranked.includes('Vancouver, WA'), 'Vancouver WA must survive');
    assert.ok(ranked.includes('Vancouver, BC'), 'Vancouver BC must survive');
    assert.ok(ranked.includes('Vancouver'), 'the ambiguous bare form must stay bare');
    assert.equal(ranked.filter((c) => c.startsWith('Vancouver')).length, 3);
  });

  test('the Bengaluru case: alias and region variants collapse to one', () => {
    const ranked = rankCities([
      { location: 'Bengaluru, India', n: 130 },
      { location: 'Bengaluru', n: 46 },
      { location: 'Bengaluru, Karnataka', n: 23 },
      { location: 'Bangalore, India', n: 36 },
      { location: 'Bangalore', n: 11 },
    ], 10);
    assert.deepEqual(ranked, ['Bengaluru, India']);
  });

  test('joins variants that agree about the country, keeping the specific one', () => {
    /* "Toronto, Canada" and "Toronto, ON" are one place written two ways. */
    const ranked = rankCities([
      { location: 'Toronto, Canada', n: 38 },
      { location: 'Toronto, Ontario', n: 26 },
      { location: 'Toronto, ON', n: 24 },
      { location: 'Toronto', n: 16 },
    ], 10);
    assert.deepEqual(ranked, ['Toronto, ON']);
  });

  test('folds a bare city into a clear majority, but not into a close call', () => {
    /* Amsterdam is Noord-Holland 42 times and New Hampshire 4: spending two
       slots on that helps nobody. Vancouver is 28 / 50 and must stay split. */
    const amsterdam = rankCities([
      { location: 'Amsterdam, Netherlands', n: 42 },
      { location: 'Amsterdam, NH', n: 4 },
      { location: 'Amsterdam', n: 58 },
    ], 10);
    assert.equal(amsterdam[0], 'Amsterdam, Netherlands');
    assert.ok(!amsterdam.includes('Amsterdam'), 'the bare form should have folded');
  });

  test('counts a second city named after the comma', () => {
    const ranked = rankCities([
      { location: 'San Francisco, CA', n: 50 },
      { location: 'Seattle, WA', n: 40 },
      { location: 'San Francisco, Seattle', n: 6 },
    ], 10);
    assert.deepEqual(ranked, ['San Francisco, CA', 'Seattle, WA']);
  });

  test('honours the limit and keeps the non-cities out', () => {
    const ranked = rankCities([
      { location: 'United States', n: 999 },
      { location: 'Remote', n: 998 },
      { location: 'EMEA', n: 997 },
      { location: 'Paris, France', n: 3 },
      { location: null, n: 500 },
    ], 50);
    assert.deepEqual(ranked, ['Paris, France']);
  });
});
