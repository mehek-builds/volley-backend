import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deniedKeys, harvestable, DENIED } from './harvest';

// The R-004 regression surface. RoleQuick once auto-filled "Yes, I am authorized to work without
// sponsorship" onto a live Berlin application for a Dubai-based student who needed sponsorship
// (Lever/Xsolla, 2026-07-16). The fix made the extension refuse to ANSWER those questions.
// Harvest is the same bug pointed the other way: capture a location-scoped answer once, replay it
// on every posting after. These tests pin the refusal on the server, where an extension bug
// cannot reach it.

describe('harvest denylist (R-004)', () => {
  test('refuses work_authorized', () => {
    assert.deepEqual(deniedKeys({ work_authorized: true }), ['work_authorized']);
  });

  test('refuses needs_sponsorship', () => {
    assert.deepEqual(deniedKeys({ needs_sponsorship: false }), ['needs_sponsorship']);
  });

  test('refuses eeo_prefs', () => {
    assert.deepEqual(deniedKeys({ eeo_prefs: { gender: 'Female' } }), ['eeo_prefs']);
  });

  test('refuses every denied key at once, and names them all', () => {
    const denied = deniedKeys({
      phone: '+971500000000',
      work_authorized: true,
      needs_sponsorship: true,
      eeo_prefs: { race: 'Asian' },
    });
    assert.deepEqual(denied.sort(), ['eeo_prefs', 'needs_sponsorship', 'work_authorized']);
  });

  test('a denied key is caught even when its value is null or undefined', () => {
    // `in` not truthiness: the extension sending the key AT ALL is the bug worth surfacing,
    // regardless of what it managed to read out of the DOM.
    assert.deepEqual(deniedKeys({ work_authorized: null }), ['work_authorized']);
    assert.deepEqual(deniedKeys({ needs_sponsorship: undefined }), ['needs_sponsorship']);
  });

  test('allows a clean payload', () => {
    assert.deepEqual(deniedKeys({ phone: '+971500000000', address_city: 'Dubai' }), []);
  });

  test('handles null/undefined bodies', () => {
    assert.deepEqual(deniedKeys(null), []);
    assert.deepEqual(deniedKeys(undefined), []);
    assert.deepEqual(deniedKeys({}), []);
  });

  // The distinction the whole fix rests on. Nationality is a stable fact about a person and fills
  // correctly (verified live on ANYbotics/Lever: Nationality = "India" filled while the separate
  // work-permit question was correctly left blank). Work authorization is a claim about a
  // PLACE, and the same person's honest answer differs per country.
  test('citizenship is NOT denied - it is a stable attribute, not a location-scoped claim', () => {
    assert.deepEqual(deniedKeys({ citizenship: 'India' }), []);
    assert.equal(harvestable.safeParse({ citizenship: 'India' }).success, true);
  });

  test('DENIED is exactly the three fields, so a silent addition trips this', () => {
    assert.deepEqual([...DENIED].sort(), ['eeo_prefs', 'needs_sponsorship', 'work_authorized']);
  });
});

describe('harvestable schema', () => {
  // Why the route checks deniedKeys BEFORE zod: zod strips unknown keys silently, so parsing
  // first would swallow a work-auth answer and return 200. This test pins the reason that
  // ordering exists, so a later "tidy-up" that reorders them fails here instead of in prod.
  test('zod alone would SILENTLY DROP a denied key - which is why it is not the guard', () => {
    const parsed = harvestable.safeParse({ phone: '+971500000000', work_authorized: true });
    assert.equal(parsed.success, true);
    assert.equal('work_authorized' in (parsed as { data: object }).data, false);
    // ...and this is what actually catches it.
    assert.deepEqual(deniedKeys({ phone: '+971500000000', work_authorized: true }), ['work_authorized']);
  });

  test('rejects empty strings rather than storing them as answers', () => {
    assert.equal(harvestable.safeParse({ phone: '' }).success, false);
  });

  test('accepts the fields a real form legitimately teaches us', () => {
    const r = harvestable.safeParse({
      phone: '+971 50 123 4567',
      address_city: 'Dubai',
      address_country: 'United Arab Emirates',
      linkedin_url: 'linkedin.com/in/mehekmandal',
      citizenship: 'India',
      date_of_birth: '25 Sep 2005',
      gpa: '3.89',
      gpa_scale: '4.0',
      major: 'Computer Science',
      desired_salary: '80000',
      desired_salary_currency: 'EUR',
    });
    assert.equal(r.success, true);
  });
});
