import assert from 'node:assert/strict';
import test from 'node:test';
import { greenhouseBoardTokenForHost } from './greenhouseEmbeddedBoards';
import {
  canonicalSupportedPortalUrl,
  detectPortal,
  greenhousePortalUrlNeedsBoardToken,
  isPortalSupported,
  portalApplicationUrl,
} from './portalSubmission';

/**
 * Greenhouse boards served from the employer's own domain.
 *
 * Measured on production 2026-08-09: three packets on this account were marked
 * portal_supported: false and dropped to the email fallback purely because portal detection keys
 * on the URL host. Every one of them is Greenhouse, the ATS Litos fills best, embedded in a
 * company page and carrying Greenhouse's own gh_jid parameter.
 */
const JUMP_FIRST = 'https://www.jumptrading.com/hr/job?gh_jid=8052351';
const JUMP_SECOND = 'https://www.jumptrading.com/hr/job?gh_jid=8052338';
const OLD_MISSION = 'https://www.oldmissioncapital.com/careers/?gh_jid=7796180003';

test('the three production packets are recognised and canonicalize to their real Greenhouse form', () => {
  for (const [rawUrl, expected] of [
    [JUMP_FIRST, 'https://job-boards.greenhouse.io/embed/job_app?for=jumptrading&token=8052351'],
    [JUMP_SECOND, 'https://job-boards.greenhouse.io/embed/job_app?for=jumptrading&token=8052338'],
    [OLD_MISSION, 'https://job-boards.greenhouse.io/embed/job_app?for=oldmissioncapital&token=7796180003'],
  ] as const) {
    assert.equal(isPortalSupported(rawUrl), true, rawUrl);
    assert.equal(detectPortal(rawUrl), 'greenhouse', rawUrl);
    assert.equal(canonicalSupportedPortalUrl(rawUrl, 'greenhouse'), expected, rawUrl);
    // The runner navigates through portalApplicationUrl, so the company page must not survive to
    // the browser. This is the step that turns recognition into an application that can be filled.
    assert.equal(portalApplicationUrl('greenhouse', rawUrl), expected, rawUrl);
    // And the derived URL is a supported board in its own right, with a board token already on it,
    // so it needs no monitored-job repair afterwards.
    assert.equal(isPortalSupported(expected), true, expected);
    assert.equal(greenhousePortalUrlNeedsBoardToken(expected), false, expected);
  }
});

/* The shape is not invented here. canonicalMonitoredPortalUrl has produced exactly this form for
 * monitored Greenhouse jobs since it shipped, including for jumptrading, so an embedded-board
 * packet is stored identically to the 41 Greenhouse postings that already work on this account. */
test('the stored ats_name and portal url agree with how monitored Greenhouse packets are stored', () => {
  const canonical = canonicalSupportedPortalUrl(JUMP_FIRST, null);
  assert.equal(canonical, 'https://job-boards.greenhouse.io/embed/job_app?for=jumptrading&token=8052351');
  assert.equal(detectPortal(canonical!), 'greenhouse');
});

test('natively hosted Greenhouse postings keep working exactly as before', () => {
  // The Databricks posting that submits today, on Greenhouse's own host.
  const databricksEmbed = 'https://job-boards.greenhouse.io/embed/job_app?for=databricks&token=6883068002';
  assert.equal(isPortalSupported(databricksEmbed), true);
  assert.equal(detectPortal(databricksEmbed), 'greenhouse');
  assert.equal(greenhousePortalUrlNeedsBoardToken(databricksEmbed), false);
  // The Databricks company wrapper keeps its own pinned rule rather than falling into the general
  // one, so its canonical URL is byte for byte what it was.
  assert.equal(
    canonicalSupportedPortalUrl('https://databricks.com/company/careers/open-positions/job?gh_jid=6883068002', 'greenhouse'),
    'https://boards.greenhouse.io/embed/job_app?token=6883068002',
  );
  // Including the narrower checks that rule carries: a wrapper path that disagrees with its own
  // job id is still refused, which the general rule must not quietly widen.
  assert.equal(isPortalSupported('https://www.databricks.com/company/careers/product/product-management-intern-summer-2027-111?gh_jid=6883068002'), false);
  assert.equal(isPortalSupported('https://job-boards.greenhouse.io/gemini/jobs/4512345'), true);
});

/**
 * The negative side, which matters more than the positive one. A wrong or dead application URL is
 * worse than the email fallback, so anything we cannot name a verified board token for stays
 * exactly where it was.
 */
test('a gh_jid alone never makes a page supported', () => {
  for (const url of [
    // Not a verified employer domain. Nuro's proven domain is nuro.com, so nuro.ai cannot be
    // resolved to the `nuro` board and must not be guessed into it.
    'https://nuro.ai/careers?gh_jid=4512345',
    // No employer domain at all.
    'https://example.com/careers?gh_jid=8052351',
    // A verified Greenhouse employer, but `1` is not a Greenhouse job id. Real ids are seven
    // digits and up; a page carrying a gh_jid shaped parameter is not evidence of a board.
    'https://www.fivetran.com/careers/job?gh_jid=1',
    // Verified employer, unusable id.
    'https://www.jumptrading.com/hr/job?gh_jid=abc',
    'https://www.jumptrading.com/hr/job?gh_jid=',
    'https://www.jumptrading.com/hr/job?gh_jid=08052351',
    // Two ids is a page we do not understand, not a posting.
    'https://www.jumptrading.com/hr/job?gh_jid=8052351&gh_jid=8052338',
    // The same employer's ordinary careers page, which is what these packets used to carry.
    'https://www.jumptrading.com/careers/4512345/',
    // Insecure links are refused before anything else.
    'http://www.jumptrading.com/hr/job?gh_jid=8052351',
  ]) {
    assert.equal(isPortalSupported(url), false, url);
    assert.equal(canonicalSupportedPortalUrl(url, 'greenhouse'), undefined, url);
    assert.throws(() => detectPortal(url), /cannot fill in|not a secure link/, url);
  }
});

test('board tokens come from the verified registry, not from the page', () => {
  assert.equal(greenhouseBoardTokenForHost('www.jumptrading.com'), 'jumptrading');
  assert.equal(greenhouseBoardTokenForHost('jumptrading.com'), 'jumptrading');
  assert.equal(greenhouseBoardTokenForHost('careers.oldmissioncapital.com'), 'oldmissioncapital');
  // The token is the board's, which is not always the company's name: Hudson River Trading
  // publishes on `wehrtyou`. Deriving it from the domain string would have produced a dead board.
  assert.equal(greenhouseBoardTokenForHost('www.hudsonrivertrading.com'), 'wehrtyou');
  assert.equal(greenhouseBoardTokenForHost('nuro.ai'), undefined);
  assert.equal(greenhouseBoardTokenForHost('example.com'), undefined);
  // A lookalike that merely ends in the same letters is not a subdomain of the verified domain.
  assert.equal(greenhouseBoardTokenForHost('notjumptrading.com'), undefined);
  // Databricks keeps its dedicated wrapper rule, so it is deliberately absent here.
  assert.equal(greenhouseBoardTokenForHost('databricks.com'), undefined);
  assert.equal(greenhouseBoardTokenForHost(undefined), undefined);
  assert.equal(greenhouseBoardTokenForHost(''), undefined);
});
