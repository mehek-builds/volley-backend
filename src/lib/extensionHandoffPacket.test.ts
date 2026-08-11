import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationReviewState } from './applicationReview';
import {
  createDashboardHandoffBinding,
  extensionHandoffPacketMatches,
  extensionHandoffVersion,
  extensionStartHandoffBinding,
  verifiedDashboardHandoffUrl,
} from './extensionHandoffPacket';
import {
  BAMBOOHR_ATTENDED_GATE_REASON,
  CAPTCHA_BLOCKER,
  ICIMS_ATTENDED_GATE_REASON,
  JOBVITE_ATTENDED_GATE_REASON,
  MANAGED_NETWORK_ACCESS_RESTRICTION_REASON,
  ORACLE_ATTENDED_GATE_REASON,
  SAP_SUCCESSFACTORS_CAPTURE_REQUIRED_REASON,
  UKG_CAPTURE_REQUIRED_REASON,
} from './portalSubmission';

const SEEKA_POSTING = 'https://jobs.smartrecruiters.com/SeekaTechnology/744000063648206-software-engineer-internship';
const SEEKA_FORM = 'https://jobs.smartrecruiters.com/oneclick-ui/company/SeekaTechnology/publication/123e4567-e89b-12d3-a456-426614174000';

function dashboardInput<T extends {
  frozenUrl: string;
  frozenHandoffUrl: string;
  frozenAtsName: string;
  attentionReason?: string;
  attentionCategories?: ApplicationReviewState['attention_categories'];
}>(input: T) {
  const applicationId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';
  return {
    ...input,
    applicationId,
    userId,
    frozenHandoffBinding: createDashboardHandoffBinding({ applicationId, userId, ...input }),
  };
}

test('the exact SEEKA posting may continue to its same-employer SmartRecruiters form', () => {
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: SEEKA_POSTING,
    frozenHandoffUrl: SEEKA_FORM,
    currentUrl: SEEKA_FORM,
    frozenAtsName: 'smartrecruiters',
    status: 'needs_attention' as const,
    attentionReason: MANAGED_NETWORK_ACCESS_RESTRICTION_REASON,
  }), true);
});

test('a managed SmartRecruiters CAPTCHA plus evidence gap may continue only on its exact frozen form', () => {
  const attentionReason = [
    CAPTCHA_BLOCKER,
    'Litos could not verify that the application form loaded.',
  ].join('\n');
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: SEEKA_POSTING,
    frozenHandoffUrl: SEEKA_FORM,
    currentUrl: SEEKA_FORM,
    frozenAtsName: 'smartrecruiters',
    status: 'needs_attention',
    attentionReason,
  }), true);
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: SEEKA_POSTING,
    frozenHandoffUrl: SEEKA_FORM,
    currentUrl: SEEKA_POSTING,
    frozenAtsName: 'smartrecruiters',
    status: 'needs_attention',
    attentionReason,
  }), false);
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: SEEKA_POSTING,
    frozenHandoffUrl: SEEKA_FORM,
    currentUrl: SEEKA_FORM.replace('123e4567-e89b-12d3-a456-426614174000', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
    frozenAtsName: 'smartrecruiters',
    status: 'needs_attention',
    attentionReason,
  }), false);
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: SEEKA_POSTING,
    frozenHandoffUrl: SEEKA_FORM,
    currentUrl: SEEKA_FORM,
    frozenAtsName: 'smartrecruiters',
    status: 'ready_for_final_approval',
    attentionReason,
  }), false);
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: SEEKA_POSTING,
    frozenHandoffUrl: SEEKA_FORM,
    currentUrl: SEEKA_FORM,
    frozenAtsName: 'smartrecruiters',
    status: 'needs_attention',
    attentionReason,
    submissionClaimedAt: '2026-08-10T00:00:00.000Z',
  }), false);
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: SEEKA_POSTING,
    frozenHandoffUrl: SEEKA_FORM,
    currentUrl: SEEKA_FORM,
    frozenAtsName: 'smartrecruiters',
    status: 'needs_attention',
    attentionReason: `Prefix: ${CAPTCHA_BLOCKER}`,
  }), false);
});

test('a CAPTCHA reason does not broaden attended recovery for another ATS', () => {
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: 'https://jobs.lever.co/acme/abc123',
    frozenHandoffUrl: 'https://jobs.lever.co/acme/abc123/apply',
    currentUrl: 'https://jobs.lever.co/acme/abc123/apply',
    frozenAtsName: 'lever',
    status: 'needs_attention',
    attentionReason: CAPTCHA_BLOCKER,
  }), false);
});

test('Jobvite attended recovery requires the exact measured gate URL and typed cause', () => {
  const job = 'https://jobs.jobvite.com/worldfirst/job/oknrAfws/apply';
  const input = {
    frozenUrl: job,
    frozenHandoffUrl: job,
    currentUrl: job,
    frozenAtsName: 'jobvite',
    status: 'needs_attention' as const,
    attentionReason: JOBVITE_ATTENDED_GATE_REASON,
  };
  assert.equal(extensionHandoffPacketMatches(input), true);
  assert.equal(extensionHandoffPacketMatches({ ...input, frozenHandoffUrl: undefined }), false);
  assert.equal(extensionHandoffPacketMatches({ ...input, attentionReason: 'The form was not reached' }), false);
  assert.equal(extensionHandoffPacketMatches({
    ...input,
    currentUrl: 'https://jobs.jobvite.com/worldfirst/job/oknrAfwt/apply',
  }), false);
});

test('iCIMS attended recovery requires the exact measured login URL and typed cause', () => {
  const login = 'https://jobs-express.icims.com/jobs/48173/sales-associate/login';
  const input = dashboardInput({
    frozenUrl: 'https://jobs-express.icims.com/jobs/48173/sales-associate/job',
    frozenHandoffUrl: login,
    currentUrl: login,
    frozenAtsName: 'icims',
    status: 'needs_attention' as const,
    attentionReason: ICIMS_ATTENDED_GATE_REASON,
  });
  assert.equal(extensionHandoffPacketMatches(input), true);
  assert.equal(extensionHandoffPacketMatches({ ...input, frozenHandoffUrl: undefined }), false);
  assert.equal(extensionHandoffPacketMatches({ ...input, attentionReason: 'Litos could not verify the exact account gate' }), false);
  assert.equal(extensionHandoffPacketMatches({
    ...input,
    currentUrl: 'https://jobs-express.icims.com/jobs/48174/sales-associate/login',
  }), false);
});

test('Oracle attended recovery requires the exact measured email gate and typed cause', () => {
  const gate = 'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/333913/apply/email';
  const input = {
    frozenUrl: gate,
    frozenHandoffUrl: gate,
    currentUrl: gate,
    frozenAtsName: 'oraclecloud',
    status: 'needs_attention' as const,
    attentionReason: ORACLE_ATTENDED_GATE_REASON,
  };
  assert.equal(extensionHandoffPacketMatches(input), true);
  assert.equal(extensionHandoffPacketMatches({ ...input, frozenHandoffUrl: undefined }), false);
  assert.equal(extensionHandoffPacketMatches({ ...input, attentionReason: 'An emailed code is required' }), false);
  assert.equal(extensionHandoffPacketMatches({ ...input, currentUrl: gate.replace('/apply/email', '') }), false);
  assert.equal(extensionHandoffPacketMatches({ ...input, currentUrl: `${gate}?source=tracker` }), false);
  assert.equal(extensionHandoffPacketMatches({ ...input, currentUrl: `${gate}#authentication` }), false);
  assert.equal(extensionHandoffPacketMatches({ ...input, currentUrl: gate.replace('/333913/', '/333914/') }), false);
  assert.equal(extensionHandoffPacketMatches({
    ...input,
    currentUrl: gate.replace('eeho.fa.us2.oraclecloud.com', 'iawmqy.fa.ocs.oraclecloud.com'),
  }), false);
  assert.equal(extensionHandoffPacketMatches({ ...input, status: 'ready_for_final_approval' }), false);
  assert.equal(extensionHandoffPacketMatches({
    ...input,
    submissionClaimedAt: '2026-08-10T00:00:00.000Z',
  }), false);
});

test('UKG and SuccessFactors capture-needed states cannot disclose an attended packet', () => {
  for (const input of [
    {
      frozenUrl: 'https://recruiting.ultipro.com/WIN1014WINDQ/JobBoard/08eb8299-5b26-4208-adb7-897aa42c6959/OpportunityDetail?opportunityId=f6cd56f9-5b2f-4b53-9e86-2553b54524f9',
      frozenHandoffUrl: 'https://recruiting.ultipro.com/WIN1014WINDQ/JobBoard/08eb8299-5b26-4208-adb7-897aa42c6959/OpportunityDetail?opportunityId=f6cd56f9-5b2f-4b53-9e86-2553b54524f9',
      frozenAtsName: 'ultipro',
      attentionReason: UKG_CAPTURE_REQUIRED_REASON,
    },
    {
      frozenUrl: 'https://career2.successfactors.eu/portalcareer?company=southafr02&job_application=10516',
      frozenHandoffUrl: 'https://career2.successfactors.eu/portalcareer?company=southafr02&job_application=10516',
      frozenAtsName: 'sap_successfactors',
      attentionReason: SAP_SUCCESSFACTORS_CAPTURE_REQUIRED_REASON,
    },
  ]) assert.equal(extensionHandoffPacketMatches({
    ...input,
    currentUrl: input.frozenHandoffUrl,
    status: 'needs_attention',
  }), false);
});

test('dashboard handoff returns only an exact server-observed Jobvite gate with its typed cause', () => {
  const url = 'https://jobs.jobvite.com/worldfirst/job/oknrAfws/apply';
  const base = {
    frozenUrl: url,
    frozenHandoffUrl: url,
    frozenAtsName: 'jobvite',
    status: 'needs_attention' as const,
    attentionReason: JOBVITE_ATTENDED_GATE_REASON,
    attentionCategories: ['privacy_consent' as const],
  };
  const input = dashboardInput(base);
  assert.equal(verifiedDashboardHandoffUrl(input), url);
  assert.equal(verifiedDashboardHandoffUrl({ ...input, status: 'ready_to_submit' }), null);
  assert.equal(verifiedDashboardHandoffUrl({ ...input, submissionClaimedAt: '2026-08-11T00:00:00.000Z' }), null);
  assert.equal(verifiedDashboardHandoffUrl({ ...input, submissionClaimId: 'claim-1' }), null);
  assert.equal(verifiedDashboardHandoffUrl({ ...input, submissionPacketVersion: 'packet-1' }), null);
  assert.equal(verifiedDashboardHandoffUrl({ ...input, submissionAttemptedAt: '2026-08-11T00:00:00.000Z' }), null);
  assert.equal(verifiedDashboardHandoffUrl({ ...input, submittedAt: '2026-08-11T00:00:00.000Z' }), null);
  assert.equal(verifiedDashboardHandoffUrl({
    ...input,
    receipt: {
      confirmation_text: 'Application received',
      final_url: url,
      captured_at: '2026-08-11T00:00:00.000Z',
    },
  }), null);
  assert.equal(verifiedDashboardHandoffUrl({
    ...input,
    unverifiedSubmission: { at: '2026-08-11T00:00:00.000Z', cause: 'no_confirmation_state' },
  }), null);
  assert.equal(verifiedDashboardHandoffUrl({
    ...input,
    unverifiedSubmission: {
      at: '2026-08-11T00:00:00.000Z',
      cause: 'no_confirmation_state',
      resolution: 'sent',
      resolved_at: '2026-08-11T00:05:00.000Z',
    },
  }), null);
  assert.equal(verifiedDashboardHandoffUrl({
    ...input,
    unverifiedSubmission: {
      at: '2026-08-11T00:00:00.000Z',
      cause: 'no_confirmation_state',
      resolution: 'not_sent',
      resolved_at: '2026-08-11T00:05:00.000Z',
    },
  }), url);
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({ ...base, attentionCategories: ['account_login'] })), null);
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({
    ...base,
    attentionReason: `Prefix: ${JOBVITE_ATTENDED_GATE_REASON}`,
  })), null);
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({
    ...base,
    frozenHandoffUrl: 'https://jobs.jobvite.com/worldfirst/job/DIFFERENT/apply',
  })), null);
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({
    ...base,
    frozenHandoffUrl: 'https://jobs.jobvite.com/WorldFirst/job/oknrAfws/apply',
  })), null);
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({ ...base, frozenHandoffUrl: `${url}?source=tracker` })), null);
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({ ...base, frozenHandoffUrl: `${url}#application` })), null);
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({
    ...base,
    frozenHandoffUrl: url.replace('jobs.jobvite.com', 'jobs.jobvite.com:444'),
  })), null);
});

test('dashboard SmartRecruiters handoff returns only the exact frozen publication for an exact cause', () => {
  const reputation = dashboardInput({
    frozenUrl: SEEKA_POSTING,
    frozenHandoffUrl: SEEKA_FORM,
    frozenAtsName: 'smartrecruiters',
    status: 'needs_attention' as const,
    attentionReason: MANAGED_NETWORK_ACCESS_RESTRICTION_REASON,
    attentionCategories: ['evidence_gap' as const],
  });
  assert.equal(verifiedDashboardHandoffUrl(reputation), SEEKA_FORM);
  const captcha = dashboardInput({
    frozenUrl: SEEKA_POSTING,
    frozenHandoffUrl: SEEKA_FORM,
    frozenAtsName: 'smartrecruiters',
    status: 'needs_attention' as const,
    attentionReason: CAPTCHA_BLOCKER,
    attentionCategories: ['captcha'],
  });
  assert.equal(verifiedDashboardHandoffUrl(captcha), SEEKA_FORM);
  assert.equal(verifiedDashboardHandoffUrl({ ...reputation, frozenHandoffUrl: SEEKA_POSTING }), null);
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({
    frozenUrl: SEEKA_POSTING,
    frozenHandoffUrl: SEEKA_FORM,
    frozenAtsName: 'smartrecruiters',
    status: 'needs_attention' as const,
    attentionReason: CAPTCHA_BLOCKER,
    attentionCategories: ['evidence_gap'],
  })), null);
  assert.equal(verifiedDashboardHandoffUrl({
    ...reputation,
    frozenHandoffUrl: SEEKA_FORM.replace(
      '123e4567-e89b-12d3-a456-426614174000',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    ),
  }), null);
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({
    ...reputation,
    frozenHandoffUrl: `${SEEKA_FORM}?source=tracker`,
  })), null);
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({
    ...reputation,
    frozenHandoffUrl: `${SEEKA_FORM}#application`,
  })), null);
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({
    ...reputation,
    frozenHandoffUrl: SEEKA_FORM.replace('jobs.smartrecruiters.com', 'jobs.smartrecruiters.com:444'),
  })), null);
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({ ...reputation, frozenAtsName: 'jobvite' })), null);
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({
    ...reputation,
    attentionReason: `Temporary: ${MANAGED_NETWORK_ACCESS_RESTRICTION_REASON}`,
  })), null);
});

test('dashboard handoff binds iCIMS host and numeric job and denies Oracle', () => {
  const posting = 'https://jobs-express.icims.com/jobs/48173/sales-associate/job';
  const login = 'https://jobs-express.icims.com/jobs/48173/sales-associate/login';
  const input = dashboardInput({
    frozenUrl: posting,
    frozenHandoffUrl: login,
    frozenAtsName: 'icims',
    status: 'needs_attention' as const,
    attentionReason: ICIMS_ATTENDED_GATE_REASON,
    attentionCategories: ['account_login' as const, 'captcha' as const],
  });
  assert.equal(verifiedDashboardHandoffUrl(input), login);
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({
    ...input,
    frozenHandoffUrl: 'https://jobs-express.icims.com/jobs/48174/sales-associate/login',
  })), null);
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({
    ...input,
    frozenHandoffUrl: 'https://other-valid.icims.com/jobs/48173/sales-associate/login',
  })), null);
  const oracleGate = 'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/333913/apply/email';
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({
    frozenUrl: oracleGate,
    frozenHandoffUrl: oracleGate,
    frozenAtsName: 'oraclecloud',
    status: 'needs_attention' as const,
    attentionReason: ORACLE_ATTENDED_GATE_REASON,
    attentionCategories: ['account_login'],
  })), null);
});

test('dashboard handoff permits only the exact captured BambooHR CAPTCHA page', () => {
  const url = 'https://prentkeromich.bamboohr.com/careers/480';
  const input = dashboardInput({
    frozenUrl: url,
    frozenHandoffUrl: url,
    frozenAtsName: 'bamboohr',
    status: 'needs_attention' as const,
    attentionReason: BAMBOOHR_ATTENDED_GATE_REASON,
    attentionCategories: ['captcha' as const],
  });
  assert.equal(verifiedDashboardHandoffUrl(input), url);
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({
    ...input,
    frozenHandoffUrl: 'https://prentkeromich.bamboohr.com/careers/481',
  })), null);
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({
    ...input,
    frozenHandoffUrl: 'https://mpathic2.bamboohr.com/careers/99',
  })), null);
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({ ...input, attentionReason: CAPTCHA_BLOCKER })), null);
  assert.equal(verifiedDashboardHandoffUrl(dashboardInput({ ...input, attentionReason: 'CAPTCHA may require attention' })), null);
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

test('a legacy SmartRecruiters packet cannot use its posting URL as the attended form', () => {
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: SEEKA_POSTING,
    currentUrl: SEEKA_POSTING,
    frozenAtsName: 'smartrecruiters',
    status: 'ready_to_submit',
  }), false);
});

test('a managed SmartRecruiters recovery cannot substitute its posting URL for the frozen form', () => {
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl: SEEKA_POSTING,
    frozenHandoffUrl: SEEKA_FORM,
    currentUrl: SEEKA_POSTING,
    frozenAtsName: 'smartrecruiters',
    status: 'needs_attention',
    attentionReason: MANAGED_NETWORK_ACCESS_RESTRICTION_REASON,
  }), false);
});

test('SmartRecruiters refill is limited to an exact eligible attended-recovery state', () => {
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

test('generic path identity ignores tracking and fragments but never another job', () => {
  const frozenUrl = 'https://jobs.lever.co/acme/abc123';
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl,
    currentUrl: 'https://jobs.lever.co/acme/abc123/apply?lever-source=LinkedIn#application-form',
    frozenAtsName: 'lever',
    status: 'ready_to_submit',
  }), true);
  assert.equal(extensionHandoffPacketMatches({
    frozenUrl,
    currentUrl: 'https://jobs.lever.co/acme/different/apply?lever-source=LinkedIn#application-form',
    frozenAtsName: 'lever',
    status: 'ready_to_submit',
  }), false);
});

test('generic handoff versions normalize non-identity tracking state', () => {
  const packet = {
    applicationId: 'application-1',
    userId: 'user-1',
    resumeObjectKey: 'users/user-1/resumes/application-1.pdf',
    spec: { _review: { status: 'ready_to_submit' } },
    jobContext: { company: 'Acme' },
    currentUrl: 'https://jobs.lever.co/acme/abc123/apply',
  };
  const version = extensionHandoffVersion(packet);
  assert.equal(extensionHandoffVersion({
    ...packet,
    currentUrl: `${packet.currentUrl}?lever-source=LinkedIn#application-form`,
  }), version);
  assert.notEqual(extensionHandoffVersion({
    ...packet,
    currentUrl: 'https://jobs.lever.co/acme/different/apply?lever-source=LinkedIn#application-form',
  }), version);
});

test('Greenhouse path tracking normalizes to its token identity without crossing jobs', () => {
  const packet = {
    applicationId: 'application-1',
    userId: 'user-1',
    resumeObjectKey: 'users/user-1/resumes/application-1.pdf',
    spec: { _review: { status: 'ready_to_submit' } },
    jobContext: { company: 'Acme' },
    currentUrl: 'https://boards.greenhouse.io/acme/jobs/123456',
  };
  const version = extensionHandoffVersion(packet);
  assert.equal(extensionHandoffVersion({
    ...packet,
    currentUrl: `${packet.currentUrl}?gh_src=LinkedIn&utm_campaign=internships#application`,
  }), version);
  assert.notEqual(extensionHandoffVersion({
    ...packet,
    currentUrl: 'https://boards.greenhouse.io/acme/jobs/654321?gh_src=LinkedIn#application',
  }), version);
});

test('query and hash job identities survive tracking normalization', () => {
  const base = {
    applicationId: 'application-1',
    userId: 'user-1',
    resumeObjectKey: 'users/user-1/resumes/application-1.pdf',
    spec: { _review: { status: 'ready_to_submit' } },
    jobContext: { company: 'Acme' },
  };
  const identities = [
    [
      'https://www.comeet.co/jobs/ACME/ABC/apply?token=opaque-one',
      'https://www.comeet.co/jobs/ACME/ABC/apply?token=opaque-one&utm_source=test',
      'https://www.comeet.co/jobs/ACME/ABC/apply?token=opaque-two',
    ],
    [
      'https://recruiting.ultipro.com/WIN1014WINDQ/JobBoard/08eb8299-5b26-4208-adb7-897aa42c6959/OpportunityDetail?opportunityId=f6cd56f9-5b2f-4b53-9e86-2553b54524f9',
      'https://recruiting.ultipro.com/WIN1014WINDQ/JobBoard/08eb8299-5b26-4208-adb7-897aa42c6959/OpportunityDetail?opportunityId=f6cd56f9-5b2f-4b53-9e86-2553b54524f9&utm_source=test',
      'https://recruiting.ultipro.com/WIN1014WINDQ/JobBoard/08eb8299-5b26-4208-adb7-897aa42c6959/OpportunityDetail?opportunityId=4fc30c2a-e2b3-42e0-bcaf-7805f741c04a',
    ],
    [
      'https://www.serverlogic.com/wp-content/plugins/bullhorn-oscp/#/jobs/101',
      'https://www.serverlogic.com/wp-content/plugins/bullhorn-oscp/?utm_source=test#/jobs/101',
      'https://www.serverlogic.com/wp-content/plugins/bullhorn-oscp/#/jobs/202',
    ],
  ] as const;
  for (const [first, tracked, second] of identities) {
    const version = extensionHandoffVersion({ ...base, currentUrl: first });
    assert.match(version ?? '', /^[a-f0-9]{64}$/);
    assert.equal(extensionHandoffVersion({ ...base, currentUrl: tracked }), version);
    assert.notEqual(extensionHandoffVersion({ ...base, currentUrl: second }), version);
  }
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

test('SmartRecruiters CAPTCHA recovery keeps the immutable extension-start binding', () => {
  const attentionReason = [CAPTCHA_BLOCKER, 'The application form did not expose any fields.'].join('\n');
  const review = {
    portal_url: SEEKA_POSTING,
    extension_handoff_url: SEEKA_FORM,
    ats_name: 'smartrecruiters',
    status: 'needs_attention' as const,
    attention_reason: attentionReason,
  };
  const packet = {
    applicationId: 'application-1',
    userId: 'user-1',
    resumeObjectKey: 'users/user-1/resumes/application-1.pdf',
    spec: {
      summary: 'Tailored summary',
      _review: { ...review, questions: [{ question: 'Why?', answer: 'Because.' }] },
    },
    jobContext: { company: 'SEEKA Technology', role: 'Software Engineer Internship' },
    currentUrl: SEEKA_FORM,
    review,
  };
  const handoffVersion = extensionHandoffVersion(packet)!;
  const validate = (overrides: Partial<Parameters<typeof extensionStartHandoffBinding>[0]> = {}) => extensionStartHandoffBinding({
    ...packet,
    handoffVersion,
    ...overrides,
  });

  assert.equal(validate(), 'valid');
  assert.equal(validate({ currentUrl: SEEKA_POSTING }), 'mismatch');
  assert.equal(validate({ currentUrl: SEEKA_FORM.replace('123e4567-e89b-12d3-a456-426614174000', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee') }), 'mismatch');
  assert.equal(validate({ resumeObjectKey: `${packet.resumeObjectKey}.new` }), 'stale');
  assert.equal(validate({ spec: { ...packet.spec, summary: 'Changed after fetch' } }), 'stale');
  assert.equal(validate({
    spec: {
      ...packet.spec,
      _review: { ...packet.spec._review, questions: [{ question: 'Why?', answer: 'Changed.' }] },
    },
  }), 'stale');
  assert.equal(validate({ jobContext: { ...packet.jobContext, company: 'Other employer' } }), 'stale');
  assert.equal(validate({ review: { ...review, status: 'submitted' } }), 'mismatch');
  assert.equal(validate({ review: { ...review, submission_claimed_at: '2026-08-10T00:00:00.000Z' } }), 'mismatch');
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
