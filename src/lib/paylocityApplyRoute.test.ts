/* PAYLOCITY'S FORM IS ITS OWN ROUTE. Celerant Tech 2950251, 2026-09-05: the posting was stored as
 * its Details page, the run opened it, and the Details -> Apply hop the form needs was refused by
 * the runner's navigation containment. The application URL is the Apply route from the start. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalSupportedPortalUrl, detectPortal, portalApplicationUrl } from './portalSubmission';

const DETAILS = 'https://recruiting.paylocity.com/recruiting/jobs/Details/2950251/Celerant-Tech/Software-Developer-Intern';
const APPLY = 'https://recruiting.paylocity.com/recruiting/jobs/Apply/2950251/Celerant-Tech/Software-Developer-Intern';

test('a Paylocity Details page canonicalizes to the Apply route the form lives on', () => {
  assert.equal(detectPortal(DETAILS), 'paylocity');
  assert.equal(canonicalSupportedPortalUrl(DETAILS), APPLY);
  assert.equal(portalApplicationUrl('paylocity', DETAILS), APPLY);
});

test('the Apply route is already canonical, and tracking noise is dropped', () => {
  assert.equal(canonicalSupportedPortalUrl(APPLY), APPLY);
  assert.equal(canonicalSupportedPortalUrl(`${APPLY}/?source=Indeed&utm=x#top`), APPLY);
  assert.equal(canonicalSupportedPortalUrl('https://2000recruiting.paylocity.com/Recruiting/Jobs/Apply/44457'), 'https://2000recruiting.paylocity.com/recruiting/jobs/Apply/44457');
});

test('a Paylocity page that is not a posting stays unsupported rather than guessed', () => {
  assert.equal(canonicalSupportedPortalUrl('https://recruiting.paylocity.com/recruiting/jobs/All/abc123/Celerant-Tech'), undefined);
});
