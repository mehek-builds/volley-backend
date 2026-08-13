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
 *
 * THE CLASS IS WHAT PEOPLE TYPE, not what Unicode calls an apostrophe. The backtick (U+0060) and
 * the acute accent (U+00B4) are not punctuation marks at all, but both sit where the apostrophe
 * key does on common keyboard layouts and both are typed for one routinely. Left out of this
 * class they survive to the next replace, which turns them into a SPACE, so "I don`t wish to
 * answer" compared as "i don t wish to answer" and matched no refusal wording: the volitional
 * branch needs "dont" or "do not" and got neither.
 */
export function comparableOption(value: string): string {
  return value
    .replace(/[‘’‛ʼ'`´]/g, '')
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
 *
 * A REFUSAL IS NOT A NEAR MISS OF A CLAIM, AND THE OLD SHAPE OF THIS PATTERN MADE IT ONE.
 *
 * The second alternative used to read, with every inner group optional:
 *
 *   (?:do not|dont|...) (?:to )?(?:want|wish|like)? ?(?:to )?(?:answer|...|identify|...)
 *
 * so `do not` plus one space plus `identify` satisfied the whole branch, and nothing anchored it.
 * That made this true of the single commonest SUBSTANTIVE option on an EEO race block:
 *
 *   "I do not identify with any of the above"          read as a refusal
 *   "I do not identify as having a disability"         read as a refusal
 *   "I do not identify as transgender"                 read as a refusal
 *   "I choose not to identify with any of the above"   read as a refusal
 *
 * None of those is a refusal. Each is a person saying which categories describe her, which is the
 * opposite kind of statement, and two call sites act on the difference. declineWordingForControl
 * REWRITES anything this matches into the control's opt-out spelling, so a stored answer of "I do
 * not identify with any of the above" was replaced by "Decline To Self Identify" - a substitution
 * of a refusal for a claim, which the comment below it says is the one thing it must never do. And
 * chooseEeoOption picks the sole matching option as a stand-in refusal, so on a race list offering
 * that phrase and no true opt-out, Litos would select it and assert on her behalf that none of the
 * listed categories describe her.
 *
 * WHAT SEPARATES THEM IS VOLITION, not vocabulary. "Do not" and "does not" are plain negations and
 * say nothing about willingness, so they now REQUIRE a volition verb: wanting, wishing, liking,
 * caring, choosing, preferring or intending. "Prefer not" and "choose not" are themselves
 * volitional and may go straight to the verb. And bare `identify` is gone from the volitional
 * branch, because "identify" there always takes a complement naming categories ("identify WITH any
 * of the above", "identify AS transgender") and that complement is the claim; the refusal idiom is
 * the compound "self identify", which is kept everywhere it was.
 *
 * MEASURED, over a written-out set of 18 refusal wordings and 16 substantive ones, including every
 * option string this repo has recorded from a real control: 18 of 18 refusals still match, 16 of 16
 * claims no longer do, and "I would not like to disclose this" now matches, which the old comment
 * claimed as an example and the old pattern did not actually catch.
 */
const DECLINE_TO_STATE_RE = new RegExp(
  [
    // "Decline to self-identify", "I decline to self-identify for protected veteran status"
    'declines? to (?:self identify|answer|state|say|specify|disclose|respond|provide)',
    /* A PLAIN NEGATION NEEDS A VOLITION VERB. "I do not want to answer", "I don't wish to answer",
       "I would not like to disclose this". Without one, "I do not identify with any of the above"
       is a claim about which categories describe her and must not be read as a refusal. */
    '(?:do not|dont|does not|doesnt|did not|didnt|would not|wouldnt|will not|wont)'
    + ' (?:want|wish|like|care|choose|prefer|intend)(?:ing)? to'
    + ' (?:answer|say|state|specify|disclose|self identify|identify|respond|provide)',
    /* A VOLITIONAL NEGATION IS ALREADY THE REFUSAL: "prefer not to say", "choose not to disclose",
       "would rather not say". Bare `identify` is deliberately absent here: "I choose not to
       identify with any of the above" states a category membership, and only the compound
       "self identify" is the opt-out idiom.

       `wish` TAKES -es, NOT -s, and spelling it `wishes?` here meant the optional group hung off
       the `e` instead of the stem: the alternative read "wishe" plus an optional "s", so it caught
       "wishes not" and the non-word "wishe not" while missing the bare "wish not" that a person
       actually types. The three neighbours that take an inflection group here (prefer, choose,
       want) are regular verbs where `s?` is right, which is why the one irregular stem in the list
       read as correct for as long as it did. */
    '(?:would rather not|rather not|prefers? not|chooses? not|wish(?:es)? not|wants? not)'
    + '(?: to)? (?:answer|say|state|specify|disclose|self identify|respond|provide)',
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
 * A STATED NEGATIVE: "I have never had a disability, nor have I ever been a veteran", in the
 * wordings that can actually reach this file.
 *
 * WHOLE-STRING ONLY, AND ONLY THE FORMS THAT WERE MEASURED. Three entries, no prefix matching, no
 * open-ended negation grammar. The reason is the same one that made DECLINE_TO_STATE_RE stop
 * matching bare "do not": a loose negative pattern reads "I do not identify with any of the above"
 * and "No, I am not able to relocate" as self-identification answers, and everything downstream of
 * this function writes protected-characteristic answers onto legal forms. A pattern that is too
 * narrow costs one unmatched option, which the applicant then chooses herself. A pattern that is
 * too wide states something about her that she never said.
 *
 * The three forms, and where each comes from:
 *
 *   "no"
 *       what the profile surface stores, and what the applicant said on 2026-08-13.
 *   "no i do not have a disability and have not had one in the past"
 *   "i am not a protected veteran"
 *       the board's own option strings, read out of the corpus (see SELF_ID_VOCABULARY_NEGATIVE).
 *       They are here so that a value which has ALREADY been respelled once into the control's
 *       wording is still recognised as the statement it is, rather than reaching the ladder as an
 *       unrecognised string that falls through to a refusal.
 *
 * NOT A REFUSAL, AND THE TWO MUST NEVER CROSS. isDeclineToState is false for all three, which is
 * asserted rather than assumed: "no" is not "no answer", and neither long form carries a volition
 * verb, so the plain-negation branch of DECLINE_TO_STATE_RE cannot reach them.
 *
 * "Yes" is deliberately absent. The affirmative is a different claim with a different failure mode
 * and no measured need, and adding it here would be guessing at a wording nobody asked for.
 */
const SELF_ID_STATED_NEGATIVE_RE = new RegExp(
  [
    '^no$',
    '^no i do not have a disability and have not had one in the past$',
    '^i am not a protected veteran$',
  ].join('|'),
);

/** Is this text a stated negative self-identification rather than a refusal to state? */
export function isStatedSelfIdentificationNegative(text: string): boolean {
  return SELF_ID_STATED_NEGATIVE_RE.test(comparableOption(text));
}

/**
 * THE STATED NEGATIVE IN THE CONTROL'S OWN WORDS, the exact counterpart of the decline vocabulary
 * above and keyed the same way, on the handle rather than on the visible question text.
 *
 * MEASURED on 2026-08-13 against the prod packet corpus, not guessed. The option text is not
 * persisted with a packet, so it was recovered from the discovery signature, where managed
 * discovery concatenates a select's option text onto the label blob. Two signatures in the corpus
 * carry a complete, untruncated list, and they are the ONLY option vocabularies the corpus has ever
 * recorded for these two controls (75 recorded instances of each control, one distinct list each):
 *
 *   "veteran statusselect ...i identify as one or more of the classifications of protected veteran
 *    listed abovei am not a protected veterani decline to self-identify for protected veteran
 *    status eeo[veteran]"
 *   "disability statusselect ...yes, i have a disability, or have had one in the pastno, i do not
 *    have a disability and have not had one in the pasti do not want to answer eeo[disability]"
 *
 * So each control offers exactly three answers: the affirmative, the negative, and the opt-out. The
 * opt-out of each is already in SELF_ID_VOCABULARY_DECLINE; the negative of each is here.
 *
 * WHY THIS HAS TO EXIST AT ALL, and it is not the failure that was predicted. A bare "No" does not
 * merely miss these lists. chooseClosestOption refuses it, because "I am not a protected veteran"
 * adds a claim to "No", and eeoAnswerLadder then continues into DECLINE_WORDINGS, one of which the
 * list does carry. Measured on this corpus before the fix: a stored "No" resolved to
 * "I decline to self-identify for protected veteran status" and to "I do not want to answer". The
 * applicant would have stated an answer and had a refusal submitted in her name, which is the same
 * substitution the decline vocabulary forbids in the other direction.
 *
 * THREE CONTROLS ARE DELIBERATELY ABSENT. `race` and `gender` have no negative: the answer to them
 * is a category, not a yes or a no. `hispanic_ethnicity` does have one, and the corpus records its
 * list as ["Yes", "No", "Decline To Self Identify"], but its negative is the literal string "No",
 * which the ordinary exact-match stage already selects without help. An entry that restates the
 * stored value would add a claim of measurement without adding behaviour. Anything not listed here
 * falls through to the behaviour that shipped, which is the same failure-closed rule the decline
 * vocabulary uses: without a handle there is nothing to be confident about.
 *
 * This is a substitution of one statement for the same statement, never of a statement for a
 * refusal and never of a refusal for a statement. Every caller checks
 * isStatedSelfIdentificationNegative on the answer first.
 */
const SELF_ID_VOCABULARY_NEGATIVE: ReadonlyArray<{ handle: RegExp; wording: string }> = [
  { handle: /(?:^|\s)veteran_status$/i, wording: 'I am not a protected veteran' },
  {
    handle: /(?:^|\s)disability_status$/i,
    wording: 'No, I do not have a disability and have not had one in the past',
  },
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
 * The exact negative string this control offers, or undefined when the label does not say which
 * vocabulary it is using.
 *
 * Undefined for every employer-authored demographic question, which is the point of keying on the
 * handle: those labels end in a numeric question id rather than a handle, so
 * "are you a person living with a disability? 4000995002" matches nothing here and keeps the
 * applicant's own "No", which the ordinary matcher already answers on a plain Yes/No list.
 */
export function selfIdentificationNegativeWording(label: string): string | undefined {
  const normalized = label.trim().replace(/\s+/g, ' ');
  return SELF_ID_VOCABULARY_NEGATIVE.find((entry) => entry.handle.test(normalized))?.wording;
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

/**
 * The stated negative to leave on this control, given the negative she stored. Returns the stored
 * wording unchanged whenever the control does not name its own vocabulary, and never touches a
 * refusal or any other answer.
 *
 * The mirror of declineWordingForControl, and safe to compose with it in either order: an answer
 * cannot be both a refusal and a statement, so at most one of the two ever rewrites anything.
 */
export function negativeWordingForControl(label: string, answer: string): string {
  if (!isStatedSelfIdentificationNegative(answer)) return answer;
  return selfIdentificationNegativeWording(label) ?? answer;
}
