import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EMPLOYER_PAGE_CHECK_LIMIT,
  classifyEmployerPage,
  employerPageCheckDue,
  litosVerificationSentence,
  providerRecordSaysNothingLeft,
  runSubmissionVerificationSweep,
  unverifiedAutoDecision,
  type UnverifiedSubmissionRecord,
} from './submissionVerificationSweep';

const WORKABLE_URL = 'https://apply.workable.com/twgai/j/772CD136FF/apply';
const GREENHOUSE_URL = 'https://job-boards.greenhouse.io/embed/job_app?for=jumptrading&token=8002989';

function record(patch: Partial<UnverifiedSubmissionRecord> = {}): UnverifiedSubmissionRecord {
  return { at: '2026-09-05T13:14:21.038Z', cause: 'no_confirmation_state', portal_url: WORKABLE_URL, ...patch };
}

test('the stored bound 2xx settles an old unverified record as accepted, from the wire', () => {
  const decision = unverifiedAutoDecision(record({
    network: [{ method: 'POST', url: 'https://apply.workable.com/api/v1/jobs/772CD136FF/apply', status: 200, content_type: 'application/json', body_excerpt: '{"ok":true}' }],
  }), WORKABLE_URL);
  assert.equal(decision.kind, 'confirm');
  assert.equal((decision as { evidence: string }).evidence, 'employer_submit_response:workable:200');
});

test('a Greenhouse refusal code in a stored 2xx body is not an acceptance', () => {
  const decision = unverifiedAutoDecision(record({
    portal_url: GREENHOUSE_URL,
    network: [{ method: 'POST', url: 'https://boards.greenhouse.io/embed/jumptrading/jobs/8002989', status: 200, content_type: 'application/json', body_excerpt: '{"code":"invalid-attributes"}' }],
  }), GREENHOUSE_URL);
  assert.deepEqual(decision, { kind: 'no_verdict' });
});

test('the runner’s own record that nothing left the browser is named on the card, never closed on', () => {
  assert.equal(providerRecordSaysNothingLeft(record({ submit_request_seen: false }), WORKABLE_URL), 'submit_request_never_issued');
  // Traffic to the human-check vendor and nothing to the employer (the Rippling shape). A same-host
  // Cloudflare beacon is NOT that: pressReachedOnlyChallengePlatform counts any request to the
  // employer's own host as reaching it.
  assert.equal(providerRecordSaysNothingLeft(record({
    network: [{ method: 'POST', url: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/flow/ov1/x', status: 200 }],
  }), WORKABLE_URL), 'challenge_only_transport');
  assert.equal(providerRecordSaysNothingLeft(record({
    network: [{ method: 'POST', url: 'https://apply.workable.com/cdn-cgi/challenge-platform/h/g/jsd/oneshot/x', status: 200 }],
  }), WORKABLE_URL), null);
  // And neither one is a ledger decision: after boundary_authorized only the applicant's look or the
  // employer server's refusal may close an attempt (AUTHORIZATION_ADMISSIBLE_NOT_SENT_PROOFS).
  assert.deepEqual(unverifiedAutoDecision(record({ submit_request_seen: false }), WORKABLE_URL), { kind: 'no_verdict' });
  const sentence = litosVerificationSentence({ checks: [], providerRecord: 'submit_request_never_issued' });
  assert.match(sentence, /never produced a request to the employer’s server/);
  assert.match(sentence, /Nothing is needed from you/);
});

test('silence, an unbound binding, or an already-recorded resolution decide nothing', () => {
  assert.deepEqual(unverifiedAutoDecision(record(), WORKABLE_URL), { kind: 'no_verdict' });
  assert.deepEqual(unverifiedAutoDecision(record({ submit_request_seen: null }), WORKABLE_URL), { kind: 'no_verdict' });
  assert.deepEqual(unverifiedAutoDecision(record({ submit_request_seen: false, resolution: 'sent' }), WORKABLE_URL), { kind: 'no_verdict' });
});

test('the employer page is classified from what it shows, never from what Litos hopes', () => {
  assert.equal(classifyEmployerPage('AI Engineering Intern First name Last name Email Phone Resume/CV Submit application'), 'form_open_no_record');
  assert.equal(classifyEmployerPage('Thank you for applying! Your application has been received.'), 'receipt_visible');
  assert.equal(classifyEmployerPage('You have already applied for this position. First name Last name'), 'applied_marker');
  assert.equal(classifyEmployerPage('This job is no longer accepting applications.'), 'posting_closed');
  assert.equal(classifyEmployerPage('Loading'), 'unreadable');
  assert.equal(classifyEmployerPage(''), 'unreadable');
  // A receipt sentence beside a live form is the form talking about itself, not a receipt.
  assert.equal(classifyEmployerPage('Thank you for applying - fill in First name Last name Resume/CV'), 'form_open_no_record');
});

test('three looks at 5 minutes, 1 hour and a day, then the inbox reconciler alone', () => {
  const at = Date.parse('2026-09-05T13:00:00.000Z');
  const check = (outcome: 'form_open_no_record') => ({ checked_at: '2026-09-05T13:05:00.000Z', url: WORKABLE_URL, outcome });
  assert.equal(employerPageCheckDue(record({ at: new Date(at).toISOString() }), at + 4 * 60_000), false);
  assert.equal(employerPageCheckDue(record({ at: new Date(at).toISOString() }), at + 5 * 60_000), true);
  assert.equal(employerPageCheckDue(record({ at: new Date(at).toISOString(), employer_page_checks: [check('form_open_no_record')] }), at + 30 * 60_000), false);
  assert.equal(employerPageCheckDue(record({ at: new Date(at).toISOString(), employer_page_checks: [check('form_open_no_record')] }), at + 61 * 60_000), true);
  assert.equal(employerPageCheckDue(record({ at: new Date(at).toISOString(), employer_page_checks: Array.from({ length: EMPLOYER_PAGE_CHECK_LIMIT }, () => check('form_open_no_record')) }), at + 10 * 24 * 60 * 60_000), false);
});

test('the card reports what Litos did and asks nothing of the applicant', () => {
  const sentence = litosVerificationSentence({
    checks: [{ checked_at: '2026-09-05T13:19:00.000Z', url: WORKABLE_URL, outcome: 'form_open_no_record' }],
    portalUrl: WORKABLE_URL,
  });
  assert.match(sentence, /Litos re-read the employer’s page at 13:19 UTC/);
  assert.match(sentence, /shows no record of an application/);
  assert.match(sentence, /Nothing is needed from you/);
  assert.match(sentence, /2 more times/);
  assert.doesNotMatch(sentence, /Open .* and look/);
});

test('one packet’s failure is counted, not thrown, and the pass continues', async () => {
  const rows = [
    { id: 'p1', user_id: 'u1', spec: { _review: { status: 'needs_attention', submission_claim_id: 'c1', portal_url: WORKABLE_URL, unverified_submission: { at: new Date(Date.now() - 10 * 60_000).toISOString(), cause: 'no_confirmation_state', portal_url: WORKABLE_URL } } } },
  ];
  const summary = await runSubmissionVerificationSweep({}, {
    listCandidates: async () => rows,
    readPage: async () => { throw new Error('stratus is having a bad day'); },
    storeScreenshot: async () => ({ url: 'urn:test' }),
    reconcileInbox: async () => {},
    now: () => Date.now(),
  });
  assert.equal(summary.outcomes.page_check_failed, 1);
});

test('the sweep re-reads stored evidence first, looks at the page only when due, and reconciles each account once', async () => {
  const reads: string[] = [];
  const reconciled: string[] = [];
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  const rows = [
    { id: 'p1', user_id: 'u1', spec: { _review: { status: 'needs_attention', submission_claim_id: 'c1', portal_url: WORKABLE_URL, unverified_submission: { at, cause: 'no_confirmation_state', portal_url: WORKABLE_URL, resolution: 'not_sent' } } } },
    { id: 'p2', user_id: 'u1', spec: { _review: { status: 'needs_attention', submission_claim_id: 'c2', portal_url: WORKABLE_URL, unverified_submission: { at: new Date().toISOString(), cause: 'no_confirmation_state', portal_url: WORKABLE_URL } } } },
  ];
  const summary = await runSubmissionVerificationSweep({}, {
    listCandidates: async () => rows,
    readPage: async ({ url }) => { reads.push(url); return { title: '', url, text: 'First name Last name Resume/CV' }; },
    storeScreenshot: async () => ({ url: 'urn:test' }),
    reconcileInbox: async (userId) => { reconciled.push(userId); },
    now: () => Date.now(),
  });
  assert.equal(summary.scanned, 2);
  assert.equal(summary.outcomes.skipped, 1, 'a resolved record is left alone');
  assert.equal(summary.outcomes.not_due, 1, 'a press ten seconds old is not looked at yet');
  assert.deepEqual(reads, []);
  assert.deepEqual(reconciled, ['u1']);
});

test('retained-attempt confirmation is reloaded before any public page observation', async () => {
  const calls: string[] = [];
  const row = { id: 'p1', user_id: 'u1', spec: { _review: {
    status: 'needs_attention', submission_claim_id: 'c1',
    unverified_submission: record(),
  } } };
  const summary = await runSubmissionVerificationSweep({}, {
    listCandidates: async () => [row],
    recoverRetainedAttempt: async (id) => { calls.push(`recover:${id}`); },
    reloadPacket: async () => ({ ...row, spec: { _review: { status: 'submitted' } } }),
    readPage: async () => { throw new Error('A confirmed attempt must not open a page'); },
    reconcileInbox: async () => {},
  });
  assert.deepEqual(calls, ['recover:p1']);
  assert.equal(summary.outcomes.skipped, 1);
  assert.equal(summary.outcomes.page_check_failed, 0);
});

test('a retained recovery failure does not starve the following packet', async () => {
  const visited: string[] = [];
  const row = (id: string) => ({ id, user_id: 'u1', spec: { _review: {
    status: 'needs_attention', submission_claim_id: id, unverified_submission: record(),
  } } });
  const summary = await runSubmissionVerificationSweep({}, {
    listCandidates: async () => [row('p1'), row('p2')],
    recoverRetainedAttempt: async (id) => { visited.push(id); if (id === 'p1') throw new Error('temporary outage'); },
    reloadPacket: async () => ({ ...row('p2'), spec: { _review: { status: 'submitted' } } }),
    reconcileInbox: async () => {},
  });
  assert.deepEqual(visited, ['p1', 'p2']);
  assert.equal(summary.outcomes.error, 1);
  assert.equal(summary.outcomes.skipped, 1);
});
