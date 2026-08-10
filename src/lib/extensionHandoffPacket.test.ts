import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionHandoffPacketMatches } from './extensionHandoffPacket';

const SEEKA_POSTING = 'https://jobs.smartrecruiters.com/SeekaTechnology/744000063648206-software-engineer-internship';
const SEEKA_FORM = 'https://jobs.smartrecruiters.com/oneclick-ui/company/SeekaTechnology/publication/123e4567-e89b-12d3-a456-426614174000';

test('the exact SEEKA posting may continue to its same-employer SmartRecruiters form', () => {
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: SEEKA_POSTING,
    currentUrl: SEEKA_FORM,
    frozenAtsName: 'smartrecruiters',
    status: 'needs_attention',
  }), true);
});

test('a SmartRecruiters packet cannot be loaded into another employer form', () => {
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: SEEKA_POSTING,
    currentUrl: SEEKA_FORM.replaceAll('SeekaTechnology', 'OtherEmployer'),
    frozenAtsName: 'smartrecruiters',
    status: 'needs_attention',
  }), false);
});

test('a form cannot override the frozen ATS identity', () => {
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: SEEKA_POSTING,
    currentUrl: SEEKA_FORM,
    frozenAtsName: 'greenhouse',
    status: 'needs_attention',
  }), false);
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
      currentUrl: SEEKA_FORM,
      frozenAtsName: 'smartrecruiters',
      status,
    }), false, status);
  }
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: SEEKA_POSTING,
    currentUrl: SEEKA_FORM,
    frozenAtsName: 'smartrecruiters',
    status: 'needs_attention',
    submissionClaimedAt: '2026-08-10T00:00:00.000Z',
  }), false);
});
