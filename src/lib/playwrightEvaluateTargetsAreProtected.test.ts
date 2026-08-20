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
 *   (b) EXPLICITLY SIGNED OFF in KNOWN_SAFE_PLAIN_EVALUATE_TARGETS below, keyed by `file:identifier`
 *       (not bare identifier - see WHY FILE-SCOPED below), meaning a human has confirmed - the same
 *       way the READ_CONTROL_LABEL audit did, with a real esbuild `--bundle --keep-names` test -
 *       that it currently has no inner named binding to mangle, AND added a
 *       reparseThroughPlaywrightSerialization tripwire test for it in the same PR.
 *
 * A new identifier that is neither fails this test by name, with the fix spelled out, rather than
 * by a future production incident.
 *
 * WHY FILE-SCOPED, NOT A BARE NAME MATCH. An earlier version of this scan matched
 * "immune by construction" and the allowlist against ANY identifier of that name anywhere in
 * src/, not the one actually flagged. A real evaluate() target and an unrelated same-named
 * String.raw constant declared in a different file would have satisfied each other - the unsafe
 * one waved through on the strength of a declaration that has nothing to do with it. Both checks
 * below are scoped to the specific file the call site was found in.
 *
 * WHY WHOLE-FILE, COMMENT-STRIPPED TEXT, NOT PER-LINE. An earlier version matched line by line and
 * skipped lines whose TRIMMED text started with `*` or `//`. That missed a call site split across
 * lines (`.evaluate(\n  someFn\n)`, functionally identical to the single-line form) and could not
 * tell a real call from one mentioned mid-line in a comment (`// used to call .evaluate(oldFn)
 * here`). Comments are stripped from a copy of each file's text before either regex runs, and
 * `\s*` in the call-site pattern already spans newlines, so a call site's shape on disk no longer
 * matters to whether this catches it.
 *
 * SCOPE. This only covers `.evaluate(<bareIdentifier>)` call shapes. It does NOT statically verify
 * inline anonymous callbacks (`.evaluate((el) => {...})`), which could themselves contain a named
 * inner binding (`const helper = () => ...`) and be just as vulnerable - auditing THOSE requires
 * reading each callback's body, which this repo's earlier audit did by hand for the small number
 * that exist today (all confirmed safe) but which this mechanical scan does not repeat. If a
 * future inline callback grows a named inner helper, this test will not catch it. Closing that gap
 * fully would need an AST-aware check (e.g. a real ESLint rule, which this repo does not currently
 * have any infrastructure for) rather than this regex-over-text scan. Also NOT attempted: resolving
 * whether the object `.evaluate(` is called on is actually a Playwright Page/ElementHandle (a false
 * positive on an unrelated `.evaluate(` from some other API just costs a spurious allowlist
 * entry, never a missed real one, so it is the safe direction to be wrong in).
 */

const SRC_ROOT = join(__dirname, '..');

/** Proven-safe (identifier, defining file) pairs - see (b) above. Keyed by `file:identifier`, not
 *  bare identifier, so an unrelated same-named function elsewhere can never inherit this sign-off. */
const KNOWN_SAFE_PLAIN_EVALUATE_TARGETS: Record<string, string> = {
  'lib/portalSubmission.ts:READ_CONTROL_LABEL':
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

/** Blanks out `/* ... *\/` and `//...` comment text (replacing it with spaces, never removing
 *  characters) so neither regex below can match inside a comment, while every match index still
 *  lines up with the ORIGINAL file's character offsets - line numbers computed from a stripped
 *  match are still correct line numbers in the real file. Does not understand string literals: a
 *  `//` or `/* ` inside a quoted string (a URL, say) is blanked too, which could in principle hide
 *  a real call site on the same line after it. Accepted rather than built around: this is a test
 *  scanning this repo's own source, not a general-purpose parser, and a full tokenizer is the
 *  AST-aware tool SCOPE above already says this file is deliberately not trying to be. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

type FileRecord = { relPath: string; raw: string; stripped: string };

/** Every non-test .ts file under src/, read from disk exactly once and comment-stripped exactly
 *  once, reused by every check below. The original design re-walked and re-read the entire tree
 *  once per distinct identifier found (and again in the second test) - O(files x identifiers)
 *  instead of O(files). */
function loadSourceFiles(): FileRecord[] {
  return listTsFilesRecursive(SRC_ROOT).map((file) => {
    const raw = readFileSync(file, 'utf8');
    return { relPath: file.slice(SRC_ROOT.length + 1), raw, stripped: stripComments(raw) };
  });
}

type EvaluateTarget = { name: string; file: string; line: number };

/** Every `.evaluate(<bareIdentifier>` call site across every loaded file. A bare identifier is a
 *  plain word after the open paren (any amount of whitespace/newlines, per SCOPE above), followed
 *  by `,` (a second arg) or `)`; anything else (a `(`, `function`, an object, a spread) is an
 *  inline callback or something else this scan does not attempt to classify, and is skipped. */
function findPlainIdentifierEvaluateTargets(files: FileRecord[]): EvaluateTarget[] {
  const found: EvaluateTarget[] = [];
  const pattern = /\.evaluate\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*[,)]/g;
  for (const { relPath, stripped } of files) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign -- straightforward regex scan
    while ((match = pattern.exec(stripped)) !== null) {
      const name = match[1]!;
      if (name === 'evaluate') continue; // never the target of its own call
      const line = stripped.slice(0, match.index).split('\n').length;
      found.push({ name, file: relPath, line });
    }
  }
  return found;
}

/** Whether `name`'s own declaration, WITHIN `file` specifically, proves it immune by construction:
 *  `= String.raw` (evaluated as a source string, never serialised as a function at all) or
 *  `= new Function(` (a real function, but one a bundler cannot rename anything inside, because
 *  its body lives in a string literal). Scoped to the one file the call site names - see WHY
 *  FILE-SCOPED above - not a search across the whole tree for any matching declaration. */
function isImmuneByConstruction(name: string, file: FileRecord): boolean {
  const declPattern = new RegExp(
    `(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*(String\\.raw\`|new Function\\()`,
  );
  return declPattern.test(file.stripped);
}

test('every plain-function Playwright evaluate() target is either immune by construction or has a signed-off tripwire test', () => {
  const files = loadSourceFiles();
  const byPath = new Map(files.map((f) => [f.relPath, f]));
  const targets = findPlainIdentifierEvaluateTargets(files);
  const unprotected: string[] = [];

  for (const { name, file, line } of targets) {
    const record = byPath.get(file)!;
    if (isImmuneByConstruction(name, record)) continue;
    if (`${file}:${name}` in KNOWN_SAFE_PLAIN_EVALUATE_TARGETS) continue;
    unprotected.push(`${name} (${file}:${line})`);
  }

  assert.deepEqual(
    unprotected,
    [],
    'Found a Playwright .evaluate() target that is neither compiled from a String.raw script (immune '
    + 'to bundler name-mangling by construction) nor listed in KNOWN_SAFE_PLAIN_EVALUATE_TARGETS in '
    + 'this file (keyed by file:identifier). Before adding it there: (1) confirm whether it actually '
    + 'has an inner named binding (a real esbuild --bundle --keep-names test against it, the way '
    + 'READ_CONTROL_LABEL was checked, not a guess), (2) if it does, or you are not sure, convert it '
    + 'to the String.raw + new Function pattern (see COMMIT_REQUIRED_CONTROLS_FOR_SUBMIT) rather than '
    + 'sign it off, (3) if it genuinely has none, add a reparseThroughPlaywrightSerialization tripwire '
    + 'test for it (see playwrightSerializationRoundTrip.ts) and only then add it to the list above '
    + 'with a comment pointing at that test.',
  );
});

/* This scan's own honesty check: if a known-safe identifier stops matching either escape hatch
   (its declaration changes shape, or someone deletes the tripwire this list promises exists), the
   maintainer above throws for a reason nobody can see just by reading it. This one names it. */
test('KNOWN_SAFE_PLAIN_EVALUATE_TARGETS entries are still found by the scan (not stale)', () => {
  const files = loadSourceFiles();
  const targets = findPlainIdentifierEvaluateTargets(files);
  for (const key of Object.keys(KNOWN_SAFE_PLAIN_EVALUATE_TARGETS)) {
    const [file, name] = key.split(':') as [string, string];
    assert.ok(
      targets.some((t) => t.file === file && t.name === name),
      `${key} is listed in KNOWN_SAFE_PLAIN_EVALUATE_TARGETS but the scan found no .evaluate(${name}) `
      + `call site in ${file} anymore - remove the stale entry.`,
    );
  }
});
