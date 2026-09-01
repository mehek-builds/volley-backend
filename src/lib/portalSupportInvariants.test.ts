import assert from 'node:assert/strict';
import test from 'node:test';
import { browserApplicationCapability } from './browserApplicationCapabilities';
import { POLLABLE_JOB_BOARDS } from './jobMonitor';
import {
  AUTONOMOUS_PORTAL_FAMILIES,
  CAPTCHA_BLOCKER,
  corroborateManagedCaptchaBlockers,
  isAutonomousPortalFamily,
  isCaptchaGatedFamily,
  isConsentGrantConditionalFamily,
  managedPortalReceiptCapability,
  portalCanAutoSubmit,
  portalCanAutoSubmitWithConsentGrant,
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
  'crelate',
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

/* PER-ACCOUNT conditional autonomy, pinned on both sides.
 *
 * The standing consent-acceptance grant unlocks SUBMIT on exactly teamtailor and pinpoint, whose
 * only bar is a routine consent control beside submit. It must not move the static story an inch:
 * the jobs board, polling and coverage copy read AUTONOMOUS_PORTAL_FAMILIES / portalCanAutoSubmit
 * with no account in hand, and an account without the grant must see today's behaviour everywhere.
 * And the grant lifts only the consent gate - a CAPTCHA-gated, multi-step or account-walled family
 * with a grant is exactly as blocked as without one, and personio's readiness-reader bar is not a
 * consent.
 *
 * breezy is grant-conditional for the TICK only (2026-08-20, measured on Transparent Hiring): it
 * was autonomous before the grant existed and must answer the same with or without one, which the
 * loop below asserts because portalCanAutoSubmit('breezy') is already true on both sides of the
 * equality. */
test('the consent grant conditionally unlocks submit on exactly teamtailor and pinpoint, and nothing static moves', () => {
  const grant = { granted_at: '2026-08-12T09:15:00.000Z', version: '2026-08-12' };
  for (const family of ALL_PORTAL_FAMILIES) {
    // No grant: byte-for-byte the account-independent answer.
    assert.equal(portalCanAutoSubmitWithConsentGrant(family, null), portalCanAutoSubmit(family), family);
    const conditional = family === 'teamtailor' || family === 'pinpoint' || family === 'breezy';
    assert.equal(isConsentGrantConditionalFamily(family), conditional, family);
    assert.equal(
      portalCanAutoSubmitWithConsentGrant(family, grant),
      portalCanAutoSubmit(family) || conditional,
      family,
    );
  }
  // Breezy's static story does not move in either direction: autonomous with no grant, and the
  // grant changes nothing about submit - it licenses only the guarded consent tick.
  assert.equal(portalCanAutoSubmit('breezy'), true);
  assert.equal(isAutonomousPortalFamily('breezy'), true);
  assert.equal((AUTONOMOUS_PORTAL_FAMILIES as readonly string[]).includes('breezy'), true);
  assert.equal(portalCanAutoSubmitWithConsentGrant('breezy', null), true);
  assert.equal(portalCanAutoSubmitWithConsentGrant('breezy', grant), true);
  for (const family of ['teamtailor', 'pinpoint'] as const) {
    assert.equal(portalCanAutoSubmit(family), false, family);
    assert.equal(isAutonomousPortalFamily(family), false, family);
    assert.equal((AUTONOMOUS_PORTAL_FAMILIES as readonly string[]).includes(family), false, family);
    // The handoff sentences the no-grant account keeps seeing.
    assert.ok(portalHandoffReason(family), family);
  }
  assert.equal(portalCanAutoSubmitWithConsentGrant('personio', grant), false);
  assert.equal(portalCanAutoSubmitWithConsentGrant('manual_recruitee', grant), false);
  // The receipt question follows the submit question in both shapes.
  assert.equal(managedPortalReceiptCapability('teamtailor'), 'unavailable_before_handoff');
  assert.equal(managedPortalReceiptCapability('teamtailor', grant), 'confirmation_possible');
  assert.equal(managedPortalReceiptCapability('pinpoint', grant), 'confirmation_possible');
  assert.equal(managedPortalReceiptCapability('personio', grant), 'unavailable_before_handoff');
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

/* Rippling is the assisted tier: pollable and fully fillable, but CAPTCHA-gated on submit (an
 * invisible Cloudflare Turnstile challenge witnessed on the Apply press 2026-08-20), so Litos fills
 * it and hands off the human-check + send. It must be BOTH in POLLABLE (so its jobs are ingested for
 * the dashboard fill-and-handoff flow) and OUT of AUTONOMOUS (so onboarding never surfaces it).
 * Re-promoting rippling to autonomous requires a live witness that the Turnstile gate is gone; this
 * pin makes that a deliberate change rather than an accident. */
test('rippling is the assisted tier: pollable, CAPTCHA-gated, never autonomous', () => {
  assert.equal(isCaptchaGatedFamily('rippling'), true, 'rippling must be CAPTCHA-gated (fill-and-handoff)');
  assert.equal(portalCanAutoSubmit('rippling'), false, 'rippling must never auto-submit');
  assert.equal(isAutonomousPortalFamily('rippling'), false, 'rippling must not be autonomous');
  assert.equal(
    (POLLABLE_JOB_BOARDS as readonly string[]).includes('rippling'), true,
    'rippling must stay pollable so its jobs are ingested for the dashboard assisted flow',
  );
  assert.match(portalHandoffReason('rippling') ?? '', /prove you are human/);
});
