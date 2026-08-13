import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  consentAcknowledgementAnswer,
  consentAcknowledgementClasses,
  resolveKnownAnswer,
  type ApplicationProfileLike,
} from './questionDiscovery';
import {
  AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION,
  AUTOMATIC_CONSENT_ACCEPTANCE_VERSION,
} from './automationConsent';

/* A CONSENT WRITTEN AS AN INSTRUCTION, and the clause that told it why.
 *
 * Jump Trading ships this control on its Greenhouse form, and this is the string exactly as the
 * resolver stores and lowercases it (generated_resumes 928e0c9a and f4f278d2, account a18f774b,
 * 2026-08-13). Both packets sat at needs_attention with it empty and required, on an account whose
 * standing consent permission was granted on 2026-08-12.
 *
 * WHAT WAS NOT WRONG, because the first diagnosis said it was and cost a session: the accepting verb.
 * `review` has always been in CONSENT_ACT, CONSENT_ACKNOWLEDGEMENT_SENTENCE matched this label on
 * main, the held-declaration veto did not fire, and "notice at collection" was already an accepted
 * privacy document. Truncating the label after "collection" was accepted on unmodified source.
 *
 * WHAT WAS WRONG: coverage completeness. After the document span and its qualifier were blanked,
 * `learn` and `how` were left unaccounted for, and one unexplained token holds the label. The
 * purpose clause is now accounted for as consent scaffolding, in the same place and by the same
 * mechanism as the accepting verbs.
 */
const JUMP_TRADING_LABEL = 'review our notice at collection to learn how we will process your personal data.';

const CONSENT_ONLY: ApplicationProfileLike = {
  consent_acknowledgement_permission: {
    granted_at: '2026-08-12T13:15:07.272Z',
    version: AUTOMATIC_CONSENT_ACCEPTANCE_VERSION,
  },
};
const BOTH_GRANTED: ApplicationProfileLike = {
  ...CONSENT_ONLY,
  conduct_acknowledgement_permission: {
    granted_at: '2026-08-12T13:15:07.272Z',
    version: AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION,
  },
};

describe('an instruction-shaped consent naming an accepted document', () => {
  test('the Jump Trading label is accepted under the standing consent permission', () => {
    assert.deepEqual(consentAcknowledgementClasses(JUMP_TRADING_LABEL), ['privacy_and_terms']);
    assert.equal(consentAcknowledgementAnswer(JUMP_TRADING_LABEL, CONSENT_ONLY)?.value, 'Yes');
    assert.deepEqual(
      resolveKnownAnswer(JUMP_TRADING_LABEL, 'checkbox', CONSENT_ONLY, undefined),
      { value: 'Yes' },
    );
  });

  test('the same label is still held with no permission granted', () => {
    assert.equal(consentAcknowledgementAnswer(JUMP_TRADING_LABEL, {}), null);
    const held = resolveKnownAnswer(JUMP_TRADING_LABEL, 'checkbox', {}, undefined);
    assert.ok(held && 'skipReason' in held, 'an ungranted account must be handed the question back');
  });

  test('the other comprehension verbs employers use read the same way', () => {
    for (const label of [
      'please review our privacy policy to understand how we use your personal information',
      'read our candidate privacy notice to see how we store your personal data',
      'review our notice at collection to learn more about how we will process your personal data',
    ]) {
      assert.deepEqual(consentAcknowledgementClasses(label), ['privacy_and_terms'], label);
    }
  });
});

describe('the boundary the purpose clause must not move', () => {
  test('an instruction naming a conduct document is not licensed by the consent permission alone', () => {
    const label = 'review our code of conduct to learn how we will process your personal data.';
    assert.deepEqual(consentAcknowledgementClasses(label), ['privacy_and_terms', 'conduct']);
    assert.equal(consentAcknowledgementAnswer(label, CONSENT_ONLY), null);
    assert.equal(consentAcknowledgementAnswer(label, BOTH_GRANTED)?.value, 'Yes');

    const bare = 'review our code of conduct.';
    assert.deepEqual(consentAcknowledgementClasses(bare), ['conduct']);
    assert.equal(consentAcknowledgementAnswer(bare, CONSENT_ONLY), null);
  });

  test('no factual declaration becomes acceptable, whatever it is instructed to review', () => {
    for (const label of [
      // The welded shape: one tick, a document and a claim about her.
      'review our notice at collection to learn how we will process your personal data,'
        + ' and confirm that you are legally authorized to work in the united states.',
      'i certify that the information i have provided is true and complete.',
      'will you require sponsorship for work authorization in the future?',
      'are you 18 years of age or older?',
      'i authorize a background check',
      'i authorize you to contact my references',
      'do you consent to relocate?',
      'please review the veteran self-identification form to learn how we report your status',
    ]) {
      assert.deepEqual(consentAcknowledgementClasses(label), [], label);
      assert.equal(consentAcknowledgementAnswer(label, BOTH_GRANTED), null, label);
    }
  });

  test('a document nothing placed still holds, purpose clause or not', () => {
    for (const label of [
      'please review our employee handbook to learn how we expect you to behave',
      'review our insider trading policy to learn how we monitor personal accounts',
      'i have read the privacy policy and the code of business conduct',
    ]) {
      assert.deepEqual(consentAcknowledgementClasses(label), [], label);
    }
  });

  test('a bare comprehension verb is not scaffolding on its own', () => {
    // `learn` and `how` are accounted for only inside the clause, never as free-floating filler.
    assert.deepEqual(
      consentAcknowledgementClasses('i agree to the privacy policy and to how you learn about me'),
      [],
    );
  });
});
