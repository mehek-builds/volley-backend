/* THE HOLD, WHAT IT COSTS, AND WHAT IT DOES NOT COVER.
 *
 * THIS FILE PREVIOUSLY CLAIMED SOMETHING FALSE, and the correction is the reason it reads as it
 * does now. It said a work-authorization declaration "still fails closed" under the licence. It
 * does not. It resolves to "Yes" on both sides of the gate, and the claim passed only because the
 * fixture carried no stored facts AND the helpers called resolveKnownAnswer with FOUR arguments
 * while every production site passes SIX, the two omitted ones being exactly what
 * workEligibilityAnswer refuses on. An adversary that cannot win, measured in a shape no caller
 * uses. Both are fixed here, and the properties are now stated separately because they are
 * different properties:
 *
 *   1. While exact control targeting is undeployed, a GRANTED and CURRENT consent permission does
 *      not become a licence, so every consent label resolves exactly as it did before PR 502. That
 *      is no longer the state of the world, and it is still asserted: the gate opened on 2026-08-13
 *      and this is the behaviour the switch buys back if the runner ever regresses, so it is driven
 *      by the injected `mayReach = false` rather than by the deployment.
 *   2. When the licence IS live, some declarations are never answered at all, and others are
 *      answered legitimately out of declarations she made herself. What holds for ALL of them is
 *      that the licence is INVISIBLE: the same label resolves to the same thing with it and
 *      without. That is the property, not "everything is held".
 *   3. Work authorization and sponsorship are NOT held by this gate. That is pinned in its own
 *      describe block, named as known-open rather than hidden, because the second predicate is
 *      declared and unwired.
 *
 * Everything runs against the owner's real production profile shape and the six-argument call, so
 * the adversary is capable of winning throughout.
 *
 * Both sides of the gate are exercised, and that claim was tested on 2026-08-13 when
 * stratus-browser-cloud PR 50 deployed and the switch was flipped. What it bought, exactly: of the
 * twenty tests here, NINETEEN passed untouched across the flip, including every test that measures
 * what a label resolves to. One failed, and it is the one written to fail. It asserted the value of
 * the switch itself and carried a note saying it "is expected to be changed, once, by the person who
 * flips the switch". Updating it is the recorded act of flipping, not a rewrite forced by the flip.
 *
 * The distinction is worth keeping straight, because the sentence in grantedAnswerReplay.ts that
 * said "nothing needs rewriting to flip it" overreached by exactly this one line. No BEHAVIOURAL
 * test needed rewriting. The state-of-the-world tripwire did, and that is what a tripwire is for. If
 * that assertion had also passed across the flip, it would have been the useless kind of test.
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
import { postingCountryFromJobContext } from './jobLocation';

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

/* THE PROFILE PRODUCTION ACTUALLY RESOLVES AGAINST, not an empty object.
 *
 * The first version of this file used `{}` plus the two licences, and that made every boundary
 * assertion below vacuous: with nothing on file, a work-authorization question has nothing to
 * answer FROM, so it was refused for a reason that had nothing to do with the permission. The
 * fixture is now the owner's real production shape, measured off application_profile on
 * 2026-08-12, so the adversary can win.
 */
const STORED_FACTS: ApplicationProfileLike = {
  work_authorized: true,
  needs_sponsorship: true,
  eeo_prefs: {
    race: 'South Asian',
    gender: 'Female',
    veteran_status: 'Decline to self-identify',
    disability_status: 'Decline to self-identify',
  },
  work_eligibility_by_country: [
    { country_code: 'US', authorized_now: true, needs_sponsorship_now: false, needs_sponsorship_future: true },
  ],
};

/* AND THE ARGUMENT SHAPE PRODUCTION ACTUALLY USES.
 *
 * Every live call site passes SIX arguments. The first version of this file passed four, and the
 * two it omitted, postingCountry and postingCountryCode, are the exact parameters
 * workEligibilityAnswer refuses on when they are absent. So the omission WAS the refusal: the file
 * claimed the work-authorization class fails closed and was in fact measuring an argument shape no
 * caller uses. Every helper here now passes six, built the way the runner builds them. */
const JD = frozenJobEmployerContext('Acme');
const POSTING_COUNTRY = postingCountryFromJobContext({
  location: 'New York, NY, United States',
  country: 'United States',
});
const POSTING_COUNTRY_CODE = 'US';

function resolve(label: string, ap: ApplicationProfileLike, inputType = 'checkbox') {
  return resolveKnownAnswer(label, inputType, ap, JD, POSTING_COUNTRY, POSTING_COUNTRY_CODE);
}

function answer(label: string, ap: ApplicationProfileLike, inputType = 'checkbox'): string | null {
  const resolved = resolve(label, ap, inputType);
  return resolved && 'value' in resolved ? resolved.value : null;
}

function held(label: string, ap: ApplicationProfileLike, inputType = 'checkbox'): string | null {
  const resolved = resolve(label, ap, inputType);
  return resolved && 'skipReason' in resolved ? resolved.skipReason : null;
}

/** What a control with an option list would actually receive. */
function selected(label: string, ap: ApplicationProfileLike, options: string[]) {
  return resolveProfileField(
    { label, inputType: 'select', options },
    ap,
    JD,
    POSTING_COUNTRY,
    POSTING_COUNTRY_CODE,
  );
}

/** The two IMC labels that blocked a real run, verbatim from its blockers. */
const IMC_PRIVACY = 'Privacy Statement';
const IMC_CONDUCT = 'Interview Code of Conduct';

/* WHAT EACH CLASS ACTUALLY DOES, MEASURED, rather than the single sentence this file used to
 * claim. The first version said every one of these "fails closed". That was FALSE, and it passed
 * only because the fixture had nothing on file and the helper used the wrong argument count.
 *
 * Measured with both licences live, the production six-argument shape and the profile above:
 *
 *   truth attestation        skip     never answered
 *   health / accommodation   null     never answered
 *   criminal / background    null     never answered
 *   unclassified document    null     never answered
 *   EEO race                 "South Asian"                filled, from HER OWN stored claim
 *   EEO veteran / disability "Decline to self-identify"   filled, from HER OWN stored opt-out
 *   work authorization       "Yes"    filled, from her stored declaration. NOT held by this gate.
 *   sponsorship              "Yes"    filled, from her stored declaration. NOT held by this gate.
 *
 * So there are two different properties here and they need two different tests. Some classes are
 * never answered at all. Others ARE answered, legitimately, out of declarations she made herself,
 * and the property that matters for them is that the CONSENT PERMISSION is invisible to them: the
 * same label resolves to the same thing with the licences and without.
 */

/** Never answered by anything, permission or no permission. */
const NEVER_ANSWERED: Array<[string, string]> = [
  ['truth attestation', 'I certify that the information provided is true and complete'],
  ['truth attestation, second wording', 'I confirm to the best of my knowledge that the details above are correct.'],
  ['health disclosure', 'I confirm I have no medical condition that would prevent me performing this role.'],
  ['interview accommodation', 'Do you require any accommodation for the interview process?'],
  ['criminal history', 'Have you ever been convicted of a felony?'],
  ['background authorization', 'I authorize Acme to conduct a background check and to contact my references.'],
];

/** Answered from her own stored declaration. The permission must be invisible to every one. */
const ANSWERED_FROM_HER_OWN_RECORD: Array<[string, string, string]> = [
  ['EEO race', 'please select your racial/ethnic background', 'South Asian'],
  ['EEO veteran', 'Are you a protected veteran?', 'Decline to self-identify'],
  ['EEO disability', 'Do you have a disability or history of a disability?', 'Decline to self-identify'],
  ['work authorization', 'Are you legally authorized to work in the United States?', 'Yes'],
  ['sponsorship', 'Will you now, or in the future, require sponsorship for employment visa status?', 'Yes'],
];

describe('the gate itself', () => {
  test('it is one predicate, and both classes read it', () => {
    // Two switches is how one class gets opened alone. The point of the module is that they cannot.
    assert.equal(consentAcceptanceMayReachControls(), exactControlTargetingDeployed());
    assert.equal(workEligibilityReplayMayReachControls(), exactControlTargetingDeployed());
  });

  test('it is OPEN, because stratus-browser-cloud PR 50 is merged and deployed', () => {
    /* THIS IS THE ONE ASSERTION THE FLIP CHANGED, and changing it is the act, not a casualty of it.
     * The line it replaced asserted `false` and carried the note that it "is expected to be changed,
     * once, by the person who flips the switch", so that opening the gate is a deliberate edit to a
     * line that says what it means rather than a silent behaviour change nothing records. That is
     * what happened here, and this is the line saying so.
     *
     * Merged as 0572a94ccc79a196ea6f9a37c51597ff62a81c35, deployed to Production 2026-08-13.
     *
     * Note what this test is and is not. It is a tripwire on the state of the world, so that neither
     * opening nor closing this gate can happen without someone editing a sentence about why. It is
     * NOT evidence that the runner is fixed: no test in this repo can be, because the defect and its
     * repair are both in Chromium, in another service. The evidence for the repair is PR 50's own
     * replay suite. The evidence THIS file carries is about the backend's behaviour on both sides of
     * the switch, which is the next test and every test below it. */
    assert.equal(exactControlTargetingDeployed(), true);
  });

  test('the production call, with mayReach DEFAULTED, reads the gate and not a literal', () => {
    /* THE PATH NOTHING ELSE IN THIS FILE TOUCHES. Every other test injects `mayReach`, which is
     * right for asserting both sides but means the whole file would report identical results if the
     * default parameter stopped reading the gate: loadApplicationProfileLike calls
     * acknowledgementPermissionsFor with THREE arguments, and that third one defaulting correctly is
     * the entire mechanism by which flipping the switch reaches production.
     *
     * WHAT IT CATCHES, MEASURED BY MUTATION RATHER THAN ASSUMED, because the first version of this
     * comment claimed more than the code does and the mutation is what caught it:
     *
     *   default replaced by `false`, gate open   ->  FAILS. This is the direction that matters.
     *   default replaced by `true`, gate open    ->  PASSES. It cannot be told apart from the real
     *                                                thing while the gate agrees with the literal.
     *
     * So this is not a proof that the default reads the gate. It is a proof that the default AGREES
     * with the gate, which is weaker and is still the property worth pinning: the day someone closes
     * this switch to stop a live harm, a default that stayed `true` would keep producing acceptances
     * while every other test in this file reported the gate closed. That is the failure this catches
     * and it is the one that would hurt. The fixture is a GRANTED row, so the two sides genuinely
     * differ and neither line is vacuous. */
    const viaDefault = acknowledgementPermissionsFor(FULLY_GRANTED, GRANTED_PREDICATES);
    assert.deepEqual(viaDefault, permissions(FULLY_GRANTED, exactControlTargetingDeployed()));
    assert.notDeepEqual(viaDefault, permissions(FULLY_GRANTED, !exactControlTargetingDeployed()));
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
    const ap = { ...STORED_FACTS, ...permissions(FULLY_GRANTED, false) } as ApplicationProfileLike;
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
  const LIVE = { ...STORED_FACTS, ...permissions(FULLY_GRANTED, true) } as ApplicationProfileLike;
  const WITHOUT_LICENCE = { ...STORED_FACTS, ...permissions(FULLY_GRANTED, false) } as ApplicationProfileLike;

  test('the licences are live, so the tests below are not vacuous', () => {
    assert.equal(LIVE.consent_acknowledgement_permission?.version, AUTOMATIC_CONSENT_ACCEPTANCE_VERSION);
    assert.equal(LIVE.conduct_acknowledgement_permission?.version, AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION);
    // And they do their job: the two blocked consents are accepted.
    assert.equal(answer(IMC_PRIVACY, LIVE), 'Yes');
    assert.equal(answer(IMC_CONDUCT, LIVE), 'Yes');
  });

  test('the profile really answers things, so a refusal below is never "nothing on file"', () => {
    /* THE GUARD THE FIRST VERSION OF THIS FILE DID NOT HAVE. With an empty profile every
     * declaration refuses for a reason that has nothing to do with any permission, and the whole
     * boundary reads as proven while proving nothing. */
    assert.equal(answer('Are you legally authorized to work in the United States?', LIVE, 'select'), 'Yes');
    assert.equal(answer('please select your racial/ethnic background', LIVE, 'select'), 'South Asian');
  });

  test('the never-answered classes are never answered', () => {
    for (const [what, label] of NEVER_ANSWERED) {
      assert.equal(answer(label, LIVE), null, `${what} must not be answered: ${label}`);
    }
  });

  test('the classes answered from her own record are answered from HER RECORD, not the permission', () => {
    for (const [what, label, expected] of ANSWERED_FROM_HER_OWN_RECORD) {
      assert.equal(answer(label, LIVE, 'select'), expected, `${what}: ${label}`);
    }
  });

  test('no declaration can be agreed to out of an option list', () => {
    /* The option list is where an "I agree" wording makes a declaration LOOK like a consent. The
     * decision is made on the label before any list is read, so the list cannot change it. */
    for (const [what, label] of [...NEVER_ANSWERED, ...ANSWERED_FROM_HER_OWN_RECORD.map(([a, b]) => [a, b] as [string, string])]) {
      const resolved = selected(label, LIVE, ['I agree', 'I do not agree']);
      assert.ok(
        resolved === null || resolved.value !== 'I agree',
        `${what} must not be agreed to from an option list: ${label}`,
      );
    }
  });

  test('the permission is invisible to every declaration, answered or held', () => {
    /* THE PROPERTY THIS FEATURE IS ACTUALLY JUDGED ON, and the honest version of the sentence this
     * file used to get wrong. Not "these are held", because several of them are legitimately
     * ANSWERED out of declarations she made herself. The property is that the licence changes
     * nothing about any of them, so no widening of the consent grammar can put an acceptance on
     * one. */
    for (const [what, label] of [...NEVER_ANSWERED, ...ANSWERED_FROM_HER_OWN_RECORD.map(([a, b]) => [a, b] as [string, string])]) {
      assert.equal(answer(label, LIVE), answer(label, WITHOUT_LICENCE), `${what} answer must not move: ${label}`);
      assert.equal(held(label, LIVE), held(label, WITHOUT_LICENCE), `${what} refusal must not move: ${label}`);
      assert.equal(
        answer(label, LIVE, 'select'),
        answer(label, WITHOUT_LICENCE, 'select'),
        `${what} must not move on a select either: ${label}`,
      );
    }
  });

  test('a document nobody classified still fails closed under both licences', () => {
    /* The property 5fc9a2a's own commit message calls the thing that makes the split safe. A label
     * carrying a second, unplaceable document is held rather than accepted. */
    const stray = 'I accept the Privacy Statement and the Supplier Expectations Handbook.';
    assert.equal(answer(stray, LIVE), null);
  });

  test('a label welding a document to a declaration is refused whole, on both sides', () => {
    /* MEASURED ON MAIN, with nothing granted at all: this resolved to "Yes", and to "I agree" off
     * an option list. The consent classifier refused it correctly; the WORK-ELIGIBILITY branch
     * answered it, accepting a named document as a side effect of answering a visa question. One
     * control, one tick, two statements, and only one of them was decided. */
    const welded = 'I acknowledge the Privacy Statement and confirm I am legally authorized to work in the United States.';
    for (const [what, ap] of [['granted', LIVE], ['not granted', WITHOUT_LICENCE]] as Array<[string, ApplicationProfileLike]>) {
      assert.equal(answer(welded, ap), null, `${what}: must not answer a welded label`);
      assert.ok(held(welded, ap), `${what}: must say why it is left`);
      assert.equal(selected(welded, ap, ['I agree', 'I do not agree']), null, `${what}: and not from a list`);
    }
    // Neither half alone is disturbed: a pure consent is still accepted, a pure declaration still
    // answered. Without this the rule could pass by refusing everything.
    assert.equal(answer(IMC_PRIVACY, LIVE), 'Yes');
    assert.equal(answer('Are you legally authorized to work in the United States?', LIVE, 'select'), 'Yes');
  });
});

describe('KNOWN OPEN: the work-authorization class is NOT held by this gate', () => {
  /* NAMED RATHER THAN HIDDEN, following the jurisdiction false-hold class pinned by 5fc9a2a.
   *
   * workEligibilityReplayMayReachControls() exists, reads the same switch, and is NOT CALLED. So
   * work-authorization and sponsorship answers reach option-shaped controls exactly as they do on
   * main. OPENING THE GATE DID NOT CHANGE THAT EITHER, which is the specific thing this block is
   * carrying across the 2026-08-13 flip: a shared predicate going from `false` to `true` must not
   * silently wire the half that was never wired. Every assertion below passed unchanged across that
   * flip, which is what says it did not.
   *
   * WHAT DID CHANGE IS UPSTREAM AND NOT VISIBLE FROM HERE. This class was exposed to the targeting
   * defect, and PR 50 repaired the defect in the runner, so the exposure is gone. It was never this
   * gate that was going to close it: the TRIGGER in the original repro was filling the sponsorship
   * combobox and the VICTIM was a consent listbox, and holding the consent answer only ever stopped
   * Litos PRODUCING the acceptance. It never stopped the sponsorship fill. So the sequence is closed
   * now, in Chromium, by a change no assertion in this file can see or should claim.
   *
   * THE TRIPWIRE IN THIS BLOCK IS NOW ARMED ONLY WHILE THE GATE IS CLOSED, and the old sentence
   * here said it fired unconditionally. Measured, by actually wiring the predicate into
   * workEligibilityAnswer and running this file:
   *
   *   gate CLOSED + predicate wired  ->  5 failures, two of them in this block by name
   *   gate OPEN   + predicate wired  ->  0 failures
   *
   * That is not a hole, but it has to be said out loud or the next reader trusts a guard that is
   * asleep. Wiring a predicate that returns `true` is a behavioural no-op, so there is nothing for
   * any assertion to see, and nothing is harmed. The harm only exists when the switch is CLOSED,
   * because then a wired predicate would hold work-authorization answers too, which is the false
   * hold 5fc9a2a pinned. These assertions fire exactly then. The guard is armed at the moment it
   * matters and is silent when the thing it guards against is harmless.
   *
   * And with the defect repaired, wiring this at all would now be a hold with no defect behind it,
   * so that failure is more likely to be a mistake than a milestone. See the note on the predicate
   * itself in grantedAnswerReplay.ts. */
  const LIVE = { ...STORED_FACTS, ...permissions(FULLY_GRANTED, true) } as ApplicationProfileLike;
  const HELD_SIDE = { ...STORED_FACTS, ...permissions(FULLY_GRANTED, false) } as ApplicationProfileLike;

  test('work authorization and sponsorship answer on BOTH sides of the gate', () => {
    for (const label of [
      'Are you legally authorized to work in the United States?',
      'Will you now, or in the future, require sponsorship for employment visa status?',
    ]) {
      assert.equal(answer(label, LIVE, 'select'), 'Yes', `still answered with the gate open: ${label}`);
      assert.equal(answer(label, HELD_SIDE, 'select'), 'Yes', `still answered with the gate closed: ${label}`);
    }
  });

  test('and they reach an option-shaped control, which is where the targeting defect bites', () => {
    const resolved = selected('Are you legally authorized to work in the United States?', HELD_SIDE, ['Yes', 'No']);
    assert.equal(resolved?.value, 'Yes');
  });

  test('the second predicate is declared, reads the same switch, and is still unwired', () => {
    assert.equal(workEligibilityReplayMayReachControls(), exactControlTargetingDeployed());
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
