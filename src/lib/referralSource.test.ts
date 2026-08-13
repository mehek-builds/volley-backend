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
    'Job boards',
    'Job Boards',
    'Online job board',
    'Online Job Board',
    'Online job boards',
    'Internet job board',
    'Job site',
    'Job Site',
    'Job posting',
    'Job Posting',
    'Online job posting',
    'Online job search',
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
    'Job boards',
    'Job Boards',
    'Online job board',
    'Online Job Board',
    'Online job boards',
    'Internet job board',
    'Job site',
    'Job Site',
    'Job posting',
    'Job Posting',
    'Online job posting',
    'Online job search',
  ]);
});

test('specific non-site sources remain available when no packet evidence exists', () => {
  assert.equal(referralSourceForApplication(' LinkedIn '), 'LinkedIn');
  assert.equal(referralSourceForApplication('University event'), 'University event');
  assert.deepEqual(referralSourceOptionCandidates('LinkedIn'), ['LinkedIn']);
  assert.deepEqual(referralSourceOptionCandidates('Careers'), []);
});

/* "How did you hear about us?" is the single most repeated blocker in the corpus, and the answer
 * has been on the profile the whole time. Three spellings was not a ladder: Old Mission refused
 * "Job board" on 2026-08-13 with the stored answer sitting right there. */
test('the job board ladder carries the spellings employers print, and no named third party', () => {
  const evidence = { kind: 'litos_job_board', value: 'Job board' } as never;
  const candidates = referralSourceOptionCandidates('Job board', evidence);

  for (const spelling of ['Job board', 'Job Boards', 'Online job board', 'Job posting', 'Job site']) {
    assert.ok(candidates.includes(spelling), `must offer "${spelling}"`);
  }

  /* THE HALF THAT MATTERS MORE. Each of these would clear a required field and each is a DIFFERENT
   * statement about where she found the role. A spelling variant of the truth is allowed here; a
   * new claim is not. */
  for (const named of ['LinkedIn', 'Indeed', 'Handshake', 'Glassdoor', 'University career fair',
    'Employee referral', 'Recruiter', 'Campus event', 'Company website']) {
    assert.ok(!candidates.includes(named), `must never offer "${named}"`);
  }

  // The evidence guard is untouched: no job-board claim without job-board evidence.
  assert.deepEqual(referralSourceOptionCandidates('Job board', undefined), []);
});
