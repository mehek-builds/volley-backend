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
  ledgerUnverifiedPressRecord,
  legacyUnverifiedPressDecision,
  legacyUnverifiedSubmissionRecord,
  packetLedgerSummary,
  readPacketAttempts,
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
    assert.equal(decision.confirmOpening, null, 'a reconstructed open is not a press to confirm');
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

  test('a ledger press with no lease and no outcome is answered, not refused', () => {
    const pressed = event({ id: 'p1', event_id: 'p1', event_kind: 'press_observed', source: 'managed_browser', evidence_code: 'submit_pressed' });
    for (const found of [true, false]) {
      const decision = legacyUnverifiedPressDecision({ current, pending, found, events: [event({}), pressed], now: NOW });
      assert.equal(decision.kind, 'resolve', `found=${found}: a press with no live lease and no confirmation is hers to answer`);
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
    // cwd-relative like every other source-reading test: tsconfig.api.json compiles this tree as CommonJS.
    const source = await readFile('src/routes/applications.ts', 'utf8');
    assert.match(
      source,
      /const pending = current\.unverified_submission\s*\?\? legacyUnverifiedSubmissionRecord\(current\)\s*\?\? \(packetEvents \? ledgerUnverifiedPressRecord\(current, packetEvents\) : null\);/,
      'the resolution route reads the prose, then the ledger, where the record is absent',
    );
    assert.match(
      source,
      /if \(pending\.legacy_prose \|\| pending\.ledger_attempt\) \{[\s\S]*?submissionBoundaryAuthorization\(userId, attempt\.attemptId, \{ executor: tx \}\)[\s\S]*?legacyUnverifiedPressDecision\(\{[\s\S]*?leases,/,
      'the packet-level arm reads every pressed attempt’s lease and decides through the one tested function',
    );
    assert.match(
      source,
      /kind: 'packet_press_refused' as const, decision, ledger: packetLedgerSummary\(events\)/,
      'a refusal carries the ledger it is naming',
    );
    assert.match(source, /code: 'UNVERIFIED_PACKET_PRESS_REFUSED',/);
    assert.match(
      source,
      /eventId: submissionAttemptEventId\(decision\.confirmOpening\.attempt_id, 'submission_confirmed', 'applicant-found-submission'\)/,
      '"found it" over one press confirms that press in the ledger',
    );
    assert.match(source, /'\/applications\/:id\/submission\/attempts',/, 'the ledger is readable by its owner');
    const getRoute = source.slice(source.indexOf("'/applications/:id/submission',"));
    const getBody = getRoute.slice(0, getRoute.indexOf('return reply.send({'));
    assert.match(
      getBody,
      /const legacyUnverified = legacyUnverifiedSubmissionRecord\(review\)\s*\?\? \(review\.status === 'needs_attention'[\s\S]*?ledgerUnverifiedPressRecord\(review, await submissionAttemptEventsForPacket\([\s\S]*?if \(legacyUnverified\) review = \{ \.\.\.review, unverified_submission: legacyUnverified \};/,
      'the read publishes either reading in the field the dashboard card reads',
    );
  });
});

/* THE PRESS THE ROW FORGOT. Fixture: Notion a4b7295c on 2026-09-05 - refused for "already pressed
 * Send on ... at Notion" with no record on the row and no claim, so only the ledger knows. */
describe('the press the row forgot is read from the ledger and answered', () => {
  const NOTION_URL = 'https://jobs.ashbyhq.com/notion/3fba1c39-c5cb-47d7-9ad2-1cec4d7e9d0c/application';
  const PRESSED_AT = new Date('2026-09-04T22:40:12.000Z');
  const pressedAttempt = 'c2222222-c4cc-414d-9a44-c7943d8effb9';
  /* One attempt's events share their binding (run, claim, packet version, posting), as the ledger's
   * own consistency rule requires; a fixture that forgets that classifies as invalid_sequence. */
  const notionEvent = (overrides: Partial<SubmissionAttemptEventRecord>) => event({
    attempt_id: pressedAttempt,
    source: 'managed_browser',
    portal_url: NOTION_URL,
    company_name: 'Notion',
    role: 'Software Engineer Intern (Summer 2027)',
    company_role: 'notion::software engineer intern (summer 2027)',
    job_id: '3fba1c39-c5cb-47d7-9ad2-1cec4d7e9d0c',
    submission_run_id: 'run-notion',
    submission_claim_id: pressedAttempt,
    packet_version: 'e'.repeat(64),
    ...overrides,
  });
  const pressedEvents = [
    notionEvent({ id: 'n1', event_id: 'n1', observed_at: new Date('2026-09-04T22:39:00.000Z'), created_at: new Date('2026-09-04T22:39:00.000Z') }),
    notionEvent({ id: 'n2', event_id: 'n2', event_kind: 'boundary_authorized', evidence_code: 'final_submission_boundary', boundary_activation_id: 'act-1', boundary_expires_at: new Date('2026-09-04T22:45:00.000Z'), observed_at: new Date('2026-09-04T22:40:00.000Z'), created_at: new Date('2026-09-04T22:40:00.000Z') }),
    notionEvent({ id: 'n3', event_id: 'n3', event_kind: 'press_observed', evidence_code: 'submit_pressed', observed_at: PRESSED_AT, created_at: PRESSED_AT }),
  ];
  const notionRow = deepgramLegacyRow({
    portal_url: NOTION_URL,
    attention_reason: 'Not sent: Litos already pressed Send on Software Engineer Intern (Summer 2027) at Notion and could not confirm what came back.',
    submission_run_id: undefined,
  });

  test('the newest press without an outcome names the record', () => {
    const record = ledgerUnverifiedPressRecord(notionRow, pressedEvents);
    assert.deepEqual(record, {
      at: PRESSED_AT.toISOString(),
      cause: 'no_confirmation_state',
      portal_url: NOTION_URL,
      submission_run_id: 'run-notion',
      ledger_attempt: pressedAttempt,
    });
    assert.equal(legacyUnverifiedSubmissionRecord(notionRow), null, 'the duplicate sentence is not the legacy sentence');
  });

  test('nothing is read where nothing pressed, where the row already knows, or where a confirmation stands', () => {
    assert.equal(ledgerUnverifiedPressRecord(notionRow, [event({})]), null, 'a reconstructed open is not a press');
    assert.equal(ledgerUnverifiedPressRecord(notionRow, []), null);
    assert.equal(
      ledgerUnverifiedPressRecord(deepgramLegacyRow({ unverified_submission: { at: NOW, cause: 'run_timed_out' } }), pressedEvents),
      null,
      'a row that carries its own record is answered on that record',
    );
    const confirmed = [...pressedEvents, notionEvent({ id: 'n4', event_id: 'n4', event_kind: 'submission_confirmed', evidence_code: 'managed_application_receipt', observed_at: new Date('2026-09-04T22:41:00.000Z'), created_at: new Date('2026-09-04T22:41:00.000Z') })];
    assert.equal(ledgerUnverifiedPressRecord(notionRow, confirmed), null, 'a confirmed attempt is owed a projection, not a question');
  });

  test('"it is not there" closes the press once its lease has lapsed', () => {
    const pending = ledgerUnverifiedPressRecord(notionRow, pressedEvents)!;
    const lapsed = new Map([[pressedAttempt, { active: false, expiresAt: '2026-09-04T22:45:00.000Z' }]]);
    const decision = legacyUnverifiedPressDecision({ current: notionRow, pending, found: false, events: pressedEvents, leases: lapsed, now: NOW });
    assert.equal(decision.kind, 'resolve');
    if (decision.kind !== 'resolve') return;
    assert.deepEqual(decision.closeOpenings.map((opening) => opening.attempt_id), [pressedAttempt]);
    assert.equal(decision.confirmOpening, null);
    assert.equal(decision.review.unverified_submission?.resolution, 'not_sent');
    assert.equal(decision.review.unverified_submission?.ledger_attempt, pressedAttempt);
  });

  test('a live employer lease is waited for, exactly as the row-bound arm waits', () => {
    const pending = ledgerUnverifiedPressRecord(notionRow, pressedEvents)!;
    const live = new Map([[pressedAttempt, { active: true, expiresAt: '2026-09-05T03:30:00.000Z' }]]);
    for (const found of [true, false]) {
      assert.deepEqual(
        legacyUnverifiedPressDecision({ current: notionRow, pending, found, events: pressedEvents, leases: live, now: NOW }),
        { kind: 'lease_active', expiresAt: '2026-09-05T03:30:00.000Z' },
        `found=${found}`,
      );
    }
  });

  test('"I found it there" confirms the one press, and refuses to guess between two', () => {
    const pending = ledgerUnverifiedPressRecord(notionRow, pressedEvents)!;
    const one = legacyUnverifiedPressDecision({ current: notionRow, pending, found: true, events: pressedEvents, now: NOW });
    assert.equal(one.kind, 'resolve');
    if (one.kind !== 'resolve') return;
    assert.equal(one.confirmOpening?.attempt_id, pressedAttempt);
    assert.equal(one.review.status, 'submitted');
    assert.equal(one.pipelineStage, 'applied');
    const secondPress = 'd3333333-c4cc-414d-9a44-c7943d8effb9';
    const two = [
      ...pressedEvents,
      notionEvent({ id: 'm1', event_id: 'm1', attempt_id: secondPress, submission_claim_id: secondPress, submission_run_id: 'run-notion-2', observed_at: new Date('2026-09-05T01:00:00.000Z'), created_at: new Date('2026-09-05T01:00:00.000Z') }),
      notionEvent({ id: 'm2', event_id: 'm2', attempt_id: secondPress, submission_claim_id: secondPress, submission_run_id: 'run-notion-2', event_kind: 'press_observed', evidence_code: 'submit_pressed', observed_at: new Date('2026-09-05T01:01:00.000Z'), created_at: new Date('2026-09-05T01:01:00.000Z') }),
    ];
    const twoPending = ledgerUnverifiedPressRecord(notionRow, two)!;
    assert.equal(twoPending.ledger_attempt, secondPress, 'the newest press names the record');
    assert.deepEqual(
      legacyUnverifiedPressDecision({ current: notionRow, pending: twoPending, found: true, events: two, now: NOW }),
      { kind: 'authority_conflict', conflict: 'ambiguous_press' },
    );
    const notThere = legacyUnverifiedPressDecision({ current: notionRow, pending: twoPending, found: false, events: two, now: NOW });
    assert.equal(notThere.kind, 'resolve');
    if (notThere.kind === 'resolve') {
      assert.deepEqual(notThere.closeOpenings.map((opening) => opening.attempt_id).sort(), [pressedAttempt, secondPress].sort(), '"not there" closes both presses');
    }
  });

  test('a confirmation anywhere on the packet refuses either answer', () => {
    const confirmed = [...pressedEvents, notionEvent({ id: 'n4', event_id: 'n4', event_kind: 'submission_confirmed', evidence_code: 'managed_application_receipt', observed_at: new Date('2026-09-04T22:41:00.000Z'), created_at: new Date('2026-09-04T22:41:00.000Z') })];
    const pending = legacyUnverifiedSubmissionRecord(deepgramLegacyRow())!;
    for (const found of [true, false]) {
      assert.deepEqual(
        legacyUnverifiedPressDecision({ current: deepgramLegacyRow(), pending, found, events: confirmed, now: NOW }),
        { kind: 'authority_conflict', conflict: 'confirmed' },
        `found=${found}`,
      );
    }
  });

  test('the ledger summary says what each attempt is, in order', () => {
    const summary = packetLedgerSummary([...pressedEvents, event({})]);
    assert.deepEqual(summary.map((attempt) => [attempt.attempt_id, attempt.source, attempt.safety]), [
      ['a3578398-c4cc-414d-9a44-c7943d8effb9', 'legacy_backfill', 'blocked_unverified:opened'],
      [pressedAttempt, 'managed_browser', 'blocked_unverified:pressed'],
    ]);
    assert.deepEqual(summary[1]!.events.map((entry) => entry.kind), ['attempt_opened', 'boundary_authorized', 'press_observed']);
    assert.equal(readPacketAttempts(pressedEvents)[0]!.pressed, true);
    /* A press whose sequence the ledger cannot fully validate is still a press: "a real or ambiguous
       send", as the duplicate guard already reads it. */
    const torn = [pressedEvents[0]!, event({ id: 'n3', event_id: 'n3', attempt_id: pressedAttempt, event_kind: 'press_observed', evidence_code: 'submit_pressed', observed_at: PRESSED_AT, created_at: PRESSED_AT })];
    const tornReading = readPacketAttempts(torn)[0]!;
    assert.equal(tornReading.safety.kind === 'blocked_unverified' && tornReading.safety.reason, 'invalid_sequence');
    assert.equal(tornReading.pressed, true);
  });
});
