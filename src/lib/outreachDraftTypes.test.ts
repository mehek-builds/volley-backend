import assert from 'node:assert/strict';
import test from 'node:test';
import { OUTREACH_DRAFT_INSTRUCTIONS, OUTREACH_DRAFT_TYPES } from './outreachDraftTypes';

test('the outreach contract supports every advertised message type with distinct guidance', () => {
  assert.deepEqual(OUTREACH_DRAFT_TYPES, [
    'first_note',
    'follow_up',
    'thank_you',
    'referral_ask',
    'offer_stage',
  ]);
  const instructions = OUTREACH_DRAFT_TYPES.map((type) => OUTREACH_DRAFT_INSTRUCTIONS[type]);
  assert.equal(new Set(instructions).size, OUTREACH_DRAFT_TYPES.length);
  assert.match(OUTREACH_DRAFT_INSTRUCTIONS.follow_up, /prior unanswered note/i);
  assert.match(OUTREACH_DRAFT_INSTRUCTIONS.thank_you, /thank-you note/i);
  assert.match(OUTREACH_DRAFT_INSTRUCTIONS.referral_ask, /referral request/i);
  assert.match(OUTREACH_DRAFT_INSTRUCTIONS.offer_stage, /offer-stage note/i);
});
