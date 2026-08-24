/* THE SKYDIO PACKET, AS A TEST SUITE.
 *
 * 13bccb2d-d726-4c47-80bc-e8090ae1463e, Ashby, 2026-08-09. Every case below is one thing that packet
 * needed and did not get: a reading of the page instead of a scrape of it, a sentence with a next
 * step in it, a lock with a key, and a duplicate guard that can see a submit it is not sure about.
 */
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isManagedNoSubmitControl,
  isManagedRunTimeout,
  managedSubmitVerdict,
  observeManagedReceiptOnce as observeManagedReceiptOnceWithBinding,
  pressReachedOnlyChallengePlatform,
  readManagedFinalSubmitChooser,
  readManagedFinalSubmitNoClick,
  readManagedSubmitOutcome,
  unverifiedSubmissionReason,
} from './managedSubmitOutcome';
import {
  FINAL_SUBMIT_CHOOSER_POLICY_V3,
  FINAL_SUBMIT_CHOOSER_POLICY_V4,
} from './finalSubmitChooserPolicy';
import { submitRequestDisposition } from './submissionSafety';
import { duplicateAmong, type SubmittedTwinRow } from './duplicateApplication';
import { attentionCategoriesForReasons } from './submissionTerminalCause';

type ManagedReceiptFixture = Parameters<typeof observeManagedReceiptOnceWithBinding>[0]['initial'];

function observeManagedReceiptOnce<T extends ManagedReceiptFixture>(input: {
  initial: T;
  expectedApplicationUrl?: string;
  observe: (continuationToken: string) => Promise<T>;
  nowMs?: number;
}) {
  return observeManagedReceiptOnceWithBinding({
    ...input,
    expectedApplicationUrl: input.expectedApplicationUrl
      ?? (typeof input.initial.url === 'string' ? input.initial.url : ''),
  });
}

/* The exact shape the runner writes on a successful Ashby submit. The container class and the
   sentence are both real: read from jobs.ashbyhq.com/skydio/.../application and from the bundle
   that renders it, cdn.ashbyprd.com/frontend_non_user/87a4960/assets/index-BFELy06m.js, 2026-08-09. */
const ASHBY_CONFIRMED = {
  submitOutcome: {
    pressed: true,
    state: 'confirmed',
    source: 'ats_state',
    evidence: '.ashby-application-form-success-container',
    message: 'Success Thank you for submitting your application. We are thrilled you would consider joining us.',
    formStillPresent: false,
  },
};

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const CHOOSER_URL = 'https://apply.workable.com/example/j/ABC123/';

function chooserResult(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Apply',
    url: CHOOSER_URL,
    text: 'Application',
    screenshot: ONE_PIXEL_PNG,
    blockedSubmits: 0,
    exactPageUrlProof: {
      expected: CHOOSER_URL,
      beforeActions: CHOOSER_URL,
      beforeApplicantData: CHOOSER_URL,
      beforeFinalChooser: CHOOSER_URL,
      beforeSubmit: null,
    },
    submitOutcome: {
      pressed: false,
      state: 'not_attempted',
      source: null,
      evidence: null,
      message: null,
      formStillPresent: null,
    },
    securityCodeAttempt: null,
    requiredFieldConfirmation: null,
    finalSubmitChooser: {
      version: 1,
      policyName: 'litos-final-submit',
      policyVersion: 4,
      grammarHash: FINAL_SUBMIT_CHOOSER_POLICY_V4.grammarHash,
      submitKind: 'application',
      outcome: 'no_submit_control',
      candidateCount: 0,
      viableCandidateCount: 0,
      topScore: null,
      topScoreCount: 0,
      addressedScopeCount: 1,
      bareSendCandidateCount: 0,
    },
    ...overrides,
  };
}

describe('managed final-submit chooser telemetry', () => {
  test('accepts byte-bound v4 no-control evidence and exact v3 telemetry while old continuations drain', () => {
    const v4 = chooserResult();
    assert.equal(
      readManagedFinalSubmitChooser(v4, FINAL_SUBMIT_CHOOSER_POLICY_V4, 'application')?.outcome,
      'no_submit_control',
    );
    const v3 = chooserResult({
      finalSubmitChooser: {
        ...v4.finalSubmitChooser,
        policyVersion: 3,
        grammarHash: FINAL_SUBMIT_CHOOSER_POLICY_V3.grammarHash,
      },
    });
    assert.equal(
      readManagedFinalSubmitChooser(v3, FINAL_SUBMIT_CHOOSER_POLICY_V3, 'application')?.policyVersion,
      3,
    );
  });

  test('rejects policy drift, extra fields, impossible counts, and v3 bare-Send claims', () => {
    const base = chooserResult();
    for (const finalSubmitChooser of [
      { ...base.finalSubmitChooser, grammarHash: '0'.repeat(64) },
      { ...base.finalSubmitChooser, extra: true },
      { ...base.finalSubmitChooser, viableCandidateCount: 1 },
      { ...base.finalSubmitChooser, outcome: 'ambiguous_submit', viableCandidateCount: 1, topScore: 1, topScoreCount: 1 },
      {
        ...base.finalSubmitChooser,
        outcome: 'selected',
        candidateCount: 2,
        viableCandidateCount: 2,
        topScore: 0,
        topScoreCount: 1,
        bareSendCandidateCount: 1,
      },
      {
        ...base.finalSubmitChooser,
        policyVersion: 3,
        grammarHash: FINAL_SUBMIT_CHOOSER_POLICY_V3.grammarHash,
        bareSendCandidateCount: 1,
      },
    ]) {
      const policy = finalSubmitChooser.policyVersion === 3
        ? FINAL_SUBMIT_CHOOSER_POLICY_V3
        : FINAL_SUBMIT_CHOOSER_POLICY_V4;
      assert.equal(readManagedFinalSubmitChooser(
        chooserResult({ finalSubmitChooser }),
        policy,
        'application',
      ), null);
    }
  });

  test('releases only a screenshot-backed exact-URL no-click with no clicked pass', () => {
    const result = chooserResult();
    assert.equal(
      readManagedFinalSubmitNoClick(
        result,
        FINAL_SUBMIT_CHOOSER_POLICY_V4,
        'application',
        CHOOSER_URL,
      )?.outcome,
      'no_submit_control',
    );
    const contradictions = [
      { screenshot: null },
      { url: 'https://apply.workable.com/example/j/OTHER/' },
      { exactPageUrlProof: { ...result.exactPageUrlProof, beforeFinalChooser: null } },
      { exactPageUrlProof: { ...result.exactPageUrlProof, beforeSubmit: CHOOSER_URL } },
      { submitOutcome: { ...result.submitOutcome, pressed: true } },
      { securityCodeAttempt: { supplied: true, entered: true, outcome: 'confirmed', resubmitted: true } },
      { requiredFieldConfirmation: { version: 2, status: 'confirmed', passes: [{ submissionOutcome: 'clicked' }] } },
      { blockedSubmits: 1 },
    ];
    for (const contradiction of contradictions) {
      assert.equal(readManagedFinalSubmitNoClick(
        chooserResult(contradiction),
        FINAL_SUBMIT_CHOOSER_POLICY_V4,
        'application',
        CHOOSER_URL,
      ), null);
    }
  });

  test('a no-click proof can freeze Workable canonicalization before applicant data', () => {
    const expected = 'https://apply.workable.com/j/20e78cba92/apply';
    const resolved = 'https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply';
    const result = chooserResult({
      url: resolved,
      exactPageUrlProof: {
        expected,
        beforeActions: resolved,
        beforeApplicantData: resolved,
        beforeFinalChooser: resolved,
        beforeSubmit: null,
      },
    });
    assert.equal(readManagedFinalSubmitNoClick(
      result,
      FINAL_SUBMIT_CHOOSER_POLICY_V4,
      'application',
      expected,
    )?.outcome, 'no_submit_control');
    assert.equal(readManagedFinalSubmitNoClick(
      { ...result, url: 'https://apply.workable.com/another-tenant/j/20E78CBA92/apply' },
      FINAL_SUBMIT_CHOOSER_POLICY_V4,
      'application',
      expected,
    ), null);
  });

  test('accepts internally consistent ambiguity but never turns a selected result into no-click', () => {
    const base = chooserResult();
    const ambiguous = chooserResult({
      finalSubmitChooser: {
        ...base.finalSubmitChooser,
        outcome: 'ambiguous_submit',
        candidateCount: 2,
        viableCandidateCount: 2,
        topScore: 0,
        topScoreCount: 2,
        bareSendCandidateCount: 2,
      },
    });
    assert.equal(readManagedFinalSubmitNoClick(
      ambiguous,
      FINAL_SUBMIT_CHOOSER_POLICY_V4,
      'application',
      CHOOSER_URL,
    )?.outcome, 'ambiguous_submit');
    const selected = chooserResult({
      finalSubmitChooser: {
        ...base.finalSubmitChooser,
        outcome: 'selected',
        candidateCount: 1,
        viableCandidateCount: 1,
        topScore: 0,
        topScoreCount: 1,
        addressedScopeCount: 1,
        bareSendCandidateCount: 1,
      },
    });
    assert.equal(readManagedFinalSubmitNoClick(
      selected,
      FINAL_SUBMIT_CHOOSER_POLICY_V4,
      'application',
      CHOOSER_URL,
    ), null);
  });
});

describe('the run reads the outcome off the page, and the caller keys off that', () => {
  test('Ashby’s own success state is a confirmation, and it says what proved it', () => {
    const verdict = managedSubmitVerdict(ASHBY_CONFIRMED);
    assert.equal(verdict.kind, 'confirmed');
    if (verdict.kind !== 'confirmed') return;
    assert.match(verdict.evidence, /ashby-application-form-success-container/);
    // The employer's own sentence is carried through as the receipt text. It is per-org: Skydio's
    // reads like this, an org that has set none gets Ashby's default. The CONTAINER is what the
    // verdict rests on, which is why the two are recorded separately.
    assert.match(verdict.confirmationText, /thank you for submitting your application/i);
  });

  test('a refusal outranks everything, because a page that refused did not file anything', () => {
    const verdict = managedSubmitVerdict({
      submitOutcome: {
        pressed: true,
        state: 'rejected',
        source: 'ats_state',
        evidence: '.ashby-application-form-failure-container',
        message: 'We couldn’t submit your application',
        formStillPresent: false,
      },
    });
    assert.equal(verdict.kind, 'refused');
    if (verdict.kind !== 'refused') return;
    assert.match(verdict.message, /couldn’t submit/i);
  });

  /* A REFUSAL IS ALSO A DEFINITE ANSWER, AND IT IS THE ONE THAT RELEASES THE CLAIM.
   *
   * The runner writes "Nothing was filed, so there is no confirmation to look for" off this verdict
   * and clears submission_claimed_at with it, so an unproven 'refused' is a wrong sentence and a
   * duplicate application in the same write. Stratus's rejected arm returns the first VISIBLE
   * failure container it finds without reading its text or asking whether the form is gone, so both
   * of these arrive over the wire looking exactly like the real thing. */
  for (const [name, over] of [
    ['an empty failure container', { message: '', formStillPresent: false }],
    ['a failure container over a live form', { message: 'We couldn’t submit your application', formStillPresent: true }],
    ['both at once', { message: '   ', formStillPresent: true }],
    ['a runner too old to say whether the form is gone', { message: 'We couldn’t submit your application', formStillPresent: null }],
  ] as const) {
    test(`${name} is unverified, never refused`, () => {
      const verdict = managedSubmitVerdict({
        submitOutcome: {
          pressed: true,
          state: 'rejected',
          source: 'ats_state',
          evidence: '.ashby-application-form-failure-container',
          ...over,
        },
      });
      assert.deepEqual(verdict, { kind: 'unverified', cause: 'no_confirmation_state' },
        'an unproven refusal must keep the claim and ask her to look, never announce that nothing was filed');
    });
  }

  test('an unproven refusal never falls through to a confirmation on the same page', () => {
    // 'rejected' outranks 'confirmed' and has to keep outranking it when it fails its own gate:
    // falling through would let a page that refused be read off its congratulatory prose instead.
    const verdict = managedSubmitVerdict({
      submitOutcome: {
        pressed: true,
        state: 'rejected',
        source: 'ats_state',
        evidence: '.ashby-application-form-failure-container',
        message: 'Thank you for submitting your application.',
        formStillPresent: true,
      },
    });
    assert.equal(verdict.kind, 'unverified');
  });

  test('an unproven refusal from a run that never pressed is still not_attempted', () => {
    const verdict = managedSubmitVerdict({
      submitOutcome: {
        pressed: false,
        state: 'rejected',
        source: 'ats_state',
        evidence: '.ashby-application-form-failure-container',
        message: '',
        formStillPresent: true,
      },
    });
    assert.deepEqual(verdict, { kind: 'not_attempted' },
      'the runner is believed about its own click even when the page proved nothing');
  });

  test('a page that never said is unverified, not submitted and not failed', () => {
    const verdict = managedSubmitVerdict({
      // The old instrument would have called this submitted: the body of an Ashby posting is full of
      // "thank you" and RECEIPT_PROOF_RE matches the bare phrase.
      submitOutcome: { pressed: true, state: 'unknown', source: null, evidence: null, message: null, formStillPresent: true },
    });
    assert.deepEqual(verdict, { kind: 'unverified', cause: 'no_confirmation_state' });
  });

  test('a runner that predates the field degrades to the old behaviour, never to a wrong answer', () => {
    // Mid-rollout this is the ordinary case. 'unreported' means "ask the scrape", which is exactly
    // what this code did before, rather than "assume nothing happened".
    assert.deepEqual(managedSubmitVerdict({ }), { kind: 'unreported' });
    assert.equal(readManagedSubmitOutcome(undefined), null);
  });

  test('a fill run reports not_attempted, and the decoy prose cannot promote it', () => {
    const outcome = readManagedSubmitOutcome({
      submitOutcome: { pressed: false, state: 'not_attempted', source: null, evidence: null, message: null, formStillPresent: true },
    });
    assert.equal(outcome?.state, 'not_attempted');
    assert.equal(outcome?.pressed, false);
  });

  test('the timeouts that mean "the run never said what it did" are recognised', () => {
    assert.equal(isManagedRunTimeout('Managed browser run timed out before it produced a result'), true);
    // The sentence the Skydio packet actually carried. Still recognised, because an older runner or
    // a genuine continuation can still produce it.
    assert.equal(isManagedRunTimeout('Managed browser continuation timed out'), true);
    assert.equal(isManagedRunTimeout('page.goto: net::ERR_CONNECTION_REFUSED'), false);
  });

  test('the exact pre-click atomic chooser failure is not reported as an attempted submission', () => {
    assert.equal(isManagedNoSubmitControl('Atomic submit control was missing or ambiguous'), true);
    assert.equal(isManagedNoSubmitControl('Atomic submit control timed out after click'), false);
    assert.equal(isManagedNoSubmitControl('Managed browser continuation timed out'), false);
  });
});

describe('an unknown pressed result gets one bounded read-only receipt observation', () => {
  const token = 'receipt_observation_token_abcdefghijklmnopqrstuvwxyz';
  const expiresAt = '2026-08-11T12:00:15.000Z';
  const unknown = {
    title: 'Application',
    url: 'https://jobs.ashbyhq.com/kos/software-engineer-intern/application',
    text: 'Submit Application',
    screenshot: 'initial-post-click-image',
    continuationOffered: true,
    continuationToken: token,
    continuationExpiresAt: expiresAt,
    humanVerification: null,
    submitOutcome: {
      pressed: true,
      state: 'unknown',
      source: null,
      evidence: null,
      message: null,
      formStillPresent: true,
    },
  };

  const atsResult = (over: Record<string, unknown>) => ({
    ...unknown,
    screenshot: 'observed-receipt-image',
    ...over,
  });

  test('Haize Greenhouse promotes only its confirmation route from the exact held run', async () => {
    const greenhouseInitial = {
      ...unknown,
      url: 'https://job-boards.greenhouse.io/haizelabs/jobs/4685944008',
    };
    const observed = atsResult({
      title: 'Thank you for applying',
      url: 'https://job-boards.greenhouse.io/haizelabs/jobs/4685944008/confirmation',
      text: 'Thank you for applying. Your application has been received.',
      submitOutcome: {
        pressed: true,
        state: 'confirmed',
        source: 'ats_route',
        evidence: 'greenhouse:/haizelabs/jobs/4685944008/confirmation',
        message: 'Thank you for applying. Your application has been received.',
        formStillPresent: false,
      },
    });
    const tokens: string[] = [];
    const result = await observeManagedReceiptOnce({
      initial: greenhouseInitial,
      nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
      observe: async (exactToken) => { tokens.push(exactToken); return observed; },
    });
    assert.deepEqual(tokens, [token]);
    assert.equal(result.attempted, true);
    assert.equal(result.receiptResult, observed);
    assert.equal(result.evidenceResult, observed);
    assert.equal(managedSubmitVerdict(result.receiptResult).kind, 'confirmed');
  });

  test('measured Greenhouse embed binds exact for and token through confirmation', async () => {
    const initial = {
      ...unknown,
      url: 'https://job-boards.greenhouse.io/embed/job_app?for=haizelabs&token=4685944008',
    };
    const observed = atsResult({
      url: 'https://job-boards.greenhouse.io/embed/job_app/confirmation?for=haizelabs&token=4685944008',
      submitOutcome: {
        pressed: true,
        state: 'confirmed',
        source: 'ats_route',
        evidence: 'greenhouse:/embed/job_app/confirmation',
        message: 'Thank you for applying. Your application has been received.',
        formStillPresent: false,
      },
    });
    const result = await observeManagedReceiptOnce({
      initial,
      nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
      observe: async () => observed,
    });
    assert.equal(result.receiptResult, observed);
    assert.equal(managedSubmitVerdict(result.receiptResult).kind, 'confirmed');
  });

  test('measured Workable success state promotes only the exact bound tenant and job', async () => {
    const initial = {
      ...unknown,
      url: 'https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply/',
    };
    const observed = atsResult({
      title: 'Thank you!',
      url: 'https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply/?success',
      text: 'Your application has been submitted successfully.',
      submitOutcome: {
        pressed: true,
        state: 'confirmed',
        source: 'ats_state',
        evidence: '[data-ui="successful-submit"]',
        message: 'Your application has been submitted successfully.',
        formStillPresent: false,
      },
    });
    const result = await observeManagedReceiptOnce({
      initial,
      nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
      observe: async () => observed,
    });
    assert.equal(result.receiptResult, observed);
    assert.equal(result.evidenceResult, observed);
    assert.equal(managedSubmitVerdict(result.receiptResult).kind, 'confirmed');
  });

  test('a supported bare Workable job URL binds through its canonical tenant redirect', async () => {
    const initial = {
      ...unknown,
      url: 'https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply/',
    };
    const observed = atsResult({
      url: 'https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply/?success',
      submitOutcome: {
        pressed: true,
        state: 'confirmed',
        source: 'ats_state',
        evidence: '[data-ui="successful-submit"]',
        message: 'Your application has been submitted successfully.',
        formStillPresent: false,
      },
    });
    let calls = 0;
    const result = await observeManagedReceiptOnce({
      initial,
      expectedApplicationUrl: 'https://apply.workable.com/j/20E78CBA92/apply/',
      nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
      observe: async () => { calls += 1; return observed; },
    });
    assert.equal(calls, 1);
    assert.equal(result.receiptResult, observed);
    assert.equal(managedSubmitVerdict(result.receiptResult).kind, 'confirmed');
  });

  test('a bare Workable URL cannot bind another token or become the observed receipt shape', async () => {
    const initial = {
      ...unknown,
      url: 'https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply/',
    };
    let calls = 0;
    const mismatch = await observeManagedReceiptOnce({
      initial,
      expectedApplicationUrl: 'https://apply.workable.com/j/AAAAAAAAAA/apply/',
      nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
      observe: async () => { calls += 1; return initial; },
    });
    assert.equal(calls, 0);
    assert.equal(mismatch.attempted, false);

    const bareObserved = atsResult({
      url: 'https://apply.workable.com/j/20E78CBA92/apply/?success',
      submitOutcome: {
        pressed: true,
        state: 'confirmed',
        source: 'ats_state',
        evidence: '[data-ui="successful-submit"]',
        message: 'Your application has been submitted successfully.',
        formStillPresent: false,
      },
    });
    const result = await observeManagedReceiptOnce({
      initial,
      expectedApplicationUrl: 'https://apply.workable.com/j/20E78CBA92/apply/',
      nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
      observe: async () => bareObserved,
    });
    assert.equal(result.receiptResult, initial);
    assert.equal(managedSubmitVerdict(result.receiptResult).kind, 'unverified');
  });

  test('Workable continuation refuses missing success state, another job, and generic status prose', async () => {
    const initial = {
      ...unknown,
      url: 'https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply/',
    };
    const exactOutcome = {
      pressed: true,
      state: 'confirmed',
      source: 'ats_state',
      evidence: '[data-ui="successful-submit"]',
      message: 'Your application has been submitted successfully.',
      formStillPresent: false,
    };
    for (const observed of [
      atsResult({
        url: 'https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply/',
        submitOutcome: exactOutcome,
      }),
      atsResult({
        url: 'https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply/?success&source=retry',
        submitOutcome: exactOutcome,
      }),
      atsResult({
        url: 'https://apply.workable.com/max-borges-agency/j/AAAAAAAAAA/apply/?success',
        submitOutcome: exactOutcome,
      }),
      atsResult({
        url: 'https://apply.workable.com/another-tenant/j/20E78CBA92/apply/?success',
        submitOutcome: exactOutcome,
      }),
      atsResult({
        url: 'https://careers.example.test/max-borges-agency/j/20E78CBA92/apply/?success',
        submitOutcome: exactOutcome,
      }),
      atsResult({
        url: 'https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply/?success',
        submitOutcome: { ...exactOutcome, source: 'live_region', evidence: 'status' },
      }),
      atsResult({
        url: 'https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply/?success',
        submitOutcome: { ...exactOutcome, formStillPresent: true },
      }),
    ]) {
      const result = await observeManagedReceiptOnce({
        initial,
        nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
        observe: async () => observed,
      });
      assert.equal(result.receiptResult, initial);
      assert.equal(managedSubmitVerdict(result.receiptResult).kind, 'unverified');
    }
  });

  test('Workable treats the provider-preserved lowercase token as the same exact job', async () => {
    const initial = {
      ...unknown,
      url: 'https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply/',
    };
    const observed = atsResult({
      url: 'https://apply.workable.com/max-borges-agency/j/20e78cba92/apply/?success',
      submitOutcome: {
        pressed: true,
        state: 'confirmed',
        source: 'ats_state',
        evidence: '[data-ui="successful-submit"]',
        message: 'Your application has been submitted successfully.',
        formStillPresent: false,
      },
    });
    const result = await observeManagedReceiptOnce({
      initial,
      expectedApplicationUrl: 'https://apply.workable.com/j/20e78cba92/apply/',
      nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
      observe: async () => observed,
    });
    assert.equal(result.receiptResult, observed);
    assert.equal(managedSubmitVerdict(result.receiptResult).kind, 'confirmed');
  });

  test('a Workable expected-application mismatch cannot consume the observation token', async () => {
    const initial = {
      ...unknown,
      url: 'https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply/',
    };
    let calls = 0;
    const result = await observeManagedReceiptOnce({
      initial,
      expectedApplicationUrl: 'https://apply.workable.com/another-tenant/j/20E78CBA92/apply/',
      nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
      observe: async () => { calls += 1; return initial; },
    });
    assert.equal(calls, 0);
    assert.equal(result.attempted, false);
    assert.equal(result.receiptResult, initial);
  });

  test('kos.ai Ashby promotes only its published success container from the exact held run', async () => {
    const observed = atsResult({
      title: 'Application submitted',
      url: 'https://jobs.ashbyhq.com/kos/software-engineer-intern/application',
      text: 'Success. Thank you for submitting your application.',
      submitOutcome: {
        pressed: true,
        state: 'confirmed',
        source: 'ats_state',
        evidence: '.ashby-application-form-success-container',
        message: 'Success. Thank you for submitting your application.',
        formStillPresent: false,
      },
    });
    const result = await observeManagedReceiptOnce({
      initial: unknown,
      nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
      observe: async (exactToken) => {
        assert.equal(exactToken, token, 'a token from another run must never be substituted');
        return observed;
      },
    });
    assert.equal(result.receiptResult, observed);
    assert.equal(managedSubmitVerdict(result.receiptResult).kind, 'confirmed');
  });

  test('ATS refusal is accepted, while weak text, unknown, and timeout stay unverified', async () => {
    const refused = atsResult({
      url: 'https://jobs.ashbyhq.com/kos/software-engineer-intern/application',
      submitOutcome: {
        pressed: true,
        state: 'rejected',
        source: 'ats_state',
        evidence: '.ashby-application-form-failure-container',
        message: 'We could not submit your application.',
        formStillPresent: false,
      },
    });
    const refusedResult = await observeManagedReceiptOnce({
      initial: unknown,
      nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
      observe: async () => refused,
    });
    assert.equal(managedSubmitVerdict(refusedResult.receiptResult).kind, 'refused');

    /* THE OBSERVATION IS WHERE AN UNPROVEN REFUSAL DOES ITS DAMAGE, because this is the arm that
     * turns a still-unknown receipt into a definite one. An empty failure container, or one sitting
     * over a live form, must not become the receiptResult at all: the initial unknown stays, and the
     * packet keeps its claim instead of being told nothing was filed and released for a re-run. */
    for (const weakRefusal of [
      { message: '', formStillPresent: false },
      { message: 'We could not submit your application.', formStillPresent: true },
    ] as const) {
      const observed = atsResult({
        url: 'https://jobs.ashbyhq.com/kos/software-engineer-intern/application',
        submitOutcome: {
          pressed: true,
          state: 'rejected',
          source: 'ats_state',
          evidence: '.ashby-application-form-failure-container',
          ...weakRefusal,
        },
      });
      const weak = await observeManagedReceiptOnce({
        initial: unknown,
        nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
        observe: async () => observed,
      });
      assert.equal(weak.receiptResult, unknown, 'an unproven refusal must not become the receipt');
      assert.equal(managedSubmitVerdict(weak.receiptResult).kind, 'unverified');
      assert.equal(weak.evidenceResult, observed, 'the latest post-click screenshot remains visible');
    }

    for (const observed of [
      atsResult({
        submitOutcome: {
          pressed: true,
          state: 'confirmed',
          source: 'page_text',
          evidence: 'body',
          message: 'Thank you for your application.',
          formStillPresent: false,
        },
      }),
      atsResult({ submitOutcome: unknown.submitOutcome }),
    ]) {
      const result = await observeManagedReceiptOnce({
        initial: unknown,
        nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
        observe: async () => observed,
      });
      assert.equal(managedSubmitVerdict(result.receiptResult).kind, 'unverified');
      assert.equal(result.evidenceResult, observed, 'the latest post-click screenshot remains visible');
    }

    const timedOut = await observeManagedReceiptOnce({
      initial: unknown,
      nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
      observe: async () => { throw new Error('continuation timed out'); },
    });
    assert.equal(timedOut.attempted, true);
    assert.equal(managedSubmitVerdict(timedOut.receiptResult).kind, 'unverified');
    assert.equal(timedOut.evidenceResult, unknown);
    assert.match(String(timedOut.error), /timed out/);
  });

  test('a delayed typed code wall is returned for challenge handoff, never promoted as a receipt', async () => {
    const delayedChallenge = atsResult({
      humanVerification: {
        kind: 'security_code',
        fieldCount: 8,
        sentTo: 'application-alias@apply.trylitos.com',
      },
      submitOutcome: {
        pressed: true,
        state: 'unknown',
        source: null,
        evidence: null,
        message: null,
        formStillPresent: true,
      },
    });
    const result = await observeManagedReceiptOnce({
      initial: unknown,
      nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
      observe: async () => delayedChallenge,
    });
    assert.equal(result.attempted, true);
    assert.equal(result.observedResult, delayedChallenge);
    assert.equal(result.receiptResult, unknown, 'a challenge is not an employer receipt');
    assert.equal(result.evidenceResult, delayedChallenge);
    assert.equal(managedSubmitVerdict(result.receiptResult).kind, 'unverified');
  });

  test('a delayed code wall from another exact job is neither exposed nor adopted', async () => {
    const initial = {
      ...unknown,
      url: 'https://job-boards.greenhouse.io/embed/job_app?for=haizelabs&token=4685944008',
    };
    const crossed = atsResult({
      url: 'https://job-boards.greenhouse.io/embed/job_app?for=other-tenant&token=9999999999',
      humanVerification: {
        kind: 'security_code',
        fieldCount: 8,
        sentTo: 'application-alias@apply.trylitos.com',
      },
      submitOutcome: {
        pressed: true,
        state: 'unknown',
        source: null,
        evidence: null,
        message: null,
        formStillPresent: true,
      },
    });
    const result = await observeManagedReceiptOnce({
      initial,
      nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
      observe: async () => crossed,
    });
    assert.equal(result.observedResult, undefined);
    assert.equal(result.evidenceResult, initial);
    assert.equal(result.receiptResult, initial);
  });

  test('spoofed ATS source labels, evidence, and host-family crossings cannot promote a receipt', async () => {
    const shapes = [
      atsResult({
        url: 'https://careers.example.test/application_confirmation',
        submitOutcome: {
          pressed: true,
          state: 'confirmed',
          source: 'ats_route',
          evidence: 'greenhouse:/application_confirmation',
          message: 'Thank you for applying.',
          formStillPresent: false,
        },
      }),
      atsResult({
        url: 'https://job-boards.greenhouse.io/application_confirmation',
        submitOutcome: {
          pressed: true,
          state: 'confirmed',
          source: 'ats_route',
          evidence: 'greenhouse:/another_run',
          message: 'Thank you for applying.',
          formStillPresent: false,
        },
      }),
      atsResult({
        url: 'https://jobs.ashbyhq.com/kos/software-engineer-intern/application',
        submitOutcome: {
          pressed: true,
          state: 'confirmed',
          source: 'ats_state',
          evidence: '.employer-made-success',
          message: 'Thank you for applying.',
          formStillPresent: false,
        },
      }),
      atsResult({
        url: 'https://job-boards.greenhouse.io/application_confirmation',
        submitOutcome: {
          pressed: true,
          state: 'confirmed',
          source: 'ats_route',
          evidence: 'greenhouse:/application_confirmation',
          message: 'Thank you for applying.',
          formStillPresent: false,
        },
      }),
      atsResult({
        url: 'https://job-boards.greenhouse.io/application_confirmation',
        submitOutcome: {
          pressed: true,
          state: 'confirmed',
          source: 'ats_state',
          evidence: '.ashby-application-form-success-container',
          message: 'Thank you for applying.',
          formStillPresent: false,
        },
      }),
      atsResult({
        url: 'https://observer:secret@jobs.ashbyhq.com/kos/software-engineer-intern/application',
        submitOutcome: {
          pressed: true,
          state: 'confirmed',
          source: 'ats_state',
          evidence: '.ashby-application-form-success-container',
          message: 'Thank you for applying.',
          formStillPresent: false,
        },
      }),
      atsResult({
        url: 'https://jobs.ashbyhq.com:444/kos/software-engineer-intern/application',
        submitOutcome: {
          pressed: true,
          state: 'confirmed',
          source: 'ats_state',
          evidence: '.ashby-application-form-success-container',
          message: 'Thank you for applying.',
          formStillPresent: false,
        },
      }),
      atsResult({
        url: 'http://jobs.ashbyhq.com/kos/software-engineer-intern/application',
        submitOutcome: {
          pressed: true,
          state: 'confirmed',
          source: 'ats_state',
          evidence: '.ashby-application-form-success-container',
          message: 'Thank you for applying.',
          formStillPresent: false,
        },
      }),
    ];
    for (const observed of shapes) {
      const result = await observeManagedReceiptOnce({
        initial: unknown,
        nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
        observe: async () => observed,
      });
      assert.equal(managedSubmitVerdict(result.receiptResult).kind, 'unverified');
      assert.equal(
        result.evidenceResult,
        observed.url === unknown.url ? observed : unknown,
        'same-job evidence may refresh the screenshot, while an identity crossing must stay on phase zero',
      );
    }
  });

  test('the initial ATS origin rejects credentials and non-default ports before observation', async () => {
    for (const url of [
      'https://runner:secret@jobs.ashbyhq.com/kos/software-engineer-intern/application',
      'https://jobs.ashbyhq.com:444/kos/software-engineer-intern/application',
      'http://jobs.ashbyhq.com/kos/software-engineer-intern/application',
    ]) {
      let calls = 0;
      const result = await observeManagedReceiptOnce({
        initial: { ...unknown, url },
        nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
        observe: async () => { calls += 1; throw new Error('must not run'); },
      });
      assert.equal(calls, 0, `invalid ATS origin must not spend its token: ${url}`);
      assert.equal(result.attempted, false);
    }
  });

  test('the frozen Ashby application rejects a same-host crossed job before token use', async () => {
    for (const url of [
      'https://jobs.ashbyhq.com/kos/other-job/application',
      'https://jobs.ashbyhq.com/other-org/software-engineer-intern/application',
    ]) {
      let calls = 0;
      const result = await observeManagedReceiptOnce({
        initial: { ...unknown, url },
        expectedApplicationUrl: unknown.url,
        nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
        observe: async () => { calls += 1; throw new Error('must not run'); },
      });
      assert.equal(calls, 0, url);
      assert.equal(result.attempted, false, url);
      assert.equal(result.receiptResult.url, url);
    }
  });

  test('the frozen Greenhouse application rejects a same-host crossed job before token use', async () => {
    const expectedApplicationUrl = 'https://job-boards.greenhouse.io/haizelabs/jobs/4685944008';
    for (const url of [
      'https://job-boards.greenhouse.io/haizelabs/jobs/9999999999',
      'https://job-boards.greenhouse.io/other-tenant/jobs/4685944008',
      'https://job-boards.greenhouse.io/embed/job_app?for=haizelabs&token=4685944008',
    ]) {
      let calls = 0;
      const result = await observeManagedReceiptOnce({
        initial: { ...unknown, url },
        expectedApplicationUrl,
        nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
        observe: async () => { calls += 1; throw new Error('must not run'); },
      });
      assert.equal(calls, 0, url);
      assert.equal(result.attempted, false, url);
      assert.equal(result.receiptResult.url, url);
    }
  });

  test('the frozen binding rejects family, origin, and shape crossings before token use', async () => {
    const expectedApplicationUrl = 'https://job-boards.greenhouse.io/haizelabs/jobs/4685944008';
    for (const url of [
      'https://jobs.ashbyhq.com/haizelabs/4685944008/application',
      'https://job-boards.eu.greenhouse.io/haizelabs/jobs/4685944008',
      'https://job-boards.greenhouse.io/embed/job_app?for=haizelabs&token=4685944008',
    ]) {
      let calls = 0;
      const result = await observeManagedReceiptOnce({
        initial: { ...unknown, url },
        expectedApplicationUrl,
        nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
        observe: async () => { calls += 1; throw new Error('must not run'); },
      });
      assert.equal(calls, 0, url);
      assert.equal(result.attempted, false, url);
    }
  });

  test('Greenhouse observation stays on the exact regional origin from phase zero', async () => {
    const initial = {
      ...unknown,
      url: 'https://job-boards.greenhouse.io/haizelabs/jobs/4685944008',
    };
    const observed = atsResult({
      url: 'https://job-boards.eu.greenhouse.io/haizelabs/jobs/4685944008/confirmation',
      submitOutcome: {
        pressed: true,
        state: 'confirmed',
        source: 'ats_route',
        evidence: 'greenhouse:/haizelabs/jobs/4685944008/confirmation',
        message: 'Thank you for applying.',
        formStillPresent: false,
      },
    });
    const result = await observeManagedReceiptOnce({
      initial,
      nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
      observe: async () => observed,
    });
    assert.equal(result.attempted, true);
    assert.equal(managedSubmitVerdict(result.receiptResult).kind, 'unverified');
    assert.equal(result.evidenceResult, initial);
  });

  test('Ashby observation cannot cross org or job identity on the same host', async () => {
    for (const url of [
      'https://jobs.ashbyhq.com/other-org/software-engineer-intern/application',
      'https://jobs.ashbyhq.com/kos/other-job/application',
    ]) {
      const observed = atsResult({
        url,
        submitOutcome: {
          pressed: true,
          state: 'confirmed',
          source: 'ats_state',
          evidence: '.ashby-application-form-success-container',
          message: 'Thank you for applying.',
          formStillPresent: false,
        },
      });
      const result = await observeManagedReceiptOnce({
        initial: unknown,
        nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
        observe: async () => observed,
      });
      assert.equal(managedSubmitVerdict(result.receiptResult).kind, 'unverified', url);
      assert.equal(result.evidenceResult, unknown);
    }
  });

  test('Greenhouse observation cannot cross tenant or job token on the same origin', async () => {
    const initial = {
      ...unknown,
      url: 'https://job-boards.greenhouse.io/haizelabs/jobs/4685944008',
    };
    for (const url of [
      'https://job-boards.greenhouse.io/other-tenant/jobs/4685944008/confirmation',
      'https://job-boards.greenhouse.io/haizelabs/jobs/other-token/confirmation',
    ]) {
      const pathname = new URL(url).pathname;
      const observed = atsResult({
        url,
        submitOutcome: {
          pressed: true,
          state: 'confirmed',
          source: 'ats_route',
          evidence: `greenhouse:${pathname}`,
          message: 'Thank you for applying.',
          formStillPresent: false,
        },
      });
      const result = await observeManagedReceiptOnce({
        initial,
        nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
        observe: async () => observed,
      });
      assert.equal(managedSubmitVerdict(result.receiptResult).kind, 'unverified', url);
      assert.equal(result.evidenceResult, initial);
    }
  });

  test('Greenhouse embed rejects cross-tenant, cross-job, and duplicate identity query values', async () => {
    const initial = {
      ...unknown,
      url: 'https://job-boards.greenhouse.io/embed/job_app?for=haizelabs&token=4685944008',
    };
    for (const url of [
      'https://job-boards.greenhouse.io/embed/job_app/confirmation?for=other-tenant&token=4685944008',
      'https://job-boards.greenhouse.io/embed/job_app/confirmation?for=haizelabs&token=other-job',
      'https://job-boards.greenhouse.io/embed/job_app/confirmation?for=haizelabs&for=other-tenant&token=4685944008',
      'https://job-boards.greenhouse.io/embed/job_app/confirmation?for=haizelabs&token=4685944008&token=other-job',
    ]) {
      const observed = atsResult({
        url,
        submitOutcome: {
          pressed: true,
          state: 'confirmed',
          source: 'ats_route',
          evidence: 'greenhouse:/embed/job_app/confirmation',
          message: 'Thank you for applying.',
          formStillPresent: false,
        },
      });
      const result = await observeManagedReceiptOnce({
        initial,
        nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
        observe: async () => observed,
      });
      assert.equal(managedSubmitVerdict(result.receiptResult).kind, 'unverified', url);
    }

    for (const url of [
      'https://job-boards.greenhouse.io/embed/job_app?for=haizelabs&for=other-tenant&token=4685944008',
      'https://job-boards.greenhouse.io/embed/job_app?for=haizelabs&token=4685944008&token=other-job',
      'https://job-boards.greenhouse.io/embed/job_app?for=haize.labs&token=4685944008',
      'https://job-boards.greenhouse.io/embed/job_app?for=haizelabs&token=not-numeric',
    ]) {
      let calls = 0;
      const result = await observeManagedReceiptOnce({
        initial: { ...unknown, url },
        nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
        observe: async () => { calls += 1; throw new Error('must not run'); },
      });
      assert.equal(calls, 0, url);
      assert.equal(result.attempted, false);
    }
  });

  test('stale, missing, or unoffered capabilities are never called', async () => {
    for (const initial of [
      { ...unknown, continuationExpiresAt: '2026-08-11T11:59:59.000Z' },
      { ...unknown, continuationToken: undefined },
      { ...unknown, continuationOffered: false },
      { ...unknown, humanVerification: { kind: 'security_code', fieldCount: 8, sentTo: null } },
      { ...unknown, url: 'https://careers.example.test/application' },
    ]) {
      let calls = 0;
      const result = await observeManagedReceiptOnce({
        initial,
        nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
        observe: async () => { calls += 1; throw new Error('must not run'); },
      });
      assert.equal(calls, 0);
      assert.equal(result.attempted, false);
      assert.equal(managedSubmitVerdict(result.receiptResult).kind, 'unverified');
    }
  });

  test('a reused one-shot token fails closed on its second claim', async () => {
    let used = false;
    const observed = atsResult({
      url: 'https://jobs.ashbyhq.com/kos/software-engineer-intern/application',
      submitOutcome: {
        pressed: true,
        state: 'confirmed',
        source: 'ats_state',
        evidence: '.ashby-application-form-success-container',
        message: 'Success. Thank you for submitting your application.',
        formStillPresent: false,
      },
    });
    const service = async () => {
      if (used) throw new Error('continuation rejected');
      used = true;
      return observed;
    };
    const first = await observeManagedReceiptOnce({ initial: unknown, nowMs: Date.parse('2026-08-11T12:00:05.000Z'), observe: service });
    const second = await observeManagedReceiptOnce({ initial: unknown, nowMs: Date.parse('2026-08-11T12:00:05.000Z'), observe: service });
    assert.equal(managedSubmitVerdict(first.receiptResult).kind, 'confirmed');
    assert.equal(managedSubmitVerdict(second.receiptResult).kind, 'unverified');
    assert.match(String(second.error), /rejected/);
  });
});

describe('the sentence for an unknown outcome leads somewhere', () => {
  const reason = unverifiedSubmissionReason({
    atsName: 'ashby',
    portalUrl: 'https://jobs.ashbyhq.com/skydio/1ec2fe3c/application',
    cause: 'run_timed_out',
  });

  test('it names the page, and what a sent application looks like on it', () => {
    assert.match(reason, /jobs\.ashbyhq\.com\/skydio\/1ec2fe3c\/application/);
    // "Check the portal" is not an instruction. This is.
    assert.match(reason, /green panel headed "Success"/);
  });

  test('it does not invite the retry the system then refuses', () => {
    // The exact wording of the sentence packet 13bccb2d carried. A needs_attention packet that has
    // been claimed cannot be re-run, so this told her to do something that would 409.
    assert.doesNotMatch(reason, /before trying again/i);
    assert.match(reason, /tell Litos which you found/i);
  });

  test('it says not to apply by hand in the meantime, and why', () => {
    assert.match(reason, /two applications to the same posting count against you/i);
  });

  test('it classifies as its own thing, not as a breakage to retry', () => {
    assert.deepEqual(attentionCategoriesForReasons([reason]), ['unverified_submission']);
  });

  test('a board whose confirmation state has not been read gets no invented description', () => {
    const generic = unverifiedSubmissionReason({ atsName: 'workable', cause: 'no_confirmation_state' });
    assert.doesNotMatch(generic, /green panel/);
    assert.match(generic, /usually replaces the form with a short confirmation/);
  });
});

describe('the state has a way out of it', () => {
  test('a claimed needs_attention packet is still refused while nobody has looked', () => {
    // Unchanged, and it must stay unchanged: the employer may already hold this application.
    assert.equal(submitRequestDisposition('needs_attention', true), 'reject');
    assert.equal(submitRequestDisposition('needs_attention', true, undefined), 'reject');
  });

  test('her own "I looked and it is not there" is what unlocks it', () => {
    assert.equal(submitRequestDisposition('needs_attention', true, 'not_sent'), 'start');
  });

  test('"I found it" does not unlock a re-run, because there is nothing left to send', () => {
    assert.equal(submitRequestDisposition('needs_attention', true, 'sent'), 'reject');
  });

  test('the key opens nothing else', () => {
    // A resolution recorded on a packet in some other state must not become a general override.
    assert.equal(submitRequestDisposition('awaiting_security_code', true, 'not_sent'), 'reject');
    assert.equal(submitRequestDisposition('submitted', true, 'not_sent'), 'submitted');
  });
});

describe('the duplicate guard can see a submit it is not sure about', () => {
  const posting = 'https://jobs.ashbyhq.com/skydio/1ec2fe3c-3fb2-4485-870d-764a3e5f5baf/application';
  const context = { company: 'Skydio', role: 'Product Management Intern' };
  const twin = (over: Partial<SubmittedTwinRow> = {}): SubmittedTwinRow => ({
    id: '13bccb2d-d726-4c47-80bc-e8090ae1463e',
    job_context: context,
    portal_url: posting,
    submitted_at: null,
    unverified_at: '2026-08-09T12:25:49.894Z',
    ...over,
  });

  test('a second application to a posting with an unresolved submit is refused', () => {
    // Before this the guard selected only submitted rows, so this row did not exist as far as it was
    // concerned and the second application went straight to the employer.
    const verdict = duplicateAmong(context, posting, [twin()]);
    assert.equal(verdict.kind, 'duplicate');
    if (verdict.kind !== 'duplicate') return;
    assert.equal(verdict.match.certainty, 'unverified');
  });

  test('and the refusal does not claim she has already applied, because nobody knows that', () => {
    const verdict = duplicateAmong(context, posting, [twin()]);
    if (verdict.kind !== 'duplicate') return;
    assert.doesNotMatch(verdict.reason, /you have already applied/i);
    assert.match(verdict.reason, /could not confirm what came back/i);
    // And it points at the one action that unblocks both packets.
    assert.match(verdict.reason, /tell Litos whether it is there/i);
    assert.deepEqual(attentionCategoriesForReasons([verdict.reason]), ['unverified_submission']);
  });

  test('a twin she has already checked and found missing stops being a reason to refuse', async () => {
    /* This one is enforced by the QUERY, not by the decision, and deliberately so. Once she has
       answered 'not_sent' the employer provably does not have that application, so the row is no
       longer any kind of twin and must not reach duplicateAmong at all. Asserting it at the
       decision level instead would be wrong in the other direction: a row with no submitted_at and
       no unverified record is a pipeline_stage 'applied' row, which IS a duplicate. */
    const source = await readFile('src/lib/duplicateApplication.ts', 'utf8');
    assert.match(source, /unverified_submission'->>'resolution' is null/);
    assert.match(source, /or \(\$\{generated_resumes\.spec\}->'_review'->'unverified_submission' is not null/);
  });

  test('a row that is merely marked applied is still a duplicate, and a certain one', () => {
    // No submitted_at, no unverified record: the pipeline_stage arm. It must keep its old sentence.
    const verdict = duplicateAmong(context, posting, [twin({ unverified_at: null })]);
    assert.equal(verdict.kind, 'duplicate');
    if (verdict.kind !== 'duplicate') return;
    assert.equal(verdict.match.certainty, 'submitted');
  });

  test('a real receipt still gets the certain sentence', () => {
    const verdict = duplicateAmong(context, posting, [twin({ submitted_at: '2026-08-06T08:48:16.764Z' })]);
    if (verdict.kind !== 'duplicate') return;
    assert.equal(verdict.match.certainty, 'submitted');
    assert.match(verdict.reason, /you have already applied/i);
    assert.deepEqual(attentionCategoriesForReasons([verdict.reason]), ['duplicate_application']);
  });
});

/** A packet mid-send: status 'submitting' with the claim its run took at the top. */
function claimedRunningRow(): import('./applicationReview').ApplicationReviewState {
  return {
    jd_text: 'jd',
    status: 'submitting',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: '2026-08-11T12:00:00.000Z',
    portal_url: 'https://jobs.ashbyhq.com/kos/job/application',
    submission_run_id: 'run-1',
    submission_claimed_at: '2026-08-11T12:00:00.000Z',
    submission_claim_id: 'claim-1',
    submission_authorization: { source: 'standing_consent', authorized_at: '2026-08-11T11:59:00.000Z' },
  };
}

describe('the send path is wired to the reading, not to the scrape', () => {
  test('the verdict is consulted before any receipt is parsed', async () => {
    const source = await readFile('src/routes/submissionRunner.ts', 'utf8');
    const verdict = source.indexOf('const verdict = managedSubmitVerdict(receiptResult);');
    const scrape = source.indexOf('readManagedReceipt(receiptResult)', verdict);
    assert.ok(verdict > 0, 'the managed send path must ask the run what it saw');
    assert.ok(scrape > verdict, 'the body scrape is enrichment now, not the proof');
  });

  /* THESE TWO WERE SOURCE GREPS UNTIL THE DECISION THEY WATCH WAS EXTRACTED FROM fail().
   *
   * They matched regexes against routes/submissionRunner.ts, which cannot tell a correct branch from
   * a deleted one and cannot see a branch that is present and wrong - and the second of them passed
   * for the whole life of the defect it was supposedly guarding, because `if (noSubmitControl)` was
   * right there in the text while the predicate feeding it rejected the format the message is
   * actually stored in. Now that submissionFailureReview is a pure exported function, both ask the
   * real thing with a real error instance. */

  test('a run cut off mid-submit records the fact, not just a sentence about it', async () => {
    const { submissionFailureReview } = await import('../routes/submissionRunner');
    // submission_attempted_at and the structured record are what make the state resolvable. Packet
    // 13bccb2d had neither, so nothing downstream could tell that a click had happened at all.
    const persisted = submissionFailureReview(
      claimedRunningRow(),
      new Error('Managed browser run timed out before it produced a result'),
    );
    assert.equal(persisted.status, 'needs_attention');
    assert.equal(typeof persisted.submission_attempted_at, 'string');
    assert.equal(persisted.unverified_submission?.cause, 'run_timed_out');
    assert.equal(persisted.submission_stop?.reason, 'run_timed_out');
    assert.equal(persisted.submission_stop?.before_click, false,
      'a run that died without reporting cannot prove where it stopped');
  });

  test('a typed managed chooser stop uses the no-submit copy and releases the stale claim', async () => {
    const { submissionFailureReview } = await import('../routes/submissionRunner');
    const { assertManagedApplicationFinalSubmitSelected, NoSubmitControlError } = await import('./portalSubmission');
    let stopped: unknown;
    try {
      assertManagedApplicationFinalSubmitSelected(
        chooserResult() as Parameters<typeof assertManagedApplicationFinalSubmitSelected>[0],
        CHOOSER_URL,
      );
    } catch (error) {
      stopped = error;
    }
    assert.ok(stopped instanceof NoSubmitControlError,
      'only the exact v4 no-click evidence reader may mint this release error');
    const persisted = submissionFailureReview(
      claimedRunningRow(),
      stopped,
    );
    assert.equal(persisted.submission_claimed_at, undefined);
    assert.equal(persisted.submission_stop?.reason, 'no_submit_control');
    assert.match(persisted.attention_reason!,
      /Litos could not find the button that sends this application, so nothing has been sent/);
  });

  /* THE 2026-08-11 PRODUCTION RUN, END TO END THROUGH THE REAL PAIR OF FUNCTIONS.
   *
   * The kos.ai send returned a complete result whose runner had pressed Submit, and the reporting
   * barrier rejected the proof's shape (the runner's submit-scope repair had added `scopeKind`,
   * unknown to the key-set check). Because that rejection was thrown as a NoSubmitControlError
   * subclass, the row released its claim, erased the attempt residue, and read "Litos could not
   * find the button that sends this application, so nothing has been sent" - a false no-send for
   * an application the employer may be holding. The error below is the REAL one out of the real
   * assertion, not a reconstruction, because a reconstruction is how this fixture family has
   * repeatedly proved the wrong thing. */
  test('a proof the barrier cannot read keeps the claim, states uncertainty, and opens the unverified exit', async () => {
    const { submissionFailureReview } = await import('../routes/submissionRunner');
    const { assertManagedRequiredFieldsConfirmed } = await import('./portalSubmission');
    let thrown: unknown;
    try {
      assertManagedRequiredFieldsConfirmed({
        requiredFieldConfirmation: {
          version: 2,
          status: 'confirmed',
          passes: [{
            submitKind: 'application',
            scope: {
              scopeKind: 'container',
              anUnknownFutureKey: true,
              formFingerprint: 'form_fingerprint_fixture_1234',
              submitFingerprint: 'submit_fingerprint_fixture_1234',
              formMatchCount: 1,
              submitMatchCount: 1,
              requiredControlCount: 0,
              sameNode: true,
            },
            requiredControls: [],
            attempts: [],
            retries: 0,
            unresolved: [],
            submissionOutcome: 'clicked',
          }],
        },
      }, 'application');
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error, 'the malformed proof must still be refused');
    const persisted = submissionFailureReview(claimedRunningRow(), thrown);
    assert.equal(persisted.status, 'needs_attention');
    assert.equal(persisted.submission_stop?.reason, 'confirmation_unproven');
    assert.equal(persisted.submission_stop?.before_click, false,
      'a rejection thrown after the remote run finished cannot prove where the run stopped');
    assert.notEqual(persisted.submission_claimed_at, undefined,
      'the claim is the duplicate guard, and an unknown click state must keep it');
    assert.doesNotMatch(persisted.attention_reason!, /nothing has been sent/,
      'the exact false sentence the kos.ai row carried');
    assert.match(persisted.attention_reason!, /does not know whether this application went through/);
    assert.match(persisted.attention_reason!, /Do not submit it by hand in the meantime/,
      'the duplicate warning is the half that protects the employer side');
    assert.equal(typeof persisted.submission_attempted_at, 'string');
    assert.equal(persisted.unverified_submission?.cause, 'no_confirmation_state');
  });

  test('the resolution route exists and is the thing the refusal points at', async () => {
    const route = await readFile('src/routes/applications.ts', 'utf8');
    assert.match(route, /'\/applications\/:id\/submission\/unverified'/);
    assert.match(route, /SUBMISSION_OUTCOME_UNVERIFIED/);
    // The refusal names the endpoint, so the message and the door cannot drift apart.
    assert.match(route, /POST \/applications\/:id\/submission\/unverified/);
  });
});

/* THE TWO ARMS ADVERSARIAL REVIEW FOUND MISSING, both of which had already been described in prose.
 *
 * The module docstring said not_attempted was "a distinct and much better answer than unverified",
 * and there was no branch for it. And the confirmed arm accepted an empty message through a `??`
 * that only catches null, so a runner reporting a container with nothing in it produced a filed
 * application. */
describe('what the verdict refuses to call a submission', () => {
  test('a run that never pressed Send is not an uncertain submission, it is a non-submission', () => {
    const verdict = managedSubmitVerdict({
      submitOutcome: {
        pressed: false, state: 'not_attempted', source: null, evidence: null,
        message: null, formStillPresent: true,
      },
    });
    // 'unverified' here would tell her Litos pressed Send, send her looking for a receipt that
    // cannot exist, and leave a record that blocks every later application to the same posting.
    assert.equal(verdict.kind, 'not_attempted');
  });

  test('pressed:false outranks a state the runner failed to set', () => {
    // Defence against a runner that reports an unrecognised state; the normalizer maps it to
    // 'unknown', and without this the caller would treat a click that never happened as uncertain.
    const verdict = managedSubmitVerdict({
      submitOutcome: {
        pressed: false, state: 'unknown', source: null, evidence: null,
        message: null, formStillPresent: true,
      },
    });
    assert.equal(verdict.kind, 'not_attempted');
  });

  test('a confirmation with nothing written in it is not a confirmation', () => {
    for (const message of [null, '', '   ']) {
      const verdict = managedSubmitVerdict({
        submitOutcome: {
          pressed: true, state: 'confirmed', source: 'ats_state',
          evidence: '.ashby-application-form-success-container',
          message, formStillPresent: true,
        },
      });
      assert.equal(verdict.kind, 'unverified', `an empty container (${JSON.stringify(message)}) must not read as sent`);
    }
  });

  test('the real confirmation still passes, so the guard has not swallowed the happy path', () => {
    assert.equal(managedSubmitVerdict(ASHBY_CONFIRMED).kind, 'confirmed');
  });
});

/* THE PRESS-WINDOW NETWORK RECORD, measured need on the live Easy Dynamics Rippling form
 * (2026-08-20, twice): Send pressed, the page said nothing either way, and nothing recorded what
 * the submit request returned. The parse is defensive because the record crosses the wire from a
 * runner on a different deploy cadence. */
describe('the submit network record', () => {
  test('valid entries are kept, with the query string stripped again on this side', () => {
    const outcome = readManagedSubmitOutcome({
      submitOutcome: {
        pressed: true, state: 'unknown', source: null, evidence: null, message: null,
        formStillPresent: true,
        network: [
          { method: 'POST', url: 'https://ats.rippling.com/api/apply?token=SECRET', status: 422 },
          { method: 'POST', url: 'https://ats.rippling.com/api/apply', status: null, failure: 'net::ERR_ABORTED' },
        ],
      },
    });
    assert.deepEqual(outcome?.network, [
      { method: 'POST', url: 'https://ats.rippling.com/api/apply', status: 422 },
      { method: 'POST', url: 'https://ats.rippling.com/api/apply', status: null, failure: 'net::ERR_ABORTED' },
    ]);
  });

  test('a malformed or absent record degrades to null, never to a throw', () => {
    const base = {
      pressed: true, state: 'unknown', source: null, evidence: null, message: null,
      formStillPresent: true,
    };
    assert.equal(readManagedSubmitOutcome({ submitOutcome: base })?.network, null);
    assert.equal(readManagedSubmitOutcome({ submitOutcome: { ...base, network: 'nope' } })?.network, null);
    assert.equal(readManagedSubmitOutcome({
      submitOutcome: { ...base, network: [{ method: 42, url: null }, 'junk', null] },
    })?.network, null);
  });

  test('the record is bounded at twenty entries on this side too', () => {
    const outcome = readManagedSubmitOutcome({
      submitOutcome: {
        pressed: true, state: 'unknown', source: null, evidence: null, message: null,
        formStillPresent: true,
        network: Array.from({ length: 30 }, (_, i) => ({ method: 'POST', url: 'https://x.test/' + i, status: 200 })),
      },
    });
    assert.equal(outcome?.network?.length, 20);
  });
});

/* THE PRESS THAT TALKED ONLY TO A CHALLENGE SERVER. The network record below is the measured one:
 * run 858a4f98 on the live Easy Dynamics Rippling form, 2026-08-20 - two challenge POSTs, two
 * analytics POSTs, and not one request to any rippling.com host. */
describe('the human-verification press sentence', () => {
  const PORTAL = 'https://ats.rippling.com/easy-dynamics-corporation/jobs/0eb836b2';
  const MEASURED = [
    { method: 'POST', url: 'https://browser-intake-datadoghq.com/api/v2/rum', status: 202 },
    { method: 'POST', url: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/fo/x', status: 200 },
    { method: 'POST', url: 'https://telemetry.transcend.io/collect', status: 204 },
  ];

  test('the measured Rippling record chooses the human-verification sentence', () => {
    assert.equal(pressReachedOnlyChallengePlatform(MEASURED, PORTAL), true);
    const reason = unverifiedSubmissionReason({
      atsName: 'rippling', portalUrl: PORTAL, cause: 'no_confirmation_state', network: MEASURED,
    });
    assert.match(reason, /human-verification check instead of submitting/);
    assert.match(reason, /Choose “It is not there”/);
    assert.match(reason, /stay in this dashboard/);
    assert.doesNotMatch(reason, /Open https:\/\//);
    assert.doesNotMatch(reason, /Litos will send this one for you/);
  });

  test('one request to the employer withdraws the claim, whatever else was spoken to', () => {
    const reached = [...MEASURED,
      { method: 'POST', url: 'https://api.rippling.com/ats/apply', status: 500 }];
    assert.equal(pressReachedOnlyChallengePlatform(reached, PORTAL), false);
    const reason = unverifiedSubmissionReason({
      atsName: 'rippling', portalUrl: PORTAL, cause: 'no_confirmation_state', network: reached,
    });
    assert.doesNotMatch(reason, /human-verification check/);
    assert.match(reason, /Litos will send this one for you/);
  });

  test('no challenge platform means the ordinary sentence, and so does no record at all', () => {
    const analyticsOnly = [MEASURED[0], MEASURED[2]];
    assert.equal(pressReachedOnlyChallengePlatform(analyticsOnly, PORTAL), false);
    assert.equal(pressReachedOnlyChallengePlatform(null, PORTAL), false);
    assert.equal(pressReachedOnlyChallengePlatform(MEASURED, undefined), false);
    assert.doesNotMatch(
      unverifiedSubmissionReason({ atsName: 'rippling', portalUrl: PORTAL, cause: 'no_confirmation_state' }),
      /human-verification check/,
    );
  });

  test('the sentence never fires for a cut-off run, where the press may well have reached the employer', () => {
    assert.doesNotMatch(
      unverifiedSubmissionReason({ atsName: 'rippling', portalUrl: PORTAL, cause: 'run_timed_out', network: MEASURED }),
      /human-verification check/,
    );
  });
});

/* THE CHALLENGE THE RUNNER SAW, measured on the live Mytos Lever form (run 6757f19a, 2026-08-20):
 * the press fetched an hCaptcha drag puzzle, the receipt shows it standing over the fully filled
 * form, and the press window also carried an ordinary POST to jobs.lever.co (Lever re-parses the
 * resume at submit) - so the requests-only predicate rightly withdrew and the applicant was
 * promised a re-send that would hit the same wall. */
describe('the challenge-on-screen sentence', () => {
  const LEVER_PORTAL = 'https://jobs.lever.co/mytos/bbb558c0';
  const LEVER_PRESS = [
    { method: 'POST', url: 'https://api.hcaptcha.com/getcaptcha/e33f87f8', status: 200 },
    { method: 'POST', url: 'https://jobs.lever.co/parseResume', status: 200 },
  ];

  test('a standing challenge selects the human-check sentence even when the employer host was spoken to', () => {
    assert.equal(pressReachedOnlyChallengePlatform(LEVER_PRESS, LEVER_PORTAL), false);
    const reason = unverifiedSubmissionReason({
      atsName: 'lever', portalUrl: LEVER_PORTAL, cause: 'no_confirmation_state',
      network: LEVER_PRESS, challengeOnScreen: true,
    });
    assert.match(reason, /put up a human-verification challenge/);
    assert.match(reason, /Choose “It is not there”/);
    assert.match(reason, /stay in this dashboard/);
    assert.doesNotMatch(reason, /Open https:\/\//);
    assert.doesNotMatch(reason, /Litos will send this one for you/);
  });

  test('without the runner sighting, the same press keeps the ordinary sentence', () => {
    const reason = unverifiedSubmissionReason({
      atsName: 'lever', portalUrl: LEVER_PORTAL, cause: 'no_confirmation_state', network: LEVER_PRESS,
    });
    assert.doesNotMatch(reason, /human-verification/);
    assert.match(reason, /Litos will send this one for you/);
  });

  test('a sighting on a cut-off run never claims the press ran into a check', () => {
    assert.doesNotMatch(
      unverifiedSubmissionReason({ atsName: 'lever', portalUrl: LEVER_PORTAL, cause: 'run_timed_out', challengeOnScreen: true }),
      /human-verification/,
    );
  });
});

/* THE CLIENT-VALIDATION REFUSAL, measured on the live transparent-hiring.breezy.hr form
 * (run 549604ee, 2026-08-20): 'Your application contains errors' under the pressed button, zero
 * requests to any breezy host in the press window, the form still standing. */
describe('the client-validation refusal', () => {
  const base = { pressed: true, state: 'rejected', evidence: 'validation_message' };

  test('a validation sentence over the LIVE form is a proven refusal', () => {
    const verdict = managedSubmitVerdict({ submitOutcome: {
      ...base, source: 'client_validation',
      message: 'Your application contains errors (1 required response still missing on the form)',
      formStillPresent: true,
    } });
    assert.deepEqual(verdict, {
      kind: 'refused',
      message: 'Your application contains errors (1 required response still missing on the form)',
    });
  });

  test('the same sentence with the form GONE is unverified, like any unproven refusal', () => {
    const verdict = managedSubmitVerdict({ submitOutcome: {
      ...base, source: 'client_validation', message: 'Your application contains errors', formStillPresent: false,
    } });
    assert.deepEqual(verdict, { kind: 'unverified', cause: 'no_confirmation_state' });
  });

  test('the general rule is untouched: an ATS panel over a live form still cannot prove a refusal', () => {
    const verdict = managedSubmitVerdict({ submitOutcome: {
      ...base, source: 'ats_state', message: 'Something went wrong', formStillPresent: true,
    } });
    assert.deepEqual(verdict, { kind: 'unverified', cause: 'no_confirmation_state' });
  });
});
