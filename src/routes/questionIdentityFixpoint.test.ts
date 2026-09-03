/* A QUESTION'S IDENTITY SURVIVES THE NEXT DISCOVERY OF THE SAME FORM, or nothing ever sends.
 *
 * MEASURED on application 4a79eec1 (Hudson River Trading, greenhouse, account a18f774b) on
 * 2026-09-03, driven by hand through the dashboard. Every round: the answers screen showed all
 * questions answered, Save reported no change, the packet audit passed "EXACT PACKET CHECKED", the
 * managed run finished, and the row came back
 *
 *   status              needs_attention
 *   attention_reason    This company form asks questions your approved packet did not cover, so
 *                       nothing was sent. Open it, answer them, and approve it again.
 *   attention_categories ["required_field"]
 *
 * with the question count moved 26 -> 27 once and then standing still. She answered, acknowledged,
 * approved and re-filled; the same sentence came back. Four boards showed the same shape.
 *
 * A STRICT SUPERSET IS THE SIGNATURE, and only one thing produces it. `missing` empty with one row
 * `unacknowledged` means the built packet carried a question the approval did not, on every round,
 * however many times she approved. Managed discovery concatenates visible label text, placeholder
 * text, name and id into one string - FOUR parts - and collapseRepeatedLabel halved that once and
 * stopped, so discovery minted "Gender Gender" while every later read of the row produced "Gender".
 * The merge kept both because they are different words; the audit-side reading collapsed them back
 * to one. See labelNormalizationFixpoint in lib/questionDiscovery.ts, including what that comment
 * does and does not claim about 4a79eec1's own rows.
 *
 * The contract these tests hold is the one the gate already promised and could not keep: one extra
 * round when the form really does teach Litos a question, and never a second. Nothing here loosens
 * the comparison - packetQuestionAcknowledgement is driven unchanged, and a genuinely new control
 * still parks on the first round.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationReviewQuestion } from '../lib/applicationReview';
import {
  normalizeDiscoveredLabel,
  normalizeReviewQuestionLabel,
  normalizeStoredPortalQuestions,
} from '../lib/questionDiscovery';
import {
  mergeDiscoveredPortalQuestions,
  packetQuestionAcknowledgement,
  packetQuestionsForFill,
} from './submissionRunner';

/* The shapes managed discovery actually hands back, worst first. Each is one control: the employer's
 * visible label, the control's placeholder, its name and its id, run together. */
const CONCATENATED_LABELS = [
  'Gender Gender gender gender',
  'Gender* Gender gender gender',
  'Pronouns Pronouns pronouns pronouns',
  'Race Race race race',
  'Hispanic/Latino? Hispanic/Latino? hispanic_latino hispanic_latino',
  'Are you legally authorized to work in the US? Are you legally authorized to work in the US? work_auth work_auth',
  // Already clean, and must stay untouched.
  'How did you hear about this role?',
  'Why do you want to work here?',
  'Privacy',
  'Privacy statement',
  // Long enough to be clipped at REVIEW_QUESTION_TEXT_MAX_LENGTH, and repeated on top of that.
  `${'Describe a system you built and what you would change about it now. '.repeat(8)}`.trim(),
];

const REVIEWED_AT = '2026-09-01T20:11:00.000Z';

/** A row she read and answered, in the round the review is stamped with. */
function answered(id: string, question: string): ApplicationReviewQuestion {
  return {
    id,
    question,
    answer: 'Yes',
    kind: 'required',
    required: true,
    portal_selector: `#${id}`,
    answer_source: 'applicant_review',
    answer_reviewed_at: REVIEWED_AT,
  };
}

/** The row this run's discovery produces for one control, minted the way discovery mints it. */
function discoveredRow(id: string, rawLabel: string): ApplicationReviewQuestion {
  return {
    id,
    question: normalizeReviewQuestionLabel(rawLabel),
    answer: '',
    kind: 'required',
    required: true,
    portal_selector: `#${id}`,
    portal_input_type: 'combobox',
  };
}

test('the label a question is minted with is the label every later read produces', () => {
  for (const raw of CONCATENATED_LABELS) {
    assert.equal(
      normalizeDiscoveredLabel(normalizeDiscoveredLabel(raw)),
      normalizeDiscoveredLabel(raw),
      `normalizeDiscoveredLabel moved a label it had already produced: ${JSON.stringify(raw)}`,
    );
    assert.equal(
      normalizeReviewQuestionLabel(normalizeReviewQuestionLabel(raw)),
      normalizeReviewQuestionLabel(raw),
      `normalizeReviewQuestionLabel moved a label it had already produced: ${JSON.stringify(raw)}`,
    );
  }
});

test('a minted question survives the stored read that every packet identity goes through', () => {
  for (const raw of CONCATENATED_LABELS) {
    const minted = normalizeReviewQuestionLabel(raw);
    assert.ok(minted, `discovery would mint nothing for ${JSON.stringify(raw)}`);
    const [stored] = normalizeStoredPortalQuestions(
      [{ question: minted, answer: '', portal_selector: '#245' }],
      'greenhouse',
    );
    assert.equal(
      stored?.question,
      minted,
      `the stored read renamed a question discovery had just minted: ${JSON.stringify(raw)}`,
    );
  }
});

/* THE LOOP ITSELF, driven through the real merge and the real acknowledgement predicate.
 *
 * Each round is one prepare: the stored rows are read the way the runner reads them, discovery's
 * rows are merged in, the packet is projected from the merged set, and the approval is taken over
 * that same merged set the way the audit route takes it. Then the hold writes the merged set back
 * onto the review and she approves it, which is what the next round starts from. */
function replayRounds(rawLabel: string, rounds: number) {
  const approved = [answered('q0', 'Question one'), answered('q1', 'Question two')];
  const discovered = [...approved, discoveredRow('245', rawLabel)];
  let reviewQuestions: ApplicationReviewQuestion[] = [...approved];
  const out: { packet: number; audit: number; missing: string[]; unacknowledged: string[]; forged: string[] }[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const storedQuestions = normalizeStoredPortalQuestions(reviewQuestions, 'greenhouse');
    const merged = mergeDiscoveredPortalQuestions(discovered, storedQuestions, [], new Set(), REVIEWED_AT);
    const approvalReading = normalizeStoredPortalQuestions(merged, 'greenhouse');
    const acknowledgement = packetQuestionAcknowledgement(
      packetQuestionsForFill(merged),
      packetQuestionsForFill(approvalReading),
    );
    out.push({ packet: merged.length, audit: approvalReading.length, ...acknowledgement });
    reviewQuestions = merged;
  }
  return out;
}

test('an approval taken over the merged set covers the next discovery of the same form', () => {
  for (const raw of CONCATENATED_LABELS) {
    const rounds = replayRounds(raw, 4);
    for (const [index, round] of rounds.entries()) {
      assert.deepEqual(
        round.unacknowledged,
        [],
        `round ${index + 1} on ${JSON.stringify(raw)} still asks about a question the approval covered`
        + ` (packet ${round.packet} rows, approval ${round.audit})`,
      );
      assert.deepEqual(round.missing, [], `round ${index + 1} on ${JSON.stringify(raw)} lost a row she approved`);
      assert.deepEqual(round.forged, [], `round ${index + 1} on ${JSON.stringify(raw)} minted a claim of hers`);
    }
  }
});

test('one control is one row, however many times its label repeats itself', () => {
  const rounds = replayRounds('Gender Gender gender gender', 4);
  for (const [index, round] of rounds.entries()) {
    assert.equal(
      round.packet,
      3,
      `round ${index + 1} built a packet of ${round.packet} rows for a form with three controls`,
    );
    assert.equal(round.packet, round.audit, `round ${index + 1}: the packet and the approval disagree on how many questions this form asks`);
  }
});

/* THE GATE IS NOT WEAKENED. A control the form really did add is still a question the approval never
 * covered, it still parks, and the round after her approval still completes. */
test('a genuinely new control still parks once, and once only', () => {
  const approved = [answered('q0', 'Question one')];
  const discovered = [...approved, discoveredRow('312', 'What is your notice period?')];

  const firstStored = normalizeStoredPortalQuestions(approved, 'greenhouse');
  const firstMerged = mergeDiscoveredPortalQuestions(discovered, firstStored, [], new Set(), REVIEWED_AT);
  const firstApproval = normalizeStoredPortalQuestions(approved, 'greenhouse');
  const first = packetQuestionAcknowledgement(
    packetQuestionsForFill(firstMerged),
    packetQuestionsForFill(firstApproval),
  );
  assert.deepEqual(first.missing, []);
  assert.deepEqual(
    first.unacknowledged,
    ['What is your notice period?'],
    'a control the approval never met has to park',
  );

  // She is asked, she approves the merged set, and the next prepare goes through.
  const secondStored = normalizeStoredPortalQuestions(firstMerged, 'greenhouse');
  const secondMerged = mergeDiscoveredPortalQuestions(discovered, secondStored, [], new Set(), REVIEWED_AT);
  const second = packetQuestionAcknowledgement(
    packetQuestionsForFill(secondMerged),
    packetQuestionsForFill(normalizeStoredPortalQuestions(firstMerged, 'greenhouse')),
  );
  assert.deepEqual(second.unacknowledged, [], 'the round after her approval must complete');
  assert.deepEqual(second.missing, []);
  assert.deepEqual(second.forged, []);
});
