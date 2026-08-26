import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSubmissionCutover,
  submissionCutoverDecision,
  type SubmissionCutoverState,
} from './submissionCutover';

const APPLICATION_ID = '11111111-2222-4333-8444-555555555555';
const DRAIN: SubmissionCutoverState = { mode: 'drain', config_valid: true };
const FREEZE: SubmissionCutoverState = { mode: 'freeze', config_valid: true };
const OFF: SubmissionCutoverState = { mode: 'off', config_valid: true };

const DRAIN_APPLICATION_CASES: ReadonlyArray<readonly [string, string]> = [
  ['POST', 'packet-audit'],
  ['POST', 'packet-audit/acknowledge'],
  ['POST', 'submit-request'],
  ['POST', 'submission/approve'],
  ['POST', 'security-code'],
  ['POST', 'submission/extension-start'],
  ['POST', 'submission/manual-handoff'],
  ['GET', 'submission/extension-packet'],
  ['GET', 'submission'],
  ['GET', 'fill-data'],
  ['POST', 'fill'],
  ['GET', 'workday-account-identity'],
  ['POST', 'workday-verification-code'],
  ['POST', 'manual-submission-start'],
  ['POST', 'manual-submission-preflight'],
  ['POST', 'manual-submission-resolution'],
];

const DRAIN_CONCRETE_CASES: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/internal/autopilot-matcher'],
  ['POST', '/internal/autopilot-matcher'],
  ['GET', '/internal/application-submission-runner'],
  ['POST', '/internal/future-submission-worker'],
  ['POST', '/resume/generate'],
  ['GET', '/resume/history'],
  ['GET', '/resume/download?t=previously-minted'],
  ['GET', '/dashboard/bootstrap'],
  ...DRAIN_APPLICATION_CASES.map(
    ([method, suffix]) => [method, `/applications/${APPLICATION_ID}/${suffix}`] as const,
  ),
];

test('cutover mode accepts only the three exact literals and fails invalid nonempty values closed', () => {
  const cases: ReadonlyArray<readonly [string | undefined, SubmissionCutoverState]> = [
    [undefined, { mode: 'off', config_valid: true }],
    ['', { mode: 'off', config_valid: true }],
    ['off', { mode: 'off', config_valid: true }],
    ['drain', { mode: 'drain', config_valid: true }],
    ['freeze', { mode: 'freeze', config_valid: true }],
    ['OFF', { mode: 'freeze', config_valid: false }],
    [' drain ', { mode: 'freeze', config_valid: false }],
    ['unexpected-secret-value', { mode: 'freeze', config_valid: false }],
    [' ', { mode: 'freeze', config_valid: false }],
  ];

  for (const [raw, expected] of cases) {
    assert.deepEqual(resolveSubmissionCutover(raw), expected, `raw value ${JSON.stringify(raw)}`);
  }
});

test('drain blocks every concrete issuer and worker path', () => {
  for (const [method, path] of DRAIN_CONCRETE_CASES) {
    assert.deepEqual(
      submissionCutoverDecision(DRAIN, method, path),
      { code: 'SUBMISSION_CUTOVER_DRAINING', retry_after_seconds: 300 },
      `${method} ${path}`,
    );
  }
});

test('drain recognizes route-template paths, including prospective routes', () => {
  for (const [method, suffix] of DRAIN_APPLICATION_CASES) {
    const path = `/applications/:id/${suffix}`;
    assert.equal(
      submissionCutoverDecision(DRAIN, method, path)?.code,
      'SUBMISSION_CUTOVER_DRAINING',
      `${method} ${path}`,
    );
  }
});

test('drain normalizes query strings and trailing slashes and treats HEAD as GET', () => {
  const paths = [
    `/applications/${APPLICATION_ID}/submission/?source=dashboard`,
    `/applications/${APPLICATION_ID}/fill-data///?refresh=1#ignored`,
    '/internal/autopilot-matcher/?segment=1',
  ];
  for (const path of paths) {
    assert.equal(submissionCutoverDecision(DRAIN, 'GET', path)?.code, 'SUBMISSION_CUTOVER_DRAINING', path);
  }

  assert.equal(
    submissionCutoverDecision(DRAIN, 'HEAD', `/applications/${APPLICATION_ID}/submission`)?.code,
    'SUBMISSION_CUTOVER_DRAINING',
  );
  assert.equal(
    submissionCutoverDecision(DRAIN, 'HEAD', '/internal/application-submission-runner')?.code,
    'SUBMISSION_CUTOVER_DRAINING',
  );
});

test('drain leaves only exact application evidence sinks and safe list reads available', () => {
  const allowed: ReadonlyArray<readonly [string, string]> = [
    ['POST', `/applications/${APPLICATION_ID}/submission/extension-outcome`],
    ['POST', `/applications/${APPLICATION_ID}/submission/handoff-complete`],
    ['POST', `/applications/${APPLICATION_ID}/submission/self-submitted`],
    ['POST', `/applications/${APPLICATION_ID}/submission/unverified`],
    ['POST', `/applications/${APPLICATION_ID}/manual-submission-outcome`],
    ['POST', '/webhooks/application-email/inbound'],
    ['POST', '/autofill/event'],
    ['GET', '/applications'],
    ['GET', '/applications/board'],
    ['POST', '/profile'],
    ['GET', '/health'],
  ];

  for (const [method, path] of allowed) {
    assert.equal(submissionCutoverDecision(DRAIN, method, path), null, `${method} ${path}`);
  }
});

test('drain defaults new scoped routes to blocked and remains exact at namespace boundaries', () => {
  const blocked: ReadonlyArray<readonly [string, string]> = [
    ['GET', `/applications/${APPLICATION_ID}/future-capability`],
    ['POST', `/applications/${APPLICATION_ID}/future-issuer`],
    ['PATCH', `/applications/${APPLICATION_ID}/resume`],
    ['POST', '/applications'],
    ['POST', `/applications/${APPLICATION_ID}/submission/extension-packet`],
    ['GET', `/applications/${APPLICATION_ID}/submission/extension-outcome`],
    ['POST', '/resume/future-capability'],
    ['DELETE', '/internal/future-worker'],
  ];
  for (const [method, path] of blocked) {
    assert.equal(
      submissionCutoverDecision(DRAIN, method, path)?.code,
      'SUBMISSION_CUTOVER_DRAINING',
      `${method} ${path}`,
    );
  }

  const allowed: ReadonlyArray<readonly [string, string]> = [
    ['POST', `/applications-extra/${APPLICATION_ID}/submit-request`],
    ['POST', '/resume-extra/generate'],
    ['POST', '/internalized/application-submission-runner'],
    ['GET', '/dashboard/bootstrap-extra'],
  ];

  for (const [method, path] of allowed) {
    assert.equal(submissionCutoverDecision(DRAIN, method, path), null, `${method} ${path}`);
  }
});

test('freeze contains drain and blocks all application and resume mutations plus inbound evidence', () => {
  for (const [method, path] of DRAIN_CONCRETE_CASES) {
    assert.equal(
      submissionCutoverDecision(FREEZE, method, path)?.code,
      'SUBMISSION_CUTOVER_FROZEN',
      `${method} ${path}`,
    );
  }

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const path of [
      '/applications',
      `/applications/${APPLICATION_ID}/submission/extension-outcome`,
      '/resume',
      '/resume/base',
    ]) {
      assert.equal(
        submissionCutoverDecision(FREEZE, method, path)?.code,
        'SUBMISSION_CUTOVER_FROZEN',
        `${method} ${path}`,
      );
    }
  }

  assert.equal(
    submissionCutoverDecision(FREEZE, 'POST', '/webhooks/application-email/inbound')?.code,
    'SUBMISSION_CUTOVER_FROZEN',
  );
  assert.equal(
    submissionCutoverDecision(FREEZE, 'POST', '/autofill/event')?.code,
    'SUBMISSION_CUTOVER_FROZEN',
  );
});

test('freeze still permits reads that cannot issue submission capability and unrelated writes', () => {
  const allowed: ReadonlyArray<readonly [string, string]> = [
    ['GET', '/applications'],
    ['GET', '/applications/board'],
    ['POST', '/profile'],
    ['DELETE', '/account'],
    ['POST', '/application-email/inbound'],
    ['POST', '/applications-extra'],
    ['POST', '/resume-extra'],
  ];

  for (const [method, path] of allowed) {
    assert.equal(submissionCutoverDecision(FREEZE, method, path), null, `${method} ${path}`);
  }
});

test('OPTIONS is always allowed and off mode leaves every request untouched', () => {
  for (const [, path] of DRAIN_CONCRETE_CASES) {
    assert.equal(submissionCutoverDecision(DRAIN, 'OPTIONS', path), null, `drain OPTIONS ${path}`);
    assert.equal(submissionCutoverDecision(FREEZE, 'OPTIONS', path), null, `freeze OPTIONS ${path}`);
  }
  assert.equal(
    submissionCutoverDecision(FREEZE, 'OPTIONS', '/webhooks/application-email/inbound'),
    null,
  );
  assert.equal(submissionCutoverDecision(FREEZE, 'OPTIONS', '/autofill/event'), null);

  for (const [method, path] of DRAIN_CONCRETE_CASES) {
    assert.equal(submissionCutoverDecision(OFF, method, path), null, `off ${method} ${path}`);
  }
  assert.equal(
    submissionCutoverDecision(OFF, 'DELETE', `/applications/${APPLICATION_ID}`),
    null,
  );
});
