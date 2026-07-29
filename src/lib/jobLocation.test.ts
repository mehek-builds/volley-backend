import assert from 'node:assert/strict';
import test from 'node:test';
import { countryFromPortal, employerEvidenceApplies, jobCountry, resolveJobCountry } from './jobLocation';

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

test('the shorthands the boards actually use for US locations', () => {
  assert.equal(jobCountry('Remote U.S.'), 'us');
  assert.equal(jobCountry('Remote - FL'), 'us');
  assert.equal(jobCountry('Remote - TX'), 'us');
  assert.equal(jobCountry('SF'), 'us');
  // ...and the trailing-code rule still cannot rescue a foreign city, because the foreign check
  // runs first.
  assert.equal(jobCountry('Amsterdam, NH'), 'non_us');
  assert.equal(jobCountry('Witten, NW'), 'unknown', 'NW is not a US state code');
});

test('a location that says nothing is surfaced, not hidden', () => {
  /* A bare "Remote" at a company whose entire filing history is American is not evidence of a
     foreign role. Hiding it would cost a job seeker real US openings to avoid a hypothetical. */
  for (const location of ['Remote', 'Anywhere', 'Flexible', '', null, undefined]) {
    assert.equal(jobCountry(location), 'unknown', String(location));
    assert.equal(employerEvidenceApplies(location), true, String(location));
  }
});

test('US WINS A GENUINE TIE, because an American hire can take the role', () => {
  // These say "US" or "New York" outright: strong signals, not a two-letter code.
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

test('REAL strings from the live board that a two-letter code got wrong', () => {
  /* Every one of these was surfaced to somebody who needs US sponsorship, because a US state code
     collided with a country code, a province, or an English word. */
  assert.equal(jobCountry('IN - Bengaluru'), 'non_us', 'IN is India here, not Indiana');
  assert.equal(jobCountry('IN-Bengaluru'), 'non_us');
  assert.equal(jobCountry('Oxford or  London-United Kingdom'), 'non_us', '"or" is not Oregon');
  assert.equal(jobCountry('Dublin OR London'), 'non_us');
  assert.equal(jobCountry('Amsterdam, NH'), 'non_us', 'NH is Noord-Holland here, not New Hampshire');
  assert.equal(jobCountry('DE - Berlin'), 'non_us', 'DE is Germany here, not Delaware');
});

test('Georgia the country is not Georgia the state', () => {
  // Real string from the live board, and the last posting that slipped through: the country,
  // listed beside two other European ones.
  assert.equal(
    jobCountry('Belgrade, Belgrade, Serbia; Berlin, Berlin, Germany; Georgia'),
    'non_us',
  );
  // The US sense still reads as US, from the city, the code, or the country beside it.
  assert.equal(jobCountry('Atlanta, Georgia'), 'us');
  assert.equal(jobCountry('Savannah, GA'), 'us');
  assert.equal(jobCountry('Georgia, United States'), 'us');
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

test('the portal is believed over the location string', () => {
  /* THE FIX FOR THE WHOLE CLASS OF BUG. Every one of these strings was misread by the parser, and
     every one of these postings carried the right answer in a structured field the whole time. */
  assert.equal(resolveJobCountry('IN', 'IN - Bengaluru'), 'non_us', 'Lever ISO code');
  assert.equal(resolveJobCountry('India Locations', 'Bengaluru'), 'non_us', 'Greenhouse office group');
  assert.equal(resolveJobCountry('Netherlands', 'Amsterdam, NH'), 'non_us', 'Ashby postal address');
  assert.equal(resolveJobCountry('GB', 'Oxford or  London-United Kingdom'), 'non_us');
  assert.equal(resolveJobCountry('United States', 'Georgia'), 'us');
  assert.equal(resolveJobCountry('US', 'Anywhere'), 'us');
});

test('a Greenhouse office list that includes the US is a US role', () => {
  // A posting filed under both is one an American hire can take.
  assert.equal(countryFromPortal('US | Bay Area'), 'us');
  assert.equal(countryFromPortal('India Locations'), 'non_us');
  assert.equal(countryFromPortal('EMEA'), 'non_us');
});

test('a two-letter code IS safe in a country field, unlike in a location string', () => {
  // "IN" in a country field can only be India. In a location string it was Indiana, which is the
  // bug this whole path exists to remove.
  assert.equal(countryFromPortal('IN'), 'non_us');
  assert.equal(countryFromPortal('DE'), 'non_us');
  assert.equal(countryFromPortal('US'), 'us');
  assert.equal(jobCountry('IN - Bengaluru'), 'non_us', 'the parser still has to cope alone');
});

test('an unrecognised portal country defers to the parser rather than guessing', () => {
  assert.equal(countryFromPortal('Mars Office'), null);
  assert.equal(resolveJobCountry('Mars Office', 'Austin, TX'), 'us');
  assert.equal(resolveJobCountry(null, 'Austin, TX'), 'us');
  assert.equal(resolveJobCountry('', 'Bengaluru, India'), 'non_us');
});
