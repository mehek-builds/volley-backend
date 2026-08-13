/* THE PRE-SUBMIT READINESS GATE'S GRAMMAR, DECLARED ONCE AND HASHED.
 *
 * WHAT THIS EXISTS TO PREVENT, measured rather than imagined. The readiness gate is written twice:
 * here, as READ_SUBMIT_READINESS_SCRIPT in portalSubmission.ts, evaluated by this service's own
 * direct-Playwright path; and again as readSubmitReadiness inside the managed runner's sandbox
 * script (stratus-browser-cloud, src/managed-browser.js). Only the second one runs a managed
 * application, which is most of them.
 *
 * On 2026-08-13 a fix for a real defect - the gate reading an optional question's own <label> as
 * that field's validation error, which stopped four Scale AI and three DV Trading packets - was
 * written, reviewed and merged as PR #527 into THIS copy. Production went on producing the same
 * sentence, because the copy that produced it never got the test. The only thing asking for parity
 * between the two was a comment.
 *
 * The atomic submit chooser had already solved this for its own grammar and is the precedent copied
 * here, in shape and in name: one declaration of the load-bearing bytes, one SHA-256 over them, and
 * a guard that refuses to start against a hash it does not recognise. See
 * finalSubmitChooserPolicy.ts, and its twin ATOMIC_SUBMIT_POLICY in managed-browser.js.
 *
 * WHAT THE GUARD DOES AND DOES NOT DO, stated plainly so nobody trusts it for more. Editing any
 * fragment below changes SUBMIT_READINESS_GRAMMAR_HASH, which turns this repo's pin red and the
 * runner's boot check red, in whichever repo the edit happened. It cannot reach across and edit the
 * other repo for you. What it removes is the SILENT case: the literal hash is the same 64 characters
 * in both repos, so an edit here that is not carried over leaves a value in this file that is
 * greppable, one string search away, in the file that has to match it. PR #527 had no such string.
 *
 * WHAT IS IN THE GRAMMAR, and why it is these seven and not the whole gate. The two copies do not
 * share a body - one keys note() on the widget, the other on the control, one reports `unmatched`
 * and the other does not - so hashing the gate is not available. What they genuinely do share is the
 * vocabulary they read an employer's markup with, plus the ONE structural rule the two copies
 * disagreed about. A hash over the vocabulary alone would have been green through the whole of the
 * incident above, which is the same as not having it.
 */
import { createHash } from 'node:crypto';

export const SUBMIT_READINESS_GRAMMAR_NAME = 'litos-submit-readiness' as const;
export const SUBMIT_READINESS_GRAMMAR_VERSION = 1 as const;

/**
 * Native required, plus aria-required. React Select's input carries aria-required="true" and no
 * required attribute at all, so a gate built on [required] alone cannot see an unanswered Greenhouse
 * screener question, which is the control this gate exists to catch.
 */
export const SUBMIT_READINESS_REQUIRED_ATTRIBUTES = String.raw`input[required], textarea[required], select[required], [aria-required="true"]`;

/**
 * Ashby's spelling of "this field, in particular": a CSS-module class on the question's own label,
 * painting the asterisk from a ':after' rule, so the mark appears in no attribute and in no text
 * anywhere on the page. Three hashed variants ship in one bundle, hence the module-name fragment
 * rather than a whole class name.
 */
export const SUBMIT_READINESS_REQUIRED_CLASS_MARKERS = String.raw`label[class*="_required_"], legend[class*="_required_"]`;

/** Greenhouse's spelling of the same mark: the character itself, printed into the label text. */
export const SUBMIT_READINESS_ASTERISK_MARK = String.raw`\*(?:\s|$)|(?:^|\s)\*`;

/**
 * And the sentence that is a page-level notice wearing the same character. "* indicates a required
 * field" is not a field marker, and matching it would refuse every Greenhouse submission there is.
 */
export const SUBMIT_READINESS_ASTERISK_LEGEND = String.raw`\*\s*(?:indicates|denotes|means|marks|=)`;

/** The employer's own "this field is missing" vocabulary, as the ATS families render it. */
export const SUBMIT_READINESS_ERROR_TEXT = String.raw`\bis required\b|\brequired field\b|\bplease (?:select|enter|complete|choose|provide)\b|\bcannot be blank\b`;

/**
 * The same legend exclusion, one layer down. A form's own "* indicates a required field" matches
 * SUBMIT_READINESS_ERROR_TEXT, and on the live Redwood Materials form it was the ONLY thing an early
 * version of this gate found on a completely and correctly filled application. A gate that blocks
 * everything is not caution.
 */
export const SUBMIT_READINESS_LEGEND_TEXT = String.raw`\bindicates?\b|\bdenotes?\b|\bfields?\s+marked\b|\ball fields\b`;

/**
 * THE FIELD'S OWN QUESTION IS NOT THE FIELD'S OWN COMPLAINT, as one statement of source shared
 * between the two gates rather than as two statements that happened to agree.
 *
 * This is the rule PR #527 added here and did not add to the runner, and it is in the grammar for
 * exactly that reason: a hash over the vocabulary alone would not have noticed. Shipped as source
 * because both gates are serialized text evaluated inside a page, so source is the only form they
 * can share. Each copy supplies `element` and `controls` and its own indentation; nothing else about
 * the statement is theirs to choose.
 *
 * A <label for="..."> naming a control in its own block is the employer ASKING. ERROR_TEXT contains
 * "please provide", and a Greenhouse label is a LEAF element exactly when the field is optional,
 * because a required one carries <span aria-hidden="true">*</span> inside it. So the loop this
 * guards could only ever mis-fire on fields the employer marked optional, and it did.
 */
export const SUBMIT_READINESS_OWN_QUESTION_SKIP = String.raw`if (element.tagName === 'LABEL' && element.getAttribute('for') && controls.some((candidate) => candidate.id === element.getAttribute('for'))) continue;`;

/** The exact bytes both copies of the gate have to agree on, in a fixed order. */
export const SUBMIT_READINESS_GRAMMAR = [
  SUBMIT_READINESS_REQUIRED_ATTRIBUTES,
  SUBMIT_READINESS_REQUIRED_CLASS_MARKERS,
  SUBMIT_READINESS_ASTERISK_MARK,
  SUBMIT_READINESS_ASTERISK_LEGEND,
  SUBMIT_READINESS_ERROR_TEXT,
  SUBMIT_READINESS_LEGEND_TEXT,
  SUBMIT_READINESS_OWN_QUESTION_SKIP,
].join('\n');

export const SUBMIT_READINESS_GRAMMAR_HASH = createHash('sha256')
  .update(SUBMIT_READINESS_GRAMMAR)
  .digest('hex');

export type SubmitReadinessGrammarPolicy = {
  name: typeof SUBMIT_READINESS_GRAMMAR_NAME;
  version: typeof SUBMIT_READINESS_GRAMMAR_VERSION;
  grammarHash: string;
};

export const SUBMIT_READINESS_GRAMMAR_POLICY: SubmitReadinessGrammarPolicy = Object.freeze({
  name: SUBMIT_READINESS_GRAMMAR_NAME,
  version: SUBMIT_READINESS_GRAMMAR_VERSION,
  grammarHash: SUBMIT_READINESS_GRAMMAR_HASH,
});
