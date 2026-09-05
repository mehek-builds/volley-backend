import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCompanySiteReferralClaim,
  isJobBoardReferralClaim,
  isReferralSourceQuestionLabel,
  jobBoardClosedListOption,
  referralSourceForApplication,
  referralSourceOptionCandidates,
  genericJobBoardOption,
  namedJobBoardOption,
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

/* THE DATABRICKS SHAPE: a list with no generic board entry and no "Other".
 *
 * Read live off Databricks' Greenhouse form on 2026-08-26, where a fully filled, audited packet
 * parked on this one required radio button. genericJobBoardOption abstains here on purpose
 * ("LinkedIn Job Posting" is a qualified board) and otherReferralOption has nothing to find, so
 * before namedJobBoardOption the ladder ran out and the question came back "left for you".
 */
const DATABRICKS_OPTIONS = [
  'LinkedIn Job Posting',
  'Recruiter Reach Out',
  'BrickFest',
  'School Career Fair and/or Event',
  'Referral from Employee',
  'Referral from Intern',
  'I am a previous Databricks intern',
];

test('the named board is taken when the list offers neither a generic board nor Other', () => {
  assert.equal(namedJobBoardOption(DATABRICKS_OPTIONS), 'LinkedIn Job Posting');
  // The two entries that would say it better are genuinely absent; that is what makes this reachable.
  assert.equal(genericJobBoardOption(DATABRICKS_OPTIONS), undefined);
  assert.equal(otherReferralOption(DATABRICKS_OPTIONS), undefined);
});

test('no claim she cannot make is ever reachable by name', () => {
  /* Each of these is a relationship that did not happen. A referral additionally routes the
   * application to a named employee and can pay that employee a bonus. */
  for (const option of [
    'Referral from Employee',
    'Referral from Intern',
    'Recruiter Reach Out',
    'I am a previous Databricks intern',
    'School Career Fair and/or Event',
    'BrickFest',
  ]) {
    assert.equal(namedJobBoardOption([option]), undefined, option);
  }
});

test('a board name attached to a person-channel is still refused', () => {
  // The board's own name in the string is not enough; the channel is what the entry claims.
  assert.equal(namedJobBoardOption(['LinkedIn Recruiter reached out']), undefined);
  assert.equal(namedJobBoardOption(['Referred by a LinkedIn connection']), undefined);
  assert.equal(namedJobBoardOption(['Indeed - employee referral']), undefined);
});

test('university-affiliated boards are not public boards', () => {
  // Handshake and a university board both assert she came through USC's careers channel.
  assert.equal(namedJobBoardOption(['Handshake']), undefined);
  assert.equal(namedJobBoardOption(['University job board']), undefined);
  assert.equal(namedJobBoardOption(['College Career Website']), undefined);
});

test('ambiguity abstains rather than guessing a board', () => {
  // Two boards named, or none: the question goes back to her, which is the honest outcome.
  assert.equal(namedJobBoardOption(['LinkedIn', 'Indeed']), undefined);
  assert.equal(namedJobBoardOption(['Recruiter Reach Out', 'Career Fair']), undefined);
  assert.equal(namedJobBoardOption([]), undefined);
});

test('the generic entry still wins when the list has one', () => {
  /* namedJobBoardOption must never PREEMPT the generic wording - it says more than her standing
   * answer does, so it is only correct when nothing states the fact more plainly. */
  const withGeneric = ['Job board', 'LinkedIn Job Posting', 'Referral from Employee'];
  assert.equal(genericJobBoardOption(withGeneric), 'Job board');
});

/* MEASURED 2026-09-05, account mehekmandal05@gmail.com, Greenhouse embed forms.
 *
 * Five Rings packet 2231fc73's question is "how did you first hear about five rings?" - the word
 * "first" sits between "you" and "hear", which the submissionRunner.ts and portalSubmission.ts
 * copies of "is this a referral question" had already drifted on before this predicate became their
 * one shared definition. isReferralSourceQuestionLabel must recognise this exact wording, or every
 * caller built on top of it (jobBoardClosedListOption's own consumers) never gets a chance to run. */
const FIVE_RINGS_REFERRAL_OPTIONS = [
  'Coffee Chat',
  'Conference',
  'GitHub',
  'Handshake',
  'LinkedIn',
  'Student Organization Newsletter or Event',
  'University Career Fair / Networking Event',
  'Word of Mouth',
  'Information Session',
  'Other',
];

test('isReferralSourceQuestionLabel recognises "first hear about" and "learned about" phrasing', () => {
  assert.equal(isReferralSourceQuestionLabel('how did you first hear about five rings?'), true);
  assert.equal(isReferralSourceQuestionLabel('How did you first hear about us?'), true);
  assert.equal(isReferralSourceQuestionLabel('where have you learned about this role?'), true);
  assert.equal(isReferralSourceQuestionLabel('how did you hear about us?'), true);
  assert.equal(isReferralSourceQuestionLabel('referral source'), true);
});

test('jobBoardClosedListOption: Five Rings list has no job-board wording, so "Job board" resolves to Other', () => {
  assert.equal(jobBoardClosedListOption('Job board', FIVE_RINGS_REFERRAL_OPTIONS), 'Other');
});

test('jobBoardClosedListOption: a list with neither a job-board wording nor Other leaves the claim unanswered', () => {
  // Notion's checkbox list: LinkedIn, Glassdoor, Notion Blog, Notion Employee, Notion Website,
  // Billboard/Outdoor Ads, Conference or Meetup. Picking LinkedIn or Glassdoor here would be a
  // claim she never made; the honest outcome is leaving it for her.
  const notionOptions = [
    'LinkedIn',
    'Glassdoor',
    'Notion Blog',
    'Notion Employee',
    'Notion Website',
    'Billboard/Outdoor Ads',
    'Conference or Meetup',
  ];
  assert.equal(jobBoardClosedListOption('Job board', notionOptions), undefined);
});

test('jobBoardClosedListOption: a generic job-board entry wins over Other', () => {
  assert.equal(jobBoardClosedListOption('Job board', ['LinkedIn', 'Referral', 'Online job board', 'Other']), 'Online job board');
});

test('jobBoardClosedListOption: Other is chosen over a same-list Referral entry, never Referral', () => {
  const result = jobBoardClosedListOption('Job board', ['Referral', 'Other', 'LinkedIn']);
  assert.equal(result, 'Other');
  assert.notEqual(result, 'Referral');
});

test('jobBoardClosedListOption refuses a non-job-board claim, whatever the list offers', () => {
  assert.equal(jobBoardClosedListOption('LinkedIn', ['Other', 'LinkedIn']), undefined);
  assert.equal(jobBoardClosedListOption(undefined, ['Other']), undefined);
});
