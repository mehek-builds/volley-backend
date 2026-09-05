import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {
  MANAGED_ATOMIC_SUBMIT_V4_CAPABILITY,
  MANAGED_APPLICATION_SUBMIT_CHOOSER_POLICY,
  MANAGED_EXACT_PAGE_URL_CAPABILITY,
  MANAGED_SUBMIT_CHOOSER_POLICY,
  runManagedBrowser,
  type ManagedBrowserResult,
} from './browserbase';
import { reparseThroughPlaywrightSerialization } from './playwrightSerializationRoundTrip';
import {
  assertManagedApplicationFinalSubmitSelected,
  assertManagedApplicationSubmitConsistency,
  assertManagedRequiredFieldsConfirmed,
  AUTONOMOUS_PORTAL_FAMILIES,
  buildManagedPortalActions,
  COMMIT_REQUIRED_CONTROLS_FOR_SUBMIT,
  CRELATE_FINAL_SUBMIT_SELECTOR,
  MANAGED_ACTION_LIMIT,
  MANAGED_BLOCKER_REASONS,
  MANAGED_PRE_PRESS_BLOCKER_REASONS,
  MANAGED_UNBOUND_SCOPE_BLOCKER_REASONS,
  MANAGED_FINAL_SUBMIT_SELECTOR,
  MANAGED_WORKABLE_APPLICATION_SCOPE_SELECTOR,
  managedApplicationUsesAtomicSubmitV4,
  managedApplicationProofIsRequired,
  ManagedActionBudgetError,
  ManagedConfirmationUnprovenError,
  ManagedRequiredFieldConfirmationError,
  NoSubmitControlError,
  UNATTRIBUTED_REQUIRED_BLOCKER,
  type SubmissionPacket,
  type SupportedPortal,
  WORKABLE_ATOMIC_SUBMIT_V4_ENABLED,
} from './portalSubmission';

const FINAL_CHOOSER_URL = 'https://apply.workable.com/example/j/ABC123/';
const FINAL_CHOOSER_SCREENSHOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function finalChooserNoClick(
  outcome: 'no_submit_control' | 'ambiguous_submit' = 'no_submit_control',
): ManagedBrowserResult {
  const ambiguous = outcome === 'ambiguous_submit';
  return {
    title: 'Apply',
    url: FINAL_CHOOSER_URL,
    text: 'Application',
    screenshot: FINAL_CHOOSER_SCREENSHOT,
    blockedSubmits: 0,
    exactPageUrlProof: {
      expected: FINAL_CHOOSER_URL,
      beforeActions: FINAL_CHOOSER_URL,
      beforeApplicantData: FINAL_CHOOSER_URL,
      beforeFinalChooser: FINAL_CHOOSER_URL,
      beforeSubmit: null,
    },
    finalSubmitChooser: {
      version: 1 as const,
      policyName: 'litos-final-submit' as const,
      policyVersion: 4 as const,
      grammarHash: MANAGED_APPLICATION_SUBMIT_CHOOSER_POLICY.grammarHash,
      submitKind: 'application' as const,
      outcome,
      candidateCount: ambiguous ? 2 : 0,
      viableCandidateCount: ambiguous ? 2 : 0,
      topScore: ambiguous ? 1 : null,
      topScoreCount: ambiguous ? 2 : 0,
      addressedScopeCount: 1,
      bareSendCandidateCount: 0,
    },
    submitOutcome: {
      pressed: false,
      state: 'not_attempted' as const,
      source: null,
      evidence: null,
      message: null,
      formStillPresent: null,
    },
    securityCodeAttempt: null,
    requiredFieldConfirmation: null,
  };
}

const packet: SubmissionPacket = {
  fullName: 'Taylor Example',
  email: 'taylor@example.com',
  phone: '+1 415 555 0101',
  city: 'San Francisco',
  resume: Buffer.from('pdf'),
  resumeName: 'resume.pdf',
  questions: [],
};

function proof(
  inputAttempts: Array<Omit<NonNullable<ManagedBrowserResult['requiredFieldConfirmation']>['passes'][number]['attempts'][number], 'attemptCount'> & { attemptCount?: 1 | 2 }>,
  overrides: Partial<NonNullable<ManagedBrowserResult['requiredFieldConfirmation']>['passes'][number]>
    & { status?: 'confirmed' | 'blocked' } = {},
): Pick<ManagedBrowserResult, 'requiredFieldConfirmation'> {
  const attempts = inputAttempts.map((attempt) => ({ attemptCount: 1 as const, ...attempt }));
  const { status = 'confirmed', ...passOverrides } = overrides;
  return {
    requiredFieldConfirmation: {
      version: 2,
      status,
      passes: [{
        submitKind: 'application',
        scope: {
          formFingerprint: 'form_fingerprint_fixture_1234',
          submitFingerprint: 'submit_fingerprint_fixture_1234',
          formMatchCount: 1,
          submitMatchCount: 1,
          requiredControlCount: attempts.length,
          sameNode: true,
        },
        requiredControls: attempts.map(({ selector, label, fieldType }) => ({ selector, label, fieldType, matchCount: 1 })),
        retries: 0,
        unresolved: [],
        attempts,
        submissionOutcome: 'clicked',
        ...passOverrides,
      }],
    },
  };
}

/* THE ATOMIC PRESS CONTRACT, PINNED AS A LITERAL ON THIS SIDE OF THE WIRE.
 *
 * stratus-browser-cloud's normalizeManagedActions accepts a confirmAndSubmit only when its selector
 * is byte-for-byte its own ATOMIC_SUBMIT_SELECTOR (src/managed-browser.js), and answers 400
 * INVALID_CONFIRM_AND_SUBMIT_SELECTOR before any browser opens otherwise. The two repos deploy
 * independently, so the string is mirrored here as a literal rather than imported from
 * MANAGED_FINAL_SUBMIT_SELECTOR: a change to either side's constant fails this test instead of
 * failing every send in production. Crelate is called out because it was the family that carried
 * its own exact selector into this action and was refused on every send from 2026-08-09 until The
 * Maven Group reached the press on 2026-09-02. */
const STRATUS_ATOMIC_SUBMIT_SELECTOR =
  'button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]';

test('every family sends the atomic press with the exact selector stratus accepts', () => {
  assert.equal(MANAGED_FINAL_SUBMIT_SELECTOR, STRATUS_ATOMIC_SUBMIT_SELECTOR);
  for (const family of AUTONOMOUS_PORTAL_FAMILIES) {
    const actions = buildManagedPortalActions(family as SupportedPortal, packet, true);
    const submit = actions.at(-1);
    assert.equal(submit?.type, 'confirmAndSubmit', `${family} ends on the atomic press`);
    assert.equal(submit?.selector, STRATUS_ATOMIC_SUBMIT_SELECTOR, `${family} sends the canonical candidate set`);
  }
  // The exact crelate control is the DIRECT path's business and never rides the managed press.
  assert.notEqual(CRELATE_FINAL_SUBMIT_SELECTOR, STRATUS_ATOMIC_SUBMIT_SELECTOR);
});

test('every managed application submit defaults to v3 and reserves its confirmation barrier', () => {
  for (const family of AUTONOMOUS_PORTAL_FAMILIES) {
    const actions = buildManagedPortalActions(family as SupportedPortal, packet, true);
    const finalSelector = MANAGED_FINAL_SUBMIT_SELECTOR;
    assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `${family} exceeded the managed action limit`);
    assert.deepEqual(actions.at(-1), {
      type: 'confirmAndSubmit',
      selector: finalSelector,
      label: 'required_field_confirmation',
      optional: false,
      timeout: 10_000,
      maxRetries: 1,
      contractVersion: 2,
      submitKind: 'application',
      chooserPolicy: MANAGED_SUBMIT_CHOOSER_POLICY,
    });
    assert.equal(actions.filter((action) => action.type === 'click'
      && action.selector === finalSelector).length, 0);
  }
});

test('only one exact native Workable application route emits the cross-repo v4 contract', () => {
  const applicationUrl = 'https://apply.workable.com/example/j/ABC123/apply';
  const actions = buildManagedPortalActions('workable', packet, true, applicationUrl);
  const exactCapabilities = actions.filter((action) => action.type === 'requireCapability'
    && action.value === MANAGED_EXACT_PAGE_URL_CAPABILITY);
  const atomicCapabilities = actions.filter((action) => action.type === 'requireCapability'
    && action.value === MANAGED_ATOMIC_SUBMIT_V4_CAPABILITY);
  assert.deepEqual(exactCapabilities, [{
    type: 'requireCapability',
    value: MANAGED_EXACT_PAGE_URL_CAPABILITY,
    optional: false,
    expectedPageUrl: applicationUrl,
  }]);
  assert.equal(
    MANAGED_WORKABLE_APPLICATION_SCOPE_SELECTOR,
    'form:has(input[name="firstname"]):has(input[name="email"]):has(input[type="file"][data-ui="resume"])',
  );
  if (WORKABLE_ATOMIC_SUBMIT_V4_ENABLED) {
    assert.deepEqual(atomicCapabilities, [{
      type: 'requireCapability',
      value: MANAGED_ATOMIC_SUBMIT_V4_CAPABILITY,
      optional: false,
      applicationScopeSelector: MANAGED_WORKABLE_APPLICATION_SCOPE_SELECTOR,
    }]);
    assert.equal(actions.at(-1)?.chooserPolicy, MANAGED_APPLICATION_SUBMIT_CHOOSER_POLICY);
  } else {
    /* v4 off for Workable (see managedApplicationUsesAtomicSubmitV4): no atomic capability is
       emitted and the press takes the v3 chooser every other family takes. */
    assert.deepEqual(atomicCapabilities, []);
    assert.equal(actions.at(-1)?.chooserPolicy, MANAGED_SUBMIT_CHOOSER_POLICY);
  }
  assert.equal(actions.at(-1)?.type, 'confirmAndSubmit');
  assert.equal(actions.at(-1)?.expectedPageUrl, applicationUrl);
  assert.equal(actions.filter((action) => action.type === 'confirmAndSubmit').length, 1);
  if (WORKABLE_ATOMIC_SUBMIT_V4_ENABLED) {
    assert.equal(actions.some((action) => action.type === 'confirmAndSubmit'
      && action.chooserPolicy?.version === 3), false,
    'a v4 refusal has no v3 submit action to fall through to in the same run');
  }
});

test('a production Workable v4 invalid phone stops cleanly before any Stratus request', { skip: !WORKABLE_ATOMIC_SUBMIT_V4_ENABLED && 'v4 is switched off for Workable; the v3 path confirms the phone on the page' }, async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error('network should be unreachable');
  }) as typeof fetch;

  try {
    const applicationUrl = 'https://apply.workable.com/example/j/ABC123/apply';
    await assert.rejects(
      async () => {
        const actions = buildManagedPortalActions('workable', {
          ...packet,
          phone: '+442071234567',
        }, true, applicationUrl);
        await runManagedBrowser(applicationUrl, actions, { allowSubmit: true });
      },
      (error: unknown) => error instanceof ManagedRequiredFieldConfirmationError
        && error.fields.includes('Phone')
        && /exact Workable country and national value/.test(error.message)
        && !/atomic submit v4 capability requires/.test(error.message),
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('host, family, and application route all have to match before managed v4 is selected', () => {
  const v4Urls = [
    'https://apply.workable.com/example/j/ABC123/apply',
    'https://apply.workable.com/j/ABC123/apply/',
    'https://apply.workable.com/example/j/ABC123/apply?source=litos',
  ];
  for (const url of v4Urls) {
    /* The native route is the shape v4 selects on - but v4 is switched off for Workable until it can
       carry a resume (WORKABLE_ATOMIC_SUBMIT_V4_ENABLED, see managedApplicationUsesAtomicSubmitV4),
       so today these take v3 like every other family. */
    assert.equal(managedApplicationUsesAtomicSubmitV4('workable', url), WORKABLE_ATOMIC_SUBMIT_V4_ENABLED, url);
    assert.equal(
      buildManagedPortalActions('workable', packet, true, url).at(-1)?.chooserPolicy?.version,
      WORKABLE_ATOMIC_SUBMIT_V4_ENABLED ? 4 : MANAGED_SUBMIT_CHOOSER_POLICY.version,
      url,
    );
  }

  const v3Cases: Array<[SupportedPortal, string]> = [
    ['workable', 'https://apply.workable.com/example/j/ABC123/'],
    ['workable', 'https://apply.workable.com/example/j/ABC123/apply/extra'],
    ['workable', 'https://www.workable.com/example/j/ABC123/apply'],
    ['workable', 'https://apply.workable.com.evil.example/example/j/ABC123/apply'],
    ['workable', 'https://apply.workable.com:444/example/j/ABC123/apply'],
    ['workable', 'http://apply.workable.com/example/j/ABC123/apply'],
    ['controlled_workable', 'https://qa.example.test/qa/portal-submission?board=workable'],
    ['greenhouse', 'https://job-boards.greenhouse.io/example/jobs/123'],
    ['lever', 'https://jobs.lever.co/example/123'],
    ['ashby', 'https://jobs.ashbyhq.com/example/123/application'],
  ];
  for (const [portal, url] of v3Cases) {
    assert.equal(managedApplicationUsesAtomicSubmitV4(portal, url), false, `${portal}: ${url}`);
    const actions = buildManagedPortalActions(portal, packet, true, url);
    const submit = actions.find((action) => action.type === 'confirmAndSubmit');
    if (submit) assert.equal(submit.chooserPolicy, MANAGED_SUBMIT_CHOOSER_POLICY, `${portal}: ${url}`);
    assert.equal(actions.some((action) => action.value === MANAGED_ATOMIC_SUBMIT_V4_CAPABILITY), false);
  }
});

test('Workable v4 budget pressure keeps both required boundaries or blocks before submit', { skip: !WORKABLE_ATOMIC_SUBMIT_V4_ENABLED && 'v4 is switched off for Workable; the v4 budget contract is pinned again when it returns' }, () => {
  const applicationUrl = 'https://apply.workable.com/example/j/ABC123/apply';
  let completed = 0;
  let blocked = 0;
  for (let count = 100; count <= 120; count += 1) {
    const crowded: SubmissionPacket = {
      ...packet,
      questions: Array.from({ length: count }, (_, index) => ({
        question: `Required Workable screener ${index}`,
        answer: `Reviewed answer ${index}`,
      })),
    };
    try {
      const actions = buildManagedPortalActions('workable', crowded, true, applicationUrl);
      assert.deepEqual(
        actions.filter((action) => action.type === 'requireCapability'
          && (action.value === MANAGED_EXACT_PAGE_URL_CAPABILITY
            || action.value === MANAGED_ATOMIC_SUBMIT_V4_CAPABILITY))
          .map((action) => action.value),
        [MANAGED_EXACT_PAGE_URL_CAPABILITY, MANAGED_ATOMIC_SUBMIT_V4_CAPABILITY],
        `the ${count}-question v4 list lost a required capability during budget trimming`,
      );
      assert.equal(actions.at(-1)?.type, 'confirmAndSubmit');
      assert.equal(actions.at(-1)?.chooserPolicy, MANAGED_APPLICATION_SUBMIT_CHOOSER_POLICY);
      completed += 1;
    } catch (error) {
      assert.ok(error instanceof ManagedActionBudgetError, `unexpected failure at ${count} questions`);
      assert.equal(error.submitActionAppended, false);
      blocked += 1;
    }
  }
  assert.ok(completed > 0, 'the measured v4 form must fit below the protected budget boundary');
  assert.ok(blocked > 0, 'the fixture must exercise the fail-closed protected budget boundary');
});

test('confirmation is bound to the exact final-submit chooser instead of the first form on the page', () => {
  const actions = buildManagedPortalActions('lever', packet, true);
  const confirmation = actions.at(-1);
  assert.equal(confirmation?.type, 'confirmAndSubmit');
  assert.equal(confirmation?.selector, MANAGED_FINAL_SUBMIT_SELECTOR);
  assert.equal(confirmation?.contractVersion, 2);
  assert.equal(confirmation?.submitKind, 'application');
  assert.notEqual(confirmation?.selector, 'form');

  // Fixture shape: form[0] is an unrelated newsletter with no required controls. The application
  // form selected through its final submit still owns this stale required error and must block.
  assert.throws(() => assertManagedRequiredFieldsConfirmed(proof([{
    selector: 'input[name="application_email"]',
    label: 'Application email',
    fieldType: 'text',
    outcome: 'failed',
    attemptCount: 2,
    reason: 'This requires an answer',
  }], {
    status: 'blocked',
    submissionOutcome: 'blocked',
    retries: 1,
    unresolved: ['Application email'],
  })));
});

test('atomic submit discovery includes common ATS submit shapes without a separate generic click', () => {
  const actions = buildManagedPortalActions('greenhouse', packet, true);
  const atomic = actions.at(-1)!;
  assert.equal(atomic.type, 'confirmAndSubmit');
  for (const shape of ['button', 'input[type="submit"]', 'input[type="image"]', '[role="button"]']) {
    assert.ok(atomic.selector?.includes(shape), shape);
  }
  assert.equal(actions.some((action) => action.type === 'click'
    && action.selector === MANAGED_FINAL_SUBMIT_SELECTOR), false);
});

test('an empty confirmed scan needs a distinct zero-control form proof', () => {
  assert.doesNotThrow(() => assertManagedRequiredFieldsConfirmed(proof([])));
  const omitted = proof([]);
  omitted.requiredFieldConfirmation!.passes[0]!.scope.requiredControlCount = 1;
  assert.throws(() => assertManagedRequiredFieldsConfirmed(omitted), /scan control count/);
});

test('each remote run attests exactly one physical click with the expected kind', () => {
  const receipt = proof([]);
  const application = receipt.requiredFieldConfirmation!.passes[0]!;
  const verification = {
    ...application,
    submitKind: 'verification' as const,
    scope: {
      ...application.scope,
      formFingerprint: 'verification_form_fixture_1234',
      submitFingerprint: 'verification_submit_fixture_1234',
    },
  };
  assert.doesNotThrow(() => assertManagedRequiredFieldsConfirmed(receipt, 'application'));
  assert.throws(() => assertManagedRequiredFieldsConfirmed(receipt, 'verification'), /unexpected submit kind/);
  receipt.requiredFieldConfirmation!.passes = [verification];
  assert.doesNotThrow(() => assertManagedRequiredFieldsConfirmed(receipt, 'verification'));
  receipt.requiredFieldConfirmation!.passes = [application, verification];
  assert.throws(() => assertManagedRequiredFieldsConfirmed(receipt), /confirmation passes/);
});

/* THE ONE STATE THAT OWES NO APPLICATION PROOF, AND IT IS NARROWER THAN THE SKIP WAS WRITTEN.
 *
 * A code wall that was ALREADY STANDING when the page loaded produces no application submit pass,
 * because Stratus will not press the disabled application control from there, so asserting one
 * would fail every retained-wall run. Everything else does owe the proof, including the ordinary
 * way a Greenhouse wall appears: press Send, get refused, get asked for a code. Keying the skip on
 * the challenge alone excused that run too, so a runner that pressed with its required-field proof
 * blocked, malformed or absent walked past the only place this service checks it.
 */
test('only an already standing code wall is excused the application submit proof', () => {
  const standingWall = { digits: 8, sentTo: 'app@apply.trylitos.com' };
  assert.equal(managedApplicationProofIsRequired(standingWall, { pressed: false }), false,
    'no application pass exists on a wall Stratus refused to press through');
  assert.equal(managedApplicationProofIsRequired(standingWall, { pressed: true }), true,
    'a run that pressed Send and then met a code wall still has to prove what it pressed');
  assert.equal(managedApplicationProofIsRequired(null, { pressed: true }), true);
  assert.equal(managedApplicationProofIsRequired(null, { pressed: false }), true);
  // A runner too old to report submitOutcome says nothing about its own click, so it is not excused.
  assert.equal(managedApplicationProofIsRequired(standingWall, null), true);
  assert.equal(managedApplicationProofIsRequired(standingWall, {}), true);
});

test('the pressed half of the skip is what catches an unproven send at a code wall', () => {
  // End to end through the real assertion: the receipt below carries no proof at all, which is the
  // exact shape an older or misbehaving runner returns, and the guard has to reach it.
  const unproven = { requiredFieldConfirmation: undefined } as Record<string, unknown>;
  const standingWall = { digits: 8, sentTo: 'app@apply.trylitos.com' };
  const check = (challenge: unknown, pressed: boolean) => {
    if (!managedApplicationProofIsRequired(challenge, { pressed })) return 'skipped';
    try {
      assertManagedRequiredFieldsConfirmed(unproven, 'application');
      return 'passed';
    } catch {
      return 'caught';
    }
  };
  assert.equal(check(standingWall, true), 'caught', 'the regression let this one through');
  assert.equal(check(null, true), 'caught');
  assert.equal(check(standingWall, false), 'skipped');
});

test('v4 routes only fully proved no-control and ambiguity results to the pre-click stop', () => {
  for (const outcome of ['no_submit_control', 'ambiguous_submit'] as const) {
    assert.throws(
      () => assertManagedApplicationFinalSubmitSelected(finalChooserNoClick(outcome), FINAL_CHOOSER_URL),
      (error: unknown) => error instanceof NoSubmitControlError
        && !(error instanceof ManagedConfirmationUnprovenError),
    );
  }
  assert.throws(
    () => assertManagedApplicationFinalSubmitSelected(
      { ...finalChooserNoClick(), screenshot: null },
      FINAL_CHOOSER_URL,
    ),
    (error: unknown) => error instanceof ManagedConfirmationUnprovenError
      && !(error instanceof NoSubmitControlError),
  );
});

test('a later chooser change with blocked confirmation evidence stays unverified', () => {
  const changedAfterConfirmation = {
    ...finalChooserNoClick(),
    ...proof([], {
      status: 'blocked',
      submissionOutcome: 'blocked',
      blockerReason: 'submit_chooser_changed',
    }),
  };
  assert.throws(
    () => assertManagedApplicationFinalSubmitSelected(changedAfterConfirmation, FINAL_CHOOSER_URL),
    (error: unknown) => error instanceof ManagedConfirmationUnprovenError
      && !(error instanceof NoSubmitControlError),
  );
});

test('the Stratus v4 re-chooser blocker token is a valid blocked confirmation proof', () => {
  const changed = proof([], {
    status: 'blocked',
    submissionOutcome: 'blocked',
    blockerReason: 'submit_chooser_changed',
  });
  assert.throws(
    () => assertManagedRequiredFieldsConfirmed(changed, 'application'),
    (error: unknown) => error instanceof ManagedRequiredFieldConfirmationError
      && error.fields.includes('submit_chooser_changed'),
  );
});

test('a selected v4 chooser and clicked pass require a matching top-level click and URL boundary', () => {
  const selected = finalChooserNoClick();
  selected.finalSubmitChooser = {
    ...selected.finalSubmitChooser!,
    outcome: 'selected',
    candidateCount: 1,
    viableCandidateCount: 1,
    topScore: 1,
    topScoreCount: 1,
  };
  Object.assign(selected, proof([]));
  selected.submitOutcome = {
    pressed: true,
    state: 'unknown',
    source: null,
    evidence: null,
    message: null,
    formStillPresent: null,
  };
  selected.exactPageUrlProof!.beforeSubmit = FINAL_CHOOSER_URL;
  assert.doesNotThrow(() => assertManagedApplicationFinalSubmitSelected(selected, FINAL_CHOOSER_URL));
  assert.doesNotThrow(() => assertManagedRequiredFieldsConfirmed(selected, 'application'));
  assert.doesNotThrow(() => assertManagedApplicationSubmitConsistency(selected, FINAL_CHOOSER_URL));

  for (const contradiction of [
    {
      ...selected,
      submitOutcome: { ...selected.submitOutcome!, pressed: false, state: 'not_attempted' as const },
    },
    {
      ...selected,
      submitOutcome: { ...selected.submitOutcome!, state: 'not_attempted' as const },
    },
    {
      ...selected,
      exactPageUrlProof: { ...selected.exactPageUrlProof!, beforeSubmit: null },
    },
  ]) {
    assert.throws(
      () => assertManagedApplicationSubmitConsistency(contradiction, FINAL_CHOOSER_URL),
      (error: unknown) => error instanceof ManagedConfirmationUnprovenError
        && !(error instanceof NoSubmitControlError),
    );
  }
});

test('a selected Workable short link freezes its tenant URL through the final click', () => {
  const expected = 'https://apply.workable.com/j/20e78cba92/apply';
  const resolved = 'https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply';
  const selected = finalChooserNoClick();
  selected.finalSubmitChooser = {
    ...selected.finalSubmitChooser!,
    outcome: 'selected',
    candidateCount: 1,
    viableCandidateCount: 1,
    topScore: 1,
    topScoreCount: 1,
  };
  Object.assign(selected, proof([]));
  selected.submitOutcome = {
    pressed: true,
    state: 'unknown',
    source: null,
    evidence: null,
    message: null,
    formStillPresent: null,
  };
  selected.exactPageUrlProof = {
    expected,
    beforeActions: resolved,
    beforeApplicantData: resolved,
    beforeFinalChooser: resolved,
    beforeSubmit: resolved,
  };
  selected.url = resolved;
  assert.doesNotThrow(() => assertManagedApplicationSubmitConsistency(selected, expected));
  assert.throws(
    () => assertManagedApplicationSubmitConsistency({
      ...selected,
      exactPageUrlProof: {
        ...selected.exactPageUrlProof!,
        beforeSubmit: 'https://apply.workable.com/another-tenant/j/20E78CBA92/apply',
      },
    }, expected),
    (error: unknown) => error instanceof ManagedConfirmationUnprovenError,
  );
});

test('a replaced submit node cannot satisfy the atomic scope proof', () => {
  const replaced = proof([]) as { requiredFieldConfirmation: Record<string, unknown> };
  const replacedPass = (replaced.requiredFieldConfirmation.passes as Array<Record<string, unknown>>)[0]!;
  replacedPass.scope = { ...(replacedPass.scope as Record<string, unknown>), sameNode: false };
  replacedPass.submissionOutcome = 'blocked';
  replacedPass.blockerReason = 'submit_node_replaced';
  replaced.requiredFieldConfirmation.status = 'blocked';
  assert.throws(
    () => assertManagedRequiredFieldsConfirmed(replaced),
    (error: unknown) => error instanceof ManagedRequiredFieldConfirmationError
      && error.fields.includes('submit_node_replaced'),
  );
});

test('direct confirmation commits the visually filled custom box without changing its answer', async () => {
  let committed = false;
  let focused = false;
  const control = {
    disabled: false,
    value: 'Yes',
    getAttribute: (name: string) => name === 'role' ? 'radio' : name === 'aria-checked' ? 'true' : null,
    getClientRects: () => ({ length: 1 }),
    focus: () => { focused = true; },
    blur: () => undefined,
    dispatchEvent: (event: unknown) => {
      if ((event as { type?: string }).type === 'click') committed = true;
      return true;
    },
  };
  const form = { setAttribute: () => undefined, querySelectorAll: () => [control] };
  const result = await COMMIT_REQUIRED_CONTROLS_FOR_SUBMIT({
    closest: () => form,
    ownerDocument: { defaultView: {
      Event,
      requestAnimationFrame: (callback: () => void) => callback(),
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    } },
  });
  assert.deepEqual(result, { formFound: true, changed: false, committed: 1 });
  assert.equal(focused, true);
  assert.equal(committed, true, 'the exact selected box must receive its commit click');
  assert.equal(control.getAttribute('aria-checked'), 'true', 'confirmation must preserve the answer');
});

/* THIS IS THE ONE TEST THAT ACTUALLY EXERCISES THE BUG THIS FILE'S OWN FIX WAS FOR.
 *
 * Every other test here calls COMMIT_REQUIRED_CONTROLS_FOR_SUBMIT directly, in-process, as an
 * ordinary JS function - which proves its LOGIC but never its SERIALIZABILITY. The incident this
 * fix closed was never a logic bug: clickFinalSubmit hands this function to Playwright's
 * elementHandle.evaluate(), which calls Function.prototype.toString() on it, ships that source text
 * into the browser page, and re-parses it there with `new Function`. Under esbuild's `keepNames`
 * bundling, the reserialized source referenced a `__name(...)` helper that only exists in the
 * bundle's own module scope - so every direct in-process test kept passing while every real call
 * threw `ReferenceError: __name is not defined`, silently swallowed by clickFinalSubmit's
 * `.catch(() => null)`, and reported as "Litos could not bind required-field confirmation" on every
 * submission. A future edit that reintroduces that class of bug - referencing any binding that only
 * exists in this module's scope, not the function's own closure - would pass every test above and
 * only fail here, exactly as it would in a real browser. */
test('the exported confirmation function survives being serialized and re-parsed, the way Playwright actually runs it', async () => {
  const reparsed = reparseThroughPlaywrightSerialization(COMMIT_REQUIRED_CONTROLS_FOR_SUBMIT);

  let committed = false;
  const control = {
    disabled: false,
    value: 'Yes',
    getAttribute: (name: string) => name === 'role' ? 'radio' : name === 'aria-checked' ? 'true' : null,
    getClientRects: () => ({ length: 1 }),
    focus: () => undefined,
    blur: () => undefined,
    dispatchEvent: (event: unknown) => {
      if ((event as { type?: string }).type === 'click') committed = true;
      return true;
    },
  };
  const form = { setAttribute: () => undefined, querySelectorAll: () => [control] };
  const result = await reparsed({
    closest: () => form,
    ownerDocument: { defaultView: {
      Event,
      requestAnimationFrame: (callback: () => void) => callback(),
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    } },
  });
  assert.deepEqual(result, { formFound: true, changed: false, committed: 1 });
  assert.equal(committed, true, 'a reparsed copy must still behave exactly like the original');
});

async function commitMarkerOnlyRequiredControl(marker: { textContent: string; className: string }) {
  let events = 0;
  const control = {
    disabled: false,
    value: 'Yes',
    getAttribute: (name: string) => name === 'role' ? 'radio' : name === 'aria-checked' ? 'true' : null,
    getClientRects: () => ({ length: 1 }),
    focus: () => undefined,
    blur: () => undefined,
    dispatchEvent: () => { events += 1; return true; },
  };
  const markerNode = {
    ...marker,
    control: null,
    parentElement: { querySelector: () => control },
    getAttribute: () => null,
    querySelector: () => null,
    closest: () => ({ querySelector: () => control }),
  };
  const form = {
    setAttribute: () => undefined,
    querySelectorAll: (selector: string) => selector.startsWith('[required]') ? [] : [markerNode],
  };
  const result = await COMMIT_REQUIRED_CONTROLS_FOR_SUBMIT({
    closest: () => form,
    ownerDocument: {
      getElementById: () => null,
      defaultView: {
        Event,
        requestAnimationFrame: (callback: () => void) => callback(),
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      },
    },
  });
  return { result, events };
}

test('direct confirmation commits a Greenhouse literal-star custom question scoped to its form', async () => {
  const { result, events } = await commitMarkerOnlyRequiredControl({
    textContent: 'Are you authorized to work? *',
    className: 'question-label',
  });
  assert.deepEqual(result, { formFound: true, changed: false, committed: 1 });
  assert.equal(events, 1, 'the literal-star required control must receive its exact commit event');
});

test('direct confirmation commits an Ashby _required_ custom question scoped to its form', async () => {
  const { result, events } = await commitMarkerOnlyRequiredControl({
    textContent: 'Will you need sponsorship?',
    className: '_label_8x3 _required_8x3',
  });
  assert.deepEqual(result, { formFound: true, changed: false, committed: 1 });
  assert.equal(events, 1, 'the Ashby class-marked required control must receive its exact commit event');
});

test('prepare runs do not commit required fields or expose a submit action', () => {
  const actions = buildManagedPortalActions('greenhouse', packet, false);
  assert.equal(actions.some((action) => action.type === 'confirmAndSubmit'), false);
  assert.equal(actions.some((action) => action.type === 'click' && action.selector?.includes('button[type="submit"]')), false);
});

test('confirmation proof covers text, date, native select, React select, radio, checkbox, file and custom controls', () => {
  const fieldTypes = ['text', 'date', 'select', 'react-select', 'radio', 'checkbox', 'file', 'custom'] as const;
  const attempts = fieldTypes.map((fieldType, index) => {
    const outcome: 'already_committed' | 'confirmed' = index === 0 ? 'already_committed' : 'confirmed';
    return {
      selector: `[data-litos-stable-id-v1="fixture-${index}"]`,
      label: `Required ${fieldType}`,
      fieldType,
      outcome,
      ...(fieldType === 'react-select' ? { attemptCount: 2 as const } : {}),
    };
  });
  assert.doesNotThrow(() => assertManagedRequiredFieldsConfirmed(proof(attempts, { retries: 1 })));
});

test('email, phone, number and textarea normalize to text while a required resume remains file', () => {
  assert.doesNotThrow(() => assertManagedRequiredFieldsConfirmed(proof([
    { selector: 'input[name="email"]', label: 'Email', fieldType: 'text', outcome: 'confirmed' },
    { selector: 'input[name="phone"]', label: 'Phone', fieldType: 'text', outcome: 'confirmed' },
    { selector: 'input[name="years_experience"]', label: 'Years experience', fieldType: 'text', outcome: 'confirmed' },
    { selector: 'textarea[name="statement"]', label: 'Statement', fieldType: 'text', outcome: 'confirmed' },
    { selector: 'input[name="resume"]', label: 'Resume', fieldType: 'file', outcome: 'already_committed' },
  ])));
});

test('Lever and Workable keep every fixed core field or block before confirmation and submit', () => {
  const expected: Record<'lever' | 'workable', string[]> = {
    lever: ['name', 'email', 'phone', 'resume'],
    workable: ['first_name', 'last_name', 'email', 'phone', 'resume'],
  };
  for (const family of ['lever', 'workable'] as const) {
    let blocked = 0;
    for (let count = 1; count <= 140; count += 7) {
      const crowded: SubmissionPacket = {
        ...packet,
        questions: Array.from({ length: count }, (_, index) => ({
          question: `Required screener ${index}`,
          answer: `Reviewed answer ${index}`,
        })),
      };
      try {
        const actions = buildManagedPortalActions(family, crowded, true);
        const labels = new Set(actions.map((action) => action.label));
        for (const label of expected[family]) assert.ok(labels.has(label), `${family} lost ${label} at ${count}`);
        assert.equal(actions.at(-1)?.type, 'confirmAndSubmit');
      } catch (error) {
        assert.ok(error instanceof ManagedActionBudgetError, `${family} threw the wrong error at ${count}`);
        assert.equal(error.submitActionAppended, false);
        blocked += 1;
      }
    }
    assert.ok(blocked > 0, `${family} never exercised its fail-closed budget path`);
  }
});

test('missing protocol proof fails closed for an older managed runner, as uncertainty and never as a no-send', () => {
  assert.throws(
    () => assertManagedRequiredFieldsConfirmed({}),
    (error: unknown) => error instanceof ManagedConfirmationUnprovenError
      && /returned none/.test((error as Error).message)
      && /whether submit was pressed is unknown/.test((error as Error).message),
  );
  /* The winning half of the adversary: the action list this result answers carried a final submit,
     so an older runner may have pressed it. A NoSubmitControlError here classifies pre-click,
     releases the claim and tells the applicant nothing was sent. */
  assert.throws(
    () => assertManagedRequiredFieldsConfirmed({}),
    (error: unknown) => !(error instanceof NoSubmitControlError),
  );
});

/* THE PROOF THE DEPLOYED RUNNER ACTUALLY EMITS, captured verbatim rather than reconstructed.
 *
 * Provenance: SANDBOX_RUNNER extracted from stratus-browser-cloud main 4748871 on 2026-08-12 and
 * driven in real Chromium against served fixtures of the two scope shapes - the formless Ashby
 * page (kos.ai's shape, container scope) and a plain Greenhouse form (form scope). In both runs
 * the runner PRESSED SUBMIT and the page recorded the submission before this object was written.
 *
 * On 2026-08-11 production rejected exactly these objects at 'scope proof', because `scopeKind`
 * (added by the runner's submit-scope repair) was an unknown key to the key-set check below, and
 * the rejection was classed as a pre-click stop: the kos.ai row read "nothing has been sent" for a
 * run whose runner had clicked. A reconstruction of this fixture is how that defect shipped, so
 * these two objects must stay byte-shaped as captured. */
const RUNNER_CONTAINER_SCOPE_PROOF = {
  requiredFieldConfirmation: {
    version: 2 as const,
    status: 'confirmed' as const,
    passes: [{
      submitKind: 'application' as const,
      scope: {
        scopeKind: 'container' as const,
        formFingerprint: '8aa80dbd8033841edd98e62edd5bdbbaa4ebec6312a990fffe202726db3c3f47',
        submitFingerprint: '11084192c4838849708ee767588c5f4cceaded9ec0a250686f0bca352cb5123b',
        formMatchCount: 1 as const,
        submitMatchCount: 1 as const,
        requiredControlCount: 3,
        sameNode: true,
      },
      requiredControls: [
        { selector: '#name', label: 'Full name *', fieldType: 'text' as const, matchCount: 1 as const },
        { selector: '#email', label: 'Email *', fieldType: 'text' as const, matchCount: 1 as const },
        { selector: '#resume', label: 'Resume *', fieldType: 'file' as const, matchCount: 1 as const },
      ],
      attempts: [
        { selector: '#name', label: 'Full name *', fieldType: 'text' as const, outcome: 'already_committed' as const, attemptCount: 1 as const },
        { selector: '#email', label: 'Email *', fieldType: 'text' as const, outcome: 'already_committed' as const, attemptCount: 1 as const },
        { selector: '#resume', label: 'Resume *', fieldType: 'file' as const, outcome: 'already_committed' as const, attemptCount: 1 as const },
      ],
      retries: 0,
      unresolved: [],
      submissionOutcome: 'clicked' as const,
    }],
  },
};

test('the deployed runner\'s container-scope proof is accepted exactly as emitted', () => {
  assert.doesNotThrow(() => assertManagedRequiredFieldsConfirmed(RUNNER_CONTAINER_SCOPE_PROOF, 'application'));
});

test('the deployed runner\'s form-scope proof shape is accepted, scope captured verbatim', () => {
  const formScope = JSON.parse(JSON.stringify(RUNNER_CONTAINER_SCOPE_PROOF)) as typeof RUNNER_CONTAINER_SCOPE_PROOF;
  const pass = formScope.requiredFieldConfirmation.passes[0]! as { scope: Record<string, unknown> };
  pass.scope = {
    ...pass.scope,
    scopeKind: 'form',
    formFingerprint: '4f37eea4efeef07e039d081e9d8e19b6a240840329b4406c06f304d17677d6e3',
    submitFingerprint: '807d8541e4911e4c6aad82fd63b786d4a8fc174261e8a33044a062977360f641',
  };
  assert.doesNotThrow(() => assertManagedRequiredFieldsConfirmed(formScope, 'application'));
});

test('scopeKind admits only the two scopes the runner can bind, and any other new scope key still fails closed', () => {
  const withScope = (patch: Record<string, unknown>) => {
    const copy = JSON.parse(JSON.stringify(RUNNER_CONTAINER_SCOPE_PROOF)) as { requiredFieldConfirmation: { passes: Array<{ scope: Record<string, unknown> }> } };
    copy.requiredFieldConfirmation.passes[0]!.scope = { ...copy.requiredFieldConfirmation.passes[0]!.scope, ...patch };
    return copy;
  };
  assert.throws(() => assertManagedRequiredFieldsConfirmed(withScope({ scopeKind: 'body' })), /scope kind/);
  assert.throws(() => assertManagedRequiredFieldsConfirmed(withScope({ scopeKind: 1 })), /scope kind/);
  assert.throws(() => assertManagedRequiredFieldsConfirmed(withScope({ futureScopeEvidence: true })), /scope proof/);
});

test('a proof this service cannot read is classified as unproven, never as a pre-click stop', () => {
  /* The adversary that won in production: the runner clicked, the page recorded the submission,
     and the proof shape was rejected. If this error is a NoSubmitControlError the row releases the
     claim and reads "nothing has been sent" - for an application the employer may be holding. */
  const rejected = (value: unknown) => {
    try {
      assertManagedRequiredFieldsConfirmed(value, 'application');
      return null;
    } catch (error) {
      return error;
    }
  };
  const unknownScopeKey = (() => {
    const copy = JSON.parse(JSON.stringify(RUNNER_CONTAINER_SCOPE_PROOF)) as { requiredFieldConfirmation: { passes: Array<{ scope: Record<string, unknown> }> } };
    copy.requiredFieldConfirmation.passes[0]!.scope.futureScopeEvidence = true;
    return copy;
  })();
  for (const malformed of [
    unknownScopeKey,
    { requiredFieldConfirmation: { version: 2, status: 'confirmed', passes: [{ bogus: true }] } },
    { requiredFieldConfirmation: { version: 3, status: 'confirmed', passes: [] } },
    {},
  ]) {
    const error = rejected(malformed);
    assert.ok(error instanceof ManagedConfirmationUnprovenError, 'the unreadable proof must be unproven');
    assert.ok(!(error instanceof NoSubmitControlError), 'an unreadable proof must never classify as a pre-click stop');
    assert.ok(!(error instanceof ManagedRequiredFieldConfirmationError), 'unreadable and runner-blocked are opposite claims');
  }
  /* And the opposite stays the opposite: a proof that VALIDATES and says the runner blocked is the
     runner's own pre-click statement, and keeps its release classification. */
  const blocked = rejected(proof([{
    selector: '[data-field-path="work-authorization"]',
    label: 'Are you authorized to work?',
    fieldType: 'radio',
    outcome: 'failed',
    attemptCount: 2,
    reason: 'This requires an answer',
  }], {
    status: 'blocked',
    submissionOutcome: 'blocked',
    retries: 1,
    unresolved: ['Are you authorized to work?'],
  }));
  assert.ok(blocked instanceof ManagedRequiredFieldConfirmationError);
  assert.ok(blocked instanceof NoSubmitControlError, 'a validated blocked proof is a proven pre-click stop');
});

test('a visually filled field that still fails ATS validation blocks submission by name', () => {
  assert.throws(
    () => assertManagedRequiredFieldsConfirmed(proof([{
      selector: '[data-field-path="work-authorization"]',
      label: 'Are you authorized to work?',
      fieldType: 'radio',
      outcome: 'failed',
      attemptCount: 2,
      reason: 'This requires an answer',
    }], {
      status: 'blocked',
      submissionOutcome: 'blocked',
      retries: 1,
      unresolved: ['Are you authorized to work?'],
    })),
    (error: unknown) => error instanceof ManagedRequiredFieldConfirmationError
      && error.fields.includes('Are you authorized to work?'),
  );
});

test('confirmation rejects coordinate-like or selectorless evidence', () => {
  for (const selector of [
    '   ', '412, 980', 'x=412,y=980', '/html/body/form/input[1]', 'form input:nth-child(2)',
    'input[type="text"]', '[role="radio"]', '[aria-required="true"]', 'input[autocomplete="email"]',
    'label[for="start"]', '[data-testid="start"]', '.required-field', 'input[name="first"], input[name="last"]',
  ]) {
    assert.throws(() => assertManagedRequiredFieldsConfirmed(proof([{
      selector,
      label: 'Start date',
      fieldType: 'date',
      outcome: 'confirmed',
    }])), selector);
  }
});

test('Greenhouse bracket ids use a unique versioned stable id instead of a brittle escaped selector', () => {
  assert.throws(() => assertManagedRequiredFieldsConfirmed(proof([{
    selector: '#question_68005616\\[\\]_73190027',
    label: 'Work authorization',
    fieldType: 'react-select',
    outcome: 'confirmed',
  }])));
  assert.doesNotThrow(() => assertManagedRequiredFieldsConfirmed(proof([{
    selector: '[data-litos-stable-id-v1="required-73190027"]',
    label: 'Work authorization',
    fieldType: 'react-select',
    outcome: 'confirmed',
  }])));
});

test('untyped hostile receipts cannot bypass the strict versioned confirmation schema', () => {
  const good = proof([{
    selector: 'input[name="start_date"]',
    label: 'Start date',
    fieldType: 'date',
    outcome: 'confirmed',
  }]);
  const raw = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
  const base = (raw.requiredFieldConfirmation as Record<string, unknown>);
  const basePass = (base.passes as Array<Record<string, unknown>>)[0]!;
  const withPass = (patch: Record<string, unknown>) => ({ ...base, passes: [{ ...basePass, ...patch }] });
  const cases: Array<[string, unknown]> = [
    ['wrong version', { ...base, version: 1 }],
    ['fractional retries', withPass({ retries: 0.5 })],
    ['excess retries', withPass({ retries: 2 })],
    ['unknown field type', withPass({ requiredControls: [{ selector: '#start', label: 'Start', fieldType: 'slider' }] })],
    ['unknown outcome', withPass({ attempts: [{ selector: 'input[name="start_date"]', label: 'Start date', fieldType: 'date', outcome: 'clicked', attemptCount: 1 }] })],
    ['missing requiredControls', { ...base, passes: [Object.fromEntries(Object.entries(basePass).filter(([key]) => key !== 'requiredControls'))] }],
    ['missing uniqueness proof', withPass({ requiredControls: [{ selector: '#start', label: 'Start', fieldType: 'date' }] })],
    ['nonunique control', withPass({ requiredControls: [{ selector: '#start', label: 'Start', fieldType: 'date', matchCount: 2 }] })],
    ['empty attempts with a discovered control', withPass({ attempts: [] })],
    ['duplicate attempts', withPass({ attempts: [...(basePass.attempts as unknown[]), ...(basePass.attempts as unknown[])] })],
    ['extra attempt', withPass({ attempts: [...(basePass.attempts as unknown[]), { selector: '#other', label: 'Other', fieldType: 'text', outcome: 'confirmed' }] })],
    ['coordinate control', withPass({ requiredControls: [{ selector: '20, 30', label: 'Start date', fieldType: 'date' }] })],
    ['failed without reason', { ...withPass({ attempts: [{ selector: 'input[name="start_date"]', label: 'Start date', fieldType: 'date', outcome: 'failed', attemptCount: 2 }], retries: 1, unresolved: ['Start date'], submissionOutcome: 'blocked' }), status: 'blocked' }],
    ['retry count without retry evidence', withPass({ retries: 1 })],
    ['retry evidence without retry count', withPass({ attempts: [{ selector: 'input[name="start_date"]', label: 'Start date', fieldType: 'date', outcome: 'confirmed', attemptCount: 2 }] })],
    ['already committed was retried', withPass({ attempts: [{ selector: 'input[name="start_date"]', label: 'Start date', fieldType: 'date', outcome: 'already_committed', attemptCount: 2 }], retries: 1 })],
    ['confirmed with unresolved', withPass({ unresolved: ['Start date'] })],
    ['blocked without failure', { ...base, status: 'blocked' }],
    ['unknown receipt property', { ...base, clicked: true }],
  ];
  for (const [name, requiredFieldConfirmation] of cases) {
    assert.throws(() => assertManagedRequiredFieldsConfirmed({ requiredFieldConfirmation }), name);
  }
});

test('managed wire contract sends one bounded confirmation action with its durable form scope', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  const submissionAttempt = {
    runId: '11111111-1111-4111-8111-111111111111',
    claimId: '22222222-2222-4222-8222-222222222222',
    executionId: '33333333-3333-4333-8333-333333333333',
  };
  let body: {
    actions?: Array<Record<string, unknown>>;
    submissionAttempt?: typeof submissionAttempt;
  } = {};
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as typeof body;
    return new Response(JSON.stringify({
      run: {
        title: 'Complete',
        url: 'https://portal.example/complete',
        text: 'Thank you',
        requiredFieldConfirmation: {
          version: 2,
          status: 'confirmed',
          passes: [{
            submitKind: 'application',
            scope: {
              formFingerprint: 'form_fingerprint_wire_fixture',
              submitFingerprint: 'submit_fingerprint_wire_fixture',
              formMatchCount: 1,
              submitMatchCount: 1,
              requiredControlCount: 2,
              sameNode: true,
            },
            requiredControls: [
              { selector: 'input[name="full_name"]', label: 'Full name', fieldType: 'text', matchCount: 1 },
              { selector: '[data-field-path="availability"]', label: 'Availability', fieldType: 'custom', matchCount: 1 },
            ],
            attempts: [
              { selector: 'input[name="full_name"]', label: 'Full name', fieldType: 'text', outcome: 'already_committed', attemptCount: 1 },
              { selector: '[data-field-path="availability"]', label: 'Availability', fieldType: 'custom', outcome: 'confirmed', attemptCount: 2 },
            ],
            retries: 1,
            unresolved: [],
            submissionOutcome: 'clicked',
          }],
        },
        submissionAttempt: body.submissionAttempt,
        terminalResult: { resultId: 'a'.repeat(64) },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    await runManagedBrowser('https://portal.example/apply', [{
      type: 'confirmAndSubmit',
      selector: MANAGED_FINAL_SUBMIT_SELECTOR,
      label: 'required_field_confirmation',
      optional: false,
      maxRetries: 1,
      contractVersion: 2,
      submitKind: 'application',
      chooserPolicy: MANAGED_SUBMIT_CHOOSER_POLICY,
    }], {
      allowSubmit: true,
      submissionAttempt,
      providerDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.deepEqual(body.actions, [{
      type: 'confirmAndSubmit',
      selector: MANAGED_FINAL_SUBMIT_SELECTOR,
      label: 'required_field_confirmation',
      optional: false,
      maxRetries: 1,
      contractVersion: 2,
      submitKind: 'application',
      chooserPolicy: MANAGED_SUBMIT_CHOOSER_POLICY,
    }]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('managed wire contract rejects missing versions and unbounded retry counts before network use', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error('network should be unreachable');
  }) as typeof fetch;
  try {
    await assert.rejects(() => runManagedBrowser('https://portal.example/apply', [{
      type: 'confirmAndSubmit',
      selector: MANAGED_FINAL_SUBMIT_SELECTOR,
      maxRetries: 1,
    }]), /contract version/);
    await assert.rejects(() => runManagedBrowser('https://portal.example/apply', [{
      type: 'confirmAndSubmit',
      selector: MANAGED_FINAL_SUBMIT_SELECTOR,
      contractVersion: 2,
      maxRetries: 2,
    }]), /maxRetries/);
    await assert.rejects(() => runManagedBrowser('https://portal.example/apply', [{
      type: 'confirmAndSubmit',
      selector: MANAGED_FINAL_SUBMIT_SELECTOR,
      contractVersion: 2,
      maxRetries: 1,
      submitKind: 'application',
    }]), /chooser policy/);
    await assert.rejects(() => runManagedBrowser('https://portal.example/apply', [{
      type: 'confirmAndSubmit',
      selector: MANAGED_FINAL_SUBMIT_SELECTOR,
      contractVersion: 2,
      maxRetries: 1,
      submitKind: 'application',
      chooserPolicy: { name: 'litos-final-submit', version: 2 } as never,
    }]), /chooser policy/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('submission runner requires confirmation proof before any receipt can be recorded', () => {
  const source = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  /* The first managed run is ALWAYS an application submit, including on a run that is finishing a
     security-code challenge. It used to be declared 'verification' whenever a code was in hand, and
     that declaration was the shape of the defect: a verification submit types the code before it
     clicks, and on a page that has not been submitted yet there is no code control to type into. */
  const policyGate = source.indexOf('const atomicSubmitV4 = managedApplicationUsesAtomicSubmitV4(portal, applicationUrl)');
  const chooser = source.indexOf('if (atomicSubmitV4) assertManagedApplicationFinalSubmitSelected(result, applicationUrl)');
  const barrier = source.indexOf("assertManagedRequiredFieldsConfirmed(result, 'application')", chooser);
  const consistency = source.indexOf('if (atomicSubmitV4) assertManagedApplicationSubmitConsistency(result, applicationUrl)', barrier);
  const verdict = source.indexOf('const typedConfirmationVerdict = exactManagedSubmitVerdict', consistency);
  const receipt = source.indexOf('const confirmedBeforeReceiptStorage = await recordManagedSubmissionConfirmed', verdict);
  assert.ok(policyGate >= 0);
  assert.ok(chooser > policyGate);
  assert.ok(barrier > chooser);
  assert.ok(consistency > barrier);
  assert.ok(verdict > consistency);
  assert.ok(receipt > verdict);
  const proofBlock = source.slice(
    source.lastIndexOf('if (managedApplicationProofIsRequired', chooser),
    source.indexOf('let receiptResult = result;', consistency),
  );
  assert.match(proofBlock, /if \(atomicSubmitV4\) assertManagedApplicationFinalSubmitSelected/);
  assert.match(proofBlock, /assertManagedRequiredFieldsConfirmed\(result, 'application'\)/,
    'v3 still requires the shared confirmation proof');
  assert.match(proofBlock, /if \(atomicSubmitV4\) assertManagedApplicationSubmitConsistency/);
  assert.equal((proofBlock.match(/buildManagedPortalActions/g) ?? []).length, 0,
    'a v4 refusal cannot rebuild the same run with a v3 action list');
});

/* THE SUPPLIED-CODE CONTINUATION IS GONE, AND THAT IS THE FIX RATHER THAN A REGRESSION.
 *
 * It typed a code the applicant had pasted in, on a page reached by sending the application again.
 * Greenhouse issues a new code on every send and invalidates the last - three codes to one mailbox
 * on a live Cresta application on 2026-08-09, at 20:24:03, 21:13:07 and 21:13:53 - so the code being
 * typed was always one generation stale and the branch could never have succeeded. There is now one
 * continuation, and the code it carries was read inside the same run that raised the challenge.
 */
test('no continuation may carry a code that came from outside the run', () => {
  const source = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  assert.equal((source.match(/continueManagedBrowserWithAccountFence\(row\.user_id, continuationToken, codeActions, \{/g) ?? []).length, 2,
    'live and lost-initial-response paths may each make the first continuation call, never a retry');
  assert.equal((source.match(/continueManagedBrowserWithAccountFence\(row\.user_id, continuationToken, \[\], \{/g) ?? []).length, 1,
    'the only other continuation is a read-only receipt observation with no actions');
  const terminalRecoveryStart = source.indexOf('export async function recoverManagedSecurityCodeContinuationTerminalResult(');
  const terminalRecoveryEnd = source.indexOf('async function recoverManagedInitialSecurityCodeChallenge(', terminalRecoveryStart);
  const terminalRecovery = source.slice(terminalRecoveryStart, terminalRecoveryEnd);
  assert.doesNotMatch(terminalRecovery, /continueManagedBrowser|runManagedBrowser/,
    'a persisted continuation attempt is GET-only');
  // The supplied code survives in exactly one place, and it is not an action list.
  const branch = source.indexOf('if (options.securityCode && initialChallenge) {');
  assert.ok(branch > 0, 'the supplied code is still fingerprinted, so the same dead code cannot resend');
  const body = source.slice(branch, source.indexOf('let enteredCode', branch));
  assert.match(body, /outcome: 'superseded'/);
  assert.doesNotMatch(body, /continueManagedBrowser|securityCodeContinuationActions|withSecurityCode\(/);
});

test('automatic security-code continuation validates its own atomic confirmation receipt', () => {
  const source = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  const continuation = source.indexOf('receiptResult = await continueManagedBrowserWithAccountFence(row.user_id, continuationToken, codeActions, {');
  const continuationBarrier = source.indexOf("assertManagedRequiredFieldsConfirmed(receiptResult, 'verification')", continuation);
  const verdict = source.indexOf('const typedConfirmationVerdict = exactManagedSubmitVerdict', continuationBarrier);
  const receipt = source.indexOf('const confirmedBeforeReceiptStorage = await recordManagedSubmissionConfirmed', verdict);
  assert.ok(continuation >= 0);
  assert.ok(continuationBarrier > continuation);
  assert.ok(verdict > continuationBarrier);
  assert.ok(receipt > verdict);
});

/* THE UNRESOLVED VOCABULARY, MEASURED AGAINST WHAT THE RUNNER ACTUALLY PUSHES.
 *
 * `pass.unresolved` used to be required to contain only selectors and labels of controls in
 * requiredControls, on pain of the whole proof being malformed. Five of the runner's eight push
 * sites emit strings that set can never contain, and the commonest of them,
 * stratus-browser-cloud@4748871 managed-browser.js:2928, fires on ANY still-empty required field.
 * So the ordinary blocked submission was unreadable, and the fixtures in this file never caught it
 * because they only ever used bare labels.
 *
 * The cost of that rejection changed in PR 506. A shape refusal now means "the click state is
 * unknown", which applied to a run that reported withholding the click produced a row saying Litos
 * pressed Send, carrying submission_attempted_at and an unresolved unverified_submission, with the
 * claim kept. See the row-level tests in routes/submissionStopExit.test.ts.
 *
 * Every string below is copied from the runner's source, not invented.
 */
const RUNNER_UNRESOLVED_STRINGS = {
  readiness: '"Start date" is required and is still empty',
  noLabel: 'A required field on the form has no label Litos can read, and is still empty',
  scanFailed: 'Required-field readiness scan failed',
  selectorless: 'Selectorless required field',
  nodeReplaced: 'Bound submit control or application form was replaced before submission',
  identityChanged: 'Bound application form or submit identity changed during confirmation',
  employerText: 'The bound application form still shows an unmatched validation error: '
    + 'Please complete this required field before continuing with your application. ',
} as const;

/** One required control left blank, the runner withheld the click. The ordinary blocked run. */
function blockedRun(unresolved: string[]) {
  return {
    submitOutcome: {
      pressed: false, state: 'not_attempted', source: null, evidence: null, message: null, formStillPresent: true,
    },
    requiredFieldConfirmation: {
      version: 2,
      status: 'blocked',
      passes: [{
        submitKind: 'application',
        scope: {
          scopeKind: 'form',
          formFingerprint: 'form_fingerprint_fixture_1234',
          submitFingerprint: 'submit_fingerprint_fixture_1234',
          formMatchCount: 1,
          submitMatchCount: 1,
          requiredControlCount: 1,
          sameNode: true,
        },
        requiredControls: [{
          selector: 'input[name="start_date"]', label: 'Start date', fieldType: 'text', matchCount: 1,
        }],
        attempts: [{
          selector: 'input[name="start_date"]',
          label: 'Start date',
          fieldType: 'text',
          outcome: 'failed',
          attemptCount: 2,
          reason: 'This requires an answer',
        }],
        retries: 1,
        unresolved,
        submissionOutcome: 'blocked',
      }],
    },
  };
}

function refusalFrom(result: unknown): Error {
  try {
    assertManagedRequiredFieldsConfirmed(result, 'application');
  } catch (error) {
    return error as Error;
  }
  return assert.fail('a blocked proof must never be accepted');
}

test('every sentence the deployed runner puts in unresolved keeps the proof readable', () => {
  for (const [name, sentence] of Object.entries(RUNNER_UNRESOLVED_STRINGS)) {
    const error = refusalFrom(blockedRun([sentence]));
    assert.ok(
      error instanceof ManagedRequiredFieldConfirmationError,
      `${name} produced ${error.name}: a blocked run must refuse as a blocked run, not as an unreadable proof`,
    );
    assert.doesNotMatch(
      error.message,
      /could not read the send run/,
      `${name} must not be reported as an unreadable proof`,
    );
  }
});

test('a readiness blocker surfaces the field it names, and only when this proof enumerated it', () => {
  /* The useful half of managed-browser.js:2126 is the quoted label. It is kept only when it matches
     a control this proof already listed, so what reaches the applicant is a label this service saw
     independently rather than any text the employer's page supplied. */
  const named = refusalFrom(blockedRun([RUNNER_UNRESOLVED_STRINGS.readiness]));
  assert.ok(named instanceof ManagedRequiredFieldConfirmationError, 'a blocked run refuses as a blocked run');
  assert.deepEqual(named.fields, ['Start date']);

  /* Identical to the row a bare label produces. That equality is the point: the runner's wording is
     no longer able to change what this service does. */
  const bare = refusalFrom(blockedRun(['Start date']));
  assert.ok(bare instanceof ManagedRequiredFieldConfirmationError, 'a bare label refuses the same way');
  assert.deepEqual(named.fields, bare.fields);

  const unknownField = refusalFrom(blockedRun(['"Salary expectation" is required and is still empty']));
  assert.ok(unknownField instanceof ManagedRequiredFieldConfirmationError, 'an unknown label still blocks');
  assert.ok(
    !unknownField.fields.includes('Salary expectation'),
    'a label this proof never enumerated is not evidence and must not be quoted back',
  );
  assert.deepEqual(unknownField.fields, [UNATTRIBUTED_REQUIRED_BLOCKER, 'Start date']);
});

test('employer-authored text never reaches the applicant, and still blocks the send', () => {
  /* managed-browser.js:2929 wraps text scraped from the employer's own page. That is the reason the
     old rule was strict, and the property is kept: the entry blocks, its text is not repeated. */
  const error = refusalFrom(blockedRun([RUNNER_UNRESOLVED_STRINGS.employerText]));
  assert.ok(error instanceof ManagedRequiredFieldConfirmationError, 'employer text must not make the proof unreadable');
  assert.ok(!error.message.includes('Please complete this required field'), 'employer text must not reach the message');
  assert.ok(error.fields.includes(UNATTRIBUTED_REQUIRED_BLOCKER), 'the entry must still count as a blocker');
  assert.ok(error.fields.every((field) => !field.includes('Please complete this required field')), 'employer text must not reach the fields');
});

test('a sentence no runner has ever emitted still blocks rather than passing through', () => {
  /* Fail-closed on the axis that matters. An entry this service cannot attribute is still a
     failure, so a future runner cannot turn a blocked pass into a confirmed one by rewording. */
  const error = refusalFrom(blockedRun(['Some wording nobody has written yet']));
  assert.ok(error instanceof ManagedRequiredFieldConfirmationError, 'an unrecognised sentence must not make the proof unreadable');
  assert.ok(error.fields.includes(UNATTRIBUTED_REQUIRED_BLOCKER), 'and it must still block the send');

  /* And it cannot be laundered into a CONFIRMED proof either: status 'confirmed' with any
     unresolved entry is still a contradiction. */
  const laundered = blockedRun(['Some wording nobody has written yet']);
  laundered.requiredFieldConfirmation.status = 'confirmed';
  assert.throws(() => assertManagedRequiredFieldsConfirmed(laundered, 'application'));
});

test('an unreadable proof on a run that withheld the click is not reported as a possible send', () => {
  /* The safety net under the vocabulary fix, for shape drift nobody has predicted yet. Two
     independent statements have to agree that the click was withheld: submitOutcome.pressed false,
     and every pass reporting 'blocked'. */
  const drifted = blockedRun(['Start date']);
  (drifted.requiredFieldConfirmation.passes[0]!.scope as Record<string, unknown>).somethingNew = true;
  const error = refusalFrom(drifted);
  assert.ok(
    error instanceof ManagedRequiredFieldConfirmationError,
    'a run that reported withholding the click must not be recorded as an unproven press',
  );
  assert.match(error.message, /did not press submit/);

  /* The half that must not move: a run that reports a PRESS keeps PR 506's unproven classification,
     because there the uncertainty is real and a false "nothing was sent" costs a duplicate. */
  const pressed = blockedRun(['Start date']);
  pressed.submitOutcome.pressed = true;
  (pressed.requiredFieldConfirmation.passes[0]!.scope as Record<string, unknown>).somethingNew = true;
  assert.ok(
    refusalFrom(pressed) instanceof ManagedConfirmationUnprovenError,
    'a press with an unreadable proof is still an unknown outcome',
  );

  /* And a runner that reports nothing at all about the press stays unknown too. */
  const silent = blockedRun(['Start date']) as Record<string, unknown>;
  delete silent.submitOutcome;
  ((silent.requiredFieldConfirmation as { passes: Array<{ scope: Record<string, unknown> }> })
    .passes[0]!.scope).somethingNew = true;
  assert.ok(refusalFrom(silent) instanceof ManagedConfirmationUnprovenError, 'a runner silent about the press stays unknown');
});

/* THE RUNNER'S REFUSAL VOCABULARY IS NOT THIS SERVICE'S TO GUESS.
 *
 * `MANAGED_BLOCKER_REASONS` decides whether a refusal arrives with its cause or as
 * contractError('blocker reason'). It sat at five entries while stratus-browser-cloud grew to
 * thirty-six, so every v4 refusal outside those five — a page reaching for an unbound network
 * transport, a payload that changed between binding and press, an application scope that went
 * missing — reached the operator and the applicant as an unnamed contract violation. Nothing was
 * sent, which is the part that held; nobody could tell what stopped it, which is the part that did
 * not.
 *
 * These two tests are the reason it cannot drift back. The first pins the two copies inside this
 * service to each other; the second pins this service to the runner's own source text. */

const RUNNER_SOURCE_PATH = '../stratus-browser-cloud/src/managed-browser.js';

/* Literals the runner-side patterns below reach that are NOT submit refusals. The quarantine file's
 * `reason` is written while clearing stale provisioning artifacts, before any page is open. A new
 * unclassified literal fails the test rather than landing here silently — deciding which of the two
 * lists it belongs in is the whole job. */
const NOT_A_BLOCKER_REASON = new Set(['stale_inactive_artifacts']);

/** Every reason literal that can reach `passes[].blockerReason`, read out of the runner's source. */
function runnerBlockerReasons(source: string): Set<string> {
  const found = new Set<string>();
  const collect = (pattern: RegExp, text = source) => {
    for (const match of text.matchAll(pattern)) {
      for (const group of match.slice(1)) if (group) found.add(group);
    }
  };
  // Assigned straight onto the pass, including the `x || 'fallback'` forms.
  collect(/blockerReason(?:\s*=|:|\s*\|\|)\s*'([a-z_]+)'/g);
  collect(/blockerReason\s*=\s*[A-Za-z.?]+\s*\|\|\s*'([a-z_]+)'/g);
  collect(/applicationScopeFailureReason\s*=\s*'([a-z_]+)'/g);
  collect(/unsupportedReason(?:\s*=|:)\s*'([a-z_]+)'/g);
  /* Reasons that reach blockerReason indirectly, through `gateResult.reason`, `guardResult.reason`
   * and `transportBinding.unsupportedReason`. These are the ones a literal-only scan misses, and
   * they are most of the list. */
  collect(/\breason(?:\s*=|:|\s*\|\|)\s*'([a-z_]+)'/g);
  collect(/\breason\s*=\s*[^;\n]*?\?\s*'([a-z_]+)'\s*:\s*'([a-z_]+)'/g);
  collect(/blockActivation\('([a-z_]+)'/g);
  /* The activation guard reports through `unchanged(reason, event)`, which forwards to
   * blockActivation. Three of its reasons are literals; the rest are built at runtime. */
  collect(/unchanged\('([a-z_]+)'/g);
  /* `eventType(event) + '_binding_changed'` never exists as a literal anywhere, so no scan of
   * literals can find it. Rebuild the family from the event list the runner actually registers,
   * plus the 'activation' fallback eventType() returns when the type getter throws. Reading the
   * array rather than hard-coding it means a new activation event joins the set on its own. */
  const activationEvents = source.match(/const ordinaryActivationEvents = \[([^\]]*)\]/);
  assert.ok(activationEvents, 'the runner still lists the activation events it witnesses');
  const eventTypes = [...activationEvents[1]!.matchAll(/'([a-z]+)'/g)].map((match) => match[1]!);
  assert.ok(eventTypes.length > 0, 'the activation event list is still readable');
  for (const type of [...eventTypes, 'activation']) found.add(`${type}_binding_changed`);
  /* `armActivation` reports by return value, and its result becomes the blockerReason whenever it
   * is anything but 'armed'. Slice to that sentinel rather than scanning every `return` in a
   * twenty-thousand-line file. */
  const armStart = source.indexOf('const armActivation = (');
  const armEnd = source.indexOf("return 'armed';", armStart);
  assert.ok(armStart >= 0 && armEnd > armStart, 'armActivation still reports by return value');
  collect(/return\s+'([a-z_]+)'/g, source.slice(armStart, armEnd));
  for (const value of NOT_A_BLOCKER_REASON) found.delete(value);
  return found;
}

test('the blocker reason union and the runtime allowlist are the same list', () => {
  /* Strip BOTH comment forms before slicing, not after. Stripping afterwards made the slice
     boundary depend on comment punctuation - a semicolon inside any inline comment ended the union
     early - and it left block-comment prose inside the matched region, where a quoted fragment like
     '_binding_changed' reads as a declared member. Both were live: this assertion caught the second
     one on the very commit that added the comment. */
  const source = readFileSync('src/lib/browserbase.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const start = source.indexOf('blockerReason?:');
  assert.ok(start >= 0, 'the confirmation proof still declares blockerReason');
  const union = source.slice(start, source.indexOf(';', start));
  const declared = new Set([...union.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!));
  assert.deepEqual(
    [...declared].sort(),
    [...MANAGED_BLOCKER_REASONS].sort(),
    'browserbase.ts declares a reason portalSubmission.ts rejects at runtime, or the reverse',
  );
});

/* CI checks out this repo alone, so there the runner source is absent and this test skips. It is
 * the local pre-push signal for anyone who has both repos side by side, which is how the pair is
 * actually developed. Making it a CI gate means checking the runner out in ci.yml. */
const RUNNER_SOURCE_ABSENT = existsSync(RUNNER_SOURCE_PATH)
  ? false
  : `${RUNNER_SOURCE_PATH} is not checked out beside this repo`;

test('blocker reasons stay in sync with the managed runner', { skip: RUNNER_SOURCE_ABSENT }, () => {
  const emitted = runnerBlockerReasons(readFileSync(RUNNER_SOURCE_PATH, 'utf8'));
  /* Derived from the allowlist rather than a magic number: the runner's vocabulary is all but the
     handful of retired reasons this service keeps under ADD, NEVER REMOVE. A floor five below the
     real yield let a partial pattern regression pass unnoticed. */
  assert.ok(
    emitted.size >= MANAGED_BLOCKER_REASONS.size - 2,
    `the scan found ${emitted.size} of ${MANAGED_BLOCKER_REASONS.size} reasons; the patterns went stale`,
  );
  const unknown = [...emitted].filter((reason) => !MANAGED_BLOCKER_REASONS.has(reason)).sort();
  assert.deepEqual(unknown, [], 'the runner emits a blocker reason this service would reject as a contract error');
  /* Deliberately one-directional. This service may keep a reason the runner has retired — a run
     that started before the deploy still reports it — so extra entries here are correct, and
     asserting set equality would force removals that break those runs. */
});

/* A PASS THAT BOUND NOTHING, AND WHY THE CONTRACT HAD TO LEARN TO READ ONE.
 *
 * The proof shape above asks every pass to name the form it bound and the control it pressed. Two
 * of the runner's emissions are built at points where neither exists — managed-browser.js:15390,
 * where the caller-bound application form was unusable, and :15458, where the security-code
 * controls did not retain the exact code. Both refuse BEFORE any submit handle is resolved, and
 * both say so by carrying null fingerprints.
 *
 * MEASURED ON THIS BRANCH BEFORE THE FIX. Fed the runner's literal payloads, the validator rejected
 * them at contractError('scope kind') and contractError('scope identity') respectively — both of
 * which run before the blockerReason check — so all six reasons those two sites can emit were
 * unreachable, and what came out named an internal check instead of the cause. The classification
 * happened to survive only because observedManagedSubmitWithheld read submitOutcome.pressed ===
 * false out of the very payload the service had just called unreadable; strip that one field, as an
 * older runner or a truncated retained result does, and the same run became
 * ManagedConfirmationUnprovenError and told the applicant Litos had pressed Send.
 *
 * The fixtures below are the runner's object literals, field for field. They are the contract.
 */
const UNBOUND_SCOPE_MESSAGE = 'The caller-bound application form was unavailable at submit time';
const UNBOUND_CODE_MESSAGE = 'The security code controls did not retain the exact caller-supplied code';

/** managed-browser.js:15390 — nothing was bound, and the pass says so in every field. */
function applicationScopeFailurePass(blockerReason: string) {
  return {
    submitKind: 'application' as const,
    scope: {
      scopeKind: null,
      formFingerprint: null,
      submitFingerprint: null,
      formMatchCount: 0,
      submitMatchCount: 0,
      requiredControlCount: 0,
      sameNode: false,
    },
    requiredControls: [],
    attempts: [],
    retries: 0,
    unresolved: [UNBOUND_SCOPE_MESSAGE],
    blockerReason,
    submissionOutcome: 'blocked' as const,
  };
}

/** managed-browser.js:15458 — a form was located and never identified, and no control was matched. */
function securityCodeUnretainedPass() {
  return {
    submitKind: 'verification' as const,
    scope: {
      scopeKind: 'form',
      formFingerprint: null,
      submitFingerprint: null,
      formMatchCount: 1,
      submitMatchCount: 0,
      requiredControlCount: 0,
      sameNode: false,
    },
    requiredControls: [],
    attempts: [],
    retries: 0,
    unresolved: [UNBOUND_CODE_MESSAGE],
    blockerReason: 'successful_address_changed',
    submissionOutcome: 'blocked' as const,
  };
}

/** The whole result, with submitOutcome deliberately ABSENT unless a test supplies one. */
/* WHAT THE RUNNER ACTUALLY SENDS ON A CONTINUATION. finalSubmitPressed is run-scoped in
 * managed-browser.js and written on both arms at :16938, so a verification result always carries an
 * explicit press report - and because it is run-scoped rather than per-phase, `pressed: false` on a
 * continuation denies the press for the WHOLE run, which is what makes it strong enough to release
 * on. Verification fixtures below carry it for that reason; silence is exercised separately. */
const RUN_WITHHELD_PRESS = {
  pressed: false, state: 'not_attempted', source: null, evidence: null, message: null, formStillPresent: null,
} as const;

function unboundRun(pass: unknown, submitOutcome?: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {
    requiredFieldConfirmation: { version: 2, status: 'blocked', passes: [pass] },
  };
  if (submitOutcome !== undefined) result.submitOutcome = submitOutcome;
  return result;
}

function refusal(result: unknown, kind: 'application' | 'verification'): Error {
  try {
    assertManagedRequiredFieldsConfirmed(result, kind);
  } catch (error) {
    return error as Error;
  }
  return assert.fail('a blocked proof must never be accepted');
}

test('every application-scope refusal the runner can name reaches the operator', () => {
  for (const reason of [
    'application_scope_missing',
    'application_scope_ambiguous',
    'application_scope_not_form',
    'application_scope_detached',
    'application_scope_unavailable',
  ]) {
    const error = refusal(unboundRun(applicationScopeFailurePass(reason)), 'application');
    assert.ok(error instanceof ManagedRequiredFieldConfirmationError, reason);
    assert.ok(error instanceof NoSubmitControlError, `${reason} must classify as a pre-click stop`);
    assert.ok(!(error instanceof ManagedConfirmationUnprovenError), `${reason} is not an unknown press`);
    assert.deepEqual((error as ManagedRequiredFieldConfirmationError).fields,
      [UNBOUND_SCOPE_MESSAGE, reason],
      'the cause and the runner\'s own sentence both survive');
    assert.doesNotMatch(error.message, /could not be read/, reason);
  }
});

test('a security code the controls did not retain reaches the operator too', () => {
  const error = refusal(unboundRun(securityCodeUnretainedPass(), RUN_WITHHELD_PRESS), 'verification');
  assert.ok(error instanceof ManagedRequiredFieldConfirmationError);
  assert.ok(error instanceof NoSubmitControlError);
  assert.deepEqual((error as ManagedRequiredFieldConfirmationError).fields,
    [UNBOUND_CODE_MESSAGE, 'successful_address_changed']);
});

/* THE SHAPE HAS TO SURVIVE THE WIRE, AND null IS THE REASON IT DOES. The runner publishes this
 * payload with JSON.stringify (managed-browser.js:16977) and the backend reads it back out of the
 * durable result, so every clause of the shape has to be a value JSON carries. An `undefined`
 * scopeKind or fingerprint would be DROPPED in transit and land on a different branch — which is
 * why the runner writes explicit nulls and why this asserts the verdict after a round trip rather
 * than before it. */
test('both unbound shapes survive the wire the runner actually sends them over', () => {
  for (const [pass, kind] of [
    [applicationScopeFailurePass('application_scope_detached'), 'application'],
    [securityCodeUnretainedPass(), 'verification'],
  ] as const) {
    const sent = unboundRun(pass, kind === 'verification' ? RUN_WITHHELD_PRESS : undefined);
    const received = JSON.parse(JSON.stringify(sent));
    assert.deepEqual(received, sent, 'nothing in the shape may be a value JSON silently drops');
    const error = refusal(received, kind);
    assert.ok(error instanceof ManagedRequiredFieldConfirmationError,
      'the round trip must not change the verdict');
  }
});

/* THE BRANCH IS A HOLE IN A FAIL-CLOSED GATE, so the thing worth testing is not that it opens —
 * it is that it stays shut for everything that is not exactly these two shapes. Each mutation below
 * breaks ONE clause of unboundScopeProof and must put the pass back on the strict path. */
test('an unbound pass that misses the shape by one field still fails closed', () => {
  const mutations: Array<[string, (pass: Record<string, any>) => void]> = [
    ['a fingerprint appears on the form side', (pass) => { pass.scope.formFingerprint = 'form_fingerprint_fixture_1234'; }],
    ['a fingerprint appears on the submit side', (pass) => { pass.scope.submitFingerprint = 'submit_fingerprint_fixture_1234'; }],
    ['a submit control claims to have matched', (pass) => { pass.scope.submitMatchCount = 1; }],
    ['a form claims to have matched without a kind', (pass) => { pass.scope.formMatchCount = 1; }],
    ['a container scope claims the unbound shape', (pass) => { pass.scope.scopeKind = 'container'; }],
    ['the scope kind is silent rather than null', (pass) => { delete pass.scope.scopeKind; }],
    ['a form scope claims it matched nothing', (pass) => { pass.scope.scopeKind = 'form'; }],
    ['the scan claims to have found controls', (pass) => { pass.scope.requiredControlCount = 1; }],
    ['the node comparison claims to have run', (pass) => { pass.scope.sameNode = true; }],
    ['a control is listed', (pass) => {
      pass.scope.requiredControlCount = 1;
      pass.requiredControls = [{ selector: 'input[name="a"]', label: 'A', fieldType: 'text', matchCount: 1 }];
    }],
    ['an attempt is listed', (pass) => {
      pass.attempts = [{ selector: 'input[name="a"]', label: 'A', fieldType: 'text', outcome: 'confirmed', attemptCount: 1 }];
    }],
    ['a retry is claimed', (pass) => { pass.retries = 1; }],
    ['the outcome says a control was clicked', (pass) => { pass.submissionOutcome = 'clicked'; }],
    ['the reason is dropped', (pass) => { delete pass.blockerReason; }],
    ['the reason is not a string', (pass) => { pass.blockerReason = 1; }],
  ];
  for (const [name, mutate] of mutations) {
    const pass = applicationScopeFailurePass('application_scope_missing') as Record<string, any>;
    mutate(pass);
    const error = refusal(unboundRun(pass), 'application');
    assert.ok(
      error instanceof ManagedConfirmationUnprovenError,
      `${name}: a pass outside the pinned shape must not be read as a proven no-send, got ${error.name}`,
    );
  }
});

/* THE CLAUSE THAT DOES THE MOST WORK. A reason decided AFTER the press describes a run that already
 * clicked, so reading its missing fingerprints as "there was nothing to press" inverts the truth.
 * Those reasons never reach the branch even in an otherwise perfect unbound pass. */
test('a post-press blocker reason can never buy the unbound shape', () => {
  for (const reason of MANAGED_BLOCKER_REASONS) {
    if (MANAGED_UNBOUND_SCOPE_BLOCKER_REASONS.has(reason)) continue;
    const error = refusal(unboundRun(applicationScopeFailurePass(reason)), 'application');
    assert.ok(error instanceof ManagedConfirmationUnprovenError,
      `${reason} is not a pre-press refusal and must stay an unknown press`);
  }
});

/* THE MEMBERSHIP LIST ITSELF, PINNED AS A LITERAL, because the two tests around it cannot see an
 * addition. `a post-press blocker reason can never buy the unbound shape` iterates the full reason
 * list and SKIPS anything already in the unbound set, so a reason added there is skipped rather
 * than checked; a size comparison stays true at seven entries. Measured: adding
 * 'submit_request_unobserved' - a reason that means the click landed and its request went missing -
 * left this file at 56/56 green while unboundScopeProof began reading that run as "nothing sent".
 *
 * So the set is asserted member for member. Adding a reason here is a deliberate act that must
 * update this literal, and the comment on MANAGED_UNBOUND_SCOPE_BLOCKER_REASONS is the standard it
 * has to meet: decided before any submit handle exists. */
test('the unbound reasons are exactly the six refusals decided before a press', () => {
  assert.deepEqual([...MANAGED_UNBOUND_SCOPE_BLOCKER_REASONS].sort(), [
    'application_scope_ambiguous',
    'application_scope_detached',
    'application_scope_missing',
    'application_scope_not_form',
    'application_scope_unavailable',
    'successful_address_changed',
  ], 'a reason was added to or removed from the pre-press subset; is the new one decided before any submit handle exists?');
  for (const reason of MANAGED_UNBOUND_SCOPE_BLOCKER_REASONS) {
    assert.ok(MANAGED_BLOCKER_REASONS.has(reason), `${reason} is not a reason this service accepts at all`);
  }
});

/* THE ONE THING THAT OUTRANKS THE PROOF. A payload claiming a press, carrying a pass that says no
 * control was ever bound, is contradictory — and PR 506's reading of a contradiction is the only
 * safe one: unknown. This is the exact regression the branch could have introduced. */
test('a run that says it pressed is never re-read as a proven no-send', () => {
  const pressed = { pressed: true, state: 'unknown', source: null, evidence: null, message: null, formStillPresent: null };
  for (const [pass, kind] of [
    [applicationScopeFailurePass('application_scope_missing'), 'application'],
    [securityCodeUnretainedPass(), 'verification'],
  ] as const) {
    const error = refusal(unboundRun(pass, pressed), kind);
    assert.ok(error instanceof ManagedConfirmationUnprovenError,
      'the pass describes no press and the run claims one; the pair proves nothing');
  }
});

test('an unbound pass can never be read as a confirmed send', () => {
  for (const [pass, kind] of [
    [applicationScopeFailurePass('application_scope_missing'), 'application'],
    [securityCodeUnretainedPass(), 'verification'],
  ] as const) {
    const forged = unboundRun(pass, kind === 'verification' ? RUN_WITHHELD_PRESS : undefined);
    (forged.requiredFieldConfirmation as { status: string }).status = 'confirmed';
    const error = refusal(forged, kind);
    assert.match(error.message, /confirmed with failures/,
      'a blocked reason on a proof calling itself confirmed is a contract violation, not a send');
  }
});

/* Pins the SHAPES the way `blocker reasons stay in sync with the managed runner` pins the reasons.
 * The branch above believes exactly two scope-side combinations because those are the two the
 * runner writes. A third synthetic pass appearing in the runner must fail here rather than in
 * production, where it would read as an unreadable proof on a run that sent nothing. */
/* Pins the SHAPES the way `blocker reasons stay in sync with the managed runner` pins the reasons,
 * and it has to read the fields rather than count the passes. Counting `formFingerprint: null`
 * alone says nothing about submitMatchCount or sameNode, so the runner could change either at one
 * of these sites and leave this green while unboundScopeProof silently stopped matching that pass
 * in production - fail-closed, so nothing is mis-sent, but this whole fix would quietly stop
 * working for that site. Each fingerprintless scope object is parsed and offered to the same
 * predicate the backend uses. */
test('the runner writes no third unbound scope shape', { skip: RUNNER_SOURCE_ABSENT }, () => {
  const source = readFileSync(RUNNER_SOURCE_PATH, 'utf8');
  const scopes = [...source.matchAll(/scope:\s*\{([^}]*formFingerprint:\s*null[^}]*)\}/g)];
  assert.equal(scopes.length, 2,
    `the runner now builds ${scopes.length} fingerprintless scopes; unboundScopeProof knows two`);

  for (const [, body] of scopes) {
    const field = (name: string) => {
      const found = new RegExp(`${name}:\\s*([A-Za-z0-9_'-]+)`).exec(body!);
      assert.ok(found, `the runner's fingerprintless scope no longer names ${name}`);
      return found![1]!;
    };
    /* The literal the runner writes, offered to the real predicate rather than re-asserted here, so
     * this test cannot drift from the rule it is pinning. */
    const pass = {
      submitKind: 'application',
      scope: {
        scopeKind: field('scopeKind') === 'null' ? null : field('scopeKind').replace(/'/g, ''),
        formFingerprint: null,
        submitFingerprint: null,
        formMatchCount: Number(field('formMatchCount')),
        submitMatchCount: Number(field('submitMatchCount')),
        requiredControlCount: Number(field('requiredControlCount')),
        sameNode: field('sameNode') === 'true',
      },
      requiredControls: [], attempts: [], retries: 0,
      unresolved: [UNBOUND_SCOPE_MESSAGE],
      blockerReason: 'application_scope_missing',
      submissionOutcome: 'blocked',
    };
    assert.ok(refusal(unboundRun(pass), 'application') instanceof ManagedRequiredFieldConfirmationError,
      `the runner writes a fingerprintless scope unboundScopeProof rejects: ${body!.replace(/\s+/g, ' ').trim()}`);
  }

  for (const sentence of [UNBOUND_SCOPE_MESSAGE, UNBOUND_CODE_MESSAGE]) {
    assert.ok(source.includes(sentence),
      `the runner no longer writes "${sentence}", so RUNNER_AUTHORED_BLOCKERS is repeating a dead string`);
  }
});

/* A REFUSAL AFTER THE CLICK IS NOT A PROOF THAT NOTHING WAS SENT.
 *
 * ManagedRequiredFieldConfirmationError extends NoSubmitControlError, and submissionFailureReview
 * reads that class as "the click provably did not happen": it clears submitted_at, receipt and
 * unverified_submission and releases the packet to be sent again. While MANAGED_BLOCKER_REASONS
 * held five entries every one of them was pre-press, so the equivalence held by accident. At
 * thirty-eight it stopped holding, and a Workable run that pressed Send came back as one that
 * never did - which files the application to a real employer a second time. */

const BOUND_PASS_SCOPE = {
  scopeKind: 'form',
  formFingerprint: 'Zm9ybV9maW5nZXJwcmludF9hYmM',
  submitFingerprint: 'c3VibWl0X2ZpbmdlcnByaW50X3h5',
  formMatchCount: 1,
  submitMatchCount: 1,
  requiredControlCount: 0,
  sameNode: true,
} as const;

/** A pass that bound a real form and a real control, then refused - the ordinary v4 shape. */
function boundRefusal(blockerReason: string, submitOutcome?: unknown) {
  const result: Record<string, unknown> = {
    requiredFieldConfirmation: {
      version: 2,
      status: 'blocked',
      passes: [{
        submitKind: 'application',
        scope: { ...BOUND_PASS_SCOPE },
        requiredControls: [],
        attempts: [],
        retries: 0,
        unresolved: ['Bound submit control or application form was replaced before submission'],
        blockerReason,
        submissionOutcome: 'blocked',
      }],
    },
  };
  if (submitOutcome !== undefined) result.submitOutcome = submitOutcome;
  return result;
}

function thrownBy(result: unknown): Error {
  try {
    assertManagedRequiredFieldsConfirmed(result, 'application');
  } catch (error) {
    return error as Error;
  }
  throw new Error('a blocked proof must never be accepted');
}

test('a post-press refusal is an unknown outcome, never a released packet', () => {
  /* submit_transport_release_failed is the sharpest case: the runner MATCHED the native request and
     replayed it to the network, and only the release confirmation went missing. The employer very
     likely has the application. */
  let checked = 0;
  for (const reason of MANAGED_BLOCKER_REASONS) {
    if (MANAGED_PRE_PRESS_BLOCKER_REASONS.has(reason)) continue;
    checked += 1;
    const error = thrownBy(boundRefusal(reason));
    assert.ok(
      error instanceof ManagedConfirmationUnprovenError,
      `${reason} is not decided before the press, so it cannot release the packet`,
    );
    assert.ok(!(error instanceof NoSubmitControlError), `${reason} must not read as a pre-click stop`);
  }
  /* A `continue` loop over two sets asserts NOTHING if the sets ever become equal, and would then
     report success on the exact merge that reintroduces the bug. Count what was actually tried. */
  assert.equal(
    checked,
    MANAGED_BLOCKER_REASONS.size - MANAGED_PRE_PRESS_BLOCKER_REASONS.size,
    'every reason outside the pre-press set must have been exercised',
  );
  assert.ok(checked > 0, 'the post-press set is not empty');
});

test('a pre-press refusal still releases, so the fix costs the honest stops nothing', () => {
  for (const reason of MANAGED_PRE_PRESS_BLOCKER_REASONS) {
    const error = thrownBy(boundRefusal(reason));
    assert.ok(
      error instanceof ManagedRequiredFieldConfirmationError,
      `${reason} is decided before the press and must stay a proven no-send`,
    );
  }
});

test('every pre-press reason is a reason the runner can actually name', { skip: RUNNER_SOURCE_ABSENT }, () => {
  for (const reason of MANAGED_PRE_PRESS_BLOCKER_REASONS) {
    assert.ok(MANAGED_BLOCKER_REASONS.has(reason), `${reason} is not in the runner's vocabulary`);
  }
  /* MEMBERSHIP IS BY RUNNER SITE, and until this assertion existed nothing checked that. The single
     post-click assignment is `blockerReason = gateResult.reason || ...`, so every reason the gate
     can produce is post-press by construction: finalizeActivation's own reasons, everything
     blockActivation and unchanged() witness, and everything decideSubmitTransportGate names. If a
     future runner routes one of those through the pre-press sites instead, that is a decision to
     make deliberately, not one to discover from a duplicate application. */
  const source = readFileSync(RUNNER_SOURCE_PATH, 'utf8');
  const gateSlice = source.slice(
    source.indexOf('const decideSubmitTransportGate = '),
    source.indexOf('const finishSubmitTransportGate = '),
  );
  assert.ok(gateSlice.length > 0, 'the submit transport gate still decides the post-click reason');
  const postClick = new Set([...gateSlice.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!));
  for (const reason of MANAGED_PRE_PRESS_BLOCKER_REASONS) {
    assert.ok(
      !postClick.has(reason),
      `${reason} is named by the post-click transport gate, so it cannot prove the press never happened`,
    );
  }
  /* Assigned on BOTH sides of the click in managed-browser.js, so neither can prove a no-send. The
     two names read as though they belong here, which is exactly why they are pinned as absent. */
  assert.ok(!MANAGED_PRE_PRESS_BLOCKER_REASONS.has('submit_transport_unpinned'));
  assert.ok(!MANAGED_PRE_PRESS_BLOCKER_REASONS.has('submit_transport_unsupported'));
  /* The unbound-scope set releases on the pass alone, so it must be a subset of the pre-press set. */
  for (const reason of MANAGED_UNBOUND_SCOPE_BLOCKER_REASONS) {
    assert.ok(MANAGED_PRE_PRESS_BLOCKER_REASONS.has(reason), `${reason} releases but is not pre-press`);
  }
});

test('a press the runner claims outranks the proof, however it spells it', () => {
  /* `pressed === true` was too narrow in the one direction that matters. A truncated retained result
     that keeps `state: 'confirmed'` but loses the `pressed` key is the shape this branch exists for,
     and it used to read as "no claim" and release the packet. */
  for (const claim of [{ pressed: true }, { pressed: 1 }, { pressed: 'true' },
    { state: 'confirmed', source: 'receipt' }]) {
    assert.ok(
      thrownBy(boundRefusal('submit_node_replaced', claim)) instanceof ManagedConfirmationUnprovenError,
      `${JSON.stringify(claim)} claims a press, so the outcome is unknown`,
    );
  }
  /* An explicit denial is still a denial, and no submitOutcome at all stays the branch's own case. */
  assert.ok(thrownBy(boundRefusal('submit_node_replaced', { pressed: false }))
    instanceof ManagedRequiredFieldConfirmationError);
  assert.ok(thrownBy(boundRefusal('submit_node_replaced')) instanceof ManagedRequiredFieldConfirmationError);
});

test('the activation guard\'s runtime-built reasons are all named and none of them releases', () => {
  /* These are the eight the first pass of this list missed: `unchanged()` never assigns
     blockerReason, and five of the names are concatenated at runtime, so a literal scan is blind to
     them. Being unlisted was not a reporting gap - contractError releases when the runner denies its
     own press, which it does on exactly these blocks, AFTER the click. */
  const runtimeBuilt = ['pointerdown', 'mousedown', 'focus', 'click', 'activation']
    .map((type) => `${type}_binding_changed`);
  for (const reason of [...runtimeBuilt, 'submit_capture_binding_changed',
    'submit_document_bubble_binding_changed', 'submit_window_bubble_binding_changed']) {
    assert.ok(MANAGED_BLOCKER_REASONS.has(reason), `${reason} would be rejected as a contract error`);
    assert.ok(
      !MANAGED_PRE_PRESS_BLOCKER_REASONS.has(reason),
      `${reason} is witnessed during activation, so it can never prove the press did not happen`,
    );
    assert.ok(
      thrownBy(boundRefusal(reason)) instanceof ManagedConfirmationUnprovenError,
      `${reason} must leave the outcome unknown`,
    );
  }
});

test('a verification pass that never bound a scope cannot speak for the application', () => {
  /* A verification phase exists only because an application phase preceded it, so "this phase bound
     nothing" is not a statement about whether the application was already sent. An explicit
     `pressed: false` IS such a statement - finalSubmitPressed is run-scoped, so it denies the press
     for the whole run - and that shape still releases. Silence does not: with no submitOutcome a
     phase-0 press is unobservable, and releasing there re-applies to an employer that already holds
     the application. */
  assert.ok(
    refusal(unboundRun(securityCodeUnretainedPass(), RUN_WITHHELD_PRESS), 'verification')
      instanceof ManagedRequiredFieldConfirmationError,
    'a run-wide denial of the press still releases',
  );
  assert.ok(
    refusal(unboundRun(securityCodeUnretainedPass()), 'verification')
      instanceof ManagedConfirmationUnprovenError,
    'silence about the press cannot release a phase that had a predecessor',
  );
  /* The application shape is unchanged: a truncated result is the case the branch exists for, and
     no earlier phase could have pressed. */
  assert.ok(
    refusal(unboundRun(applicationScopeFailurePass('application_scope_missing')), 'application')
      instanceof ManagedRequiredFieldConfirmationError,
    'an application pass still releases on silence',
  );
});

test('an unbound pass must carry the runner sentence that explains its reason', () => {
  /* Without this clause a pass with `unresolved: []` satisfied every other one, and the applicant
     was handed the bare token - application_scope_missing - with the sentence explaining it gone.
     That is the defect the unbound branch exists to remove, reachable inside the branch itself. */
  const stripped = applicationScopeFailurePass('application_scope_missing') as Record<string, unknown>;
  stripped.unresolved = [];
  assert.ok(
    refusal(unboundRun(stripped), 'application') instanceof ManagedConfirmationUnprovenError,
    'a refusal that explains nothing cannot be a proven no-send',
  );
});

test('a scope-invalid chooser steps aside so the confirmation proof can name the refusal', () => {
  /* THE ORDERING IS THE WHOLE BUG. submissionRunner runs the chooser barrier BEFORE the confirmation
     barrier, and the runner emits `outcome: 'application_scope_invalid'` in the same block that
     builds the unbound pass. While the chooser reader rejected that outcome, the first barrier threw
     "Litos could not read the managed final-submit chooser proof" - an internal check name - and the
     five application_scope_* reasons could never reach the operator on any real run. Both new tests
     for those reasons passed anyway, because they call the confirmation read directly.

     This asserts the pair in production order. */
  const policy = MANAGED_APPLICATION_SUBMIT_CHOOSER_POLICY;
  const result = {
    finalSubmitChooser: {
      version: 1,
      policyName: policy.name,
      policyVersion: policy.version,
      grammarHash: policy.grammarHash,
      submitKind: 'application',
      outcome: 'application_scope_invalid',
      candidateCount: 0,
      viableCandidateCount: 0,
      topScore: null,
      topScoreCount: 0,
      addressedScopeCount: 0,
      bareSendCandidateCount: 0,
    },
    ...unboundRun(applicationScopeFailurePass('application_scope_detached')),
  };
  assert.doesNotThrow(
    () => assertManagedApplicationFinalSubmitSelected(result as never, FINAL_CHOOSER_URL),
    'the chooser barrier must defer to the stronger read that follows it',
  );
  const error = refusal(result, 'application');
  assert.ok(error instanceof ManagedRequiredFieldConfirmationError);
  assert.deepEqual((error as ManagedRequiredFieldConfirmationError).fields,
    [UNBOUND_SCOPE_MESSAGE, 'application_scope_detached'],
    'the operator gets the runner\'s sentence and the reason, not an internal check name');

  /* A scope-invalid report that claims it scored candidates is describing a chooser run it also
     says could not happen; that contradiction still fails closed at the first barrier. */
  const contradictory = { ...result, finalSubmitChooser: { ...result.finalSubmitChooser, candidateCount: 2 } };
  assert.throws(
    () => assertManagedApplicationFinalSubmitSelected(contradictory as never, FINAL_CHOOSER_URL),
    ManagedConfirmationUnprovenError,
  );
});
