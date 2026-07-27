import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, deriveStage, isStage, canMove, STAGE_LABEL } from './pipeline';

describe('deriveStage', () => {
  test('a stored stage always wins over the derivation', () => {
    assert.equal(deriveStage('interview', 'submitted'), 'interview');
    assert.equal(deriveStage('saved', 'submitted'), 'saved');
  });

  test('a never-moved submitted application starts at applied', () => {
    assert.equal(deriveStage(null, 'submitted'), 'applied');
  });

  test('a prepared resume that was never sent is NOT an application', () => {
    // Counting a prepared resume as applied is the same inflation the funnel refuses.
    assert.equal(deriveStage(null, 'resume_ready'), 'saved');
    assert.equal(deriveStage(null, undefined), 'saved');
    assert.equal(deriveStage(null, 'failed'), 'saved');
  });

  test('a garbage stored value falls back rather than propagating', () => {
    assert.equal(deriveStage('offerrr', 'submitted'), 'applied');
    assert.equal(deriveStage(42, undefined), 'saved');
  });

  test('the student stays at interview no matter what the automation says', () => {
    // The two axes move independently: this is the whole reason the column exists.
    for (const status of ['submitted', 'failed', 'preparing', 'ready_to_submit']) {
      assert.equal(deriveStage('interview', status), 'interview');
    }
  });
});

describe('stages', () => {
  test('every stage has a label', () => {
    for (const stage of STAGES) assert.ok(STAGE_LABEL[stage]);
  });

  test('isStage rejects anything not on the list', () => {
    assert.equal(isStage('applied'), true);
    assert.equal(isStage('APPLIED'), false);
    assert.equal(isStage(''), false);
    assert.equal(isStage(null), false);
  });

  test('a card can move backwards and skip forwards', () => {
    // Not a state machine: an "interview" that turns out to be a recruiter screen goes back, and a
    // referral can start at interview.
    assert.equal(canMove('interview', 'applied'), true);
    assert.equal(canMove('saved', 'offer'), true);
    assert.equal(canMove('closed', 'interview'), true);
  });

  test('a move to the same stage is not a move', () => {
    assert.equal(canMove('applied', 'applied'), false);
  });
});

/**
 * All twelve submission statuses, pinned.
 *
 * The doc comment used to restate five of them, so a reader auditing deriveStage against it would
 * have concluded it was exhaustive while it omitted the seven that make the derivation ambiguous.
 * This is the list, and every entry here is a decision rather than an accident.
 */
describe('deriveStage over the full submission status union', () => {
  const EXPECTED: Record<string, string> = {
    resume_ready: 'saved',
    questions_ready: 'saved',
    ready_to_submit: 'saved',
    submit_requested: 'saved',
    preparing: 'saved',
    filling: 'saved',
    // Set when a submission was CLAIMED but the employer confirmation could not be verified. Erring
    // to 'saved' matches the funnel's rule that a maybe is not an application; the student moves it
    // the moment they know.
    needs_attention: 'saved',
    ready_for_final_approval: 'saved',
    submitting: 'saved',
    submission_claimed: 'saved',
    submitted: 'applied',
    failed: 'saved',
  };

  for (const [status, expected] of Object.entries(EXPECTED)) {
    test(`${status} derives to ${expected}`, () => {
      assert.equal(deriveStage(null, status), expected);
    });
  }

  test('only a confirmed submission derives to applied', () => {
    const applied = Object.entries(EXPECTED).filter(([, stage]) => stage === 'applied');
    assert.deepEqual(applied.map(([status]) => status), ['submitted']);
  });
});
