import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/* THE PRODUCTION BUILD IS NOT THE TYPECHECK, and the gap between them shipped main red for three
 * consecutive merges.
 *
 * This backend sets `lib: ["ES2022"]` with no "dom" on purpose (see the note above
 * DISCOVER_QUESTIONS_SCRIPT in questionDiscovery.ts: page scripts are carried as source strings
 * precisely so the project never has to pull the DOM lib in project-wide). So HTMLElement,
 * SVGElement and the rest are not in scope, and naming one in a type position is a compile error.
 *
 * It does not present as one locally. `tsc -p tsconfig.json` compiles `src` INCLUDING the test
 * files, and several of those import playwright-core and @xmldom/xmldom, whose declarations put the
 * DOM globals into global scope for the whole program. tsconfig.build.json excludes test files, the
 * ambient declarations leave with them, and the identical source stops compiling:
 *
 *     npx tsc --noEmit -p tsconfig.json    passes
 *     npm run build                        fails
 *
 * Measured: fba1805 added `as (element: SVGElement | HTMLElement) => string[]` to
 * portalSubmission.ts. Typecheck was green, the build was not, every Vercel deploy failed, and the
 * `test` CI job reported failure without running a single test - build:smoke runs first, and its
 * failure SKIPS the Test step. So the break also hid the test results, which is why it survived
 * three merges rather than one.
 *
 * 034acbb fixed that instance with the PlaywrightEvaluationTarget alias. This test is not that fix
 * and does not duplicate it; it is the thing that was missing around it. The alias stops one line
 * from naming a DOM global, and nothing stops the next line, in any file, from doing it again with
 * the same three-merge delay before anyone notices.
 *
 * Asserted by running the real compiler against the real production config, not by grepping for
 * type names. The first version of this test was a grep, and it was wrong twice: it flagged prose
 * inside block comments, and once that was fixed its string-literal stripping mis-paired a quote
 * inside a regex literal and blanked the very line it was meant to catch. A heuristic that silently
 * stops matching is worse than no guard at all here, since the thing it guards is already invisible.
 * The compiler has no false negatives, and 30 seconds is cheap against a red main nobody can see.
 */

test('the production build config compiles, not just the typecheck config', () => {
  let failure = '';
  try {
    execFileSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.build.json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    });
  } catch (error) {
    // tsc writes diagnostics to stdout, not stderr.
    const shaped = error as { stdout?: string; stderr?: string; message?: string };
    failure = (shaped.stdout || shaped.stderr || shaped.message || 'tsc failed with no output').trim();
  }
  assert.equal(
    failure,
    '',
    'npm run build would fail on this tree even though tsc -p tsconfig.json passes. The usual cause '
    + 'is a DOM global (HTMLElement, SVGElement, Document...) named in non-test source: the test '
    + `files pull those into scope, the production build excludes them.\n\n${failure}`,
  );
});

test('the DOM globals really are absent from this project\'s lib', () => {
  /* The test above is only worth its 30 seconds while this premise holds. If someone adds "dom" to
     the lib array, the two configs stop disagreeing about DOM globals, and the right response is to
     revisit both tests rather than work around them. Pinning the premise here means that
     conversation happens at the tsconfig, which is where the decision actually lives. */
  const config = JSON.parse(readFileSync('tsconfig.json', 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  assert.deepEqual(config.compilerOptions.lib, ['ES2022']);
  // And the production config is still the one that excludes the test files, which is the entire
  // mechanism by which it can disagree with the typecheck.
  const build = JSON.parse(readFileSync('tsconfig.build.json', 'utf8'));
  assert.ok(build.exclude.some((pattern: string) => pattern.includes('test')));
});
