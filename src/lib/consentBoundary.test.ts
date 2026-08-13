import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONSENT_STRUCTURAL_FILLER,
  frozenJobEmployerContext,
  refreshKnownQuestionAnswers,
  resolveKnownAnswer,
  type ApplicationProfileLike,
} from './questionDiscovery';
import { resolveProfileField } from './profileFieldResolution';
import { resolvePrescript, type PostingQuestion } from './postingQuestions';
import { automationConsentValues } from './automationConsent';

/* THE ONE LINE THIS FEATURE IS.
 *
 * Litos may accept an employer's privacy statement, applicant terms or code of conduct in the
 * applicant's name, and only under the standing permission she granted once at onboarding. It may
 * never accept a FACTUAL DECLARATION - her right to work, her age, her degree, her record, her
 * health, her service, an authorization she grants, a statement she swears to - whatever that
 * permission says.
 *
 * Both halves are asserted here against the SAME profile, because the interesting failure is not
 * "the consent did not go in", it is "the permission reached something it was never meant to".
 *
 * Every test drives the real resolution path (resolveKnownAnswer, and resolveProfileField where a
 * control has an option list), because a value that resolves and then fails to reach the control is
 * the defect lib/profileFieldResolution.ts was written for.
 */

/** Both standing permissions granted, and nothing else on file. */
const GRANTED: ApplicationProfileLike = {
  consent_acknowledgement_permission: { granted_at: '2026-08-12T09:15:00.000Z', version: '2026-08-12' },
  conduct_acknowledgement_permission: { granted_at: '2026-08-12T09:16:00.000Z', version: '2026-08-12' },
};
/** Privacy and terms only. A code of conduct is a different grant and stays hers. */
const PRIVACY_ONLY: ApplicationProfileLike = {
  consent_acknowledgement_permission: { granted_at: '2026-08-12T09:15:00.000Z', version: '2026-08-12' },
};
/** The default for every account: never asked, or revoked, or a stale consent version. */
const NOT_GRANTED: ApplicationProfileLike = {};

/* `employer` is the frozen job context the runner already passes as jdText. A label naming the
 * employer needs it, and a label that does not is unaffected: see the employer-name tests below. */
function answer(
  label: string,
  ap: ApplicationProfileLike,
  inputType = 'checkbox',
  employer = 'Acme',
): string | null {
  const resolved = resolveKnownAnswer(label, inputType, ap, frozenJobEmployerContext(employer));
  return resolved && 'value' in resolved ? resolved.value : null;
}

function held(label: string, ap: ApplicationProfileLike, inputType = 'checkbox'): string | null {
  const resolved = resolveKnownAnswer(label, inputType, ap, frozenJobEmployerContext('Acme'));
  return resolved && 'skipReason' in resolved ? resolved.skipReason : null;
}

/** What the runner would actually put in a control that has an option list, and whether it chose. */
function selected(label: string, ap: ApplicationProfileLike, options: string[]) {
  return resolveProfileField({ label, inputType: 'select', options }, ap, frozenJobEmployerContext('Acme'));
}

/* LABELS ARE VERBATIM where they came off a real form. "Privacy Statement" and "Interview Code of
 * Conduct" are IMC's own two, copied from the blockers of the run that could not be sent:
 *   "Privacy Statement" is required and is still empty
 *   "Interview Code of Conduct" is required and is still empty
 * The Cloudflare wording is the shape already sitting in this account's stored question data. */
const IMC_PRIVACY = 'Privacy Statement';
const IMC_CONDUCT = 'Interview Code of Conduct';
const CLOUDFLARE = "Please review and acknowledge Cloudflare's Candidate Privacy Policy (cloudflare.com/candidate-privacy-policy)";
const GDPR = 'I consent to Acme collecting, storing and processing my personal data for recruitment purposes, in accordance with the GDPR.';
const TERMS = 'I have read and accept the applicant terms and conditions.';
const SELECT_SHAPED = 'Do you agree to our candidate privacy notice?';

const CONSENT_LABELS = [IMC_PRIVACY, IMC_CONDUCT, CLOUDFLARE, GDPR, TERMS, SELECT_SHAPED];

/* THE HELD CLASS. Each one is a claim about the applicant rather than an agreement to a document,
 * and each is here because getting it wrong is a specific harm this repo has already had or has
 * already written a rule against: R-004 was a false work-authorization declaration sent on a live
 * application, and the sensitive-answer parsers exist because a catch-all reached one of these. */
const FACTUAL_DECLARATIONS: Array<[string, string]> = [
  ['work authorization', 'Are you legally authorized to work in the United States?'],
  ['sponsorship', 'Will you now, or in the future, require sponsorship for employment visa status?'],
  ['truth attestation', 'I certify that the information provided is true and complete'],
  ['health disclosure', 'I acknowledge the candidate privacy notice and confirm I have no medical condition that would prevent me performing this role.'],
  ['disability', 'Do you have a disability or history of a disability?'],
  ['veteran status', 'Are you a protected veteran?'],
  ['criminal history', 'Have you ever been convicted of a felony?'],
  ['background and reference authorization', 'I authorize Acme to conduct a background check and to contact my previous employers and references.'],
  ['consent wording, non-consent matter', 'Do you consent to relocate for this role?'],
  ['age attestation', 'At the time of application, are you 18+ years of age?'],
  ['degree completion', 'I confirm that I will have completed my degree before the start date.'],
  ['restrictive covenant', 'I confirm I am subject to no non-compete or non-solicitation agreement with a previous employer.'],
];

describe('the consent class, accepted only under standing permission', () => {
  test('with no permission on the row, every consent goes back to her exactly as it does today', () => {
    /* "Goes back to her" is either of two shapes and both are main's behaviour: a named refusal
     * (`privacy notice left for you to agree to yourself: ...`), or nothing at all, which leaves the
     * control blank and the employer's own "required and is still empty" reports it. What must
     * never happen is an answer, and that is what is asserted. */
    for (const label of CONSENT_LABELS) {
      assert.equal(answer(label, NOT_GRANTED), null, label);
    }
    // The two that blocked the live IMC run carry the refusal wording the applicant actually saw.
    assert.match(held(IMC_PRIVACY, NOT_GRANTED) ?? '', /privacy notice/);
    assert.match(held(IMC_CONDUCT, NOT_GRANTED) ?? '', /code of conduct/);
  });

  test('the two IMC labels that blocked a real application are accepted once permission is granted', () => {
    // The run reported both of these as "required and is still empty", with the resolver's own
    // refusals beside them: `privacy notice left for you to agree to yourself: "privacy statement"`
    // and `agreement to a code of conduct left for you to agree to yourself: "interview code of
    // conduct"`. Both are the applicant agreeing to the employer's own document, which is precisely
    // what the standing permission covers.
    assert.equal(answer(IMC_PRIVACY, GRANTED), 'Yes');
    assert.equal(answer(IMC_CONDUCT, GRANTED), 'Yes');
    // Lowercased the way discovery actually hands labels to the resolver.
    assert.equal(answer('privacy statement', GRANTED), 'Yes');
    assert.equal(answer('interview code of conduct', GRANTED), 'Yes');
  });

  test('a code of conduct needs its OWN grant and never rides on the privacy one', () => {
    /* CODE_OF_CONDUCT_ACKNOWLEDGEMENT exists because IMC's "Interview Code of Conduct" was once
     * auto-answered "Yes" with nothing stored behind it, and that was judged wrong and corrected.
     * Licensing it off a permission she granted for privacy notices would be that same reversion
     * arriving by a tidier route, so the two are separate grants at every layer. */
    assert.equal(answer(IMC_CONDUCT, PRIVACY_ONLY), null, 'the privacy grant must not tick a conduct policy');
    assert.match(held(IMC_CONDUCT, PRIVACY_ONLY) ?? '', /code of conduct/);
    assert.equal(answer(IMC_PRIVACY, PRIVACY_ONLY), 'Yes', 'and the privacy grant still works on its own');
    assert.equal(answer(IMC_CONDUCT, GRANTED), 'Yes');

    // A label naming BOTH documents needs BOTH grants, and holds on either alone.
    const both = 'I agree to the candidate privacy notice and to the interview code of conduct.';
    assert.equal(answer(both, PRIVACY_ONLY), null);
    assert.equal(answer(both, { conduct_acknowledgement_permission: GRANTED.conduct_acknowledgement_permission }), null);
    assert.equal(answer(both, GRANTED), 'Yes');
  });

  test('the Cloudflare, GDPR and terms shapes are accepted too', () => {
    assert.equal(answer(CLOUDFLARE, GRANTED), 'Yes');
    assert.equal(answer(GDPR, GRANTED), 'Yes');
    assert.equal(answer(TERMS, GRANTED), 'Yes');
  });

  test('a select-shaped consent chooses the ACCEPTING option and never its opposite', () => {
    /* A consent is usually a checkbox and is often not one. "I agree" / "I do not agree" is a real
     * pair on real forms, and the whole hazard is that both options contain the word "agree": a
     * matcher that ranks by overlap can select the refusal. A verifier bug found in this repo on
     * 2026-08-11 accepted the exact opposite of what a control held, and the cost here would be an
     * application on which the applicant appears to have REFUSED the employer's privacy notice. */
    const agreePair = selected(SELECT_SHAPED, GRANTED, ['I agree', 'I do not agree']);
    assert.ok(agreePair, 'a granted consent must resolve against a select');
    assert.equal(agreePair.value, 'I agree');
    assert.equal(agreePair.matchedOption, true);

    const reversed = selected(SELECT_SHAPED, GRANTED, ['I do not agree', 'I agree']);
    assert.equal(reversed?.value, 'I agree', 'DOM order must not decide which option is the acceptance');

    const yesNo = selected(IMC_PRIVACY, GRANTED, ['Yes', 'No']);
    assert.equal(yesNo?.value, 'Yes');
    assert.equal(yesNo?.matchedOption, true);

    const declineWording = selected(IMC_CONDUCT, GRANTED, ['I accept', 'I decline']);
    assert.equal(declineWording?.value, 'I accept');
  });

  test('an accepting option that cannot be identified with confidence is left for her', () => {
    // Two options both read as acceptances. There is nothing left to rank them by, and picking one
    // by DOM order is the guess this whole module refuses to make.
    const twoAcceptances = selected(SELECT_SHAPED, GRANTED, ['I agree', 'I accept']);
    assert.equal(twoAcceptances?.matchedOption, false, 'an ambiguous pair must select nothing');

    // A third entry this file cannot read as either an acceptance or a refusal means the list's
    // meaning is not established, so no option on it may be selected.
    const unreadable = selected(SELECT_SHAPED, GRANTED, ['I agree', 'I do not agree', 'Ask me later']);
    assert.equal(unreadable?.matchedOption, false, 'an unreadable option must stop the whole list');

    // And nothing on either list was selected, so the runner reports the field rather than filling
    // it: `usableOptions(...).length > 0 && !matchedOption` is the branch that pushes
    // "none of the options match your saved answer, so this one is left for you".
    assert.notEqual(twoAcceptances?.value, 'I accept');
  });
});

describe('with the permission off, nothing about main changes', () => {
  test('the consent option matcher is gated on the permission, not on the grammar', () => {
    /* HONEST TITLE, because this does not discriminate. resolveProfileField's consent branch was
     * gated on the GRAMMAR alone, and the gate is now consentAcknowledgementAnswer, which is
     * strictly narrower. But no witness exists that separates them: a label needs to be a consent by
     * the grammar AND answered by some other handler with no permission on the row, and a search of
     * all 558 stored labels found none. So this passes before and after the gate change.
     *
     * It is kept as an INVARIANT rather than a regression: it pins that a consent-shaped label the
     * grammar recognises is resolved by main's generic path while the permission is off, which is
     * the property the narrower gate exists to guarantee and the one a future edit would break. The
     * gate change itself is justified by reasoning, not by this test, and that is worth stating
     * rather than dressing up. */
    const label = 'Processing of Personal Data';
    assert.ok(resolveKnownAnswer(label, 'select', NOT_GRANTED, undefined));
    assert.equal(answer(label, NOT_GRANTED, 'select'), null);
    // The generic path returns null for a label it cannot answer. The consent path would have
    // returned an object with matchedOption set, which is the behaviour change being pinned out.
    assert.equal(selected(label, NOT_GRANTED, ['I agree', 'I do not agree']), null);
  });

  test('every consent label resolves identically to main when nothing is granted', () => {
    for (const label of CONSENT_LABELS) {
      assert.equal(answer(label, NOT_GRANTED), null, label);
      assert.equal(selected(label, NOT_GRANTED, ['I agree', 'I do not agree']), null, label);
      assert.equal(selected(label, NOT_GRANTED, ['Yes', 'No']), null, label);
    }
  });
});

describe('a second document nobody classified holds the whole label', () => {
  /* THE LEAK, and it defeated the two-grant split entirely. CONSENT_ACKNOWLEDGEMENT_SENTENCE needs
   * only one consent subject to match, while the conduct class is a closed four-alternative list, so
   * a privacy document beside a conduct document spelled any other way classified as privacy only
   * and was accepted on the privacy grant alone. It failed OPEN, in the one place the split exists
   * to fail closed. */
  const LEAKS = [
    'I agree to the Privacy Policy and the Code of Business Conduct',
    'I agree to the Privacy Policy and the Standards of Business Conduct',
    'I accept the Candidate Privacy Notice and the Global Code of Business Ethics',
    'I acknowledge the Privacy Statement and the Employee Handbook',
    'I consent to the processing of my personal data and accept the Supplier Code of Business Conduct',
    'I have read the Privacy Policy and the Anti-Bribery Policy',
    'I agree to the terms and conditions and the Insider Trading Policy',
    // The witness that survived the head-noun fix: "expectations" was not on that list.
    'By submitting this application I accept the Applicant Terms and the Conduct Expectations',
    /* The four that survived the COORDINATION fix, each a different syntax. They are the reason the
     * rule stopped looking for the stray document and started accounting for the whole label. */
    'In accordance with the conduct expectations',                          // prepositional
    'I agree to the conduct expectations and the privacy policy',           // unplaceable first
    'The privacy policy itself and the conduct expectations',               // intervening word
    'I agree to the privacy policy and my conduct expectations',            // possessive determiner
    /* And the four bare-label smugglers, which no previous rule closed. DATA_HANDLING_SUBJECT's
     * 80-character window matches a span that COVERS the conduct name, so every rule that asked a
     * question about the span skipped them. Coverage blanks the span and reads what is left. */
    'consent to storing under the code of business conduct my personal data',
    'consent to collecting per the standards of business conduct my personal information',
    'I consent to the processing under the employee handbook of my personal data',
    'consent to sharing beyond the insider trading policy my personal information',
  ];

  test('every leaked label now holds, on both grants', () => {
    for (const label of LEAKS) {
      assert.equal(answer(label, PRIVACY_ONLY), null, `must not ride the privacy grant: ${label}`);
      // And holding is not an artefact of the missing conduct grant: the document is unplaceable, so
      // holding both permissions does not help either.
      assert.equal(answer(label, GRANTED), null, `must hold even with both grants: ${label}`);
    }
  });

  test('a modifier belongs to the document it modifies, not to a second document', () => {
    /* Employers qualify their documents. Accounting for the head alone stranded the modifier and
     * held documents the classifier had actually placed. Absorbed one token to the LEFT only:
     * English puts modifiers before heads, and absorbing to the right would swallow "expectations"
     * in "the code of conduct expectations", which is a document nobody placed. */
    assert.equal(answer('I agree to the candidate privacy notice and the Business Conduct Guidelines', GRANTED), 'Yes');
    assert.equal(answer('Please review the California Privacy Notice', GRANTED), 'Yes');
    assert.equal(answer('I agree to the code of conduct expectations', GRANTED), null);
  });

  test('NO CONDUCT-FAMILY HEAD NOUN IS FILLER, which is the only thing holding the split', () => {
    /* THE GUARD THAT DID NOT EXIST, and the comment it enforces was previously FALSE.
     *
     * The filler used to claim that no entry in it is a document name. It is not true: `notice`,
     * `policy`, `statement`, `terms`, `conditions`, `agreement` and `consent` are all filler and all
     * name documents in isolation, so a bare-head stray beside a placed document is absorbed. The
     * code was right and its stated reason was wrong, which is the exact failure that cost this
     * repo hours when three documents disagreed with the implementation and each other.
     *
     * The property that actually holds the two-grant boundary is narrower: no CONDUCT-family head
     * noun is filler. Absorbing a privacy-family head is harmless, because privacy and terms share
     * one grant and nothing crosses a permission boundary. Absorbing a conduct-family head would let
     * a behavioural policy through on the privacy grant, which is the whole thing this branch
     * exists to prevent.
     *
     * A maintainer adding `handbook` or `guidelines` here as scaffolding would open that boundary
     * silently. This is what stops them. */
    const CONDUCT_FAMILY_HEADS = [
      'code', 'codes', 'conduct', 'ethics', 'guideline', 'guidelines', 'handbook', 'handbooks',
      'standard', 'standards', 'principle', 'principles', 'expectation', 'expectations',
      'rule', 'rules', 'charter', 'charters', 'protocol', 'protocols', 'covenant', 'covenants',
      'pledge', 'pledges', 'undertaking', 'undertakings', 'declaration', 'declarations',
      'manual', 'manuals', 'directive', 'directives', 'ethic',
    ];
    for (const head of CONDUCT_FAMILY_HEADS) {
      assert.equal(
        CONSENT_STRUCTURAL_FILLER.has(head),
        false,
        `"${head}" is a conduct-family head noun and must never be structural filler`,
      );
    }
    // And the behaviour that disjointness buys: each one survives as a stray and holds the label.
    for (const head of CONDUCT_FAMILY_HEADS) {
      assert.equal(
        answer(`I agree to the privacy policy and the ${head}`, GRANTED),
        null,
        `a stray "${head}" must hold the whole label`,
      );
    }
  });

  test('a privacy-family head IS absorbed, and that is deliberate rather than an oversight', () => {
    // Stated so the asymmetry above reads as a decision. These cross no permission boundary:
    // privacy and terms are one grant, so an absorbed stray there cannot reach the conduct class.
    for (const head of ['notice', 'policy', 'statement', 'terms', 'conditions', 'agreement', 'consent']) {
      assert.equal(answer(`I agree to the privacy policy and the ${head}`, GRANTED), 'Yes', head);
    }
  });

  test('THE KNOWN FALSE-HOLD CLASS: a jurisdiction qualifier away from the document', () => {
    /* A CLASS, NOT A CASE, and the earlier version of this test presented it as a single quirk.
     *
     * A place name is accounted for only when it sits DIRECTLY left of the document span, where the
     * modifier rule absorbs it. Anywhere else it is an unaccounted proper noun and the label holds.
     * Measured over an independently written set of 14 jurisdiction-scoped privacy labels: 8 held.
     * The reviewer's own 14-label set gave 7. The count depends on the sample; the class does not.
     *
     * Fail-closed, so it is not a safety problem: it costs a checkbox the applicant ticks herself.
     * The fix is a jurisdiction qualifier in CONSENT_DOCUMENT_QUALIFIER, so a place name is
     * accounted for wherever it appears rather than only when adjacent. It is deliberately NOT done
     * here: it widens what counts as a qualifier, which is exactly the kind of change that needs its
     * own corpus measurement rather than being folded into a fix for something else. */
    const HELD = [
      'California residents, please review the California Privacy Notice',
      'For California residents: the California Privacy Notice applies',
      'Nevada residents may opt out under the Nevada Privacy Notice',
      'Virginia residents, please review the privacy statement',
      // The qualifier is one token further out than the modifier rule reaches.
      'I agree to the California Consumer Privacy Notice',
    ];
    for (const label of HELD) assert.equal(answer(label, GRANTED), null, label);

    // Directly adjacent, so the modifier rule accounts for it and the label is accepted.
    for (const label of [
      'I agree to the California Privacy Notice',
      'Please review the California Privacy Notice',
      'I accept the Texas privacy policy',
    ]) assert.equal(answer(label, GRANTED), 'Yes', label);
  });

  test('a second document the classifier CAN place is accepted, and needs both grants', () => {
    // "Business Conduct Guidelines" is placeable: `conduct guidelines` is one of the four conduct
    // alternatives. So this is not a leak, it is a correctly classified two-document label, and the
    // proof it is handled by class rather than by luck is that the privacy grant alone will not do.
    const label = 'I agree to the candidate privacy notice and the Business Conduct Guidelines';
    assert.equal(answer(label, PRIVACY_ONLY), null);
    assert.equal(answer(label, GRANTED), 'Yes');
  });

  test('it is the unplaceable document that holds it, not the length of the sentence', () => {
    // Same sentence, same two documents, one of them spelled the way the classifier knows.
    assert.equal(answer('I agree to the Privacy Policy and the Code of Conduct', GRANTED), 'Yes');
    assert.equal(answer('I agree to the Privacy Policy and the Code of Business Conduct', GRANTED), null);
  });

  test('a bare document label is exempt, because it cannot contain a second document', () => {
    // Anchored end to end. Without the exemption its own trailing noun reads as a second document.
    for (const label of ['Privacy Policy Acknowledgement', 'Privacy Policy Agreement', 'Terms and Conditions']) {
      assert.equal(answer(label, GRANTED), 'Yes', label);
    }
  });

  test('an ordinary sentence continuing past the document name is not a second document', () => {
    /* The rule fires on a NOUN PHRASE joined to a classified document, not on any coordination.
     * Without that, every consent whose sentence carries on past the document name would hold, which
     * is most of them. Clause markers are closed-class function words, not employer vocabulary. */
    for (const label of [
      'I agree to the candidate privacy notice and understand my data will be processed.',
      'I agree to the privacy policy and confirm I have read it.',
      'I have read and accept the applicant terms and conditions.',
      'I consent to Acme collecting, storing and processing my personal data for recruitment purposes.',
    ]) {
      assert.equal(answer(label, GRANTED), 'Yes', label);
    }
  });

  test('the employer\u2019s own name is accounted for, and only from the frozen job context', () => {
    /* Measured over the label corpus, a company name in the label was the single largest cause of
     * false holds: "i consent to acme collecting...", "do you consent to brex processing...",
     * "faire candidate privacy policy acknowledgment". Lowercased, nothing distinguishes "brex" from
     * "expectations", so coverage cannot account for it from the text.
     *
     * It does not have to. The packet knows the employer and already passes it on the frozen job
     * line. Accounting for exactly that name is not a guess; with no context passed, the name is
     * unaccounted and the label holds, which is the safe direction. */
    const gdpr = 'I consent to Acme collecting, storing and processing my personal data for recruitment purposes, in accordance with the GDPR.';
    assert.equal(answer(gdpr, GRANTED, 'checkbox', 'Acme'), 'Yes');
    assert.equal(answer(gdpr, GRANTED, 'checkbox', ''), null, 'no employer context means the name is unaccounted');
    // And it accounts for the employer only. A different company does not unlock the label.
    assert.equal(answer(gdpr, GRANTED, 'checkbox', 'Brex'), null);
  });

  test('a URL naming a DIFFERENT document is read, not blanked away', () => {
    /* The blanking rule assumed every URL points at the document the sentence names. It does not:
     * blanking made a conduct document invisible and the label accepted on the privacy grant alone.
     * The path is now read as words, so the ordinary machinery sees it. */
    const conductLink = 'I agree to the Privacy Policy at acme.com/code-of-conduct';
    assert.equal(answer(conductLink, PRIVACY_ONLY), null, 'the linked conduct document needs its own grant');
    assert.equal(answer(conductLink, GRANTED), 'Yes');

    // A linked document nothing can place holds the label, on either grant.
    for (const label of [
      'I agree to the Privacy Policy at acme.com/code-of-business-conduct',
      'I agree to the Privacy Policy at acme.com/code-of-business-conduct.pdf',
    ]) {
      assert.equal(answer(label, GRANTED), null, label);
    }

    // A routing URL is not a document name and must not hold anything.
    assert.equal(answer('I agree to the Privacy Policy. Apply at acme.com/apply?src=123', GRANTED), 'Yes');
  });

  test('a privacy spelling shadowed by a shorter alternative still resolves', () => {
    /* Sticky matching returns the FIRST matching alternative, not the longest, so the bare `privacy`
     * alternative shadowed `privacy and cookies policy` and left "Policy" uncovered. It failed
     * closed, so it only cost a hold, but on a spelling the pattern explicitly supports. */
    assert.equal(answer('I agree to the Privacy and Cookies Policy', GRANTED), 'Yes');
    assert.equal(answer('I agree to the Privacy and Cookie Notice', GRANTED), 'Yes');
  });

  test('a URL pointing at the document already named is not a second document', () => {
    // "cloudflare.com/candidate-privacy-policy" carries the word "policy", and its hyphens stop the
    // privacy pattern covering it. Blanking URLs first is what keeps this a positive.
    assert.equal(answer(CLOUDFLARE, GRANTED), 'Yes');
  });
});

describe('the factual-declaration class, which the permission never reaches', () => {
  test('granting the permission changes nothing about any factual declaration', () => {
    /* THE ASSERTION THIS WHOLE FEATURE IS JUDGED ON. Not "these are held" - some of them are
     * legitimately ANSWERED by their own resolver from her own stored declaration, and a disability
     * question correctly returns her EEO opt-out. The property is that the permission is invisible
     * to all of them: the same label resolves to the same thing with and without it, so no widening
     * of the consent grammar can ever put an acceptance on one of these. */
    for (const [what, label] of FACTUAL_DECLARATIONS) {
      assert.equal(
        answer(label, GRANTED),
        answer(label, NOT_GRANTED),
        `${what} must resolve identically with and without the permission: ${label}`,
      );
      assert.equal(
        held(label, GRANTED),
        held(label, NOT_GRANTED),
        `${what} must be refused identically with and without the permission: ${label}`,
      );
    }
  });

  test('and none of them is answered "Yes" off an empty profile', () => {
    // The specific harm: an acceptance value landing on a claim about her. Every one of these with
    // nothing on file must be a refusal, a null, or her own EEO opt-out - never the consent value.
    for (const [what, label] of FACTUAL_DECLARATIONS) {
      assert.notEqual(answer(label, GRANTED), 'Yes', `${what} must never be answered Yes: ${label}`);
    }
  });

  test('a select cannot be used to slip a factual declaration past the label rule', () => {
    // The option list is where an "I agree" wording makes a declaration LOOK like a consent. The
    // decision is made on the label, before any list is consulted, so the shape of the list cannot
    // change it.
    for (const [what, label] of FACTUAL_DECLARATIONS) {
      const resolved = selected(label, GRANTED, ['I agree', 'I do not agree']);
      assert.ok(
        resolved === null || resolved.value !== 'I agree',
        `${what} must not be agreed to from an option list: ${label}`,
      );
    }
  });

  test('the sponsorship and work-eligibility paths are untouched by the permission', () => {
    /* Not merely "still held": still ANSWERED, from the stored declaration, exactly as on main.
     * A permission that quietly disabled a working answer would be as bad as one that invented a
     * new one, and this is the family R-004 was opened against. */
    const authorized: ApplicationProfileLike = { work_authorized: true, needs_sponsorship: false };
    const label = 'Are you legally authorized to work in the United States?';
    assert.equal(answer(label, authorized, 'select'), 'Yes', 'stored eligibility must still answer');
    assert.equal(
      answer(label, { ...authorized, ...GRANTED }, 'select'),
      answer(label, authorized, 'select'),
      'the standing permission must not change a work-eligibility answer',
    );

    const sponsorship = 'Will you now, or in the future, require sponsorship for employment visa status to work in the United States?';
    const needsSponsorship: ApplicationProfileLike = { work_authorized: true, needs_sponsorship: true };
    assert.equal(answer(sponsorship, needsSponsorship, 'select'), 'Yes');
    assert.equal(answer(sponsorship, { ...needsSponsorship, ...GRANTED }, 'select'), 'Yes');
  });

  test('the EEO path is untouched by the permission', () => {
    const eeo: ApplicationProfileLike = { eeo_prefs: { gender: 'Female' } };
    assert.equal(answer('what is your gender?', eeo, 'select'), 'Female');
    assert.equal(answer('what is your gender?', { ...eeo, ...GRANTED }, 'select'), 'Female');
    assert.equal(answer('please select your racial/ethnic background', GRANTED, 'select'), 'Decline to self-identify');
    // The demographic-survey consent stays a consent question left for her: it is a data-processing
    // consent WHOSE SUBJECT IS the demographic block, and that block is answered by its own rule.
    const demographic = 'By checking this box, I consent to Reddit collecting, storing, and processing my responses to the demographic data survey above.';
    assert.equal(answer(demographic, GRANTED), null);
    assert.ok(held(demographic, GRANTED));
  });

  test('a truth attestation is not a consent however it is worded', () => {
    for (const label of [
      'I certify that all information I have provided is true, complete, and accurate.',
      'I confirm to the best of my knowledge that the details above are correct.',
      'I declare that the information in this application is truthful.',
    ]) {
      assert.equal(answer(label, GRANTED), null, label);
    }
  });
});

describe('one spelling of the label, across all three call sites', () => {
  test('the raw discovered blob resolves the same as the normalized label', () => {
    /* Discovery hands the runner a concatenated blob: label text, the employer's required marker,
     * and Greenhouse's array and row handles. resolveProfileField normalizes before it tests;
     * the runner's consent trail does not. Three spellings reaching one predicate is how a control
     * gets accepted on one path and held on another, so the predicate owns the spelling. */
    for (const raw of ['Privacy Statement*', 'privacy statement* []', 'Interview Code of Conduct *']) {
      assert.equal(answer(raw, GRANTED), 'Yes', raw);
    }
    // And the trail the runner stamps agrees with the answer, on the raw form.
    const resolved = selected('Privacy Statement*', GRANTED, ['I agree', 'I do not agree']);
    assert.equal(resolved?.value, 'I agree');
  });
});

describe('the pre-script hands a consent back only when it may not accept it', () => {
  const question = (label: string, options: string[] | null = null): PostingQuestion => ({
    label,
    input_type: options ? 'select' : 'checkbox',
    options,
    required: true,
    max_length: null,
  });

  test('with no permission the Apply screen asks, which is what it does today', () => {
    const { questions } = resolvePrescript([question(IMC_PRIVACY), question(IMC_CONDUCT)], NOT_GRANTED, new Map());
    assert.equal(questions.length, 2);
    for (const item of questions) {
      assert.equal(item.ask, true, item.label);
      assert.equal(item.answer, '');
    }
  });

  test('with permission the Apply screen fills them instead', () => {
    const { questions, ask } = resolvePrescript(
      [question(IMC_PRIVACY), question(IMC_CONDUCT), question(SELECT_SHAPED, ['I agree', 'I do not agree'])],
      GRANTED,
      new Map(),
    );
    assert.equal(ask.length, 0, 'a consent she has already permitted is not work for her');
    assert.deepEqual(questions.map((item) => item.answer), ['Yes', 'Yes', 'I agree']);
    // Never marked as remembered: this is a permission, not an answer she typed on another form.
    assert.deepEqual(questions.map((item) => item.remembered), [false, false, false]);
  });

  test('with permission a factual declaration is still asked', () => {
    const { ask } = resolvePrescript(
      FACTUAL_DECLARATIONS.map(([, label]) => question(label)),
      GRANTED,
      new Map(),
    );
    assert.equal(ask.length, FACTUAL_DECLARATIONS.length, 'every declaration stays hers to make');
    for (const item of ask) assert.equal(item.answer, '');
  });

  test('a consent whose accepting option cannot be identified is asked, not guessed', () => {
    const { ask } = resolvePrescript([question(SELECT_SHAPED, ['I agree', 'I accept'])], GRANTED, new Map());
    assert.equal(ask.length, 1);
    assert.equal(ask[0].answer, '');
  });
});

describe('the permission is recorded the way the other standing permissions are', () => {
  test('granting it stamps a date and a version, revoking it clears both', () => {
    const now = new Date('2026-08-12T09:15:00.000Z');
    const granted = automationConsentValues({
      automatic_submission_enabled: false,
      automatic_verification_enabled: false,
      automatic_consent_acceptance_enabled: true,
    }, now) as Record<string, unknown>;
    assert.equal(granted.automatic_consent_acceptance_enabled, true);
    assert.equal(granted.automatic_consent_acceptance_consented_at, now);
    assert.equal(typeof granted.automatic_consent_acceptance_consent_version, 'string');

    const revoked = automationConsentValues({
      automatic_submission_enabled: false,
      automatic_verification_enabled: false,
      automatic_consent_acceptance_enabled: false,
    }, now) as Record<string, unknown>;
    assert.equal(revoked.automatic_consent_acceptance_enabled, false);
    assert.equal(revoked.automatic_consent_acceptance_consented_at, null);
    assert.equal(revoked.automatic_consent_acceptance_consent_version, null);
  });

  test('the answer_source literal does not collide with permission to SEND', () => {
    /* SubmissionAuthorizationSource already owns 'standing_consent', and it means something else
     * entirely: authority to press submit. Two different permissions sharing one literal in one
     * codebase is how a stale comment cost a full wrong diagnosis earlier in this work. */
    const authorization = readFileSync('src/lib/submissionAuthorization.ts', 'utf8');
    assert.match(authorization, /'standing_consent'/, 'the send permission keeps its name');
    const provenance = readFileSync('src/lib/applicationReview.ts', 'utf8');
    assert.match(provenance, /answer_source\?: 'applicant_review' \| 'consent_permission'/);
    assert.doesNotMatch(provenance, /answer_source\?: [^;]*standing_consent/);
  });

  test('a writer that does not mention the permission leaves it entirely alone', () => {
    // The same rule captcha resume has, and it matters more here: this object is spread into a
    // column update, so naming the column always would make POST /onboarding/complete silently
    // revoke a permission granted in settings, or restamp the date she chose it on.
    const untouched = automationConsentValues({
      automatic_submission_enabled: true,
      automatic_verification_enabled: false,
    }, new Date()) as Record<string, unknown>;
    assert.equal('automatic_consent_acceptance_enabled' in untouched, false);
    assert.equal('automatic_consent_acceptance_consented_at' in untouched, false);
    assert.equal('automatic_consent_acceptance_consent_version' in untouched, false);
  });
});

describe('a refresh keeps a consent current, or removes it entirely', () => {
  /* The record the runner writes for a select-shaped consent: the employer's own option text as the
   * answer, "Yes" as what it was snapped from, and the grant that licensed it. */
  const accepted = () => ({
    question: IMC_PRIVACY,
    answer: 'I agree',
    answer_source: 'consent_permission' as const,
    answer_option_source: 'Yes',
    consent_permission_version: 'privacy_and_terms@2026-08-12',
    consent_permission_granted_at: '2026-08-12T09:15:00.000Z',
  });

  test('the employer\u2019s own option text survives a refresh while the permission holds', () => {
    /* THE DIVERGENCE THIS CLOSES. storedOptionAnswerIsCurrent needs a date or number BAND, and
     * "I agree" is neither, so the keep-branch was unreachable for consents and every refresh
     * replaced "I agree" with "Yes" - which is not on the control's option list at all. The prepare
     * run would show the applicant "I agree" and the employer would receive "Yes". That is PR 496's
     * measured prepare-versus-submit divergence, reintroduced for the consent family. */
    const [refreshed] = refreshKnownQuestionAnswers([accepted()], GRANTED, undefined);
    assert.equal(refreshed.answer, 'I agree', 'the option text the employer actually offers must stand');
    assert.equal(refreshed.answer_source, 'consent_permission', 'and its provenance stands with it');
    assert.equal(refreshed.consent_permission_granted_at, '2026-08-12T09:15:00.000Z');
  });

  test('revoking the permission removes the answer AND its provenance', () => {
    /* BLOCK 3. withoutProvenance stripped three fields and not the two consent ones, so a blanked
     * answer kept "accepted under a permission granted at 09:15" beside it - the feature's forbidden
     * misreading inverted, claiming an acceptance that is not there on a control she now has to fill
     * herself. */
    const [refreshed] = refreshKnownQuestionAnswers([accepted()], NOT_GRANTED, undefined);
    assert.equal(refreshed.answer, '', 'a withdrawn permission un-ticks an unsent packet');
    assert.equal('consent_permission_version' in refreshed, false, 'no orphaned grant version');
    assert.equal('consent_permission_granted_at' in refreshed, false, 'no orphaned grant date');
    assert.equal('answer_source' in refreshed, false);
    assert.equal('answer_option_source' in refreshed, false);
  });

  test('revoking only the conduct grant removes only the conduct acceptance', () => {
    const conduct = { ...accepted(), question: IMC_CONDUCT, consent_permission_version: 'conduct@2026-08-12' };
    assert.equal(refreshKnownQuestionAnswers([conduct], GRANTED, undefined)[0].answer, 'I agree');
    assert.equal(refreshKnownQuestionAnswers([conduct], PRIVACY_ONLY, undefined)[0].answer, '');
    // And the privacy acceptance beside it is untouched by the conduct revocation.
    assert.equal(refreshKnownQuestionAnswers([accepted()], PRIVACY_ONLY, undefined)[0].answer, 'I agree');
  });

  test('the review round trip is not locked in by the currency branch', () => {
    /* A granted permission is necessary and NOT sufficient. The dashboard "Review answers" round
     * trip stores the resolved value rather than the displayed one, so a consent showing "I agree"
     * comes back "Yes" after an unedited Save. Keying currency on the permission alone PRESERVED
     * that "Yes", turning a recoverable divergence into a permanent one. It must fall through and
     * be recomputed instead. The round trip itself is fixed on
     * fix/review-screen-shows-resolved-answer, which this branch must land after. */
    const roundTripped = { ...accepted(), answer: 'Yes' };
    const [refreshed] = refreshKnownQuestionAnswers([roundTripped], GRANTED, undefined);
    assert.equal(refreshed.answer, 'Yes');
    assert.equal('consent_permission_version' in refreshed, false, 'a recomputed answer keeps no grant record');
    // The employer's own option text is still kept, which is the branch's actual job.
    assert.equal(refreshKnownQuestionAnswers([accepted()], GRANTED, undefined)[0].answer, 'I agree');
  });

  test('an explicit refusal is never overwritten with an acceptance', () => {
    // She edited the control to say no. The resolver still has a value, and without this the
    // refusal is replaced by the acceptance value on the next run.
    const refused = { ...accepted(), answer: 'I do not agree' };
    assert.equal(refreshKnownQuestionAnswers([refused], GRANTED, undefined)[0].answer, 'I do not agree');
  });

  test('a plain checkbox acceptance is unaffected either way', () => {
    const plain = { question: IMC_PRIVACY, answer: 'Yes' };
    assert.equal(refreshKnownQuestionAnswers([plain], GRANTED, undefined)[0].answer, 'Yes');
    assert.equal(refreshKnownQuestionAnswers([plain], NOT_GRANTED, undefined)[0].answer, '');
  });
});

describe('the packet says the acceptance was Litos acting on a permission', () => {
  test('the runner stamps the standing consent onto every consent it accepts', () => {
    /* Source-level, in the idiom selfDeclaration.test.ts already uses on this file: the alternative
     * is standing up a browser run. What is asserted is the property that matters - a consent
     * answered from the permission carries its provenance, so the audit cannot show a tick that
     * reads as if the applicant had made it herself. */
    const source = readFileSync('src/routes/submissionRunner.ts', 'utf8');
    const trail = source.indexOf('const consentTrail =');
    assert.ok(trail > 0, 'the runner must build a standing-consent trail');
    assert.match(source, /answer_source: 'consent_permission' as const/);
    assert.match(source, /consent_permission_version: consentLicence\.version/);
    assert.match(source, /consent_permission_granted_at: consentLicence\.granted_at/);
    // Keyed on the profile resolution, never on a remembered answer: her own replayed words must
    // not be reported as a machine acceptance.
    assert.match(source, /const consentLicence = profileKnown && 'value' in profileKnown/);
    // The trail is built from the SAME call that licenses the acceptance, so it cannot name a grant
    // the resolver did not actually use, and it is handed the same frozen job context.
    assert.match(source, /consentAcknowledgementLicence\(label, ap, questionContext\)/);
    // Both places a resolved answer becomes a question carry it, including the branch that rewrites
    // an existing packet question on a re-run.
    assert.equal(source.split('...consentTrail,').length - 1, 2);
  });
});
