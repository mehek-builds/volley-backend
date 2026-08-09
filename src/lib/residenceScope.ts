// Is the stored fact even a member of the set the question asks about?
//
// WHY THIS FILE EXISTS (measured on prod packets for the owner account, 2026-08-09). DV Trading's
// application asks two residence questions in a row:
//
//   "What country do you currently reside in?"        180 countries, required
//   "If applicable, which US state do you reside in?"  the 50 states, NOT required
//
// She lives in Dubai and studies in Los Angeles, so the honest answer to the second one is nothing
// at all: it is the question's own "if applicable" branch, and the employer marked it optional for
// exactly this case. Litos answered it "Dubai", the runner reported
//
//   no option matched "Dubai", left for you to choose
//
// and the ONLY reason a false statement about her residence did not reach a real employer is that
// the matcher happened to be strict. That is luck, not a safeguard. Every improvement to option
// matching makes this worse, not better: a looser matcher is one edit-distance away from choosing
// Delaware, and a wrong answer is invisible to her in a way a blank never is.
//
// So membership is checked BEFORE matching, and it is a set test rather than a similarity score.
// The fifty states plus DC is a closed, complete, non-negotiable list; a value outside it is not a
// near miss, it is a different kind of thing. There is nothing to rank and nothing to guess.
//
// Deliberately narrow. This refuses only when the question SAYS it wants a United States state and
// the stored region is not one. A bare "State/Province" question is untouched, because that is the
// generic address field every form has and her region is a perfectly good answer to it.

import { US_STATES } from './cities';

const US_STATE_NAMES: ReadonlySet<string> = new Set(
  US_STATES.flatMap(([code, name]) => [code.toLowerCase(), name.toLowerCase()]),
);

function comparableRegion(value: string): string {
  return value
    .toLowerCase()
    // "D.C." is written with dots as often as without, so the dots go before the words are split
    // and the abbreviation stays one token instead of becoming "d c".
    .replace(/\./g, '')
    .replace(/[^a-z]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Is this text one of the fifty states, or DC, by name or by postal code? */
export function isUsState(value: string | null | undefined): boolean {
  const key = comparableRegion(value ?? '');
  if (!key) return false;
  if (US_STATE_NAMES.has(key)) return true;
  return key === 'washington dc' || key === 'district of columbia';
}

/**
 * Does the label say, in the employer's own words, that it wants a state OF THE UNITED STATES?
 *
 * The two shapes real forms use are the adjective ("which US state do you reside in?") and the
 * prepositional phrase ("in which state in the United States do you live?"). A label that merely
 * mentions America somewhere else in a long sentence is not enough: the country word has to sit
 * next to the state word, or the work-authorization questions on the same form would all read as
 * US-scoped state questions.
 */
const US_SCOPED_STATE_QUESTION =
  /\b(?:us|usa|united\s+states|american)\b[^?!]{0,20}\bstates?\b|\bstates?\b[^?!]{0,20}\b(?:in|of|within)\s+(?:the\s+)?(?:us|usa|united\s+states)\b/i;

export function asksForUsState(label: string): boolean {
  // The dots go first: "U.S. state" and "US state" are the same question, and a dot would
  // otherwise sit between the country word and its own word boundary.
  return US_SCOPED_STATE_QUESTION.test(label.replace(/\./g, '').replace(/\s+/g, ' '));
}

/**
 * The reason to leave a US-state question alone, or null when the stored region can honestly
 * answer it.
 *
 * Returns a sentence rather than a boolean because the applicant is owed the actual reason: the
 * question is not unanswered because Litos does not know where she lives, it is unanswered because
 * where she lives is not on the list the employer offered.
 */
export function usStateScopeSkipReason(
  label: string,
  storedState: string | null | undefined,
): string | null {
  if (!asksForUsState(label)) return null;
  const stored = storedState?.trim();
  if (!stored || isUsState(stored)) return null;
  return `question asks for a US state and your residence is not one, left for you: "${label.slice(0, 60)}"`;
}
