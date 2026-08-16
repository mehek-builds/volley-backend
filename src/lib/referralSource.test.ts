import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCompanySiteReferralClaim,
  isJobBoardReferralClaim,
  referralSourceForApplication,
  referralSourceOptionCandidates,
  genericJobBoardOption,
  otherReferralOption,
  REFERRAL_OTHER_DETAIL,
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

const JOB_BOARD_LADDER = [
  'Job board',
  'Job Board',
  'Job boards',
  'Online job board',
  'Online Job Board',
  'Job site',
  'Job search site',
  'Job posting site',
];

test('a stored job-board default is answerable on its own, with or without packet evidence', () => {
  assert.equal(isJobBoardReferralClaim('Job Board'), true);
  assert.deepEqual(referralSourceOptionCandidates('Job board', jobBoardEvidence), JOB_BOARD_LADDER);
  // The behaviour this file used to assert was []. Requiring per-packet evidence on top of the
  // stored default meant almost every packet discarded her answer before comparing any option, and
  // "how did you hear about us" became the largest single blocker on the owner's queue. A stored
  // default IS the declaration; relaying it is what selfDeclaration.ts permits.
  assert.deepEqual(referralSourceOptionCandidates('Job board'), JOB_BOARD_LADDER);
  // Still never drifts into a different acquisition claim.
  assert.equal(
    referralSourceOptionCandidates('Job board', jobBoardEvidence).some((value) => /website|career|other/i.test(value)),
    false,
  );
});

test('the generic job-board option is read off the employer list, and a qualified one is refused', () => {
  assert.equal(genericJobBoardOption(['Referral', 'Job board', 'Career fair']), 'Job board');
  assert.equal(genericJobBoardOption(['Online Job Board', 'Employee referral']), 'Online Job Board');
  // Jane Street, read live read-only 2026-08-16: 128 options, no generic entry, and the only
  // near-match is qualified. Choosing it would tell the employer she came through USC's board.
  assert.equal(genericJobBoardOption(['3Blue1Brown', 'University job board', 'VLDB']), undefined);
  for (const named of ['LinkedIn job board', 'Handshake job board', 'Company job board', 'College job board']) {
    assert.equal(genericJobBoardOption(['Referral', named]), undefined, named);
  }
  // Ambiguity is not resolved by picking the first.
  assert.equal(genericJobBoardOption(['Job board', 'Job site']), undefined);
});

test('Other is found only as written, and is never preferred over a job-board entry', () => {
  assert.equal(otherReferralOption(['Referral', 'Other']), 'Other');
  assert.equal(otherReferralOption(['Other (please specify)']), 'Other (please specify)');
  assert.equal(otherReferralOption(['Referral', 'Career fair']), undefined);
  // "Mother" and "Other duties" must not be mistaken for the Other entry.
  assert.equal(otherReferralOption(['Mother', 'Other duties as assigned']), undefined);
  assert.equal(REFERRAL_OTHER_DETAIL, 'Litos');
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
  assert.deepEqual(referralSourceOptionCandidates('Company website', jobBoardEvidence), JOB_BOARD_LADDER);
});

test('specific non-site sources remain available when no packet evidence exists', () => {
  assert.equal(referralSourceForApplication(' LinkedIn '), 'LinkedIn');
  assert.equal(referralSourceForApplication('University event'), 'University event');
  assert.deepEqual(referralSourceOptionCandidates('LinkedIn'), ['LinkedIn']);
  assert.deepEqual(referralSourceOptionCandidates('Careers'), []);
});
