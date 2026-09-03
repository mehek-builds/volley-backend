import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  applicantConfirmedSensitiveAnswer,
  refreshKnownQuestionAnswers,
  reviewQuestionRequiresAttention,
  sensitiveQuestionRequiresAttention,
} from './questionDiscovery';
import {
  applyApplicantReviewedAnswers,
  applyApplicationReviewEdit,
  mergeSubmittedApplicationReviewQuestions,
  type ApplicationReviewQuestion,
  type ApplicationReviewState,
  type SubmittedApplicationReviewQuestion,
} from './applicationReview';

/* THE SEND THAT COULD NOT BE MADE, AND THE ONE THAT STILL MUST NOT BE.
 *
 * Packet 4a79eec1 (Hudson River Trading, greenhouse), account a18f774b, traced end to end on
 * 2026-09-03. ready_for_final_approval, server audit passed, 27 of 27 questions answered, 46 fields
 * filled, resume verified attached on the employer's own form. Every press of Send answered 422:
 *
 *   Sensitive question requires your attention: will you now, or in the future, require visa
 *   sponsorship to legally work in the country specified for this position?
 *
 * The question was answered "Yes". By her. Stamped answer_source 'applicant_review' with
 * answer_reviewed_at 2026-09-01T21:28:12.934Z. The refusal was not about the answer being wrong or
 * missing; the gate never looked at where the answer came from at all. It asked one question - does
 * the resolver independently compute this same value - and workEligibilityAnswer REFUSES this label
 * by design, because HRT's posting lists Austin, Chicago, New York, London and Singapore, so "the
 * country specified for this position" names three countries and her position differs between them.
 * A refusal makes the gate's only test false forever, so the expression was `!(false)` on every
 * evaluation and no action she could take would ever change it.
 *
 * BOTH HALVES OF THIS FILE ARE LOAD-BEARING. The refusal is correct and R-004 is the logged incident
 * where guessing one of the three countries sent a false legal declaration to an employer; nothing
 * here narrows it. What changes is that HER OWN CONFIRMATION is now an input, and only hers: the
 * machine paths that can mint answer_source 'applicant_review' - the blanket PUT /review stamp and
 * the diff-inferred edit claim - are exercised below and must still refuse.
 */

/** Her real stored eligibility, from the account above. Not a fixture; this is what is in the row. */
const HER_PROFILE = {
  citizenship: 'India',
  work_eligibility_by_country: [{
    country_code: 'US',
    authorized_now: true,
    needs_sponsorship_now: false,
    needs_sponsorship_future: true,
    authorization_type: 'F-1 CPT/OPT',
  }],
/* Index 4, not 3: the gate takes the packet's questions ahead of the label, so the profile moved
 * one place along. Kept as a positional type derived from the function rather than an imported one
 * so a signature change surfaces here as a compile error instead of a silently mistyped fixture. */
} as unknown as Parameters<typeof sensitiveQuestionRequiresAttention>[4];

/** The employer's own wording, byte for byte off the packet. */
const HRT_LABEL =
  'will you now, or in the future, require visa sponsorship to legally work in the country specified for this position?';

const REVIEWED_AT = '2026-09-01T21:28:12.934Z';

function gate(
  label: string,
  answer: string,
  confirmation?: { answer_confirmed_of?: unknown },
): boolean {
  /* An EMPTY packet, deliberately: every case in this file is about the CONFIRMATION exit, so the
   * gate must see no work-location answers and therefore no indicated country. That keeps the
   * refusals below meaning "the resolver still cannot answer this label", which is what they are
   * asserting, rather than passing because the packet happened to settle the country. */
  return sensitiveQuestionRequiresAttention(
    [], label, answer, 'text', HER_PROFILE, undefined, undefined, undefined, confirmation,
  );
}

function storedQuestion(overrides: Partial<ApplicationReviewQuestion> = {}): ApplicationReviewQuestion {
  return {
    id: 'q-sponsorship',
    question: HRT_LABEL,
    answer: 'Yes',
    kind: 'required',
    required: true,
    ...overrides,
  } as ApplicationReviewQuestion;
}

test('the dead end is real: the resolver refuses this label and no answer alone can clear it', () => {
  /* The refusal itself, stated first so a later narrowing of workEligibilityAnswer cannot make the
   * rest of this file pass for the wrong reason. Three countries, two different true answers. */
  assert.equal(gate(HRT_LABEL, 'Yes'), true, 'her correct answer does not clear the gate on its own');
  assert.equal(gate(HRT_LABEL, 'No'), true, 'and neither does the opposite one');
  assert.equal(gate(HRT_LABEL, ''), true, 'nor a blank');
  /* And the same profile on a posting that names ONE country resolves cleanly, which is the proof
   * that the refusal is about multi-country ambiguity rather than about her record being unreadable.
   * needs_sponsorship_future is true, so the resolver answers "Yes" and agrees with her. */
  assert.equal(
    sensitiveQuestionRequiresAttention([], HRT_LABEL, 'Yes', 'text', HER_PROFILE, undefined, undefined, 'US'),
    false,
    'a single-country posting was never blocked, which is why this only ever bit multi-country ones',
  );
});

test('her explicit confirmation of this exact question and answer clears the gate', () => {
  assert.equal(gate(HRT_LABEL, 'Yes', { answer_confirmed_of: HRT_LABEL }), false);
});

/* ---- a machine answer must never satisfy the gate ---- */

test('the blanket PUT /review stamp claims the answer and still does not open the gate', () => {
  /* applyApplicantReviewedAnswers is the writer behind the 802-answer laundering: it stamps
   * 'applicant_review' on EVERY non-blank answer in the body, and "do you now or will you in the
   * future require immigration sponsorship" -> "Yes" was one of the 802 it claimed. If the gate had
   * been keyed on that stamp, this test would be the machine walking straight through it. */
  const stamped = applyApplicantReviewedAnswers(
    { questions: [storedQuestion()] } as unknown as ApplicationReviewState,
    [storedQuestion()],
    REVIEWED_AT,
  );
  const question = stamped.questions[0]!;
  assert.equal(question.answer_source, 'applicant_review', 'the blanket stamp does claim it');
  assert.equal(question.answer_reviewed_at, REVIEWED_AT, 'and dates it');
  assert.equal(question.answer_confirmed_of, undefined, 'and cannot say she was shown it');
  assert.equal(
    gate(question.question, question.answer, question),
    true,
    'so the send still refuses: a blanket claim is not a declaration she made',
  );
});

test('a save that merely changes the bytes mints an applicant claim and still does not open the gate', () => {
  /* The other mint path. applicantSuppliedAnswer infers "she typed this" from a diff, which is a
   * reasonable inference and not a confirmation - and on a REFUSED question the second test that
   * normally guards it is dead, because the resolver returns no value for submittedIsResolverValue
   * to compare against. So a body posting any different string mints the claim. It must not mint
   * the confirmation, and the gate must keep refusing. */
  const merged = mergeSubmittedApplicationReviewQuestions(
    [storedQuestion({ answer: 'Yes' })],
    [{ ...storedQuestion({ answer: 'No' }) } as SubmittedApplicationReviewQuestion],
    REVIEWED_AT,
  );
  const question = merged[0]!;
  assert.equal(question.answer, 'No');
  assert.equal(question.answer_source, 'applicant_review', 'the diff mints the applicant claim');
  assert.equal(question.answer_confirmed_of, undefined, 'the diff cannot mint a confirmation');
  assert.equal(gate(question.question, question.answer, question), true);
});

test('a caller cannot assert the confirmation on a stored question by sending the field', () => {
  /* The route's questionSchema drops answer_confirmed_of before the merge is ever reached, and this
   * is the second lock behind that: the merge strips every provenance key off a submitted question
   * and re-derives what it is willing to claim. A public body that sends the field verbatim, with no
   * confirmed flag, gets nothing. */
  const merged = mergeSubmittedApplicationReviewQuestions(
    [storedQuestion({ answer: '' })],
    [{
      ...storedQuestion({ answer: 'Yes' }),
      answer_confirmed_of: HRT_LABEL,
    } as SubmittedApplicationReviewQuestion],
    REVIEWED_AT,
  );
  assert.equal(merged[0]!.answer_confirmed_of, undefined);
  assert.equal(gate(merged[0]!.question, merged[0]!.answer, merged[0]!), true);
});

test('a question arriving only in the submit body brings no confirmation with it', () => {
  const merged = mergeSubmittedApplicationReviewQuestions(
    [],
    [{
      ...storedQuestion({ answer: 'Yes' }),
      answer_confirmed_of: HRT_LABEL,
      confirmed: true,
    } as SubmittedApplicationReviewQuestion],
    REVIEWED_AT,
  );
  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]!.answer_confirmed_of,
    undefined,
    'there is no stored question here for her to have been shown, so a confirmation of one cannot be true',
  );
  assert.equal(gate(merged[0]!.question, merged[0]!.answer, merged[0]!), true);
});

/* ---- and the applicant has a path that actually works ---- */

test('confirmed: true through the answers route records the confirmation and opens the gate', () => {
  const merged = mergeSubmittedApplicationReviewQuestions(
    [storedQuestion({ answer: 'Yes' })],
    [{ ...storedQuestion({ answer: 'Yes' }), confirmed: true } as SubmittedApplicationReviewQuestion],
    REVIEWED_AT,
  );
  const question = merged[0]!;
  assert.equal(question.answer, 'Yes', 'her answer stands unedited, which is what confirming means');
  assert.equal(question.answer_source, 'applicant_review');
  assert.equal(question.answer_confirmed_of, HRT_LABEL, 'and the record names the text she was shown');
  assert.equal(gate(question.question, question.answer, question), false, 'the send is unblocked');
});

test('the SAME save without the flag leaves the packet exactly where it was', () => {
  /* The control test for the one above, and the reason the flag exists at all. An unedited Save
   * posts back the values the screen displayed and is indistinguishable from a Save she never
   * looked at - the DV Trading CONFIRM loop. Only the flag separates them. */
  const merged = mergeSubmittedApplicationReviewQuestions(
    [storedQuestion({ answer: 'Yes' })],
    [{ ...storedQuestion({ answer: 'Yes' }) } as SubmittedApplicationReviewQuestion],
    REVIEWED_AT,
  );
  assert.equal(merged[0]!.answer_confirmed_of, undefined);
  assert.equal(gate(merged[0]!.question, merged[0]!.answer, merged[0]!), true);
});

test('answering a blank sensitive question and confirming it in one save clears it', () => {
  const merged = mergeSubmittedApplicationReviewQuestions(
    [storedQuestion({ answer: '' })],
    [{ ...storedQuestion({ answer: 'Yes' }), confirmed: true } as SubmittedApplicationReviewQuestion],
    REVIEWED_AT,
  );
  assert.equal(merged[0]!.answer_confirmed_of, HRT_LABEL);
  assert.equal(gate(merged[0]!.question, merged[0]!.answer, merged[0]!), false);
});

/* ---- what falsifies a confirmation ---- */

test('replacing the answer drops the confirmation and the gate closes again', () => {
  const confirmed = storedQuestion({ answer: 'Yes', answer_confirmed_of: HRT_LABEL });
  assert.equal(gate(confirmed.question, confirmed.answer, confirmed), false);
  const merged = mergeSubmittedApplicationReviewQuestions(
    [confirmed],
    [{ ...storedQuestion({ answer: 'No' }) } as SubmittedApplicationReviewQuestion],
    REVIEWED_AT,
  );
  assert.equal(
    merged[0]!.answer_confirmed_of,
    undefined,
    'an answer-claim dies with the answer it describes: she never affirmed "No"',
  );
  assert.equal(gate(merged[0]!.question, merged[0]!.answer, merged[0]!), true);
});

test('a confirmation does not carry across a renamed question', () => {
  /* The reason this field stores the label rather than a bare `true`. These two sentences have
   * DIFFERENT true answers for this applicant - she needs no sponsorship in the US today and does
   * need it in the UK - so a confirmation that carried between them would be the false legal
   * declaration R-004 is about, arriving through the fix for it. */
  const uk = 'will you now, or in the future, require visa sponsorship to legally work in the united kingdom?';
  assert.equal(
    gate(uk, 'Yes', { answer_confirmed_of: HRT_LABEL }),
    true,
    'a confirmation made against the multi-country wording says nothing about this one',
  );
  assert.equal(
    gate(HRT_LABEL, 'Yes', { answer_confirmed_of: HRT_LABEL.toUpperCase() }),
    true,
    'and equality is bytes, because a case change is a different sentence in front of an employer',
  );
});

test('a blank answer is not a declaration however it is marked', () => {
  assert.equal(gate(HRT_LABEL, '', { answer_confirmed_of: HRT_LABEL }), true);
  assert.equal(gate(HRT_LABEL, '   ', { answer_confirmed_of: HRT_LABEL }), true);
});

test('a never-fill question refuses whatever anybody confirms', () => {
  /* An SSN and a CAPTCHA are not declarations Litos may carry at all, so the confirmation branch
   * sits behind the NEVER_FILL test in the gate and excludes those labels inside the predicate too.
   * Two readers, one rule; if they ever disagree this is the test that says so. */
  for (const label of ['social security number', 'please complete the captcha below']) {
    assert.equal(gate(label, '123-45-6789', { answer_confirmed_of: label }), true, label);
    assert.equal(
      applicantConfirmedSensitiveAnswer({ question: label, answer: '123-45-6789', answer_confirmed_of: label }),
      false,
      label,
    );
  }
});

test('the confirmation is only ever read for a question the gate actually holds', () => {
  assert.equal(
    applicantConfirmedSensitiveAnswer({
      question: 'how many years of python experience do you have?',
      answer: '3',
      answer_confirmed_of: 'how many years of python experience do you have?',
    }),
    false,
    'an ordinary question is not sensitive, and this predicate must not become a general answer flag',
  );
});

/* ---- the refresh must not delete what the gate now accepts ---- */

test('the send-time refresh keeps a confirmed answer and still blanks an unconfirmed one', () => {
  /* refreshKnownQuestionAnswers runs on the packet at four read sites and on the fill that reaches
   * the employer, and it blanks any answer to a refused question that cannot prove it came from her.
   * The proof it accepted before was keyed on the review ROUND, which holds only while the round
   * stands still - and the round is being made to advance in a concurrent change. Without the
   * confirmation being accepted here too, that change would blank this answer on the next unrelated
   * save and the packet would refuse for a blank required answer instead. */
  const asOf = new Date('2026-09-03T12:00:00.000Z');
  const [kept] = refreshKnownQuestionAnswers(
    [{ question: HRT_LABEL, answer: 'Yes', answer_confirmed_of: HRT_LABEL }],
    HER_PROFILE, undefined, undefined, undefined, undefined, asOf,
  );
  assert.equal(kept!.answer, 'Yes', 'her confirmed answer survives to the gate');
  assert.equal(kept!.answer_confirmed_of, HRT_LABEL, 'with the proof still attached');

  const [blanked] = refreshKnownQuestionAnswers(
    [{ question: HRT_LABEL, answer: 'Yes' }],
    HER_PROFILE, undefined, undefined, undefined, undefined, asOf,
  );
  assert.equal(blanked!.answer, '', 'and an unattributed answer to the same label is still erased');

  const [renamed] = refreshKnownQuestionAnswers(
    [{
      question: 'will you now, or in the future, require visa sponsorship to legally work in the united kingdom?',
      answer: 'Yes',
      answer_confirmed_of: HRT_LABEL,
    }],
    HER_PROFILE, undefined, undefined, undefined, undefined, asOf,
  );
  assert.equal(renamed!.answer, '', 'a confirmation of other words keeps nothing alive here either');
  assert.equal(
    (renamed as { answer_confirmed_of?: unknown }).answer_confirmed_of,
    undefined,
    'and the blanked record keeps no claim beside the value it no longer holds',
  );
});

/* ---- the wiring, which mutation testing caught and nothing else did ---- */

test('the record-first gate reads the confirmation off the question it is handed', () => {
  /* reviewQuestionRequiresAttention exists because the trailing optional argument on the other form
   * is a trap: deleting it at the call site is one token, compiles, and passes every other test in
   * this suite while silently reverting the whole fix. This is the form the send gates use, and the
   * record is not optional in it. */
  assert.equal(
    reviewQuestionRequiresAttention([], { question: HRT_LABEL, answer: 'Yes' }, HER_PROFILE, undefined),
    true,
  );
  assert.equal(
    reviewQuestionRequiresAttention(
      [], { question: HRT_LABEL, answer: 'Yes', answer_confirmed_of: HRT_LABEL }, HER_PROFILE, undefined,
    ),
    false,
  );
});

test('every send gate reaches the applicant confirmation through the record-first form', async () => {
  /* THE MUTATION THIS PINS, stated as the change it refuses. Rewriting the filter below to the
   * label-and-answer form without its trailing record - `sensitiveQuestionRequiresAttention(
   * question.question, question.answer, 'text', profile, jdText, ...)` - type-checks, and before this
   * test the entire suite stayed green while every confirmed sensitive answer refused again in
   * production. The three send gates and the dashboard list all read this one function, so pinning it
   * here pins them. */
  const source = await readFile('src/routes/applications.ts', 'utf8');
  const start = source.indexOf('function sensitiveQuestionsFor(');
  const end = source.indexOf('function sensitiveQuestionFor(', start);
  assert.ok(start >= 0 && end > start, 'sensitiveQuestionsFor must remain the one place this is decided');
  const body = source.slice(start, end);
  /* The packet's own questions now lead the call, carrying the OTHER exit from this gate: the
   * country she indicated on the form. Both are required parameters, so this pin still says exactly
   * what it said before - the whole record reaches the gate, and dropping it is not a silent
   * change - and it now says the same about the form. */
  assert.match(
    body,
    /\.filter\(\(question\) => reviewQuestionRequiresAttention\(\s*packetQuestions,\s*question, profile, jdText, postingCountry, postingCountryCode,/,
    'the whole question record, or her confirmation is not an input to the send gate',
  );
  assert.doesNotMatch(
    body,
    /sensitiveQuestionRequiresAttention\(/,
    'the label-and-answer form takes the record as an optional trailing argument, which is droppable in silence',
  );
  /* And the three send gates plus the dashboard list all still go through it rather than around it. */
  assert.equal(source.split('sensitiveQuestionFor(').length - 1, 4, 'three send gates and one list');
});

test('the blanket review route cannot carry a confirmation even if a caller sends one', () => {
  /* PUT /review claims every non-blank answer as hers, which is the writer the 802-answer laundering
   * came through. reviewBodySchema does not list `confirmed` and zod strips it; this asserts the
   * function refuses it too, so the one-writer property does not depend on a schema in another file
   * staying narrow. */
  const edited = applyApplicationReviewEdit(
    {
      questions: [storedQuestion({ answer: 'Yes' })],
      questions_reviewed_at: REVIEWED_AT,
    } as unknown as ApplicationReviewState,
    {
      questions: [{ ...storedQuestion({ answer: 'Yes' }), confirmed: true } as ApplicationReviewQuestion],
      skipped_reasons: [],
    },
  );
  const question = edited.questions[0]!;
  assert.equal(question.answer_source, 'applicant_review', 'the blanket stamp still claims the answer');
  assert.equal(question.answer_confirmed_of, undefined, 'and still cannot say she was shown it');
  assert.equal(gate(question.question, question.answer, question), true);
});

test('a confirmed EEO self-identification is hers on the same rule', () => {
  /* The other family isRefusedQuestion holds, and the one the 802-answer incident did most damage
   * in: gender, disability status and veteran status were all claimed by the blanket stamp. Same
   * predicate, so they get the same exit and the same locks. */
  const label = 'what is your gender?';
  assert.equal(gate(label, 'Female', undefined), true);
  assert.equal(gate(label, 'Female', { answer_confirmed_of: label }), false);
});
