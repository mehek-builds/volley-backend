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
 * WHAT THE CASES ARE. Eight pages built from the read-only sweep of 30 live postings on 2026-08-12,
 * each one chosen so its adversary can win:
 *   - lever_invisible_hcaptcha must NOT block, and blocked permanently before this change.
 *   - jazzhr_visible_recaptcha must block, and is the one genuine CAPTCHA in the sweep. Its bframe is
 *     mounted but hidden, so under the corrected bframe reading the verdict has to be carried by the
 *     visible widget and the visible anchor rather than waved through by a presence check.
 *   - greenhouse_badge_only must NOT block: the shape 24 of the 30 postings carry.
 *   - greenhouse_badge_only_without_size_parameter must NOT block with Google's size=invisible gone
 *     from the query string, which is the only thing that used to be holding those 24 back.
 *   - hcaptcha_overflowing_zero_height_container must block. Same markup as the Lever page and the
 *     same measured 1380x0 container, with the child in its painted state.
 *   - hcaptcha_escalated_challenge_over_zero_height_container must block: the image grid is open.
 *   - turnstile_overflowing_zero_height_container must block. Turnstile is the other provider whose
 *     only channel here is the [data-sitekey] container.
 *   - recaptcha_overflowing_zero_height_container must block, and is carried BECAUSE it passes
 *     without the subtree read. reCAPTCHA has a second channel, so the collapsed container costs it
 *     nothing; without it beside the two above the suite would read as though a node-only visibility
 *     rule were fine on every provider.
 *
 * THE FIXTURE THAT WAS WRONG, kept in the record because it is this project's signature failure. The
 * visible-hCaptcha case first hand-wrote its container as 303x78. No visible hCaptcha was measured
 * anywhere in the sweep; the one thing measured about a Lever container is that its height is 0 while
 * it holds non-zero children, so the height is imposed rather than derived from content. Assuming it
 * would go away in the visible state was the entire safety margin, and on that assumption a
 * node-only visibility read passed every case here while silently discarding correct CAPTCHA
 * blockers on hCaptcha, on Turnstile, and on an open challenge grid.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MANAGED_CAPTCHA_VISIBILITY_CAPABILITY, type ManagedBrowserResult } from './browserbase';
import {
  buildManagedCaptchaProbeActions,
  CAPTCHA_BLOCKER,
  corroborateManagedCaptchaBlockers,
  isCaptchaGatedFamily,
  managedCaptchaVerdictIsCorroborated,
  managedResultRequiresCaptchaAttention,
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

const CONTRACT_PATH = 'src/lib/fixtures/captcha-visibility-contract.json';
const CONTRACT_BYTES = readFileSync(CONTRACT_PATH);
const contract = JSON.parse(CONTRACT_BYTES.toString('utf8')) as { actions: unknown[]; cases: ContractCase[] };

/* THE DIGEST, PINNED HERE AND IN THE STRATUS REPLAY AS THE SAME 64 CHARACTERS.
 *
 * Everything else in this file proves that THIS repo agrees with the file. Nothing in either repo
 * could previously prove the two COPIES of the file agree with each other, so a hand-edit of this
 * copy alone passed both suites and the shared artifact silently stopped being shared. Pinning the
 * bytes means editing either copy fails that copy's repo until its literal is updated, and the two
 * literals sit in two pull requests where a reviewer can compare them without leaving the diff. It
 * is not a cross-repo lock, which nothing without shared CI can be. It is what turns a silent
 * divergence into a red suite and a visible constant. */
const CONTRACT_SHA256 = '3561ff6813e9b655c5eb4a74cd3a3ec19545ee82b2aabc1963b3e090b280b4b6';

test('the contract file is the bytes both repos are pinned to', () => {
  assert.equal(
    createHash('sha256').update(CONTRACT_BYTES).digest('hex'),
    CONTRACT_SHA256,
    'the contract changed: update CONTRACT_SHA256 here and in stratus, and copy the file across',
  );
});

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
  assert.equal(contract.cases.length, 8);
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
    assert.deepEqual(entry.emitted.capabilities, [MANAGED_CAPTCHA_VISIBILITY_CAPABILITY]);
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
  assert.equal(PRE_FIX_LEVER_EMISSION.capabilities, undefined);
  // The defect, reproduced. An attribute-only reading of this page cannot reach any other answer,
  // which is the argument for changing what the runner sends rather than how the rules read it.
  assert.equal(managedResultRequiresCaptchaAttention(PRE_FIX_LEVER_EMISSION), true);
  assert.equal(managedCaptchaVerdictIsCorroborated('lever', PRE_FIX_LEVER_EMISSION), true);
  // And the same page under the layout read, from the contract: the opposite answer.
  const fixed = contract.cases.find((one) => one.name === 'lever_invisible_hcaptcha')!;
  assert.equal(managedResultRequiresCaptchaAttention(resultOf(fixed)), false);
});

test('the two hCaptcha pages are identical in markup AND in container geometry', () => {
  /* THE ARGUMENT AGAINST THE CHEAP FIX, made as an assertion instead of a paragraph, and now made
   * against the geometry that was actually measured rather than one that was assumed.
   *
   * Both pages mount div.h-captcha[data-sitekey] with the same key and no data-size: Lever renders
   * hCaptcha programmatically and writes none. Both containers are the measured 1380x0. Every
   * attribute matches, the style attribute matches, and the correct answers are opposite. The only
   * difference in the whole document is what the CHILDREN are doing, so:
   *   - a rule reading attributes gets one of the two wrong. That includes appending
   *     :not(.h-captcha:not([data-size])) to the rendered-sitekey selector, whose answer for both is
   *     "not rendered", which on the second page is a submit click under a live challenge.
   *   - a layout rule asked of the matched NODE ONLY also gets one of the two wrong, in the same
   *     direction, because both containers have a 1380x0 border box. That was the defect found in
   *     review on the first version of this change.
   * Only a rule that looks at what the container paints can separate them. */
  const hidden = contract.cases.find((one) => one.name === 'lever_invisible_hcaptcha')!;
  const shown = contract.cases.find((one) => one.name === 'hcaptcha_overflowing_zero_height_container')!;
  const containerOf = (entry: ContractCase) => (entry.html.match(/<div[^>]*id="h-captcha"[\s\S]*?>/) ?? [''])[0]
    .replace(/\s+/g, ' ');
  assert.notEqual(containerOf(hidden), '');
  assert.equal(containerOf(hidden), containerOf(shown));
  assert.match(containerOf(hidden), /width:1380px;height:0/);
  assert.ok(!containerOf(hidden).includes('data-size'), 'neither page declares a size');
  assert.equal(managedResultRequiresCaptchaAttention(resultOf(hidden)), false);
  assert.equal(managedResultRequiresCaptchaAttention(resultOf(shown)), true);
});

test('a correct runner blocker survives on every container-only provider', () => {
  /* THE REVIEW FINDING, as the assertion it should always have been. On these three pages the runner
   * raised a correct CAPTCHA blocker from the same DOM, and the managed evidence answered "nothing
   * here" because the widget container's border box is 1380x0. corroborateManagedCaptchaBlockers
   * then DELETED the blocker, which sends a run into a challenge it cannot clear: the direction that
   * loses an application outright rather than stranding one.
   *
   * lever is autonomous and not captcha-gated, so nothing else in the chain would have kept it. */
  assert.equal(isCaptchaGatedFamily('lever'), false);
  for (const name of [
    'hcaptcha_overflowing_zero_height_container',
    'hcaptcha_escalated_challenge_over_zero_height_container',
    'turnstile_overflowing_zero_height_container',
    'recaptcha_overflowing_zero_height_container',
  ]) {
    const entry = contract.cases.find((one) => one.name === name)!;
    assert.equal(entry.emitted.runnerBlockedOnCaptcha, true, name + ': the runner must have raised one');
    assert.deepEqual(
      corroborateManagedCaptchaBlockers('lever', [CAPTCHA_BLOCKER], resultOf(entry)),
      [CAPTCHA_BLOCKER],
      name + ': a correct blocker must not be discarded',
    );
  }
});

test('the capability is asserted on the wire and branched on nowhere', () => {
  /* WHAT WAS TRIED AND REJECTED, kept as a test so the next reader does not re-derive it.
   *
   * The obvious use for the capability is to refuse to let corroborateManagedCaptchaBlockers delete
   * the runner's CAPTCHA claim when this repo's counter-evidence was never asked a layout question.
   * It reads well and it is backwards: the only runners lacking the capability are OLDER runners,
   * and the older one is, the worse the predicate raising the claim, so the guard would be most
   * active exactly where the claim deserves least trust. It also reversed a policy bought with
   * fourteen production stalls.
   *
   * So the capability is a wire assertion, not a branch, and this pins both halves of that: the
   * emission must carry it, and the corroboration answer must not depend on it. */
  const badge = contract.cases.find((one) => one.name === 'greenhouse_badge_only')!;
  const withCapability = resultOf(badge);
  const withoutCapability: ManagedBrowserResult = { ...withCapability, capabilities: [] };
  assert.deepEqual(badge.emitted.capabilities, [MANAGED_CAPTCHA_VISIBILITY_CAPABILITY]);
  assert.deepEqual(corroborateManagedCaptchaBlockers('lever', [CAPTCHA_BLOCKER], withCapability), []);
  assert.deepEqual(corroborateManagedCaptchaBlockers('lever', [CAPTCHA_BLOCKER], withoutCapability), []);
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
