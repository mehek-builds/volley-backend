import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationReviewState } from './applicationReview';
import {
  canStartExtensionSubmission,
  extensionEmployerReceiptIsSufficient,
  extensionOutcomeClaimDisposition,
  extensionOutcomePatch,
  isSafeExtensionReceiptUrl,
} from './extensionSubmission';

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
  assert.equal(canStartExtensionSubmission(review('submitted'), 'user_initiated', false), 'submitted');
});

test('an active managed submission is never handed to the extension', () => {
  assert.equal(canStartExtensionSubmission(review('submitting'), 'standing_consent', true), 'in_flight');
});

test('only confirmed outcomes become submitted with a Chrome extension receipt', () => {
  const confirmed = extensionOutcomePatch('confirmed', '2026-07-30T01:00:00.000Z', {
    confirmationText: 'Thank you for applying', finalUrl: 'https://jobs.example/thanks',
  });
  assert.equal(confirmed.status, 'submitted');
  assert.equal(confirmed.receipt?.source, 'chrome_extension');
  for (const outcome of ['unknown', 'failed', 'cancelled'] as const) {
    const unresolved = extensionOutcomePatch(outcome, '2026-07-30T01:00:00.000Z', {
      finalUrl: 'https://jobs.example',
      submissionRunId: '8b56a408-a8d0-41c0-8335-c3f2b6f12246',
    });
    assert.equal(unresolved.status, 'needs_attention');
    assert.equal(unresolved.submission_attempted_at, '2026-07-30T01:00:00.000Z');
    assert.deepEqual(unresolved.unverified_submission, {
      at: '2026-07-30T01:00:00.000Z',
      cause: 'no_confirmation_state',
      portal_url: 'https://jobs.example',
      submission_run_id: '8b56a408-a8d0-41c0-8335-c3f2b6f12246',
    });
    assert.equal(Object.hasOwn(unresolved, 'submission_claim_id'), false);
    assert.equal(Object.hasOwn(unresolved, 'submission_claimed_at'), false);
  }
});

test('an unknown extension response replays and can later promote on a verified receipt', () => {
  const claimId = '45be435b-63de-4451-90bd-a59b901f1e0a';
  const unresolved: ApplicationReviewState = {
    ...review('needs_attention'),
    submission_claim_id: claimId,
    unverified_submission: {
      at: '2026-07-30T01:00:00.000Z',
      cause: 'no_confirmation_state',
    },
  };
  assert.equal(extensionOutcomeClaimDisposition(unresolved, claimId, 'unknown'), 'replay_unverified');
  assert.equal(extensionOutcomeClaimDisposition(unresolved, claimId, 'confirmed'), 'promote_confirmed');
  assert.equal(extensionOutcomeClaimDisposition(unresolved, '84d53e99-f24a-423b-b4fb-34841c53f20c', 'confirmed'), 'stale');
  assert.equal(extensionOutcomeClaimDisposition(review('submitted'), claimId, 'confirmed'), 'stale');
});

test('extension receipt links cannot execute or open local files', () => {
  assert.equal(isSafeExtensionReceiptUrl('https://jobs.example/thanks'), true);
  assert.equal(isSafeExtensionReceiptUrl('http://localhost:3000/qa/thanks'), true);
  assert.equal(isSafeExtensionReceiptUrl('javascript:alert(1)'), false);
  assert.equal(isSafeExtensionReceiptUrl('data:text/html,hello'), false);
  assert.equal(isSafeExtensionReceiptUrl('file:///etc/passwd'), false);
  assert.equal(isSafeExtensionReceiptUrl('http://jobs.example/thanks'), false);
});

test('Jobvite terminal receipts require employer confirmation bound to the exact tenant and job', () => {
  const portalUrl = 'https://jobs.jobvite.com/worldfirst/job/oknrAfws/apply';
  const sufficient = (confirmationText: string | undefined, finalUrl: string) =>
    extensionEmployerReceiptIsSufficient({ atsName: 'jobvite', portalUrl, confirmationText, finalUrl });
  assert.equal(sufficient('Your application has been submitted', `${portalUrl}/confirmation`), true);
  assert.equal(sufficient('Thank you for applying to WorldFirst.', `${portalUrl}/confirmation`), true);
  assert.equal(sufficient(undefined, `${portalUrl}/confirmation`), false);
  assert.equal(sufficient('Account created successfully', `${portalUrl}/confirmation`), false);
  assert.equal(sufficient('Thank you', `${portalUrl}/confirmation`), false);
  assert.equal(sufficient('You have not successfully applied.', `${portalUrl}/confirmation`), false);
  assert.equal(sufficient('Once your application has been submitted, you may close this page.', `${portalUrl}/confirmation`), false);
  assert.equal(sufficient('Applications received after Friday will not be reviewed.', `${portalUrl}/confirmation`), false);
  assert.equal(sufficient('Your application has been submitted.', portalUrl), false);
  assert.equal(sufficient('Your application has been submitted.', `${portalUrl}?submitted=true`), false);
  assert.equal(sufficient('Your application has been submitted', 'https://jobs.jobvite.com/worldfirst/job/oknrAfwt/apply/confirmation'), false);
  assert.equal(sufficient('Your application has been submitted', 'https://jobs.jobvite.com/worldfirst/job/OKNRAfws/apply/confirmation'), false);
  assert.equal(sufficient('Your application has been submitted', 'https://jobs.jobvite.com/WorldFirst/job/oknrAfws/apply/confirmation'), false);
  assert.equal(sufficient('Your application has been submitted', 'https://jobs.jobvite.com/worldfirst/job/oknrAfws-extra/apply/confirmation'), false);
  assert.equal(sufficient('Your application has been submitted', 'https://jobs.jobvite.com/other/job/oknrAfws/apply/confirmation'), false);
  assert.equal(sufficient('Your application has been submitted', 'https://evil.example/worldfirst/job/oknrAfws/apply/confirmation'), false);
  assert.equal(sufficient('Your application has been submitted', 'https://jobs.jobvite.com:444/worldfirst/job/oknrAfws/apply/confirmation'), false);
});

test('iCIMS terminal receipts require employer confirmation bound to the exact tenant and numeric job', () => {
  const portalUrl = 'https://jobs-express.icims.com/jobs/48173/sales-associate/login';
  const sufficient = (confirmationText: string | undefined, finalUrl: string) =>
    extensionEmployerReceiptIsSufficient({ atsName: 'icims', portalUrl, confirmationText, finalUrl });
  assert.equal(sufficient('Thank you for applying', 'https://jobs-express.icims.com/jobs/48173/sales-associate/login/confirmation'), true);
  assert.equal(sufficient('Application received', 'https://jobs-express.icims.com/jobs/48173/sales-associate/job/submitted'), true);
  assert.equal(sufficient('Login successful', 'https://jobs-express.icims.com/jobs/48173/sales-associate/login/confirmation'), false);
  assert.equal(sufficient('Profile saved', 'https://jobs-express.icims.com/jobs/48173/sales-associate/login/confirmation'), false);
  assert.equal(sufficient('Application received', 'https://jobs-express.icims.com/jobs/481730/sales-associate/login/confirmation'), false);
  assert.equal(sufficient('Application received', 'https://other.icims.com/jobs/48173/sales-associate/login/confirmation'), false);
  assert.equal(sufficient('Application received', 'https://jobs-express.icims.com/jobs/48173/sales-associate/confirmation'), false);
  assert.equal(sufficient('Application received.', portalUrl), false);
  assert.equal(sufficient('Application received.', `${portalUrl}?success=true`), false);
});

test('Oracle remains unconfirmable until a measured terminal receipt contract exists', () => {
  const portalUrl = 'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/333913/apply/email';
  for (const finalUrl of [
    portalUrl,
    `${portalUrl}?submitted=true`,
    `${portalUrl}/confirmation`,
    'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/333913/thank-you',
  ]) assert.equal(extensionEmployerReceiptIsSufficient({
    atsName: 'oraclecloud',
    portalUrl,
    confirmationText: 'Your application has been submitted.',
    finalUrl,
  }), false);
});

test('receipt tightening is scoped to attended families', () => {
  assert.equal(extensionEmployerReceiptIsSufficient({
    atsName: 'lever',
    portalUrl: 'https://jobs.lever.co/acme/job-1',
    finalUrl: 'https://jobs.lever.co/acme/job-1',
  }), true);
});

test('receipt scope follows the frozen portal and cannot be bypassed by missing or spoofed ATS metadata', () => {
  const portalUrl = 'https://jobs.jobvite.com/worldfirst/job/oknrAfws/apply';
  assert.equal(extensionEmployerReceiptIsSufficient({
    portalUrl,
    finalUrl: `${portalUrl}/confirmation`,
  }), false);
  assert.equal(extensionEmployerReceiptIsSufficient({
    atsName: 'lever',
    portalUrl,
    confirmationText: 'Your application has been submitted.',
    finalUrl: `${portalUrl}/confirmation`,
  }), false);
  assert.equal(extensionEmployerReceiptIsSufficient({
    atsName: 'jobvite',
    portalUrl: 'https://jobs.jobvite.com/worldfirst/jobs',
    confirmationText: 'Your application has been submitted.',
    finalUrl: `${portalUrl}/confirmation`,
  }), false);
});
