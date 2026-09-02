/* A CLOSED-LIST CONTROL GETS A CHOICE, NOT A TYPED FILL, ON EVERY FAMILY.
 *
 * Measured in production 2026-09-02: DSI Innovations on Recruitee (packet a34e5ce2, host
 * dsiinnovations.recruitee.com). Discovery completed in 1,439 ms and read the calling-code picker
 * correctly - durable selector `#country-select-input-candidate\.phone-undefined`, a role=combobox
 * button bound to a downshift listbox, stored as portal_input_type `combobox`. The plan still aimed
 * a bare `fill` of "United States" at it, because the only combobox arm in the reviewed-question
 * loop is keyed on `portalFamily(portal) === 'greenhouse'`. The runner routes a fill whose target
 * reports role=combobox into its unbounded custom chooser; it walked a 246-row virtualised country
 * list until the 270 s provider deadline closed the page under its own wait. The run returned 502
 * after 270,086 ms at `runProgress.action.index: 5, type: fill, label: "question:select country
 * calling code: united sta..."`, the review was persisted failed, and a per-user lock was held for
 * the whole 270 s.
 *
 * The evidence to do better was already computed in that loop and thrown away: the option inventory
 * the probe READ for this exact control was consumed only inside the Greenhouse arm.
 *
 * These tests pin the generalised plan shape: a measured closed list is dispatched on its shape, a
 * native select takes the existing select action, an open control still fills, an answer no offered
 * row matches emits nothing at all rather than being typed, and Greenhouse's existing plans are
 * unchanged.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildManagedPortalActions, type SubmissionPacket } from './portalSubmission';

/** The exact durable selector discovery stored for the DSI calling-code picker. */
const DSI_CALLING_CODE_SELECTOR = '#country-select-input-candidate\\.phone-undefined';
/** The option-inventory key that selector derives to, and the key prod's field_options carried. */
const DSI_CALLING_CODE_CONTROL_ID = 'country-select-input-candidate.phone-undefined';
const DSI_CALLING_CODE_QUESTION = 'select country calling code: united states';

function packetFor(
  questions: unknown[],
  fieldOptions: Record<string, string[]> = {},
): SubmissionPacket {
  return {
    fullName: 'Mehek Mandal',
    email: 'mehekman@usc.edu',
    phone: '+1 213 574 6270',
    resume: 'BASE64',
    resumeName: 'resume.pdf',
    jdText: 'Junior Automation Engineer',
    fieldOptions,
    questions,
  } as unknown as SubmissionPacket;
}

function callingCodeQuestion(answer: string) {
  return {
    question: DSI_CALLING_CODE_QUESTION,
    answer,
    required: true,
    portal_selector: DSI_CALLING_CODE_SELECTOR,
    portal_input_type: 'combobox',
  };
}

/** Every action this plan aimed at the calling-code control, by selector or by question label. */
function callingCodeActions(actions: ReturnType<typeof buildManagedPortalActions>) {
  return actions.filter((action) => action.selector === DSI_CALLING_CODE_SELECTOR
    || String(action.text ?? '') === DSI_CALLING_CODE_QUESTION);
}

test('a Recruitee calling-code combobox plans a choice against its measured option list, never a fill', () => {
  const actions = buildManagedPortalActions('recruitee', packetFor(
    [callingCodeQuestion('United States')],
    // The employer's own rows, in the order react-phone-number-input sorts them.
    { [DSI_CALLING_CODE_CONTROL_ID]: ['International', 'Ukraine', 'United Arab Emirates', 'United Kingdom', 'United States', 'Uruguay'] },
  ));
  const aimed = callingCodeActions(actions);
  assert.equal(
    aimed.some((action) => action.type === 'fill'),
    false,
    'the fill that hung the DSI run for 270 s must not be in the plan',
  );
  const choice = aimed.find((action) => action.type === 'fillByLabelText');
  assert.ok(choice, 'a measured combobox must get the runner\'s scoped choice action');
  assert.equal(choice!.text, DSI_CALLING_CODE_QUESTION);
  // The employer's canonical row text, not the answer string as it happened to be written.
  assert.equal(choice!.value, 'United States');
  assert.equal(aimed.length, 1, 'one control, one action');
});

test('a listbox control is dispatched on the same measured shape as a combobox', () => {
  const actions = buildManagedPortalActions('recruitee', packetFor([
    {
      ...callingCodeQuestion('United States'),
      portal_input_type: 'listbox',
    },
  ], { [DSI_CALLING_CODE_CONTROL_ID]: ['International', 'United Kingdom', 'United States'] }));
  const aimed = callingCodeActions(actions);
  assert.equal(aimed.some((action) => action.type === 'fill'), false);
  assert.equal(aimed.filter((action) => action.type === 'fillByLabelText').length, 1);
});

test('the measured DSI inventory offers no "United States" row, so the plan types nothing at all', () => {
  /* What prod actually held for this control. The listbox is react-virtual'd, so the closed DOM
   * renders only the first two rows and that is all the probe could read. "United States" is not
   * among them, and a control the employer has not offered it on is the applicant's to answer. */
  const actions = buildManagedPortalActions('recruitee', packetFor(
    [callingCodeQuestion('United States')],
    { [DSI_CALLING_CODE_CONTROL_ID]: ['International', 'Afghanistan'] },
  ));
  assert.deepEqual(
    callingCodeActions(actions).map((action) => action.type),
    [],
    'an answer no offered row matches is surfaced to the applicant, never guessed onto the form',
  );
});

test('a native select plans the select action at its measured selector', () => {
  const actions = buildManagedPortalActions('recruitee', packetFor([
    {
      question: 'highest level of education',
      answer: "Bachelor's Degree",
      required: true,
      portal_selector: '#education-level',
      portal_input_type: 'select',
    },
  ], { 'education-level': ['High School', "Bachelor's Degree", "Master's Degree"] }));
  const aimed = actions.filter((action) => action.selector === '#education-level');
  assert.deepEqual(aimed.map((action) => action.type), ['select']);
  assert.equal(aimed[0].value, "Bachelor's Degree");
});

test('an open text control still fills, with its answer, at its measured selector', () => {
  const actions = buildManagedPortalActions('recruitee', packetFor([
    {
      question: 'why do you want to work here?',
      answer: 'Because the automation work is hands-on.',
      required: true,
      portal_selector: '#question-motivation',
      portal_input_type: 'text',
    },
  ], { 'question-motivation': [] }));
  const aimed = actions.filter((action) => action.selector === '#question-motivation');
  assert.deepEqual(aimed.map((action) => action.type), ['fill']);
  assert.equal(aimed[0].value, 'Because the automation work is hands-on.');
});

test('a combobox with no read inventory keeps the plan it has today', () => {
  // No probe evidence means no proof of what is on offer, so this change withholds nothing: the
  // pre-existing fill stays, and the generalisation is confined to controls that were measured.
  const actions = buildManagedPortalActions('recruitee', packetFor([callingCodeQuestion('United States')]));
  assert.deepEqual(callingCodeActions(actions).map((action) => action.type), ['fill']);
});

test('Greenhouse combobox plans are unchanged: the family arm above still owns them', () => {
  const actions = buildManagedPortalActions('greenhouse', packetFor([
    {
      question: 'what is your highest level of education?',
      answer: "Bachelor's Degree",
      required: true,
      answer_source: 'applicant_review',
      portal_selector: '#question_12345',
      portal_input_type: 'combobox',
    },
  ], { 'question_12345': ['High School', "Bachelor's Degree"] }));
  const aimed = actions.filter((action) => action.selector === '#question_12345'
    || String(action.text ?? '') === 'what is your highest level of education?');
  assert.deepEqual(aimed.map((action) => action.type), ['fillByLabelText']);
  assert.equal(aimed[0].value, "Bachelor's Degree");
});

test('a Greenhouse native select keeps its existing fill-led plan, unchanged by the new arm', () => {
  const actions = buildManagedPortalActions('greenhouse', packetFor([
    {
      question: 'preferred office',
      answer: 'New York',
      required: true,
      portal_selector: '#office-select',
      portal_input_type: 'select',
    },
  ], { 'office-select': ['New York', 'London'] }));
  const aimed = actions.filter((action) => action.selector === '#office-select');
  assert.equal(aimed.some((action) => action.type === 'select'), false, 'Greenhouse plans stay pinned');
  const fill = aimed.find((action) => action.type === 'fill');
  assert.ok(fill, 'the Greenhouse fall-through still leads with its fill');
  assert.equal(fill!.value, 'New York');
});

test('a Recruitee radio question still takes the checkbox/radio arm, untouched', () => {
  const actions = buildManagedPortalActions('recruitee', packetFor([
    {
      question: 'are you legally authorized to work in the united states?',
      answer: 'Yes',
      required: true,
      portal_selector: '#authorized',
      portal_input_type: 'radio',
    },
  ], { authorized: ['Yes', 'No'] }));
  const aimed = actions.filter((action) => action.selector === '#authorized'
    || String(action.text ?? '') === 'are you legally authorized to work in the united states?');
  assert.deepEqual(aimed.map((action) => action.type), ['fillByLabelText']);
});
