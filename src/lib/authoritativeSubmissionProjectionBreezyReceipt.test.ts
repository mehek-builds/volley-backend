/* A BREEZY RECEIPT BINDS ITS ATTEMPT.
 *
 * Fixture: Bear Robotics b822b998, 2026-09-05T01:50:46Z. Frozen posting URL on the tenant host,
 * receipt at .../apply/submitted with Breezy's own success text. Before the tenant-host rule this
 * receipt fell through measuredPersistedReceiptMatchesOpening to false and the row was parked with
 * the employer's confirmation in hand.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  breezyPostingFromUrl,
  measuredPersistedReceiptMatchesOpening,
} from './authoritativeSubmissionProjection';
import type { SubmissionAttemptEventRecord } from './submissionAttemptLedger';

const BEAR_POSTING = 'https://bear-robotics.breezy.hr/p/b8d4995f6d23-software-engineering-intern-developer-productivity';
const BEAR_RECEIPT_URL = `${BEAR_POSTING}/apply/submitted`;
const BEAR_RECEIPT_TEXT = 'Application Submitted Your application has been submitted successfully. Good luck!';
const observedAt = new Date('2026-09-05T01:50:46.285Z');

function event(overrides: Partial<SubmissionAttemptEventRecord>): SubmissionAttemptEventRecord {
  return {
    id: '5e377281-7991-4c40-b4c7-10a85cc591ef',
    user_id: 'cf48e921-8543-466c-b51f-1598fd723235',
    application_id: '4c791631-0a5e-4a9a-9d8e-2b7f3c1d9e11',
    packet_id: 'b822b998-be14-452e-9e09-e5a7e48cbc97',
    event_id: '5e377281-7991-4c40-b4c7-10a85cc591ef',
    attempt_id: '28f6cd3b-13bc-41c5-ac57-76fa2ef46a2b',
    parent_attempt_id: null,
    event_kind: 'attempt_opened',
    source: 'managed_browser',
    operation: 'initial_submission',
    submission_run_id: '09dbd4fa-5492-4892-8cc3-a442c239f764',
    submission_claim_id: '28f6cd3b-13bc-41c5-ac57-76fa2ef46a2b',
    packet_version: 'f'.repeat(64),
    posting_key: null,
    job_id: null,
    company_role: 'bear robotics::software engineering intern, developer productivity',
    company_name: 'Bear Robotics',
    role: 'Software Engineering Intern, Developer Productivity',
    portal_url: BEAR_POSTING,
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
const confirmation = event({
  event_kind: 'submission_confirmed',
  evidence_code: 'managed_application_receipt',
});

describe('a Breezy receipt on the tenant host binds its attempt', () => {
  test('Bear Robotics: same tenant, same posting, the submitted route, Breezy’s exact text', () => {
    assert.equal(
      measuredPersistedReceiptMatchesOpening(opening, confirmation, BEAR_RECEIPT_URL, BEAR_RECEIPT_TEXT),
      true,
    );
  });

  test('a frozen /apply form URL binds the same receipt', () => {
    assert.equal(
      measuredPersistedReceiptMatchesOpening(
        event({ portal_url: `${BEAR_POSTING}/apply` }),
        confirmation,
        BEAR_RECEIPT_URL,
        BEAR_RECEIPT_TEXT,
      ),
      true,
    );
  });

  test('whitespace in the page reading does not break the exact text', () => {
    assert.equal(
      measuredPersistedReceiptMatchesOpening(
        opening,
        confirmation,
        BEAR_RECEIPT_URL,
        '  Application Submitted\n\nYour application has been submitted successfully.   Good luck!  ',
      ),
      true,
    );
  });

  test('anything but that does not', () => {
    const cases: [string, string, string][] = [
      ['another tenant', 'https://zinier.breezy.hr/p/b8d4995f6d23-software-engineering-intern-developer-productivity/apply/submitted', BEAR_RECEIPT_TEXT],
      ['another posting', 'https://bear-robotics.breezy.hr/p/0000000aaaaa-other-role/apply/submitted', BEAR_RECEIPT_TEXT],
      ['the apply form itself, before any press', `${BEAR_POSTING}/apply`, BEAR_RECEIPT_TEXT],
      ['the bare posting', BEAR_POSTING, BEAR_RECEIPT_TEXT],
      ['a required-field refusal still on the form', BEAR_RECEIPT_URL, 'One or more required fields above hasn’t been completed.'],
      ['Workable’s sentence on a Breezy route', BEAR_RECEIPT_URL, 'Your application has been submitted successfully.'],
      ['http', BEAR_RECEIPT_URL.replace('https://', 'http://'), BEAR_RECEIPT_TEXT],
    ];
    for (const [name, finalUrl, text] of cases) {
      assert.equal(measuredPersistedReceiptMatchesOpening(opening, confirmation, finalUrl, text), false, name);
    }
  });

  test('the jobs.breezy.hr aggregate and the marketing site are not tenant postings', () => {
    assert.equal(breezyPostingFromUrl('https://jobs.breezy.hr/bear-robotics/b8d4995f6d23'), null);
    assert.equal(breezyPostingFromUrl('https://breezy.hr/p/anything'), null);
    assert.equal(breezyPostingFromUrl('https://www.breezy.hr/p/anything'), null);
    assert.equal(breezyPostingFromUrl('https://a.b.breezy.hr/p/anything'), null);
    assert.deepEqual(breezyPostingFromUrl(BEAR_RECEIPT_URL), {
      tenant: 'bear-robotics',
      posting: 'b8d4995f6d23-software-engineering-intern-developer-productivity',
      route: 'submitted',
    });
  });
});
