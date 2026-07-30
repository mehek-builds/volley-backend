import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationReviewState } from './applicationReview';
import { canStartExtensionSubmission, extensionOutcomePatch } from './extensionSubmission';

const review = (status: ApplicationReviewState['status']): ApplicationReviewState => ({
  jd_text: 'Role', status, edited_terms: [], questions: [], skipped_reasons: [], updated_at: '2026-07-30T00:00:00.000Z',
});

test('standing consent is required before an extension auto submission starts', () => {
  assert.equal(canStartExtensionSubmission(review('ready_to_submit'), 'standing_consent', false), 'consent_required');
  assert.equal(canStartExtensionSubmission(review('ready_to_submit'), 'standing_consent', true), 'start');
});

test('a claimed or completed application cannot start twice', () => {
  const claimed = { ...review('needs_attention'), submission_claimed_at: '2026-07-30T01:00:00.000Z' };
  assert.equal(canStartExtensionSubmission(claimed, 'standing_consent', true), 'reject');
  assert.equal(canStartExtensionSubmission(review('submitted'), 'per_application_approval', false), 'submitted');
});

test('only confirmed outcomes become submitted with a Chrome extension receipt', () => {
  const confirmed = extensionOutcomePatch('confirmed', '2026-07-30T01:00:00.000Z', {
    confirmationText: 'Thank you for applying', finalUrl: 'https://jobs.example/thanks',
  });
  assert.equal(confirmed.status, 'submitted');
  assert.equal(confirmed.receipt?.source, 'chrome_extension');
  assert.equal(extensionOutcomePatch('unknown', '2026-07-30T01:00:00.000Z', { finalUrl: 'https://jobs.example' }).status, 'needs_attention');
  assert.equal(extensionOutcomePatch('failed', '2026-07-30T01:00:00.000Z', { finalUrl: 'https://jobs.example' }).status, 'failed');
});
