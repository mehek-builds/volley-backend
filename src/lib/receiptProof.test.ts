import assert from 'node:assert/strict';
import test from 'node:test';
import { receiptProof } from './receiptProof';

test('a bare thank-you on an ordinary host is proof', () => {
  assert.equal(receiptProof('Thank you', 'https://jobs.lever.co/apollo/abc/thanks').proven, true);
  assert.equal(receiptProof('Application received', 'https://tixtrack.teamtailor.com/jobs/1/applications/new').proven, true);
});

test('crelate proof is structural: the applythanks route with one applicationId and the sentence', () => {
  const url = 'https://jobs.crelate.com/portal/themavengroup/job/applythanks/wtmao1bfqg9te5b5jo5jknskxo?applicationId=abcdEFGH1234';
  assert.equal(receiptProof('Thank you for applying to Cyber Test Engineer at The Maven Group', url).proven, true);
  assert.equal(receiptProof('Thank you for applying to this position.', url).proven, true);
  assert.equal(receiptProof('Thank you', url).proven, false, 'the sentence is required');
  assert.equal(receiptProof('Thank you for applying to this position.', 'https://jobs.crelate.com/portal/themavengroup/job/apply/wtmao1bfqg9te5b5jo5jknskxo').proven, false, 'the apply route is not the receipt route');
});
