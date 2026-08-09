// Refusals to state, and the words the control itself uses for them.
//
// Split out of profileFieldResolution.ts so that questionDiscovery.ts can consult it too.
// questionDiscovery is where a self-identification answer is PRODUCED, and profileFieldResolution
// imports questionDiscovery, so the vocabulary cannot live there without a cycle. Nothing in this
// file imports anything.

/**
 * Comparison form for option matching. Apostrophes are DELETED rather than spaced so that
 * "Bachelor's Degree" and "Bachelors Degree" collapse to one string: portals spell that enum
 * both ways and they are the same answer.
 */
export function comparableOption(value: string): string {
  return value
    .replace(/[‘’‛ʼ']/g, '')
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/[^a-z0-9.+/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A refusal to state, in the wordings employers put on the list. Tested against comparableOption()
 * output, so apostrophes are already gone ("don't" reads "dont") and punctuation is spaces.
 *
 * MATCHES THE INTENT, NEVER THE STRING. Both of the two option vocabularies the corpus has ever
 * recorded word their opt-out differently from the stored answer, and both came back unmatched:
 *
 *   "I decline to self-identify for protected veteran status"   (from the veteran status control)
 *   "I do not want to answer"                                   (from the disability status control)
 *
 * The first is the more interesting failure. chooseClosestOption saw an option that states the
 * answer and adds words, and refused it because CLOSED_SET_ANSWER_RE lists "decline to self
 * identify" among the answers whose whole meaning is the phrase itself. That rule is right for
 * "Yes" against "Yes - I am authorized to work in the US for any employer", where the remainder
 * asserts something the answer did not. It is wrong here: "for protected veteran status" does not
 * add a claim, it names the question being declined. So the refusal is not relaxed for anyone else;
 * declines are recognised by what they mean instead.
 */
const DECLINE_TO_STATE_RE = new RegExp(
  [
    // "Decline to self-identify", "I decline to self-identify for protected veteran status"
    'declines? to (?:self identify|answer|state|say|specify|disclose|respond|provide)',
    // "I do not want to answer", "I don't wish to answer", "prefer not to say", "choose not to disclose"
    '(?:do not|dont|does not|doesnt|would rather not|rather not|prefer not|prefers not|choose not|chooses not)'
    + ' (?:to )?(?:want|wish|like)? ?(?:to )?(?:answer|say|state|specify|disclose|self identify|identify|respond|provide)',
    // "I would not like to disclose this", "not wishing to answer"
    'not (?:want|wish|choose|prefer)(?:ing)? to (?:answer|say|state|specify|disclose|self identify|identify|respond|provide)',
    // the bare noun phrases short lists use, whole-string only so "no answer required" is not one
    '^(?:decline[ds]?|i decline|no answer|not disclosed|not specified|undisclosed)$',
  ].join('|'),
);

/** Is this text a refusal to state rather than a statement? */
export function isDeclineToState(text: string): boolean {
  return DECLINE_TO_STATE_RE.test(comparableOption(text));
}

/**
 * THE OPT-OUT IN THE CONTROL'S OWN WORDS, when the discovered label carries the field handle that
 * names its vocabulary.
 *
 * MEASURED, and it is the single biggest reason a packet cannot be submitted. Across the prod
 * packets for the owner account on 2026-08-09, "are you hispanic/latino? hispanic_ethnicity" came
 * back as `no option matched "Decline to self-identify", left for you to choose` on TWENTY packets
 * across eight employers, more than any other question in the corpus.
 *
 * The list that question offers is ["Yes", "No", "Decline To Self Identify"] - read on 2026-08-09
 * from the board's own published English strings, not guessed - and the stored answer is
 * "Decline to self-identify". Those are the same refusal spelled two ways, and they differ by ONE
 * HYPHEN, which the runner's matcher does not forgive. A voluntary question with an explicit
 * opt-out therefore blocked eight employers' applications over punctuation.
 *
 * The wordings below are the BOARD's, not any employer's. All four appear byte-identical on all ten
 * distinct employer forms in the measured corpus, because they are rendered from the board's own
 * locale file rather than configured per customer. Keyed on the handle rather than on the visible
 * question text for the same reason the demographic block must not be caught by this: those
 * questions are employer-authored, their labels end in a numeric question id instead of a handle,
 * and their opt-out is worded differently again. A handle is required, and it must be the whole
 * label or its last word, so "how would you describe your gender identity? (mark all that apply)
 * 4012865007" matches nothing here and keeps the applicant's own wording, which is what already
 * works for it.
 *
 * This is a substitution of one refusal for the same refusal, never of a refusal for a statement.
 * Every caller checks isDeclineToState on the answer first.
 */
const SELF_ID_VOCABULARY_DECLINE: ReadonlyArray<{ handle: RegExp; wording: string }> = [
  { handle: /(?:^|\s)hispanic_ethnicity$/i, wording: 'Decline To Self Identify' },
  { handle: /(?:^|\s)race$/i, wording: 'Decline To Self Identify' },
  { handle: /(?:^|\s)gender$/i, wording: 'Decline To Self Identify' },
  { handle: /(?:^|\s)veteran_status$/i, wording: "I don't wish to answer" },
  { handle: /(?:^|\s)disability_status$/i, wording: 'I do not want to answer' },
];

/**
 * The exact opt-out string this control offers, or undefined when the label does not say which
 * vocabulary it is using.
 *
 * Undefined is the common case and the safe one: without a handle there is nothing to be confident
 * about, and the applicant's own wording stays at the head of the ladder where it belongs.
 */
export function selfIdentificationDeclineWording(label: string): string | undefined {
  const normalized = label.trim().replace(/\s+/g, ' ');
  return SELF_ID_VOCABULARY_DECLINE.find((entry) => entry.handle.test(normalized))?.wording;
}

/**
 * The refusal to leave on this control, given the refusal she stored. Returns the stored wording
 * unchanged whenever the control does not name its own vocabulary, and never touches a stated
 * answer.
 */
export function declineWordingForControl(label: string, answer: string): string {
  if (!isDeclineToState(answer)) return answer;
  return selfIdentificationDeclineWording(label) ?? answer;
}
