import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  consentAcknowledgementClasses,
  consentAcknowledgementLicence,
  isConsentAcknowledgementQuestion,
  isHeldDeclarationLabel,
  consentAcknowledgementAnswer,
  type ApplicationProfileLike,
} from './questionDiscovery';
import { chooseConsentOption, consentAcceptanceValue } from './profileFieldResolution';
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
