import assert from 'node:assert/strict';
import test from 'node:test';
import { keepNamesTransformIsActiveInThisTestRun, reparseThroughPlaywrightSerialization } from './playwrightSerializationRoundTrip';

/* If this fails, every reparse tripwire test in this codebase (COMMIT_REQUIRED_CONTROLS_FOR_SUBMIT
 * in requiredFieldConfirmation.test.ts, READ_CONTROL_LABEL in portalSubmission.test.ts) has stopped
 * meaning anything: they would all keep passing whether or not the function they cover would
 * actually survive Playwright's real elementHandle.evaluate() path in production. This is the one
 * test in the suite that would tell you that happened. */
test('the reparse tripwire mechanism itself is live: a mangled function is caught, not silently missed', () => {
  assert.equal(
    keepNamesTransformIsActiveInThisTestRun(),
    true,
    'reparsing a function with a named inner binding must throw ReferenceError: __name is not defined - '
    + 'if it does not, this test runner has stopped applying the transform every reparse tripwire test '
    + 'in this codebase relies on, and none of them are protecting anything anymore',
  );
});

test('reparseThroughPlaywrightSerialization produces a function that behaves identically for an unmangled input', () => {
  const original = (a: number, b: number) => a + b;
  const reparsed = reparseThroughPlaywrightSerialization(original);
  assert.equal(reparsed(2, 3), 5);
});
