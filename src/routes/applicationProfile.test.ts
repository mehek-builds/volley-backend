import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getTableColumns } from 'drizzle-orm';
import { applicationProfileWriteValues, bodySchema, decryptRow, ENCRYPTED_FIELDS } from './applicationProfile';
import { application_profile, type ApplicationProfile } from '../db/schema';
import { looksEncrypted } from '../lib/fieldCrypto';

process.env.ENCRYPTION_KEY ??= 'test-encryption-key-at-least-32-chars-long';

// The trap these tests exist to pin: a column declared in schema.ts with no matching line in
// bodySchema is stripped by zod SILENTLY. PUT returns 200, the value is discarded, and the client
// believes a write that never happened. So for every new column the round-trip has three joints,
// each of which can drop the value with no error: parse (keeps the key), write (nothing mangles a
// non-string), serve (decryptRow passes it back). languages is the first jsonb array to ride
// through all three.

function row(over: Partial<ApplicationProfile> = {}): ApplicationProfile {
  return {
    user_id: '00000000-0000-4000-8000-000000000001',
    phone: null,
    address_city: null,
    address_state: null,
    address_zip: null,
    address_country: null,
    linkedin_url: null,
    github_url: null,
    portfolio_url: null,
    citizenship: null,
    work_authorized: null,
    needs_sponsorship: null,
    work_eligibility_by_country: null,
    availability_date: null,
    availability_term: null,
    desired_salary: null,
    desired_salary_currency: null,
    date_of_birth: null,
    gpa: null,
    gpa_scale: null,
    major: null,
    languages: null,
    eeo_prefs: null,
    referral_source_default: null,
    // Application facts asked once in onboarding. Present here as nulls on purpose: this fixture is
    // the FULL row shape, so a column added to schema.ts with no line here fails the build, which is
    // the same trap the file header describes for bodySchema.
    pronouns: null,
    legal_first_name: null,
    preferred_first_name: null,
    high_school_grad_date: null,
    education_start_date: null,
    prior_application_employers: null,
    has_outstanding_offers: null,
    outstanding_offer_details: null,
    military_service: null,
    politically_exposed: null,
    politically_exposed_family: null,
    advanced_study_plan: null,
    attest_truthful_information: null,
    accept_privacy_notices: null,
    application_attestations_consented_at: null,
    onsite_commitment: null,
    onsite_locations: null,
    relocation_willingness: null,
    availability_window_start: null,
    availability_window_end: null,
    availability_cycle: null,
    availability_valid_through: null,
    updated_at: null,
    ...over,
  };
}

describe('education start date schema and round-trip', () => {
  test('declares the live database contract: nullable text with no default', () => {
    const column = getTableColumns(application_profile).education_start_date;
    assert.equal(column.name, 'education_start_date');
    assert.equal(column.getSQLType(), 'text');
    assert.equal(column.notNull, false);
    assert.equal(column.hasDefault, false);
  });

  test('bodySchema keeps the month-and-year value for the write side', () => {
    const parsed = bodySchema.parse({ education_start_date: 'August 2024' });
    assert.equal(parsed.education_start_date, 'August 2024');
  });

  test('decryptRow returns the stored value unchanged on the read side', () => {
    const served = decryptRow(row({ education_start_date: 'August 2024' }));
    assert.equal(served.education_start_date, 'August 2024');
  });

  test('null clears, omission leaves alone, and the field stays plaintext', () => {
    assert.equal(bodySchema.parse({ education_start_date: null }).education_start_date, null);
    assert.equal('education_start_date' in bodySchema.parse({}), false);
    assert.equal((ENCRYPTED_FIELDS as readonly string[]).includes('education_start_date'), false);
  });
});

describe('languages round-trip (PUT accepts, GET serves)', () => {
  test('bodySchema KEEPS languages - the write side of the round-trip', () => {
    const parsed = bodySchema.parse({ languages: ['English', 'Hindi', 'Spanish'] });
    assert.deepEqual(parsed.languages, ['English', 'Hindi', 'Spanish']);
  });

  test('decryptRow passes a stored languages array through untouched - the read side', () => {
    const served = decryptRow(row({ languages: ['English', 'Hindi'] }));
    assert.deepEqual(served.languages, ['English', 'Hindi']);
  });

  test('the silent-strip trap is real: an unknown key parses fine and vanishes', () => {
    // This is what a schema.ts column WITHOUT a bodySchema line looks like to the API: no error,
    // no 400, the key just is not there afterwards. Which is why the test above is load-bearing.
    const parsed = bodySchema.parse({ not_a_declared_field: 'x' });
    assert.equal('not_a_declared_field' in parsed, false);
  });

  test('null clears, omission leaves alone - same contract as every other field', () => {
    assert.equal(bodySchema.parse({ languages: null }).languages, null);
    assert.equal('languages' in bodySchema.parse({}), false);
  });

  test('rejects a bare string and non-string members - it is a list or nothing', () => {
    assert.equal(bodySchema.safeParse({ languages: 'English' }).success, false);
    assert.equal(bodySchema.safeParse({ languages: [1, 2] }).success, false);
    assert.equal(bodySchema.safeParse({ languages: [] }).success, true);
  });

  test('languages is plaintext: NOT in ENCRYPTED_FIELDS, so encryptRow cannot touch it', () => {
    assert.equal((ENCRYPTED_FIELDS as readonly string[]).includes('languages'), false);
  });
});

describe('country-scoped work eligibility round-trip', () => {
  const records = [{
    country_code: 'US',
    authorized_now: true,
    needs_sponsorship_now: false,
    needs_sponsorship_future: true,
    authorization_type: 'F-1 CPT',
    authorization_expiry: '2028-05-12',
  }, {
    country_code: 'AE',
    authorized_now: true,
    needs_sponsorship_now: false,
    needs_sponsorship_future: false,
  }];

  test('bodySchema keeps complete records and normalizes ISO codes', () => {
    const parsed = bodySchema.parse({ work_eligibility_by_country: [{ ...records[0], country_code: 'us' }] });
    assert.equal(parsed.work_eligibility_by_country?.[0]?.country_code, 'US');
  });

  test('rejects duplicates, incomplete booleans, and malformed expiry dates', () => {
    assert.equal(bodySchema.safeParse({ work_eligibility_by_country: [records[0], records[0]] }).success, false);
    assert.equal(bodySchema.safeParse({ work_eligibility_by_country: [{ country_code: 'US' }] }).success, false);
    assert.equal(bodySchema.safeParse({ work_eligibility_by_country: [{ ...records[0], country_code: 'ZZ' }] }).success, false);
    assert.equal(bodySchema.safeParse({
      work_eligibility_by_country: [{ ...records[0], authorization_expiry: 'May 2028' }],
    }).success, false);
  });

  test('PUT derives projections from scoped lists and preserves scalar-only extension writes', () => {
    const scoped = applicationProfileWriteValues(bodySchema.parse({
      work_eligibility_by_country: records,
      work_authorized: false,
      needs_sponsorship: false,
    }));
    assert.equal(looksEncrypted(String(scoped.work_eligibility_by_country)), true);
    assert.doesNotMatch(String(scoped.work_eligibility_by_country), /F-1 CPT|2028-05-12/);
    assert.equal(scoped.work_authorized, true);
    assert.equal(scoped.needs_sponsorship, true);
    assert.deepEqual(applicationProfileWriteValues(bodySchema.parse({
      work_authorized: false,
      needs_sponsorship: true,
    })), { work_authorized: false, needs_sponsorship: true });
    assert.deepEqual(applicationProfileWriteValues(bodySchema.parse({
      work_eligibility_by_country: null,
      work_authorized: true,
      needs_sponsorship: false,
    })), { work_authorized: true, needs_sponsorship: false });
  });

  test('GET decrypts stored scope without synthesizing a hidden key for scalar-only clients', () => {
    const encrypted = applicationProfileWriteValues(bodySchema.parse({ work_eligibility_by_country: records }));
    assert.deepEqual(decryptRow(row({
      work_eligibility_by_country: encrypted.work_eligibility_by_country as string,
    })).work_eligibility_by_country, records);
    const old = decryptRow(row({
      work_authorized: true,
      needs_sponsorship: false,
      work_eligibility_by_country: null,
    }));
    assert.equal(old.work_eligibility_by_country, null);
    const ambiguous = decryptRow(row({
      work_authorized: true,
      needs_sponsorship: true,
      work_eligibility_by_country: null,
    }));
    assert.equal(ambiguous.work_eligibility_by_country, null);
  });

  test('legacy GET-edit-PUT preserves scalar edits without creating scoped authority', () => {
    const fetched = decryptRow(row({
      work_authorized: true,
      needs_sponsorship: false,
      work_eligibility_by_country: null,
    }));
    const edited = bodySchema.parse({ ...fetched, work_authorized: false, needs_sponsorship: true });
    const write = applicationProfileWriteValues(edited);
    assert.equal('work_eligibility_by_country' in write, false);
    assert.equal(write.work_authorized, false);
    assert.equal(write.needs_sponsorship, true);
  });
});

describe('EEO preferences round-trip (PUT accepts, GET serves)', () => {
  test('bodySchema keeps optional self-identification preferences', () => {
    const parsed = bodySchema.parse({ eeo_prefs: { gender: 'Female', race: 'Asian' } });
    assert.deepEqual(parsed.eeo_prefs, { gender: 'Female', race: 'Asian' });
  });

  test('decryptRow passes stored EEO preferences through untouched', () => {
    const served = decryptRow(row({ eeo_prefs: { gender: 'Female', race: 'Asian' } }));
    assert.deepEqual(served.eeo_prefs, { gender: 'Female', race: 'Asian' });
  });
});
