import test from 'node:test';
import assert from 'node:assert/strict';
import { questionMetadataBlockersForOptionProbeFailures } from './questionMetadata';

/* AN OPTION PROBE THAT FAILED AGAINST A FREE-TEXT FIELD IS NOT AN OPTION PROBLEM.
 *
 * questionMetadataBlockerForOptionProbeFailure returns 'missing_exact_options' for anything with a
 * readable label and never checks that the control is closed, so a probe against a text field parks
 * the packet on "Litos could not read the exact options" for a control that can never have any.
 *
 * Measured on Five Rings 767ed539 (Greenhouse): question_metadata_blockers carried
 *   { kind: 'missing_exact_options', portal_input_type: 'text', required: false,
 *     question: 'if you answered yes to the above, please provide details on competing offers ...' }
 */
const textField = {
  label: 'If you answered yes to the above, please provide details on competing offers',
  inputType: 'text',
  options: null,
  durableSelector: '#question_17808233008',
  id: 'question_17808233008',
  required: false,
} as never;

const selectField = {
  label: 'Are you legally authorized to work in the United States?',
  inputType: 'select-one',
  options: null,
  durableSelector: '#question_999',
  id: 'question_999',
  required: true,
} as never;

const unlabelledText = {
  label: '',
  inputType: 'text',
  options: null,
  durableSelector: '#question_888',
  id: 'question_888',
  required: true,
} as never;

test('a failed probe on a free-text control raises no exact-options blocker', () => {
  const blockers = questionMetadataBlockersForOptionProbeFailures(
    'greenhouse' as never,
    [textField],
    [{ controlId: 'question_17808233008' }],
  );
  assert.deepEqual(blockers.filter((b) => b.kind === 'missing_exact_options'), []);
});

test('a failed probe on a real closed control still raises it', () => {
  const blockers = questionMetadataBlockersForOptionProbeFailures(
    'greenhouse' as never,
    [selectField],
    [{ controlId: 'question_999' }],
  );
  assert.equal(blockers.filter((b) => b.kind === 'missing_exact_options').length, 1);
});

/* Only the exact-options kind is filtered: an unlabelled text field is a real defect the applicant
 * cannot answer, and that blocker must survive for every control type. */
test('an unlabelled text control still raises missing_question_text', () => {
  const blockers = questionMetadataBlockersForOptionProbeFailures(
    'greenhouse' as never,
    [unlabelledText],
    [{ controlId: 'question_888' }],
  );
  assert.equal(blockers.filter((b) => b.kind === 'missing_question_text').length, 1);
});
