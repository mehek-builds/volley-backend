/* THE FORM THAT ASKS FOR THE GPA THREE TIMES, AND THE ONE WORD THAT NAMED ALL THREE CONTROLS.
 *
 * Measured live 2026-09-03 on Hudson River Trading packet 4a79eec1 (greenhouse job-boards, job
 * 8052083, "Software Engineering Internship (C++ or Python) - Summer 2027", read from
 * boards-api.greenhouse.io/v1/boards/wehrtyou/jobs/8052083?questions=true). The posting spells
 * "GPA" on THREE controls, all three deliberate, and the fixtures below are that response verbatim:
 *
 *   question_68000287  "What is your overall college/university GPA?" - a required 13-band
 *                      multi_value_single_select whose options include "3.76 - 4.0", the band she
 *                      reviewed and chose, alongside four UK honours classes.
 *   question_68000288  "Please select the corresponding GPA scale:" - a required three-option
 *                      multi_value_single_select, a DIFFERENT stored field entirely.
 *   question_68000289  an `input_text` with zero values, not required, rendered as a bare
 *                      <input type="text" class="input input__single-line">, captioned "We
 *                      recognize that the options above may not cover all global grading systems.
 *                      Please feel free to write in your GPA below without conversion, along with
 *                      the corresponding scale and any other relevant details."
 *
 * portalSubmission emitted `{type:'fillByLabelText', text:'GPA', value:'3.89', label:'gpa'}`. The
 * runner resolves an anchor by exact label match and then by any label CONTAINING it, and takes
 * `.first()`: against that markup the exact pass found 0 and the loose pass found 4, of which the
 * first was `<label id="question_68000287-label">` - the BAND. Three of those four loose hits are
 * the controls above, which is the whole point: one word, three controls, DOM order deciding.
 *
 * So the run opened the band control, typed "3.89" into its react-select search box, watched
 * thirteen options filter to none, and read react-select's own empty-menu notice back to her as
 * the employer's offer:
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
 * Thirteen mutations were applied to the production file with this file untouched, helpers shimmed
 * to a constant rather than deleted, including deletion of the GPA CALL SITE itself. Every one was
 * caught. The PR carries the table and the one guard that was written, could not be made to fail,
 * and was therefore deleted rather than shipped.
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

const SCALE_LABEL = 'Please select the corresponding GPA scale:';

/** The thirteen bands the posting publishes, in the board API's own order. */
const BAND_OPTIONS = [
  'First-Class Honours (UK)', 'Upper Second-Class Honours (UK)', 'Lower Second-Class Honours (UK)',
  'Third-Class Honours (UK)', '< 3.0', '3.01 - 3.25', '3.26 - 3.50', '3.51 - 3.75', '3.76 - 4.0',
  '4.01 - 4.25', '4.26 - 4.50', '4.51 - 4.75', '4.76 - 5.0',
];
const SCALE_OPTIONS = ['0.0 - 4.0', '0.0 - 5.0', 'UK Grading Scale'];

const BAND = { selector: '#question_68000287', label: BAND_LABEL };
const SCALE = { selector: '#question_68000288', label: SCALE_LABEL };
const WRITE_IN = { selector: '#question_68000289', label: WRITE_IN_LABEL };

const BAND_QUESTION = {
  question: BAND_LABEL,
  answer: '3.76 - 4.0',
  answerSource: 'applicant_review',
  portalSelector: BAND.selector,
  portalInputType: 'combobox',
};

const SCALE_QUESTION = {
  question: SCALE_LABEL,
  answer: '0.0 - 4.0',
  answerSource: 'applicant_review',
  portalSelector: SCALE.selector,
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
    questions: [BAND_QUESTION, SCALE_QUESTION, WRITE_IN_QUESTION],
    fieldOptions: { question_68000287: BAND_OPTIONS, question_68000288: SCALE_OPTIONS },
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
  assert.deepEqual(
    reaching(packet, SCALE),
    [],
    'nor the scale menu beside it, which is a different stored field entirely',
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
    questions: [BAND_QUESTION, SCALE_QUESTION, { ...WRITE_IN_QUESTION, answer: '3.89/4.0 (USC)' }],
  });
  assert.deepEqual(
    build(packet).filter((action) => action.selector === WRITE_IN.selector).map((action) => action.value),
    ['3.89/4.0 (USC)'],
    'the reviewed-question chain owns an answered control; the alias must add nothing to it',
  );
  assert.deepEqual(reaching(packet, WRITE_IN), [], 'the profile value must not chase an answered control');
  assert.deepEqual(reaching(packet, BAND), [], 'nor go looking for the band instead');
  assert.deepEqual(reaching(packet, SCALE), [], 'nor the scale menu');
  // Her reviewed scale answer is untouched throughout, and it reaches only the scale control.
  const scale = build(packet).filter((action) => action.value === '0.0 - 4.0');
  assert.equal(scale.length > 0, true, 'the scale answer must still be filled');
  for (const action of scale) {
    assert.equal(actionCouldReach(action, SCALE), true, 'the scale answer reaches the scale menu');
    assert.equal(actionCouldReach(action, BAND), false, 'and never the band beside it');
    assert.equal(actionCouldReach(action, WRITE_IN), false, 'and never the write-in');
  }
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
    questions: [BAND_QUESTION, SCALE_QUESTION, { ...WRITE_IN_QUESTION, portalSelector: '[data-litos-discovered-7]' }],
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

/* THE ROW THIS RESOLUTION MUST NOT TOUCH, and why the GPA reasoning does not travel to it.
 *
 * A Greenhouse education section repeats the same anchor once per row, so "End date year" names two
 * controls exactly. The GPA band's read list IS the whole of what that control accepts, so "3.89 is
 * not among these thirteen" really does prove the band cannot hold it. An education year menu's read
 * list is a TRUNCATED WINDOW: row 0 commonly publishes only the next few years. Refusing row 0 on
 * that basis makes row 1 the sole survivor and binds her graduation year to her SECOND education
 * entry, while the runner's own .first() lands it on row 0 correctly.
 *
 * Measured on PR #920 before the resolution was scoped to the GPA anchors:
 *   main only: {"type":"fillByLabelText","text":"End date year","value":"2028",...}
 *   PR   only: {"type":"fill","selector":"#end-year--1","value":"2028",...}
 *
 * Row 0 is a combobox with a real, non-empty, capped option list, which is exactly the configuration
 * the file's other education fixture does not model: giving both rows portalInputType 'text' and no
 * fieldOptions lands in the stand-aside clause, so it pins the safe case and nothing pins this one. */
const EDU_ANCHOR = 'End date year';
const EDU_ROW_0 = { selector: '#end-year--0', label: EDU_ANCHOR };
const EDU_ROW_1 = { selector: '#end-year--1', label: EDU_ANCHOR };

function twoRowEducationPacket(): SubmissionPacket {
  return hrtPacket({
    questions: [
      BAND_QUESTION,
      SCALE_QUESTION,
      WRITE_IN_QUESTION,
      { question: EDU_ANCHOR, answer: '', portalSelector: EDU_ROW_0.selector, portalInputType: 'combobox' },
      { question: EDU_ANCHOR, answer: '', portalSelector: EDU_ROW_1.selector, portalInputType: 'combobox' },
    ],
    fieldOptions: {
      question_68000287: BAND_OPTIONS,
      question_68000288: SCALE_OPTIONS,
      'end-year--0': ['2024', '2025', '2026', '2027'],
      'end-year--1': ['2026', '2027', '2028', '2029'],
    },
  });
}

test('a capped education year list does not move her graduation year to the second row', () => {
  const actions = build(twoRowEducationPacket()).filter((action) => action.value === '2028');
  assert.equal(actions.length > 0, true, 'her graduation year must still be filled');
  for (const action of actions) {
    assert.notEqual(
      action.selector,
      EDU_ROW_1.selector,
      'a truncated option read on row 0 must never bind her graduation year to the second education row',
    );
  }
  assert.equal(
    actions.some((action) => action.type === 'fillByLabelText' && action.text === EDU_ANCHOR),
    true,
    'the education anchor stays on the label fill, where the runner resolves it to row 0 itself',
  );
});

test('scoping the resolution to GPA does not cost the GPA fix', () => {
  // The same packet that carries the education rows must still put her raw GPA in the write-in and
  // keep it away from both menus, so the scoping is a narrowing of blast radius and not of effect.
  const packet = twoRowEducationPacket();
  assert.deepEqual(
    reaching(packet, WRITE_IN).map((action) => ({ type: action.type, selector: action.selector })),
    [{ type: 'fill', selector: WRITE_IN.selector }],
    'her 3.89 still belongs in the write-in',
  );
  assert.deepEqual(reaching(packet, BAND), [], 'and must still never reach the band');
  assert.deepEqual(reaching(packet, SCALE), [], 'nor the scale menu');
});

/* THE OTHER ONE-WORD ANCHOR THE ORIGINAL AUDIT NAMED, GIVEN THE SAME TREATMENT HERE.
 *
 * PR #920's own audit named 'Discipline' as carrying the identical hazard, then left it uncovered:
 * its call site replicated the suppression gate inline (packetControlFailed('discipline--0') plus
 * managedSpeculativeLabelFillSuppressed, by hand) instead of routing through
 * managedFillByLabelUnlessHandled, so it never reached managedAnchorResolution at all. A Greenhouse
 * form can render the fixed education row's taxonomy control - discipline--0, whose full label some
 * employers customise to something like "Discipline/Major" - beside a SEPARATE custom question such
 * as "Field of study or discipline", a genuine write-in for what the taxonomy does not cover. Both
 * labels contain the bare word "Discipline", the anchor fallback emits that same one word, and the
 * runner's exact-then-loose-then-.first() resolution decided which control got the value with no
 * more evidence than DOM order - byte-identical on main and on #920, confirmed by execution.
 *
 * The fix is the same function GPA already uses, not a new one: 'Discipline' now passes
 * resolveAmbiguousAnchor true. It also passes one argument GPA never needed, selfControlId, and the
 * reason is specific to this control. discipline--0 already gets its own combobox-aware
 * fill+Enter+select sequence from pushGreenhouseEducationComboboxActions, unconditionally, a few
 * lines above the anchor fallback. A discipline--0 candidate whose OWN probe came back 'text' with no
 * options - the exact shape questionMetadata.ts documents for a react-select caught before its menu
 * opens - is, at the evidence managedAnchorCandidateRefusesValue can see, indistinguishable from a
 * genuinely open write-in. Paired against a second, separately-refused control, that shape would
 * otherwise make discipline--0 the sole holder and bind a bare `fill` there: no Enter, no option
 * click, on top of the sequence that already filled it, reopening a closed menu with nothing left in
 * the build to close it again. selfControlId turns that specific bind into a stand-aside instead:
 * discipline--0 keeps exactly the fill it already had, and only a genuinely different control can
 * ever be bound to from this anchor. The third test below is that shape, constructed rather than
 * merely asserted safe.
 *
 * THE TRUNCATED-READ-LIST HAZARD THAT SCOPED THE FLAG OUT OF END DATE YEAR DOES NOT TRAVEL HERE.
 * That hazard is specifically a POPULATED option list that is not the whole list - end-year--0 is
 * read by a path with no window cap, so a short real list there is indistinguishable from a
 * truncated one. discipline--0 is read exclusively through pushManagedReactSelectOptionProbeActions's
 * open/extract/close probe (line ~1410), documented above it (line ~1457) as measured stopping at
 * exactly MANAGED_OPTION_LISTBOX_RENDER_CAP rows on the live Anduril posting, ending on "European
 * Studies" - and parsedManagedOptionLines (line ~1486) discards a read landing on exactly that count
 * as 'windowed' before managedResultFieldOptions ever writes it to fieldOptions. So discipline--0 can
 * only ever reach this resolution as its true, complete list, or as no list at all; never as a
 * partial one a membership check could be fooled by. A discipline--0 read with no options - unprobed
 * or a discarded window, indistinguishable here and treated alike - still refuses on
 * measuredClosedListShape alone, the same unconditional-on-value refusal an unread GPA band gets,
 * and that path never depended on what the option list actually contained.
 */
const FIELD_OF_STUDY_LABEL = 'Field of study or discipline';
const DISCIPLINE_COMBO_LABEL = 'Discipline/Major';

const DISCIPLINE_COMBO = { selector: '#discipline--0', label: DISCIPLINE_COMBO_LABEL };
const FIELD_OF_STUDY = { selector: '#question_77770001', label: FIELD_OF_STUDY_LABEL };

const DISCIPLINE_COMBO_QUESTION = {
  question: DISCIPLINE_COMBO_LABEL,
  answer: '',
  portalSelector: DISCIPLINE_COMBO.selector,
  portalInputType: 'combobox',
};

const FIELD_OF_STUDY_QUESTION = {
  question: FIELD_OF_STUDY_LABEL,
  answer: '',
  portalSelector: FIELD_OF_STUDY.selector,
  portalInputType: 'text',
};

function disciplinePacket(overrides: Record<string, unknown> = {}): SubmissionPacket {
  return hrtPacket({
    major: 'Computer Science & Business Administration, Finance Emphasis',
    ...overrides,
  });
}

// Isolated to this call site's own label, 'education_discipline_label', because the id-scoped
// combobox builder a few lines above ALSO emits "Computer Science" - at #discipline--0, under
// 'education_discipline_combo:0' - and a value-only filter (as the GPA helpers above use) would
// conflate the two. This is the one action set the ambiguous-anchor fix controls.
const disciplineFallback = (packet: SubmissionPacket) =>
  build(packet).filter((action) => action.label === 'education_discipline_label');
const reachingDiscipline = (packet: SubmissionPacket, control: { selector: string; label: string }) =>
  disciplineFallback(packet).filter((action) => actionCouldReach(action, control));

test('the discipline value is left in the write-in beside the fixed taxonomy control, never the control itself', () => {
  // discipline--0 unprobed: no fieldOptions entry, closed shape from portalInputType 'combobox'.
  // Refused on measuredClosedListShape alone, the same path an unread GPA band takes.
  const packet = disciplinePacket({
    questions: [BAND_QUESTION, SCALE_QUESTION, WRITE_IN_QUESTION, DISCIPLINE_COMBO_QUESTION, FIELD_OF_STUDY_QUESTION],
  });
  assert.deepEqual(
    reachingDiscipline(packet, FIELD_OF_STUDY).map((action) => ({ type: action.type, selector: action.selector })),
    [{ type: 'fill', selector: FIELD_OF_STUDY.selector }],
    'the value belongs in the write-in, addressed by the id discovery read off that control',
  );
  assert.deepEqual(
    reachingDiscipline(packet, DISCIPLINE_COMBO),
    [],
    'and must never additionally land on the taxonomy control through this ambiguous fallback',
  );
  // discipline--0 still gets its own, correct, unconditional fill regardless: the combobox builder
  // a few lines above the anchor fallback owns it and never consulted this resolution at all.
  const ownFill = build(packet).filter((action) => action.label === 'education_discipline_combo:0' && action.type === 'fill');
  assert.deepEqual(
    ownFill.map((action) => ({ selector: action.selector, value: action.value })),
    [{ selector: DISCIPLINE_COMBO.selector, value: 'Computer Science' }],
    'the taxonomy control keeps its own combobox-aware fill throughout',
  );
  // And carrying a discipline candidate on the same packet must not cost the GPA fix either.
  assert.deepEqual(
    reaching(packet, WRITE_IN).map((action) => ({ type: action.type, selector: action.selector })),
    [{ type: 'fill', selector: WRITE_IN.selector }],
    'the GPA fix is unaffected by this packet also carrying a discipline candidate',
  );
});

test('the probe-failure case: a candidate read as portalInputType text with no options must not become the holder', () => {
  /* discipline--0's OWN probe came back exactly the shape questionMetadata.ts documents for a
   * react-select caught before its menu opens: portalInputType 'text', no options. Paired only
   * against the genuine write-in - itself 'text' with no options, and never excludable - neither
   * candidate is provably wrong, so this stands aside entirely rather than guess between two
   * controls it cannot tell apart. */
  const packet = disciplinePacket({
    questions: [
      BAND_QUESTION, SCALE_QUESTION, WRITE_IN_QUESTION,
      { ...DISCIPLINE_COMBO_QUESTION, portalInputType: 'text' },
      FIELD_OF_STUDY_QUESTION,
    ],
  });
  /* Not asserted as reachingDiscipline(...) === [] against either control: a plain fillByLabelText
   * with text 'Discipline' genuinely COULD reach either label by the runner's own loose match (both
   * contain the word), and that is the pre-existing ambiguity this fix leaves standing here, not a
   * new one. What must hold is that discipline--0 receives no BOUND (id-scoped) duplicate. */
  assert.deepEqual(
    disciplineFallback(packet).filter((action) => action.type === 'fill'),
    [],
    'a misprobed taxonomy control must not become the holder of a bound fill',
  );
  assert.deepEqual(
    disciplineFallback(packet).map((action) => ({ type: action.type, text: action.text, value: action.value })),
    [{ type: 'fillByLabelText', text: 'Discipline', value: 'Computer Science' }],
    'the original ambiguous label fill goes out exactly as it did before this fix existed',
  );
});

test('a misprobed taxonomy control is not bound to even when a genuinely different control is refused beside it', () => {
  /* THE SHAPE THAT PROVES selfControlId IS DOING WORK, NOT JUST DOCUMENTING SAFETY THAT ALREADY
   * EXISTED. Pair discipline--0's misprobed 'text'-with-no-options shape against a control that IS
   * separately, provably refused - a real closed list that does not carry "Computer Science" - and
   * holders narrows to exactly one candidate: discipline--0 itself. Without selfControlId,
   * managedAnchorResolution cannot tell that shape apart from a genuine write-in and binds a bare
   * `fill` straight at #discipline--0 - no Enter, no option click - on top of the sequence that
   * already filled it two actions earlier, reopening a closed react-select with nothing left in the
   * build to close it again. Measured directly: reverting the selfControlId argument at the call
   * site turns the first assertion below from [] into a second `fill` at #discipline--0. */
  const otherLabel = 'Which department is this discipline within?';
  const other = { selector: '#question_77770002', label: otherLabel };
  const packet = disciplinePacket({
    fieldOptions: {
      question_68000287: BAND_OPTIONS,
      question_68000288: SCALE_OPTIONS,
      question_77770002: ['Marketing', 'Sales', 'Operations'],
    },
    questions: [
      BAND_QUESTION, SCALE_QUESTION, WRITE_IN_QUESTION,
      { ...DISCIPLINE_COMBO_QUESTION, portalInputType: 'text' },
      { question: otherLabel, answer: '', portalSelector: other.selector, portalInputType: 'combobox' },
    ],
  });
  // The dangerous shape: every OTHER anchor-matching candidate is refused, so without selfControlId
  // discipline--0 would be the sole holder and receive a bound `fill` straight from this fallback.
  assert.deepEqual(
    disciplineFallback(packet).filter((action) => action.type === 'fill'),
    [],
    'discipline--0 must not receive a second, bare-fill bind on top of its own combobox sequence',
  );
  assert.deepEqual(
    build(packet).filter((action) => action.selector === DISCIPLINE_COMBO.selector && action.type === 'fill'),
    build(packet).filter((action) => action.label === 'education_discipline_combo:0' && action.type === 'fill'),
    'every fill this build sends to #discipline--0 comes from its own combobox builder, none from the anchor fallback',
  );
  // It stands aside to the pre-existing ambiguous fill rather than going silent, exactly like the
  // probe-failure case above: no worse than before this fix, not newly silent either.
  assert.deepEqual(
    disciplineFallback(packet).map((action) => ({ type: action.type, text: action.text, value: action.value })),
    [{ type: 'fillByLabelText', text: 'Discipline', value: 'Computer Science' }],
    'the original ambiguous label fill still goes out',
  );
});

test('a single discipline candidate keeps the behaviour it already had', () => {
  // The regression guard for every ordinary Greenhouse form: no competing custom question, nothing
  // ambiguous, the plain label fill goes out exactly as it did before this fix existed.
  const packet = disciplinePacket({ questions: [BAND_QUESTION, SCALE_QUESTION, WRITE_IN_QUESTION] });
  assert.deepEqual(
    disciplineFallback(packet).map((action) => ({ type: action.type, text: action.text, value: action.value })),
    [{ type: 'fillByLabelText', text: 'Discipline', value: 'Computer Science' }],
    "a single named control is the runner's to resolve, as it always was",
  );
});

test('a discipline control the form spells exactly is left on the path that already resolves it', () => {
  // Most Greenhouse boards render the fixed control's bare label, "Discipline", not "Discipline/
  // Major". The runner's exact match already reaches that deterministically before the loose pass
  // ever runs, so this fix stands aside exactly as the equivalent GPA test does above.
  const packet = disciplinePacket({
    questions: [
      BAND_QUESTION, SCALE_QUESTION, WRITE_IN_QUESTION,
      { ...DISCIPLINE_COMBO_QUESTION, question: 'Discipline' },
      FIELD_OF_STUDY_QUESTION,
    ],
  });
  assert.deepEqual(
    disciplineFallback(packet).map((action) => ({ type: action.type, text: action.text, value: action.value })),
    [{ type: 'fillByLabelText', text: 'Discipline', value: 'Computer Science' }],
    'an unambiguous exact anchor keeps the label fill it has always had',
  );
});
