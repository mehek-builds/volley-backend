import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conditionalFollowUpPolarity,
  gatingAnswerPolarity,
  unmetConditionalFollowUpBlockers,
} from './conditionalFollowUp';
import { READ_SUBMIT_READINESS_SCRIPT } from './portalSubmission';

/* Every fixture below is the live employer markup, read read-only on 2026-08-13, paired with the
 * stored packet it blocked on account a18f774b. The discovered labels are written the way discovery
 * really reports them on Greenhouse - the visible label with the control's own handle concatenated
 * onto it, and the employer's `*` still attached where the employer printed one - because
 * discoveredFieldIsRequired reads that RAW string and normalizeReviewQuestionLabel is what strips
 * the handle back off. Getting that wrong is the difference between this module seeing Akuna's
 * required marker and not. */

const SCALE_AI_AGREEMENTS = 'Are you currently bound by any agreements with a current or former '
  + 'employer that may restrict your ability to work for Scale AI or perform the duties of the '
  + 'position for which you are applying? This includes, but is not limited to, non-compete '
  + 'agreements, non-solicitation agreements, confidentiality or non-disclosure agreements, or any '
  + 'other contractual obligations that could limit your employment activities.';

const scaleAiDiscovered = () => [
  { label: 'LinkedIn Profile question_8788016005' },
  { label: 'Website question_8788017005' },
  { label: `${SCALE_AI_AGREEMENTS}* question_8788019005` },
  { label: 'If yes, please provide further explanation below. question_8788020005' },
  { label: 'Are you legally authorized to work in the country where the job is located?* question_8788021005' },
  {
    label: 'Will you now or in the future require company sponsorship to retain or extend your work '
      + 'authorization in the country where the job is located?* question_8788022005',
  },
];

const scaleAiQuestions = (agreementsAnswer: string) => [
  { question: 'linkedin profile', answer: 'https://www.linkedin.com/in/mehekmandal/' },
  { question: 'website', answer: 'https://github.com/mehek-builds' },
  { question: SCALE_AI_AGREEMENTS.toLowerCase(), answer: agreementsAnswer },
  { question: 'are you legally authorized to work in the country where the job is located?', answer: 'Yes' },
  {
    question: 'will you now or in the future require company sponsorship to retain or extend your work '
      + 'authorization in the country where the job is located?',
    answer: 'Yes',
  },
];

const SCALE_AI_BLOCKER = '"If yes, please provide further explanation below." is required and is still empty';

test('the Scale AI shape: the gate is answered No, so the follow-up stops holding the send', () => {
  /* Packet 9ddffb88-edae-41b2-8d71-b052648c358b, whose ENTIRE attention_reason was this sentence
   * plus the unanswerable count derived from it. `question_8788020005` carries aria-required="false",
   * no required attribute and no asterisk; the agreements question above it is answered "No". */
  assert.deepEqual(
    unmetConditionalFollowUpBlockers([SCALE_AI_BLOCKER], scaleAiDiscovered(), scaleAiQuestions('No')),
    [SCALE_AI_BLOCKER],
  );
});

test('the Scale AI shape with the gate answered Yes keeps the follow-up required', () => {
  // Same form, same optional marker. The condition is MET, so the employer really is asking for an
  // explanation and this must reach her rather than be dropped.
  assert.deepEqual(
    unmetConditionalFollowUpBlockers([SCALE_AI_BLOCKER], scaleAiDiscovered(), scaleAiQuestions('Yes')),
    [],
  );
});

test('an undetermined gating answer keeps the follow-up required', () => {
  // Packets 7cfdb112 and 72a12ce7, same Scale AI posting: the agreements question is a legal
  // declaration Litos refuses to answer, so it came back empty and its own blocker is in the list.
  // The condition cannot be evaluated, and unevaluated is not the same as unmet.
  const blockers = [
    `"${SCALE_AI_AGREEMENTS.slice(0, 118)}" is required and is still empty`,
    SCALE_AI_BLOCKER,
  ];
  assert.deepEqual(
    unmetConditionalFollowUpBlockers(blockers, scaleAiDiscovered(), scaleAiQuestions('')),
    [],
  );
  // A gate answered with something that is neither yes nor no is undetermined for the same reason.
  assert.deepEqual(
    unmetConditionalFollowUpBlockers([SCALE_AI_BLOCKER], scaleAiDiscovered(), scaleAiQuestions('Prefer not to say')),
    [],
  );
});

test('a gating question with no record at all keeps the follow-up required', () => {
  // Discovery reported the follow-up and nothing above it. There is no referent, so nothing to
  // evaluate, so the blocker stands.
  const orphaned = [{ label: 'If yes, please provide further explanation below. question_8788020005' }];
  assert.deepEqual(unmetConditionalFollowUpBlockers([SCALE_AI_BLOCKER], orphaned, []), []);
});

const AKUNA_FOLLOW_UP = 'If you answered “Yes” above to requiring visa sponsorship now or in the '
  + 'future for work authorization, please respond to the following questions. What is your current '
  + 'immigration status/basis of your current work authorization?';

const akunaDiscovered = (marker: string) => [
  {
    label: 'Do you now, or will you in the future, require visa sponsorship to continue working in the '
      + 'United States (e.g. H-1B, TN, E-3, O-1, etc.)?* question_67727967',
  },
  { label: `${AKUNA_FOLLOW_UP}${marker} question_67727968` },
];

const akunaQuestions = (sponsorship: string) => [
  {
    question: 'do you now, or will you in the future, require visa sponsorship to continue working in the '
      + 'united states (e.g. h-1b, tn, e-3, o-1, etc.)?',
    answer: sponsorship,
  },
];

// The provider truncates a long blocker label at 120 characters, which is why this fixture is
// clipped and why label matching has to tolerate a prefix.
const AKUNA_BLOCKER = `"${AKUNA_FOLLOW_UP.slice(0, 118)}" is required and is still empty`;

test('the Akuna shape: the employer marks the follow-up required, so it stays required', () => {
  /* `question_67727968` really does carry aria-required="true" and a `*` in its label, on nine
   * blocked packets. An employer who marks a conditional field required requires it
   * unconditionally, and the asterisk in the RAW discovered label is how this module sees that. */
  assert.deepEqual(
    unmetConditionalFollowUpBlockers([AKUNA_BLOCKER], akunaDiscovered('*'), akunaQuestions('Yes')),
    [],
  );
});

test('the Akuna shape: a Yes gating answer keeps the follow-up required even without the marker', () => {
  // The two facts are independent, and each alone is enough to keep the blocker. Here the marker is
  // gone and only the answered condition holds it, which is the case the applicant's own answer
  // creates.
  assert.deepEqual(
    unmetConditionalFollowUpBlockers([AKUNA_BLOCKER], akunaDiscovered(''), akunaQuestions('Yes')),
    [],
  );
  // ... and with the marker gone AND the sponsorship answer negative, the employer's form is asking
  // nothing, so it drops. This is the DV Trading shape the day its gate gets an answer.
  assert.deepEqual(
    unmetConditionalFollowUpBlockers([AKUNA_BLOCKER], akunaDiscovered(''), akunaQuestions('No')),
    [AKUNA_BLOCKER],
  );
});

const DV_FOLLOW_UP = 'If yes, please provide your visa type and expiration date.';
const DV_SPONSORSHIP = 'Will you now or in the future require employer sponsorship for work '
  + 'authorization in this country? If you will be working remotely from outside the US, please '
  + 'answer no.';

const dvDiscovered = () => [
  { label: 'Are you legally authorized to work in the country where this role is based? * question_8954177005' },
  { label: `${DV_SPONSORSHIP}* question_8954178005` },
  { label: `${DV_FOLLOW_UP} question_8954179005` },
  { label: 'How did you hear about DV Trading?* question_8954181005' },
  { label: 'Terms & Conditions* question_8954183005' },
];

test('the DV Trading shape: the sponsorship gate was never answered, so the follow-up stays required', () => {
  /* Packets 42dd2894, 5d228350 and 07283493. `question_8954179005` is aria-required="false" with no
   * asterisk, so the employer does not require it - but the sponsorship question above it came back
   * empty on all three, so this run cannot prove the condition is unmet and must not act as if it
   * had. Fail closed: a wrongly-required field costs a question, a wrongly-skipped one costs an
   * application. */
  const blockers = [
    `"${DV_SPONSORSHIP.slice(0, 118)}" is required and is still empty`,
    `"${DV_FOLLOW_UP}" is required and is still empty`,
    '"Terms & Conditions" is required and is still empty',
  ];
  const questions = [
    { question: 'are you legally authorized to work in the country where this role is based?', answer: 'Yes' },
    { question: DV_SPONSORSHIP.toLowerCase(), answer: '' },
  ];
  assert.deepEqual(unmetConditionalFollowUpBlockers(blockers, dvDiscovered(), questions), []);
});

test('a required field that is genuinely independent is never touched', () => {
  /* Every one of these is a real blocker on a real packet, and none of them is an anaphor. Two are
   * consent-shaped, one is EEO-adjacent, one is a plain screener, and one is the employer's own
   * "is required" wording arriving as prose rather than as this repo's sentence. */
  const blockers = [
    '"Terms & Conditions" is required and is still empty',
    '"How did you hear about DV Trading?" is required and is still empty',
    '"I certify that all information I have provided in order to apply for this position with Akuna is true, complete, and acc" is required and is still empty',
    '"Are you legally authorized to work in the country where this role is based?" is required and is still empty',
    '"If applicable, which US state do you reside in?" is required and is still empty',
    '"If other, please explain" is required and is still empty',
    'CAPTCHA requires your attention',
  ];
  const discovered = [
    ...dvDiscovered(),
    { label: 'If applicable, which US state do you reside in? question_8954176005' },
    { label: 'If other, please explain question_8954182005' },
    {
      label: 'I certify that all information I have provided in order to apply for this position with '
        + 'Akuna is true, complete, and accurate.* question_67727976',
    },
  ];
  const questions = [
    { question: 'are you legally authorized to work in the country where this role is based?', answer: 'No' },
    { question: DV_SPONSORSHIP.toLowerCase(), answer: 'No' },
    { question: 'how did you hear about dv trading?', answer: '' },
  ];
  assert.deepEqual(unmetConditionalFollowUpBlockers(blockers, discovered, questions), []);
});

test('a label matching two discovered controls at once is refused rather than guessed at', () => {
  // Two "If yes, please explain" fields under two different gates. The blocker names only the
  // label, so nothing here can say which gate it belongs to.
  const discovered = [
    { label: 'Do you have a criminal record?* question_1' },
    { label: 'If yes, please provide further explanation below. question_2' },
    { label: 'Do you require an accommodation?* question_3' },
    { label: 'If yes, please provide further explanation below. question_4' },
  ];
  const questions = [
    { question: 'do you have a criminal record?', answer: 'No' },
    { question: 'do you require an accommodation?', answer: 'No' },
  ];
  assert.deepEqual(unmetConditionalFollowUpBlockers([SCALE_AI_BLOCKER], discovered, questions), []);
});

test('a blocker naming a field discovery never saw is refused rather than guessed at', () => {
  assert.deepEqual(unmetConditionalFollowUpBlockers([SCALE_AI_BLOCKER], [], scaleAiQuestions('No')), []);
});

test('the anaphor grammar reads the pointing clause and nothing else', () => {
  // Every conditional label on the three forms in the corpus.
  assert.equal(conditionalFollowUpPolarity('If yes, please provide further explanation below.'), 'yes');
  assert.equal(conditionalFollowUpPolarity('If yes, please provide your visa type and expiration date.'), 'yes');
  assert.equal(conditionalFollowUpPolarity('If yes, select your most recent proprietary trading firm experience'), 'yes');
  assert.equal(conditionalFollowUpPolarity(AKUNA_FOLLOW_UP), 'yes');
  assert.equal(conditionalFollowUpPolarity('If so, when?'), 'yes');
  assert.equal(conditionalFollowUpPolarity('If no, please explain why'), 'no');
  assert.equal(conditionalFollowUpPolarity('If not, when do you expect to graduate?'), 'no');
  assert.equal(conditionalFollowUpPolarity('If the answer above is yes, list the firms'), 'yes');

  // Conditionals whose condition is NOT the answer above. Each one keeps its blocker.
  assert.equal(conditionalFollowUpPolarity('If applicable, which US state do you reside in?'), null);
  assert.equal(conditionalFollowUpPolarity('If other, please explain'), null);
  assert.equal(conditionalFollowUpPolarity("If you selected 'Other', please list your University:"), null);
  assert.equal(conditionalFollowUpPolarity('If you have a current work authorization/status, when does it expire?'), null);
  assert.equal(conditionalFollowUpPolarity('If you have upcoming deadlines, please indicate which company'), null);
  assert.equal(conditionalFollowUpPolarity('If none of the above apply, write N/A'), null);
  assert.equal(conditionalFollowUpPolarity('If you selected self-describe, please specify your pronouns.'), null);

  // Not an opening clause at all, so not an anaphor.
  assert.equal(conditionalFollowUpPolarity('Please explain if yes'), null);
  assert.equal(conditionalFollowUpPolarity('Do you have prior experience? If yes, name the firm'), null);
  assert.equal(conditionalFollowUpPolarity(''), null);
});

test('a gating answer is read as negative only when the whole answer is one', () => {
  assert.equal(gatingAnswerPolarity('No'), 'no');
  assert.equal(gatingAnswerPolarity('no.'), 'no');
  assert.equal(gatingAnswerPolarity('Yes'), 'yes');
  // Affirmative may lead with its word: reading one only ever KEEPS a blocker.
  assert.equal(gatingAnswerPolarity('Yes, I will require sponsorship'), 'yes');
  // Negative may not, because reading one is what drops a blocker.
  assert.equal(gatingAnswerPolarity('No, I am not bound by any agreement'), null);
  assert.equal(gatingAnswerPolarity('Decline to self identify'), null);
  assert.equal(gatingAnswerPolarity('Prefer not to say'), null);
  assert.equal(gatingAnswerPolarity(''), null);
  assert.equal(gatingAnswerPolarity(undefined), null);
});

test('the readiness gate no longer reads a control’s own label as that control’s error', () => {
  /* The manufacturing site, pinned on the script's source because there is no DOM in this test
   * runner to drive it through. The sentences this whole module refuses were produced by the
   * managed runner's copy of this loop; this repo's copy carries the same defect and the same fix,
   * so the two cannot drift. */
  assert.match(
    READ_SUBMIT_READINESS_SCRIPT,
    /if \(element\.tagName === 'LABEL' && control\.id && element\.getAttribute\('for'\) === control\.id\) continue;/,
  );
  // The vocabulary that made an employer's question look like an employer's complaint is unchanged:
  // the fix is the structural test above, not a narrower word list.
  assert.match(READ_SUBMIT_READINESS_SCRIPT, /please \(\?:select\|enter\|complete\|choose\|provide\)/);
});
