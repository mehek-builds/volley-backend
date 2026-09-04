/* THE FOUR SHAPES THIS PASS ALMOST SHIPPED A FROZEN PACKET ON, replayed through the real merge and
 * the real acknowledgement predicate.
 *
 * Sibling of questionIdentityFixpoint.test.ts and driven by the same harness, because the defect is
 * the same defect arriving by a different door. #902 closed it for the repeat collapse. The handle
 * strip re-opened it twice: it ran BEFORE tidyLabel, so a handle wearing trailing decoration was
 * invisible on the pass that removed the decoration and bare on the next one; and its token cap was
 * per call, so a fifth handle token came off on the next read.
 *
 * Both were found by review, on these four strings, each of which minted one label and read back
 * another and so froze at "packet 3, audit 4" with `missing` empty and one row forever
 * `unacknowledged`. A normalizer that is a fixpoint of itself is what makes the mint and every
 * later read agree, and that is what is asserted here at the packet level rather than at the
 * string level.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationReviewQuestion } from '../lib/applicationReview';
import { normalizeReviewQuestionLabel, normalizeStoredPortalQuestions } from '../lib/questionDiscovery';
import {
  mergeDiscoveredPortalQuestions,
  packetQuestionAcknowledgement,
  packetQuestionsForFill,
} from './submissionRunner';

const REVIEWED_AT = '2026-09-01T20:11:00.000Z';

/* The exact strings review replayed: a handle behind the employer's asterisk, a handle behind a
 * parenthesised marker, and a five-token handle run that the per-call cap used to trim to four. */
const DRIFTING_LABELS = [
  'cover letter candidate[cover_letter]*',
  'expected salary salary_expectations*',
  'expected salary salary_expectations (required)',
  'what is your notice period? a_one b_two c_three d_four e_five',
];

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

function replayRounds(rawLabel: string, rounds: number) {
  const approved = [answered('q0', 'Question one'), answered('q1', 'Question two')];
  const discovered = [...approved, discoveredRow('245', rawLabel)];
  let reviewQuestions: ApplicationReviewQuestion[] = [...approved];
  const out: { packet: number; missing: string[]; unacknowledged: string[] }[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const storedQuestions = normalizeStoredPortalQuestions(reviewQuestions, 'greenhouse');
    const merged = mergeDiscoveredPortalQuestions(discovered, storedQuestions, [], new Set(), REVIEWED_AT);
    const approvalReading = normalizeStoredPortalQuestions(merged, 'greenhouse');
    const { missing, unacknowledged } = packetQuestionAcknowledgement(
      packetQuestionsForFill(merged),
      packetQuestionsForFill(approvalReading),
    );
    out.push({ packet: merged.length, missing, unacknowledged });
    reviewQuestions = merged;
  }
  return out;
}

test('a handle wearing decoration no longer freezes the packet above the approval', () => {
  for (const raw of DRIFTING_LABELS) {
    const rounds = replayRounds(raw, 4);
    // One extra round is the contract when the form really does teach Litos a question. Never a
    // second: from round 2 on, the approval covers the packet and nothing is left unacknowledged.
    for (const [index, round] of rounds.entries()) {
      if (index === 0) continue;
      assert.deepEqual(
        round.unacknowledged,
        [],
        `round ${index + 1} still carries a question the approval did not, for ${JSON.stringify(raw)}`,
      );
      assert.deepEqual(round.missing, [], JSON.stringify(raw));
    }
    // And the packet stops growing, which is the strict-superset signature the review measured.
    const sizes = rounds.map((round) => round.packet);
    assert.equal(
      new Set(sizes.slice(1)).size,
      1,
      `the packet kept moving across rounds (${sizes.join(' -> ')}) for ${JSON.stringify(raw)}`,
    );
  }
});
