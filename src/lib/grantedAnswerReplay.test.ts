/* THE HOLD, AND WHAT IT MUST NOT COST.
 *
 * Two properties, and the second is the one that can actually go wrong:
 *
 *   1. While exact control targeting is undeployed, a GRANTED and CURRENT consent permission does
 *      not become a licence, so every consent label resolves exactly as it did before PR 502.
 *   2. When it IS deployed and the licence is live, a truth attestation, an EEO question, a health
 *      or accommodation disclosure and a work-authorization declaration STILL fail closed.
 *
 * Property 2 is asserted with the grant SWITCHED ON, because that is the only configuration in
 * which it can fail. Asserting it with the permission absent would be asserting nothing: the
 * adversary has to be capable of winning, and an ungranted profile cannot accept anything by
 * construction.
 *
 * Both sides of the gate are exercised, so the day stratus-browser-cloud PR 50 deploys, flipping
 * the single `false` in grantedAnswerReplay.ts needs no test rewritten.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  acknowledgementPermissionsFor,
  consentAcceptanceMayReachControls,
  exactControlTargetingDeployed,
  workEligibilityReplayMayReachControls,
  type AcknowledgementPermissionRow,
} from './grantedAnswerReplay';
import {
  AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION,
  AUTOMATIC_CONSENT_ACCEPTANCE_VERSION,
  conductAcceptanceGranted,
  consentAcceptanceGranted,
} from './automationConsent';
import {
  frozenJobEmployerContext,
  resolveKnownAnswer,
  type ApplicationProfileLike,
} from './questionDiscovery';
import { resolveProfileField } from './profileFieldResolution';

process.env.ENCRYPTION_KEY ??= 'test-encryption-key-at-least-32-chars-long';

const GRANTED_AT = new Date('2026-08-12T09:15:00.000Z');

/* A row that has granted BOTH permissions, on the CURRENT version. Nothing about this row is what
 * holds the acceptance back: consentAcceptanceGranted and conductAcceptanceGranted both say yes,
 * which is asserted below so the fixture cannot quietly become the reason. */
const FULLY_GRANTED: AcknowledgementPermissionRow = {
  automatic_consent_acceptance_enabled: true,
  automatic_consent_acceptance_consented_at: GRANTED_AT,
  automatic_consent_acceptance_consent_version: AUTOMATIC_CONSENT_ACCEPTANCE_VERSION,
  automatic_conduct_acceptance_enabled: true,
  automatic_conduct_acceptance_consented_at: GRANTED_AT,
  automatic_conduct_acceptance_consent_version: AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION,
};

const GRANTED_PREDICATES = {
  consent: consentAcceptanceGranted,
  conduct: conductAcceptanceGranted,
  consentVersion: AUTOMATIC_CONSENT_ACCEPTANCE_VERSION,
  conductVersion: AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION,
};

function permissions(row: AcknowledgementPermissionRow | null | undefined, mayReach: boolean) {
  return acknowledgementPermissionsFor(row, GRANTED_PREDICATES, mayReach);
}

function answer(label: string, ap: ApplicationProfileLike, inputType = 'checkbox'): string | null {
  const resolved = resolveKnownAnswer(label, inputType, ap, frozenJobEmployerContext('Acme'));
  return resolved && 'value' in resolved ? resolved.value : null;
}

function held(label: string, ap: ApplicationProfileLike, inputType = 'checkbox'): string | null {
  const resolved = resolveKnownAnswer(label, inputType, ap, frozenJobEmployerContext('Acme'));
  return resolved && 'skipReason' in resolved ? resolved.skipReason : null;
}

/** The two IMC labels that blocked a real run, verbatim from its blockers. */
const IMC_PRIVACY = 'Privacy Statement';
const IMC_CONDUCT = 'Interview Code of Conduct';

/* THE CLASS THAT MUST NEVER BE ACCEPTED, whatever any permission says. The four the scope addition
 * named, plus the two the original boundary was built around. Each is a claim about the applicant
 * rather than an agreement to a document. */
const NEVER_ACCEPTED: Array<[string, string]> = [
  ['truth attestation', 'I certify that the information provided is true and complete'],
  ['truth attestation, second wording', 'I confirm to the best of my knowledge that the details above are correct.'],
  ['EEO race', 'please select your racial/ethnic background'],
  ['veteran status', 'Are you a protected veteran?'],
  ['disability', 'Do you have a disability or history of a disability?'],
  ['health disclosure', 'I confirm I have no medical condition that would prevent me performing this role.'],
  ['interview accommodation', 'Do you require any accommodation for the interview process?'],
  ['work authorization', 'Are you legally authorized to work in the United States?'],
  ['sponsorship', 'Will you now, or in the future, require sponsorship for employment visa status?'],
  ['criminal history', 'Have you ever been convicted of a felony?'],
  ['background authorization', 'I authorize Acme to conduct a background check and to contact my references.'],
];

describe('the gate itself', () => {
  test('it is one predicate, and both classes read it', () => {
    // Two switches is how one class gets opened alone. The point of the module is that they cannot.
    assert.equal(consentAcceptanceMayReachControls(), exactControlTargetingDeployed());
    assert.equal(workEligibilityReplayMayReachControls(), exactControlTargetingDeployed());
  });

  test('it is CLOSED today, because stratus-browser-cloud PR 50 is not deployed', () => {
    /* This assertion is expected to be changed, once, by the person who flips the switch, and it is
     * here so that flipping it is a deliberate edit to a line that says what it means rather than a
     * silent behaviour change nothing records. */
    assert.equal(exactControlTargetingDeployed(), false);
  });
});

describe('with the gate closed, a granted permission does not become a licence', () => {
  test('the fixture really has granted both, so the hold is the gate and not the row', () => {
    // Without this the whole file could be passing because the fixture forgot to grant anything.
    assert.equal(consentAcceptanceGranted(FULLY_GRANTED), true);
    assert.equal(conductAcceptanceGranted(FULLY_GRANTED), true);
  });

  test('both licences are withheld', () => {
    const closed = permissions(FULLY_GRANTED, false);
    assert.equal(closed.consent_acknowledgement_permission, undefined);
    assert.equal(closed.conduct_acknowledgement_permission, undefined);
  });

  test('and the consent labels that PR 502 unblocked go back to the applicant', () => {
    /* The exact pre-502 behaviour: a named refusal, not an answer and not silence. These two are
     * the ones that blocked the live IMC run, so this is the cost of the hold stated plainly. */
    const ap = permissions(FULLY_GRANTED, false) as ApplicationProfileLike;
    assert.equal(answer(IMC_PRIVACY, ap), null);
    assert.equal(answer(IMC_CONDUCT, ap), null);
    assert.match(held(IMC_PRIVACY, ap) ?? '', /privacy notice/);
    assert.match(held(IMC_CONDUCT, ap) ?? '', /code of conduct/);
  });

  test('the grant is HELD, never revoked: the row keeps her decision, its date and its version', () => {
    /* The difference that matters to the applicant. A gate that cleared the columns would make her
     * re-consent on the day it opens, and would destroy the date the permission is defined by. */
    assert.equal(FULLY_GRANTED.automatic_consent_acceptance_enabled, true);
    assert.equal(FULLY_GRANTED.automatic_consent_acceptance_consented_at, GRANTED_AT);
    assert.equal(FULLY_GRANTED.automatic_consent_acceptance_consent_version, AUTOMATIC_CONSENT_ACCEPTANCE_VERSION);
    // And the same row, once the gate opens, yields the licence with the ORIGINAL date on it.
    const opened = permissions(FULLY_GRANTED, true);
    assert.equal(opened.consent_acknowledgement_permission?.granted_at, GRANTED_AT.toISOString());
    assert.equal(opened.conduct_acknowledgement_permission?.granted_at, GRANTED_AT.toISOString());
  });
});

describe('with the gate open, the feature works and the boundary still holds', () => {
  /* THE ADVERSARY THAT CAN WIN. Everything below runs with both licences live, which is the only
   * configuration in which a factual declaration could be accepted by mistake. */
  const LIVE = permissions(FULLY_GRANTED, true) as ApplicationProfileLike;

  test('the licences are live, so the tests below are not vacuous', () => {
    assert.equal(LIVE.consent_acknowledgement_permission?.version, AUTOMATIC_CONSENT_ACCEPTANCE_VERSION);
    assert.equal(LIVE.conduct_acknowledgement_permission?.version, AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION);
    // And they do their job: the two blocked consents are accepted.
    assert.equal(answer(IMC_PRIVACY, LIVE), 'Yes');
    assert.equal(answer(IMC_CONDUCT, LIVE), 'Yes');
  });

  test('a truth attestation, EEO, health, accommodation and work authorization all still fail closed', () => {
    for (const [what, label] of NEVER_ACCEPTED) {
      assert.notEqual(answer(label, LIVE), 'Yes', `${what} must never be accepted: ${label}`);
    }
  });

  test('and none of them can be agreed to out of an option list either', () => {
    /* The option list is where an "I agree" wording makes a declaration LOOK like a consent. The
     * decision is made on the label before any list is read, so the list cannot change it. */
    for (const [what, label] of NEVER_ACCEPTED) {
      const resolved = resolveProfileField(
        { label, inputType: 'select', options: ['I agree', 'I do not agree'] },
        LIVE,
        frozenJobEmployerContext('Acme'),
      );
      assert.ok(
        resolved === null || resolved.value !== 'I agree',
        `${what} must not be agreed to from an option list: ${label}`,
      );
    }
  });

  test('the permission is invisible to every one of them, not merely refused by a second rule', () => {
    /* The stronger property, and the one that survives a future widening of the consent grammar:
     * the same label resolves to the same thing with the licences and without them. */
    const withoutLicence = permissions(FULLY_GRANTED, false) as ApplicationProfileLike;
    for (const [what, label] of NEVER_ACCEPTED) {
      assert.equal(
        answer(label, LIVE),
        answer(label, withoutLicence),
        `${what} must resolve identically with and without the licence: ${label}`,
      );
      assert.equal(
        held(label, LIVE),
        held(label, withoutLicence),
        `${what} must be held identically with and without the licence: ${label}`,
      );
    }
  });

  test('a document nobody classified still fails closed under both licences', () => {
    /* The property 5fc9a2a's own commit message calls the thing that makes the split safe. A label
     * carrying a second, unplaceable document is held rather than accepted. */
    const stray = 'I accept the Privacy Statement and the Supplier Expectations Handbook.';
    assert.equal(answer(stray, LIVE), null);
  });
});

describe('an ungranted account is unchanged by any of this', () => {
  test('no permission, no licence, on either side of the gate', () => {
    const none: AcknowledgementPermissionRow = {};
    for (const mayReach of [false, true]) {
      const derived = permissions(none, mayReach);
      assert.equal(derived.consent_acknowledgement_permission, undefined);
      assert.equal(derived.conduct_acknowledgement_permission, undefined);
    }
  });

  test('a STALE consent version is not a grant, gate open or closed', () => {
    const stale: AcknowledgementPermissionRow = {
      ...FULLY_GRANTED,
      automatic_consent_acceptance_consent_version: '2026-01-01',
    };
    assert.equal(permissions(stale, true).consent_acknowledgement_permission, undefined);
    // The conduct grant on the same row is untouched by the other one going stale.
    assert.ok(permissions(stale, true).conduct_acknowledgement_permission);
  });

  test('a null row does not throw', () => {
    assert.deepEqual(permissions(null, true), {
      consent_acknowledgement_permission: undefined,
      conduct_acknowledgement_permission: undefined,
    });
  });
});
