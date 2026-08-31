import assert from 'node:assert/strict';
import test from 'node:test';
import {
  employerEmailConfirmationEvidenceCode,
  measuredPersistedReceiptMatchesOpening,
} from './authoritativeSubmissionProjection';
import type { SubmissionAttemptEventRecord } from './submissionAttemptLedger';
import {
  unsupportedEmailConfirmationEvidenceCode,
  unsupportedEmailConfirmationText,
} from './unsupportedEmailReceipt';

const observedAt = new Date('2026-08-31T10:00:00.000Z');

function event(overrides: Partial<SubmissionAttemptEventRecord>): SubmissionAttemptEventRecord {
  return {
    id: '5e377281-7991-4c40-b4c7-10a85cc591ef',
    user_id: 'cf48e921-8543-466c-b51f-1598fd723235',
    application_id: 'c9ea060c-ec99-469a-8d19-4eabac66bd89',
    packet_id: '0cf0dcee-b030-4dd8-aaf4-84df811da7c3',
    event_id: '5e377281-7991-4c40-b4c7-10a85cc591ef',
    attempt_id: 'a3578398-c4cc-414d-9a44-c7943d8effb9',
    parent_attempt_id: null,
    event_kind: 'attempt_opened',
    source: 'managed_browser',
    operation: 'initial_submission',
    submission_run_id: 'fb2079d2-daf6-4a89-8940-f9e362e3eb60',
    submission_claim_id: 'a3578398-c4cc-414d-9a44-c7943d8effb9',
    packet_version: 'f'.repeat(64),
    posting_key: null,
    job_id: null,
    company_role: 'jump trading::software engineer',
    company_name: 'Jump Trading',
    role: 'Software Engineer',
    portal_url: 'https://job-boards.greenhouse.io/jumptrading/jobs/7654321',
    portal_identity: null,
    proof_kind: null,
    evidence_code: 'atomic_claim_reserved',
    boundary_activation_id: null,
    boundary_expires_at: null,
    observed_at: observedAt,
    created_at: observedAt,
    ...overrides,
  } as SubmissionAttemptEventRecord;
}

test('Jump Greenhouse repair keeps exact board and job confirmation authority', () => {
  const opening = event({});
  const confirmation = event({
    event_kind: 'submission_confirmed',
    evidence_code: 'managed_application_receipt',
  });
  assert.equal(measuredPersistedReceiptMatchesOpening(
    opening,
    confirmation,
    'https://job-boards.greenhouse.io/jumptrading/jobs/7654321/application_confirmation',
    'Thank you for applying.',
  ), true);
  assert.equal(measuredPersistedReceiptMatchesOpening(
    opening,
    confirmation,
    'https://job-boards.greenhouse.io/another-board/jobs/7654321/application_confirmation',
    'Thank you for applying.',
  ), false);
});

test('generic Ashby application URL and mutable text cannot mint repair authority', () => {
  const opening = event({
    portal_url: 'https://jobs.ashbyhq.com/example/11111111-1111-4111-8111-111111111111',
    company_name: 'Example',
    company_role: 'example::software engineer',
  });
  const confirmation = event({
    event_kind: 'submission_confirmed',
    evidence_code: 'managed_application_receipt',
  });
  assert.equal(measuredPersistedReceiptMatchesOpening(
    opening,
    confirmation,
    'https://jobs.ashbyhq.com/example/11111111-1111-4111-8111-111111111111/application',
    'Application submitted successfully',
  ), false);
});

test('unsupported email projection requires the exact recipient, provider id, and reference', () => {
  const accepted = { recipient: 'jobs@example.test', messageId: 'resend-123' };
  const opening = event({
    source: 'unsupported_email',
    portal_url: 'https://careers.example.test/jobs/42',
    evidence_code: 'atomic_email_claim_reserved',
  });
  const confirmation = event({
    source: 'unsupported_email',
    event_kind: 'submission_confirmed',
    evidence_code: unsupportedEmailConfirmationEvidenceCode(accepted),
  });
  assert.equal(measuredPersistedReceiptMatchesOpening(
    opening,
    confirmation,
    'https://careers.example.test/jobs/42',
    unsupportedEmailConfirmationText(accepted),
    accepted.messageId,
  ), true);
  assert.equal(measuredPersistedReceiptMatchesOpening(
    opening,
    confirmation,
    'https://careers.example.test/jobs/42',
    unsupportedEmailConfirmationText(accepted),
    'different-id',
  ), false);
});

test('employer email confirmation evidence is bound to the exact stored message and receipt', () => {
  const base = {
    attemptId: 'a3578398-c4cc-414d-9a44-c7943d8effb9',
    userId: 'cf48e921-8543-466c-b51f-1598fd723235',
    packetId: '0cf0dcee-b030-4dd8-aaf4-84df811da7c3',
    messageId: '15490a8b-3375-4b04-b91b-fd8e0d7d236c',
    alias: 'Jobs+Applicant@Example.Test',
    confirmationText: 'Application received',
    finalUrl: 'https://jobs.example.test/apply/42',
    receivedAt: '2026-08-31T10:00:00.000Z',
  };
  const exact = employerEmailConfirmationEvidenceCode(base);
  assert.match(exact, /^employer_email_confirmation_v1:[a-f0-9]{64}$/);
  assert.equal(exact, employerEmailConfirmationEvidenceCode({
    ...base,
    alias: ' jobs+applicant@example.test ',
    receivedAt: new Date(base.receivedAt),
  }));
  for (const changed of [
    { messageId: '0e74826d-acd8-48f7-9c4a-415a571a02b3' },
    { confirmationText: 'Different confirmation' },
    { finalUrl: 'https://jobs.example.test/apply/43' },
    { receivedAt: '2026-08-31T10:00:01.000Z' },
  ]) {
    assert.notEqual(exact, employerEmailConfirmationEvidenceCode({ ...base, ...changed }));
  }
});
