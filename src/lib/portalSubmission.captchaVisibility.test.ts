/* THE CONSUMER HALF OF A CROSS-REPO CONTRACT, RUN AGAINST WHAT THE RUNNER REALLY SENDS.
 *
 * WHAT THIS EXISTS TO STOP. This repo builds an action list, stratus-browser-cloud executes it, and
 * the predicates below decide whether a finished application is handed back to a person to redo by
 * hand. Neither repo can import the other, so each side used to pin its half against a literal it
 * wrote itself, and both halves passed while the two disagreed. That is precisely how the
 * pass.scope.scopeKind mismatch blocked every submission in this product for a day.
 *
 * src/lib/fixtures/captcha-visibility-contract.json is the shared artifact, committed byte-identical
 * in both repos. `actions` is what buildManagedCaptchaProbeActions really returns; `emitted` is what
 * the shipped runner really returned when those actions ran against `html` in real Chromium. This
 * file asserts that the builder still produces those actions and that the predicates still reach
 * `expected` from that emission. The producer half is pinned in the stratus repo against the same
 * bytes, so either side drifting fails its own suite with the same file naming the disagreement.
 *
 * WHAT THE CASES ARE. Five pages from the read-only sweep of 30 live postings on 2026-08-12, and
 * each one is chosen so its adversary can win:
 *   - lever_invisible_hcaptcha must NOT block, and blocked permanently before this change.
 *   - jazzhr_visible_recaptcha must block, and is the one genuine CAPTCHA in the sweep. Its bframe is
 *     mounted but hidden, so under the corrected bframe reading the verdict has to be carried by the
 *     visible widget and the visible anchor rather than waved through by a presence check.
 *   - greenhouse_badge_only must NOT block: the shape 24 of the 30 postings carry.
 *   - greenhouse_badge_only_without_size_parameter must NOT block with Google's size=invisible gone
 *     from the query string, which is the only thing that used to be holding those 24 back.
 *   - visible_hcaptcha_without_data_size must block. hCaptcha writes no data-size in either state, so
 *     this page and the Lever page are attribute-for-attribute identical and want opposite answers.
 *     Any rule that reads only attributes, including a :not(.h-captcha:not([data-size])) patch on the
 *     rendered-sitekey selector, gets one of the two wrong.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MANAGED_CAPTCHA_VISIBILITY_CAPABILITY, type ManagedBrowserResult } from './browserbase';
import {
  buildManagedCaptchaProbeActions,
  CAPTCHA_BLOCKER,
  corroborateManagedCaptchaBlockers,
  managedCaptchaVerdictIsCorroborated,
  managedResultRequiresCaptchaAttention,
  managedResultSupportsCaptchaVisibility,
  readManagedCaptchaEvidence,
} from './portalSubmission';

type ContractCase = {
  name: string;
  source: string;
  note: string;
  html: string;
  emitted: {
    extracted: Array<{ selector: string; label?: string; value: string | null }>;
    capabilities: string[] | null;
    captchaSkipped: string[];
    runnerBlockedOnCaptcha: boolean;
  };
  expected: { requiresAttention: boolean; corroborated: boolean; runnerBlocked: boolean };
};

const contract = JSON.parse(
  readFileSync('src/lib/fixtures/captcha-visibility-contract.json', 'utf8'),
) as { actions: unknown[]; cases: ContractCase[] };

/** The emission as a result object, with nothing added that the runner did not send. */
function resultOf(entry: ContractCase): ManagedBrowserResult {
  return {
    title: 'Fixture',
    url: 'http://127.0.0.1/',
    text: '',
    extracted: entry.emitted.extracted,
    ...(entry.emitted.capabilities ? { capabilities: entry.emitted.capabilities } : {}),
  };
}

test('the contract pins the action list this repo actually sends', () => {
  /* Without this the file would be a set of pages the runner was asked something ELSE about, and
     every verdict below would be about a question production never asks. It is also what makes a
     change to the selectors fail here: edit the badge exclusion and this stops matching. */
  assert.deepEqual(JSON.parse(JSON.stringify(buildManagedCaptchaProbeActions())), contract.actions);
});

test('every contract case carries a runner emission and a page it came from', () => {
  assert.equal(contract.cases.length, 5);
  for (const entry of contract.cases) {
    assert.ok(entry.html.length > 0, entry.name + ' must carry the page it was measured on');
    assert.deepEqual(entry.emitted.capabilities, [MANAGED_CAPTCHA_VISIBILITY_CAPABILITY],
      entry.name + ': the emission must say the layout read was honoured');
  }
});

for (const entry of contract.cases) {
  test('managed captcha verdict on ' + entry.name, () => {
    const result = resultOf(entry);
    assert.equal(
      managedResultRequiresCaptchaAttention(result),
      entry.expected.requiresAttention,
      entry.name + ': ' + entry.note,
    );
    assert.equal(
      managedCaptchaVerdictIsCorroborated('lever', result),
      entry.expected.corroborated,
      entry.name + ' corroboration: ' + entry.note,
    );
    /* THE THIRD LAYER, ON THE SAME DOM. The runner's own blocker predicate ran over the same fixture
       page in the same Chromium and its answer is recorded in the contract. The defect being fixed
       was these two disagreeing, so agreeing is the assertion. */
    assert.equal(
      entry.emitted.runnerBlockedOnCaptcha,
      entry.expected.runnerBlocked,
      entry.name + ': the runner predicate is pinned to the same answer',
    );
    assert.equal(managedResultSupportsCaptchaVisibility(result), true);
    assert.equal(readManagedCaptchaEvidence(result).visibilityConfirmed, true);
  });
}

test('a lever posting showing nobody anything keeps no CAPTCHA blocker', () => {
  /* The end the applicant sees. lever is autonomous and not captcha-gated, so before this change the
     blocker survived corroboration - the corroboration reads the same evidence through the same
     predicates, which is the tautology its own comment warns about - and submissionRunner threw
     CaptchaUnresolvedError before the packet was even built. */
  const entry = contract.cases.find((one) => one.name === 'lever_invisible_hcaptcha')!;
  assert.deepEqual(
    corroborateManagedCaptchaBlockers('lever', [CAPTCHA_BLOCKER, 'Resume upload failed'], resultOf(entry)),
    ['Resume upload failed'],
  );
});

test('a real visible reCAPTCHA keeps its blocker on a family that could otherwise submit', () => {
  // The contrast, and the one that has to hold whatever else changes. Same call, same autonomous
  // family, a page that really is asking: the blocker stays.
  const entry = contract.cases.find((one) => one.name === 'jazzhr_visible_recaptcha')!;
  assert.deepEqual(
    corroborateManagedCaptchaBlockers('lever', [CAPTCHA_BLOCKER], resultOf(entry)),
    [CAPTCHA_BLOCKER],
  );
});

/* ---------------------------------------------------------------------------------------------
 * THE PRE-FIX EMISSION, KEPT AS EVIDENCE RATHER THAN DELETED.
 *
 * Verbatim from the 2026-08-12 sweep: the six probe extracts replayed against
 * jobs.lever.co/palantir/d5486403-c050-4920-b2e0-91b69b61ebb2/apply in real Chromium, through the
 * shipped attribute-only reading. Two entries came back, both naming a container that is 1380x0.
 *
 * It is pinned for two reasons. It reproduces the defect, so the fix cannot be believed on the
 * strength of a fixture written after the fact. And it states the ROLLOUT dependency out loud: a
 * runner that has not deployed the visibility read still emits this, and this still blocks. The
 * capability is the only thing in the payload that tells the two apart, which is why it is asserted
 * rather than assumed.
 * ------------------------------------------------------------------------------------------- */
const PRE_FIX_LEVER_EMISSION: ManagedBrowserResult = {
  title: 'Palantir Technologies',
  url: 'https://jobs.lever.co/palantir/d5486403-c050-4920-b2e0-91b69b61ebb2/apply',
  text: '',
  extracted: [
    {
      selector: '[data-sitekey]:not(.grecaptcha-badge):not(.grecaptcha-badge *)',
      label: 'captcha_challenge',
      value: 'e33f87f8-88ec-4e1a-9a13-df9bbb1d8120',
    },
    {
      selector: '[data-sitekey]:not([data-size="invisible" i]):not(.grecaptcha-badge):not(.grecaptcha-badge *)',
      label: 'captcha_rendered_sitekey',
      value: 'e33f87f8-88ec-4e1a-9a13-df9bbb1d8120',
    },
  ],
};

test('the measured pre-fix emission still reproduces the block, and says why it is trusted less', () => {
  assert.equal(managedResultSupportsCaptchaVisibility(PRE_FIX_LEVER_EMISSION), false);
  assert.equal(readManagedCaptchaEvidence(PRE_FIX_LEVER_EMISSION).visibilityConfirmed, false);
  // The defect, reproduced. An attribute-only reading of this page cannot reach any other answer,
  // which is the argument for changing what the runner sends rather than how the rules read it.
  assert.equal(managedResultRequiresCaptchaAttention(PRE_FIX_LEVER_EMISSION), true);
  assert.equal(managedCaptchaVerdictIsCorroborated('lever', PRE_FIX_LEVER_EMISSION), true);
  // And the same page under the layout read, from the contract: the opposite answer.
  const fixed = contract.cases.find((one) => one.name === 'lever_invisible_hcaptcha')!;
  assert.equal(managedResultRequiresCaptchaAttention(resultOf(fixed)), false);
});

test('the visible and invisible hCaptcha pages are indistinguishable by attribute alone', () => {
  /* THE ARGUMENT AGAINST THE CHEAP FIX, made as an assertion instead of a paragraph.
   *
   * Both pages mount div.h-captcha[data-sitekey] with the same key and no data-size, because
   * hCaptcha never writes one. Their extract-visible emissions differ ONLY because one container has
   * a box. Any rule that decides from the markup, including appending
   * :not(.h-captcha:not([data-size])) to the rendered-sitekey selector, returns one answer for both
   * of them, and one of the two answers is a submit click under a live challenge. */
  const hidden = contract.cases.find((one) => one.name === 'lever_invisible_hcaptcha')!;
  const shown = contract.cases.find((one) => one.name === 'visible_hcaptcha_without_data_size')!;
  const attributesOf = (entry: ContractCase) => (entry.html.match(/<div[^>]*id="h-captcha"[^>]*>/) ?? [''])[0]
    .replace(/\s*style="[^"]*"/, '');
  assert.equal(attributesOf(hidden), attributesOf(shown));
  assert.notEqual(attributesOf(hidden), '');
  assert.equal(managedResultRequiresCaptchaAttention(resultOf(hidden)), false);
  assert.equal(managedResultRequiresCaptchaAttention(resultOf(shown)), true);
});

test('the badge-only pages carry no anchor evidence at all, with or without size=invisible', () => {
  /* THE LATENT FRAGILITY. ANCHOR_DECLARES_INVISIBLE_RE reads a substring of Google's own query
     string, and on 24 of the 30 postings measured it was the only thing standing between the page
     and "CAPTCHA requires your attention". This asserts the evidence is empty at the SELECTOR, so
     the regex is a second line rather than the wall: strip the parameter and the answer is the same.
     Remove the badge exclusion from MANAGED_CAPTCHA_ANCHOR_SELECTOR and the action-list assertion at
     the top of this file fails, and the runner's emission for these two pages changes in the stratus
     repo against the same contract file. */
  for (const name of ['greenhouse_badge_only', 'greenhouse_badge_only_without_size_parameter']) {
    const entry = contract.cases.find((one) => one.name === name)!;
    const evidence = readManagedCaptchaEvidence(resultOf(entry));
    assert.deepEqual(evidence.anchorSrcs, [], name + ': the badge anchor must not be evidence');
    assert.equal(evidence.bframeSrc, null, name);
    assert.deepEqual(evidence.sitekeys, [], name);
  }
  const stripped = contract.cases.find((one) => one.name === 'greenhouse_badge_only_without_size_parameter')!;
  assert.ok(!stripped.html.includes('size=invisible'), 'the fixture must really have lost the parameter');
  assert.ok(stripped.html.includes('grecaptcha-badge'), 'and must still carry the badge it is about');
});
