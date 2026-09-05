/* AN ASHBY RECEIPT BINDS ITS ATTEMPT.
 *
 * Fixture: Deepgram 4ef78910, 2026-09-05T04:48:14Z. Frozen posting URL and receipt URL are the same
 * Ashby application route; the receipt text opens with Ashby's own success view and continues with
 * the employer's appended recruiter-impersonation notice. Before the Ashby arm this receipt fell
 * through measuredPersistedReceiptMatchesOpening to false and the row parked with the employer's
 * confirmation in hand.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  ashbyPostingFromUrl,
  measuredPersistedReceiptMatchesOpening,
} from './authoritativeSubmissionProjection';
import type { SubmissionAttemptEventRecord } from './submissionAttemptLedger';

const DEEPGRAM_URL = 'https://jobs.ashbyhq.com/deepgram/dc8693b5-72ce-4ca3-ab15-9c8434d35da1/application';
const DEEPGRAM_RECEIPT = 'Success Your application was successfully submitted. We\'ll contact you if there are next steps. '
  + 'Notice: We\'re aware of individuals impersonating Deepgram recruiters. All legitimate Deepgram recruiting '
  + 'communication comes from an @deepgram.com email address.';
const observedAt = new Date('2026-09-05T04:48:14.903Z');

function event(overrides: Partial<SubmissionAttemptEventRecord>): SubmissionAttemptEventRecord {
  return {
    id: '5e377281-7991-4c40-b4c7-10a85cc591ef',
    user_id: 'cf48e921-8543-466c-b51f-1598fd723235',
    application_id: '8c6485c4-1b6f-4874-a792-36cadd79ad77',
    packet_id: '4ef78910-b11b-47a8-878e-05fbc9fdf174',
    event_id: '5e377281-7991-4c40-b4c7-10a85cc591ef',
    attempt_id: 'cc90fb67-13bc-41c5-ac57-76fa2ef46a2b',
    parent_attempt_id: null,
    event_kind: 'attempt_opened',
    source: 'managed_browser',
    operation: 'initial_submission',
    submission_run_id: 'e2b8c1d0-5492-4892-8cc3-a442c239f764',
    submission_claim_id: 'cc90fb67-13bc-41c5-ac57-76fa2ef46a2b',
    packet_version: 'f'.repeat(64),
    posting_key: null,
    job_id: 'dc8693b5-72ce-4ca3-ab15-9c8434d35da1',
    company_role: 'deepgram::software engineering- internship (fall 2026/summer 2027)',
    company_name: 'deepgram',
    role: 'Software Engineering- Internship (Fall 2026/Summer 2027)',
    portal_url: DEEPGRAM_URL,
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

const opening = event({});
const confirmation = event({ event_kind: 'submission_confirmed', evidence_code: 'managed_application_receipt' });

describe('an Ashby receipt binds its attempt', () => {
  test('Deepgram: the same posting, Ashby’s success view, the employer’s notice appended', () => {
    assert.equal(measuredPersistedReceiptMatchesOpening(opening, confirmation, DEEPGRAM_URL, DEEPGRAM_RECEIPT), true);
  });

  test('the bare posting route and the application route are one posting; whitespace is not identity', () => {
    const bare = 'https://jobs.ashbyhq.com/deepgram/dc8693b5-72ce-4ca3-ab15-9c8434d35da1';
    assert.equal(measuredPersistedReceiptMatchesOpening(event({ portal_url: bare }), confirmation, DEEPGRAM_URL, DEEPGRAM_RECEIPT), true);
    assert.equal(
      measuredPersistedReceiptMatchesOpening(opening, confirmation, DEEPGRAM_URL, '  Success\n\nYour application was successfully submitted.  We\'ll contact you if there are next steps.'),
      true,
    );
  });

  test('anything but that does not', () => {
    const cases: [string, string, string][] = [
      ['another org', 'https://jobs.ashbyhq.com/notion/dc8693b5-72ce-4ca3-ab15-9c8434d35da1/application', DEEPGRAM_RECEIPT],
      ['another job', 'https://jobs.ashbyhq.com/deepgram/3fba1c39-c5cb-47d7-9ad2-1cec4d7e9d0c/application', DEEPGRAM_RECEIPT],
      ['the form still showing a validation error', DEEPGRAM_URL, '"Current Location" is required and is still empty'],
      ['the employer’s notice alone, without Ashby’s sentence', DEEPGRAM_URL, 'Notice: We\'re aware of individuals impersonating Deepgram recruiters.'],
      ['Ashby’s sentence buried after employer copy', DEEPGRAM_URL, 'Thanks for your interest. Success Your application was successfully submitted. We\'ll contact you if there are next steps.'],
      ['http', DEEPGRAM_URL.replace('https://', 'http://'), DEEPGRAM_RECEIPT],
    ];
    for (const [name, finalUrl, text] of cases) {
      assert.equal(measuredPersistedReceiptMatchesOpening(opening, confirmation, finalUrl, text), false, name);
    }
  });

  test('only jobs.ashbyhq.com/<org>/<uuid>[/application] is a posting', () => {
    assert.deepEqual(ashbyPostingFromUrl(DEEPGRAM_URL), { org: 'deepgram', jobId: 'dc8693b5-72ce-4ca3-ab15-9c8434d35da1', route: 'application' });
    assert.equal(ashbyPostingFromUrl('https://jobs.ashbyhq.com/deepgram'), null);
    assert.equal(ashbyPostingFromUrl('https://jobs.ashbyhq.com/deepgram/not-a-uuid/application'), null);
    assert.equal(ashbyPostingFromUrl('https://jobs.ashbyhq.com/deepgram/dc8693b5-72ce-4ca3-ab15-9c8434d35da1/apply'), null);
    assert.equal(ashbyPostingFromUrl('https://app.ashbyhq.com/deepgram/dc8693b5-72ce-4ca3-ab15-9c8434d35da1/application'), null);
  });
});
