import assert from 'node:assert/strict';
import test from 'node:test';
import { phoneForPortalField } from './portalSubmission';

/* THE DIAL CODE THAT WAS WRITTEN TWICE.
 *
 * Cresta's live form (Greenhouse's newer React form) showed "Phone number is too short" under
 * "+971 567417451" while the country control beside it already read +971, so the application could
 * not be submitted at all. phoneForPortalField stripped the dial code for Rippling and for nothing
 * else, which was never the rule - it was the one board where the rule had been noticed.
 *
 * The rule is: when the phone field has a SEPARATE control that is ALREADY showing this number's
 * own dial code, the field takes the national number and the dial code does not go in it. Both
 * halves are load-bearing, and the second is the whole guard against the mirror-image defect. A
 * number written without its country onto a form that carries no country anywhere is worse than one
 * a validator rejects out loud, because it produces a phone number the employer cannot dial and
 * nothing on the page says so.
 *
 * `dialCodesOnForm` is what the field's own group was measured to be showing. The DOM read that
 * produces it lives at the two fill sites (fillPhoneField here, separateDialCodesFor in the managed
 * runner) and is exercised end to end by the portal-shapes trial's phone-country case; this file
 * pins the DECISION those reads feed.
 */

const UAE = '+971 567417451';

test('a country control already holding this number\'s dial code takes the national number', () => {
  assert.equal(phoneForPortalField('greenhouse', UAE, ['971']), '567417451');
});

test('the rule is not a board, so it holds on a family that never had a special case', () => {
  assert.equal(phoneForPortalField('lever', '+44 7700 900123', ['44']), '7700900123');
  assert.equal(phoneForPortalField('ashby', '+1 213 555 0100', ['1']), '2135550100');
  assert.equal(phoneForPortalField('smartrecruiters', UAE, ['971']), '567417451');
});

test('THE MIRROR IMAGE: a form with no country control still gets the full international number', () => {
  assert.equal(phoneForPortalField('greenhouse', UAE, []), UAE);
  assert.equal(phoneForPortalField('greenhouse', UAE, undefined), UAE);
  assert.equal(phoneForPortalField('lever', UAE), UAE);
});

test('a country control showing a DIFFERENT country changes nothing', () => {
  /* Read literally: the number does not start with that code, so nothing about it has been written
     twice, and removing digits would corrupt a number that is currently correct. The country being
     wrong is the applicant's to fix, and a truncated number would hide it. */
  assert.equal(phoneForPortalField('greenhouse', UAE, ['1']), UAE);
  assert.equal(phoneForPortalField('greenhouse', UAE, ['44', '91']), UAE);
});

test('the longest matching code wins, so +1 never eats a +1-prefixed longer code', () => {
  assert.equal(phoneForPortalField('greenhouse', UAE, ['1', '971']), '567417451');
});

test('a national number is left alone even beside a country control', () => {
  // No leading '+', so there is no dial code in the field to remove and no claim to act on.
  assert.equal(phoneForPortalField('greenhouse', '0567417451', ['971']), '0567417451');
  assert.equal(phoneForPortalField('greenhouse', '567417451', ['971']), '567417451');
});

test('a number that is nothing BUT its dial code is left alone', () => {
  // Stripping would leave the field empty, which is a worse answer than an odd one.
  assert.equal(phoneForPortalField('greenhouse', '+971', ['971']), '+971');
});

test('Rippling keeps its measured fallback for the path that has no page to read', () => {
  /* buildManagedPortalActions has no live DOM, so it cannot ask. Rippling's widget was measured to
     carry its own country selector, and that stays true; it is now the fallback rather than the
     rule. */
  assert.equal(phoneForPortalField('rippling', UAE), '567417451');
  assert.equal(phoneForPortalField('controlled_rippling', UAE), '567417451');
});

test('an absent phone stays absent', () => {
  assert.equal(phoneForPortalField('greenhouse', undefined, ['971']), undefined);
  assert.equal(phoneForPortalField('greenhouse', '', ['971']), '');
});
