import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  conservativeLegacyUsRecord,
  countryEligibilityForRead,
  countryWorkEligibilityListSchema,
  normalizeCountryWorkEligibility,
  legacyUsProjection,
  namedCountryCode,
  ISO_COUNTRY_CODES,
  type CountryWorkEligibility,
} from './workEligibility';
import {
  jobCountry,
  portalRegionMembershipsForCountryCode,
  postingCountryCodeFromJobContext,
  postingCountryFromJobContext,
} from './jobLocation';
import { resolveKnownAnswer, type ApplicationProfileLike } from './questionDiscovery';
import { resolveProfileField } from './profileFieldResolution';

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
    assert.equal(countryWorkEligibilityListSchema.safeParse([{
      country_code: 'US',
      authorized_now: false,
      needs_sponsorship_now: false,
      needs_sponsorship_future: true,
    }]).success, false);
    assert.equal(countryWorkEligibilityListSchema.safeParse([{
      ...records[0], authorization_expiry: '2026-02-30',
    }]).success, false);
    assert.equal(countryWorkEligibilityListSchema.safeParse([{
      ...records[0], authorization_expiry: '2020-01-01',
    }]).success, false);
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
      work_authorized: true,
      needs_sponsorship: false,
      sponsorship_answer: 'needs_future',
    }), undefined);
    assert.equal(conservativeLegacyUsRecord({
      work_authorized: true,
      needs_sponsorship: false,
      sponsorship_answer: 'needs_now',
    }), undefined);
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

  test('mixed structured country evidence never selects either scoped declaration', () => {
    for (const jobContext of [
      { locations: ['London', 'New York, NY'] },
      { location: 'London / New York, NY' },
      { location: 'London office supporting US customers' },
    ]) {
      assert.equal(postingCountryFromJobContext(jobContext), 'unknown');
      assert.equal(postingCountryCodeFromJobContext(jobContext), undefined);
      const held = resolveKnownAnswer(
        'Are you authorized to work in the country where this role is located?',
        'select',
        profile,
        undefined,
        postingCountryFromJobContext(jobContext),
        postingCountryCodeFromJobContext(jobContext),
      );
      assert.ok(held && 'skipReason' in held);
    }
  });

  test('explicit jurisdictions override city aliases and contradictions fail closed', () => {
    const scopedProfile: ApplicationProfileLike = {
      work_eligibility_by_country: [
        records[0],
        records[2],
        {
          country_code: 'CA',
          authorized_now: false,
          needs_sponsorship_now: true,
          needs_sponsorship_future: true,
        },
      ],
    };
    const cases: Array<[string, string, 'Yes' | 'No']> = [
      ['Paris TX', 'US', 'Yes'],
      ['Berlin, NJ', 'US', 'Yes'],
      ['Athens GA', 'US', 'Yes'],
      ['Dublin, CA', 'US', 'Yes'],
      ['Vienna VA', 'US', 'Yes'],
      ['Geneva, NY', 'US', 'Yes'],
      ['London ON', 'CA', 'No'],
      ['London, Ontario', 'CA', 'No'],
      ['London, Canada', 'CA', 'No'],
      ['London, ON, Canada', 'CA', 'No'],
      ['Paris, TX, United States', 'US', 'Yes'],
      ['Remote, United States', 'US', 'Yes'],
      ['Remote, Canada', 'CA', 'No'],
      ['United States - Remote', 'US', 'Yes'],
      ['United States, Remote', 'US', 'Yes'],
      ['US Remote', 'US', 'Yes'],
      ['Remote (United States)', 'US', 'Yes'],
      ['Canada - Remote', 'CA', 'No'],
      ['Remote Canada', 'CA', 'No'],
      ['United Kingdom - Remote', 'GB', 'No'],
      ['Remote United Kingdom', 'GB', 'No'],
      ['London', 'GB', 'No'],
      ['TX, United States', 'US', 'Yes'],
      ['Texas, United States', 'US', 'Yes'],
      ['ON, Canada', 'CA', 'No'],
      ['Ontario, Canada', 'CA', 'No'],
      ['London, England', 'GB', 'No'],
      ['Paris, France', 'FR', 'No'],
    ];
    for (const [location, code, answer] of cases) {
      const context = { location };
      assert.equal(postingCountryCodeFromJobContext(context), code, location);
      assert.equal(postingCountryFromJobContext(context), code === 'US' ? 'us' : 'non_us', location);
      if (['US', 'GB', 'CA'].includes(code)) {
        assert.deepEqual(resolveKnownAnswer(
          'Are you authorized to work in the country where this role is located?',
          'select',
          scopedProfile,
          undefined,
          postingCountryFromJobContext(context),
          postingCountryCodeFromJobContext(context),
        ), { value: answer }, location);
      }
    }

    for (const context of [
      { location: 'Paris, TX, France' },
      { location: 'London ON, England' },
      { location: 'London office supporting US customers' },
      { location: 'Paris office supporting US customers' },
      { location: 'London, UK, supporting US customers' },
      { location: 'London office serving US clients' },
      { location: 'Paris team aligned to Texas business hours' },
      { location: 'Berlin support for New York customers' },
      { location: 'London • US customers' },
      { location: 'London, UK, US time zone' },
      { location: 'Sales territory, United States' },
      { location: 'Reports to Manager, Canada' },
      { location: 'Coverage Department, United Kingdom' },
      { location: 'Employer HQ, US' },
      { location: 'Springfield, United States' },
      { location: 'Unknownville TX' },
      { portal_country: 'GB', location: 'Paris, TX' },
      { portal_country: 'US', location: 'London, England' },
    ]) {
      assert.equal(postingCountryCodeFromJobContext(context), undefined, JSON.stringify(context));
      assert.equal(postingCountryFromJobContext(context), 'unknown', JSON.stringify(context));
    }
    assert.equal(postingCountryCodeFromJobContext({ portal_country: 'US', location: 'Paris, TX' }), 'US');
    assert.equal(postingCountryCodeFromJobContext({ portal_country: 'GB', location: 'London, England' }), 'GB');
    assert.equal(postingCountryCodeFromJobContext({ portal_country: 'US', location: 'Springfield' }), 'US');
  });

  test('ATS office-group country labels provide exact codes and conflicts still fail closed', () => {
    const consistent: Array<[Record<string, unknown>, string]> = [
      [{ portal_country: 'United States Locations', location: 'New York, NY' }, 'US'],
      [{ portal_country: 'India Locations', location: 'Mumbai' }, 'IN'],
      [{ portal_country: 'Canada Offices', location: 'Toronto' }, 'CA'],
      [{ portal_country: 'United Kingdom Office', location: 'London' }, 'GB'],
      [{ portal_country: 'United-States (Locations)', location: 'Boston' }, 'US'],
      [{ portal_country: 'India | Recruiting', location: 'Bengaluru' }, 'IN'],
    ];
    for (const [context, code] of consistent) {
      assert.equal(postingCountryCodeFromJobContext(context), code, JSON.stringify(context));
      assert.equal(postingCountryFromJobContext(context), code === 'US' ? 'us' : 'non_us', JSON.stringify(context));
      if (code === 'US' || code === 'GB') {
        assert.deepEqual(resolveKnownAnswer(
          'Are you authorized to work in the country where this role is located?',
          'select',
          profile,
          undefined,
          postingCountryFromJobContext(context),
          postingCountryCodeFromJobContext(context),
        ), { value: code === 'US' ? 'Yes' : 'No' }, JSON.stringify(context));
      }
    }

    for (const context of [
      { portal_country: 'United States Locations', location: 'London' },
      { portal_country: 'India Locations', location: 'New York, NY' },
      { portal_country: 'Canada Offices', location: 'London' },
      { portal_country: 'United Kingdom Locations', location: 'New York, NY' },
      { portal_country: 'United States Locations', locations: ['London', 'New York, NY'] },
    ]) {
      assert.equal(postingCountryCodeFromJobContext(context), undefined, JSON.stringify(context));
      assert.equal(postingCountryFromJobContext(context), 'unknown', JSON.stringify(context));
      const held = resolveKnownAnswer(
        'Are you authorized to work in the country where this role is located?',
        'select',
        profile,
        undefined,
        postingCountryFromJobContext(context),
        postingCountryCodeFromJobContext(context),
      );
      assert.ok(held && 'skipReason' in held, JSON.stringify(context));
    }
  });

  test('broad ATS regions preserve scope without inventing an exact country', () => {
    for (const context of [
      { portal_country: 'EMEA', location: 'New York, NY' },
      { portal_country: 'APAC', location: 'San Francisco, CA' },
      { portal_country: 'LATAM', location: 'Boston' },
      { portal_country: 'United States Recruiting', location: 'London' },
      { portal_country: 'EMEA', location: 'Toronto' },
      { portal_country: 'APAC', location: 'London' },
      { portal_country: 'LATAM', location: 'Mumbai' },
      { portal_country: 'EMEA | Canada', location: 'Toronto' },
      { portal_country: 'APAC, EMEA', location: 'London' },
      { portal_country: 'United States / Canada', location: 'Toronto' },
    ]) {
      assert.equal(postingCountryFromJobContext(context), 'unknown', JSON.stringify(context));
      assert.equal(postingCountryCodeFromJobContext(context), undefined, JSON.stringify(context));
      const held = resolveKnownAnswer(
        'Are you authorized to work in the country where this role is located?',
        'select',
        profile,
        undefined,
        postingCountryFromJobContext(context),
        postingCountryCodeFromJobContext(context),
      );
      assert.ok(held && 'skipReason' in held, JSON.stringify(context));
    }

    const consistent = { portal_country: 'EMEA', location: 'London' };
    assert.equal(postingCountryFromJobContext(consistent), 'non_us');
    assert.equal(postingCountryCodeFromJobContext(consistent), 'GB');
    assert.deepEqual(resolveKnownAnswer(
      'Are you authorized to work in the country where this role is located?',
      'select',
      profile,
      undefined,
      postingCountryFromJobContext(consistent),
      postingCountryCodeFromJobContext(consistent),
    ), { value: 'No' });

    const broadOnly = { portal_country: 'EMEA' };
    assert.equal(postingCountryFromJobContext(broadOnly), 'non_us');
    assert.equal(postingCountryCodeFromJobContext(broadOnly), undefined);
    const held = resolveKnownAnswer(
      'Are you authorized to work in the country where this role is located?',
      'select',
      profile,
      undefined,
      postingCountryFromJobContext(broadOnly),
      postingCountryCodeFromJobContext(broadOnly),
    );
    assert.ok(held && 'skipReason' in held);

    const broadUsOnly = { portal_country: 'United States Recruiting' };
    assert.equal(postingCountryFromJobContext(broadUsOnly), 'us');
    assert.equal(postingCountryCodeFromJobContext(broadUsOnly), undefined);
    assert.deepEqual(resolveKnownAnswer(
      'Are you authorized to work in the country where this role is located?',
      'select',
      profile,
      undefined,
      postingCountryFromJobContext(broadUsOnly),
      postingCountryCodeFromJobContext(broadUsOnly),
    ), { value: 'Yes' });

    for (const [context, code] of [
      [{ portal_country: 'EMEA | United Kingdom', location: 'London' }, 'GB'],
      [{ portal_country: 'APAC / India', location: 'Mumbai' }, 'IN'],
      [{ portal_country: 'LATAM; Brazil', location: 'Sao Paulo' }, 'BR'],
      [{ portal_country: 'EMEA and GB', location: 'London' }, 'GB'],
    ] as const) {
      assert.equal(postingCountryFromJobContext(context), 'non_us', JSON.stringify(context));
      assert.equal(postingCountryCodeFromJobContext(context), code, JSON.stringify(context));
    }
  });

  test('portal list separators and ISO region membership are closed and exhaustive', () => {
    for (const separator of ['|', ',', '/', ';', '\n', '•', ' and ', ' or ', '&', '+']) {
      const context = { portal_country: `EMEA${separator}US`, location: 'London' };
      assert.equal(postingCountryFromJobContext(context), 'unknown', separator);
      assert.equal(postingCountryCodeFromJobContext(context), undefined, separator);
    }
    for (const portal_country of [
      'EMEA & US',
      'EMEA&APAC',
      'APAC & United States',
      'LATAM & USA',
      'EMEA + US',
      'EMEA+APAC',
    ]) {
      const context = { portal_country, location: 'London' };
      assert.equal(postingCountryFromJobContext(context), 'unknown', portal_country);
      assert.equal(postingCountryCodeFromJobContext(context), undefined, portal_country);
    }

    for (const code of ISO_COUNTRY_CODES) {
      assert.equal(portalRegionMembershipsForCountryCode(code).length, 1, code);
    }
    assert.deepEqual(portalRegionMembershipsForCountryCode('KG'), ['APAC']);
    assert.deepEqual(portalRegionMembershipsForCountryCode('CA'), ['UNSCOPED']);
    assert.equal(postingCountryCodeFromJobContext({ portal_country: 'APAC & KG' }), 'KG');
  });

  test('structured ATS country metadata reaches the exact country resolver', () => {
    const jobContext = { portal_country: 'GB', location: 'London' };
    assert.equal(postingCountryFromJobContext(jobContext), 'non_us');
    assert.equal(postingCountryCodeFromJobContext(jobContext), 'GB');
    assert.deepEqual(
      resolveKnownAnswer(
        'Are you authorized to work in the country where this role is located?',
        'select',
        profile,
        undefined,
        postingCountryFromJobContext(jobContext),
        postingCountryCodeFromJobContext(jobContext),
      ),
      { value: 'No' },
    );
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

  test('malformed, duplicate, and expired scoped data never falls through to legacy US values', () => {
    for (const work_eligibility_by_country of [
      [{ country_code: 'US', authorized_now: true }],
      [records[0], records[0]],
      [{ ...records[0], authorization_expiry: '2020-01-01' }],
    ]) {
      const held = resolveKnownAnswer(
        'Are you authorized to work in the United States?',
        'select',
        { work_eligibility_by_country, work_authorized: true, needs_sponsorship: false } as ApplicationProfileLike,
        undefined,
      );
      assert.ok(held && 'skipReason' in held);
    }
  });

  test('one expired country is disabled while another valid country remains usable', () => {
    const aged = [
      { ...records[0], authorization_expiry: '2020-01-01' },
      records[1],
    ];
    assert.deepEqual(normalizeCountryWorkEligibility(aged), [records[1]]);
    const scopedProfile = { work_eligibility_by_country: aged } as ApplicationProfileLike;
    assert.deepEqual(
      resolveKnownAnswer('Are you authorized to work in the United Arab Emirates?', 'select', scopedProfile, undefined),
      { value: 'Yes' },
    );
    const held = resolveKnownAnswer(
      'Are you authorized to work in the United States?', 'select', scopedProfile, undefined,
    );
    assert.ok(held && 'skipReason' in held);
  });

  test('now is current-only while now or future uses both stored answers', () => {
    const current = resolveKnownAnswer(
      'Will you need sponsorship now to work in the United States?', 'select', profile, undefined,
    );
    assert.deepEqual(current, { value: 'No' });
    const combined = resolveKnownAnswer(
      'Will you now or in the future need sponsorship to work in the United States?', 'select', profile, undefined,
    );
    assert.deepEqual(combined, { value: 'Yes' });
  });

  test('US state codes and US cities never become foreign ISO countries', () => {
    assert.equal(postingCountryCodeFromJobContext({ location: 'San Francisco, CA' }), 'US');
    assert.equal(postingCountryCodeFromJobContext({ location: 'Bloomington, IN' }), 'US');
    assert.equal(postingCountryCodeFromJobContext({ location: 'Melbourne, FL' }), 'US');
    assert.equal(postingCountryCodeFromJobContext({ location: 'CA' }), undefined);
    assert.equal(postingCountryCodeFromJobContext({ location: 'IN' }), undefined);
    assert.equal(postingCountryCodeFromJobContext({ portal_country: 'CA' }), 'CA');
    assert.equal(postingCountryCodeFromJobContext({ country: 'IN' }), 'IN');
    assert.equal(postingCountryCodeFromJobContext({ location: 'Melbourne' }), undefined);
    assert.equal(jobCountry('Melbourne, FL'), 'us');
  });

  test('direct profile resolution receives the exact posting country', () => {
    assert.deepEqual(resolveProfileField(
      { label: 'Will you require sponsorship?', inputType: 'select', options: ['Yes', 'No'] },
      profile,
      undefined,
      'non_us',
      'GB',
    ), {
      key: null,
      value: 'Yes',
      candidates: ['Yes'],
      matchedOption: true,
    });
    assert.equal(resolveProfileField(
      { label: 'Will you require sponsorship?', inputType: 'select', options: ['Yes', 'No'] },
      profile,
      undefined,
      'non_us',
    ), null);

    const direct = readFileSync('src/lib/portalSubmission.ts', 'utf8');
    assert.match(direct, /resolveProfileField\([\s\S]*postingCountryCodeFromJobContext/);
    const managed = readFileSync('src/routes/submissionRunner.ts', 'utf8');
    assert.match(managed, /resolveProfileField\([\s\S]*postingCountryCode/);
    const monitor = readFileSync('src/routes/jobMonitor.ts', 'utf8');
    assert.match(monitor, /raw_json: portalCountry \? \{ portal_country: portalCountry \} : null/);
    const resume = readFileSync('src/routes/resume.ts', 'utf8');
    assert.match(resume, /postingPortalCountry[\s\S]*portal_country: postingPortalCountry/);
  });
});
