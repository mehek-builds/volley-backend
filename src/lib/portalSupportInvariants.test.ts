import assert from 'node:assert/strict';
import test from 'node:test';
import { browserApplicationCapability } from './browserApplicationCapabilities';
import {
  AUTONOMOUS_PORTAL_FAMILIES,
  CAPTCHA_BLOCKER,
  corroborateManagedCaptchaBlockers,
  isAutonomousPortalFamily,
  isCaptchaGatedFamily,
  portalCanAutoSubmit,
  portalHandoffReason,
  type AutonomousPortalFamily,
  type PortalFamily,
} from './portalSubmission';

/* THE INVARIANT THE CAPTCHA CORROBORATION RULE RESTS ON, asserted rather than assumed.
 *
 * corroborateManagedCaptchaBlockers drops an uncorroborated CAPTCHA blocker on any family that is
 * not CAPTCHA-gated. That is safe only while "not CAPTCHA-gated and able to auto-submit" and "on the
 * autonomous list" are the same set, because a family that can auto-submit while sitting outside the
 * autonomous list is one whose prepare blocker can now be dropped and whose submit is not otherwise
 * stopped. The only remaining guard would be the submit-time probe in submissionRunner, and that
 * probe fails OPEN by design: a runner error is caught and treated as "no challenge seen".
 *
 * The agreement is real today and entirely coincidental. AUTONOMOUS_PORTAL_FAMILIES is a hand
 * maintained array; `as const satisfies readonly AutonomousPortalFamily[]` checks that every entry
 * BELONGS, never that every member is present. Add a family to PortalFamily and to no gated set, and
 * portalCanAutoSubmit answers true while isAutonomousPortalFamily answers false, silently. This file
 * is the thing that notices. Adding ATS families is exactly the condition that makes it bite.
 */
const ALL_PORTAL_FAMILIES = [
  'greenhouse',
  'lever',
  'ashby',
  'smartrecruiters',
  'workable',
  'jazzhr',
  'paylocity',
  'rippling',
  'breezy',
  'bamboohr',
  'jobvite',
  'icims',
  'oraclecloud',
  'ultipro',
  'recruitee',
  'teamtailor',
  'personio',
  'pinpoint',
  'comeet',
  'zoho_recruit',
  'bullhorn',
  'sap_successfactors',
  'oracle_taleo',
  'adp_recruiting',
  'avature',
] as const satisfies readonly PortalFamily[];

// A family added to the union and not to the list above is a BUILD failure here, not a test that
// quietly checks a shorter list than it used to. Same device as ALL_STATUSES in applicationStall.
const _familiesAreExhaustive: PortalFamily extends (typeof ALL_PORTAL_FAMILIES)[number] ? true : never = true;
void _familiesAreExhaustive;

/* The completeness check the comment above AUTONOMOUS_PORTAL_FAMILIES already claims to have.
 *
 * It says the list is "subtracted from PortalFamily rather than hand-listed, so there is no second
 * list to remember to update". The TYPE is subtracted; the VALUE is hand-listed, and `satisfies`
 * only proves membership. This is the other direction, and it is what makes that comment true: a new
 * family that lands in none of the gated sets joins AutonomousPortalFamily, and if nobody adds it to
 * the array this line stops compiling.
 */
const _autonomousListIsComplete: AutonomousPortalFamily extends (typeof AUTONOMOUS_PORTAL_FAMILIES)[number]
  ? true
  : never = true;
void _autonomousListIsComplete;

test('every portal family is classified, so auto-submit and autonomy cannot disagree', () => {
  for (const family of ALL_PORTAL_FAMILIES) {
    assert.equal(
      portalCanAutoSubmit(family),
      isAutonomousPortalFamily(family),
      `${family}: portalCanAutoSubmit and isAutonomousPortalFamily disagree. A family must be either `
      + 'on AUTONOMOUS_PORTAL_FAMILIES or in one of the gated sets (multi-step, CAPTCHA-gated, '
      + 'consent-gated, manual-final-review, account-walled). Classify it in portalSubmission.ts.',
    );
  }
});

/* The one deliberate exception, named here so it reads as a decision rather than as a gap in the
 * test above. 'manual_recruitee' is not a family: it is a Recruitee tenant shape whose final controls
 * were never validated, and portalCanAutoSubmit refuses it by name while the recruitee FAMILY stays
 * autonomous. It is safe in the direction that matters, refusing rather than allowing. */
test('the manual Recruitee shape refuses to auto-submit without demoting the family', () => {
  assert.equal(portalCanAutoSubmit('manual_recruitee'), false);
  assert.equal(portalCanAutoSubmit('recruitee'), true);
  assert.equal(isAutonomousPortalFamily('recruitee'), true);
});

/* WHAT THE COMPLETENESS CHECK FOUND when it was first written, recorded so the next reader knows
 * this file has already earned its place.
 *
 * zoho_recruit and bullhorn are in none of the five deny sets, so AutonomousPortalFamily claimed
 * both were autonomous, while portalCanAutoSubmit answered false for both because it branches to the
 * researched capability table for them. The type and the function disagreed, and the array below
 * could not be complete no matter who maintained it. The type now subtracts the capability-reviewed
 * families too. The runtime half stays asserted here, because the table is data: flip
 * programmaticSubmit on either family and the disagreement comes back the other way round.
 */
test('a family denied by the researched capability table is not autonomous by omission', () => {
  for (const family of ['zoho_recruit', 'bullhorn'] as const) {
    assert.equal(browserApplicationCapability(family).programmaticSubmit, false, family);
    assert.equal(portalCanAutoSubmit(family), false, family);
    assert.equal(isAutonomousPortalFamily(family), false, family);
    assert.equal((AUTONOMOUS_PORTAL_FAMILIES as readonly string[]).includes(family), false, family);
  }
});

/* A family Litos cannot finish must never lose its CAPTCHA blocker to a page read, because losing it
 * is what produces a send button that cannot work. Asserted against the classification rather than
 * against a hand-copied list of three names, so it keeps holding as families are added. */
test('no family that gates every form can have its blocker dropped', () => {
  for (const family of ALL_PORTAL_FAMILIES) {
    if (!isCaptchaGatedFamily(family)) continue;
    assert.equal(portalCanAutoSubmit(family), false, `${family} is CAPTCHA-gated and must not auto-submit`);
    assert.deepEqual(
      corroborateManagedCaptchaBlockers(family, [CAPTCHA_BLOCKER], null),
      [CAPTCHA_BLOCKER],
      `${family} must keep its CAPTCHA blocker with no page evidence at all`,
    );
    // And the handoff sentence still comes from the family, so what she is told does not depend on
    // what the page read happened to return.
    assert.match(portalHandoffReason(family) ?? '', /prove you are human/);
  }
});
