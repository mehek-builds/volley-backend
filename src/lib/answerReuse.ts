/**
 * WHICH ANSWERS MAY BE CARRIED TO THE NEXT POSTING, AND WHICH MAY NEVER BE.
 *
 * The ask-at-Apply step may remember only narrow, immutable factual values whose meaning does not
 * depend on the employer, posting, policy version or option list. A prior answer is not authority
 * merely because the applicant once typed it. Legal status, intentions, self-ratings and agreements
 * can change or can mean something different on the next form.
 *
 * THE LINE, and it is drawn one way on purpose. "Based on the team descriptions above, which
 * opening would you be most interested in contributing to?" is a real question with a real answer,
 * and that answer is about ONE posting. Replaying it onto a different employer's form is Litos
 * making a statement she never made, which is the same harm as inventing one - the only difference
 * is that the words were hers originally. So:
 *
 *   POSTING-SPECIFIC IS THE DEFAULT. An answer is reused only when it clears a narrow positive
 *   whitelist for an immutable factual class, AND nothing in the label ties it to this posting.
 *
 * The asymmetry is deliberate and is the whole safety argument. Failing to reuse a reusable answer
 * costs her one more box to type in, on a screen built for typing in boxes. Reusing a
 * posting-specific one sends a wrong answer to an employer, silently, and she finds out at
 * interview. Those are not comparable, so the tie goes to asking again.
 */

import {
  isLocationCommitmentQuestion,
  isPriorApplicationQuestion,
  isRelocationQuestion,
  normalizeReviewQuestionLabel,
} from './questionDiscovery';
import { labelNamesOfficeMetro } from './officeMetros';
import { isSelfDeclarationQuestion } from './selfDeclaration';

export type AnswerReuseScope = 'reusable' | 'posting_specific';

export type AnswerReuseContext = {
  /** The employer this posting belongs to, so a label that names them can be held back. */
  company?: string | null;
};

/**
 * The label points at THIS posting, so its answer belongs to this posting.
 *
 * Every alternative below was written against a label measured on the production run of
 * 2026-08-08, or is the immediate sibling of one:
 *  - "Based on the team descriptions above, which opening would you be most interested in
 *    contributing to?" (Faire) - both `above` and `which opening`;
 *  - "What is your preferred work location?" (Point72) - the option list is this employer's offices;
 *  - "Please confirm the season you are applying for" - the seasons are this posting's.
 */
const POSTING_SCOPED_QUESTION = new RegExp(
  [
    // Deixis: the question refers to something on the page it is printed on.
    String.raw`\bthis\s+(?:role|position|job|opening|posting|req(?:uisition)?|internship|programme|program|team|group|office|location|company|firm|organi[sz]ation)\b`,
    String.raw`\b(?:listed|described|mentioned|shown|stated)\s+above\b|\bthe\s+above\b|\babove[,.]?\s+which\b|\bteam\s+descriptions?\b|\bjob\s+description\s+above\b`,
    // Choosing among options that exist only on this posting.
    String.raw`\bwhich\s+(?:opening|openings|team|teams|role|roles|position|positions|office|offices|location|locations|group|groups|desk|desks|track|tracks|programme|program|cohort|season|site|sites)\b`,
    String.raw`\bpreferred\s+(?:work\s+)?(?:location|office|site|team|group|desk|start\s+date)\b|\blocation\s+preference\b|\boffice\s+preference\b`,
    String.raw`\b(?:rank|order|prioriti[sz]e)\b[^?]{0,60}\b(?:offices|locations|teams|roles|choices|preferences)\b`,
    String.raw`\b(?:first|top|second|third)\s+choice\b|\bselect\s+your\s+top\b|\bmost\s+interested\s+in\s+(?:contributing|joining|working)\b`,
    // Motivation. The answer is about this employer by construction.
    String.raw`\bwhy\s+(?:do\s+you\s+want|are\s+you\s+interested|would\s+you\s+(?:like|want)|us\b|our\b)`,
    String.raw`\bwhat\s+(?:interests|excites|draws|attracts)\s+you\b`,
    // "How did you hear about this job" and friends, which name the posting outright.
    String.raw`\bhear\s+about\s+(?:this|the)\s+(?:job|role|position|opening|opportunity)\b`,
  ].join('|'),
  'i',
);

/* ---- THE ONSITE COMMITMENT, and the one thing that decides whether her answer travels ----
 *
 * Does the label say WHERE.
 *
 * "Are you willing to work four days per week in our San Francisco office?" (Together AI) and "Are
 * you available to work from our office in San Francisco?" (Redwood Materials) are questions about
 * HER. Whether she will sit in an office in San Francisco is a fact about her life, it is the same
 * fact at the next employer with an office in San Francisco, and the ask-at-Apply step exists to
 * stop asking. Six distinct postings ask this in her history: Anduril, Postman, Fluency, Brex,
 * Together AI, Redwood, which is three times the two-posting bar.
 *
 * WHY THIS IS ON THE WHITELIST AT ALL, given that the whitelist is otherwise one class wide. The
 * hardening above holds an answer back whenever its meaning can drift between forms: a policy
 * version, an option taxonomy, a legal status. A named metro is the opposite shape. The stored key
 * is the normalized label, so a replay happens only when the next employer asks the SAME question,
 * and that question already carries its own scope in its own words: the city, and the cadence when
 * it names one. Nothing is composed and nothing is inferred; the only variable left is which
 * employer is asking, and where she is willing to sit is not a fact about the employer.
 *
 * It is also why the placeless case is NOT handled here. "Are you willing to work in-person for 12
 * weeks during the internship?" (Anduril) names no place, so what she agreed to is wherever THAT
 * posting's office is, and replaying a Costa Mesa "Yes" onto a New York posting is Litos making a
 * commitment she never made. That case simply falls through to the posting-specific default below,
 * which is where every unproven class already lands, so there is no second rule to keep in step.
 *
 * Relocation needs no place: application_profile.relocation_willingness is a plain yes/no for
 * exactly that reason, so "are you willing to relocate?" and "are you willing to relocate to
 * Austin?" are both settled by the same stable fact.
 *
 * This sits BELOW the three vetoes on purpose. "Which office location do you prefer?" and "what is
 * your preferred work location?" reach POSTING_SCOPED_QUESTION first and stay posting-specific:
 * choosing among an employer's own offices is a different question from committing to sit in one.
 */

/* The metro table lives in officeMetros.ts, shared with the resolver. Two copies of "does this
 * label name an office" would let one file treat a label as placed while the other treats it as
 * placeless, and those two readings disagree about whether an answer may travel. */

/**
 * 'reusable' for the onsite commitments that carry their own scope, and null for everything else,
 * INCLUDING a placeless onsite label. Null means "this rule has nothing to say", and the caller's
 * default then holds the answer back, which is the same refusal the placeless case needs.
 */
function onsiteCommitmentReuseScope(label: string): AnswerReuseScope | null {
  if (!isLocationCommitmentQuestion(label)) return null;
  if (isRelocationQuestion(label)) return 'reusable';
  return labelNamesOfficeMetro(label) ? 'reusable' : null;
}

/** Exact standardized-test scores, alongside the placed onsite commitment above. */
const STANDARDIZED_TEST_SCORE_QUESTION =
  /\b(?:sat|act|gre|gmat|lsat|toefl|ielts)\b[^?]{0,60}\bscores?\b|\bstandardi[sz]ed\s+test\s+scores?\b|\bscores?\b[^?]{0,40}\b(?:sat|act|gre|gmat)\b/i;
const STANDARDIZED_TEST_SCORE_OPTION_QUESTION =
  /\b(?:range|band|bracket|select|choose|which\s+of|below|above|greater|less|at\s+least|at\s+most)\b/i;

const COMPANY_SUFFIX_WORDS = new Set([
  'inc', 'inc.', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'group',
  'holdings', 'technologies', 'technology', 'labs', 'lab', 'capital', 'partners', 'management',
  'research', 'systems', 'solutions', 'ventures', 'trading', 'securities', 'the', 'and',
]);

/**
 * The distinctive words in an employer's name: "Akuna Capital" -> ["akuna"], "Tower Research
 * Capital" -> ["tower"].
 *
 * Suffixes are dropped because they are shared: matching on "capital" would flag every question at
 * every fund as naming the employer, and matching on "research" would flag half of them.
 */
export function companyNameTokens(company: string | null | undefined): string[] {
  return (company ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s&.-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/[.]+$/g, '').trim())
    .filter((token) => token.length >= 3 && !COMPANY_SUFFIX_WORDS.has(token));
}

/** Does the question name the employer whose form it is on? */
export function labelNamesCompany(label: string, company: string | null | undefined): boolean {
  const tokens = companyNameTokens(company);
  if (tokens.length === 0) return false;
  const haystack = ` ${(label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return tokens.some((token) => haystack.includes(` ${token} `));
}

/**
 * May the answer to this question be carried to a different posting?
 *
 * The order of the tests is the rule: every veto runs before the single positive test, so a label
 * that is both a self-declaration and posting-scoped comes back posting-specific.
 */
export function answerReuseScope(label: string, context: AnswerReuseContext = {}): AnswerReuseScope {
  const value = (label ?? '').trim();
  if (!value) return 'posting_specific';

  // Veto 1: the question points at this posting.
  if (POSTING_SCOPED_QUESTION.test(value)) return 'posting_specific';

  // Veto 2: the question names this employer. "Have you previously applied to work at Point72?"
  // has a true answer that is true only of Point72.
  if (labelNamesCompany(value, context.company)) return 'posting_specific';

  /* Veto 3: the prior-application question, whether or not it managed to name anybody.
   *
   * Veto 2 catches the named ones. This catches "Have you applied to us before?", which names
   * nobody, reads as a general question, and is per-employer all the same. Without it, one "No"
   * given to a firm she has never approached would be replayed as a "No" to a firm she applied to
   * last month, which is a false statement about her own record - the exact class of harm that a
   * drafted 600-word essay opening "I have not applied to Akuna in the past" already caused once. */
  if (isPriorApplicationQuestion(value)) return 'posting_specific';

  /* Positive test 1: an onsite commitment whose label names the place it is about. It runs before
   * the self-declaration line because that line refuses, and a placed onsite commitment is the one
   * declaration whose scope is written into the question itself. A placeless one returns null here
   * and is refused below with everything else. See onsiteCommitmentReuseScope. */
  const onsite = onsiteCommitmentReuseScope(value);
  if (onsite) return onsite;

  // Self-declarations never cross posting boundaries. This includes legal/export-control status,
  // sponsorship, military history, policies, attestations, intentions and skill self-ratings.
  if (isSelfDeclarationQuestion(value)) return 'posting_specific';

  // Positive test 2. Only an exact standardized score travels. A range or select prompt has an
  // employer-specific option taxonomy, so replaying the old option text is unsafe.
  if (STANDARDIZED_TEST_SCORE_QUESTION.test(value) && !STANDARDIZED_TEST_SCORE_OPTION_QUESTION.test(value)) {
    return 'reusable';
  }

  return 'posting_specific';
}

/** How long a stored answer key may be. Long enough to stay distinct, short enough to index. */
export const SAVED_ANSWER_KEY_MAX_LENGTH = 300;

/**
 * The identity of a question across employers.
 *
 * Built from the label the applicant actually saw (after normalizeReviewQuestionLabel has stripped
 * the provider's `--0` handles and required markers), then case-folded and stripped of punctuation
 * so that "Please rate your skill level in C++:" and "Please rate your skill level in C++*" are one
 * question rather than three.
 *
 * `+` survives the strip deliberately: C, C++ and C# are three different skills and three different
 * answers, and folding them together would replay a C rating onto a C++ question.
 */
export function savedAnswerKey(label: string): string {
  const normalized = normalizeReviewQuestionLabel(label ?? '') || (label ?? '');
  const key = normalized
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return key.slice(0, SAVED_ANSWER_KEY_MAX_LENGTH);
}

export type ReviewedAnswer = { question: string; answer: string };

export type StorableAnswer = { key: string; question: string; answer: string };

/**
 * The subset of a reviewed answer set that is safe to remember.
 *
 * Blank answers are dropped rather than stored as empty: "she has not answered this yet" and "she
 * answered it with nothing" are different, and only the first is true here.
 */
export function reusableAnswersToStore(
  answers: readonly ReviewedAnswer[],
  context: AnswerReuseContext = {},
): StorableAnswer[] {
  const out = new Map<string, StorableAnswer>();
  for (const item of answers) {
    const question = (item?.question ?? '').trim();
    const answer = (item?.answer ?? '').trim();
    if (!question || !answer) continue;
    if (answerReuseScope(question, context) !== 'reusable') continue;
    const key = savedAnswerKey(question);
    if (!key) continue;
    out.set(key, { key, question, answer });
  }
  return [...out.values()];
}

/**
 * The stored answer for a question, if there is one and if it may travel here.
 *
 * The scope is checked AGAIN on the read side, against THIS posting's company, and that second
 * check is not redundant. The write side only knew the posting the answer came from. A label that
 * reads as a general declaration at Astranis ("Have you applied to us before?") can be
 * posting-scoped at the next employer, and the read side is the only place that knows which
 * employer is asking now.
 */
export function savedAnswerFor(
  label: string,
  saved: ReadonlyMap<string, string>,
  context: AnswerReuseContext = {},
  options: readonly string[] | null = null,
): string | undefined {
  const question = (label ?? '').trim();
  if (!question) return undefined;
  if (answerReuseScope(question, context) !== 'reusable') return undefined;
  const value = saved.get(savedAnswerKey(question));
  if (!value?.trim()) return undefined;
  const usableOptions = (options ?? []).filter((option) => option.trim());
  if (usableOptions.length === 0) return value;
  // A stable factual value may travel, but a closed control is a new factual claim about which of
  // this employer's choices applies. Replay only when the current form contains the exact stored
  // value. Range and band options must never receive a numeric score merely because the label stayed
  // unchanged between postings.
  return usableOptions.find((option) => option.trim() === value.trim());
}
