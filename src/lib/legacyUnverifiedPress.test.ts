/* THE PRESS THAT WAS ONLY EVER A SENTENCE, answered.
 *
 * Fixture: Deepgram packet 4bfd5827 as it stood on 2026-09-05. The 2026-08-11 runner pressed Send,
 * could not read a confirmation, and left one sentence in attention_reason. The duplicate guard read
 * that sentence and refused packet 4ef78910 on the same posting ("Litos already pressed Send on ...
 * at Deepgram"), and the exit it named - "tell Litos whether it is there" - did not exist for the
 * row: no card on the dashboard, 409 not_waiting from the route. These tests drive the reading and
 * the decision with the real review shape and real ledger event rows.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { describe } from 'node:test';
import type { ApplicationReviewState } from './applicationReview';
import { applicantFoundSubmissionReceiptText } from './authoritativeSubmissionProjection';
import { isLegacyUnverifiedAttemptReason } from './duplicateApplication';
import {
  LEGACY_PRESS_NOT_THERE_REASON,
  legacyUnverifiedPressDecision,
  legacyUnverifiedSubmissionRecord,
} from './legacyUnverifiedPress';
import type { SubmissionAttemptEventRecord } from './submissionAttemptLedger';

const DEEPGRAM_URL = 'https://jobs.ashbyhq.com/deepgram/dc8693b5-72ce-4ca3-ab15-9c8434d35da1/application';
const LEGACY_PROSE = 'The final submission was attempted, but Litos could not verify the employer confirmation. '
  + 'Check the employer portal before applying again.';
const ALIAS_DECIDED_AT = '2026-08-11T03:38:56.610Z';
const ROW_TOUCHED_AT = '2026-09-05T02:30:38.066Z';
const NOW = '2026-09-05T02:58:00.000Z';

function deepgramLegacyRow(extra: Partial<ApplicationReviewState> = {}): ApplicationReviewState {
  return {
    jd_text: 'Software Engineering- Internship (Fall 2026/Summer 2027)',
    status: 'needs_attention',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: ROW_TOUCHED_AT,
    portal_url: DEEPGRAM_URL,
    ats_name: 'ashby',
    submission_run_id: '2ccfd43a-644a-4cbc-bce0-5a958fd89ff4',
    attention_reason: LEGACY_PROSE,
    attention_categories: ['unknown'],
    applicant_email: {
      address: 'app-4bfd582755-59013929bff9@garaierkaa.resend.app',
      source: 'litos_alias',
      reason: 'deliverable',
      tracked: true,
      decided_at: ALIAS_DECIDED_AT,
    },
    ...extra,
  };
}

const observedAt = new Date('2026-08-27T14:11:35.408Z');

function event(overrides: Partial<SubmissionAttemptEventRecord>): SubmissionAttemptEventRecord {
  return {
    id: '5e377281-7991-4c40-b4c7-10a85cc591ef',
    user_id: 'cf48e921-8543-466c-b51f-1598fd723235',
    application_id: null,
    packet_id: '4bfd5827-5518-4fb6-8fae-4b79f3e0cde0',
    event_id: '5e377281-7991-4c40-b4c7-10a85cc591ef',
    attempt_id: 'a3578398-c4cc-414d-9a44-c7943d8effb9',
    parent_attempt_id: null,
    event_kind: 'attempt_opened',
    source: 'legacy_backfill',
    operation: 'initial_submission',
    submission_run_id: null,
    submission_claim_id: null,
    packet_version: null,
    posting_key: null,
    job_id: 'dc8693b5-72ce-4ca3-ab15-9c8434d35da1',
    company_role: 'deepgram::software engineering- internship (fall 2026/summer 2027)',
    company_name: 'Deepgram',
    role: 'Software Engineering- Internship (Fall 2026/Summer 2027)',
    portal_url: DEEPGRAM_URL,
    portal_identity: null,
    proof_kind: null,
    evidence_code: 'legacy_backfill_v1',
    boundary_activation_id: null,
    boundary_expires_at: null,
    observed_at: observedAt,
    created_at: observedAt,
    ...overrides,
  } as SubmissionAttemptEventRecord;
}

describe('the pre-ledger press is read as the record it described', () => {
  test('Deepgram 4bfd5827 publishes an unverified press she can answer', () => {
    const record = legacyUnverifiedSubmissionRecord(deepgramLegacyRow());
    assert.deepEqual(record, {
      at: ALIAS_DECIDED_AT,
      cause: 'no_confirmation_state',
      portal_url: DEEPGRAM_URL,
      submission_run_id: '2ccfd43a-644a-4cbc-bce0-5a958fd89ff4',
      legacy_prose: true,
    });
  });

  test('the old writer’s own press time wins over the alias decision when it exists', () => {
    const record = legacyUnverifiedSubmissionRecord(deepgramLegacyRow({
      submission_attempted_at: '2026-08-11T03:41:10.000Z',
    }));
    assert.equal(record?.at, '2026-08-11T03:41:10.000Z');
  });

  test('nothing else is read as one', () => {
    const modern = deepgramLegacyRow({
      unverified_submission: { at: NOW, cause: 'run_timed_out' },
    });
    assert.equal(legacyUnverifiedSubmissionRecord(modern), null, 'a modern record is its own authority');
    assert.equal(
      legacyUnverifiedSubmissionRecord(deepgramLegacyRow({ status: 'failed' })),
      null,
      'only the parked row is waiting on her',
    );
    assert.equal(
      legacyUnverifiedSubmissionRecord(deepgramLegacyRow({
        receipt: { confirmation_text: 'Thanks', final_url: DEEPGRAM_URL, captured_at: NOW, source: 'managed_browser' },
      })),
      null,
      'a receipt is evidence an employer holds something; not this question',
    );
    assert.equal(
      legacyUnverifiedSubmissionRecord(deepgramLegacyRow({
        attention_reason: '"Current Location" is required and is still empty',
      })),
      null,
      'a pre-submit stop is not a press',
    );
  });
});

describe('her answer over the pre-ledger press', () => {
  const current = deepgramLegacyRow();
  const pending = legacyUnverifiedSubmissionRecord(current)!;

  test('"it is not there" resolves the row and closes every reconstructed attempt that never reached the employer', () => {
    const neverReached = event({});
    const alreadyClosed = event({ attempt_id: 'b1111111-c4cc-414d-9a44-c7943d8effb9', id: 'b1', event_id: 'b1' });
    const alreadyClosedProof = event({
      attempt_id: 'b1111111-c4cc-414d-9a44-c7943d8effb9',
      id: 'b2',
      event_id: 'b2',
      event_kind: 'not_sent_proven',
      proof_kind: 'applicant_checked_not_sent',
      evidence_code: 'applicant_checked_not_sent',
    });
    const decision = legacyUnverifiedPressDecision({
      current,
      pending,
      found: false,
      events: [neverReached, alreadyClosed, alreadyClosedProof],
      now: NOW,
    });
    assert.equal(decision.kind, 'resolve');
    if (decision.kind !== 'resolve') return;
    assert.deepEqual(decision.closeOpenings, [neverReached], 'only the attempt with no proof yet is closed');
    assert.equal(decision.pipelineStage, null);
    const { review } = decision;
    assert.equal(review.status, 'needs_attention');
    assert.deepEqual(review.unverified_submission, { ...pending, resolution: 'not_sent', resolved_at: NOW });
    assert.equal(review.attention_reason, LEGACY_PRESS_NOT_THERE_REASON);
    assert.deepEqual(review.attention_categories, ['unverified_submission']);
    assert.equal(review.submission_claim_id, undefined);
    assert.equal(review.submission_claimed_at, undefined);
    /* The two arms of alreadyAtEmployer() that saw this row: the prose is gone, and the record it
       reads instead carries a resolution. Neither can refuse the next packet on the posting. */
    assert.equal(isLegacyUnverifiedAttemptReason(review.attention_reason), false);
    assert.equal(review.unverified_submission?.resolution, 'not_sent');
  });

  test('"I found it there" records the Sent marker with her receipt', () => {
    const decision = legacyUnverifiedPressDecision({ current, pending, found: true, events: [event({})], now: NOW });
    assert.equal(decision.kind, 'resolve');
    if (decision.kind !== 'resolve') return;
    assert.deepEqual(decision.closeOpenings, [], 'her word that it is there closes nothing as not sent');
    assert.equal(decision.pipelineStage, 'applied');
    const { review } = decision;
    assert.equal(review.status, 'submitted');
    assert.equal(review.submitted_at, NOW);
    assert.equal(review.attention_reason, undefined);
    assert.deepEqual(review.unverified_submission, { ...pending, resolution: 'sent', resolved_at: NOW });
    assert.deepEqual(review.receipt, {
      confirmation_text: applicantFoundSubmissionReceiptText(true),
      final_url: DEEPGRAM_URL,
      captured_at: NOW,
      source: 'attended_handoff',
    });
  });

  test('a ledger fact that the boundary was reached outranks the prose, for either answer', () => {
    const pressed = event({ id: 'p1', event_id: 'p1', event_kind: 'press_observed', source: 'managed_browser', evidence_code: 'submit_pressed' });
    for (const found of [true, false]) {
      const decision = legacyUnverifiedPressDecision({ current, pending, found, events: [event({}), pressed], now: NOW });
      assert.deepEqual(decision, { kind: 'authority_conflict' }, `found=${found}`);
    }
  });

  test('"I found it there" with no page to point at is refused rather than invented', () => {
    const noUrl = deepgramLegacyRow({ portal_url: undefined });
    const noUrlPending = legacyUnverifiedSubmissionRecord(noUrl)!;
    assert.equal(noUrlPending.portal_url, undefined);
    const decision = legacyUnverifiedPressDecision({ current: noUrl, pending: noUrlPending, found: true, events: [], now: NOW });
    assert.deepEqual(decision, { kind: 'authority_missing' });
  });
});

describe('the routes read the same record', () => {
  test('GET /submission publishes the card and POST /submission/unverified accepts the answer', async () => {
    const source = await readFile(new URL('../routes/applications.ts', import.meta.url), 'utf8');
    assert.match(
      source,
      /const pending = current\.unverified_submission \?\? legacyUnverifiedSubmissionRecord\(current\);/,
      'the resolution route reads the prose where the record is absent',
    );
    assert.match(
      source,
      /if \(pending\.legacy_prose\) \{[\s\S]*?legacyUnverifiedPressDecision\(\{/,
      'the legacy arm decides through the one tested function',
    );
    const getRoute = source.slice(source.indexOf("'/applications/:id/submission',"));
    const getBody = getRoute.slice(0, getRoute.indexOf('return reply.send({'));
    assert.match(
      getBody,
      /const legacyUnverified = legacyUnverifiedSubmissionRecord\(review\);\s*if \(legacyUnverified\) review = \{ \.\.\.review, unverified_submission: legacyUnverified \};/,
      'the read publishes the reading in the field the dashboard card reads',
    );
  });
});
