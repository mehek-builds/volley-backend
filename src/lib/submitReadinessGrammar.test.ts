/* THE PIN THAT MAKES THE OTHER REPO'S COPY FINDABLE.
 *
 * Written the same way finalSubmitChooserPolicy.test.ts pins the atomic chooser's grammar, and for
 * the same reason: the literal below is the ONE string that appears, character for character, in
 * both this repo and stratus-browser-cloud. Change any fragment of the readiness grammar and this
 * test goes red with the new hash in its failure output, and that hash is a string search away in
 * managed-browser.js, where the runner's boot check refuses to start against a value it does not
 * recognise.
 *
 * It cannot make the other repo change. Nothing here can. What it removes is a fix landing in one
 * copy of this gate with nothing anywhere saying the other copy exists, which is what happened to
 * PR #527 and cost four Scale AI and three DV Trading packets a send they were owed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  SUBMIT_READINESS_ERROR_TEXT,
  SUBMIT_READINESS_GRAMMAR,
  SUBMIT_READINESS_GRAMMAR_HASH,
  SUBMIT_READINESS_GRAMMAR_POLICY,
  SUBMIT_READINESS_OWN_QUESTION_SKIP,
} from './submitReadinessGrammar';
import { READ_SUBMIT_READINESS_SCRIPT } from './portalSubmission';

test('the readiness grammar hash identifies the exact bytes both gates share', () => {
  assert.equal(SUBMIT_READINESS_GRAMMAR_POLICY.name, 'litos-submit-readiness');
  assert.equal(SUBMIT_READINESS_GRAMMAR_POLICY.version, 1);
  /* KEEP THIS IN STEP WITH SUBMIT_READINESS_POLICY.grammarHash IN
     stratus-browser-cloud/src/managed-browser.js, which throws at boot if its own copy of the
     grammar does not hash to it. */
  assert.equal(SUBMIT_READINESS_GRAMMAR_HASH, '5382e70ebe4ac09c4a66af78dd1aae3b37032f30295621bdabfe43dbc0eaadbc');
  assert.equal(createHash('sha256').update(SUBMIT_READINESS_GRAMMAR).digest('hex'), SUBMIT_READINESS_GRAMMAR_HASH);
});

test('the gate that ships is built from the grammar, not from a copy of it', () => {
  /* A hash over a declaration nobody reads guards nothing. Every fragment has to be in the script
     that is actually evaluated in the page, which is what makes the hash a statement about the
     running gate rather than about a constants file. */
  for (const fragment of SUBMIT_READINESS_GRAMMAR.split('\n')) {
    assert.ok(
      READ_SUBMIT_READINESS_SCRIPT.includes(fragment),
      `the shipped readiness script no longer carries: ${fragment.slice(0, 60)}`,
    );
  }
});

test('the structural rule is in the grammar, and not only the vocabulary', () => {
  /* THE POINT OF THE WHOLE FILE. The two copies of this gate never disagreed about a word list.
     They disagreed about ONE structural rule - whether a field's own <label> may be read as that
     field's validation error - and a hash over the vocabulary alone would have been green through
     the entire incident. Asserted on what the statement decides rather than on its spelling, in the
     spirit of the repo's convention: a decision about a LABEL, against the control that label names,
     that skips. */
  assert.match(SUBMIT_READINESS_OWN_QUESTION_SKIP, /'LABEL'/);
  assert.match(SUBMIT_READINESS_OWN_QUESTION_SKIP, /getAttribute\('for'\)/);
  assert.match(SUBMIT_READINESS_OWN_QUESTION_SKIP, /\bcontinue\b/);
  /* AND THAT IT IS BOUNDED TO THE QUESTION, NOT TO ANY LABEL NAMING THE CONTROL. Without this the
     rule reads a jQuery-Validation error label - errorElement 'label', for=idOrName(element),
     "This field is required." - as the field's own question and skips the one message the gate was
     built to read. Asserted on the decision rather than the spelling: the element must BE the first
     label for that control, which is the one authored with the field rather than appended to it. */
  assert.match(SUBMIT_READINESS_OWN_QUESTION_SKIP, /element === \w+\.querySelector\(/);
  assert.match(SUBMIT_READINESS_OWN_QUESTION_SKIP, /label\[for=/);
  /* The skip may only reach for bindings BOTH copies of the gate bind under the same name. This
     repo's scan root is `scanRoot` and the runner's is `root`, so naming either is a ReferenceError
     in the other repo on any page that renders an inline error. */
  assert.doesNotMatch(SUBMIT_READINESS_OWN_QUESTION_SKIP, /\broot\b/);
  assert.doesNotMatch(SUBMIT_READINESS_OWN_QUESTION_SKIP, /\bscanRoot\b/);
  assert.ok(
    SUBMIT_READINESS_GRAMMAR.includes(SUBMIT_READINESS_OWN_QUESTION_SKIP),
    'the rule the two copies actually diverged on must be inside the hashed bytes',
  );
  // And the vocabulary that made an employer's question look like an employer's complaint is still
  // there, unnarrowed. The fix is the structural rule above, never a shorter word list.
  assert.match(SUBMIT_READINESS_ERROR_TEXT, /please[^\n]*provide/);
});
