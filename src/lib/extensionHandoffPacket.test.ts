import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extensionHandoffPacketMatches,
  extensionHandoffVersion,
  extensionStartHandoffBinding,
} from './extensionHandoffPacket';
import { MANAGED_NETWORK_ACCESS_RESTRICTION_REASON } from './portalSubmission';

const SEEKA_POSTING = 'https://jobs.smartrecruiters.com/SeekaTechnology/744000063648206-software-engineer-internship';
const SEEKA_FORM = 'https://jobs.smartrecruiters.com/oneclick-ui/company/SeekaTechnology/publication/123e4567-e89b-12d3-a456-426614174000';

test('the exact SEEKA posting may continue to its same-employer SmartRecruiters form', () => {
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: SEEKA_POSTING,
    frozenHandoffUrl: SEEKA_FORM,
    currentUrl: SEEKA_FORM,
    frozenAtsName: 'smartrecruiters',
    status: 'needs_attention',
    attentionReason: MANAGED_NETWORK_ACCESS_RESTRICTION_REASON,
  }), true);
});

test('a SmartRecruiters packet cannot be loaded into another employer form', () => {
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: SEEKA_POSTING,
    frozenHandoffUrl: SEEKA_FORM,
    currentUrl: SEEKA_FORM.replaceAll('SeekaTechnology', 'OtherEmployer'),
    frozenAtsName: 'smartrecruiters',
    status: 'needs_attention',
    attentionReason: MANAGED_NETWORK_ACCESS_RESTRICTION_REASON,
  }), false);
});

test('a form cannot override the frozen ATS identity', () => {
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: SEEKA_POSTING,
    frozenHandoffUrl: SEEKA_FORM,
    currentUrl: SEEKA_FORM,
    frozenAtsName: 'greenhouse',
    status: 'needs_attention',
    attentionReason: MANAGED_NETWORK_ACCESS_RESTRICTION_REASON,
  }), false);
});

test('a caller-supplied application id cannot select another publication from the same SmartRecruiters tenant', () => {
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: SEEKA_POSTING,
    frozenHandoffUrl: SEEKA_FORM,
    currentUrl: SEEKA_FORM.replace('123e4567-e89b-12d3-a456-426614174000', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
    frozenAtsName: 'smartrecruiters',
    status: 'needs_attention',
    attentionReason: MANAGED_NETWORK_ACCESS_RESTRICTION_REASON,
  }), false);
});

test('a legacy SmartRecruiters packet without a runner-observed form URL is not disclosed', () => {
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: SEEKA_POSTING,
    currentUrl: SEEKA_FORM,
    frozenAtsName: 'smartrecruiters',
    status: 'needs_attention',
    attentionReason: MANAGED_NETWORK_ACCESS_RESTRICTION_REASON,
  }), false);
});

test('SmartRecruiters refill is limited to the exact network-reputation recovery state', () => {
  for (const candidate of [
    { status: 'needs_attention' as const, attentionReason: 'A required field is empty.' },
    { status: 'questions_ready' as const, attentionReason: MANAGED_NETWORK_ACCESS_RESTRICTION_REASON },
    { status: 'ready_for_final_approval' as const, attentionReason: MANAGED_NETWORK_ACCESS_RESTRICTION_REASON },
  ]) {
    assert.equal(extensionHandoffPacketMatches({
      frozenUrl: SEEKA_POSTING,
      frozenHandoffUrl: SEEKA_FORM,
      currentUrl: SEEKA_FORM,
      frozenAtsName: 'smartrecruiters',
      ...candidate,
    }), false);
  }
});

test('handoff version changes after any packet, PDF, owner, application, or form mutation', () => {
  const packet = {
    applicationId: 'application-1',
    userId: 'user-1',
    resumeObjectKey: 'users/user-1/resumes/application-1.pdf',
    spec: { _review: { questions: [{ question: 'Why?', answer: 'Because.' }] } },
    jobContext: { company: 'SEEKA Technology', role: 'Software Engineer Internship' },
    currentUrl: SEEKA_FORM,
  };
  const version = extensionHandoffVersion(packet);
  assert.match(version ?? '', /^[a-f0-9]{64}$/);
  assert.notEqual(extensionHandoffVersion({ ...packet, applicationId: 'application-2' }), version);
  assert.notEqual(extensionHandoffVersion({ ...packet, userId: 'user-2' }), version);
  assert.notEqual(extensionHandoffVersion({ ...packet, resumeObjectKey: `${packet.resumeObjectKey}.new` }), version);
  assert.notEqual(extensionHandoffVersion({ ...packet, spec: { _review: { questions: [] } } }), version);
  assert.notEqual(extensionHandoffVersion({ ...packet, jobContext: { company: 'Other employer' } }), version);
  assert.notEqual(extensionHandoffVersion({
    ...packet,
    currentUrl: SEEKA_FORM.replace('123e4567-e89b-12d3-a456-426614174000', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
  }), version);
});

test('a generic other ATS handoff requires exact canonical application identity', () => {
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: 'https://jobs.lever.co/acme/abc123',
    currentUrl: 'https://jobs.lever.co/acme/abc123/apply',
    frozenAtsName: 'lever',
    status: 'ready_to_submit',
  }), true);
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: 'https://jobs.lever.co/acme/abc123',
    currentUrl: 'https://jobs.lever.co/acme/different/apply',
    frozenAtsName: 'lever',
    status: 'ready_to_submit',
  }), false);
});

test('generic extension-start validates a complete immutable handoff binding', () => {
  const currentUrl = 'https://jobs.lever.co/acme/abc123/apply';
  const packet = {
    applicationId: 'application-1',
    userId: 'user-1',
    resumeObjectKey: 'users/user-1/resumes/application-1.pdf',
    spec: {
      summary: 'Tailored summary',
      _review: {
        portal_url: 'https://jobs.lever.co/acme/abc123',
        ats_name: 'lever',
        status: 'ready_to_submit' as const,
        questions: [{ question: 'Why?', answer: 'Because.' }],
      },
    },
    jobContext: { company: 'Acme', role: 'Engineer' },
    currentUrl,
  };
  const review = packet.spec._review;
  const handoffVersion = extensionHandoffVersion(packet)!;
  const validate = (overrides: Partial<Parameters<typeof extensionStartHandoffBinding>[0]> = {}) => extensionStartHandoffBinding({
    handoffVersion,
    ...packet,
    review,
    ...overrides,
  });

  assert.equal(validate(), 'valid');
  assert.equal(validate({ handoffVersion: undefined, currentUrl: undefined }), 'missing');
  assert.equal(validate({ handoffVersion: undefined }), 'missing');
  assert.equal(validate({ currentUrl: undefined }), 'missing');
  assert.equal(validate({ currentUrl: 'https://jobs.lever.co/acme/different/apply' }), 'mismatch');
  assert.equal(validate({ spec: { ...packet.spec, summary: 'Changed after fetch' } }), 'stale');
  assert.equal(validate({
    spec: { ...packet.spec, _review: { ...review, questions: [{ question: 'Why?', answer: 'Changed.' }] } },
  }), 'stale');
  assert.equal(validate({ resumeObjectKey: `${packet.resumeObjectKey}.new` }), 'stale');
  assert.equal(validate({ jobContext: { ...packet.jobContext, role: 'Designer' } }), 'stale');
  assert.equal(validate({ jobContext: { ...packet.jobContext, company: 'Other employer' } }), 'stale');
  assert.equal(validate({
    spec: { ...packet.spec, _review: { ...review, status: 'questions_ready' } },
    review: { ...review, status: 'questions_ready' },
  }), 'stale');
});

test('SmartRecruiters recovery cannot bypass its required extension-start binding', () => {
  const packet = {
    applicationId: 'application-1',
    userId: 'user-1',
    resumeObjectKey: 'users/user-1/resumes/application-1.pdf',
    spec: { _review: { status: 'needs_attention' } },
    jobContext: { company: 'SEEKA Technology' },
    review: {
      portal_url: SEEKA_POSTING,
      extension_handoff_url: SEEKA_FORM,
      ats_name: 'smartrecruiters',
      status: 'needs_attention' as const,
      attention_reason: MANAGED_NETWORK_ACCESS_RESTRICTION_REASON,
    },
  };
  assert.equal(extensionStartHandoffBinding(packet), 'missing');
});

test('claimed, submitted, in-flight, and security-code packets are never disclosed for refill', () => {
  for (const status of [
    'resume_ready',
    'submit_requested',
    'preparing',
    'filling',
    'awaiting_security_code',
    'submitting',
    'submission_claimed',
    'submitted',
    'failed',
  ] as const) {
    assert.equal(extensionHandoffPacketMatches({
      frozenUrl: SEEKA_POSTING,
      frozenHandoffUrl: SEEKA_FORM,
      currentUrl: SEEKA_FORM,
      frozenAtsName: 'smartrecruiters',
      status,
      attentionReason: MANAGED_NETWORK_ACCESS_RESTRICTION_REASON,
    }), false, status);
  }
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: SEEKA_POSTING,
    frozenHandoffUrl: SEEKA_FORM,
    currentUrl: SEEKA_FORM,
    frozenAtsName: 'smartrecruiters',
    status: 'needs_attention',
    attentionReason: MANAGED_NETWORK_ACCESS_RESTRICTION_REASON,
    submissionClaimedAt: '2026-08-10T00:00:00.000Z',
  }), false);
});
