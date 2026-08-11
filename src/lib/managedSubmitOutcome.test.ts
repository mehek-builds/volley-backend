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
  readManagedSubmitOutcome,
  unverifiedSubmissionReason,
} from './managedSubmitOutcome';
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
        formStillPresent: true,
      },
    });
    assert.equal(verdict.kind, 'refused');
    if (verdict.kind !== 'refused') return;
    assert.match(verdict.message, /couldn’t submit/i);
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
        formStillPresent: true,
      },
    });
    const refusedResult = await observeManagedReceiptOnce({
      initial: unknown,
      nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
      observe: async () => refused,
    });
    assert.equal(managedSubmitVerdict(refusedResult.receiptResult).kind, 'refused');

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

describe('the send path is wired to the reading, not to the scrape', () => {
  test('the verdict is consulted before any receipt is parsed', async () => {
    const source = await readFile('src/routes/submissionRunner.ts', 'utf8');
    const verdict = source.indexOf('const verdict = managedSubmitVerdict(receiptResult);');
    const scrape = source.indexOf('readManagedReceipt(receiptResult)', verdict);
    assert.ok(verdict > 0, 'the managed send path must ask the run what it saw');
    assert.ok(scrape > verdict, 'the body scrape is enrichment now, not the proof');
  });

  test('a run cut off mid-submit records the fact, not just a sentence about it', async () => {
    const source = await readFile('src/routes/submissionRunner.ts', 'utf8');
    // submission_attempted_at and the structured record are what make the state resolvable. Packet
    // 13bccb2d had neither, so nothing downstream could tell that a click had happened at all.
    assert.match(source, /if \(uncertainAfterClaim && isManagedRunTimeout\(message\)\)/);
    assert.match(source, /submission_attempted_at: input\.at/);
    assert.match(source, /unverified_submission: \{/);
  });

  test('a managed chooser stop uses the no-submit copy and releases the stale claim', async () => {
    const source = await readFile('src/routes/submissionRunner.ts', 'utf8');
    const failStart = source.indexOf('async function fail(');
    const failEnd = source.indexOf('export type SecurityCodeSubmissionOutcome', failStart);
    const failure = source.slice(failStart, failEnd);
    assert.match(failure, /error instanceof NoSubmitControlError \|\| isManagedNoSubmitControl\(message\)/);
    assert.match(failure, /if \(noSubmitControl\) \{[\s\S]*preClickNoSubmitReview\(current, message\)[\s\S]*return;/);
    assert.match(source, /Litos could not find the button that sends this application, so nothing has been sent/);
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
