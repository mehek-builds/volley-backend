import assert from 'node:assert/strict';
import test from 'node:test';
import { portalAccountCapability, mayOpenPortalAccount } from './portalAccountCapability';

/* THE TWO HALVES OF THE GATE ARE SEPARATE VALUES ON PURPOSE. A permission is about the applicant,
 * a capability is about the platform, and collapsing them is how a granted permission starts
 * meaning "try anyway" on a platform where trying means defeating a challenge. */

test('a granted permission cannot open an account on a challenge-gated platform', () => {
  const verdict = mayOpenPortalAccount('icims', true);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /human/i);
});

/* This is the sentence the permission wording promises: a CAPTCHA-gated signup is out of reach with
   the permission granted exactly as it is without it. */
test('granting changes nothing on a challenge-gated platform', () => {
  assert.equal(mayOpenPortalAccount('icims', true).allowed, mayOpenPortalAccount('icims', false).allowed);
});

test('the one eligible platform still needs the permission', () => {
  assert.equal(portalAccountCapability('oraclecloud').eligible, true);
  assert.equal(mayOpenPortalAccount('oraclecloud', false).allowed, false);
  assert.equal(mayOpenPortalAccount('oraclecloud', true).allowed, true);
});

/* A platform that cannot do it says so BEFORE a permission question is raised: "turn this on" is
   the wrong thing to tell someone about a platform where turning it on changes nothing. */
test('an ineligible platform explains itself rather than asking for permission', () => {
  assert.doesNotMatch(mayOpenPortalAccount('icims', false).reason, /turned that on/i);
  assert.match(mayOpenPortalAccount('oraclecloud', false).reason, /turned that on/i);
});

test('a family with no record is not eligible, and does not throw', () => {
  assert.equal(portalAccountCapability('greenhouse').eligible, false);
  assert.equal(portalAccountCapability('a-family-added-tomorrow').eligible, false);
  assert.equal(mayOpenPortalAccount('a-family-added-tomorrow', true).allowed, false);
});

/* Adding a family to PortalFamily must not quietly grant it account creation. Eligibility is an
   allowlist of live captures, so the safe default is the only default. */
test('eligibility is an allowlist, and it is exactly one family today', () => {
  const families = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'jazzhr',
    'paylocity', 'rippling', 'breezy', 'bamboohr', 'jobvite', 'icims', 'oraclecloud', 'ultipro',
    'recruitee', 'teamtailor', 'personio', 'pinpoint', 'comeet', 'zoho_recruit', 'bullhorn',
    'sap_successfactors', 'oracle_taleo', 'adp_recruiting', 'avature'];
  const eligible = families.filter((family) => portalAccountCapability(family).eligible);
  assert.deepEqual(eligible, ['oraclecloud'],
    'a new eligible family needs a live signup capture and a deliberate entry, never a default');
});

test('every reason is a sentence an applicant could read', () => {
  for (const family of ['icims', 'ultipro', 'oraclecloud', 'sap_successfactors', 'greenhouse']) {
    const { reason } = portalAccountCapability(family);
    assert.match(reason, /^[A-Z].*\.$/, `${family} reason is not a sentence: ${reason}`);
    assert.doesNotMatch(reason, /captcha|hcaptcha|42703|null|undefined/i, `${family} leaks an internal term`);
  }
});
