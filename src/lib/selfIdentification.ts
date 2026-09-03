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

/* ---------------------------------------------------------------------------------------------
 * A STATED SELF-IDENTIFICATION ANSWER, IN THE WORDS A CONTROL OFFERS.
 *
 * The three question patterns, the gender equivalence table and the federal race table below were
 * moved here from profileFieldResolution.ts on 2026-09-03, byte for byte and with their own
 * comments. Nothing about what they say changed; where they live did.
 *
 * WHY THEY MOVED, and it is the same reason comparableOption did. refreshKnownQuestionAnswers in
 * questionDiscovery.ts now has to ask the question the resolver asks - "does this string still
 * state the answer the profile holds?" - and profileFieldResolution imports questionDiscovery, so a
 * leaf module is the only home both readers can reach. Two copies of this vocabulary would drift,
 * and the drift would be a snapped demographic answer that one reader recognises and the other
 * silently replaces, which is exactly the defect measured below. profileFieldResolution re-exports
 * every name it exported before, so no import outside these two files changes.
 * ------------------------------------------------------------------------------------------- */

/** A race or ethnicity question, as opposed to the rest of the self-identification block. */
const EEO_RACE_QUESTION = /\brace\b|racial|ethnicit|ethnic\b/i;
/** Asked as its own yes/no on nearly every US form, and answered from its own stored preference. */
const EEO_HISPANIC_QUESTION = /hispanic|latin/i;
/* ANY gender self-identification ask, not only one that spells "gender identity".
 *
 * Measured 2026-09-03 on Hudson River Trading (packet 4a79eec1, greenhouse job-boards): the label
 * is "What is your gender?" and the employer's own options are Woman / Man / Non-binary / I don't
 * wish to answer. Her stored answer is "Female", which is not on that list, so nothing snapped and
 * a question Litos can answer was handed back to her - the only one of the four EEO controls that
 * failed, and it failed on vocabulary alone. The old pattern required the literal phrase "gender
 * identity", which that label does not carry, so the equivalence below never ran. */
const EEO_GENDER_IDENTITY_QUESTION = /\bgender\b|\bsex\b/i;

/* THE TWO SPELLINGS OF THE SAME ANSWER, both directions.
 *
 * Greenhouse's job-boards renderer offers Woman / Man; its older board and most other families
 * offer Female / Male. A stored answer in either vocabulary must reach a list written in the other,
 * and the ladder keeps HER wording first, so a list carrying her own spelling still wins. Only the
 * two paired terms are equivalent: nothing here rewrites a non-binary, self-described or declined
 * answer, which are hers alone. */
const EEO_GENDER_EQUIVALENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^female$/i, 'Woman'],
  [/^woman$/i, 'Female'],
  [/^male$/i, 'Man'],
  [/^man$/i, 'Male'],
];

/**
 * THE MAPPING RULE, and it is deliberately the narrowest one that works.
 *
 * A stored race value is rewritten to a US federal category ONLY when that category WHOLLY CONTAINS
 * it: the stored value names a subgroup that the federal definition of the category already
 * includes, so the rewrite loses detail and changes no membership. "South Asian" to "Asian" is that
 * shape - the EEOC defines Asian as origins in the Far East, Southeast Asia, or the Indian
 * subcontinent, so a person who wrote South Asian is inside Asian by the employer's own definition,
 * and the employer's list has no finer word to offer.
 *
 * Race is the applicant's own self-identification, so anything that is not a clean containment
 * declines instead of guessing, and declining is always available and always honest. The cases this
 * table deliberately does NOT contain, each for a stated reason:
 *
 *   "Central Asian"          the federal definition of Asian names the Far East, Southeast Asia and
 *                            the Indian subcontinent, and not Central Asia. Not a containment.
 *   "Asian/Pacific Islander" spans TWO federal categories. Picking either one narrows her answer.
 *   "Middle Eastern",        the enum has no such category and files them under White. That is a
 *   "North African"          contested reassignment, not a coarser word for the same thing.
 *   "Native American"        read as American Indian or Alaska Native by most, but not by all, and
 *                            it overlaps Native Hawaiian. Ambiguous, so it declines.
 *   "Indian"                 ambiguous between Asian Indian and American Indian. Never mapped.
 *
 * A category is only ever WIDENED. The reverse - a stored "Asian" against a list offering "South
 * Asian" and "East Asian" - is a narrowing, it invents detail she did not give, and chooseClosestOption
 * already refuses it because the extra word distinguishes the claim.
 */
const EEO_FEDERAL_RACE_CATEGORIES: ReadonlyArray<{ category: string; subgroup: RegExp }> = [
  { category: 'Asian', subgroup: /^(?:south|east|southeast|south east) asian$|^asian american$/ },
  { category: 'Black or African American', subgroup: /^(?:black|african american)$/ },
  { category: 'Hispanic or Latino', subgroup: /^(?:hispanic|latino|latina|latinx|latino\/a|hispanic\/latino)$/ },
  { category: 'Native Hawaiian or Other Pacific Islander', subgroup: /^(?:native hawaiian|pacific islander)$/ },
  { category: 'American Indian or Alaska Native', subgroup: /^(?:american indian|alaskan? native)$/ },
  { category: 'White', subgroup: /^(?:white|caucasian)$/ },
  { category: 'Two or More Races', subgroup: /^(?:multiracial|multi racial|biracial|bi racial|mixed race|two or more races)$/ },
];

/**
 * The single federal category that wholly contains a stored race value, or undefined.
 *
 * Undefined when NO category claims it and, just as deliberately, when more than one does: two
 * claimants is the ambiguity the rule above exists to refuse, and it must fail closed if this table
 * is ever extended carelessly.
 */
export function eeoFederalRaceCategory(stored: string): string | undefined {
  const key = comparableOption(stored);
  if (!key) return undefined;
  const claimed = EEO_FEDERAL_RACE_CATEGORIES.filter((entry) => entry.subgroup.test(key));
  if (claimed.length !== 1) return undefined;
  // Already the category itself: nothing to widen, and the exact stage would have taken it anyway.
  return comparableOption(claimed[0].category) === key ? undefined : claimed[0].category;
}

/**
 * The forms of a STATED self-identification answer, best first.
 *
 * Her own words at the head, then the wordings that say the same thing in a vocabulary a control is
 * more likely to use. NEVER a refusal: the decline wordings are appended one rung down by
 * eeoAnswerLadder, for the same reason "Other" is last on the referral ladder.
 */
export function selfIdentificationStatedForms(label: string, stored: string): string[] {
  const base = stored.trim();
  if (!base) return [];
  const coarser = EEO_RACE_QUESTION.test(label) && !EEO_HISPANIC_QUESTION.test(label)
    ? eeoFederalRaceCategory(base)
    : undefined;
  return [...selfIdentificationRespellings(label, base), coarser]
    .filter((value): value is string => Boolean(value?.trim()));
}

/**
 * THE SAME STATED ANSWER, RE-SPELLED: her own wording, then the paired term the other vocabulary
 * uses for that identical answer. Nothing else, ever.
 *
 * This is the FIRST RUNG of selfIdentificationStatedForms, split out because the second rung is a
 * different kind of act and one caller may only have the first. A re-spelling is SYMMETRIC and
 * lossless: EEO_GENDER_EQUIVALENTS carries Female/Woman and Male/Man in both directions, so
 * "Female" and "Woman" are one answer written twice and either may stand for the other. Widening
 * "South Asian" to "Asian" is one-way and loses detail; that is safe when a resolver is CHOOSING
 * which option to put into an empty control, and it is not the same act when something rewrites an
 * answer already stored in a packet, where leaving it alone means the applicant is asked and
 * answers for herself.
 *
 * So the two rungs have two callers. resolveProfileField and chooseEeoOption fill a control and
 * take both. snapAnswerToOfferedOption in questionDiscovery.ts rewrites a stored answer and takes
 * only this one; the rule and the measurement are on that function.
 *
 * NEVER A REFUSAL. The decline wordings are appended a rung further down by eeoAnswerLadder and
 * cannot reach either of these lists, which is the property both callers depend on.
 */
export function selfIdentificationRespellings(label: string, stored: string): string[] {
  const base = stored.trim();
  if (!base) return [];
  const equivalentGender = EEO_GENDER_IDENTITY_QUESTION.test(label)
    ? EEO_GENDER_EQUIVALENTS.find(([spelling]) => spelling.test(base))?.[1]
    : undefined;
  return [base, equivalentGender].filter((value): value is string => Boolean(value?.trim()));
}

/* THE SENTENCE A CONTROL USES TO SAY YES OR NO, per subject, because the answer is stored as a
 * polarity and the employer's list is written as a paragraph.
 *
 * MEASURED 2026-09-03 on two live forms, with eeo_prefs holding veteran_status "No" and
 * disability_status "No":
 *
 *   Verkada (greenhouse, packet f1b2df5a)
 *     veteran     "I don't wish to answer" / "I identify as one or more of the classifications of
 *                 a protected veteran" / "I am not a protected veteran"
 *     disability  "I do not want to answer" / "No, I do not have a disability and have not had one
 *                 in the past" / "Yes, I have a disability, or have had one in the past"
 *   Zeus Fire and Security (breezy, packet f04623c3)
 *     veteran     the same three, upper-cased, under name="eeoc.veteran_status"
 *     disability  "Yes, I have a disability, or have had one in the past" / "No, I don't have a
 *                 disability" / "I don't wish to answer"
 *
 * WHAT HAPPENED WITHOUT THIS TABLE, and it is worse than the blank it looks like. chooseEeoOption
 * ran the ladder for "No" - which is CLOSED_SET_ANSWER_RE, so no option may extend it - matched
 * nothing, and fell through to the stage that picks the sole option reading as a refusal. Measured
 * on the Verkada lists above, that stage returned "I don't wish to answer" for veteran and "I do
 * not want to answer" for disability, with matchedOption true, so nothing was even surfaced to her.
 * She said "No"; Litos was about to tell two employers she declined to say. A refusal states
 * nothing false, but it is not her answer, and this module's own rule is that a truthful specific
 * answer must never be displaced by a catch-all. On the Breezy disability list, whose only refusal
 * is worded "I don't wish to answer", the same substitution was one option away.
 *
 * A MATCHER, NOT A GENERATOR, and that is the whole safety of it. Nothing here writes a sentence
 * onto a form: each pattern can only recognise a sentence the EMPLOYER already wrote, and the
 * caller then requires exactly one option to match and refuses any option that reads as a refusal.
 * Both patterns for a subject are anchored at the start of the option so the two can never overlap:
 * "I am not a protected veteran" cannot satisfy `affirms`, and "Yes, I have a disability" cannot
 * satisfy `denies`.
 *
 * WHAT IS MEASURED AND WHAT IS REASONED, because the difference matters to whoever edits this next.
 *
 *   MEASURED. Veteran and disability, on the four live lists quoted above. Those are the two that
 *   were substituting a refusal for her answer, and they are the whole reason this table exists.
 *
 *   REASONED, not observed on any list this repo has recorded. Hispanic and transgender. Every
 *   hispanic control in the corpus offers a bare "Yes"/"No", which the exact stage already takes;
 *   the spelled-out wording is what other boards write, and eeo_prefs carries transgender_status
 *   "No" against the same yes/no-against-a-sentence shape. Both are written in the measured
 *   entries' style so a first sighting needs no new rule, and neither changes any measured list.
 *
 * Gender and race are deliberately ABSENT: neither is a yes/no question, their equivalences are the
 * two tables above, and a polar rule for them would have to invent a category she did not name.
 *
 * "I do not identify as having a disability" is deliberately NOT matched by the disability denial.
 * It is a real substantive claim and selfIdentificationDecline.test.ts pins it as one, but the
 * "identify as" family is the one this file has already been burned by, and the reach is not worth
 * it while every measured list carries the plain wording. */
type SelfIdentificationPolarClaim = {
  /** Tested against the comparable form of the LABEL. */
  subject: RegExp;
  /** Tested against the comparable form of an OPTION. */
  affirms: RegExp;
  denies: RegExp;
};

const SELF_ID_POLAR_CLAIMS: readonly SelfIdentificationPolarClaim[] = [
  {
    subject: /veteran|military/,
    affirms: /^(?:yes )?i (?:identify as one or more of the classifications\b|am (?:a |an )?(?:protected )?veteran\b)/,
    denies: /^(?:no )?(?:i am )?not (?:a |an )?(?:protected )?veteran\b/,
  },
  {
    subject: /disab/,
    affirms: /^(?:yes )?i have (?:a |an |any )?disabilit/,
    denies: /^(?:no )?i (?:do not|dont) have (?:a |an |any )?disabilit/,
  },
  {
    subject: /hispanic|latin/,
    affirms: /^(?:yes )?i am hispanic (?:or|and) latin/,
    denies: /^(?:no )?i am not hispanic (?:or|and) latin/,
  },
  {
    // REASONED, not measured on a live list. See the note above.
    subject: /transgender/,
    affirms: /^(?:yes )?i (?:am|identify as) (?:a )?transgender/,
    denies: /^(?:no )?i (?:am not|do not identify as|dont identify as) (?:a )?transgender/,
  },
];

/**
 * The one option on this control that states the stored yes-or-no answer, or null.
 *
 * Fails closed on every kind of doubt, and each condition is load-bearing:
 *
 *   - the stored answer must be the bare polarity. Anything else is already a sentence and belongs
 *     to the ordinary matcher, and restricting to "yes"/"no" means this rule can never reinterpret
 *     a race, a gender or a refusal.
 *   - exactly ONE subject may claim the label, so a label naming two of them answers neither.
 *   - exactly ONE option may match, because at that point there is nothing left to rank two
 *     look-alikes by and picking between them by DOM order is the guess this family must refuse.
 *   - an option that reads as a refusal is never eligible, whatever else it says. That is belt and
 *     braces: it keeps a wording like "I do not wish to answer whether I am a protected veteran"
 *     from ever being read as her denial.
 */
export function selfIdentificationPolarClaimOption(
  label: string,
  stored: string,
  options: readonly string[] | null | undefined,
): string | null {
  const polarity = stored.trim().toLowerCase();
  if (polarity !== 'yes' && polarity !== 'no') return null;
  const subject = comparableOption(label);
  if (!subject) return null;
  const claimed = SELF_ID_POLAR_CLAIMS.filter((claim) => claim.subject.test(subject));
  if (claimed.length !== 1) return null;
  const pattern = polarity === 'yes' ? claimed[0].affirms : claimed[0].denies;
  const matched = new Map<string, string>();
  for (const raw of options ?? []) {
    const option = typeof raw === 'string' ? raw.trim() : '';
    if (!option || isDeclineToState(option)) continue;
    const key = comparableOption(option);
    if (key && pattern.test(key)) matched.set(key, option);
  }
  return matched.size === 1 ? [...matched.values()][0] : null;
}

/**
 * Does `answer` still state what the profile says, for this control?
 *
 * The question refreshKnownQuestionAnswers asks about a snapped demographic answer, and the exact
 * converse of what chooseEeoOption does: an answer this says yes to is one the resolver would have
 * chosen from a list offering only it, for the profile value in hand.
 *
 * A REFUSAL FOR A REFUSAL AND A CLAIM FOR A CLAIM, never one for the other, which is why the
 * decline test comes before anything else. eeoAnswerLadder appends the decline wordings to every
 * ladder, so a membership test alone would say "Decline to self-identify" states a stored "No" -
 * the substitution this whole file exists to make impossible.
 */
export function selfIdentificationAnswerStates(label: string, stored: string, answer: string): boolean {
  const storedKey = comparableOption(stored);
  const answerKey = comparableOption(answer);
  if (!storedKey || !answerKey) return false;
  if (storedKey === answerKey) return true;
  if (isDeclineToState(answer) || isDeclineToState(stored)) {
    return isDeclineToState(answer) && isDeclineToState(stored);
  }
  if (selfIdentificationStatedForms(label, stored).some((form) => comparableOption(form) === answerKey)) {
    return true;
  }
  return selfIdentificationPolarClaimOption(label, stored, [answer]) !== null;
}
