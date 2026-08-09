import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCompanySiteReferralClaim,
  isJobBoardReferralClaim,
  referralSourceForApplication,
  referralSourceOptionCandidates,
  type ReferralSourceEvidence,
} from './referralSource';

const jobBoardEvidence: ReferralSourceEvidence = {
  kind: 'litos_job_board',
  value: 'Job board',
  jobId: '11111111-1111-4111-8111-111111111111',
  sourceId: '22222222-2222-4222-8222-222222222222',
  sourceUrl: 'https://boards.greenhouse.io/acme/jobs/123',
  observedAt: '2026-08-09T00:00:00.000Z',
};

test('legacy and ambiguous company-site defaults fail closed without packet evidence', () => {
  for (const value of ['Company website', 'Website', 'Web site', 'Careers', 'Careers page']) {
    assert.equal(isCompanySiteReferralClaim(value), true, value);
    assert.equal(referralSourceForApplication(value), undefined, value);
  }
});

test('packet-specific Litos job-board evidence overrides the historical company-site default', () => {
  assert.equal(referralSourceForApplication('Company website', jobBoardEvidence), 'Job board');
  assert.equal(referralSourceForApplication('Website', jobBoardEvidence), 'Job board');
  assert.equal(referralSourceForApplication(undefined, jobBoardEvidence), 'Job board');
});

test('runtime job-board candidates stay inside the evidenced acquisition channel', () => {
  assert.equal(isJobBoardReferralClaim('Job Board'), true);
  assert.deepEqual(referralSourceOptionCandidates('Job board', jobBoardEvidence), [
    'Job board',
    'Job Board',
    'Online job board',
  ]);
  assert.deepEqual(referralSourceOptionCandidates('Job board'), []);
  assert.equal(
    referralSourceOptionCandidates('Job board', jobBoardEvidence).some((value) => /website|career|other/i.test(value)),
    false,
  );
});

test('company-site selection requires matching employer-site evidence', () => {
  const employerEvidence: ReferralSourceEvidence = {
    ...jobBoardEvidence,
    kind: 'employer_career_site',
    value: 'Company website',
  };
  assert.equal(referralSourceForApplication('Company website', employerEvidence), 'Company website');
  assert.equal(referralSourceForApplication('Company website', {
    ...employerEvidence,
    kind: 'litos_job_board',
  }), undefined);
  const candidates = referralSourceOptionCandidates('Company website', employerEvidence);
  assert.equal(candidates.some((value) => /job\s*board|other/i.test(value)), false);
  assert.deepEqual(referralSourceOptionCandidates('Company website', jobBoardEvidence), [
    'Job board',
    'Job Board',
    'Online job board',
  ]);
});

test('specific non-site sources remain available when no packet evidence exists', () => {
  assert.equal(referralSourceForApplication(' LinkedIn '), 'LinkedIn');
  assert.equal(referralSourceForApplication('University event'), 'University event');
  assert.deepEqual(referralSourceOptionCandidates('LinkedIn'), ['LinkedIn']);
  assert.deepEqual(referralSourceOptionCandidates('Careers'), []);
});
