import assert from 'node:assert/strict';
import test from 'node:test';
import { privateRunnerStepDiagnostic } from './submissionRunner';

test('runner diagnostics redact contact data and opaque tokens', () => {
  const diagnostic = privateRunnerStepDiagnostic(Object.assign(
    new TypeError('Failed for mehek@example.com at https://apply.example/job?token=secret with +1 (213) 574-6270 and abcdefghijklmnopqrstuvwxyz012345'),
    { code: 'PACKET_DRIFT' },
  ));

  assert.deepEqual(diagnostic, {
    errorName: 'TypeError',
    errorCode: 'PACKET_DRIFT',
    errorMessage: 'Failed for [email] at [url] with [phone] and [token]',
    errorFingerprint: diagnostic.errorFingerprint,
  });
  assert.match(diagnostic.errorFingerprint, /^[a-f0-9]{16}$/);
});

test('runner diagnostics omit untrusted names and codes', () => {
  const diagnostic = privateRunnerStepDiagnostic({
    name: 'not a valid name',
    code: 'not-safe',
    message: 'ordinary failure',
  });

  assert.equal(diagnostic.errorName, 'Error');
  assert.equal(diagnostic.errorCode, undefined);
  assert.equal(diagnostic.errorMessage, 'ordinary failure');
});
