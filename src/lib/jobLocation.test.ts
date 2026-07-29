import assert from 'node:assert/strict';
import test from 'node:test';
import { employerEvidenceApplies, jobCountry } from './jobLocation';

/**
 * An H-1B is a US work visa, so an employer's H-1B record is evidence about US roles and nothing
 * else. Every location below is real text from the live board on 2026-07-29, where 3,336 of the
 * 9,552 postings the sponsor filter surfaced turned out to be abroad.
 */

test('unmistakably US locations, in the shapes the boards actually use', () => {
  for (const location of [
    'San Francisco, CA',
    'New York, New York, United States',
    'Remote, California, United States, AMER',
    'Austin, TX',
    'Starbase, TX',
    'Hawthorne, CA',
    'Remote - US',
    'United States',
    'Seattle, Washington',
    'Culver City',
    'Greenwich, CT',
    'Boston',
  ]) {
    assert.equal(jobCountry(location), 'us', location);
    assert.equal(employerEvidenceApplies(location), true, location);
  }
});

test('unmistakably foreign locations, which an H-1B says nothing about', () => {
  for (const location of [
    'Bengaluru, India',
    'Singapore',
    'Tokyo, Japan',
    'London',
    'London, United Kingdom',
    'Dublin',
    'Paris, France',
    'Amsterdam',
    'Sydney, Australia',
    'Toronto, Canada',
    'Remote (EMEA)',
    'Gurugram',
  ]) {
    assert.equal(jobCountry(location), 'non_us', location);
    assert.equal(employerEvidenceApplies(location), false, location);
  }
});

test('a location that says nothing is surfaced, not hidden', () => {
  /* A bare "Remote" at a company whose entire filing history is American is not evidence of a
     foreign role. Hiding it would cost a job seeker real US openings to avoid a hypothetical. */
  for (const location of ['Remote', 'Anywhere', 'Flexible', '', null, undefined]) {
    assert.equal(jobCountry(location), 'unknown', String(location));
    assert.equal(employerEvidenceApplies(location), true, String(location));
  }
});

test('US WINS A TIE, because an American hire can take the role', () => {
  assert.equal(jobCountry('Remote - US or London'), 'us');
  assert.equal(jobCountry('New York / Dublin'), 'us');
  assert.equal(jobCountry('San Francisco, CA; London, UK'), 'us');
});

test('a foreign city is not turned American by a state abbreviation inside a word', () => {
  // "ORLANDO" contains "OR", "INDIA" contains "IN", "PARIS" contains "PA". Word boundaries only.
  assert.equal(jobCountry('India'), 'non_us');
  assert.equal(jobCountry('Paris'), 'non_us');
  assert.equal(jobCountry('Mindanao'), 'unknown');
});

test('accents do not hide a foreign city', () => {
  // Both were surfaced as "unknown" until the folding went in: "São Paulo" normalised to "S O PAULO".
  assert.equal(jobCountry('São Paulo'), 'non_us');
  assert.equal(jobCountry('Reykjavík'), 'non_us');
  assert.equal(jobCountry('Zürich'), 'non_us');
});

test('the ambiguous city names are left alone rather than guessed', () => {
  /* Cambridge, Birmingham and Portland exist on both sides of the Atlantic. Claiming them would
     turn a British role into an American one, and 'unknown' is a perfectly good answer. */
  assert.equal(jobCountry('Cambridge'), 'unknown');
  assert.equal(jobCountry('Birmingham'), 'unknown');
  // ...but with a state beside it there is no ambiguity left.
  assert.equal(jobCountry('Cambridge, MA'), 'us');
});
