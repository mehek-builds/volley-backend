import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sponsorshipStateForRecords } from './countryEligibilityPersistence';

test('US settings edits keep sponsorship state and the board filter aligned', () => {
  assert.deepEqual(sponsorshipStateForRecords([{
    country_code: 'US',
    authorized_now: true,
    needs_sponsorship_now: false,
    needs_sponsorship_future: true,
  }]), {
    sponsorship_required_at_onboarding: true,
    sponsorship_answer: 'needs_future',
    sponsor_only_jobs_enabled: true,
  });
  assert.deepEqual(sponsorshipStateForRecords([{
    country_code: 'US',
    authorized_now: true,
    needs_sponsorship_now: false,
    needs_sponsorship_future: false,
  }]), {
    sponsorship_required_at_onboarding: false,
    sponsorship_answer: 'no',
    sponsor_only_jobs_enabled: false,
  });
  assert.deepEqual(sponsorshipStateForRecords([{
    country_code: 'GB',
    authorized_now: true,
    needs_sponsorship_now: false,
    needs_sponsorship_future: false,
  }]), {
    sponsorship_required_at_onboarding: false,
    sponsorship_answer: null,
    sponsor_only_jobs_enabled: false,
  });
});

test('profile declaration and sponsor filter are committed by one database transaction', () => {
  const source = readFileSync('src/lib/countryEligibilityPersistence.ts', 'utf8');
  assert.match(source, /db\.transaction\(async \(tx\)/);
  assert.match(source, /tx[\s\S]*insert\(application_profile\)[\s\S]*tx\.update\(users\)/);
  assert.match(source, /encryptField\(JSON\.stringify\(records\)\)/);
  assert.match(source, /coalesce\(\$\{users\.sponsorship_required_at_onboarding\}, false\)/);
  assert.match(source, /sponsor_only_jobs_enabled: desired\.sponsor_only_jobs_enabled[\s\S]*users\.sponsor_only_jobs_enabled/);
  assert.match(source, /when \$\{users\.sponsorship_required_at_onboarding\} is true then \$\{users\.sponsorship_answer\}/);
});
