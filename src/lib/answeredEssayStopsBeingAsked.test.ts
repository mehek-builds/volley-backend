import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeSubmittedApplicationReviewQuestions,
  type ApplicationReviewQuestion,
  type SubmittedApplicationReviewQuestion,
} from './applicationReview';
import {
  applicantConfirmedSensitiveAnswer,
  normalizeStoredPortalQuestions,
} from './questionDiscovery';
import { unapprovedLitosDraftQuestionLabels } from './submissionSafety';

/* THE MEASURED LOOP, 2026-09-04, account mehekmandal05@gmail.com, Exa "Software Engineer, Intern"
 * packet 73768339-7fef-4493-aa75-1d47c61ae51f (ashby).
 *
 * Four required essay questions, every one already drafted and answered with good text. The
 * dashboard walks them one per screen ("1 of 4", "Save and next"); each press sends
 * PUT /applications/:id/review/answers with `confirmed: true` for that one question, and each
 * returned 200. Reloading came back to "1 of 4", the same question, the same 365-character answer.
 *
 * The tests below run the two real compositions the product runs - the read path's
 * normalizeStoredPortalQuestions, then the save path's merge - rather than asserting a predicate
 * agrees with itself. On the base commit the loop reproduces here exactly: three passes, twelve
 * confirmations, nothing minted, all four still owed. */

const ROUND = '2026-09-04T00:00:00.000Z';
const ESSAY = 'x'.repeat(365);

/* The employer's own label as the run captured it, required marker and all. That marker is the
 * whole of the divergence: normalizeReviewQuestionLabel strips it on every read, and nothing ever
 * writes the stripped form back. */
const STORED_LABELS = [
  'Why do you want to work at Exa? *',
  'What is the most impressive thing you have built? *',
  'Tell us about a time you shipped something end to end. *',
  'What are you hoping to learn here? *',
] as const;

const storedEssays = (): ApplicationReviewQuestion[] => STORED_LABELS.map((question, index) => ({
  id: `q${index + 1}`,
  question,
  answer: ESSAY,
  kind: 'essay' as const,
  required: true,
  answer_source: 'litos_draft' as const,
}));

/** GET /applications/:id/submission, as far as the label is concerned. */
const served = (questions: readonly ApplicationReviewQuestion[]) =>
  normalizeStoredPortalQuestions(questions, 'ashby');

/**
 * One press of "Save and next": the dashboard posts back the whole list it was SHOWN, flagging the
 * single question on screen. The body is narrowed to the keys reviewAnswersBodySchema admits, so
 * this cannot accidentally hand the merge provenance a real request could never carry.
 */
const saveAndNext = (
  stored: readonly ApplicationReviewQuestion[],
  targetId: string,
): ApplicationReviewQuestion[] => mergeSubmittedApplicationReviewQuestions(
  stored,
  served(stored).map((question): SubmittedApplicationReviewQuestion => ({
    id: question.id,
    question: question.question,
    answer: question.answer,
    kind: question.kind,
    required: question.required,
    ...(question.id === targetId ? { confirmed: true as const } : {}),
  })),
  ROUND,
  // The resolver answers nothing for an essay label, on either lookup.
  () => undefined,
  () => undefined,
);

const walkAllFour = (stored: readonly ApplicationReviewQuestion[]): ApplicationReviewQuestion[] => {
  let current = [...stored];
  for (const question of served(current)) current = saveAndNext(current, question.id);
  return current;
};

describe('an essay she read and confirmed stops being asked', () => {
  test('the four Exa essays settle on the first pass and stay settled', () => {
    const first = walkAllFour(storedEssays());

    for (const question of first) {
      assert.equal(
        question.answer_source,
        'applicant_review',
        `her confirmation must be recorded: ${question.question}`,
      );
      assert.equal(question.answer_reviewed_at, ROUND);
      /* Minted against the STORED label, which is the form identity and stays so. The reader is
       * what crosses back over the serve boundary; see the round trip asserted below. */
      assert.equal(question.answer_confirmed_of, question.question);
      assert.equal(question.answer, ESSAY, 'her paragraph is untouched');
    }

    /* THE EXIT, stated as the send gate states it. This is the list the 422 is built from, and on
     * the base commit it still named all four after every pass. */
    assert.deepEqual(unapprovedLitosDraftQuestionLabels(first), []);

    /* AND IT DOES NOT UNWIND. The second pass re-posts three unflagged questions beside each
     * flagged one, which is exactly where exactReviewedIdentityUnchanged used to drop the claim
     * minted by the pass before - a second turn of the same screw, hidden behind the first. */
    const second = walkAllFour(first);
    for (const question of second) {
      assert.equal(question.answer_source, 'applicant_review', `claim survives pass two: ${question.question}`);
      assert.equal(question.answer_confirmed_of, question.question);
    }
    assert.deepEqual(unapprovedLitosDraftQuestionLabels(second), []);
  });

  test('a save that flags nothing still mints nothing, on the same packet', () => {
    /* The other half of the loop's own evidence: what made it a loop was that a CONFIRMED save and
     * an untouched Save were indistinguishable to the row. They must stay distinguishable in the
     * other direction, or this change is the 802-answer laundering arriving through the label. */
    const stored = storedEssays();
    const merged = mergeSubmittedApplicationReviewQuestions(
      stored,
      served(stored).map((question): SubmittedApplicationReviewQuestion => ({
        id: question.id,
        question: question.question,
        answer: question.answer,
        kind: question.kind,
        required: question.required,
      })),
      ROUND,
      () => undefined,
      () => undefined,
    );
    for (const question of merged) {
      assert.equal(question.answer_source, 'litos_draft', 'an unflagged echo approves nothing');
      assert.equal(question.answer_confirmed_of, undefined);
    }
    assert.deepEqual(
      unapprovedLitosDraftQuestionLabels(merged).length,
      4,
      'every draft is still owed her approval',
    );
  });
});

describe('the confirmation survives the trip back out to the reader', () => {
  /* A refused work-eligibility label, which is the shape the sensitive gate actually rules on, and
   * the one the same divergence silently broke: the mint writes the raw stored label while every
   * reader sees the served one, so a confirmation could be recorded and then unreadable on the very
   * next request - a 200 that changed nothing, which is the CONFIRM loop in its older shape. */
  const SPONSORSHIP = 'Do you require visa sponsorship to work in your selected location? *';
  const sensitive = (): ApplicationReviewQuestion[] => [{
    id: 'q-visa',
    question: SPONSORSHIP,
    answer: 'Yes',
    kind: 'required',
    required: true,
  }];

  test('a confirmed sensitive answer reads as confirmed on the served record', () => {
    const stored = sensitive();
    const confirmed = saveAndNext(stored, 'q-visa');
    assert.equal(confirmed[0].answer_confirmed_of, SPONSORSHIP);

    const [asServed] = served(confirmed);
    assert.notEqual(asServed.question, SPONSORSHIP, 'the read path really does rewrite this label');
    assert.equal(
      applicantConfirmedSensitiveAnswer(asServed),
      true,
      'the gate must read back the confirmation it was just handed',
    );
  });

  test('a confirmation does not carry across a real rename', () => {
    const confirmed = saveAndNext(sensitive(), 'q-visa');
    const renamed = {
      ...confirmed[0],
      question: 'Do you require visa sponsorship to work in the United Kingdom?',
    };
    assert.equal(
      applicantConfirmedSensitiveAnswer(renamed),
      false,
      'a different sentence in front of an employer is a different question',
    );
  });
});

/* IMPORTED LAZILY, AND ONLY HERE, so this file DISCRIMINATES rather than merely failing to load.
 * A static import of a symbol the base commit does not export makes every test in the file fail
 * with a module error, which proves the export is new and proves nothing about the loop. Deferred,
 * the two compositions above run against whatever `mergeSubmittedApplicationReviewQuestions` the
 * checkout actually has - and on the base commit they fail on the behaviour, naming the answer
 * source and the still-owed drafts. */
const predicate = async () => (await import('./questionDiscovery')).servedLabelMatchesStoredControl;

describe('servedLabelMatchesStoredControl admits only what the server itself serves', () => {
  test('the stored bytes and their own normalization, and nothing else', async () => {
    const servedLabelMatchesStoredControl = await predicate();
    const stored = 'Why do you want to work at Exa? *';
    assert.equal(servedLabelMatchesStoredControl(stored, stored), true);
    assert.equal(servedLabelMatchesStoredControl(stored, 'Why do you want to work at Exa?'), true);
  });

  test('a rename is still a rename, including a whitespace one', async () => {
    const servedLabelMatchesStoredControl = await predicate();
    const stored = 'Can you work onsite?';
    /* One-directional on purpose. The server never serves a padded label, so a body carrying one is
     * not echoing anything, and applicationReview.test.ts requires it to invalidate. Folding both
     * sides would admit it. */
    assert.equal(servedLabelMatchesStoredControl(stored, '  Can you work onsite?  '), false);
    assert.equal(servedLabelMatchesStoredControl(stored, 'Can  you work onsite?'), false);
    assert.equal(servedLabelMatchesStoredControl(stored, 'can you work onsite?'), false);
    assert.equal(servedLabelMatchesStoredControl(stored, 'Can you work on-site?'), false);
  });

  test('a label the normalizer cannot read matches only itself', async () => {
    const servedLabelMatchesStoredControl = await predicate();
    /* An opaque identifier normalizes to '', which must not become a wildcard that folds every
     * unreadable control on the form into one. */
    const opaque = '__field_9f2a1c';
    assert.equal(servedLabelMatchesStoredControl(opaque, opaque), true);
    assert.equal(servedLabelMatchesStoredControl(opaque, ''), false);
    assert.equal(servedLabelMatchesStoredControl(opaque, '__field_0000aa'), false);
  });
});
