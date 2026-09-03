import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  SUBMISSION_AUTHORITY_REJECTED_FIELDS,
  submissionAuthorityPublicationForPacket,
  submissionAuthorityRefusalForWire,
  submissionAuthorityRefusalTallies,
  submissionAuthorityUnavailableMarker,
  type SubmissionAuthorityPublication,
  type SubmissionAuthorityRefusal,
} from '../lib/submissionAuthorityEnvelope';
import type { AuthoritativeSubmissionProjection } from '../lib/authoritativeSubmissionProjection';
import type { SubmissionAttemptRetrySafety } from '../lib/submissionAttemptLedger';

/**
 * GET /applications/board/authority-rejections, and the one promise it makes.
 *
 * #894 gave every shape-caused refusal a branch, a field and a shape, and put the record in two
 * server log lines. Litos serves from Railway and the environment this is debugged from has no log
 * reader, so the largest send blocker on the account - 163 of 200 cards refused on 2026-09-03, all
 * under the single word `unpublishable_projection` - stayed unreadable by the only person who could
 * act on it. This route is that record on a surface she can reach.
 *
 * THREE THINGS ARE PINNED HERE, in order of what they would cost if they broke:
 *
 *  1. A CARD THAT PUBLISHES TODAY PUBLISHES THE IDENTICAL BYTES. A quarantined card cannot be sent,
 *     which is the exact failure being diagnosed, so a diagnosis that could quarantine one would be
 *     worse than no diagnosis at all. Pinned as literal expected JSON per projection state, plus a
 *     source assertion that the board's card literal and its marker are untouched.
 *  2. NO RAW VALUE TRAVELS. Every refusal is driven from a projection whose identifiers, timestamps,
 *     URL and receipt text are unmistakable sentinels, and the serialised payload is searched for
 *     each of them.
 *  3. THE REJECTION ACTUALLY TRAVELS, for all seven `unpublishable_projection` return sites and for
 *     the `unpublishable_receipt_source` site beside them.
 */

const PACKET = 'c2c6c00a-71e0-4923-bbc2-123322c6d014';
const OTHER_PACKET = '0cf0dcee-b030-4dd8-aaf4-84df811da7c3';
const ATTEMPT = 'a3578398-c4cc-414d-9a44-c7943d8effb9';
const CANONICAL = 'c9ea060c-ec99-469a-8d19-4eabac66bd89';
const CAPTURED_AT = '2026-08-28T08:02:00.000Z';

/* SENTINELS, not plausible data. Every one of these is a value a refusal is caused BY, so if any of
 * them can be found in the payload the route publishes, the classification leaked the thing it
 * exists to withhold. They are shaped to survive JSON.stringify unchanged and to be greppable. */
const SENTINEL_ATTEMPT = '7ffffff1-5eed-7eed-0eed-5eed5eed5eed';
const SENTINEL_CANONICAL = '7ffffff2-5eed-7eed-0eed-5eed5eed5eed';
const SENTINEL_TIMESTAMP = '2026-08-28T08:02:00.7654321Z';
const SENTINEL_URL = 'http://leaked.example.invalid/receipt-7ffffff3';
const SENTINEL_TEXT = 'LEAKED-RECEIPT-TEXT-7ffffff4';
const SENTINEL_SOURCE = 'unsupported_email';
const SENTINEL_STAGE = 'leaked_stage_7ffffff5';
const SENTINELS = [
  SENTINEL_ATTEMPT,
  SENTINEL_CANONICAL,
  SENTINEL_TIMESTAMP,
  SENTINEL_URL,
  SENTINEL_TEXT,
  SENTINEL_STAGE,
  OTHER_PACKET,
];

/**
 * Source with its prose removed, for the assertions that say a spelling is ABSENT.
 *
 * This repo writes long dated comments at every fix site, and those comments name the very fields
 * they explain the absence of - the board's own card mapper explains `rejectedBranch` and
 * `rejectedShape` at length while emitting neither. Matching over the prose would either pass
 * vacuously or fail on a reworded sentence, and both make the assertion say nothing about the code.
 * Block comments and whole-line comments go; a trailing comment after code stays, which is
 * deliberate, since nothing in these slices hides a key there.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const confirmedProjection: AuthoritativeSubmissionProjection = {
  state: 'confirmed',
  attemptId: ATTEMPT,
  canonicalApplicationId: CANONICAL,
  packetId: PACKET,
  submittedAt: '2026-08-28T08:00:00.000Z',
  receipt: {
    confirmationText: 'Thank you for applying.',
    finalUrl: 'https://job-boards.greenhouse.io/example/jobs/1/application_confirmation',
    capturedAt: CAPTURED_AT,
    source: 'managed_browser',
  },
  source: 'managed_browser',
  trackerStage: 'applied',
};

function refusal(input: {
  projection: AuthoritativeSubmissionProjection | undefined;
  retrySafety: SubmissionAttemptRetrySafety | undefined;
  revision?: string;
}): SubmissionAuthorityRefusal | undefined {
  return submissionAuthorityRefusalForWire(
    PACKET,
    submissionAuthorityPublicationForPacket({
      packetId: PACKET,
      projection: input.projection,
      retrySafety: input.retrySafety,
      revision: input.revision ?? '3',
    }),
  );
}

/**
 * The seven `unpublishable_projection` return sites, each driven by a sentinel value.
 *
 * One case per RETURN SITE rather than per clause: eighteen clauses reach these seven returns, and
 * the clause-level naming is already pinned in lib/submissionAuthorityEnvelope.test.ts. What this
 * file has to prove is that each site's rejection survives the trip to the wire.
 */
const REFUSAL_SITES: ReadonlyArray<{
  site: string;
  projection: AuthoritativeSubmissionProjection | undefined;
  retrySafety: SubmissionAttemptRetrySafety;
  reason: string;
  rejected: { branch: string; field: string; shape: string };
}> = [
  {
    site: 'none: a safe_not_sent whose attempt id the client would quarantine',
    projection: { state: 'none' },
    retrySafety: {
      kind: 'safe_not_sent',
      attemptId: SENTINEL_ATTEMPT,
      proofKind: 'typed_pre_click_stop',
      resolvedAt: CAPTURED_AT,
    },
    reason: 'unpublishable_projection',
    rejected: { branch: 'none', field: 'retry_safety.attemptId', shape: 'uuid_version_unsupported' },
  },
  {
    site: 'unverified: a held attempt whose observation is not a strict timestamp',
    projection: { state: 'unverified', attemptId: ATTEMPT, observedAt: SENTINEL_TIMESTAMP, reason: 'pressed' },
    retrySafety: { kind: 'blocked_unverified', attemptId: ATTEMPT, at: CAPTURED_AT, reason: 'pressed' },
    reason: 'unpublishable_projection',
    rejected: { branch: 'unverified', field: 'projection.observed_at', shape: 'timestamp_not_strict_iso' },
  },
  {
    site: 'repair_required: a repair with no reasons to render',
    projection: { state: 'repair_required', reasons: [] },
    retrySafety: { kind: 'no_evidence' },
    reason: 'unpublishable_projection',
    rejected: { branch: 'repair_required', field: 'projection.reasons', shape: 'empty_list' },
  },
  {
    site: 'repair_required: a repair bound to another packet',
    projection: { state: 'repair_required', packetId: OTHER_PACKET, reasons: ['packet_missing'] },
    retrySafety: { kind: 'no_evidence' },
    reason: 'unpublishable_projection',
    rejected: { branch: 'repair_required', field: 'projection.packet_id', shape: 'bound_to_other_packet' },
  },
  {
    site: 'repair_required: a present but malformed optional id',
    projection: { state: 'repair_required', canonicalApplicationId: SENTINEL_CANONICAL, reasons: ['receipt_missing'] },
    retrySafety: { kind: 'no_evidence' },
    reason: 'unpublishable_projection',
    rejected: {
      branch: 'repair_required',
      field: 'projection.canonical_application_id',
      shape: 'uuid_version_unsupported',
    },
  },
  {
    site: 'confirmed: a confirmation bound to another packet',
    projection: { ...confirmedProjection, packetId: OTHER_PACKET },
    retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT },
    reason: 'unpublishable_projection',
    rejected: { branch: 'confirmed', field: 'projection.packet_id', shape: 'bound_to_other_packet' },
  },
  {
    site: 'confirmed: a receipt the client would quarantine',
    projection: {
      ...confirmedProjection,
      receipt: { ...confirmedProjection.receipt, finalUrl: SENTINEL_URL, confirmationText: SENTINEL_TEXT },
    },
    retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT },
    reason: 'unpublishable_projection',
    rejected: { branch: 'confirmed', field: 'receipt.final_url', shape: 'not_https_url' },
  },
  {
    /* The eighth site, and the one that is NOT `unpublishable_projection`. A genuine send refused
     * for a vocabulary the client has no word for is a different repair from a malformed field, so
     * it keeps its own reason and still names which of the two sources it was. */
    site: 'confirmed: an attempt source outside the client vocabulary',
    projection: { ...confirmedProjection, source: SENTINEL_SOURCE, trackerStage: SENTINEL_STAGE },
    retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT },
    reason: 'unpublishable_receipt_source',
    rejected: { branch: 'confirmed', field: 'projection.source', shape: 'outside_client_vocabulary' },
  },
];

describe('submissionAuthorityRefusalForWire', () => {
  it('carries the branch, the field and the shape for every refusal site', () => {
    for (const site of REFUSAL_SITES) {
      const wire = refusal({ projection: site.projection, retrySafety: site.retrySafety });
      assert.deepEqual(
        wire,
        { packet_id: PACKET, reason: site.reason, rejected: site.rejected },
        site.site,
      );
    }
    // Seven of the eight are the residual class the 2026-09-03 census collapsed into one word.
    assert.equal(
      REFUSAL_SITES.filter((site) => site.reason === 'unpublishable_projection').length,
      7,
      'all seven unpublishable_projection return sites are exercised',
    );
  });

  it('publishes the value that failed nowhere in the payload', () => {
    /* THE ONE PROMISE. `uuid_version_unsupported` says the identifier had the canonical layout and
     * a version nibble outside 1-5, and says nothing else about it. An attempt id is an internal
     * identifier and stays one, and so does a receipt's text and its final URL - the last of which
     * is a live employer URL bound to this applicant. Searched over the whole serialised payload
     * rather than key by key, so a value smuggled inside a message string is caught too. */
    for (const site of REFUSAL_SITES) {
      const wire = refusal({ projection: site.projection, retrySafety: site.retrySafety });
      const payload = JSON.stringify(wire);
      for (const sentinel of SENTINELS) {
        assert.equal(payload.includes(sentinel), false, `${site.site} leaks ${sentinel}`);
      }
      // The whole payload is the packet's own id plus three closed-vocabulary strings.
      assert.deepEqual(Object.keys(wire ?? {}).sort(), ['packet_id', 'reason', 'rejected']);
    }
  });

  it('names nothing when the reason is already the whole story', () => {
    // These four describe a state, not a malformed value, so there is nothing to classify and the
    // route degrades to exactly the reason the board marker already published.
    const stateOnly: ReadonlyArray<[string, Parameters<typeof refusal>[0]]> = [
      ['projection_read_failed', { projection: undefined, retrySafety: { kind: 'no_evidence' } }],
      ['revision_not_canonical', { projection: { state: 'none' }, retrySafety: { kind: 'no_evidence' }, revision: '03' }],
      ['boundary_authorized', {
        projection: { state: 'unverified', attemptId: ATTEMPT, observedAt: CAPTURED_AT, reason: 'boundary_authorized' },
        retrySafety: {
          kind: 'blocked_unverified',
          attemptId: ATTEMPT,
          at: CAPTURED_AT,
          reason: 'boundary_authorized',
          leaseId: ATTEMPT,
          expiresAt: CAPTURED_AT,
        },
      }],
      ['inconsistent_retry_evidence', {
        projection: { state: 'none' },
        retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT },
      }],
    ];
    for (const [reason, input] of stateOnly) {
      assert.deepEqual(refusal(input), { packet_id: PACKET, reason }, reason);
    }
  });

  it('drops a rejection whose members are outside the closed vocabularies', () => {
    /* The run-time half of the promise. `field` and `shape` are closed unions, so the compiler
     * already refuses an interpolated value at every site in the builder. It cannot see a cast, a
     * JSON round trip or a caller that rebuilt a publication from parsed input, and a leaked
     * identifier is not a defect anyone gets to fix after it has been served. */
    const forged = [
      { branch: 'none', field: `attempt ${SENTINEL_ATTEMPT}`, shape: 'uuid_malformed' },
      { branch: 'none', field: 'retry_safety.attemptId', shape: SENTINEL_ATTEMPT },
      { branch: SENTINEL_ATTEMPT, field: 'retry_safety.attemptId', shape: 'uuid_malformed' },
    ];
    for (const rejected of forged) {
      const wire = submissionAuthorityRefusalForWire(PACKET, {
        published: false,
        reason: 'unpublishable_projection',
        rejected,
      } as unknown as SubmissionAuthorityPublication);
      assert.deepEqual(
        wire,
        { packet_id: PACKET, reason: 'unpublishable_projection' },
        'an unrecognised member drops the record and keeps the reason',
      );
    }
  });

  it('names only fields the builder can actually produce', () => {
    // The vocabulary is a promise about what a reader will ever see, so it stays exactly the set the
    // builder reaches: a name in the list that no branch emits invites a repair for a state that
    // cannot happen, and a name a branch emits that is not in the list is dropped at the boundary.
    const builder = readFileSync('src/lib/submissionAuthorityEnvelope.ts', 'utf8');
    const emitted = builder.slice(builder.indexOf('export function submissionAuthorityPublicationForPacket('));
    for (const field of SUBMISSION_AUTHORITY_REJECTED_FIELDS) {
      assert.ok(emitted.includes(`'${field}'`), `${field} is emitted by a branch`);
    }
    assert.equal(SUBMISSION_AUTHORITY_REJECTED_FIELDS.length, 14);
  });
});

describe('submissionAuthorityRefusalTallies', () => {
  it('ranks the refusal classes, largest first, with a stable tie break', () => {
    /* THE READING THE COUNT COULD NOT GIVE. "163 packets say unpublishable_projection" is a number
     * over seven return sites; a ranked (branch, field, shape) table is a list of repairs. */
    const refusals = REFUSAL_SITES.flatMap((site, index) => {
      const wire = refusal({ projection: site.projection, retrySafety: site.retrySafety });
      assert.ok(wire);
      // The first site three times over, so the ordering has something to order.
      return index === 0 ? [wire, { ...wire, packet_id: OTHER_PACKET }, wire] : [wire];
    });
    const tallies = submissionAuthorityRefusalTallies(refusals);
    assert.equal(tallies.length, REFUSAL_SITES.length);
    assert.deepEqual(tallies[0], {
      reason: 'unpublishable_projection',
      branch: 'none',
      field: 'retry_safety.attemptId',
      shape: 'uuid_version_unsupported',
      packets: 3,
    });
    for (const tally of tallies.slice(1)) assert.equal(tally.packets, 1);
    // Deterministic: the same input orders the same way twice, so a diff between two days is a diff
    // about the packets rather than about map iteration.
    assert.deepEqual(submissionAuthorityRefusalTallies([...refusals].reverse()), tallies);
  });

  it('groups a state-only refusal without inventing a branch', () => {
    const tallies = submissionAuthorityRefusalTallies([
      { packet_id: PACKET, reason: 'projection_read_failed' },
      { packet_id: OTHER_PACKET, reason: 'projection_read_failed' },
    ]);
    assert.deepEqual(tallies, [{ reason: 'projection_read_failed', packets: 2 }]);
  });
});

describe('the board payload is untouched', () => {
  const board = readFileSync('src/routes/jdMatch.ts', 'utf8');
  const cardMapper = board.slice(
    board.indexOf('cards: rows.map((row) => {'),
    board.indexOf("fastify.get('/applications/board/authority-rejections'"),
  );

  it('publishes byte-identical envelopes for every publishable state', () => {
    /* A quarantined card cannot be sent, which is the failure this whole diagnosis exists to name,
     * so the bytes a publishable card carries are pinned as literals rather than compared against
     * something this file also computes. Any drift in the builder fails here, whatever caused it. */
    const publishable: ReadonlyArray<[string, Parameters<typeof refusal>[0], string]> = [
      ['none + no_evidence', { projection: { state: 'none' }, retrySafety: { kind: 'no_evidence' } },
        '{"schema_version":"submission-authority-v1","revision":"3","state":"none","application_id":"c2c6c00a-71e0-4923-bbc2-123322c6d014","packet_id":"c2c6c00a-71e0-4923-bbc2-123322c6d014","projection":{"state":"none"},"retry_safety":{"kind":"no_evidence"}}'],
      ['none + safe_not_sent', {
        projection: { state: 'none' },
        retrySafety: { kind: 'safe_not_sent', attemptId: ATTEMPT, proofKind: 'applicant_checked_not_sent', resolvedAt: CAPTURED_AT },
      },
        '{"schema_version":"submission-authority-v1","revision":"3","state":"none","application_id":"c2c6c00a-71e0-4923-bbc2-123322c6d014","packet_id":"c2c6c00a-71e0-4923-bbc2-123322c6d014","projection":{"state":"none"},"retry_safety":{"kind":"safe_not_sent","attemptId":"a3578398-c4cc-414d-9a44-c7943d8effb9","proofKind":"applicant_checked_not_sent","resolvedAt":"2026-08-28T08:02:00.000Z"}}'],
      ['unverified', {
        projection: { state: 'unverified', attemptId: ATTEMPT, observedAt: CAPTURED_AT, reason: 'pressed' },
        retrySafety: { kind: 'blocked_unverified', attemptId: ATTEMPT, at: CAPTURED_AT, reason: 'pressed' },
      },
        '{"schema_version":"submission-authority-v1","revision":"3","state":"unverified","application_id":"c2c6c00a-71e0-4923-bbc2-123322c6d014","packet_id":"c2c6c00a-71e0-4923-bbc2-123322c6d014","projection":{"state":"unverified","attempt_id":"a3578398-c4cc-414d-9a44-c7943d8effb9","observed_at":"2026-08-28T08:02:00.000Z","reason":"pressed"},"retry_safety":{"kind":"blocked_unverified","attemptId":"a3578398-c4cc-414d-9a44-c7943d8effb9","at":"2026-08-28T08:02:00.000Z","reason":"pressed"}}'],
      ['repair_required', {
        projection: { state: 'repair_required', attemptId: ATTEMPT, reasons: ['receipt_missing'] },
        retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT },
      },
        '{"schema_version":"submission-authority-v1","revision":"3","state":"repair_required","application_id":"c2c6c00a-71e0-4923-bbc2-123322c6d014","packet_id":"c2c6c00a-71e0-4923-bbc2-123322c6d014","projection":{"state":"repair_required","reasons":["receipt_missing"],"attempt_id":"a3578398-c4cc-414d-9a44-c7943d8effb9"},"retry_safety":{"kind":"blocked_confirmed","attemptId":"a3578398-c4cc-414d-9a44-c7943d8effb9","confirmedAt":"2026-08-28T08:02:00.000Z"}}'],
      ['confirmed', { projection: confirmedProjection, retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT } },
        '{"schema_version":"submission-authority-v1","revision":"3","state":"confirmed","application_id":"c2c6c00a-71e0-4923-bbc2-123322c6d014","packet_id":"c2c6c00a-71e0-4923-bbc2-123322c6d014","projection":{"state":"confirmed","attempt_id":"a3578398-c4cc-414d-9a44-c7943d8effb9","canonical_application_id":"c9ea060c-ec99-469a-8d19-4eabac66bd89","packet_id":"c2c6c00a-71e0-4923-bbc2-123322c6d014","submitted_at":"2026-08-28T08:00:00.000Z","receipt":{"confirmation_text":"Thank you for applying.","final_url":"https://job-boards.greenhouse.io/example/jobs/1/application_confirmation","captured_at":"2026-08-28T08:02:00.000Z","source":"managed_browser"},"source":"managed_browser","tracker_stage":"applied"},"retry_safety":{"kind":"blocked_confirmed","attemptId":"a3578398-c4cc-414d-9a44-c7943d8effb9","confirmedAt":"2026-08-28T08:02:00.000Z"}}'],
    ];
    for (const [state, input, expected] of publishable) {
      const publication = submissionAuthorityPublicationForPacket({
        packetId: PACKET,
        projection: input.projection,
        retrySafety: input.retrySafety,
        revision: '3',
      });
      assert.ok(publication.published, state);
      assert.equal(JSON.stringify(publication.envelope), expected, state);
      // And a published card contributes nothing at all to the census, so no key is added to it.
      assert.equal(submissionAuthorityRefusalForWire(PACKET, publication), undefined, state);
    }
  });

  it('keeps the marker at exactly three keys and six reasons', () => {
    // The one thing the deployed dashboard could plausibly parse strictly. It gains no key here:
    // the rejection reaches its reader through a route that publishes no card.
    assert.deepEqual(submissionAuthorityUnavailableMarker(PACKET, 'unpublishable_projection'), {
      schema_version: 'submission-authority-v1',
      packet_id: PACKET,
      reason: 'unpublishable_projection',
    });
    const lib = readFileSync('src/lib/submissionAuthorityEnvelope.ts', 'utf8');
    const marker = lib.slice(
      lib.indexOf('export function submissionAuthorityUnavailableMarker('),
      lib.indexOf('export type SubmissionAuthorityRefusal = {'),
    );
    assert.match(marker, /return \{ schema_version: SUBMISSION_AUTHORITY_SCHEMA_VERSION, packet_id: packetId, reason \};/);
  });

  it('adds no key to a board card and no field to the board response', () => {
    /* The card literal, key for key, in the order the route writes them. The board is the surface
     * the dashboard's authority check runs over, so a key added here is the one change that could
     * turn a publishable card into an unpublishable one. */
    for (const key of [
      'id:', 'job_id:', 'company:', 'role:', 'created_at:', 'moved_at:', 'reviewable:',
      'submission_status:', 'run_revision:', 'review_updated_at:', 'stage:',
    ]) {
      assert.ok(cardMapper.includes(key), `the board card still carries ${key}`);
    }
    // Exactly the two authority spellings the card has ever carried, and exactly one of them per
    // card, which applicationsBoardAuthority.db.test.ts pins as behaviour.
    assert.match(cardMapper, /\{ submission_authority: publication\.envelope \}/);
    assert.match(cardMapper, /\{ submission_authority_unavailable: submissionAuthorityUnavailableMarker\(row\.id, publication\.reason\) \}/);
    /* The card gains nothing. The board's log line still carries rejectedBranch/rejectedField/
     * rejectedShape from #894 - that is the point of stripping the prose and reading the object
     * literal alone, since the mapper explains those three at length while emitting none of them. */
    const emittedCard = withoutComments(cardMapper.slice(cardMapper.indexOf('return {')));
    assert.doesNotMatch(emittedCard, /rejected|rejection|branch|shape/, 'no diagnosis rides along on a card');
    // And the response root: the collection fields are the board's proof it speaks the contract,
    // and nothing new sits beside them.
    const boardResponse = board.slice(
      board.indexOf("fastify.get('/applications/board',"),
      board.indexOf('cards: rows.map((row) => {'),
    );
    assert.match(boardResponse, /schema_version: SUBMISSION_AUTHORITY_SCHEMA_VERSION,\n\s+submission_authority_revision: submissionAuthority\.revision,/);
    assert.doesNotMatch(withoutComments(boardResponse), /rejections:|summary:/, 'the census does not ride along on the board');
  });

  it('leaves the packet review response carrying the envelope and nothing else', () => {
    // The other surface that refuses these packets. It still publishes only the unattempted
    // builder's envelope; its refusal is readable through the census route instead.
    const applications = readFileSync('src/routes/applications.ts', 'utf8');
    const helper = applications.slice(
      applications.indexOf('async function unattemptedPacketSubmissionAuthority('),
      applications.indexOf('const questionSchema'),
    );
    const afterEnvelope = helper.slice(
      helper.indexOf('if (envelope) return { submission_authority: envelope };'),
    );
    assert.doesNotMatch(afterEnvelope.slice(60), /submission_authority/, 'no new authority key on the review response');
    assert.match(afterEnvelope, /return \{\};/);
  });
});

describe('GET /applications/board/authority-rejections', () => {
  const board = readFileSync('src/routes/jdMatch.ts', 'utf8');
  const route = board.slice(
    board.indexOf("fastify.get('/applications/board/authority-rejections'"),
    board.indexOf("fastify.patch('/applications/:id/stage'"),
  );
  const code = withoutComments(route);

  it('is registered, authenticated and scoped to the caller', () => {
    assert.ok(route.length > 0, 'the route exists in jdMatch.ts');
    assert.match(route, /\{ preHandler: requireAuth \}/);
    // The user filter is on the row select, before anything is classified, so a packet id naming
    // somebody else's row classifies nothing rather than confirming it exists.
    assert.match(route, /eq\(generated_resumes\.user_id, userId\)/);
    assert.match(route, /z\.object\(\{ packet_id: z\.string\(\)\.uuid\(\)\.optional\(\) \}\)/);
    // Same page as the board, so the census counts the same packets the board refuses.
    assert.match(route, /\.limit\(BOARD_LIMIT\)/);
    assert.match(route, /\.orderBy\(desc\(generated_resumes\.created_at\)\)/);
  });

  it('reads one column and no job description', () => {
    // A diagnostic that pulled `spec` or `job_context` would carry tens of kilobytes of job text a
    // row for a payload of closed-vocabulary strings. Every input it needs comes from the
    // projection read.
    assert.match(route, /\.select\(\{ id: generated_resumes\.id \}\)/);
    assert.doesNotMatch(code, /job_context|generated_resumes\.spec/);
  });

  it('publishes only through the boundary that withholds the value', () => {
    // Nothing here builds a rejection by hand; every refusal that reaches the reply passes the
    // membership re-check first.
    assert.match(route, /submissionAuthorityRefusalForWire\(row\.id, publication\)/);
    assert.match(route, /summary: submissionAuthorityRefusalTallies\(refusals\)/);
    assert.doesNotMatch(code, /publication\.rejected/, 'the raw rejection never reaches the reply');
    // A failed projection read reports per packet instead of throwing the census away, the same
    // fallback the board uses.
    assert.match(route, /published: false, reason: 'projection_read_failed'/);
  });

  it('publishes no envelope, no marker and no card', () => {
    assert.doesNotMatch(code, /submission_authority:/);
    assert.doesNotMatch(code, /submissionAuthorityUnavailableMarker/);
    assert.doesNotMatch(code, /cards:/);
  });

  /* THAT THE ROUTER ACTUALLY RESOLVES THIS PATH is asserted in index.test.ts, next to the other
   * anonymous-caller checks, because that file already boots one app and shares it. `/applications/
   * :id` is a live parametric route in three other files, so a new static child under
   * `/applications/board` is the one registration that could be swallowed by a sibling parameter
   * and answer 404 forever while every source assertion here still passed. */
});
