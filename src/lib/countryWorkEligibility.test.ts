import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conservativeLegacyUsRecord,
  countryEligibilityForRead,
  countryWorkEligibilityListSchema,
  legacyUsProjection,
  namedCountryCode,
  type CountryWorkEligibility,
} from './workEligibility';
import { postingCountryCodeFromJobContext } from './jobLocation';
import { resolveKnownAnswer, type ApplicationProfileLike } from './questionDiscovery';

const records: CountryWorkEligibility[] = [
  {
    country_code: 'US',
    authorized_now: true,
    needs_sponsorship_now: false,
    needs_sponsorship_future: true,
    authorization_type: 'F-1 CPT',
    authorization_expiry: '2028-05-12',
  },
  {
    country_code: 'AE',
    authorized_now: true,
    needs_sponsorship_now: false,
    needs_sponsorship_future: false,
  },
  {
    country_code: 'GB',
    authorized_now: false,
    needs_sponsorship_now: true,
    needs_sponsorship_future: true,
  },
];

const profile: ApplicationProfileLike = { work_eligibility_by_country: records };

describe('country work eligibility contract', () => {
  test('accepts complete records and rejects duplicate country codes', () => {
    assert.equal(countryWorkEligibilityListSchema.safeParse(records).success, true);
    assert.equal(countryWorkEligibilityListSchema.safeParse([records[0], records[0]]).success, false);
    assert.equal(countryWorkEligibilityListSchema.safeParse([{ country_code: 'USA' }]).success, false);
  });

  test('projects only the US row into the two compatibility booleans', () => {
    assert.deepEqual(legacyUsProjection(records), {
      work_authorized: true,
      needs_sponsorship: true,
    });
    assert.deepEqual(legacyUsProjection(records.filter((row) => row.country_code !== 'US')), {
      work_authorized: null,
      needs_sponsorship: null,
    });
  });

  test('migrates old US answers only when present and future meaning is recoverable', () => {
    assert.deepEqual(conservativeLegacyUsRecord({ work_authorized: true, needs_sponsorship: false }), {
      country_code: 'US',
      authorized_now: true,
      needs_sponsorship_now: false,
      needs_sponsorship_future: false,
    });
    assert.deepEqual(conservativeLegacyUsRecord({
      work_authorized: true,
      needs_sponsorship: true,
      sponsorship_answer: 'needs_future',
    }), {
      country_code: 'US',
      authorized_now: true,
      needs_sponsorship_now: false,
      needs_sponsorship_future: true,
    });
    assert.equal(conservativeLegacyUsRecord({ work_authorized: true, needs_sponsorship: true }), undefined);
    assert.equal(conservativeLegacyUsRecord({
      work_authorized: false,
      needs_sponsorship: true,
      sponsorship_answer: 'not_authorized',
    }), undefined);
    assert.equal(countryEligibilityForRead({ stored: null, work_authorized: false, needs_sponsorship: true }), undefined);
  });

  test('country names resolve to one ISO code and multi-country labels stay ambiguous', () => {
    assert.equal(namedCountryCode('Are you authorized to work in the United Arab Emirates?'), 'AE');
    assert.equal(namedCountryCode('May you work in the UK or Ireland?'), undefined);
    assert.equal(namedCountryCode('Do you need sponsorship?'), undefined);
  });
});

describe('exact-country resolver', () => {
  test('answers authorization and present or future sponsorship from the selected country only', () => {
    assert.deepEqual(
      resolveKnownAnswer('Are you authorized to work in the United Arab Emirates?', 'select', profile, undefined),
      { value: 'Yes' },
    );
    assert.deepEqual(
      resolveKnownAnswer('Do you currently need sponsorship to work in the United States?', 'select', profile, undefined),
      { value: 'No' },
    );
    assert.deepEqual(
      resolveKnownAnswer('Will you need sponsorship in the future to work in the United States?', 'select', profile, undefined),
      { value: 'Yes' },
    );
    assert.deepEqual(
      resolveKnownAnswer('Are you authorized to work in the United Kingdom?', 'select', profile, undefined),
      { value: 'No' },
    );
  });

  test('answers optional authorization detail only under the exact same scope', () => {
    assert.deepEqual(
      resolveKnownAnswer('What is your current immigration status in the United States?', 'text', profile, undefined),
      { value: 'F-1 CPT' },
    );
    assert.deepEqual(
      resolveKnownAnswer('When does your work authorization expire in the United States?', 'date', profile, undefined),
      { value: '2028-05-12' },
    );
    const held = resolveKnownAnswer('What is your current immigration status?', 'text', profile, undefined);
    assert.ok(held && 'skipReason' in held);
  });

  test('uses one structured role country for an unscoped label and refuses ambiguous roles', () => {
    const ukCode = postingCountryCodeFromJobContext({ location: 'London, United Kingdom' });
    assert.equal(ukCode, 'GB');
    assert.deepEqual(
      resolveKnownAnswer('Will you require sponsorship?', 'select', profile, undefined, 'non_us', ukCode),
      { value: 'Yes' },
    );
    assert.equal(postingCountryCodeFromJobContext({ locations: ['London, UK', 'New York, NY'] }), undefined);
    const held = resolveKnownAnswer('Will you require sponsorship?', 'select', profile, undefined, 'non_us', undefined);
    assert.ok(held && 'skipReason' in held);
  });

  test('never falls back from a missing non-US row to the US record', () => {
    const held = resolveKnownAnswer(
      'Are you authorized to work in Canada?',
      'select',
      { work_eligibility_by_country: records.filter((row) => row.country_code !== 'CA') },
      undefined,
    );
    assert.ok(held && 'skipReason' in held);
  });
});

