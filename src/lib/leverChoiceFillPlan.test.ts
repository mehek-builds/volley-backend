/* THE DGA RADIO PLAN, ASSERTED AS THE PLAN SHAPE RATHER THAN AS A RUN.
 *
 * Measured in production 2026-08-28 (application c3093dee, jobs.lever.co/dga, run at 11:31 UTC,
 * run_revision b9566f8e): five required radio questions carried applicant-reviewed answers, exact
 * discovered options and durable [name="cards[<uuid>][fieldN]"] selectors, and every run ended with
 * each of them "required and is still empty". The runner-side chooser for a durable-name fill at a
 * radio group had already shipped (stratus-browser-cloud PR #116) and never fired, because this
 * planner emitted only an optional label-scoped fillByLabelText for Lever choice questions - no
 * fill action targeting a cards[...] group name was in the plan at all.
 *
 * These tests pin the repaired plan shape: on Lever the discovered group name leads, one fill per
 * proven option value; a value the inventory cannot prove exactly falls back to the label path; and
 * Ashby keeps its label-scoped action, because its durable selector resolves to a display:none
 * mirror input that a selector-aimed action cannot drive.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildManagedPortalActions, type SubmissionPacket } from './portalSubmission';

const DGA_AUTHORIZED_SELECTOR = '[name="cards[67287a5d-d48f-428a-8881-fbe076caa364][field0]"]';
const DGA_EXPERIENCE_SELECTOR = '[name="cards[f830b2fd-2b0d-49f1-97a5-a9a5f01a7f5d][field2]"]';

function leverPacket(questions: unknown[], fieldOptions: Record<string, string[]> = {}): SubmissionPacket {
  return {
    fullName: 'Mehek Mandal',
    email: 'mehekman@usc.edu',
    phone: '+1 213 555 0100',
    resume: 'BASE64',
    resumeName: 'resume.pdf',
    jdText: 'DGA organizing role',
    fieldOptions,
    questions,
  } as unknown as SubmissionPacket;
}

test('a Lever radio question with an applicant-reviewed answer plans a fill at its group name', () => {
  const actions = buildManagedPortalActions('lever', leverPacket([
    {
      question: 'are you authorized to work lawfully in the united states? ✱',
      answer: 'Yes',
      required: true,
      options: ['Yes', 'No'],
      answer_source: 'applicant_review',
      portal_selector: DGA_AUTHORIZED_SELECTOR,
      portal_input_type: 'radio',
    },
  ], {
    'name:cards[67287a5d-d48f-428a-8881-fbe076caa364][field0]': ['Yes', 'No'],
  }));
  const groupFill = actions.find((action) => action.type === 'fill' && action.selector === DGA_AUTHORIZED_SELECTOR);
  assert.ok(groupFill, 'the plan must carry a fill aimed at the discovered cards[...] group name');
  assert.equal(groupFill!.value, 'Yes');
  assert.equal(
    actions.some((action) => action.type === 'fillByLabelText'
      && /authorized to work lawfully/.test(String(action.text))),
    false,
    'the group-name fill replaces the label-scoped action that measured as a silent no-op on Lever',
  );
});

test('the answer fills with the employer’s own canonical option text', () => {
  const actions = buildManagedPortalActions('lever', leverPacket([
    {
      question: 'how many years of experience do you have in organizing/field? ✱',
      answer: '1-2 years',
      required: true,
      answer_source: 'applicant_review',
      portal_selector: DGA_EXPERIENCE_SELECTOR,
      portal_input_type: 'radio',
    },
  ], {
    'name:cards[f830b2fd-2b0d-49f1-97a5-a9a5f01a7f5d][field2]':
      ['0 years (that’s okay!)', '1-2 years', '3-5 years', '6+ years'],
  }));
  const groupFill = actions.find((action) => action.type === 'fill' && action.selector === DGA_EXPERIENCE_SELECTOR);
  assert.ok(groupFill);
  assert.equal(groupFill!.value, '1-2 years');
});

test('a radio answer the inventory cannot prove exactly keeps the label-scoped fallback', () => {
  const actions = buildManagedPortalActions('lever', leverPacket([
    {
      question: 'are you open to relocation? ✱',
      answer: 'Yes and No',
      required: true,
      answer_source: 'applicant_review',
      portal_selector: DGA_AUTHORIZED_SELECTOR,
      portal_input_type: 'radio',
    },
  ], {
    'name:cards[67287a5d-d48f-428a-8881-fbe076caa364][field0]': ['Yes', 'No'],
  }));
  assert.equal(
    actions.some((action) => action.type === 'fill' && action.selector === DGA_AUTHORIZED_SELECTOR),
    false,
    'an unproven value must never be aimed at the group',
  );
  assert.ok(actions.some((action) => action.type === 'fillByLabelText'
    && /open to relocation/.test(String(action.text))));
});

test('Ashby choice questions keep the label-scoped action, never a selector fill', () => {
  const mirrorSelector = '[name="477fc43f-966e-4740-b93b-71f92b83993e"]';
  const actions = buildManagedPortalActions('ashby', leverPacket([
    {
      question: 'are you legally authorized to work in the country where this role is located?',
      answer: 'Yes',
      required: true,
      answer_source: 'applicant_review',
      portal_selector: mirrorSelector,
      portal_input_type: 'checkbox',
    },
  ]));
  assert.equal(
    actions.some((action) => action.type === 'fill' && action.selector === mirrorSelector),
    false,
    'Ashby’s durable selector is a display:none mirror input; a selector-aimed fill cannot drive it',
  );
  assert.ok(actions.some((action) => action.type === 'fillByLabelText'
    && /legally authorized to work/.test(String(action.text))));
});
