import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/**
 * THE SYSTEMIC GATE the code review on PR #640 flagged as missing.
 *
 * Two real production incidents (COMMIT_REQUIRED_CONTROLS_FOR_SUBMIT blocking every submission,
 * and the READ_CONTROL_LABEL audit that followed it) came from the same bug class: a function
 * handed to Playwright's `page.evaluate()`/`elementHandle.evaluate()` gets serialised with
 * `Function.prototype.toString()` and re-parsed INSIDE the browser page. A bundler's `keepNames`
 * transform can wrap a named binding declared inside that function's body in a `__name(...)` call
 * that only exists in the bundle's own module scope, throwing `ReferenceError: __name is not
 * defined` at runtime in the page - not in any test that calls the function directly in-process.
 *
 * Until now, protection against this was entirely PER-FUNCTION: a code comment, and for two
 * functions, a dedicated reparse tripwire test (playwrightSerializationRoundTrip.ts). Nothing
 * stopped a THIRD evaluate target from being added tomorrow with neither. This test is that stop:
 * it scans the real source for every `.evaluate(<identifier>)` call site with a bare identifier
 * argument (a reference to a named function or script, not an inline anonymous callback - see
 * SCOPE below for why anonymous callbacks are out of scope), and requires every identifier it
 * finds to be either:
 *
 *   (a) IMMUNE BY CONSTRUCTION - its own declaration is `= String.raw` (passed to evaluate() as a
 *       source STRING, which Playwright evals directly with no toString()/re-parse step at all) or
 *       `= new Function(` (a real function object, but one whose body is a string literal, which a
 *       bundler cannot see into to rename anything inside it); or
 *   (b) EXPLICITLY SIGNED OFF in KNOWN_SAFE_PLAIN_EVALUATE_TARGETS below, meaning a human has
 *       confirmed - the same way the READ_CONTROL_LABEL audit did, with a real esbuild
 *       `--bundle --keep-names` test - that it currently has no inner named binding to mangle, AND
 *       added a reparseThroughPlaywrightSerialization tripwire test for it in the same PR.
 *
 * A new identifier that is neither fails this test by name, with the fix spelled out, rather than
 * by a future production incident.
 *
 * SCOPE. This only covers `.evaluate(<bareIdentifier>)` call shapes. It does NOT statically verify
 * inline anonymous callbacks (`.evaluate((el) => {...})`), which could themselves contain a named
 * inner binding (`const helper = () => ...`) and be just as vulnerable - auditing THOSE requires
 * reading each callback's body, which this repo's earlier audit did by hand for the small number
 * that exist today (all confirmed safe) but which this mechanical scan does not repeat. If a
 * future inline callback grows a named inner helper, this test will not catch it. Closing that gap
 * fully would need an AST-aware check (e.g. a real ESLint rule, which this repo does not currently
 * have any infrastructure for) rather than this line-based scan.
 */

const SRC_ROOT = join(__dirname, '..');

/** Identifiers this scan will find that are proven safe (see (b) above), and where the proof is. */
const KNOWN_SAFE_PLAIN_EVALUATE_TARGETS: Record<string, string> = {
  READ_CONTROL_LABEL:
    'src/lib/portalSubmission.test.ts: 3 reparseThroughPlaywrightSerialization tests, covering the '
    + 'happy path, the ancestor aria-hidden walk + aria-labelledby lookup, and the label-fallback '
    + 'chain tail (aria-label/title/alt). Confirmed via a real esbuild --bundle --keep-names test '
    + 'to have no inner named binding as of 2026-08-20.',
};

function listTsFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listTsFilesRecursive(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every `.evaluate(<bareIdentifier>` call site's identifier, across every non-test .ts file under
 *  src/. A bare identifier is a plain word immediately after the open paren, optionally followed
 *  by `,` (a second arg) or `)`; anything else (a `(`, `function`, an object, a spread) is an
 *  inline callback or something else this scan does not attempt to classify, and is skipped - see
 *  SCOPE above. */
function findPlainIdentifierEvaluateTargets(): Map<string, { file: string; line: number }[]> {
  const found = new Map<string, { file: string; line: number }[]>();
  const pattern = /\.evaluate\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*[,)]/g;
  for (const file of listTsFilesRecursive(SRC_ROOT)) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      // Skip comment lines (this codebase's block comments consistently continue with a leading
      // `*`, per its own style throughout portalSubmission.ts) - a prose mention of `.evaluate(`
      // inside a comment is not a real call site, and one such mention (portalSubmission.ts:1125,
      // explaining page.evaluate(string, elementHandle)) is exactly what first tripped this scan.
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      // eslint-disable-next-line no-cond-assign -- straightforward regex scan
      while ((match = pattern.exec(line)) !== null) {
        const name = match[1]!;
        // Playwright's own APIs and this scan's own helper are not evaluate TARGETS.
        if (name === 'evaluate') continue;
        const entry = found.get(name) ?? [];
        entry.push({ file: file.slice(SRC_ROOT.length + 1), line: i + 1 });
        found.set(name, entry);
      }
    }
  }
  return found;
}

/** Whether `name`'s own declaration proves it immune by construction: `= String.raw` (evaluated as
 *  a source string, never serialised as a function at all) or `= new Function(` (a real function,
 *  but one a bundler cannot rename anything inside, because its body lives in a string literal). */
function isImmuneByConstruction(name: string): boolean {
  const declPattern = new RegExp(
    `(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*(String\\.raw\`|new Function\\()`,
  );
  for (const file of listTsFilesRecursive(SRC_ROOT)) {
    if (declPattern.test(readFileSync(file, 'utf8'))) return true;
  }
  return false;
}

test('every plain-function Playwright evaluate() target is either immune by construction or has a signed-off tripwire test', () => {
  const targets = findPlainIdentifierEvaluateTargets();
  const unprotected: string[] = [];

  for (const [name, sites] of targets) {
    if (isImmuneByConstruction(name)) continue;
    if (name in KNOWN_SAFE_PLAIN_EVALUATE_TARGETS) continue;
    unprotected.push(
      `${name} (${sites.map((s) => `${s.file}:${s.line}`).join(', ')})`,
    );
  }

  assert.deepEqual(
    unprotected,
    [],
    'Found a Playwright .evaluate() target that is neither compiled from a String.raw script (immune '
    + 'to bundler name-mangling by construction) nor listed in KNOWN_SAFE_PLAIN_EVALUATE_TARGETS in '
    + 'this file. Before adding it there: (1) confirm whether it actually has an inner named binding '
    + '(a real esbuild --bundle --keep-names test against it, the way READ_CONTROL_LABEL was checked, '
    + 'not a guess), (2) if it does, or you are not sure, convert it to the String.raw + new Function '
    + 'pattern (see COMMIT_REQUIRED_CONTROLS_FOR_SUBMIT) rather than sign it off, (3) if it genuinely '
    + 'has none, add a reparseThroughPlaywrightSerialization tripwire test for it (see '
    + 'playwrightSerializationRoundTrip.ts) and only then add it to the list above with a comment '
    + 'pointing at that test.',
  );
});

/* This scan's own honesty check: if these known-safe identifiers stop matching either escape hatch
   (their declaration changes shape, or someone deletes the tripwire this list promises exists),
   the maintainer above throws for a reason nobody can see just by reading it. This one names it. */
test('KNOWN_SAFE_PLAIN_EVALUATE_TARGETS entries are still found by the scan (not stale)', () => {
  const targets = findPlainIdentifierEvaluateTargets();
  for (const name of Object.keys(KNOWN_SAFE_PLAIN_EVALUATE_TARGETS)) {
    assert.ok(
      targets.has(name),
      `${name} is listed in KNOWN_SAFE_PLAIN_EVALUATE_TARGETS but the scan found no .evaluate(${name}) `
      + 'call site anymore - remove the stale entry.',
    );
  }
});
