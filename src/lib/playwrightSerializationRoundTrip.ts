/* Reproduces exactly what Playwright's elementHandle.evaluate()/page.evaluate() do internally:
 * serialise a function with Function.prototype.toString() and re-parse that source INSIDE the
 * browser page, rather than calling the original function object in-process. A test that only
 * calls a function directly proves its logic, never its serialisability - and a bundler transform
 * (esbuild's `keepNames` wrapping a named inner binding in a `__name(...)` call that only exists in
 * the bundle's own module scope) breaks exactly the reparse step this reproduces, not the direct
 * call. Two call sites (COMMIT_REQUIRED_CONTROLS_FOR_SUBMIT, READ_CONTROL_LABEL) had this pattern
 * copy-pasted before it was extracted here; a third likely candidate is READ_SUBMIT_READINESS_SCRIPT.
 *
 * ONLY VALID EVIDENCE OF A REPARSED FUNCTION BEHAVING CORRECTLY, NEVER EVIDENCE THE MANGLING
 * TRANSFORM RAN AT ALL. A test that calls this and asserts on the reparsed function's return value
 * would keep passing even if the test runner stopped applying esbuild's keepNames-equivalent
 * transform entirely - `new Function` on an UNMANGLED toString() never throws either. Pair any use
 * of this with, or rely on, a canary test (see keepNamesTransformIsActiveInThisTestRun below) that
 * actually proves the transform is live in this test run, not just assumed from a comment. */
// eslint-disable-next-line no-new-func -- reproducing exactly what Playwright's elementHandle.evaluate() does internally
export function reparseThroughPlaywrightSerialization<T extends (...args: never[]) => unknown>(fn: T): T {
  return new Function('return (' + fn.toString() + ');')() as T;
}

/* THE CANARY. Every reparse tripwire test's whole premise - that a mangled function will throw
 * `ReferenceError: __name is not defined` when reparsed - rests on this test runner's `tsx`
 * invocation actually applying an esbuild keepNames-equivalent transform at test time. Nothing
 * asserted that fact anywhere; it was verified once, by hand, out of band, and left in a comment.
 * This function defines a throwaway function WITH a named inner binding (the exact shape that
 * triggers the mangling) and reparses it through the same path, asserting the mangled failure
 * mode actually occurs. If this ever stops throwing, every other reparse tripwire test in this
 * codebase has silently stopped testing what it claims to test, and this is the one that says so. */
export function keepNamesTransformIsActiveInThisTestRun(): boolean {
  const canary = (x: number) => {
    const helper = (y: number) => y + 1;
    return helper(x);
  };
  try {
    reparseThroughPlaywrightSerialization(canary)(1);
    return false;
  } catch (error) {
    return error instanceof ReferenceError && /__name/.test((error as Error).message);
  }
}
