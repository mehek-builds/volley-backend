import test from 'node:test';
import assert from 'node:assert/strict';
import {
  knownAnswerLookup,
  refreshKnownQuestionAnswers,
  snapStoredAnswersToOfferedOptions,
  REVIEWED_PICK_EXACT_OPTION_TYPE,
  type ApplicationProfileLike,
} from './questionDiscovery';
import { resolveSubmittedApplicationAnswers } from './submittedAnswers';
import { resolvePacketAuditQuestionFixpoint } from '../routes/submissionRunner';
import { reopenUnfitClosedChoiceQuestions, storedAnswerMatchesNoExactOption } from './questionMetadata';
import { blankRequiredQuestionLabels } from './submissionSafety';
import { isDeclineToState } from './selfIdentification';
import type { ApplicationReviewQuestion, ApplicationReviewState } from './applicationReview';

/* ── The Hudson River Trading gender control, read from the packet ─────────────────────────────
 *
 * Packet 4a79eec1, greenhouse. Read from production 2026-09-03:
 *
 *   question           what is your gender?
 *   portal_input_type  combobox
 *   options            ["Woman","Man","Non-binary","I don't wish to answer"]
 *
 * Her stored eeo_prefs.gender is "Female", which is on none of them, so the fill can select nothing
 * and the row cannot be sent. PR #888 shipped the Female/Woman equivalence into the FILL path and
 * no save has ever reached it.
 *
 * EVERY SAFETY CLAIM IS TESTED THROUGH A REAL ENTRY POINT AND ACROSS EVERY CONTROL TYPE THE RULE
 * CAN REACH. Two rounds of this PR were defeated by testing a narrower composition than production
 * runs: first by calling the leaf instead of the save path, then by exercising only `radio` while
 * the live control is a `combobox`, where the re-open never fires and an extra fixpoint pass lands.
 * CONTROL_TYPES below is derived from the constant itself so a widening of that set cannot silently
 * escape this matrix. */
const HRT_GENDER_OPTIONS = ['Woman', 'Man', 'Non-binary', "I don't wish to answer"];
const ROUND = '2026-09-03T09:14:00.000Z';
const AS_OF = new Date('2026-09-03T09:14:00.000Z');
const CONTROL_TYPES = ['select', 'select-one', 'radio', 'listbox', 'combobox'] as const;
/** The set the re-open also governs. On the rest, an unfit answer is never blanked. */
const REOPENED_TYPES = new Set(['select', 'select-one', 'radio', 'listbox']);

const HER_PROFILE = {
  eeo_prefs: {
    gender: 'Female', race: 'South Asian', veteran_status: 'No', hispanic: 'No',
  },
} as unknown as ApplicationProfileLike;

const question = (overrides: Partial<ApplicationReviewQuestion> = {}): ApplicationReviewQuestion => ({
  id: 'gender',
  question: 'What is your gender?',
  answer: 'Female',
  kind: 'required',
  required: true,
  portal_input_type: 'combobox',
  options: [...HRT_GENDER_OPTIONS],
  ...overrides,
});

/** The packet-audit path, which is what GET /applications/:id/submission shapes the screen with. */
const auditPath = (
  questions: readonly ApplicationReviewQuestion[],
  review: Partial<ApplicationReviewState> = {},
  profile: ApplicationProfileLike = HER_PROFILE,
) => resolvePacketAuditQuestionFixpoint(
  /* The round is ROUND, not null: `answer_reviewed_at` is only meaningful beside the
   * `questions_reviewed_at` it equals, so a null round silently disarms every applicant claim in
   * the fixture and tests a packet that has never been reviewed. */
  { questions: [...questions], questions_reviewed_at: ROUND, ...review } as unknown as ApplicationReviewState,
  profile,
  '',
  undefined,
  undefined,
  AS_OF,
);

/**
 * The real save path.
 *
 * `submitted` DEFAULTS TO WHAT THE GET SERVED, not to the raw stored rows, because that is what an
 * untouched Save posts: the client sends back the list it was shown, and the screen is shaped by
 * auditPath. Defaulting to the stored rows models a STALE TAB instead, where the merge correctly
 * reads the post-back as an edit, and it quietly tests a different request than the one under
 * discussion. An empty submitted list is a third thing again: the merge strips answer_source from a
 * row with no counterpart.
 */
const savePath = (
  questions: readonly ApplicationReviewQuestion[],
  profile: ApplicationProfileLike = HER_PROFILE,
  submitted?: readonly ApplicationReviewQuestion[],
) => resolveSubmittedApplicationAnswers({
  current: { questions: [...questions], questions_reviewed_at: ROUND, jd_text: undefined } as never,
  submitted: (submitted ?? auditPath(questions, {}, profile)).map((one) => ({ ...one })),
  profile,
  now: () => ROUND,
  asOf: AS_OF,
}).questions;

test('the control-type matrix covers every type the rule can reach', () => {
  for (const t of CONTROL_TYPES) {
    assert.equal(REVIEWED_PICK_EXACT_OPTION_TYPE.test(t), true, `${t} must be in the gate`);
  }
  for (const t of ['checkbox', 'select-multiple', 'text', 'textarea', 'file', 'date', 'number']) {
    assert.equal(REVIEWED_PICK_EXACT_OPTION_TYPE.test(t), false, `${t} must not be in the gate`);
  }
});

test('the HRT gender answer reaches the employer in its own spelling, on every reachable control', () => {
  for (const portal_input_type of CONTROL_TYPES) {
    const [saved] = savePath([question({ portal_input_type })]);
    assert.equal(saved.answer, 'Woman', `${portal_input_type} must re-spell "Female"`);
    assert.deepEqual(saved.options, HRT_GENDER_OPTIONS, 'the employer\'s list is untouched');
    assert.deepEqual(blankRequiredQuestionLabels([saved]), [], `${portal_input_type} clears the gate`);
    assert.equal('answer_draft' in saved, false, 'nothing was re-opened, so no draft is minted');
  }
});

test('the equivalence runs both ways, for the boards that spell it Female and Male', () => {
  assert.equal(
    savePath(
      [question({ answer: 'Woman', options: ['Female', 'Male', 'Decline To Self Identify'] })],
      { eeo_prefs: { gender: 'Woman' } } as unknown as ApplicationProfileLike,
    )[0].answer,
    'Female',
  );
  assert.equal(
    savePath(
      [question({ answer: 'Male' })],
      { eeo_prefs: { gender: 'Male' } } as unknown as ApplicationProfileLike,
    )[0].answer,
    'Man',
  );
});

/* ── The answer the refresh wrote over hers is NEVER the thing re-spelled ──────────────────────
 *
 * refreshKnownQuestionAnswers overwrites a stored answer with the profile's value, so a rule that
 * re-spells the refresh's OUTPUT re-spells the machine's answer rather than hers. Two rounds of
 * this PR shipped that defect in two different shapes:
 *
 *   round 1  the snap ran on the refresh's output, so every control type flipped.
 *   round 2  the snap took an "answer of record" argument computed inside the fixpoint transform,
 *            and packetQuestionFixpoint feeds its transform its own output, so from pass 2 the
 *            argument WAS the machine's value. Traced on combobox, stored "Trans woman":
 *              pass 1  "Trans woman" -> "Female"   refused correctly
 *              pass 2  "Female"      -> "Woman"    landed
 *            Invisible on radio, where the re-open blanks at pass 1 and pass 2 never arrives.
 *
 * The rule now runs once, on the stored record, outside the loop. These assert that every rejected
 * row settles to the value 3a0a3d0 settles it to, on EVERY control type, and the multi-pass test
 * below drives the transform by hand so a future in-loop regression cannot hide behind the re-open. */
const NEVER_HERS_TO_REWRITE: ReadonlyArray<{ label: string; answer: string }> = [
  { label: 'What is your gender?', answer: 'Trans woman' },
  { label: 'What is your gender?', answer: 'Prefer not to say' },
  { label: 'What is your gender?', answer: 'Genderqueer' },
  { label: 'What is your sex?', answer: 'Intersex' },
];

for (const { label, answer } of NEVER_HERS_TO_REWRITE) {
  test(`a stored "${answer}" is never re-spelled as the profile's gender, on any control type`, () => {
    for (const portal_input_type of CONTROL_TYPES) {
      const [saved] = savePath([question({ id: 'x', question: label, answer, portal_input_type })]);
      assert.notEqual(saved.answer, 'Woman', `${portal_input_type} wrote an identity she never gave`);
      /* Byte-identical to base: blanked where the re-open governs, held unfillable where it does
       * not. Both are the system asking her rather than answering for her. */
      assert.equal(
        saved.answer,
        REOPENED_TYPES.has(portal_input_type) ? '' : 'Female',
        `${portal_input_type} must settle where 3a0a3d0 settles it`,
      );
    }
  });
}

test('driving the refresh/re-open transform by hand never lands a re-spelling on a later pass', () => {
  for (const portal_input_type of CONTROL_TYPES) {
    let current = snapStoredAnswersToOfferedOptions(
      [question({ answer: 'Trans woman', portal_input_type })],
    );
    for (let pass = 1; pass <= 4; pass += 1) {
      current = reopenUnfitClosedChoiceQuestions(refreshKnownQuestionAnswers(
        current, HER_PROFILE, undefined, ROUND, undefined, undefined, AS_OF,
      ));
      assert.notEqual(
        current[0].answer, 'Woman',
        `${portal_input_type} re-spelled the machine's value on pass ${pass}`,
      );
    }
  }
});

test('the paths that skip the re-open do not re-spell a sent packet, and still repair a live one', () => {
  /* resolvePacketAuditQuestionFixpoint and refreshedHistorySpec drop the re-open when the packet
   * may be with the employer, and there every closed-choice type would flip if the rule ran inside
   * the loop. A sent record is the record of what was sent. */
  const sent = { submission_claimed_at: ROUND };
  for (const portal_input_type of CONTROL_TYPES) {
    assert.equal(
      auditPath([question({ portal_input_type })], sent)[0].answer,
      'Female',
      `${portal_input_type}: a packet that may be with the employer keeps its stored answer`,
    );
    /* The refresh still overwrites an off-list stored self-identification here, exactly as it does
     * on 3a0a3d0: only the RE-OPEN is skipped for a sent packet, not the resolver. What must never
     * happen is that value becoming a fit answer, which is what makes an unsendable row sendable. */
    assert.equal(
      auditPath([question({ answer: 'Trans woman', portal_input_type })], sent)[0].answer,
      'Female',
      `${portal_input_type}: byte-identical to 3a0a3d0`,
    );
    assert.equal(
      auditPath([question({ portal_input_type })])[0].answer,
      'Woman',
      `${portal_input_type}: a live packet is still repaired`,
    );
  }
});

/* ── Never a decline, through the save path ───────────────────────────────────────────────────── */
const NEVER_A_DECLINE: ReadonlyArray<{ label: string; answer: string; options: string[] }> = [
  {
    label: 'What is your race/ethnicity?',
    answer: 'South Asian',
    options: ['Asian', 'Black or African American', 'White', 'Decline to self-identify'],
  },
  {
    label: 'What is your race/ethnicity?',
    answer: 'Middle Eastern',
    options: ['Asian', 'White', 'Two or More Races', 'I do not wish to answer'],
  },
  { label: 'What is your gender?', answer: 'Trans woman', options: [...HRT_GENDER_OPTIONS] },
  {
    label: 'What is your age?',
    answer: '20',
    options: ['18-24', '25-34', '35-44', 'Prefer not to say'],
  },
];

for (const { label, answer, options } of NEVER_A_DECLINE) {
  test(`"${answer}" never lands on the control's own decline, on any control type`, () => {
    const declines = options.filter((option) => isDeclineToState(option));
    assert.equal(declines.length, 1, 'the list really does offer a decline to land on');
    /* THE RULE ITSELF IS ASSERTED HERE, NOT ONLY ITS COMPOSITION, and that is not belt and braces.
     * Measured: give the candidate ladder the decline wordings (PR #892's shape) and the composed
     * save path still comes out clean, because the refresh does not recognise a decline as stating
     * what the profile says and simply overwrites it on the next pass. So the end-to-end assertion
     * below passes for the wrong reason against exactly the defect it is named for. The rule has to
     * be pinned where it can be violated: on the stored record it actually rewrites. */
    for (const portal_input_type of CONTROL_TYPES) {
      const [snapped] = snapStoredAnswersToOfferedOptions([question({
        id: 'x', question: label, answer, options: [...options], portal_input_type,
      })]);
      assert.equal(
        isDeclineToState(snapped.answer), isDeclineToState(answer),
        `${portal_input_type}: the rule proposed ${JSON.stringify(snapped.answer)} for a stated answer`,
      );
      assert.equal(
        declines.includes(snapped.answer.trim()), false,
        `${portal_input_type}: the rule proposed the employer's own opt-out`,
      );
    }
    for (const portal_input_type of CONTROL_TYPES) {
      const [saved] = savePath([question({
        id: 'x', question: label, answer, options: [...options], portal_input_type,
      })]);
      assert.equal(
        declines.includes(saved.answer.trim()), false,
        `${portal_input_type} answered ${JSON.stringify(saved.answer)}, which is the opt-out`,
      );
      assert.equal(
        options.includes(saved.answer.trim()) && saved.answer.trim() !== answer, false,
        `${portal_input_type} silently landed on another of the employer's options`,
      );
    }
  });
}

test('a widening is not a re-spelling: a coarser federal race category is never written', () => {
  for (const portal_input_type of CONTROL_TYPES) {
    const [saved] = savePath([question({
      id: 'race',
      question: 'What is your race/ethnicity?',
      answer: 'South Asian',
      options: ['Asian', 'White', 'Black or African American'],
      portal_input_type,
    })]);
    assert.notEqual(saved.answer, 'Asian', `${portal_input_type} widened her own answer`);
  }
});

test('"C#" against ["C", "C#", "Java", "Python"] is never rewritten to "C"', () => {
  /* THE GATE AND THE MATCHER ARE ONE RELATION. comparableOption folds "C#" onto "c", which is also
   * "C"'s key, so the strict gate calls the answer off-list. A matcher on a looser relation than
   * its gate then finds "C" and rewrites a language she named to a different one. PR #892's
   * second critical. */
  const stored = question({
    id: 'lang', question: 'Primary programming language', answer: 'C#',
    options: ['C', 'C#', 'Java', 'Python'], portal_input_type: 'select-one',
  });
  assert.equal(storedAnswerMatchesNoExactOption(stored), true, 'the strict gate calls it off-list');
  assert.deepEqual(snapStoredAnswersToOfferedOptions([stored]), [stored]);
  for (const portal_input_type of CONTROL_TYPES) {
    assert.notEqual(savePath([question({ ...stored, portal_input_type })])[0].answer, 'C');
  }
});

test('a skip cannot ride onto a machine-rewritten answer', () => {
  /* submissionRunner's skipOutlivedItsAnswer rule: a skip means "the value is right, the portal's
   * menu will not take it", it is bound to a NON-EMPTY answer (applicationReview.ts), and carried
   * onto a value the machine rewrote it silences the send gate for something she never saw. */
  const [snapped] = snapStoredAnswersToOfferedOptions(
    [question({ answer_state: 'skipped' } as Partial<ApplicationReviewQuestion>)],
  ) as unknown as Record<string, unknown>[];
  assert.equal(snapped.answer, 'Woman', 'the answer really did change');
  assert.equal('answer_state' in snapped, false, 'so the skip taken against "Female" is gone');
});

test('a snapped answer sheds every claim made about the string it replaced', () => {
  const [snapped] = snapStoredAnswersToOfferedOptions([question({
    answer_source: 'applicant_review',
    answer_reviewed_at: ROUND,
    answer_override_of: 'Woman',
    consent_permission_version: 'v3',
    consent_permission_granted_at: ROUND,
  } as Partial<ApplicationReviewQuestion>)]) as unknown as Record<string, unknown>[];

  assert.equal(snapped.answer, 'Woman');
  for (const field of [
    'answer_source', 'answer_reviewed_at', 'answer_override_of',
    'consent_permission_version', 'consent_permission_granted_at',
  ]) {
    assert.equal(field in snapped, false, `${field} belongs to the answer it was made about`);
  }
  assert.equal(snapped.answer_option_source, 'Female', 'the value it was snapped from is recorded');
});

test('her deliberate pick records an override of the RESOLVER\'s value, not the control\'s spelling', () => {
  /* THE DEFECT ROUND 2 INTRODUCED. knownAnswerLookup feeds `answer_override_of`, and an override's
   * currency is judged later by recomputing resolveKnownAnswer, which answers "Female". Returning
   * the snapped "Woman" there recorded her "Non-binary" as an override of a value the resolver
   * never produces, so the next save judged her own choice stale and replaced it with the
   * machine's. Measured on combobox, both saves. */
  const [first] = savePath([question()], HER_PROFILE, [question({ answer: 'Non-binary' })]);
  assert.equal(first.answer, 'Non-binary');
  assert.equal(first.answer_source, 'applicant_review');
  assert.equal(first.answer_override_of, 'Female', 'the resolver value, never "Woman"');

  const shrunk = { ...first, options: ['Woman', 'Man', "I don't wish to answer"] };
  const [second] = savePath([shrunk]);
  assert.equal(second.answer, 'Non-binary', 'her pick survives a list that drops it');
  assert.equal(second.answer_source, 'applicant_review', 'and so does her provenance');
});

test('an untouched Save of the re-spelled value mints no applicant claim', () => {
  const [saved] = savePath([question()]);
  assert.equal(saved.answer, 'Woman');
  assert.equal(saved.answer_source, undefined, 'a round trip of what the screen showed is not a choice');
});

test('the repair survives a second save instead of lasting exactly one round trip', () => {
  const first = savePath([question()]);
  assert.equal(first[0].answer, 'Woman');
  const second = savePath(first);
  assert.equal(second[0].answer, 'Woman', 'a second Save does not undo the first');
  assert.deepEqual(savePath(second), second, 'and the record has settled');
});

test('an answer she reviewed and picked from the control\'s own list is still kept verbatim', () => {
  for (const portal_input_type of CONTROL_TYPES) {
    const [saved] = savePath([question({
      answer: 'Man', portal_input_type,
      answer_source: 'applicant_review',
      answer_reviewed_at: ROUND,
    } as Partial<ApplicationReviewQuestion>)]);
    assert.equal(saved.answer, 'Man', `${portal_input_type}: #896's protection survives`);
    assert.equal(saved.answer_source, 'applicant_review');
  }
});

test('the lookup answers the resolver\'s own value, unchanged by this rule', () => {
  for (const stored of [question(), question({ answer: 'Trans woman' })]) {
    assert.equal(
      knownAnswerLookup(HER_PROFILE, undefined, undefined, undefined, AS_OF)(stored),
      'Female',
      'a control\'s vocabulary must not reach a field about the profile',
    );
  }
});

/* ── The matcher's own arithmetic ─────────────────────────────────────────────────────────────── */

test('a stored answer the control already offers is not re-spelled at all', () => {
  const bothSpellings = [question({ options: ['Female', 'Woman', 'Non-binary'] })];
  assert.deepEqual(snapStoredAnswersToOfferedOptions(bothSpellings), bothSpellings);
  assert.equal(
    snapStoredAnswersToOfferedOptions([question({ options: ['Woman', 'Man'] })])[0].answer,
    'Woman',
    'and drop "Female" from that list and the same record does snap',
  );
});

test('two options spelling the same re-spelling refuse rather than picking by DOM order', () => {
  const ambiguous = [question({ options: ['Woman', 'woman', 'Man'] })];
  assert.deepEqual(snapStoredAnswersToOfferedOptions(ambiguous), ambiguous);
  assert.equal(
    snapStoredAnswersToOfferedOptions([question({ options: ['Woman', 'Woman', 'Man'] })])[0].answer,
    'Woman',
    'two rows spelling it identically are one option, and that one is adopted',
  );
});

test('an open control is never snapped, whatever it happens to carry beside it', () => {
  for (const portal_input_type of ['textarea', 'text', 'checkbox', 'select-multiple', 'file', 'date']) {
    const stored = [question({ portal_input_type })];
    assert.deepEqual(snapStoredAnswersToOfferedOptions(stored), stored);
  }
});

test('a control with no readable options cannot produce a rewrite', () => {
  for (const options of [null, undefined, [], ['   ']]) {
    const stored = [question({ options: options as string[] | null })];
    assert.deepEqual(snapStoredAnswersToOfferedOptions(stored), stored);
  }
  assert.equal(
    snapStoredAnswersToOfferedOptions([question({ options: ['   ', 'Woman', 'Man'] })])[0].answer,
    'Woman',
  );
});
