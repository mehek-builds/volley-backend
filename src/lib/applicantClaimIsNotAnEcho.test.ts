import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mergeSubmittedApplicationReviewQuestions,
  type ApplicationReviewQuestion,
  type ApplicationReviewState,
  type SubmittedApplicationReviewQuestion,
} from './applicationReview';
import { machineAnswerLookup, resolveSubmittedApplicationAnswers } from './submittedAnswers';
import {
  knownAnswerLookup,
  refreshKnownQuestionAnswers,
  type ApplicationProfileLike,
} from './questionDiscovery';
import { resolveProfileField } from './profileFieldResolution';
import {
  discoverAndResolveQuestions,
  mergeDiscoveredPortalQuestions,
  resolveApplicantClosedChoiceFallbacks,
} from '../routes/submissionRunner';
import { reopenUnfitClosedChoiceQuestions } from './questionMetadata';

/* ── The Hudson River Trading gender record, measured in production ────────────────────────────
 *
 * Packet 4a79eec1 (Hudson River Trading, greenhouse), account a18f774b, read from
 * GET /applications/:id/submission after a managed run at revision 07637333 completed
 * 2026-09-03T15:19:57Z:
 *
 *   question               "what is your gender?"  (required)
 *   answer                 "Woman"
 *   options                ["Woman","Man","Non-binary","I don't wish to answer"]
 *   answer_source          "applicant_review"
 *   answer_override_of     "Female"
 *   answer_reviewed_at     "2026-09-01T21:28:12.934Z"
 *   questions_reviewed_at  "2026-09-01T21:28:12.934Z"     <- IDENTICAL
 *
 * The packet asserted she reviewed that control on 2026-09-01 and overrode "Female" with "Woman".
 * She did not. Earlier the same day the row read "Female", matching no option, and the packet was
 * parked on it; the Female/Woman equivalence merged on 2026-09-03 as 7a3d1b2, so on 2026-09-01 no
 * code path in the repo could produce "Woman" for this label at all.
 *
 * The stamp is not cosmetic. refreshKnownQuestionAnswers returns a question untouched when
 * `applicantReviewedCurrentAnswer && reviewedAnswerIsAnOfferedOption(...)`, ahead of every recompute
 * rule, so a machine value that acquires this claim is immune to correction by any resolver Litos
 * ships afterwards. On this record the value was right. The mechanism stamps whatever the resolver
 * produced, and the same merge writes gender, disability and veteran answers - which is the
 * 802-answer laundering class recorded at applicationReview.ts's mint site, reached from a new
 * direction. */
const ROUND = '2026-09-01T21:28:12.934Z';
const HRT_GENDER_OPTIONS = ['Woman', 'Man', 'Non-binary', "I don't wish to answer"];
const GENDER_LABEL = 'What is your gender?';
const AS_OF = new Date('2026-09-03T15:19:57.000Z');

const HER_PROFILE = {
  eeo_prefs: {
    gender: 'Female', race: 'South Asian', veteran_status: 'No', hispanic: 'No',
  },
} as unknown as ApplicationProfileLike;

const question = (overrides: Partial<ApplicationReviewQuestion> = {}): ApplicationReviewQuestion => ({
  id: 'gender',
  question: GENDER_LABEL,
  answer: 'Female',
  kind: 'required',
  required: true,
  portal_input_type: 'select-one',
  portal_selector: '#gender',
  options: [...HRT_GENDER_OPTIONS],
  ...overrides,
});

const claims = (row: ApplicationReviewQuestion) => ({
  answer: row.answer,
  answer_source: row.answer_source,
  answer_reviewed_at: row.answer_reviewed_at,
  answer_override_of: row.answer_override_of,
});

const resolverAnswerFor = knownAnswerLookup(HER_PROFILE, undefined, undefined, undefined, AS_OF);
const machineAnswerFor = machineAnswerLookup(HER_PROFILE);

/** The narrow answers route's own composition: merge, with both lookups. */
const save = (
  stored: readonly ApplicationReviewQuestion[],
  submitted: readonly SubmittedApplicationReviewQuestion[],
) => mergeSubmittedApplicationReviewQuestions(
  stored, submitted, ROUND, resolverAnswerFor, machineAnswerFor,
);

test('the two resolutions really do disagree on this control, which is the whole mechanism', () => {
  /* Without this, every assertion below could pass for the wrong reason. resolveKnownAnswer says
   * what the answer IS from the profile; resolveProfileField says how that same answer is WRITTEN
   * into this control. The fill, the runner and the packet audit all resolve through the second,
   * so the review screen renders the second - and the mint gate asked only the first. */
  assert.equal(resolverAnswerFor(question()), 'Female', 'the resolver answers her profile wording');
  assert.equal(
    resolveProfileField(
      { label: GENDER_LABEL, inputType: 'select-one', options: HRT_GENDER_OPTIONS },
      HER_PROFILE,
    )?.value,
    'Woman',
    "and the fill writes the employer's own option text",
  );
  assert.equal(machineAnswerFor(question()), 'Woman', 'which is exactly what the new lookup answers');
});

test('a body echoing the screen does not become her reviewed choice, back-dated two days', () => {
  /* THE REGRESSION GATE. On origin/main this produces the live record byte for byte:
   * answer "Woman", answer_source "applicant_review", answer_override_of "Female",
   * answer_reviewed_at equal to a review round that predates the value by two days. */
  const [saved] = save([question()], [question({ answer: 'Woman' })]);

  assert.equal(saved.answer, 'Woman', 'the bytes in the request are still adopted verbatim');
  assert.deepEqual(claims(saved), {
    answer: 'Woman',
    answer_source: undefined,
    answer_reviewed_at: undefined,
    answer_override_of: undefined,
  }, 'and nothing on the record claims she chose them');
});

test('the false claim would have been permanent, which is why the mint gate is the fix', () => {
  /* The harm is not only the false sentence. Build the record the old gate minted and hand it to
   * the refresh: the early return keeps it ahead of every recompute rule, so no resolver Litos
   * ships afterwards can ever correct it. */
  const laundered = question({
    answer: 'Woman',
    answer_source: 'applicant_review',
    answer_reviewed_at: ROUND,
    answer_override_of: 'Female',
  });
  const [afterCorrection] = refreshKnownQuestionAnswers(
    [laundered], HER_PROFILE, undefined, ROUND, undefined, undefined, AS_OF,
  );
  assert.deepEqual(afterCorrection, laundered, 'the refresh returns it untouched, permanently');

  /* And the row this branch produces instead is ordinary machine output, which the refresh owns. */
  const [saved] = save([question()], [question({ answer: 'Woman' })]);
  const [recomputed] = refreshKnownQuestionAnswers(
    [saved], HER_PROFILE, undefined, ROUND, undefined, undefined, AS_OF,
  );
  assert.equal(recomputed.answer_source, undefined, 'nothing shields it from a later resolver');
});

test('end to end through the send path, on the round the route actually stamps', () => {
  const current = {
    questions: [question()],
    questions_reviewed_at: ROUND,
    jd_text: undefined,
  } as unknown as ApplicationReviewState;
  const { questions, questionsReviewedAt } = resolveSubmittedApplicationAnswers({
    current,
    submitted: [question({ answer: 'Woman' })],
    profile: HER_PROFILE,
    asOf: AS_OF,
    now: () => '2026-09-03T15:19:57.000Z',
  });

  assert.equal(questions[0].answer_source, undefined, 'no claim is minted on the send path either');
  assert.equal(questions[0].answer_override_of, undefined);
  /* AND THE BACK-DATING IS NOT FIXED HERE, deliberately, because it cannot be fixed here alone.
   * The round is frozen at the FIRST review by design (`current.questions_reviewed_at ?? now()`),
   * and every reader of a claim demands answer_reviewed_at === questions_reviewed_at, so advancing
   * it would invalidate every standing claim on the packet at once. What this branch removes is the
   * only thing that made the frozen round dangerous on a machine value: the claim itself. */
  assert.equal(questionsReviewedAt, ROUND, 'the round is still the first review, and still frozen');
});

test('a self-identification she genuinely changes is still recorded as hers', () => {
  /* The gate refuses an ECHO, not an edit. "Non-binary" is on the employer's list and is not what
   * the machine writes, so this is her choice and the record has to say so - including the override
   * note, which must name the PRE-SNAP resolver value or its own currency check can never pass. */
  const [saved] = save([question()], [question({ answer: 'Non-binary' })]);
  assert.deepEqual(claims(saved), {
    answer: 'Non-binary',
    answer_source: 'applicant_review',
    answer_reviewed_at: ROUND,
    answer_override_of: 'Female',
  });
});

test('an explicit per-question confirmation still claims a machine value, which is the escape hatch', () => {
  /* If she really did pick "Woman" off the list, the product has a way to say so and it is not a
   * diff: the client sets `confirmed` on the one question she confirmed. applicantConfirmedAnswer is
   * deaf to both value tests on purpose, so this branch is untouched - and it is why refusing the
   * echo costs her nothing she cannot get back deliberately. */
  const [saved] = save(
    [question()],
    [{ ...question({ answer: 'Woman' }), confirmed: true } as SubmittedApplicationReviewQuestion],
  );
  assert.equal(saved.answer, 'Woman');
  assert.equal(saved.answer_source, 'applicant_review');
  assert.equal(saved.answer_reviewed_at, ROUND);
  assert.equal(saved.answer_override_of, 'Female', 'a confirmation of a disputed value is an override too');
});

test('the shapes the mint rule exists for still mint: a degree edit and an off-resolver option pick', () => {
  /* THE TWO MEASURED CASES THE EXISTING RULE WAS BUILT FROM, pinned so this gate cannot quietly
   * take them back. Neither answer is a string the machine writes for its control, so both are
   * still hers: the Lever degree edit ("the supported edit path could not move a single resolved
   * answer in the product") and the Mytos band pick, where resolveProfileField matches no option at
   * all and the applicant chose one anyway. */
  const degree: ApplicationReviewQuestion = {
    id: 'degree',
    question: 'What is your highest level of education?',
    answer: "Bachelor's Degree",
    kind: 'required',
    required: true,
    portal_input_type: 'select-one',
    options: ["Bachelor's Degree", "Master's Degree", 'Doctorate'],
  };
  const [savedDegree] = save([degree], [{ ...degree, answer: "Master's Degree" }]);
  assert.equal(savedDegree.answer_source, 'applicant_review', 'her degree correction is hers');

  const gpaBand: ApplicationReviewQuestion = {
    id: 'gpa',
    question: 'Degree classification',
    answer: '3.89/4.00 (US 4.0 scale)',
    kind: 'required',
    required: true,
    portal_input_type: 'select-one',
    options: ['GPA 3.5-3.8', 'GPA 3.8-4.0', 'First class honours'],
  };
  const [savedBand] = save([gpaBand], [{ ...gpaBand, answer: 'GPA 3.5-3.8' }]);
  assert.equal(savedBand.answer_source, 'applicant_review', 'the option she picked is hers');
});

test('a control with no measured option list resolves to the unsnapped value and changes nothing', () => {
  /* The lookup reads the ROW's own control shape. With no list there is nothing to snap onto, so it
   * answers what knownAnswerLookup answers and this gate adds exactly zero refusals - which is what
   * keeps it from becoming a second, quieter resolver. */
  const openControl = question({ portal_input_type: 'text', options: null });
  assert.equal(machineAnswerFor(openControl), 'Female', 'the same string the resolver answers');
  const [saved] = save([openControl], [{ ...openControl, answer: 'Woman' }]);
  assert.equal(saved.answer_source, 'applicant_review', 'so a typed value is still her own');
});

test('an untouched Save over a machine value mints nothing, exactly as before', () => {
  const [saved] = save([question()], [question()]);
  assert.equal(saved.answer, 'Female');
  assert.equal(saved.answer_source, undefined);
});

/* ── The fill run's own writeback: an override record does not outlive its answer ──────────────── */

const GENDER_FIELD = {
  label: GENDER_LABEL,
  selector: '#gender',
  durableSelector: '#gender',
  inputType: 'select-one',
  role: 'combobox',
  options: [...HRT_GENDER_OPTIONS],
  required: true,
  maxLength: null,
} as never;

/** submissionRunner.ts's own composition for the persisted question list, byte for byte.
 *
 * BOTH HALVES ARE RETURNED, and the resolved row is the one to assert on for this rule.
 * mergeDiscoveredPortalQuestions puts a current-round applicant answer FIRST and
 * normalizeApplicationReviewQuestions is first-wins, so on a row she still owns the stored record
 * wins the collision and the resolved row never reaches the packet. Asserting only on `persisted`
 * would leave the branch under test unobserved on exactly the shape that keeps her claim. */
const fillRun = async (stored: ApplicationReviewQuestion) => {
  const current = {
    questions: [stored],
    questions_reviewed_at: ROUND,
    portal_url: 'https://boards.greenhouse.io/hudsonrivertrading/jobs/1',
    ats_name: 'greenhouse',
    jd_text: '',
  } as unknown as ApplicationReviewState;
  const discovery = await discoverAndResolveQuestions(
    [GENDER_FIELD],
    { id: 'app', job_context: null, spec: {} } as never,
    current,
    HER_PROFILE,
    false,
    'greenhouse',
  );
  const persisted = reopenUnfitClosedChoiceQuestions(resolveApplicantClosedChoiceFallbacks(
    [GENDER_FIELD],
    mergeDiscoveredPortalQuestions(
      discovery.questions,
      [stored],
      discovery.invalidatedQuestionKeys,
      new Set(),
      current.questions_reviewed_at,
    ),
    undefined,
    undefined,
  ));
  return { resolved: discovery.questions, persisted };
};

test('a fill that replaces the answer drops the override note the old answer was made against', async () => {
  /* MEASURED 2026-09-03 by running this composition over the HRT shapes on origin/main. The runner
   * already drops answer_source and answer_reviewed_at when it replaces a stored answer with a
   * machine value; answer_override_of was the one claim about the old string that rode across. It
   * is not inert - refreshKnownQuestionAnswers reads it to decide whether to KEEP an answer - and a
   * machine value has nothing to be an override OF. */
  const [persisted] = (await fillRun(question({
    answer: '',
    answer_draft: 'Female',
    answer_source: 'applicant_review',
    answer_reviewed_at: ROUND,
    answer_override_of: 'Female',
  } as Partial<ApplicationReviewQuestion>))).persisted;

  assert.equal(persisted.answer, 'Woman', 'the fill really did replace the answer');
  assert.equal(persisted.answer_override_of, undefined, 'so the override note goes with the old one');
  assert.equal(persisted.answer_source, undefined, 'as the source and the round already did');
  assert.equal(persisted.answer_option_source, 'Female', 'the derivation record is about the NEW value and stays');
});

test('a replaced answer sheds its override even when nothing on the row was ever hers', async () => {
  /* THE SHAPE THE OLD CODE ITSELF PRODUCES, which is why the strip is keyed on the answer changing
   * and not on answer_source. The runner has always dropped answer_source on a replacement while
   * leaving answer_override_of, so the row this run meets is routinely a plain machine record still
   * carrying an override note - measured on origin/main as
   * {answer:"Woman", answer_override_of:"Female", answer_option_source:"Female"}. Keyed on the
   * source, this exact record is the one case the strip would keep missing, and it is the common
   * one. */
  const { resolved } = await fillRun(question({ answer_override_of: 'Female' }));

  assert.equal(resolved[0].answer, 'Woman', 'the resolver replaced her stored "Female"');
  assert.equal(resolved[0].answer_source, undefined, 'nothing here was ever an applicant claim');
  assert.equal(resolved[0].answer_override_of, undefined, 'and the override note still goes');
});

test('both merge call sites on the save paths are wired to the machine lookup', () => {
  /* THE ONE THING THE UNIT TESTS ABOVE CANNOT REACH. mergeSubmittedApplicationReviewQuestions takes
   * the lookup as an argument, so a call site that omits it silently keeps the old behaviour with no
   * type error and no failing assertion - and PUT /applications/:id/review/answers is a route, not a
   * function these tests can compose. Pinned as source, the way this repo already pins which gate an
   * employer-bound route calls (see packetAuditRoutes.test.ts). */
  const applications = readFileSync('src/routes/applications.ts', 'utf8');
  const from = applications.indexOf("'/applications/:id/review/answers'");
  const to = applications.indexOf("'/applications/:id/submit-request'", from);
  assert.ok(from >= 0 && to > from, 'the narrow answers route was not found');
  const answersRoute = applications.slice(from, to);
  assert.match(answersRoute, /machineAnswerLookup\(/, 'the answers route builds the machine lookup');
  assert.match(
    answersRoute,
    /mergeSubmittedApplicationReviewQuestions\([\s\S]*?resolverAnswerFor,\s*machineAnswerFor,/,
    'and hands it to the merge beside the resolver lookup',
  );

  const submittedAnswers = readFileSync('src/lib/submittedAnswers.ts', 'utf8');
  assert.match(
    submittedAnswers,
    /mergeSubmittedApplicationReviewQuestions\([\s\S]*?machineAnswerLookup\(/,
    'and so does the send path',
  );
});

test('a fill that recomputes the same answer keeps every claim standing', async () => {
  /* The converse, and the reason the strip is keyed on the answer changing rather than on the
   * source. Nothing is being replaced here, so nothing on the record has gone stale. */
  /* Asserted on the RESOLVED row as well as the persisted one. The stored record wins the writeback
   * collision on a row she still owns, so `persisted` alone would be green whatever this branch did
   * to the resolved copy - and that copy is what a later run inherits. */
  const { resolved, persisted } = await fillRun(question({
    answer: 'Woman',
    answer_source: 'applicant_review',
    answer_reviewed_at: ROUND,
    answer_override_of: 'Female',
  }));

  assert.equal(resolved[0].answer, 'Woman', 'the resolver recomputed the same value');
  assert.equal(resolved[0].answer_override_of, 'Female', 'so her override is still about this string');
  assert.equal(resolved[0].answer_source, 'applicant_review', 'and the claim itself stands');
  assert.equal(persisted[0].answer, 'Woman');
  assert.equal(persisted[0].answer_override_of, 'Female', 'her override survives an unchanged answer');
  assert.equal(persisted[0].answer_reviewed_at, ROUND);
});
