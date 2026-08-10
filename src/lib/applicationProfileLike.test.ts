import assert from 'node:assert/strict';
import test from 'node:test';
import { applicationProfileWriteValues, bodySchema, decryptRow } from '../routes/applicationProfile';
import { eligibilityFromLoadedApplicationProfile } from './applicationProfileLike';
import { resolveProfileField } from './profileFieldResolution';

process.env.ENCRYPTION_KEY ??= 'test-encryption-key-at-least-32-chars-long';

test('the live profile loader resolves decrypted country records into a send value', () => {
  const records = [{
    country_code: 'GB',
    authorized_now: false,
    needs_sponsorship_now: true,
    needs_sponsorship_future: true,
  }];
  const written = applicationProfileWriteValues(bodySchema.parse({ work_eligibility_by_country: records }));
  const raw = {
    work_eligibility_by_country: written.work_eligibility_by_country,
    work_authorized: null,
    needs_sponsorship: null,
  } as never;
  const app = decryptRow(raw);
  const loaded = eligibilityFromLoadedApplicationProfile(app, {
    work_authorized: undefined,
    needs_sponsorship: undefined,
  });
  assert.deepEqual(loaded, records);
  assert.deepEqual(resolveProfileField(
    { label: 'Will you require sponsorship?', inputType: 'select', options: ['Yes', 'No'] },
    { work_eligibility_by_country: loaded },
    undefined,
    'non_us',
    'GB',
  )?.value, 'Yes');
});

test('an empty stored envelope is authoritative and never unlocks scalar fallback', () => {
  const app = decryptRow({
    work_eligibility_by_country: '',
    work_authorized: true,
    needs_sponsorship: false,
  } as never);
  assert.deepEqual(app.work_eligibility_by_country, []);
  assert.deepEqual(eligibilityFromLoadedApplicationProfile(app, {
    work_authorized: true,
    needs_sponsorship: false,
  }), []);
});
