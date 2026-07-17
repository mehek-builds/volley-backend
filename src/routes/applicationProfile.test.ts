import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bodySchema, decryptRow, ENCRYPTED_FIELDS } from './applicationProfile';
import type { ApplicationProfile } from '../db/schema';

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
    updated_at: null,
    ...over,
  };
}

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
