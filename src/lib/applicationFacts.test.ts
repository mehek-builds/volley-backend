import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getTableColumns } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { application_profile } from '../db/schema';
import {
  classifyField,
  frozenJobEmployerContext,
  questionRequiresHumanAttention,
  refreshKnownQuestionAnswers,
  resolveKnownAnswer,
  sensitiveQuestionRequiresAttention,
  type ApplicationProfileLike,
} from './questionDiscovery';
import { resolveProfileField } from './profileFieldResolution';
import {
  APPLICATION_FACT_COLUMNS,
  factBoolean,
  factString,
  factStringList,
  isUndefinedColumnError,
} from './applicationFacts';

/* A query builder with no connection behind it. Only ever used to RENDER SQL, never to run it, so
 * these tests need no database. */
const mockDb = drizzle.mock();

/* Does a fact answered once in onboarding actually reach the control on a real employer form?
 *
 * That is the whole question, and it is not the same question as "is the value stored". PR #361
 * existed because a value sat in the database that the resolution path could not see, so every
 * case below drives the SAME path the submission runner drives - resolveProfileField, which calls
 * resolveKnownAnswer for the answer and then snaps it onto the control's real option list.
 *
 * LABELS ARE VERBATIM. Every question string here was copied out of spec._review on a production
 * packet for the owner account, lowercased the way discovery lowercases them, including the curly
 * apostrophes and the trailing Greenhouse handles. A test written against a tidied-up paraphrase
 * proves the paraphrase works.
 */

/** What the runner would actually put in the control, or null when nothing is filled. */
function filled(
  label: string,
  ap: ApplicationProfileLike,
  control: { inputType?: string; options?: string[]; context?: string } = {},
): string | null {
  return resolve(label, ap, control)?.value ?? null;
}

function resolve(
  label: string,
  ap: ApplicationProfileLike,
  control: { inputType?: string; options?: string[]; context?: string } = {},
) {
  return resolveProfileField(
    { label, inputType: control.inputType ?? 'text', options: control.options },
    ap,
    control.context,
  );
}

/**
 * A value was produced but it is not one of the control's choices, so nothing gets selected and the
 * required field is reported empty. This is the measured shape of several of the failures here, and
 * naming it keeps a test from reading as if the field were simply left alone.
 */
function selectsNothing(label: string, ap: ApplicationProfileLike, options: string[]): boolean {
  const resolved = resolve(label, ap, { inputType: 'select', options });
  return resolved !== null && resolved.matchedOption === false;
}

/** The reason the applicant is shown when a question is deliberately left for her. */
function heldFor(label: string, ap: ApplicationProfileLike, inputType = 'text', jdText?: string): string {
  const resolved = resolveKnownAnswer(label, inputType, ap, jdText);
  assert.ok(resolved && 'skipReason' in resolved, `expected "${label}" to be held, got ${JSON.stringify(resolved)}`);
  return resolved.skipReason;
}

const YES_NO = ['Yes', 'No'];

describe('stored application facts reach the control on the real employer question', () => {
  test('pronouns: Akuna, 2 postings, 9 packets', () => {
    const label = 'we care about addressing everyone correctly. add your personal pronouns below to share with the hiring team.';
    assert.equal(filled(label, { pronouns: 'she/her' }), 'she/her');
    // The same declaration snaps onto a closed list that capitalises differently.
    assert.equal(
      filled(label, { pronouns: 'she/her' }, { inputType: 'select', options: ['He/Him', 'She/Her', 'They/Them', 'Prefer not to say'] }),
      'She/Her',
    );
    // Prefer-not-to-say is a real declaration, not an absence, and must survive as one.
    assert.equal(
      filled(label, { pronouns: 'Prefer not to say' }, { inputType: 'select', options: ['He/Him', 'She/Her', 'Prefer not to say'] }),
      'Prefer not to say',
    );
    // The self-describe follow-up asks for the same fact in a second box.
    assert.equal(filled('if you selected self-describe, please specify your pronouns', { pronouns: 'she/her' }), 'she/her');
  });

  test('pronouns are never inferred and never guessed', () => {
    const label = 'we care about addressing everyone correctly. add your personal pronouns below to share with the hiring team.';
    // Nothing stored, and a profile full of adjacent facts that a looser rule could reach for.
    assert.match(
      heldFor(label, { full_name: 'Mehek Mandal', eeo_prefs: { gender: 'Female' } }),
      /pronouns question left for you/,
    );
    assert.equal(filled(label, { full_name: 'Mehek Mandal', eeo_prefs: { gender: 'Female' } }), null);
    // And no profile key claims the label, so no later rule can pick it up either.
    assert.equal(classifyField(label), null);
  });

  test('legal first name beats the resume name: Akuna, 2 postings, 7 packets', () => {
    const label = 'what is your legal first name? (please also ensure that you input your legal first name in the *first name* field above)';
    assert.equal(filled(label, { full_name: 'Mehek Mandal', legal_first_name: 'Meheka' }), 'Meheka');
    // Null legal name still falls back to the parse, which is the behaviour that already existed.
    assert.equal(filled(label, { full_name: 'Mehek Mandal' }), 'Mehek');
    assert.equal(
      filled('do you have a preferred name, other than the name indicated above? if yes, please indicate that name below',
        { full_name: 'Mehek Mandal', legal_first_name: 'Meheka', preferred_first_name: 'Mehek' }),
      'Mehek',
    );
  });

  test('high school graduation: Akuna 2 postings, IMC 1, and never the university date', () => {
    const akuna = 'to be considered for this role, you must have earned a high school diploma (or an equivalent degree). please confirm the month and year that most accurately reflects when you earned it.';
    const imc = 'when did you graduate from high school?';
    const ap: ApplicationProfileLike = {
      high_school_grad_date: 'June 2024',
      // The facts a catch-all previously reached for. One production packet answered the IMC
      // question "University of Southern California, Viterbi School of Engineering".
      school: 'University of Southern California, Viterbi School of Engineering',
      grad_date: 'May 2028',
      grad_year: 2028,
    };
    assert.equal(filled(akuna, ap), 'June 2024');
    assert.equal(filled(imc, ap), 'June 2024');
    assert.equal(
      filled(imc, ap, { inputType: 'select', options: ['Before 2020', '2021', '2022', '2023', '2024', '2025'] }),
      '2024',
    );
    // A bare yes/no confirmation is a Yes that the stored date is the evidence for.
    assert.equal(
      filled('please confirm that you have earned a high school diploma or an equivalent degree.', ap, { inputType: 'select', options: YES_NO }),
      'Yes',
    );
    // With nothing on file, neither shape is answered, and the university date is not substituted.
    for (const label of [akuna, imc]) {
      const reason = heldFor(label, { school: 'University of Southern California', grad_date: 'May 2028', grad_year: 2028 });
      assert.match(reason, /high school graduation question left for you/);
    }
  });

  test('prior applications resolve only against an exact declared employer target', () => {
    const labels = {
      akunaEver: 'have you ever applied to a full time or internship position with akuna in the past?',
      akunaRole: 'have you applied to this role at akuna previously?',
      imc: 'have you applied to this role or another role @imc within the last 12-18 months? as a reminder, if you have already applied you will not be reconsidered.',
      point72: 'have you previously applied to work at point72?',
    };
    // A complete empty declaration does not answer without exact packet-employer context.
    const none: ApplicationProfileLike = { prior_application_employers: [] };
    for (const [name, label] of Object.entries(labels)) {
      assert.match(heldFor(label, none), /prior application question left for you/, name);
    }
    const noneTyped = resolveKnownAnswer(
      labels.akunaEver,
      'select',
      none,
      frozenJobEmployerContext('Akuna Capital'),
    );
    assert.ok(noneTyped && 'skipReason' in noneTyped);
    // An exact named match answers Yes. Unrelated and help-text-tailed labels remain held.
    const applied: ApplicationProfileLike = { prior_application_employers: ['Akuna', 'Jane Street'] };
    const akunaContext = frozenJobEmployerContext('Akuna Capital');
    const appliedTyped = resolveKnownAnswer(labels.akunaEver, 'select', applied, akunaContext);
    assert.ok(appliedTyped && 'skipReason' in appliedTyped);
    assert.equal(filled(labels.akunaRole, applied, { inputType: 'select', options: YES_NO, context: akunaContext }), 'Yes');
    assert.equal(
      filled(labels.point72, applied, { inputType: 'select', options: YES_NO, context: frozenJobEmployerContext('Point72') }),
      'No',
    );
    assert.match(heldFor(labels.imc, applied), /prior application question left for you/);
  });

  /* ONLY HER OWN DECLARATION ANSWERS NO, AND LITOS' SEND LOG IS NOT HER DECLARATION.
   *
   * THIS BLOCK REPLACES ONE THAT ASSERTED THE OPPOSITE, and the replacement is the point. PR #500
   * read `submitted_application_companies: []` as a licence to answer "No". It is not one. That
   * column is built from this user's own generated_resumes rows (lib/duplicateApplication.ts), so
   * it knows nothing about an application she made herself, one she made before Litos existed, or
   * one she made through any other channel. Its silence is an absence of evidence, and an absence
   * of evidence is not evidence of absence.
   *
   * The IMC label below is the exact string off the live form on 2026-08-10, reminder sentence and
   * all, and that sentence is what makes the cost concrete: an applicant not selected this season
   * may only reapply in 2027. A wrong "No" there misstates her history to the employer AND pushes
   * through the exact duplicate the question exists to catch, and it went out unflagged, because
   * these labels are in neither NEVER_FILL_PATTERNS nor the attention set.
   *
   * `prior_application_employers` is the record that does answer: `[]` is her saying she has
   * applied nowhere, and a list that does not name this employer is her saying she has not applied
   * here. `undefined` is "never asked" and holds.
   */
  const IMC_PRIOR_APPLICATION_LABEL = 'Have you applied to this role or another role @IMC within the last 12-18 months? '
    + 'As a reminder, if you have already applied for this position during the current recruitment season and were not '
    + 'selected, you may reapply when the next recruitment season begins in 2027.';

  const PLAIN_PRIOR_APPLICATION_LABELS = [
    'Have you previously applied to this company?',
    'Have you applied to us before?',
  ];

  test('an empty Litos send log does not answer a company-scoped prior-application question', () => {
    const imc = frozenJobEmployerContext('IMC');
    const nothingSent: ApplicationProfileLike = { submitted_application_companies: [] };

    for (const label of [
      IMC_PRIOR_APPLICATION_LABEL,
      // Discovery lowercases every label it captures, so this is the spelling that actually arrives.
      IMC_PRIOR_APPLICATION_LABEL.toLowerCase(),
      ...PLAIN_PRIOR_APPLICATION_LABELS,
    ]) {
      const resolved = resolveKnownAnswer(label, 'text', nothingSent, imc);
      assert.ok(resolved && 'skipReason' in resolved, `${label} -> ${JSON.stringify(resolved)}`);
      assert.match(resolved.skipReason, /prior application question left for you/, label);
      // Held by the missing declaration, NOT by the compound refusal the live label used to hit:
      // the reminder sentence is still stripped and the label is still read as one question.
      assert.doesNotMatch(resolved.skipReason, /compound application question/, label);
    }
    // Nothing reaches the control, so the employer gets a blank she fills rather than a claim.
    assert.equal(
      filled(IMC_PRIOR_APPLICATION_LABEL, nothingSent, { inputType: 'select', options: YES_NO, context: imc }),
      null,
    );

    // Nothing read at all is held for the same reason, and for the same reason it always was.
    const unread = heldFor(IMC_PRIOR_APPLICATION_LABEL, {}, 'text', imc);
    assert.match(unread, /prior application question left for you/);
    assert.doesNotMatch(unread, /compound application question/);
  });

  /* WHY THIS FAMILY IS NOT IN THE ATTENTION SET, WHICH IS A CHOICE AND NOT AN OVERSIGHT.
   *
   * The obvious second repair is to add these labels to NEVER_FILL_PATTERNS, or to the set
   * isRefusedQuestion reads, so that a prior-application answer always stops the packet for review.
   * Both were considered and both are worse than the hold.
   *
   * The attention machinery is a SEND BLOCK, not a nudge: sensitiveQuestionRequiresAttention flags
   * whenever the resolver's own value does not equal the answer on the packet, the final-approval
   * route turns that into a 422, and it has no exemption for an answer the applicant reviewed
   * herself. After this fix the resolver has no value for exactly the accounts that must answer by
   * hand, so the flag would fire on her own typed answer and there would be no way to clear it
   * short of filling an onboarding column. That converts "one question she answers herself" into
   * "an application she cannot send", which is a bigger harm than the one being fixed.
   *
   * What replaces the flag is that Litos now writes nothing at all here, and takes back what it
   * wrote before: an unsupported answer is blanked on the next refresh, a blank required answer
   * already stops final approval on its own, and answer reuse has vetoed this family since it
   * shipped (Veto 3 in lib/answerReuse.ts), so no "No" can arrive from another posting either.
   */
  test('a held prior-application question is blanked rather than flagged, and her declaration still travels', () => {
    const imc = frozenJobEmployerContext('IMC');
    const nothingSent: ApplicationProfileLike = { submitted_application_companies: [] };

    assert.equal(questionRequiresHumanAttention({ question: IMC_PRIOR_APPLICATION_LABEL, answer: '' }), false);
    assert.equal(questionRequiresHumanAttention({ question: IMC_PRIOR_APPLICATION_LABEL, answer: 'No' }), false);
    assert.equal(
      sensitiveQuestionRequiresAttention(IMC_PRIOR_APPLICATION_LABEL, 'No', 'text', nothingSent, imc),
      false,
    );

    // The answer PR #500 would have shipped is withdrawn from the packet rather than sent.
    assert.deepEqual(
      refreshKnownQuestionAnswers([{ question: IMC_PRIOR_APPLICATION_LABEL, answer: 'No' }], nothingSent, imc),
      [{ question: IMC_PRIOR_APPLICATION_LABEL, answer: '' }],
    );
    // And an account that filled the onboarding column is not held up by any of this.
    assert.deepEqual(
      refreshKnownQuestionAnswers(
        [{ question: IMC_PRIOR_APPLICATION_LABEL, answer: '' }],
        { prior_application_employers: [] },
        imc,
      ),
      [{ question: IMC_PRIOR_APPLICATION_LABEL, answer: 'No' }],
    );
  });

  test('an explicit declaration that she has applied nowhere answers No', () => {
    const imc = frozenJobEmployerContext('IMC');
    const declaredNone: ApplicationProfileLike = { prior_application_employers: [] };

    for (const label of [
      IMC_PRIOR_APPLICATION_LABEL,
      IMC_PRIOR_APPLICATION_LABEL.toLowerCase(),
      ...PLAIN_PRIOR_APPLICATION_LABELS,
    ]) {
      assert.deepEqual(resolveKnownAnswer(label, 'text', declaredNone, imc), { value: 'No' }, label);
    }
    // And it reaches a real yes/no control rather than producing a value nothing can select.
    assert.equal(
      filled(IMC_PRIOR_APPLICATION_LABEL, declaredNone, { inputType: 'select', options: YES_NO, context: imc }),
      'No',
    );
    // A declared list that does not name this employer says the same thing about this employer.
    for (const label of PLAIN_PRIOR_APPLICATION_LABELS) {
      assert.deepEqual(
        resolveKnownAnswer(label, 'text', { prior_application_employers: ['Akuna'] }, imc),
        { value: 'No' },
        label,
      );
    }
    // Her declaration stands whether or not Litos ever read its own send history.
    assert.deepEqual(
      resolveKnownAnswer('Have you applied to us before?', 'text',
        { prior_application_employers: [], submitted_application_companies: [] }, imc),
      { value: 'No' },
    );
  });

  test('a submitted application to that same company hands the question back, and never answers Yes', () => {
    const imc = frozenJobEmployerContext('IMC');
    const sentToImc: ApplicationProfileLike = { submitted_application_companies: ['IMC'] };

    /* NOT "Yes". The label asks about a 12-18 month window and about "this role or another role",
     * and a list of employers settles neither. Those rows also include sends that were pressed and
     * lost, which the employer may never have received (submittedApplicationCompanies in
     * lib/duplicateApplication.ts), so a "Yes" off one of them is as much a false statement as the
     * "No" this rule exists to stop. A wrong Yes costs her the same as a wrong No. */
    const held = resolveKnownAnswer(IMC_PRIOR_APPLICATION_LABEL, 'text', sentToImc, imc);
    assert.ok(held && 'skipReason' in held, JSON.stringify(held));
    assert.match(held.skipReason, /prior application question left for you/);
    // Held by the evidence, not by the compound refusal it used to fall into on the live form.
    assert.doesNotMatch(held.skipReason, /compound application question/);
    assert.equal(
      filled(IMC_PRIOR_APPLICATION_LABEL, sentToImc, { inputType: 'select', options: YES_NO, context: imc }),
      null,
    );
    // The plain forms are withdrawn by the same evidence.
    assert.match(heldFor('Have you applied to us before?', sentToImc, 'text', imc), /prior application question/);

    /* THE SEND LOG WITHDRAWS AN ANSWER SHE WOULD OTHERWISE GET, and that is its whole job here.
     * Her declared list was taken at onboarding and a send came after it, so a packet already at
     * this employer stops the declaration answering rather than contradicting it. */
    const declaredElsewhere: ApplicationProfileLike = { prior_application_employers: ['Akuna'] };
    const withdrawn = resolveKnownAnswer('Have you previously applied to this company?', 'text',
      { ...declaredElsewhere, submitted_application_companies: ['IMC'] }, imc);
    assert.ok(withdrawn && 'skipReason' in withdrawn, JSON.stringify(withdrawn));
    assert.match(withdrawn.skipReason, /prior application question left for you/);

    /* COMPANY IDENTITY IS EXACT, on the duplicate guard's own folding of job_context.company. A
     * submitted application to a similarly-named but different company withdraws nothing: if it
     * did, the near-miss would take away an answer her own declaration supports.
     *
     * Asserted on a label with NO trailing sentence, deliberately. IMC's real label carries one, and
     * a removed sentence withdraws every answer that rests on a positive record wherever it sits -
     * so on that label these would hold for a reason that has nothing to do with company identity,
     * and the assertion would prove nothing about the rule it is named for. */
    const bare = 'Have you previously applied to this company?';
    // The exception itself, with nothing else in play: a submitted IMC application holds it.
    assert.match(heldFor(bare, sentToImc, 'text', imc), /prior application question left for you/);
    for (const other of ['IMC Trading', 'Imcorp', 'IMC Health']) {
      assert.deepEqual(
        resolveKnownAnswer(bare, 'text', { ...declaredElsewhere, submitted_application_companies: [other] }, imc),
        { value: 'No' },
        other,
      );
      // And with nothing declared the near miss changes nothing either: the question was already
      // hers to answer, because no record on file speaks to her own applications.
      const undeclared = resolveKnownAnswer(bare, 'text', { submitted_application_companies: [other] }, imc);
      assert.ok(undeclared && 'skipReason' in undeclared, `${other} -> ${JSON.stringify(undeclared)}`);
    }
  });

  /* A REMOVED SENTENCE IS AN UNKNOWN SCOPE, AND NO VOCABULARY DECIDES OTHERWISE.
   *
   * PR #500 blocked here twice. The first attempt read nothing about the sentence and answered "Yes"
   * off a declared "IMC" to a label whose only restriction it had just discarded. The second sorted
   * tails with five closed word classes, and failed both ways at once: a WIDENING tail was correctly
   * detected and then ignored on the No path, and every phrasing outside the alternation - "we
   * disregard applications made before 2024", "internship applications are a separate process" -
   * went straight back to "Yes". A list over surface forms fails closed on false positives and OPEN
   * on false negatives, and open is the direction that puts a false statement on an application.
   *
   * So the rule reads the RECORDS instead of the words. A removed sentence means never Yes, and No
   * only where there is no positive record of any application to any employer at all. With zero
   * records there is nothing for a restatement to bring into or out of scope, so No is true under
   * every narrowing, widening, window and group-entity rewording. The tails below are deliberately
   * a mix of all four kinds, and not one of them is inspected by the code they exercise.
   */
  const NARROWING_TAILS = [
    'Note this refers only to internship applications.',
    'Please note that you must also confirm you were not terminated for cause.',
    'Note we disregard applications made before 2024.',
    'Note we ignore internship applications.',
    'Note that for the purposes of this question, internships are separate.',
    'Note this does not concern internship applications.',
    'Note applications beyond 12 months ago are disregarded.',
    'Note internship applications are a separate process.',
  ];
  const WIDENING_TAILS = [
    'Note that this refers to applications to any employer.',
    'Please note that applications to any IMC group entity also count.',
    'Note this includes our subsidiaries.',
  ];
  const SCOPE_RESTATING_TAILS = [...NARROWING_TAILS, ...WIDENING_TAILS];
  const questionWith = (tail: string) => `Have you applied to a role at IMC? ${tail}`;

  test('a stripped help-text tail never produces Yes, whatever the sentence said', () => {
    const imc = frozenJobEmployerContext('IMC');
    for (const tail of SCOPE_RESTATING_TAILS) {
      const label = questionWith(tail);
      /* Her declared list names IMC. That proves she applied to IMC and cannot prove the
       * application falls inside whatever the sentence said, so the question is hers. */
      for (const ap of [
        { prior_application_employers: ['IMC'] },
        { prior_application_employers: ['IMC'], submitted_application_companies: [] },
        { prior_application_employers: ['IMC'], submitted_application_companies: ['IMC'] },
      ] satisfies ApplicationProfileLike[]) {
        const resolved = resolveKnownAnswer(label, 'text', ap, imc);
        assert.ok(resolved && 'skipReason' in resolved, `${tail} -> ${JSON.stringify(resolved)}`);
        assert.match(resolved.skipReason, /prior application question left for you/, tail);
      }
      // Global scope is restated by the same sentence and withdrawn for the same reason.
      const global = resolveKnownAnswer(`Have you ever applied for a job before? ${tail}`, 'text',
        { prior_application_employers: ['IMC'] }, imc);
      assert.ok(global && 'skipReason' in global, `${tail} -> ${JSON.stringify(global)}`);
    }
  });

  test('a stripped tail answers No only with no positive record anywhere, not merely none here', () => {
    const imc = frozenJobEmployerContext('IMC');
    for (const tail of SCOPE_RESTATING_TAILS) {
      const label = questionWith(tail);

      /* THE FINDING THAT BLOCKED THE SECOND ATTEMPT. A record for a DIFFERENT employer is exactly
       * what a widening tail brings into scope, so "none for IMC" is not enough to answer. Both
       * records are read for their content, not for this company. */
      for (const ap of [
        { submitted_application_companies: ['Jane Street'] },
        { submitted_application_companies: ['IMC Trading Services'] },
        { prior_application_employers: ['Akuna'] },
        { prior_application_employers: ['Akuna'], submitted_application_companies: [] },
      ] satisfies ApplicationProfileLike[]) {
        const resolved = resolveKnownAnswer(label, 'text', ap, imc);
        assert.ok(resolved && 'skipReason' in resolved, `${tail} / ${JSON.stringify(ap)} -> ${JSON.stringify(resolved)}`);
      }
      // Neither record read is not the same as both records empty.
      const unread = resolveKnownAnswer(label, 'text', {}, imc);
      assert.ok(unread && 'skipReason' in unread, `${tail} -> ${JSON.stringify(unread)}`);
    }
  });

  test('a scope-restating tail does not narrow her declared No, because that No survives every restatement', () => {
    const imc = frozenJobEmployerContext('IMC');
    /* THE REGRESSION GUARD FOR THE WRONG REPAIR. Refusing to strip a restating tail would put every
     * one of these back in the compound refusal. Her declared `[]` is a statement that the set of
     * applications is empty, and there is nothing for a narrowing or a widening to act on in an
     * empty set, so No is true under all four kinds of restatement. */
    for (const tail of SCOPE_RESTATING_TAILS) {
      for (const ap of [
        { prior_application_employers: [] },
        { prior_application_employers: [], submitted_application_companies: [] },
      ] satisfies ApplicationProfileLike[]) {
        assert.deepEqual(
          resolveKnownAnswer(questionWith(tail), 'text', ap, imc),
          { value: 'No' },
          `${tail} / ${JSON.stringify(ap)}`,
        );
      }
      /* AND THE SEND LOG DOES NOT STAND IN FOR THAT DECLARATION, here least of all. A widening tail
       * is exactly the case where an application Litos never sent is the one that counts, so an
       * empty send log with nothing declared holds rather than answering. */
      const sendLogOnly = resolveKnownAnswer(questionWith(tail), 'text', { submitted_application_companies: [] }, imc);
      assert.ok(sendLogOnly && 'skipReason' in sendLogOnly, `${tail} -> ${JSON.stringify(sendLogOnly)}`);
      assert.match(sendLogOnly.skipReason, /prior application question left for you/, tail);
    }
    // And with no tail at all nothing above applies: the ordinary rules answer as they always did.
    assert.deepEqual(
      resolveKnownAnswer('Have you applied to a role at IMC?', 'text', { prior_application_employers: ['IMC'] }, imc),
      { value: 'Yes' },
    );
    assert.deepEqual(
      resolveKnownAnswer('Have you applied to a role at IMC?', 'text', { prior_application_employers: ['Akuna'] }, imc),
      { value: 'No' },
    );
    // IMC's real tail is removed like any other, and her declaration answers through it.
    assert.deepEqual(
      resolveKnownAnswer(IMC_PRIOR_APPLICATION_LABEL, 'text', { prior_application_employers: [] }, imc),
      { value: 'No' },
    );
  });

  /* THE SEND LOG WITHDRAWS ON THIS EMPLOYER, NOT ON EVERY EMPLOYER. Measured on the owner account
   * on 2026-08-12, on the live IMC packet fc6eade3.
   *
   * She had declared `[]` - applied nowhere - and Litos' send log held exactly two companies,
   * Cresta and kos.ai, and nothing at IMC. The stripped-tail branch read both records GLOBALLY, so
   * two applications to unrelated companies withdrew an answer that both records agree on and IMC's
   * required question was handed back. The same label with the reminder sentence removed answered
   * "No" off the same profile through the ordinary rules, which is what makes this a defect rather
   * than a stricter reading: one employer appending help text should not change what her records
   * say about that employer.
   */
  test('a send to another company does not withdraw the declared No for this one', () => {
    const imc = frozenJobEmployerContext('IMC');
    // Production shape, verbatim: prior_application_employers `[]`, send log Cresta and kos.ai.
    const owner: ApplicationProfileLike = {
      prior_application_employers: [],
      submitted_application_companies: ['cresta', 'kos.ai'],
    };
    assert.deepEqual(resolveKnownAnswer(IMC_PRIOR_APPLICATION_LABEL, 'text', owner, imc), { value: 'No' });
    // Discovery lowercases every label it captures, so this is the spelling that actually arrives.
    assert.deepEqual(
      resolveKnownAnswer(IMC_PRIOR_APPLICATION_LABEL.toLowerCase(), 'text', owner, imc),
      { value: 'No' },
    );
    // And it reaches the real yes/no control rather than producing a value nothing can select.
    assert.equal(
      filled(IMC_PRIOR_APPLICATION_LABEL, owner, { inputType: 'select', options: YES_NO, context: imc }),
      'No',
    );
    assert.equal(questionRequiresHumanAttention({ question: IMC_PRIOR_APPLICATION_LABEL, answer: 'No' }), false);

    /* AND A SUBMITTED APPLICATION TO THIS COMPANY STILL HANDS IT BACK, which is the half of the old
     * rule that was right. Those rows carry no window and no role scope, so they cannot support a
     * "Yes" either - the send log withdraws an answer, it never adds one. */
    for (const sent of [['IMC'], ['cresta', 'IMC'], ['IMC', 'kos.ai']]) {
      const ap: ApplicationProfileLike = {
        prior_application_employers: [], submitted_application_companies: sent,
      };
      const held = resolveKnownAnswer(IMC_PRIOR_APPLICATION_LABEL, 'text', ap, imc);
      assert.ok(held && 'skipReason' in held, `${JSON.stringify(sent)} -> ${JSON.stringify(held)}`);
      assert.match(held.skipReason, /prior application question left for you/);
      assert.doesNotMatch(held.skipReason, /compound application question/);
      assert.notEqual(
        filled(IMC_PRIOR_APPLICATION_LABEL, ap, { inputType: 'select', options: YES_NO, context: imc }),
        'Yes',
        JSON.stringify(sent),
      );
    }

    /* NOTHING ELSE IN THE BRANCH MOVES. Only her own `[]` answers: a declared list with anything in
     * it cannot be shown to fall inside whatever the removed sentence said, and an unread column is
     * still "never asked". Both hold however empty the send log is. */
    for (const ap of [
      { prior_application_employers: ['Akuna'], submitted_application_companies: [] },
      { prior_application_employers: ['IMC'], submitted_application_companies: [] },
      { submitted_application_companies: [] },
      {},
    ] satisfies ApplicationProfileLike[]) {
      const resolved = resolveKnownAnswer(IMC_PRIOR_APPLICATION_LABEL, 'text', ap, imc);
      assert.ok(resolved && 'skipReason' in resolved, `${JSON.stringify(ap)} -> ${JSON.stringify(resolved)}`);
    }
  });

  test('the prior-application rule is company-scoped, and reaches nothing else', () => {
    const imc = frozenJobEmployerContext('IMC');
    const nothingSent: ApplicationProfileLike = { submitted_application_companies: [] };

    /* EMPLOYMENT HISTORY IS UNTOUCHED, and this is the one that matters most. "Have you ever worked
     * for Redwood Materials?" is in this account's data and is about having been EMPLOYED. It keeps
     * priorEmployerAnswer's handling - Yes from a positive record, silence otherwise, never a No off
     * a record measured not to be exhaustive - and this rule must never be what answers it. */
    for (const label of [
      'Have you ever worked for Redwood Materials?',
      'Have you previously been employed by IMC?',
    ]) {
      const resolved = resolveKnownAnswer(label, 'text', nothingSent, frozenJobEmployerContext('Redwood Materials'));
      assert.ok(resolved && 'skipReason' in resolved, `${label} -> ${JSON.stringify(resolved)}`);
      assert.match(resolved.skipReason, /prior employer or program question left for you/, label);
      assert.doesNotMatch(resolved.skipReason, /prior application/, label);
    }
    for (const label of [
      'Are you a former employee of IMC?',
      'Do you have a relative employed at IMC?',
      'Are you eligible for rehire at IMC?',
    ]) {
      const resolved = resolveKnownAnswer(label, 'text', nothingSent, imc);
      assert.equal(resolved === null || !('value' in resolved), true, `${label} -> ${JSON.stringify(resolved)}`);
    }

    // A DIFFERENT company from the one being applied to. Nothing on file scopes to Point72, and the
    // IMC evidence says nothing about it, so it stays with the applicant.
    const elsewhere = resolveKnownAnswer('Have you previously applied to work at Point72?', 'text', nothingSent, imc);
    assert.ok(elsewhere && 'skipReason' in elsewhere, JSON.stringify(elsewhere));

    // "When" and "how many times" are not yes/no questions and this rule may not reach them.
    for (const label of ['When did you last apply to IMC?', 'How many times have you applied to IMC?']) {
      const resolved = resolveKnownAnswer(label, 'text', nothingSent, imc);
      assert.equal(resolved === null || !('value' in resolved), true, `${label} -> ${JSON.stringify(resolved)}`);
    }

    // Referral, sponsorship and the consent gates keep their own answers and their own refusals.
    assert.match(
      heldFor('Were you referred by an IMC employee?', nothingSent, 'text', imc),
      /how you heard about this role is yours to answer/,
    );
    assert.match(
      heldFor('Will you now or in the future require sponsorship for employment visa status?', nothingSent, 'text', imc),
      /work-eligibility question left for you/,
    );
    assert.match(heldFor('privacy statement', nothingSent, 'checkbox', imc), /privacy notice/);

    // A genuine compound tail is still compound. The reminder sentence is employer help text; an
    // instruction after it is a second thing being asked, and it holds the whole label.
    const compound = resolveKnownAnswer(`${IMC_PRIOR_APPLICATION_LABEL} Please explain why.`, 'text', nothingSent, imc);
    assert.ok(compound && 'skipReason' in compound, JSON.stringify(compound));
    assert.match(compound.skipReason, /compound application question/);

    // Global history is not company-scoped, so the company-scoped evidence does not answer it.
    assert.match(
      heldFor('Have you ever applied for a job before?', nothingSent, 'text', imc),
      /prior application question left for you/,
    );
  });

  test('an unanswered application history is held, not drafted into a claim', () => {
    // A production packet carried a 600-word essay opening "I have not applied to Akuna in the
    // past" - a statement about her history that nothing on file supported. Undefined must stop
    // the resolver here so it never reaches the drafter.
    const reason = heldFor('have you ever applied to a full time or internship position with akuna in the past?', {});
    assert.match(reason, /prior application question left for you/);
    // Declared history but an employer the label does not name: still held rather than guessed.
    assert.match(
      heldFor('have you previously applied to this employer?', { prior_application_employers: ['Akuna Capital'] }),
      /prior application question left for you/,
    );
  });

  test('outstanding offers and deadlines: 5 postings, 5 companies', () => {
    const labels = [
      'do you have any offer deadlines that we should be aware of?',           // Akuna
      'are you holding any outstanding offers?',                                // Five Rings
      'do you currently have any offers?',                                      // IMC
      'do you have any outstanding offers or deadlines?',                       // Virtu
      'do you currently have an offer? if so, what is your deadline to make a decision by',  // Tower
    ];
    for (const label of labels) {
      assert.equal(filled(label, { has_outstanding_offers: false }, { inputType: 'select', options: YES_NO }), 'No', label);
      assert.match(heldFor(label, {}), /offer question left for you/, label);
    }
    // Tower asks for the deadline in the same box, so the stored detail is what goes in it.
    assert.equal(
      filled(labels[4], { has_outstanding_offers: true, outstanding_offer_details: 'One offer from Optiver, decision due 1 December 2026.' }),
      'One offer from Optiver, decision due 1 December 2026.',
    );
    // A plain yes/no control still gets a yes/no.
    assert.equal(
      filled(labels[2], { has_outstanding_offers: true, outstanding_offer_details: 'One offer from Optiver.' }, { inputType: 'select', options: YES_NO }),
      'Yes',
    );
  });

  test('military service: Point72 asks a required yes/no with no decline option', () => {
    const label = 'have you served in the military?';
    // The measured failure: with nothing stored this resolves through the EEO path to "Decline to
    // self-identify", which is not one of Point72's choices, so the required field stayed empty.
    assert.equal(selectsNothing(label, {}, YES_NO), true);
    // With the declaration on file it selects a real option.
    assert.equal(filled(label, { military_service: 'No' }, { inputType: 'select', options: YES_NO }), 'No');
    assert.equal(resolve(label, { military_service: 'No' }, { inputType: 'select', options: YES_NO })?.matchedOption, true);
    assert.equal(filled(label, { military_service: 'Yes' }, { inputType: 'select', options: YES_NO }), 'Yes');
    // A voluntary self-identification block still belongs to eeo_prefs, whose wording was written
    // against that block's own option list.
    const eeoLabel = 'are you a veteran or active member of the united states armed forces?';
    assert.equal(
      filled(eeoLabel, { military_service: 'No', eeo_prefs: { veteran_status: 'I am not a protected veteran' } }),
      'I am not a protected veteran',
    );
    // With no EEO wording on file, the declaration answers it rather than declining into a
    // list that may not offer a decline.
    assert.equal(filled(eeoLabel, { military_service: 'No' }, { inputType: 'select', options: YES_NO }), 'No');
  });

  test('military service is a declaration, never inferred from citizenship or address', () => {
    const ap: ApplicationProfileLike = { citizenship: 'Indian', address_country: 'United Arab Emirates', address_city: 'Dubai' };
    // Nothing about where she lives or holds a passport may become a yes or a no here.
    assert.notEqual(filled('have you served in the military?', ap, { inputType: 'select', options: YES_NO }), 'Yes');
    assert.notEqual(filled('have you served in the military?', ap, { inputType: 'select', options: YES_NO }), 'No');
    assert.equal(selectsNothing('have you served in the military?', ap, YES_NO), true);
  });

  test('politically exposed person: Tower, and the "Dubai" defect', () => {
    const self = 'are you or have you been entrusted with a position or function in any government, international organization (such as the un or world bank), or state-owned enterprise?';
    const family = 'are you an immediate family member of someone holding such a position? an immediate family member is a parent, sibling, spouse or domestic partner, child, or in-law.';
    const withAddress: ApplicationProfileLike = { address_city: 'Dubai', address_state: 'Dubai', address_country: 'United Arab Emirates' };

    /* THE REGRESSION THIS FILE EXISTS FOR. On 2026-08-06 the live answer to the first label was
     * "Dubai": classifyField's `\b(state|province)\b` residence rule matched the word "state"
     * inside "state-owned enterprise". Both assertions below fail if anything of that shape comes
     * back - the classifier no longer claims the label at all, and the resolver refuses it. */
    assert.equal(classifyField(self), null);
    assert.equal(classifyField(family), null);
    assert.equal(filled(self, withAddress), null);
    assert.equal(filled(family, withAddress), null);
    assert.match(heldFor(self, withAddress), /politically-exposed-person declaration left for you/);
    assert.match(heldFor(family, withAddress), /politically-exposed-person declaration left for you/);

    // From an explicit declaration, and the two questions keep their two separate answers.
    const declared: ApplicationProfileLike = {
      ...withAddress,
      politically_exposed: 'No',
      politically_exposed_family: 'Yes',
    };
    assert.equal(filled(self, declared, { inputType: 'select', options: YES_NO }), 'No');
    assert.equal(filled(family, declared, { inputType: 'select', options: YES_NO }), 'Yes');
    // "Prefer not to say" survives where the form offers it.
    assert.equal(
      filled(self, { ...withAddress, politically_exposed: 'Prefer not to say' }, { inputType: 'select', options: [...YES_NO, 'Prefer not to say'] }),
      'Prefer not to say',
    );
  });

  test('an ordinary state-of-residence question is still answered from the address', () => {
    // The PEP guard must not cost the rule it protects: a real residence question keeps working.
    assert.equal(classifyField('state / province'), 'address_state');
    assert.equal(filled('state / province', { address_state: 'Dubai' }), 'Dubai');
  });

  test('further education plans: Akuna 2 postings, Five Rings, IMC (4 postings, 3 companies)', () => {
    const plan = 'are you considering or committed to pursuing further education immediately after completing your current academic studies?';
    const type = 'if so, please specify the type of degree you plan to pursue.';
    const mastersDate = 'if you are an undergraduate considering a master’s degree following graduation, when is your potential master’s graduation date?';
    const undergraduate: ApplicationProfileLike = { grad_date: 'May 2028', grad_year: 2028, degree: 'Bachelor of Science in Computer Science' };

    /* The measured wrong answer: "May 2028", her UNDERGRADUATE graduation date, given to a question
     * about a master's degree she has not said she is doing. */
    assert.equal(filled(mastersDate, undergraduate), null);
    assert.match(heldFor(mastersDate, undergraduate), /further-education question left for you/);

    assert.equal(filled(plan, { ...undergraduate, advanced_study_plan: 'no' }, { inputType: 'select', options: YES_NO }), 'No');
    assert.equal(filled(plan, { ...undergraduate, advanced_study_plan: 'considering' }, { inputType: 'select', options: YES_NO }), 'Yes');
    assert.equal(filled(plan, { ...undergraduate, advanced_study_plan: 'committed' }, { inputType: 'select', options: YES_NO }), 'Yes');
    assert.equal(filled(mastersDate, { ...undergraduate, advanced_study_plan: 'no' }), 'N/A');
    assert.equal(filled(type, { ...undergraduate, advanced_study_plan: 'no' }), 'N/A');
    assert.match(heldFor(plan, undergraduate), /further-education question left for you/);
  });

  test('truthfulness certification remains scoped to the exact application', () => {
    const label = 'i certify that all information i have provided in order to apply for this position with akuna is true, complete, and accurate.';
    assert.equal(filled(label, { attest_truthful_information: true }, { inputType: 'checkbox', options: YES_NO }), null);
    assert.match(heldFor(label, { attest_truthful_information: true }), /certification that your information is true/);
    assert.equal(filled(label, {}), null);
    assert.match(heldFor(label, {}), /certification that your information is true/);
    // Explicitly declined reads the same as never asked: not ticked.
    assert.equal(filled(label, { attest_truthful_information: false }), null);
  });

  test('privacy acknowledgements remain scoped to each employer notice', () => {
    const labels = ['privacy policy acknowledgement', 'privacy statement', 'privacy'];
    for (const label of labels) {
      assert.equal(filled(label, { accept_privacy_notices: true }, { inputType: 'checkbox', options: YES_NO }), null, label);
      assert.match(heldFor(label, { accept_privacy_notices: true }, 'checkbox'), /privacy notice/, label);
      assert.equal(filled(label, {}), null, label);
      assert.match(heldFor(label, {}, 'checkbox'), /privacy notice/, label);
    }
  });

  test('no stored consent unlocks a commitment that is neither truthfulness nor privacy', () => {
    const everything: ApplicationProfileLike = { attest_truthful_information: true, accept_privacy_notices: true };
    const exclusivity = 'by submitting this application and answering “yes” below, i acknowledge that this role is my top preference and i will not be considered for other tech and/or quant roles at akuna for this recruiting season.';
    assert.equal(filled(exclusivity, everything), null);
    assert.match(heldFor(exclusivity, everything), /which roles you will be considered for/);

    const conduct = 'interview code of conduct';
    assert.equal(filled(conduct, everything), null);
    assert.match(heldFor(conduct, everything, 'checkbox'), /code of conduct/);
  });
});

describe('the reader survives the migration not having run', () => {
  test('every fact column reads as "never asked" when it is absent from the row', () => {
    // Exactly what selectApplicationProfileRow's fallback hands back: the established columns, and
    // nothing at all for the new ones.
    const legacyRow = { user_id: 'u', phone: '+971500000000' } as never;
    for (const column of APPLICATION_FACT_COLUMNS) {
      assert.equal(factString(legacyRow, column), undefined, column);
      assert.equal(factBoolean(legacyRow, column), undefined, column);
      assert.equal(factStringList(legacyRow, column), undefined, column);
    }
    // And "never asked" is what makes the resolver hold the question rather than answer it.
    assert.match(heldFor('privacy statement', {}, 'checkbox'), /privacy notice/);
  });

  test('an empty declared list is preserved, because it is an answer', () => {
    const row = { user_id: 'u', prior_application_employers: [] } as never;
    assert.deepEqual(factStringList(row, 'prior_application_employers'), []);
    // It remains distinguishable in storage without authorizing arbitrary target extraction.
    assert.match(
      heldFor('have you previously applied to work at point72?', { prior_application_employers: [] }),
      /prior application question left for you/,
    );
  });

  /* THE GUARD THAT COULD NOT FIRE, pinned so nobody builds it again.
   *
   * A retry used to sit in upsertApplicationProfile that stripped the fact columns out of the
   * payload object and wrote a second time, promising that an unmigrated database would still save
   * the established fields. It could never work: Drizzle names EVERY declared column in the emitted
   * INSERT and fills the omitted ones with `default`, so removing a key from the payload does not
   * remove the column from the SQL. The retry raised the identical 42703 and threw.
   *
   * This test renders the SQL and asserts that property directly. If a future ORM upgrade ever makes
   * an insert's column list follow its payload, this test fails and the retry becomes buildable
   * again - which is the only condition under which it should be. Until then the migration is a
   * hard prerequisite for writes, and that is stated rather than papered over.
   */
  test('an insert names every declared column, so a payload-stripping retry cannot help', () => {
    const dialect = new PgDialect();
    const sqlFor = (payload: Record<string, unknown>) => dialect.sqlToQuery(
      mockDb
        .insert(application_profile)
        .values({ user_id: '00000000-0000-4000-8000-000000000001', ...payload })
        .onConflictDoUpdate({ target: application_profile.user_id, set: payload })
        .getSQL(),
    ).sql;

    const full = sqlFor({ address_city: 'Dubai', major: 'CS', standardized_test_type: 'SAT' });
    assert.ok(full.includes('standardized_test_type'), 'the column is named when it is in the payload');

    // The payload a stripping retry would have produced. The column is STILL in the SQL.
    const stripped = sqlFor({ address_city: 'Dubai', major: 'CS' });
    assert.ok(
      stripped.includes('standardized_test_type'),
      'removing the key does not remove the column, which is why the retry was deleted',
    );
  });

  test('the write path exposes no partial-save flag, because there is no partial save', async () => {
    const source = await readFile('src/lib/applicationFacts.ts', 'utf8');
    // Comments stripped: the removal is documented at length in this file, and the point of the
    // assertion is that no CODE reaches for the helpers again, not that the history goes unwritten.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /droppedFactColumns/);
    assert.doesNotMatch(code, /withoutFactColumns/);
    assert.doesNotMatch(code, /mayRetryWithoutFactColumns/);
    // The prerequisite itself must stay written down, in the comments this time.
    assert.match(source, /MIGRATION FIRST, THEN MERGE/);
  });

  /* THE FALLBACK ONLY FIRES IF THE ERROR IS RECOGNISED, and for the whole life of this file it was
   * not. Drizzle does not rethrow the pg error: it wraps it in a DrizzleQueryError whose own `code`
   * is undefined, so a test on the outer `code` never matched 42703 and selectApplicationProfileRow
   * rethrew. Measured 2026-08-09 by pointing buildPacket at a database missing one fact column:
   * every read of application_profile failed, which is autofill, onboarding and every in-flight
   * submission, for as long as the deploy led the migration. */
  test('the undefined-column check reads through the wrapper Drizzle actually throws', () => {
    const pgError = Object.assign(new Error('column "education_start_date" does not exist'), { code: '42703' });
    assert.equal(isUndefinedColumnError(pgError), true, 'the bare pg error');
    assert.equal(isUndefinedColumnError(new Error('Failed query', { cause: pgError })), true, 'wrapped once');
    assert.equal(
      isUndefinedColumnError(new Error('outer', { cause: new Error('Failed query', { cause: pgError }) })),
      true,
      'wrapped twice',
    );
    // Everything else still throws, which is the half that keeps a real failure from being swallowed.
    assert.equal(isUndefinedColumnError(new Error('connection terminated')), false);
    assert.equal(isUndefinedColumnError(Object.assign(new Error('bad'), { code: '23505' })), false);
    assert.equal(isUndefinedColumnError(undefined), false);
    // A cause that loops back on itself must not spin.
    const looped = new Error('a') as Error & { cause?: unknown };
    looped.cause = looped;
    assert.equal(isUndefinedColumnError(looped), false);
  });

  test('false and null are told apart in storage but treated the same by the resolver', () => {
    assert.equal(factBoolean({ user_id: 'u', accept_privacy_notices: false } as never, 'accept_privacy_notices'), false);
    assert.equal(factBoolean({ user_id: 'u', accept_privacy_notices: null } as never, 'accept_privacy_notices'), undefined);
    assert.equal(filled('privacy statement', { accept_privacy_notices: false }), null);
    assert.equal(filled('privacy statement', {}), null);
  });
});

/* THE MOUNT, ASSERTED AGAINST THE SCHEMA RATHER THAN AGAINST A HAND-BUILT OBJECT.
 *
 * restrictive_agreements shipped in #515 with a column, a zod field, a resolver branch and four
 * passing unit tests, and answered nothing in production. Every one of those tests called
 * resolveKnownAnswer with a literal `{ restrictive_agreements: 'No' }`, so not one of them crossed
 * the two places the value actually has to travel through: APPLICATION_FACT_COLUMNS, which is the
 * projection selectApplicationProfileRow narrows to, and buildApplicationProfileLike, which maps
 * the row onto the shape resolvers read. The column was absent from both, so the row never carried
 * it and the resolver saw undefined forever.
 *
 * This is the composition-root defect the repo has now recorded three times: the module is
 * correct, the suite is green, and nothing mounts it. A behavioural test of a resolver cannot
 * catch it by construction, so this reads the wiring itself and fails when a declaration column
 * exists in the schema but is not carried to the readers.
 */
describe('every declaration column is actually mounted on the read path', () => {
  test('APPLICATION_FACT_COLUMNS carries restrictive_agreements', () => {
    assert.ok(
      APPLICATION_FACT_COLUMNS.includes('restrictive_agreements'),
      'restrictive_agreements must be in the projection or the row never carries it',
    );
  });

  test('a declared restrictive-agreement answer survives the row-to-resolver hop', () => {
    const row = { user_id: 'u', restrictive_agreements: 'No' } as never;
    assert.equal(factString(row, 'restrictive_agreements'), 'No');
  });

  test('the schema declares no fact column the projection has forgotten', () => {
    /* The general form. Any column added to application_profile alongside the declaration set has
     * to be named in APPLICATION_FACT_COLUMNS, or it reads as "never asked" no matter what is
     * stored. Scoped to the declaration columns this list owns rather than to every column on the
     * table, because the encrypted identity fields are read by a different path. */
    for (const column of ['politically_exposed', 'politically_exposed_family', 'restrictive_agreements']) {
      assert.ok(
        Object.keys(getTableColumns(application_profile)).includes(column),
        `${column} must exist on the schema`,
      );
      assert.ok(
        APPLICATION_FACT_COLUMNS.includes(column as never),
        `${column} exists on the schema but is not in APPLICATION_FACT_COLUMNS`,
      );
    }
  });
});
