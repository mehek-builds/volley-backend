import assert from 'node:assert/strict';
import test from 'node:test';
import { packetAuditSha256, packetVisibleQuestions } from './packetAudit';

/* Measured on Belvedere Trading c4413bff (Lever), 2026-09-05: the fill run's discovery merge wrote
 * the applicant's 25 approved questions back in the form's order, the run's own set-based drift
 * check passed, and POST /submission/approve then refused the send as packet_stale because the
 * question binding hashed the array as arranged. These pin the binding to the rows and not to
 * their arrangement, and pin that every byte of a row still counts. */

const school = {
  id: 'ff484bb2', question: 'name of school ✱', answer: 'University of Southern California',
  kind: 'required', required: false, portal_selector: '[name="cards[x][field9]"]', portal_input_type: 'combobox',
  answer_source: 'applicant_review', options: ['A', 'B'],
};
const street = {
  id: '6d127747', question: 'street address ✱', answer: '1133 W 36th Pl',
  kind: 'required', required: true, portal_selector: '[name="cards[x][field0]"]', portal_input_type: 'text',
};
const learn = {
  id: '17122e75', question: 'how did you learn about belvedere trading? ✱', answer: 'Other',
  kind: 'required', required: true, portal_selector: '[name="cards[x][field4]"]', portal_input_type: 'select',
};
const binding = (questions: unknown) => packetAuditSha256(packetVisibleQuestions(questions));

test('the question binding does not move when discovery rewrites the arrangement of the same rows', () => {
  const approved = binding([street, school, learn]);
  assert.equal(binding([learn, school, street]), approved, 'the form order is not packet identity');
  assert.equal(binding([school, learn, street]), approved);
});

test('every byte of a row is still bound: an answer, a label, a control or a row moves the hash', () => {
  const approved = binding([street, school, learn]);
  assert.notEqual(binding([street, { ...school, answer: 'University of California, Los Angeles' }, learn]), approved);
  assert.notEqual(binding([street, { ...school, question: 'name of school' }, learn]), approved);
  assert.notEqual(binding([street, { ...school, portal_selector: '[name="cards[x][field10]"]' }, learn]), approved);
  assert.notEqual(binding([street, { ...school, portal_input_type: 'select' }, learn]), approved);
  assert.notEqual(binding([street, { ...school, required: true }, learn]), approved);
  assert.notEqual(binding([street, school]), approved, 'a removed row moves the hash');
  assert.notEqual(binding([street, school, learn, { ...learn, id: 'dup' }]), approved, 'an added row moves the hash');
});

test('display-only and provenance fields still stay out of the binding, and malformed input still reaches the canonical check', () => {
  const approved = binding([street, school, learn]);
  assert.equal(binding([street, { ...school, options: ['B', 'A', 'C'], answer_source: undefined, answer_reviewed_at: 'now' }, learn]), approved);
  // Not a list of plain objects: returned untouched so bindingIssues' canonical-JSON check rejects it.
  assert.equal(packetVisibleQuestions('not a list'), 'not a list');
  assert.deepEqual(packetVisibleQuestions([street, 'stray']), [
    { id: street.id, question: street.question, answer: street.answer, kind: street.kind, required: street.required, portal_selector: street.portal_selector, portal_input_type: street.portal_input_type },
    'stray',
  ]);
});
