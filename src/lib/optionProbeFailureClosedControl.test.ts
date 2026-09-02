import test from 'node:test';
import assert from 'node:assert/strict';
import { questionMetadataBlockersForOptionProbeFailures } from './questionMetadata';

/* AN OPTION PROBE THAT FAILED AGAINST A FREE-TEXT FIELD IS NOT AN OPTION PROBLEM.
 *
 * questionMetadataBlockerForOptionProbeFailure returns 'missing_exact_options' for anything with a
 * readable label and never checks that the control is closed, so a probe against a text field parks
 * the packet on "Litos could not read the exact options" for a control that can never have any.
 * Measured on Five Rings 767ed539 (Greenhouse): {kind:'missing_exact_options',
 * portal_input_type:'text', required:false} on an OPTIONAL "details on competing offers" field.
 *
 * THE GUARD ASKS THE PROBE, NOT THE OPTIONS. A first cut asked discoveredQuestionControlType, which
 * decides closedness from field.options - the evidence a failed probe did not produce - so it called
 * Greenhouse's react-selects open text and deleted their blockers. Those blockers are a hard send
 * gate, so that was a critical regression. The react-select case below is the regression test.
 */
const field = (over: Record<string, unknown>) => ({
  label: 'Question', inputType: 'text', role: null, options: null, required: true, ...over,
} as never);

const blockers = (f: unknown, controlId: string) =>
  questionMetadataBlockersForOptionProbeFailures('greenhouse' as never, [f as never], [{ controlId }]);

test('a failed probe on a genuine free-text control raises no exact-options blocker', () => {
  const f = field({
    label: 'If you answered yes to the above, please provide details on competing offers',
    durableSelector: '#question_17808233008', id: 'question_17808233008', required: false,
  });
  assert.deepEqual(blockers(f, 'question_17808233008').filter((b) => b.kind === 'missing_exact_options'), []);
});

/* THE REGRESSION TEST FOR THE CRITICAL.
 * Greenhouse's education controls are react-selects whose inner element is <input type="text"> with
 * no options in the DOM until the menu opens, and whose taxonomies load over the network - so the
 * probe's documented failure for them is "the option list was still loading". They are held closed
 * by MANAGED_FIXED_CLOSED_CONTROL_IDS, and their blocker must survive. */
const REACT_SELECTS: ReadonlyArray<readonly [string, string]> = [
  // Labels as discovery actually reports them - Greenhouse prefixes the required marker and the
  // control handle. A BARE control id is not a label at all and correctly becomes
  // missing_question_text instead, which the last test in this file pins.
  ['school--0', 'school* school--0'],
  ['degree--0', 'degree* degree--0'],
  ['discipline--0', 'discipline* discipline--0'],
  ['end-month--0', 'end-month* end-month--0'],
];
for (const [controlId, label] of REACT_SELECTS) {
  test(`a failed probe on the ${controlId} react-select still blocks`, () => {
    const f = field({ label, durableSelector: `#${controlId}`, id: controlId });
    assert.equal(blockers(f, controlId).filter((b) => b.kind === 'missing_exact_options').length, 1,
      'a react-select reported as text must not lose its blocker');
  });
}

test('a failed probe on a native select still blocks', () => {
  const f = field({
    label: 'Are you legally authorized to work in the United States?',
    inputType: 'select-one', durableSelector: '#question_999', id: 'question_999',
  });
  assert.equal(blockers(f, 'question_999').filter((b) => b.kind === 'missing_exact_options').length, 1);
});

test('a failed probe on a declared combobox still blocks', () => {
  const f = field({
    label: 'Highest degree attained', inputType: 'combobox',
    durableSelector: '#question_777', id: 'question_777',
  });
  assert.equal(blockers(f, 'question_777').filter((b) => b.kind === 'missing_exact_options').length, 1);
});

/* Only the exact-options kind is filtered: an unlabelled text field is a real defect the applicant
 * cannot answer, and that blocker must survive for every control type. */
test('an unlabelled text control still raises missing_question_text', () => {
  const f = field({ label: '', durableSelector: '#question_888', id: 'question_888' });
  assert.equal(blockers(f, 'question_888').filter((b) => b.kind === 'missing_question_text').length, 1);
});
