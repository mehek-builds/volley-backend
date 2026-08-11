import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyField, frozenJobEmployerContext, resolveKnownAnswer, type ApplicationProfileLike } from './questionDiscovery';
import { resolveProfileField } from './profileFieldResolution';
import {
  APPLICATION_FACT_COLUMNS,
  factBoolean,
  factString,
  factStringList,
  isUndefinedColumnError,
  mayRetryWithoutFactColumns,
  withoutFactColumns,
} from './applicationFacts';

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

  /* THE DEFAULT IS NO, AND LITOS' OWN SEND HISTORY IS THE ONLY THING THAT WITHDRAWS IT.
   *
   * `prior_application_employers` is an onboarding column most accounts have never filled, so
   * before this every company-scoped prior-application question was handed back. The IMC label
   * below is the exact string off the live form on 2026-08-10, reminder sentence and all, and it
   * was one of the blockers stopping a real application from going out.
   *
   * The evidence is `submitted_application_companies`: the employers Litos has already sent an
   * application to for this user, read by lib/applicationProfileLike.ts from the rows
   * lib/duplicateApplication.ts counts as having reached an employer. `[]` is "Litos looked and has
   * sent nothing", which is what licenses the answer. `undefined` is "nobody looked" and holds.
   */
  const IMC_PRIOR_APPLICATION_LABEL = 'Have you applied to this role or another role @IMC within the last 12-18 months? '
    + 'As a reminder, if you have already applied for this position during the current recruitment season and were not '
    + 'selected, you may reapply when the next recruitment season begins in 2027.';

  test('a company-scoped prior-application question answers No when Litos has sent nothing to that employer', () => {
    const imc = frozenJobEmployerContext('IMC');
    const nothingSent: ApplicationProfileLike = { submitted_application_companies: [] };

    // The compound IMC form. "This role or another role at IMC" is entirely inside the company
    // scope the evidence covers, so the disjunction no longer makes the question unanswerable.
    assert.deepEqual(resolveKnownAnswer(IMC_PRIOR_APPLICATION_LABEL, 'text', nothingSent, imc), { value: 'No' });
    // Discovery lowercases every label it captures, so the lowercased spelling is the one that
    // actually arrives and it has to answer identically.
    assert.deepEqual(
      resolveKnownAnswer(IMC_PRIOR_APPLICATION_LABEL.toLowerCase(), 'text', nothingSent, imc),
      { value: 'No' },
    );
    // And it reaches a real yes/no control rather than producing a value nothing can select.
    assert.equal(
      filled(IMC_PRIOR_APPLICATION_LABEL, nothingSent, { inputType: 'select', options: YES_NO, context: imc }),
      'No',
    );

    // The plain forms of the same question.
    for (const label of ['Have you previously applied to this company?', 'Have you applied to us before?']) {
      assert.deepEqual(resolveKnownAnswer(label, 'text', nothingSent, imc), { value: 'No' }, label);
    }

    // NOTHING READ IS NOT THE SAME AS NOTHING SENT. With no history on the profile at all the
    // question stays held, exactly as it did before this rule existed - and it is now held for the
    // right reason, because the label itself is a complete question rather than a compound one.
    const unread = heldFor(IMC_PRIOR_APPLICATION_LABEL, {}, 'text', imc);
    assert.match(unread, /prior application question left for you/);
    assert.doesNotMatch(unread, /compound application question/);
  });

  test('a submitted application to that same company hands the question back, and never answers Yes', () => {
    const imc = frozenJobEmployerContext('IMC');
    const sentToImc: ApplicationProfileLike = { submitted_application_companies: ['IMC'] };

    /* NOT "Yes". The label asks about a 12-18 month window and about "this role or another role",
     * and a list of employers settles neither. A wrong Yes costs her the same as a wrong No, so the
     * exception restores exactly today's behaviour rather than flipping the answer. */
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

    /* COMPANY IDENTITY IS EXACT, on the duplicate guard's own folding of job_context.company. A
     * submitted application to a similarly-named but different company withdraws nothing: if it
     * did, the near-miss would answer a live employer's question out of another company's history.
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
        resolveKnownAnswer(bare, 'text', { submitted_application_companies: [other] }, imc),
        { value: 'No' },
        other,
      );
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

  test('a scope-restating tail does not narrow the default No, because No survives every restatement', () => {
    const imc = frozenJobEmployerContext('IMC');
    /* THE REGRESSION GUARD FOR THE WRONG REPAIR. Refusing to strip a restating tail would put every
     * one of these back in the compound refusal. With no application to any employer there is
     * nothing for a narrowing or a widening to act on, so No is true either way, and the default-No
     * rule this branch exists for holds under all four kinds of restatement. */
    for (const tail of SCOPE_RESTATING_TAILS) {
      for (const ap of [
        { submitted_application_companies: [] },
        { prior_application_employers: [] },
        { prior_application_employers: [], submitted_application_companies: [] },
      ] satisfies ApplicationProfileLike[]) {
        assert.deepEqual(
          resolveKnownAnswer(questionWith(tail), 'text', ap, imc),
          { value: 'No' },
          `${tail} / ${JSON.stringify(ap)}`,
        );
      }
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
    // IMC's real tail is removed like any other, and the blocker this branch exists for stays fixed.
    assert.deepEqual(
      resolveKnownAnswer(IMC_PRIOR_APPLICATION_LABEL, 'text', { submitted_application_companies: [] }, imc),
      { value: 'No' },
    );
  });

  test('the new default is company-scoped, and reaches nothing else', () => {
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

  test('a write can shed the fact columns without losing the established ones', () => {
    const values = { phone: '+971500000000', pronouns: 'she/her', accept_privacy_notices: true };
    assert.deepEqual(withoutFactColumns(values), { phone: '+971500000000' });
  });

  test('a required scoped column prevents any compatibility projection retry', () => {
    const values = {
      work_eligibility_by_country: 'encrypted',
      work_authorized: true,
      needs_sponsorship: false,
    };
    assert.equal(mayRetryWithoutFactColumns(values, ['work_eligibility_by_country']), false);
    assert.equal(mayRetryWithoutFactColumns(values), true);
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
