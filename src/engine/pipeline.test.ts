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
