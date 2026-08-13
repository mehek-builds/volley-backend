// Shared "does this claim trace back to the student's real data" helpers, used by the resume
// validator (engine/resumeValidate.ts) and the application-answer drafter (llm/applicationAnswer.ts).
// The product's hard rule (Mehek's #1 promise): never output an org, title, or number the student
// didn't actually provide. These functions turn that promise into deterministic checks instead of
// trusting the model prompt alone.

const STOPWORDS = new Set(
  `the and for with you your our are will from that this have they their who whom able strong good
using use used per via etc into across within a an of to in on at by as is be we i my me it its
also however than then them these those about when while after before`
    .split(/\s+/)
    .filter(Boolean),
);

// Content words (lowercased, stopwords + very short tokens removed). Used for org/title/proper-noun
// grounding by set membership.
export function wordSet(text: string): Set<string> {
  const words = (text.toLowerCase().match(/[a-z][a-z0-9+#.&/-]*/g) ?? []) as string[];
  return new Set(
    words
      .map((w) => w.replace(/[.+#&/-]+$/g, ''))
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w)),
  );
}

// A "metric" number: something quantitative, not an incidental digit inside an identifier. Matches
// $-amounts, k/m/b/x/% suffixed numbers (commas allowed), and bare 2+ digit numbers or decimals
// (commas allowed, so "40,000" is captured whole - not clipped to "40"). The leading lookbehind
// rejects digits glued to letters (S3, EC2, GPT-4-style tokens) so tech names aren't mistaken for
// fabricated metrics. Single bare digits (1-9) are ignored on purpose (too noisy to be a
// meaningful fabrication signal).
// The k/m/b/x/% suffix must be attached (no space) and not part of a longer word - otherwise
// "40,000 ms" would swallow the "m" of "ms" as a millions suffix.
const METRIC_NUMBER_RE =
  /(?<![a-z0-9])(?:\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?(?:k|m|b|x|%)(?![a-z])|\d[\d,]*\d(?:\.\d+)?|\d+\.\d+)\+?/gi;

function numStr(x: number): string {
  return Number.isInteger(x) ? String(x) : String(parseFloat(x.toFixed(6)));
}

// The metric-number strings in `text`, with ratio/date-like "N/N" patterns (e.g. "24/7", "12/2024")
// filtered out - those aren't standalone metrics, and "24/7" was previously mis-captured as the
// metric "24". Uses match positions so a number touching a slash-digit on either side is skipped.
function metricTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(METRIC_NUMBER_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const prev = start > 0 ? text[start - 1] : '';
    const prev2 = start > 1 ? text[start - 2] : '';
    const next = end < text.length ? text[end] : '';
    const next2 = end + 1 < text.length ? text[end + 1] : '';
    if ((next === '/' && /\d/.test(next2)) || (prev === '/' && /\d/.test(prev2))) continue;
    out.push(m[0]);
  }
  return out;
}

// Every comparable signature of a single number string. "40K", "40,000" and "40000" all reduce to
// the same expanded integer; a percentage and its decimal proportion reduce to the same tagged
// value so a source "0.40" grounds an output "40%" (and vice-versa). A bare count stays distinct
// from a proportion: "25%"/"0.25" -> "d:0.25", but plain "25" -> "25", so "a team of 25" still does
// NOT ground "25%". Multipliers ("3x") only ground their exact form.
function signaturesOf(raw: string): string[] {
  const t = raw.toLowerCase().replace(/[$,\s]/g, '').replace(/\+$/, '');
  if (!/\d/.test(t)) return [];
  const sigs = new Set<string>([t]); // raw normalized form, e.g. "40k", "25%", "3x", "0.40", "40"
  const pct = t.match(/^(\d+(?:\.\d+)?)%$/);
  if (pct) {
    const p = parseFloat(pct[1]) / 100;
    // Only a percentage that is itself a proportion in [0,1) maps to a decimal signature. A
    // percentage >= 100% ("380%") must NOT collapse to "d:3.8", or it would ground a bank decimal
    // >= 1 (e.g. a "3.8" GPA) and let a fabricated large percentage ship as verified.
    if (Number.isFinite(p) && p < 1) sigs.add(`d:${numStr(p)}`); // "40%" -> d:0.4
  } else if (/^\d+\.\d+$/.test(t)) {
    const d = parseFloat(t);
    // Symmetrically, only a decimal in (0,1) is percentage-equivalent; a decimal >= 1 (GPA, rating,
    // "1.5x"-style figure) is a distinct quantity and must not ground a percentage.
    if (Number.isFinite(d) && d < 1) sigs.add(`d:${numStr(d)}`); // "0.40" -> d:0.4
  } else if (!/[%x]$/.test(t)) {
    // Only unit-less numbers and k/m/b magnitudes expand to a comparable integer ("40k" <-> "40000").
    const m = t.match(/^(\d+(?:\.\d+)?)(k|m|b)?$/);
    if (m) {
      let val = parseFloat(m[1]);
      if (m[2] === 'k') val *= 1e3;
      else if (m[2] === 'm') val *= 1e6;
      else if (m[2] === 'b') val *= 1e9;
      if (Number.isFinite(val)) sigs.add(numStr(Math.round(val)));
    }
  }
  return [...sigs];
}

// The set of numeric signatures present in a source corpus (experience bank text, JD, etc.).
export function numberSignatures(text: string): Set<string> {
  const sigs = new Set<string>();
  for (const raw of metricTokens(text)) {
    for (const s of signaturesOf(raw)) sigs.add(s);
  }
  return sigs;
}

// The metric numbers in `generated` whose signatures are NOT present in `sourceSignatures`.
// Empty result = every number is grounded in the source.
export function ungroundedNumbers(generated: string, sourceSignatures: Set<string>): string[] {
  const out: string[] = [];
  for (const raw of metricTokens(generated)) {
    const sigs = signaturesOf(raw);
    const grounded = sigs.some((s) => sourceSignatures.has(s));
    if (!grounded) out.push(raw.trim());
  }
  return out;
}

/* A QUANTIFIED RESULT THAT TWO DIFFERENT ORGS BOTH CLAIM BELONGS TO NEITHER.
 *
 * The Truveta packet (fbc1d407) said of Traeco "cut agent response latency from 2.3s to 0.1s" and,
 * three sentences later, said of Tonee "authoring a specification that reduced latency from 2.3s to
 * 0.1s". Identical numbers, two unrelated projects, so at most one can be true and a reader who
 * notices discounts the whole letter.
 *
 * The generator did not invent this. Her experience bank holds the SAME figure under both orgs, so
 * every number in that letter passed ungroundedNumbers honestly. The bank is where the defect lives.
 * These helpers are the deterministic containment: while the source disagrees with itself about who
 * a figure belongs to, no drafter may attribute it to anyone.
 *
 * WHY TWO SHARED NUMBERS AND NOT ONE. Numbers repeat innocently across a real career: her bank has
 * "$14K from 7 sponsors" at Spark SC and a "14-point NPS increase" at Cinematica Labs, "24 pods" at
 * Cinematica and "24 participants" at Einstein Bros, "50+ interviews" at both SoFi and Traeco. One
 * number in common is a coincidence and blocking it would strip true claims out of good letters. Two
 * or more numbers in common between the same two orgs is a copied claim: measured against her real
 * bank on 2026-08-09, the >=2 threshold flags exactly the Tonee/Traeco pair and nothing else.
 *
 * The comparison runs on signatures, so "40K" under one org still collides with "40,000" under
 * another, but uniqueness is counted on the raw token so a decimal below 1 (which always carries
 * both its own form and a "d:" proportion signature) cannot reach the threshold by itself.
 */
export type AttributedMetrics = { org: string; text: string };

function normalizedOrg(org: string): string {
  return org.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// raw metric token -> its signatures, per normalized org.
function metricsByOrg(sources: AttributedMetrics[]): Map<string, Map<string, string[]>> {
  const byOrg = new Map<string, Map<string, string[]>>();
  for (const source of sources) {
    const key = normalizedOrg(source.org ?? '');
    if (!key) continue;
    const tokens = byOrg.get(key) ?? new Map<string, string[]>();
    for (const raw of metricTokens(source.text ?? '')) {
      const sigs = signaturesOf(raw);
      if (sigs.length > 0) tokens.set(sigs[0], sigs);
    }
    byOrg.set(key, tokens);
  }
  return byOrg;
}

/**
 * Figures that more than one org in the source claims, so none of them may be attributed.
 * `labels` is for prompt and operator text; `signatures` is what a generated draft is checked against.
 */
export function contestedMetrics(sources: AttributedMetrics[]): { labels: string[]; signatures: Set<string> } {
  const byOrg = metricsByOrg(sources);
  const orgs = [...byOrg.keys()];
  const labels = new Set<string>();
  const signatures = new Set<string>();
  for (let i = 0; i < orgs.length; i += 1) {
    for (let j = i + 1; j < orgs.length; j += 1) {
      const left = byOrg.get(orgs[i])!;
      const right = byOrg.get(orgs[j])!;
      const shared: Array<[string, string[]]> = [];
      for (const [token, sigs] of left) {
        const collides = [...right.values()].some((other) => sigs.some((sig) => other.includes(sig)));
        if (collides) shared.push([token, sigs]);
      }
      if (shared.length < 2) continue;
      for (const [token, sigs] of shared) {
        labels.add(token);
        for (const sig of sigs) signatures.add(sig);
      }
    }
  }
  return { labels: [...labels].sort(), signatures };
}

/** The metric numbers in `generated` that match a contested signature. Empty = nothing contested is claimed. */
export function contestedMetricsUsed(generated: string, signatures: Set<string>): string[] {
  if (signatures.size === 0) return [];
  const out = new Set<string>();
  for (const raw of metricTokens(generated)) {
    if (signaturesOf(raw).some((sig) => signatures.has(sig))) out.add(raw.trim());
  }
  return [...out];
}

/* A PROMISE IS NOT A FACT, AND PROSE IS NOT THE PLACE TO MAKE ONE.
 *
 * The same Truveta packet wrote "I am based in Los Angeles but able to work from the Greater Seattle
 * area for this internship". She lives in Dubai and is enrolled in Los Angeles, and she never said
 * either half of that sentence. Truveta's form asks whether the applicant will be in the Seattle
 * area and can come into the Bellevue office; the letter answered that question in prose, as a
 * promise, where nothing could check it.
 *
 * This is the same defect resolveKnownAnswer shed when `case 'onsite_commitment': return { value:
 * 'Yes' }` was deleted, one layer further out. The rule that replaced it is the rule here: Litos may
 * REPORT a fact on file and may never MAKE a commitment on her behalf. Where she lives, where she
 * will sit, when she is free, how long she will stay, and what she will not do elsewhere are all
 * commitments.
 *
 * SO THE COVER LETTER NEVER MAKES ONE, whatever the posting asks. There is no "backed by a stored
 * fact" branch here on purpose: the columns that hold those declarations (address_city,
 * onsite_commitment, onsite_locations, relocation_willingness) are not in the drafter's candidate
 * source at all, and even if they were, a structured question with a reviewable answer is the right
 * surface for them and questionDiscovery.ts already owns it. When a posting genuinely needs the
 * statement, leaving it out surfaces the question to a human, which is the outcome the resolver
 * already produces. Silence is safer than an invented promise.
 *
 * Deliberately narrow. Every pattern needs a first-person forward-looking frame or a word that has
 * no other business in a cover letter, so a past-tense achievement ("conducted 47 user interviews in
 * person") and a stored fact ("an expected graduation date of May 2028") both pass untouched.
 * Measured over all 136 stored letters on 2026-08-09: 8 flagged, every one a genuine promise.
 */
const COMMITMENT_CLAIM_RES: RegExp[] = [
  // Where she lives. "I am based in Los Angeles", "I'm currently located in ...".
  /\bi(?:'m| am)\s+(?:currently\s+)?(?:based|located|living|residing|situated)\b/i,
  // Moving house, in any form.
  /\brelocat(?:e|es|ed|ing|ion)\b/i,
  // Willingness to be somewhere or to begin. "able to work from the Greater Seattle area".
  /\b(?:able|available|willing|happy|prepared|ready|open)\s+to\s+(?:work|be|commute|travel|relocate|move|come|report|attend|start|begin|join|split|spend)\b/i,
  // Being in an office. "the flexibility to work in-office in the Greater Seattle area".
  /\b(?:work|works|working|be|being|sit|sitting)\s+(?:on[\s-]?site|onsite|in[\s-]?person|in[\s-]?office|in the office|from the office)\b/i,
  /\bcommut(?:e|es|ing)\b/i,
  /* When she is free and for how long. "I'm available for a 12-14 week internship in Austin".
   * "available for" needs a TERM after it, not just an article: "I made the results available for
   * the whole team" is a past-tense achievement and reads identically up to the object. */
  /\bavailable\s+(?:to\s+start\b|from\s+\w+\s+\d|beginning\b|for\s+(?:an?\s+|the\s+|either\s+|both\s+)?(?:\d|(?:fall|spring|summer|winter|full[\s-]?time|part[\s-]?time|twelve|eleven|ten|nine|eight|seven|six|\w+[\s-]week|week|month|internship|term|semester|quarter|co-?op)\b))/i,
  // Hours or duration promised. "can commit to full-time hours in office in Austin".
  /\b(?:can|could|will|would|able to|happy to)\s+commit\b|\bi\s+commit\s+to\b/i,
  // A start date.
  /\bstart\s+date\b|\bi\s+(?:can|could|will|would)\s+start\b/i,
  // Exclusivity and non-competes.
  /\bexclusiv(?:e|ely|ity)\b|\bnon[\s-]?compete\b|\bno other (?:offers|applications|companies)\b/i,
];

/**
 * Sentences in `text` that promise something on the candidate's behalf rather than report a fact.
 * Empty result = the draft makes no commitment. Returned as whole sentences so the operator (and the
 * regeneration feedback) can see exactly which line has to go.
 */
export function unsupportedCommitments(text: string): string[] {
  const sentences = (text ?? '')
    /* The next character has to look like a sentence opening, or "I'm a U.S. citizen and available
     * for a twelve-week internship this fall" breaks after "U.S." and the operator is handed a
     * fragment starting mid-clause. A lowercase word after a period is an abbreviation, not a new
     * sentence. Two real sentences that fail to split are harmless here: the pair is returned
     * together and the promise is still shown. */
    .split(/(?<=[.!?])\s+(?=["'([]?[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const found: string[] = [];
  for (const sentence of sentences) {
    if (COMMITMENT_CLAIM_RES.some((re) => re.test(sentence))) found.push(sentence);
  }
  return found;
}

// Replace em/en dashes with a comma (or fold into adjacent sentence punctuation) so drafted text
// never ships a dash. Global hard rule = zero em dashes, and essay warnings aren't surfaced by the
// extension, so the answer path strips rather than only warns.
export function stripEmDashes(s: string): string {
  return s
    .replace(/\s*[—–]\s*/g, ', ') // em/en dash -> comma + space
    .replace(/,\s*,/g, ', ') // collapse any doubled commas
    .replace(/,\s*([.!?;:])/g, '$1') // ", ." -> "."
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s*,\s*/, '') // no leading comma (dash at start)
    .replace(/\s*,\s*$/, '') // no trailing comma (dash at end)
    .trim();
}

// Sentence/pronoun capitalization that isn't an organization or proper noun of interest.
const COMMON_CAPS = new Set(
  `I A The A An My Our We You Your This That It Its They Their As At In On Of To With For And But So
After Before When While Also However Here There If Then Because During Since Given Building Working
Using Leading Since`.split(/\s+/),
);

// Best-effort proper-noun grounding for free-text essays: capitalized multi-word phrases (or
// all-caps acronyms) whose content words don't appear in the corpus. Heuristic, so callers treat
// the result as review WARNINGS, never a hard block - it can over-flag legitimate phrasing.
export function ungroundedProperNouns(text: string, corpus: Set<string>): string[] {
  const found = new Set<string>();
  /* Do not begin a candidate phrase in the middle of a hyphenated word. The live Scale AI letter
   * contains "Object-Oriented Programming". wordSet correctly keeps "object-oriented" as one
   * grounded token, but the proper-noun matcher used to start after the hyphen and report
   * "Oriented Programming" as an unknown name. That warning asks the applicant to review a person
   * who does not exist. The same boundary applies to the two Unicode range separators an employer
   * or model may use, written as escapes so the prohibited glyphs never enter the source. */
  const re = /(?<![-\u2013\u2014])\b([A-Z][a-zA-Z0-9&.]+(?:\s+[A-Z][a-zA-Z0-9&.]+){0,3})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const phrase = m[1];
    const words = phrase.split(/\s+/);
    const isAcronym = words.length === 1 && /^[A-Z]{2,}$/.test(words[0]);
    // Only consider multi-word Capitalized phrases and standalone all-caps acronyms; a single
    // ordinary Capitalized word is almost always sentence-initial, not an org.
    if (words.length < 2 && !isAcronym) continue;
    const contentWords = words.filter((w) => !COMMON_CAPS.has(w));
    if (contentWords.length === 0) continue;
    const allGrounded = contentWords.every((w) => corpus.has(w.toLowerCase().replace(/[.&]/g, '')));
    if (!allGrounded) found.add(phrase);
  }
  return [...found];
}

// R-042: ranking/ordering asks. A "rank these languages" question invites naming items from the
// QUESTION's own list, and every item positively ranked is a skill claim in the student's name -
// which is how a live draft said "Python first, JAVA second" against a declared list with no Java
// (R-015's disease through a new door: the resume's SKILLS pruning and the prose grounding rule
// both key on the student's own material, and neither sees a ranking's item list). These helpers
// are the deterministic half of the fix; the prompt rule in llm/applicationAnswer.ts is the other
// half, and llm/applicationAnswer.ts wires both to the declared skills list (R-015's authority).

// Does the question ask the student to rank/order items? Deliberately keyword-narrow: "in order
// to" is everywhere in application questions and must never trigger, so bare "order" only counts
// with a ranking object ("order these", "in order of preference") or a list-then-order shape.
const RANKING_ASK_RES = [
  /\brank(?:ing|ed)?\b/i,
  /\bin (?:the )?order of\b/i, // "in order of preference/proficiency"
  /\b(?:list|sort|arrange|order)\b[^.?!]*\bin order\b/i, // "list your languages in order"
  /\border (?:them|these|those|the following|your)\b/i,
  /\bfrom (?:most|strongest|best)\b[^.?!]*\bto (?:least|weakest|worst)\b/i,
];

export function isRankingAsk(question: string): boolean {
  return RANKING_ASK_RES.some((re) => re.test(question));
}

// One candidate-list segment -> its items. Splits on commas/semicolons/newlines plus "and"/"or"
// joiners, then keeps only item-shaped pieces (short, at most 3 words): a colon followed by prose
// ("Rank your priorities: tell us what matters most to you") produces sentence-length fragments
// that all fail the shape filter, so it extracts nothing instead of inventing a list.
function splitListSegment(segment: string): string[] {
  return segment
    .replace(/^\s*(?:e\.g\.|for example|such as|including)[,:]?\s*/i, '')
    .split(/[,;\n]/)
    .flatMap((part) => part.split(/\s+(?:and|or)\s+/i))
    .map((s) => s.trim().replace(/^\(|[).?!]+$/g, '').trim())
    .filter((s) => s.length > 0 && s.length <= 40 && s.split(/\s+/).length <= 3)
    .filter((s) => !/^(?:etc|and so on)\.?$/i.test(s));
}

// The question's own candidate list, when it names one. Sources, most explicit first: a
// parenthesized list "(Python, Java, C++)", then a colon tail "rank these: Python, Java, Go".
// A single survivor is not a list, so each source needs 2+ item-shaped pieces to count. Missing
// an item here only narrows enforcement (the prompt rule still applies); it can never add a
// false claim, so the extraction stays conservative on purpose.
export function extractRankedItems(question: string): string[] {
  const paren = question.match(/\(([^)]*,[^)]*)\)/);
  if (paren) {
    const items = splitListSegment(paren[1]);
    if (items.length >= 2) return items;
  }
  const colon = question.lastIndexOf(':');
  if (colon !== -1) {
    const items = splitListSegment(question.slice(colon + 1));
    if (items.length >= 2) return items;
  }
  return [];
}

// Whole-item mention test, safe for symbol-bearing names ("C++", "C#") where \b sits on the wrong
// side of the "+"/"#": the lookarounds stand in for word boundaries so "C" is not claimed by an
// answer that says "C++", nor "Java" by "JavaScript". Case-insensitive on purpose: the live miss
// ranked "JAVA" where the question wrote "Java".
function itemMentionRe(item: string): RegExp {
  const escaped = item
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  return new RegExp(`(?<![a-z0-9+#])${escaped}(?![a-z0-9+#])`, 'i');
}

// The unheld question items the drafted answer still names. ANY mention is treated as a claim:
// "positively ranked" versus "honestly disclaimed" is a judgement call a deterministic check
// cannot make, so the prompt tells the model to omit unheld items entirely and this enforces
// exactly that. Stricter than an honest "I have not used Java" needs, and that is the right
// failure direction (same reasoning as pruneUngroundedContent: fewer claims, all of them real).
export function claimedUnheldItems(answer: string, unheldItems: string[]): string[] {
  return unheldItems.filter((item) => item.trim().length > 0 && itemMentionRe(item).test(answer));
}
