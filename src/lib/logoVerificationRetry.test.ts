import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isTransientLogoVerificationReason,
  logoVerificationErrorReason,
  retryTransientLogoVerification,
} from './logoVerificationRetry';

test('classifies exact and composite provider pressure without retrying terminal proof failures', () => {
  assert.equal(isTransientLogoVerificationReason('http_429'), true);
  assert.equal(isTransientLogoVerificationReason('ats:logo_missing;homepage:http_503'), true);
  assert.equal(isTransientLogoVerificationReason('network_EAI_AGAIN'), true);
  assert.equal(isTransientLogoVerificationReason('http_404'), false);
  assert.equal(isTransientLogoVerificationReason('identity_mismatch'), false);
  assert.equal(isTransientLogoVerificationReason('ats:logo_missing;homepage:logo_missing'), false);
});

test('normalizes transport errors without exposing arbitrary messages', () => {
  assert.equal(logoVerificationErrorReason(new DOMException('timed out', 'TimeoutError')), 'timeout');
  assert.equal(
    logoVerificationErrorReason(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })),
    'network_ECONNRESET',
  );
  assert.equal(logoVerificationErrorReason(new Error('secret upstream detail')), 'verification_failed');
});

test('retries only bounded transient outcomes and preserves the final exact reason', async () => {
  const outcomes = [
    { verified: false as const, reason: 'ats:http_429' },
    { verified: false as const, reason: 'ats:http_503' },
    { verified: false as const, reason: 'ats:http_429' },
  ];
  const sleeps: number[] = [];
  const result = await retryTransientLogoVerification(async () => outcomes.shift()!, {
    delaysMs: [11, 22],
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  assert.deepEqual(result, { verified: false, reason: 'ats:http_429' });
  assert.deepEqual(sleeps, [11, 22]);

  let terminalAttempts = 0;
  const terminal = await retryTransientLogoVerification(async () => {
    terminalAttempts += 1;
    return { verified: false as const, reason: 'identity_mismatch' };
  }, { sleep: async () => undefined });
  assert.deepEqual(terminal, { verified: false, reason: 'identity_mismatch' });
  assert.equal(terminalAttempts, 1);
});
