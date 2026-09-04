/* THE FORM THAT ASKS FOR THE GPA TWICE, AND THE ONE WORD THAT NAMED BOTH CONTROLS.
 *
 * Measured live 2026-09-03 on Hudson River Trading packet 4a79eec1 (greenhouse job-boards, job
 * 8052083, read from boards-api.greenhouse.io/v1/boards/wehrtyou/jobs/8052083?questions=true). The
 * posting carries two GPA controls on purpose:
 *
 *   question_68000287  "What is your overall college/university GPA?" - a 13-band react-select
 *                      whose options include "3.76 - 4.0", the band she reviewed and chose.
 *   question_68000289  an `input_text` with zero values, rendered as a bare
 *                      <input type="text" class="input input__single-line">, captioned "We
 *                      recognize that the options above may not cover all global grading systems.
 *                      Please feel free to write in your GPA below without conversion, along with
 *                      the corresponding scale and any other relevant details."
 *
 * portalSubmission emitted `{type:'fillByLabelText', text:'GPA', value:'3.89', label:'gpa'}`. The
 * runner resolves an anchor by exact label match and then by any label CONTAINING it, and takes
 * `.first()`: against that markup the exact pass found 0 and the loose pass found 4, of which the
 * first was `<label id="question_68000287-label">` - the BAND. So the run opened the band control,
 * typed "3.89" into its react-select search box, watched thirteen options filter to none, and read
 * react-select's own empty-menu notice back to her as the employer's offer:
 *
 *   status: failed
 *   attention_reason: ... "gpa" (no option matched "3.89" (the list offered: "No options"),
 *                     left for you to choose)
 *
 * Nothing reached the employer.
 *
 * HOW THESE ASSERTIONS ARE WRITTEN, and it is the reason they are not action counts. The harm is
 * not "an extra action exists", it is "a value can arrive at a control that cannot hold it". So
 * `actionCouldReach` below re-implements the runner's own two-pass resolution and every assertion
 * is phrased against a named control on the form. That is what makes them survive the second GPA
 * emitter, whose anchor is the full sentence "What is your GPA?" - a phrase no label on this
 * posting contains, so it resolves to nothing here and is left exactly as it was.
 *
 * Each test below was re-run against the unfixed helper body and against a managedAnchorResolution
 * shimmed to `undefined`, and each one failed there. The survivors are recorded in the PR.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildManagedPortalActions,
  type SubmissionPacket,
} from './portalSubmission';
import type { ManagedBrowserAction } from './browserbase';

const WRITE_IN_LABEL = 'We recognize that the options above may not cover all global grading systems. '
  + 'Please feel free to write in your GPA below without conversion, along with the corresponding '
  + 'scale and any other relevant details.';

const BAND_LABEL = 'What is your overall college/university GPA?';

/** The bands the posting publishes, trimmed to the rows these assertions depend on. */
const BAND_OPTIONS = ['< 3.0', '3.01 - 3.25', '3.26 - 3.50', '3.51 - 3.75', '3.76 - 4.0'];

const BAND = { selector: '#question_68000287', label: BAND_LABEL };
const WRITE_IN = { selector: '#question_68000289', label: WRITE_IN_LABEL };

const BAND_QUESTION = {
  question: BAND_LABEL,
  answer: '3.76 - 4.0',
  answerSource: 'applicant_review',
  portalSelector: BAND.selector,
  portalInputType: 'combobox',
};

const WRITE_IN_QUESTION = {
  question: WRITE_IN_LABEL,
  answer: '',
  portalSelector: WRITE_IN.selector,
  portalInputType: 'text',
};

const words = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * THE RUNNER'S OWN RESOLUTION, RE-STATED HERE so the assertions are about where a value can land
 * rather than about how many actions were emitted. A selector-scoped action reaches exactly the
 * control it names. A label-scoped action reaches every control whose label contains its anchor,
 * which is the whole defect.
 */
function actionCouldReach(action: ManagedBrowserAction, control: { selector: string; label: string }): boolean {
  if (action.type === 'fillByLabelText') {
    const anchor = words(action.text ?? '');
    return Boolean(anchor) && words(control.label).includes(anchor);
  }
  return (action.selector ?? '') === control.selector;
}

function hrtPacket(overrides: Record<string, unknown> = {}): SubmissionPacket {
  return {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    school: 'University of Southern California',
    degree: 'Bachelor of Science in Computer Science',
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    gpa: '3.89',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [BAND_QUESTION, WRITE_IN_QUESTION],
    fieldOptions: { question_68000287: BAND_OPTIONS },
    ...overrides,
  } as unknown as SubmissionPacket;
}

const build = (packet: SubmissionPacket) => buildManagedPortalActions('greenhouse', packet);
const rawGpa = (packet: SubmissionPacket) => build(packet).filter((action) => action.value === '3.89');
const reaching = (packet: SubmissionPacket, control: { selector: string; label: string }) =>
  rawGpa(packet).filter((action) => actionCouldReach(action, control));

test('the raw GPA is left in the write-in control the employer provided for it', () => {
  const packet = hrtPacket();
  assert.deepEqual(
    reaching(packet, WRITE_IN).map((action) => ({ type: action.type, selector: action.selector })),
    [{ type: 'fill', selector: WRITE_IN.selector }],
    'her 3.89 belongs in the write-in, addressed by the id discovery read off that control',
  );
  // The band keeps her reviewed answer, and it is the band's own full wording that carries it -
  // a sentence no other label on this form contains, so it resolves to one control.
  const band = build(packet).filter((action) => action.value === '3.76 - 4.0');
  assert.equal(band.length > 0, true, 'her reviewed band answer must still be filled');
  for (const action of band) {
    assert.equal(
      actionCouldReach(action, BAND),
      true,
      `her band answer must reach question_68000287, not ${action.selector ?? action.text}`,
    );
  }
});

test('the measured failure cannot recur: no emitted action can drive the band with a raw GPA', () => {
  /* The band's option list DELIBERATELY absent, which is the state the failed run was in: the
   * "No options" notice is react-select's, not a read list, so the answer-outranks-guess
   * suppression added for this same packet cannot fire and the bare 'GPA' anchor is the only
   * thing standing between "3.89" and the band's search box. */
  const packet = hrtPacket({ fieldOptions: {} });
  assert.deepEqual(
    reaching(packet, BAND),
    [],
    'the raw profile GPA must never be able to reach the banded dropdown',
  );
  assert.equal(
    build(packet).some((action) => action.type === 'fillByLabelText' && action.text === 'GPA'),
    false,
    'a bare-word GPA anchor must not be sent to a form that spells the word on two controls',
  );
  assert.deepEqual(
    reaching(packet, WRITE_IN).map((action) => action.selector),
    [WRITE_IN.selector],
    'and the write-in is still the one control that gets it',
  );
});

test('a write-in the review already answered is not filled twice, and never with the profile value', () => {
  const packet = hrtPacket({
    questions: [BAND_QUESTION, { ...WRITE_IN_QUESTION, answer: '3.89/4.0 (USC)' }],
  });
  assert.deepEqual(
    build(packet).filter((action) => action.selector === WRITE_IN.selector).map((action) => action.value),
    ['3.89/4.0 (USC)'],
    'the reviewed-question chain owns an answered control; the alias must add nothing to it',
  );
  assert.deepEqual(reaching(packet, WRITE_IN), [], 'the profile value must not chase an answered control');
  assert.deepEqual(reaching(packet, BAND), [], 'nor go looking for the band instead');
});

test('when every control the anchor names is a closed list, the raw GPA reaches none of them', () => {
  /* Both controls are menus and neither published a list, so nothing on this form can accept a
   * raw "3.89". Emitting the anchor anyway is how the measured failure happened; the honest
   * outcome is to emit nothing and leave the field to her. */
  const scale = { selector: '#question_68000290', label: 'Please select the GPA scale your school uses' };
  const packet = hrtPacket({
    fieldOptions: {},
    questions: [
      { ...BAND_QUESTION, answer: '' },
      { question: scale.label, answer: '', portalSelector: scale.selector, portalInputType: 'select' },
    ],
  });
  assert.deepEqual(reaching(packet, BAND), [], 'no closed list may be handed a value no read list vouches for');
  assert.deepEqual(reaching(packet, scale), [], 'and that holds for every one of them, not just the first');
});

test('two controls that could each hold the value are left exactly as they were', () => {
  /* THE LINE THIS FIX WILL NOT CROSS. A Greenhouse education section renders "End date year" once
   * per row, and both rows are genuine text inputs, so neither is provably the wrong control.
   * Choosing between them is the runner's `.first()`, and swapping that blind guess for a
   * different blind guess here would be no better. The plain label fill goes out unchanged. */
  const packet = hrtPacket({
    fieldOptions: {},
    questions: [
      { question: 'End date year', answer: '', portalSelector: '#end-year--0', portalInputType: 'text' },
      { question: 'End date year', answer: '', portalSelector: '#end-year--1', portalInputType: 'text' },
    ],
  });
  assert.deepEqual(
    build(packet)
      .filter((action) => action.type === 'fillByLabelText' && action.text === 'End date year')
      .map((action) => action.value),
    ['2028'],
    'an anchor with no provably-wrong target keeps its existing label fill',
  );
});

test('an anchor the form spells exactly is left on the path that already resolves it', () => {
  /* The runner matches an exact label before it ever runs the loose pass, so a control spelled
   * "GPA" is already reached deterministically and this fix stands aside. */
  const packet = hrtPacket({
    fieldOptions: {},
    questions: [
      { question: 'GPA', answer: '', portalSelector: '#question_1', portalInputType: 'text' },
      { question: 'GPA range', answer: '', portalSelector: '#question_2', portalInputType: 'combobox' },
    ],
  });
  assert.equal(
    build(packet).some((action) => action.type === 'fillByLabelText' && action.text === 'GPA' && action.value === '3.89'),
    true,
    'an unambiguous exact anchor keeps the label fill it has always had',
  );
});

test('the new bound fill does not slip past the last-line failed-control invariant', () => {
  /* A BOUNDARY TEST, AND IT IS HONEST ABOUT WHOSE CODE ENFORCES WHICH HALF. The write-in refusal
   * comes from managedActionTargetsFailedField, the exact-id filter at the end of the build whose
   * own comment says it exists so "a newly added fallback cannot silently bypass" the builder
   * guards; this bound fill IS a newly added fallback and its selector shape is what decides
   * whether that filter can see it. The BAND assertion is this diff's: that filter matches the
   * failed control by id and by exact label, and a bare 'GPA' anchor is neither, so with the
   * resolution neutered the value reaches the band right past it. */
  const packet = hrtPacket({
    fieldOptions: {},
    failedFields: [{ controlId: 'question_68000289', label: WRITE_IN_LABEL, selector: WRITE_IN.selector }],
  });
  assert.deepEqual(reaching(packet, WRITE_IN), [], 'a failed control must not receive a bound fill');
  assert.deepEqual(reaching(packet, BAND), [], 'and the value must not be redirected at the band instead');
});

test('one discovered GPA control is left to the ladder, however unpromising its list looks', () => {
  /* THE SCOPE OF THIS FIX, PINNED SO IT CANNOT BE WIDENED QUIETLY. Exactly one control here carries
   * the word, its read options do not include "3.89", and this still does not stand the ladder
   * down. The packet only ever sees the controls DISCOVERY turned into questions, so a form can
   * carry a GPA field this list does not mention, and on such a form the ladder is that field's
   * only fill - the same reason packetAnswerOutranksAliasGuess refuses to act on an unprobed
   * control. This fix answers ambiguity, and one control is not ambiguous. */
  const packet = hrtPacket({
    fieldOptions: { question_68000287: BAND_OPTIONS },
    questions: [{ ...BAND_QUESTION, answer: '', answerSource: undefined }],
  });
  assert.equal(
    build(packet).some((action) => action.type === 'fillByLabelText' && action.text === 'GPA' && action.value === '3.89'),
    true,
    'a single named control keeps the speculative ladder it has always had',
  );
});

test('a control with no durable handle is refused rather than addressed by the ambiguous word', () => {
  /* Discovery reports a temporary marker for controls it cannot name durably. There is no way to
   * bind to that, and falling back to the bare anchor is the defect itself, so nothing is sent. */
  const packet = hrtPacket({
    fieldOptions: {},
    questions: [BAND_QUESTION, { ...WRITE_IN_QUESTION, portalSelector: '[data-litos-discovered-7]' }],
  });
  assert.deepEqual(reaching(packet, BAND), [], 'an unbindable target must not put the value at the band');
  assert.equal(
    build(packet).some((action) => action.type === 'fillByLabelText' && action.text === 'GPA'),
    false,
    'nor fall back to the anchor that started this',
  );
});

test('a posting with one GPA control keeps the behaviour it already had', () => {
  // The regression guard for every ordinary form: one control, nothing ambiguous, nothing changes.
  const packet = hrtPacket({
    fieldOptions: {},
    questions: [{ question: 'GPA (out of 4.0)', answer: '', portalSelector: '#question_9', portalInputType: 'text' }],
  });
  assert.equal(
    build(packet).some((action) => action.type === 'fillByLabelText' && action.text === 'GPA' && action.value === '3.89'),
    true,
    "a single named control is the runner's to resolve, as it always was",
  );
});
