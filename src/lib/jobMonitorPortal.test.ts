import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAshbyJobs, normalizeGreenhouseJobs, normalizeLeverJobs } from './jobMonitor';
import { countryFromPortal, resolveJobCountry } from './jobLocation';
import { portalNameAgrees } from './sponsorIdentity';

/**
 * WHAT THE PORTAL PUBLISHES, READ RATHER THAN INFERRED.
 *
 * Every payload below is the real shape the board returns, trimmed. The point of these tests is
 * that the poller carries the portal's own answer through to the columns the board filter reads -
 * an earlier version of this change extracted the fields correctly and then failed to persist
 * them, which no test noticed because nothing asserted on the whole path.
 */

test('Greenhouse: the company names itself on every posting', () => {
  const jobs = normalizeGreenhouseJobs({
    jobs: [{
      id: 1,
      title: 'Lead Security Technician',
      absolute_url: 'https://job-boards.greenhouse.io/sas/jobs/1',
      content: 'Install and service commercial alarm systems.',
      location: { name: 'Canoga Park, CA' },
      company_name: 'Superior Alarm Systems',
      offices: [{ name: 'Superior Alarm Systems', location: 'Canoga Park, California, United States' }],
    }],
  });
  assert.equal(jobs[0].portal_company_name, 'Superior Alarm Systems');
  // And that is enough to know the board is not the company our token suggested.
  assert.equal(portalNameAgrees('sas', jobs[0].portal_company_name), false);
});

test('Greenhouse: an office NAME is not a country, but its address is', () => {
  /* The trap this file exists for. Stripe's office groups are "US" and "India Locations", which
     look like a country field - but Superior Alarm Systems names its office after itself, and
     reading names as countries would have made "Superior Alarm Systems" a country. Only the
     address is used. */
  const named = normalizeGreenhouseJobs({
    jobs: [{
      id: 2,
      title: 'Engineer',
      absolute_url: 'https://job-boards.greenhouse.io/x/jobs/2',
      content: 'Build things.',
      location: { name: 'Bengaluru' },
      offices: [{ name: 'India Locations', location: null }],
    }],
  });
  assert.equal(named[0].portal_country, undefined, 'a name is never taken as a country');
  // With no portal answer, the location string decides - which is what that fallback is for.
  assert.equal(resolveJobCountry(named[0].portal_country, named[0].location), 'non_us');

  const addressed = normalizeGreenhouseJobs({
    jobs: [{
      id: 3,
      title: 'Technician',
      absolute_url: 'https://job-boards.greenhouse.io/x/jobs/3',
      content: 'Service alarms.',
      location: { name: 'Canoga Park, CA' },
      offices: [{ name: 'Superior Alarm Systems', location: 'Canoga Park, California, United States' }],
    }],
  });
  assert.equal(addressed[0].portal_country, 'Canoga Park, California, United States');
  assert.equal(countryFromPortal(addressed[0].portal_country), 'us');
});

test('Lever: an ISO country code, which cannot collide with a state', () => {
  const jobs = normalizeLeverJobs([{
    id: 'abc',
    text: 'Administrative Assistant',
    hostedUrl: 'https://jobs.lever.co/palantir/abc',
    applyUrl: 'https://jobs.lever.co/palantir/abc/apply',
    descriptionPlain: 'Support the London office.',
    categories: { location: 'London, United Kingdom', commitment: 'Full-time' },
    country: 'GB',
  }]);
  assert.equal(jobs[0].portal_country, 'GB');
  assert.equal(resolveJobCountry(jobs[0].portal_country, jobs[0].location), 'non_us');
});

test('Ashby: a postal address with the country spelled out', () => {
  const jobs = normalizeAshbyJobs({
    jobs: [{
      id: 'x1',
      title: 'Product Manager',
      jobUrl: 'https://jobs.ashbyhq.com/notion/x1',
      applyUrl: 'https://jobs.ashbyhq.com/notion/x1/application',
      descriptionPlain: 'Own the roadmap.',
      location: 'New York, New York',
      address: { postalAddress: { addressCountry: 'United States', addressRegion: 'New York' } },
    }],
  });
  assert.equal(jobs[0].portal_country, 'United States');
  assert.equal(resolveJobCountry(jobs[0].portal_country, jobs[0].location), 'us');
});

test('the portal beats the string on every location that was misread', () => {
  /* Each of these was a live bug: the left value is what the portal published, the right is the
     string that fooled the parser. */
  assert.equal(resolveJobCountry('IN', 'IN - Bengaluru'), 'non_us');
  assert.equal(resolveJobCountry('NL', 'Amsterdam, NH'), 'non_us');
  assert.equal(resolveJobCountry('GB', 'Oxford or  London-United Kingdom'), 'non_us');
  assert.equal(resolveJobCountry('Georgia', 'Georgia'), 'non_us', 'the country field means the country');
  assert.equal(resolveJobCountry('United States', 'Georgia'), 'us');
});

test('a portal that publishes nothing leaves the parser in charge', () => {
  assert.equal(resolveJobCountry(undefined, 'Austin, TX'), 'us');
  assert.equal(resolveJobCountry(undefined, 'Bengaluru, India'), 'non_us');
  assert.equal(resolveJobCountry(undefined, 'Remote'), 'unknown');
});
