import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  consentAcknowledgementClasses,
  consentAcknowledgementLicence,
  isConsentAcknowledgementQuestion,
  isHeldDeclarationLabel,
  consentAcknowledgementAnswer,
  isConsentAcceptingWording,
  isConsentRefusingWording,
  type ApplicationProfileLike,
} from './questionDiscovery';
import { comparableOption } from './selfIdentification';
import {
  chooseClosestOption,
  chooseConsentOption,
  consentAcceptanceValue,
  graduationDateLadder,
  optionCoversMonthYear,
} from './profileFieldResolution';
import {
  AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION,
  AUTOMATIC_CONSENT_ACCEPTANCE_VERSION,
  conductAcceptanceGranted,
  consentAcceptanceGranted,
} from './automationConsent';

/* The grammar on its own, with no account and no control attached.
 *
 * consentBoundary.test.ts asserts the behaviour through the real resolution path, which is what
 * actually protects an application. This file asserts the two pieces that behaviour is built out of
 * - the closed grammar and the option chooser - so that a regression in either is reported where it
 * happened rather than as a mysterious change three layers up.
 */

const GRANTED: ApplicationProfileLike = {
  consent_acknowledgement_permission: { granted_at: '2026-08-12T09:15:00.000Z', version: AUTOMATIC_CONSENT_ACCEPTANCE_VERSION },
  conduct_acknowledgement_permission: { granted_at: '2026-08-12T09:16:00.000Z', version: AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION },
};

describe('the closed grammar', () => {
  test('the bare document labels employers actually ship are consents', () => {
    for (const label of [
      'Privacy Statement',
      'privacy statement',
      'Privacy',
      'Privacy Policy Acknowledgement',
      'Candidate Privacy Notice',
      'Job Applicant Privacy Notice',
      'Data Protection Notice',
      'Interview Code of Conduct',
      'Code of Conduct',
      'Code of Ethics',
      'Acceptable Use Policy',
      'Terms and Conditions',
      'Applicant Terms',
      'Processing of Personal Data',
      'Notice at Collection',
    ]) {
      assert.ok(isConsentAcknowledgementQuestion(label), `should be a consent: ${label}`);
    }
  });

  test('the sentence shapes are consents', () => {
    for (const label of [
      "Please review and acknowledge Cloudflare's Candidate Privacy Policy (cloudflare.com/candidate-privacy-policy)",
      'I consent to the collection, storage and processing of my personal data for recruitment purposes, in accordance with the GDPR.',
      'I have read and accept the applicant terms and conditions.',
      'By selecting "I agree", I understand that the information I have provided will be processed in accordance with the Candidate Privacy Policy.',
      'Do you agree to our candidate privacy notice?',
      'I acknowledge that my information will be retained for recruitment purposes.',
      'I agree to the code of conduct.',
    ]) {
      assert.ok(isConsentAcknowledgementQuestion(label), `should be a consent: ${label}`);
    }
  });

  test('a consent verb over a non-consent subject is not a consent at all', () => {
    /* The point of requiring a closed SUBJECT and not merely an accepting verb. None of these is
     * vetoed for its wording; each simply names no document and no data-handling act, so the
     * grammar never matches it in the first place. */
    for (const label of [
      'Do you agree to work five days a week in the office?',
      'I acknowledge that this role is based in New York.',
      'Do you accept the offered start date?',
      'I confirm I have read the job description.',
    ]) {
      assert.equal(isConsentAcknowledgementQuestion(label), false, `should not be a consent: ${label}`);
    }
  });

  test('the held vocabulary vetoes, whatever else the label looks like', () => {
    const vetoed: Array<[string, string]> = [
      ['work authorization', 'I agree to the privacy policy and confirm I am authorized to work in the United States.'],
      ['sponsorship', 'I acknowledge the candidate privacy notice and that I require visa sponsorship.'],
      ['age', 'I agree to the terms and conditions and confirm I am 18 years of age or older.'],
      ['degree', 'I accept the applicant terms and confirm my degree will be complete by June.'],
      ['criminal history', 'I agree to the code of conduct and declare I have no criminal convictions.'],
      ['background check', 'I agree to the privacy policy and authorize a background check.'],
      ['references', 'I acknowledge the privacy notice and consent to you contacting my references.'],
      ['health', 'I accept the terms and conditions and confirm I have no medical condition affecting this role.'],
      ['veteran', 'I agree to the privacy statement and confirm I am a protected veteran.'],
      ['EEO', 'I consent to processing of my personal data including my race and gender.'],
      ['truth attestation', 'I agree to the privacy policy and certify the information is true and complete.'],
      ['non-compete', 'I accept the applicant terms and confirm I am under no non-compete agreement.'],
      ['export control', 'I agree to the privacy notice and confirm my status under US export control laws.'],
      ['relocation', 'Do you consent to relocate?'],
      ['authorization grant', 'I authorize the processing of my personal data.'],
    ];
    for (const [what, label] of vetoed) {
      assert.ok(isHeldDeclarationLabel(label), `${what} must be recognised as held: ${label}`);
      assert.equal(isConsentAcknowledgementQuestion(label), false, `${what} must not be a consent: ${label}`);
    }
  });

  test('the veto runs first, so no consent wording can re-open a held label', () => {
    // The same sentence with and without the held clause. Only the clause differs, and only the
    // clause decides, which is what makes the boundary a property of the order rather than of how
    // the consent alternatives happen to be written today.
    assert.ok(isConsentAcknowledgementQuestion('I agree to the candidate privacy policy.'));
    assert.equal(isConsentAcknowledgementQuestion('I agree to the candidate privacy policy and confirm I am 18 or older.'), false);
  });

  test('an empty or whitespace label is nothing', () => {
    assert.equal(isConsentAcknowledgementQuestion(''), false);
    assert.equal(isConsentAcknowledgementQuestion('   '), false);
  });
});

describe('the two classes and the two grants', () => {
  test('each label is sorted into the classes whose grant it needs', () => {
    assert.deepEqual(consentAcknowledgementClasses('Privacy Statement'), ['privacy_and_terms']);
    assert.deepEqual(consentAcknowledgementClasses('Terms and Conditions'), ['privacy_and_terms']);
    assert.deepEqual(consentAcknowledgementClasses('Interview Code of Conduct'), ['conduct']);
    assert.deepEqual(
      consentAcknowledgementClasses('I agree to the candidate privacy notice and to the code of conduct.'),
      ['privacy_and_terms', 'conduct'],
    );
    assert.deepEqual(consentAcknowledgementClasses('Are you legally authorized to work in the US?'), []);
  });

  test('the licence names every grant it used, and the later date of the two', () => {
    const both = consentAcknowledgementLicence('I agree to the candidate privacy notice and to the code of conduct.', GRANTED);
    assert.ok(both);
    // Each grant is named with the class it belongs to, so a two-grant acceptance stays legible
    // even while both wordings carry the same date. The date is the LATER grant: that is when the
    // acceptance actually became licensed.
    assert.equal(
      both.version,
      `privacy_and_terms@${AUTOMATIC_CONSENT_ACCEPTANCE_VERSION} + conduct@${AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION}`,
    );
    assert.equal(both.granted_at, '2026-08-12T09:16:00.000Z');

    const privacyOnly = consentAcknowledgementLicence('Privacy Statement', GRANTED);
    assert.equal(privacyOnly?.granted_at, '2026-08-12T09:15:00.000Z');
  });

  test('a differently versioned pair is recorded as both sets of words', () => {
    const licence = consentAcknowledgementLicence('I agree to the candidate privacy notice and to the code of conduct.', {
      consent_acknowledgement_permission: { granted_at: '2026-08-12T09:15:00.000Z', version: 'A' },
      conduct_acknowledgement_permission: { granted_at: '2026-08-12T09:16:00.000Z', version: 'B' },
    });
    assert.equal(licence?.version, 'privacy_and_terms@A + conduct@B');
  });

  test('holding one grant never licenses the other class', () => {
    const privacyOnly: ApplicationProfileLike = { consent_acknowledgement_permission: GRANTED.consent_acknowledgement_permission };
    const conductOnly: ApplicationProfileLike = { conduct_acknowledgement_permission: GRANTED.conduct_acknowledgement_permission };
    assert.equal(consentAcknowledgementAnswer('Interview Code of Conduct', privacyOnly), null);
    assert.equal(consentAcknowledgementAnswer('Privacy Statement', conductOnly), null);
    assert.equal(consentAcknowledgementAnswer('Privacy Statement', privacyOnly)?.value, 'Yes');
    assert.equal(consentAcknowledgementAnswer('Interview Code of Conduct', conductOnly)?.value, 'Yes');
  });

  test('a compound acceptance names both permissions, not one collapsed string', () => {
    // Both versions are the same date today, so deduping on the version string alone collapsed a
    // two-grant acceptance to "2026-08-12" and the packet could not say which permissions were used.
    const licence = consentAcknowledgementLicence(
      'I agree to the candidate privacy notice and to the code of conduct.',
      GRANTED,
    );
    assert.equal(licence?.version, 'privacy_and_terms@2026-08-12 + conduct@2026-08-12');
    assert.equal(consentAcknowledgementLicence('Privacy Statement', GRANTED)?.version, 'privacy_and_terms@2026-08-12');
    assert.equal(consentAcknowledgementLicence('Interview Code of Conduct', GRANTED)?.version, 'conduct@2026-08-12');
  });

  test('the conduct permission is version-checked in its own right', () => {
    assert.equal(conductAcceptanceGranted({ automatic_conduct_acceptance_enabled: true }), false);
    assert.equal(conductAcceptanceGranted({
      automatic_conduct_acceptance_enabled: true,
      automatic_conduct_acceptance_consent_version: '2000-01-01',
    }), false);
    assert.equal(conductAcceptanceGranted({
      automatic_conduct_acceptance_enabled: true,
      automatic_conduct_acceptance_consent_version: AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION,
    }), true);
  });
});

describe('the permission gate', () => {
  test('no permission means no answer, whatever the label', () => {
    assert.equal(consentAcknowledgementAnswer('Privacy Statement', {}), null);
    assert.equal(consentAcknowledgementAnswer('Privacy Statement', GRANTED)?.value, 'Yes');
  });

  test('a stale consent version is not consent', () => {
    assert.equal(consentAcceptanceGranted(undefined), false);
    assert.equal(consentAcceptanceGranted({}), false);
    assert.equal(consentAcceptanceGranted({ automatic_consent_acceptance_enabled: true }), false);
    assert.equal(consentAcceptanceGranted({
      automatic_consent_acceptance_enabled: true,
      automatic_consent_acceptance_consent_version: '2000-01-01',
    }), false, 'a row agreeing to different words has not agreed to these');
    assert.equal(consentAcceptanceGranted({
      automatic_consent_acceptance_enabled: false,
      automatic_consent_acceptance_consent_version: AUTOMATIC_CONSENT_ACCEPTANCE_VERSION,
    }), false, 'a revocation is a revocation even with the current version still on the row');
    assert.equal(consentAcceptanceGranted({
      automatic_consent_acceptance_enabled: true,
      automatic_consent_acceptance_consent_version: AUTOMATIC_CONSENT_ACCEPTANCE_VERSION,
    }), true);
  });
});

describe('choosing the accepting option', () => {
  test('the plain pairs', () => {
    assert.equal(chooseConsentOption(['I agree', 'I do not agree']), 'I agree');
    assert.equal(chooseConsentOption(['I do not agree', 'I agree']), 'I agree');
    assert.equal(chooseConsentOption(['Yes', 'No']), 'Yes');
    assert.equal(chooseConsentOption(['Agree', 'Disagree']), 'Agree');
    assert.equal(chooseConsentOption(['I accept', 'I decline']), 'I accept');
    assert.equal(chooseConsentOption(['I consent', 'I do not consent']), 'I consent');
    assert.equal(chooseConsentOption(['I acknowledge', 'I decline to acknowledge']), 'I acknowledge');
    assert.equal(chooseConsentOption(['I have read and agree', 'I do not agree']), 'I have read and agree');
    // The employer's placeholder row is stripped before any of this, as everywhere else.
    assert.equal(chooseConsentOption(['Select...', 'I agree', 'I do not agree']), 'I agree');
    // A single-option list is the checkbox-shaped select, and it is unambiguous.
    assert.equal(chooseConsentOption(['I agree']), 'I agree');
  });

  test('a refusal is never mistaken for an acceptance, however much text it shares', () => {
    /* "I do not agree" contains "agree". A matcher that scored on overlap could select it, and the
     * result would be an application on which she appears to have refused the employer's privacy
     * notice. Refusal is tested first and wins outright. */
    assert.equal(chooseConsentOption(['I do not agree']), null);
    assert.equal(chooseConsentOption(['I do not agree', 'I decline']), null);
    assert.equal(chooseConsentOption(["I don't agree", 'I agree']), 'I agree');
  });

  test('anything ambiguous or unreadable selects nothing', () => {
    assert.equal(chooseConsentOption(['I agree', 'I accept']), null, 'two acceptances cannot be ranked');
    assert.equal(chooseConsentOption(['I agree', 'I do not agree', 'Ask me later']), null, 'an unreadable entry stops the list');
    assert.equal(chooseConsentOption(['Option A', 'Option B']), null);
    assert.equal(chooseConsentOption([]), null);
    assert.equal(chooseConsentOption(null), null);
    assert.equal(chooseConsentOption(undefined), null);
    // An option that states what is being agreed to is not one of the closed acceptance wordings,
    // and two of them are exactly the ambiguity this refuses.
    assert.equal(chooseConsentOption(['I agree to the privacy notice', 'I agree to the code of conduct']), null);
  });
});

describe('the value that goes into the control', () => {
  test('a control with no options takes the plain acceptance', () => {
    assert.equal(consentAcceptanceValue('Privacy Statement', GRANTED, null), 'Yes');
    assert.equal(consentAcceptanceValue('Privacy Statement', GRANTED, []), 'Yes');
  });

  test('a control with options takes one of its own, or nothing', () => {
    assert.equal(consentAcceptanceValue('Privacy Statement', GRANTED, ['I agree', 'I do not agree']), 'I agree');
    assert.equal(consentAcceptanceValue('Privacy Statement', GRANTED, ['I agree', 'I accept']), null);
  });

  test('no permission and the held class both return nothing', () => {
    assert.equal(consentAcceptanceValue('Privacy Statement', {}, null), null);
    assert.equal(consentAcceptanceValue('Are you legally authorized to work in the United States?', GRANTED, ['Yes', 'No']), null);
    assert.equal(consentAcceptanceValue('I certify that the information provided is true and complete', GRANTED, ['Yes', 'No']), null);
  });
});

/* ---------------------------------------------------------------------------------------------
 * THE COMPOUND CONSENT OPTION, measured 2026-08-13.
 *
 * Greenhouse renders consent checkboxes whose only option label is "Acknowledge/Confirm": one
 * option, two accepting verbs, joined by a slash. CONSENT_ACCEPTING_OPTION is anchored end to end
 * over SINGLE verbs, so that label is neither "acknowledge" nor "confirm" and matched no
 * alternative at all. chooseConsentOption(["Acknowledge/Confirm"]) returned null,
 * resolveProfileField reported matchedOption: false, and routes/submissionRunner.ts told the
 * applicant a consent Litos held every permission to accept had been left for her to finish.
 * Four packets.
 *
 * The anchoring is not the defect and is not relaxed. What changes is that an option made of
 * NOTHING BUT accepting verbs is read as an acceptance, with every part held to the same closed
 * vocabulary the whole option was held to before.
 * ------------------------------------------------------------------------------------------- */

describe('an option that joins two accepting verbs', () => {
  test('the accepting compounds, each as the only option a Greenhouse consent offers', () => {
    for (const label of [
      'Acknowledge/Confirm',
      'Acknowledge and Confirm',
      'I Agree/Accept',
      'I acknowledge and agree to the above',
      'Acknowledge/Confirm/Accept',
      'Confirm + Accept',
      'I agree or accept',
    ]) {
      assert.equal(chooseConsentOption([label]), label, `${label} is an acceptance`);
      assert.equal(consentAcceptanceValue('Privacy Statement', GRANTED, [label]), label);
    }
  });

  test('an ampersand or a comma is erased before the split, so those spellings still fail closed', () => {
    /* MEASURED WHILE THIS WAS BEING WRITTEN, and recorded rather than quietly worked around.
     *
     * The joiner class is [/&+,] plus the two coordinators, but comparableOption runs first and its
     * class is [^a-z0-9.+/]: it keeps '/', '.' and '+', and turns EVERYTHING else into a space. So
     * '&' and ',' never reach the split - "Acknowledge & Confirm" arrives as "acknowledge confirm",
     * two accepting verbs with nothing between them but whitespace.
     *
     * Splitting on whitespace as well was considered and rejected. CONSENT_ACCEPTING_OPTION admits
     * an optional "i " prefix, so "I Acknowledge & I Confirm" would split into a bare "i" that is
     * not an accepting verb, and the rule would be no more complete while being much easier to
     * widen by accident. These two spellings are handed back to the applicant, which is exactly
     * what happened before this change, on a consent that is real work for her and not a wrong
     * answer given in her name. */
    assert.equal(comparableOption('Acknowledge & Confirm'), 'acknowledge confirm');
    assert.equal(comparableOption('Agree, Accept'), 'agree accept');
    assert.equal(chooseConsentOption(['Acknowledge & Confirm']), null);
    assert.equal(chooseConsentOption(['Agree, Accept']), null);
  });

  test('a compound sits beside a refusal the same way a single verb does', () => {
    assert.equal(chooseConsentOption(['Acknowledge/Confirm', 'Decline']), 'Acknowledge/Confirm');
    assert.equal(chooseConsentOption(['I do not agree', 'Acknowledge and Confirm']), 'Acknowledge and Confirm');
    // Two acceptances still cannot be ranked, compound or not.
    assert.equal(chooseConsentOption(['Acknowledge/Confirm', 'I agree']), null);
  });

  test('EVERY part has to be an accepting verb, and a refusing token anywhere ends it', () => {
    for (const label of [
      // A refusing token in either part. isConsentRefusingWording is tested over the whole key
      // before the split and over every part after it, so neither position can get through.
      'Acknowledge/Decline',
      'Decline/Acknowledge',
      'Agree/Disagree',
      'Confirm or Reject',
      'Yes and No',
      'I acknowledge but do not agree',
      'Accept/Opt out',
      // A part that is simply not an accepting verb. This is the line that keeps the rule from
      // being a loosening: "continue", "submit" and "next" are what a compound usually joins.
      'Accept and Continue',
      'Acknowledge/Submit',
      'Read/Confirm',
      'Confirm and Send',
      // And a compound of two things that are neither.
      'Option A/Option B',
    ]) {
      assert.equal(chooseConsentOption([label]), null, `${label} must not be read as an acceptance`);
    }
  });

  test('the single-verb wordings this vocabulary always read are untouched', () => {
    // "read and agree" carries a coordinator and is a SINGLE accepting phrase the anchored regex
    // already spells out. Split on "and" it would yield "read", which is not an accepting verb, so
    // the whole key is asked before the compound rule ever runs. This is that ordering, pinned.
    assert.equal(chooseConsentOption(['I have read and agree']), 'I have read and agree');
    assert.equal(chooseConsentOption(['Read and accept']), 'Read and accept');
    assert.equal(chooseConsentOption(['I have read and acknowledged']), 'I have read and acknowledged');
    assert.equal(chooseConsentOption(['I agree to the above']), 'I agree to the above');
    assert.equal(chooseConsentOption(['Yes I agree']), 'Yes I agree');
  });

  test('a stored compound acceptance is still recognised as one on the next run', () => {
    /* THE HALF THAT MAKES THIS A REPAIR RATHER THAN A NEW DIVERGENCE.
     *
     * chooseConsentOption selecting "Acknowledge/Confirm" is worth nothing on its own:
     * refreshKnownQuestionAnswers asks the SAME question of an answer already on a packet, and had
     * the two disagreed, the next run would have recomputed this control to the bare "Yes" that is
     * on no such control's list. That is the prepare-versus-submit divergence, reached from the
     * other side. One vocabulary, two callers. */
    assert.equal(isConsentAcceptingWording('Acknowledge/Confirm'), true);
    assert.equal(isConsentAcceptingWording('Acknowledge and Confirm'), true);
    assert.equal(isConsentAcceptingWording('I Agree/Accept'), true);
    assert.equal(isConsentAcceptingWording('Acknowledge/Decline'), false);
    assert.equal(isConsentAcceptingWording('Accept and Continue'), false);
    // And the refusal predicate is unmoved by any of it.
    assert.equal(isConsentRefusingWording('Acknowledge/Decline'), true);
    assert.equal(isConsentRefusingWording('Acknowledge/Confirm'), false);
  });

  test('the slash survives comparableOption, and Spring/Summer 2028 still resolves', () => {
    /* WHY THE SPLIT IS IN THE CONSENT RULE AND NOT IN comparableOption, pinned so that the easier
     * edit cannot be made later without this failing.
     *
     * comparableOption's character class is [^a-z0-9.+/]: it deliberately KEEPS the slash. That is
     * load-bearing a long way from consent. Greenhouse's standard graduation term list offers
     * "Spring/Summer 2028", optionCoversMonthYear reaches that entry's year across the slash, and
     * the applicant graduates in May 2028. Splitting on '/' globally would take the season run
     * apart and put a May graduation into "Winter 2028", a term that ends six months before she
     * finishes - which is the exact answer two live Jump Trading packets carried on 2026-08-13. */
    assert.equal(comparableOption('Spring/Summer 2028'), 'spring/summer 2028');
    assert.equal(comparableOption('Acknowledge/Confirm'), 'acknowledge/confirm');
    assert.equal(optionCoversMonthYear('Spring/Summer 2028', 5, 2028), true);
    assert.equal(
      chooseClosestOption(graduationDateLadder('May 2028', 2028), [
        'Winter 2028', 'Spring/Summer 2028', 'Fall 2028',
      ]),
      'Spring/Summer 2028',
    );
  });
});

describe("Teamtailor's platform-default consent sentence", () => {
  /* MEASURED LIVE, 2026-08-20, on the account's real Teamtailor rows (Fully, and Uproar by
   * Moburst). The run filled everything and parked on "This company asks you to confirm its
   * applicant privacy terms before sending" because this exact sentence, the platform's own
   * default wording on the candidate[consent_given] control, classified as nothing.
   *
   * Two grammar facts sit inside it. "personal details" is the noun Teamtailor uses where the
   * data-handling vocabulary knew only personal data and personal information, so a tenant whose
   * label names no document at all needs the classifier to know the spelling. And the purpose
   * clause "to be able to process my job application" carries "able", which no filler word and no
   * scaffolding span accounted for, so coverage held the label even when the Privacy Policy had
   * already classified it.
   *
   * The employer's own name sits mid-clause ("confirm that Fully store..."), so every test here
   * passes employerContext the way the resolvers do: the frozen employer line composed by
   * applicationContextForQuestionResolution, with the ordinary prose around it. */
  const TEAMTAILOR_DEFAULT = (company: string) =>
    `By submitting this application, I agree that I have read the Privacy Policy and confirm that ${company} store my personal details to be able to process my job application.`;
  const employerContext = (company: string) =>
    `Group Financial Controller\nBuild the finance function.\n[LITOS FROZEN JOB EMPLOYER] ${company}`;

  test('the exact live sentence classifies as a privacy consent, for both live tenants', () => {
    for (const company of ['Fully', 'Uproar by Moburst']) {
      assert.deepEqual(
        consentAcknowledgementClasses(TEAMTAILOR_DEFAULT(company), employerContext(company)),
        ['privacy_and_terms'],
        company,
      );
    }
  });

  test('the close tenant variant "so that <Company> can process my job application" classifies too', () => {
    const label = 'By submitting this application, I agree that I have read the Privacy Policy and confirm that Fully store my personal details so that Fully can process my job application.';
    assert.deepEqual(consentAcknowledgementClasses(label, employerContext('Fully')), ['privacy_and_terms']);
  });

  test('"personal details" is a data-handling subject in its own right, with no document named', () => {
    // The vocabulary half on its own: a tenant wording that never says Privacy Policy still has to
    // classify off the data-handling act, and before the fix this returned [].
    assert.deepEqual(
      consentAcknowledgementClasses(
        'I confirm that Fully store my personal details to be able to process my job application.',
        employerContext('Fully'),
      ),
      ['privacy_and_terms'],
    );
  });

  test('without the employer context the tenant name is unaccounted and the label holds', () => {
    // Fail-closed pin: the company name is absorbed only because the caller proves it belongs
    // here. No context, no proof, hold. This is the same direction the rule has always failed in.
    assert.deepEqual(consentAcknowledgementClasses(TEAMTAILOR_DEFAULT('Fully')), []);
  });

  test('the veto still runs first: welding a truth attestation onto the same sentence holds it', () => {
    const welded = `${TEAMTAILOR_DEFAULT('Fully').slice(0, -1)} and certify that the information provided is true.`;
    assert.deepEqual(consentAcknowledgementClasses(welded, employerContext('Fully')), []);
  });

  test('a second document smuggled into the clause still holds the label', () => {
    // The coverage rule must place the WHOLE clause, not stop reading it. A conduct-family stray
    // inside the same sentence survives to be counted, exactly as the boundary tests demand.
    const smuggled = 'By submitting this application, I agree that I have read the Privacy Policy and the employee handbook and confirm that Fully store my personal details to be able to process my job application.';
    assert.deepEqual(consentAcknowledgementClasses(smuggled, employerContext('Fully')), []);
  });

  test('with the standing permission the licence covers the live sentence; without it, null', () => {
    const licence = consentAcknowledgementLicence(TEAMTAILOR_DEFAULT('Fully'), GRANTED, employerContext('Fully'));
    assert.ok(licence);
    assert.equal(licence.version, `privacy_and_terms@${AUTOMATIC_CONSENT_ACCEPTANCE_VERSION}`);
    assert.equal(licence.granted_at, '2026-08-12T09:15:00.000Z');
    assert.equal(consentAcknowledgementLicence(TEAMTAILOR_DEFAULT('Fully'), {}, employerContext('Fully')), null);
  });
});
