import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachManagedFieldOptions,
  buildManagedDiscoveredOptionProbeActions,
  managedOptionProbeTargets,
  managedResultFieldOptions,
  openControlListboxSelector,
  reactSelectListboxSelector,
  ripplingListboxSelector,
  MANAGED_OPTION_EXTRACT_PREFIX,
  MANAGED_OPTION_PROBE_MENU_WAIT_MS,
  type PortalFamily,
} from './portalSubmission';
import { DISCOVER_QUESTIONS_SCRIPT, refreshKnownQuestionAnswers } from './questionDiscovery';
import { SINGLE_CHOICE_EXACT_OPTION_TYPE } from './questionDiscovery';
import { discoveredQuestionNeedsExactOptionsBeforeResolution, optionsSurvivingAnUnreadMenu } from './questionMetadata';
import { discoverAndResolveQuestions } from '../routes/submissionRunner';
import { postingQuestionInventoryFromDiscovered } from './postingQuestions';

/* A REQUIRED CHOICE QUESTION WITH NO CAPTURED OPTIONS IS UNANSWERABLE BY CONSTRUCTION.
 *
 * Measured live on mehekmandal05@gmail.com, 2026-09-03: of 179 unanswered REQUIRED choice questions
 * across the packet queue, 160 carry a completely EMPTY option list, and 19 packets are blocked on
 * nothing else. The product must send one of the employer control's own exact option strings; with
 * none captured there is nothing it can send, so the question renders as needing an answer and no
 * answer can ever satisfy it. Same unsatisfiable-gate shape as the send blockers elsewhere.
 *
 * Four causes were proven and are pinned here, one test each. Two live in the probe planner in this
 * repo, one in the DOM walk in this repo, and the fourth is the same DOM-walk defect in the runner
 * (stratus-patches/0001-bound-listbox-wherever-mounted.patch, verified by the script beside it).
 *
 * The last test in this file is the safety invariant, and it is the reason the other four are
 * allowed to widen anything: a genuinely empty option list must still be judged against NOTHING.
 * reviewedComboboxOptionKept.test.ts owns that rule; this file re-states the half that a capture
 * change could plausibly break.
 */

/** A react-select as discovery actually reports one: inputType 'text', closedness only in the role. */
const reactSelect = (id: string, label: string, over: Record<string, unknown> = {}) => ({
  label: `${label}* ${id}`,
  selector: `#${id}`,
  durableSelector: `#${id}`,
  inputType: 'text',
  role: 'combobox',
  required: true,
  options: null,
  ...over,
});

/* The whole PortalFamily union, written out rather than derived, so this test fails when a family is
 * added and nobody asks whether its closed controls can be read. */
const EVERY_FAMILY: readonly PortalFamily[] = [
  'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'jazzhr', 'paylocity', 'rippling',
  'breezy', 'bamboohr', 'jobvite', 'icims', 'oraclecloud', 'ultipro', 'recruitee', 'teamtailor',
  'personio', 'pinpoint', 'comeet', 'crelate', 'zoho_recruit', 'bullhorn', 'sap_successfactors',
  'oracle_taleo', 'adp_recruiting', 'avature',
];

test('every ATS family plans an option probe for a closed control it cannot otherwise read', () => {
  /* CAUSE 1. managedOptionProbeTargets opened with a three-name allow list - greenhouse, rippling,
   * paylocity - against this union of twenty-six, so on the other twenty-three no closed control's
   * menu was EVER opened. A custom combobox does not render its menu until it is opened, so those
   * families' options could only come from the DOM walk, which correctly reports nothing for a
   * closed widget. That is the largest single reason a question reaches the applicant with an empty
   * option list.
   *
   * The allow list was defensible only because those three are the families whose popup id shape
   * somebody had measured. It is not a reason any more: openControlListboxSelector names the popup
   * by the control's own aria-expanded rather than by a convention. */
  const discovered = [reactSelect('question_37228964002', 'Overall GPA')];
  for (const family of EVERY_FAMILY) {
    assert.deepEqual(
      managedOptionProbeTargets(family, discovered, {}, true),
      ['question_37228964002'],
      `${family} must read a closed control's own option list`,
    );
  }
});

test('the probe waits for the menu it opened, on the exact node it is about to read', () => {
  /* CAUSE 2, AND IT IS A TIMING RACE RATHER THAN A MISSING TARGET. The extract used to run in the
   * action immediately after the open click, and click's only settle is
   * waitForLoadState('networkidle') - which returns at once for a menu painted from client state
   * with no network request. So the read landed before the popup existed and the control was
   * recorded as having returned no readable choices, which downstream is indistinguishable from a
   * control whose menu is genuinely empty.
   *
   * This file used to believe the runner had no wait primitive at all. The runner exempts
   * waitForSelector from its optional-action pre-check BY NAME and honours its own clamped timeout,
   * so the wait is available and is now spent. The two assertions that matter are that the wait
   * comes between the open and the read, and that it names the SAME node the read names - a wait on
   * anything else proves nothing about what the extract will see. */
  const actions = buildManagedDiscoveredOptionProbeActions(
    'workable',
    [reactSelect('question_88', 'How did you hear about us?')],
    {},
    true,
  );
  const seq = actions.map((action) => action.type);
  const open = seq.indexOf('click');
  assert.equal(seq[open + 1], 'waitForSelector', 'the wait must sit between the open and the read');
  assert.equal(seq[open + 2], 'extract');
  assert.equal(seq[open + 3], 'press');
  assert.equal(actions[open + 1]!.selector, actions[open + 2]!.selector);
  assert.equal(actions[open + 1]!.timeout, MANAGED_OPTION_PROBE_MENU_WAIT_MS);
  // Optional, so a control that never opens costs this window and can never fail the run: an
  // optional waitForSelector that times out lands in the runner's catch and is reported in skipped.
  assert.equal(actions.every((action) => action.optional === true), true);
  // Still read-only. Nothing here types, uploads, selects or submits.
  assert.deepEqual(
    [...new Set(seq)].sort(),
    ['click', 'extract', 'press', 'waitForSelector'],
  );
});

test('the family-agnostic selector proves the popup is this control\'s, and round-trips its id', () => {
  /* The proof is in two halves and both are load-bearing. body:has([id=X][aria-expanded="true"])
   * refuses to read anything unless THIS control declares an open popup, so a page-level menu, a
   * cookie banner's listbox or a neighbouring question's menu can never donate while the control is
   * closed. :visible keeps the read to the popup a person can see.
   *
   * And the id has to survive the round trip, because managedResultFieldOptions keys the read back
   * onto the control. The label carries it today; the selector is the fallback that has to keep
   * working, and it is the only key guaranteed to come back if the label is ever dropped again. */
  const selector = openControlListboxSelector('question_88');
  assert.match(selector, /^body:has\(\[id="question_88"\]\[aria-expanded="true"\]\) \[role="listbox"\]:visible$/);
  assert.deepEqual(
    managedResultFieldOptions({ extracted: [{ selector, value: 'Yes\nNo\nPrefer not to say' }] } as never),
    { question_88: ['Yes', 'No', 'Prefer not to say'] },
  );
  // The two measured conventions are untouched, and each still names one exact node.
  assert.equal(reactSelectListboxSelector('degree--0'), '[id="react-select-degree--0-listbox"]');
  assert.equal(ripplingListboxSelector('field-90'), '[id="field-90-list"]');
});

test('the read reaches the question the applicant is shown, on a family that never had one before', () => {
  /* End to end over the join, because a list that is read and then not attached is the same defect
   * wearing different clothes - that is exactly what happened to Lever's cards[<uuid>][field0] keys
   * (leverOptionInventory.test.ts). A Lever posting whose GPA control is a closed band list now
   * reaches postingQuestionInventoryFromDiscovered with the employer's own thirteen bands instead of
   * a bare box. */
  const bands = ['3.76 - 4.0', '3.51 - 3.75', '3.26 - 3.5', 'Below 3.26'];
  const discovered = [reactSelect('question_4102', 'What is your overall college/university GPA?')];
  const probed = attachManagedFieldOptions(discovered, { question_4102: bands });
  assert.deepEqual(probed[0]!.options, bands);

  const inventory = postingQuestionInventoryFromDiscovered(probed as never, 'lever');
  const question = inventory.questions.find((item) => /gpa/i.test(item.label));
  assert.ok(question, 'the GPA question must survive into the inventory');
  assert.deepEqual(question.options, bands);
  assert.equal(question.required, true);

  // And the same field with nothing read still carries no options rather than an invented list.
  const unread = attachManagedFieldOptions(discovered, {});
  assert.equal(unread[0]!.options, null);
});

test('the DOM walk binds a popup the widget portalled, and reads the row spellings that exist', () => {
  /* CAUSE 3, asserted on the shipped script source the way every other test of this script is: there
   * is no DOM in this suite, and a copy of the logic here would let the reader drift while the test
   * kept passing - the exact failure that made an earlier three-repo fix invisible in production.
   *
   * The reader required the popup to be the opener's SIBLING, so a menu portalled to <body> - React
   * Select with menuPortalTarget, downshift behind a popper, Radix, MUI, Headless UI - had its
   * reverse aria-labelledby binding read and then discarded. The fill path already resolved that
   * same binding with no sibling test, so the two layers disagreed about which listbox is a
   * control's own: the chooser could commit an option the reader could not report. */
  assert.doesNotMatch(
    DISCOVER_QUESTIONS_SCRIPT,
    /listbox\.parentElement !== el\.parentElement/,
    'a portalled menu is still the opener\'s own menu',
  );
  assert.match(DISCOVER_QUESTIONS_SCRIPT, /function boundOptionListbox\(el\)/);
  // Both directions the chooser resolves, so the two cannot drift apart again.
  assert.match(DISCOVER_QUESTIONS_SCRIPT, /getAttribute\('aria-controls'\) \|\| el\.getAttribute\('aria-owns'\)/);
  assert.match(DISCOVER_QUESTIONS_SCRIPT, /document\.querySelectorAll\('\[role="listbox"\]\[aria-labelledby\]'\)/);
  // A reference that lands on the popup CONTAINER still finds the list one node inside it.
  assert.match(DISCOVER_QUESTIONS_SCRIPT, /node\.querySelector\('\[role="listbox"\]'\)/);
  // The <ul role="listbox"><li> spelling, which returned zero rows off menus that were fully present.
  assert.match(DISCOVER_QUESTIONS_SCRIPT, /function optionRowsIn\(root\)/);
  assert.match(DISCOVER_QUESTIONS_SCRIPT, /root\.querySelectorAll\('li'\)/);
  // And the bound that keeps all of it honest: exactly one candidate, or nothing is inferred.
  assert.match(DISCOVER_QUESTIONS_SCRIPT, /return candidates\.length === 1 \? candidates\[0\] : null;/);
});

test('none of this starts judging a stored answer against an option list that is still empty', () => {
  /* THE SAFETY INVARIANT, RE-STATED FROM THE CAPTURE SIDE.
   *
   * reviewedComboboxOptionKept.test.ts owns the rule and states it in full: no options means no
   * membership test, so the answer is returned exactly as stored. It is repeated here because these
   * changes are the ones that could plausibly break it - widening what counts as a captured list is
   * one edit away from widening what counts as a list worth judging against - and because a capture
   * failure must degrade to "we did not read it", never to "the employer does not offer it".
   *
   * Asserted on a value the profile could not recompute, which is the case where a wrong judgement
   * would silently destroy the applicant's own answer. */
  const [kept] = refreshKnownQuestionAnswers(
    [{
      question: 'have you applied to this role at akuna previously?',
      answer: 'Yes',
      portal_input_type: 'combobox',
      options: [],
      answer_source: 'applicant_review',
      answer_reviewed_at: '2026-09-03T11:00:00.000Z',
    }] as never,
    { legal_first_name: 'Mehek' } as never,
    undefined,
    '2026-09-03T11:00:00.000Z',
    undefined,
    undefined,
    new Date('2026-09-03T12:00:00.000Z'),
  );
  assert.equal(kept!.answer, 'Yes');

  // And an unread control still reports an unread control: attachManagedFieldOptions does not
  // manufacture a list, and a probe target is still raised so the next pass tries again.
  const discovered = [reactSelect('question_4102', 'Overall GPA')];
  assert.equal(attachManagedFieldOptions(discovered, {})[0]!.options, null);
  assert.deepEqual(managedOptionProbeTargets('lever', discovered, {}, true), ['question_4102']);
});

/* ── THE FIFTH CAUSE: A LIST THAT WAS CAPTURED, AND THEN OVERWRITTEN WITH NOTHING ──────────────
 *
 * The four causes above are failures to CAPTURE. This one is a failure to KEEP. The two
 * existing-record writes in discoverAndResolveQuestions spread `...existing` and then set `options`
 * from the CURRENT run's read, so a run whose option probe returned nothing replaced a list an
 * earlier run had really measured. The comment at the second site calls it refreshing the
 * display-only choices; on an empty read it is a deletion, and an empty read is ordinary - the menu
 * is opened by a probe that can be skipped, batched away, or time out.
 *
 * MEASURED on origin/main at the deployed revision (107e1ae7), driving the real
 * discoverAndResolveQuestions twice over one Greenhouse gender combobox `[id="245"]`:
 *   run 1, menu read  : options ["Woman","Man","Non-binary","I don't wish to answer"], answer "Woman"
 *   run 2, menu unread: options null,                                                 answer "Female"
 */

test('the retention gate keeps a measured menu only where nothing can blank an answer against it', () => {
  const menu = ['Woman', 'Man', 'Non-binary', "I don't wish to answer"];
  const stored = { options: menu, portal_selector: '[id="245"]' };

  // A fresh read always wins; retention is only ever about an EMPTY one.
  assert.deepEqual(
    optionsSurvivingAnUnreadMenu({ freshOptions: ['A', 'B'], controlType: 'combobox', selector: '[id="245"]', existing: stored }),
    ['A', 'B'],
  );
  // The case the measurement found: same control, menu unread, list kept.
  assert.deepEqual(
    optionsSurvivingAnUnreadMenu({ freshOptions: null, controlType: 'combobox', selector: '[id="245"]', existing: stored }),
    menu,
  );

  /* THE SAFETY SCOPE. storedAnswerMatchesNoExactOption blanks a stored answer matching none of the
   * recorded options, gated on SINGLE_CHOICE_EXACT_OPTION_TYPE. Handing a retained list to one of
   * those types could let a menu read on an earlier render RE-OPEN a correct answer, which destroys
   * data to close a display gap. Retention therefore stops exactly where that gate starts, written
   * as the set difference rather than a `combobox` literal so the two stay coupled. */
  for (const controlType of ['select', 'select-one', 'radio', 'listbox']) {
    assert.ok(SINGLE_CHOICE_EXACT_OPTION_TYPE.test(controlType), `${controlType} is blankable`);
    assert.equal(
      optionsSurvivingAnUnreadMenu({ freshOptions: null, controlType, selector: '[id="245"]', existing: stored }),
      null,
      `${controlType} must not carry a stale list into the re-open gate`,
    );
  }

  // A list is evidence about ONE control, so a different binding keeps nothing.
  assert.equal(optionsSurvivingAnUnreadMenu({ freshOptions: null, controlType: 'combobox', selector: '[id="999"]', existing: stored }), null);
  assert.equal(optionsSurvivingAnUnreadMenu({ freshOptions: null, controlType: 'combobox', selector: null, existing: stored }), null);
  // Nothing stored, a placeholder-only list, and a control that is no longer a menu keep nothing.
  assert.equal(optionsSurvivingAnUnreadMenu({ freshOptions: null, controlType: 'combobox', selector: '[id="245"]', existing: undefined }), null);
  assert.equal(optionsSurvivingAnUnreadMenu({ freshOptions: null, controlType: 'combobox', selector: '[id="245"]', existing: { options: ['Select...'], portal_selector: '[id="245"]' } }), null);
  assert.equal(optionsSurvivingAnUnreadMenu({ freshOptions: null, controlType: 'text', selector: '[id="245"]', existing: stored }), null);
});

test('a blankable control never even reaches the retention site with an unread menu', () => {
  /* WHY THE SCOPE ABOVE IS BELT AND BRACES RATHER THAN THE ONLY GUARD, which is what makes the
   * wider case safe to reason about at all.
   *
   * A zero-option read on a type that needs exact options before resolution raises
   * `missing_exact_options` at the top of the loop, and that branch ends in `continue`: the record
   * is either preserved WHOLESALE under its own current-round same-selector proof, or invalidated.
   * Either way control never reaches the two writes this change touches. So the types
   * storedAnswerMatchesNoExactOption is allowed to blank cannot be handed a retained list by this
   * change even if the gate above were removed - the set that needs exact options is a SUPERSET of
   * the set that can be blanked. */
  const asField = (controlType: string) => ({
    label: 'what is your gender?', selector: '[id="245"]', durableSelector: '[id="245"]',
    inputType: controlType === 'combobox' ? 'text' : controlType,
    role: controlType === 'combobox' ? 'combobox' : null,
    options: null, required: true,
  }) as never;
  for (const controlType of ['select', 'select-one', 'radio', 'listbox']) {
    assert.ok(SINGLE_CHOICE_EXACT_OPTION_TYPE.test(controlType));
    assert.equal(discoveredQuestionNeedsExactOptionsBeforeResolution(asField(controlType)), true,
      `${controlType} is intercepted before the retention site`);
  }
  // Combobox is the exempt one, which is exactly why it falls through to the write this change fixes.
  assert.equal(SINGLE_CHOICE_EXACT_OPTION_TYPE.test('combobox'), false);
  assert.equal(discoveredQuestionNeedsExactOptionsBeforeResolution(asField('combobox')), false);
});

const GENDER_MENU = ['Woman', 'Man', 'Non-binary', "I don't wish to answer"];
const REVIEWED_ROUND = '2026-09-03T11:00:00.000Z';

async function twoRunsOverAGenderCombobox() {
  const field = (options: string[] | null) => ({
    label: 'what is your gender? 245', selector: '[data-litos-discovered-3]', durableSelector: '[id="245"]',
    inputType: 'text', role: 'combobox', maxLength: null, options,
    ...(options ? { optionsComplete: true } : {}), required: true,
  });
  const state = (questions: unknown[]) => ({
    jd_text: 'Build C++ services.', role: 'Software Engineering Internship',
    portal_url: 'https://job-boards.greenhouse.io/embed/job_app?for=wehrtyou&token=8052083',
    ats_name: 'greenhouse', status: 'ready_to_submit', edited_terms: [], questions,
    skipped_reasons: [], questions_reviewed_at: REVIEWED_ROUND, updated_at: REVIEWED_ROUND,
  }) as never;
  const profile = { school: 'USC', eeo_prefs: { gender: 'Female' } } as never;
  const row = { user_id: 'user-1' } as never;

  const first = await discoverAndResolveQuestions([field(GENDER_MENU)] as never, row, state([]), profile, true, 'greenhouse');
  // Stored the way the dashboard stores HER pick of an employer option, in the current review round.
  const hers = first.questions.map((question) => ({
    ...question, answer: 'Woman', answer_source: 'applicant_review', answer_reviewed_at: REVIEWED_ROUND,
  }));
  const second = await discoverAndResolveQuestions([field(null)] as never, row, state(hers), profile, true, 'greenhouse');
  return { first: first.questions[0]!, second: second.questions[0] };
}

test('a combobox menu measured by an earlier run survives a run whose probe read nothing', async () => {
  const { first, second } = await twoRunsOverAGenderCombobox();
  assert.deepEqual(first.options, GENDER_MENU, 'run 1 captured the menu');
  assert.ok(second, 'the question is still returned');
  // The regression: this was `null` on origin/main, so the dashboard rendered the employer's
  // combobox as a bare text box and neither Litos nor the applicant could pick from it.
  assert.deepEqual(second.options, GENDER_MENU, 'run 2 must not replace a measured menu with nothing');
});

test('the answer beside it still reverts, which is the LARGER half and is NOT fixed here', async () => {
  /* SEPARATE DEFECT, PINNED SO IT IS NOT MISTAKEN FOR THIS ONE and so the follow-up has a home.
   *
   * `reviewedAnswerStillFits` computes `reviewedOption` against `usableOptions(field.options)` - the
   * FRESH read - not against the list the record carries. On an unread menu that set is empty, so
   * her reviewed "Woman" is on no offered option as far as the gate can see, the gate returns false,
   * and the resolver's profile value replaces it. The stored answer becomes "Female", which the
   * control does not offer: the question then reads ANSWERED with nothing selected, which is the
   * loop reviewedComboboxOptionKept.test.ts was written for, reached through a different door.
   *
   * Retaining the list at the WRITE site cannot fix this, as this test proves: the gate never
   * consults the retained list. The fix is to give that gate the same effective-options notion this
   * change gives the write, and it is deliberately not made here - that gate decides whether her
   * answer or the profile wins, and widening it is its own measured change. */
  const { second } = await twoRunsOverAGenderCombobox();
  assert.equal(second!.answer, 'Female', 'still reverts today - update this test when the gate is fixed');
  assert.ok(!GENDER_MENU.includes(second!.answer), 'and the value it reverts to is unfillable');
});
