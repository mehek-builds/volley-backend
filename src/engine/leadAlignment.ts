import { extractJdSignals } from './jdSignals';
import type { JdContext } from './jdMatch';
import type { ResumeSpec } from '../llm/resumeSpec';
import { monitoredDescriptionHash } from '../lib/monitoredPortalRepair';

/**
 * WHAT "THE TOP EXPERIENCE IS ALIGNED FOR THEIR ROLE" MEANS, STATED SO A MACHINE CAN CHECK IT.
 *
 * The tailoring prompt has always asked for "most relevant first", and the model has always
 * answered by putting the most RECENT entry first. Measured across 85 production packets for one
 * applicant: 71 led with the same entry, and the decisive pair - a Quantitative Trading Analyst
 * posting and a GPU Systems Research posting - came back with the same lead org, the same three
 * bullets and identical prose, differing only in which of bullets 2 and 3 came second. The skills
 * line diverged cleanly on that same pair (77 distinct values across the 85), so the model was
 * reading the posting; it simply was not treating the lead entry as a question it had to answer.
 * A resume is reverse-chronological in almost every document the model has ever seen, so absent a
 * forcing function it writes one.
 *
 * A GENERIC OVERLAP SCORE WAS TRIED FIRST AND REJECTED. A broad bag of words ranked a Program
 * Management internship top for a Test Automation Engineer posting on coincidental words such as
 * "intern", "through" and "system". The deterministic selector below instead permits a candidate
 * only when a domain-bearing term occurs in both a primary JD requirement and an existing bullet.
 * Generic language cannot create a candidate or affect the ordering.
 *
 * THIS FILE CHOOSES AND CHECKS THE LEAD. The selector ranks only supported JD and bullet pairs,
 * moves the winning existing entry to the front, and records `lead_alignment` metadata naming the
 * exact requirement and evidence bullet. Both citations are verified against the frozen JD and
 * selected bullet, and the JD hash binds the decision to the posting used to make it. The check
 * therefore has three properties that matter here:
 *
 *   1. It is not satisfiable by recency. "It is her current job" is not a requirement quoted from
 *      the posting, so a model that leads with the most recent entry has to go and find a
 *      requirement that entry actually proves. On a Product Management internship, looking for
 *      that requirement is what surfaces the entry whose bullets say "defined product requirements"
 *      instead.
 *   2. IT CANNOT INVENT ANYTHING, which is the non-negotiable constraint on this system. Both
 *      citations must already exist word for word; nothing here writes, rewrites, merges or moves
 *      a bullet, and `lead_alignment` is metadata that no renderer reads. The strongest thing a
 *      failed check can do is ask the model to choose again. See leadAlignment.test.ts, which pins
 *      that property in both directions.
 *   3. It is measurable after the fact. Every shipped packet records which requirement its lead
 *      claims to prove, so "is the top experience aligned" stops being a matter of opinion.
 */
export interface LeadAlignment {
  /** The org of the entry this justifies. Always the FIRST entry; carried so the claim says which
   *  entry it is about rather than relying on position surviving every later transform. */
  entry_org: string;
  /** Verbatim from the job description. */
  requirement: string;
  /** Verbatim one of the first entry's own selected bullets. */
  evidence: string;
  /** Hash of the exact JD text used to make the choice. New packets always carry it; optional so
   *  specs generated before this field existed can still be read and explicitly re-evaluated. */
  jd_hash?: string;
}

/* Folded for comparison only, never for output. Curly quotes, the various dashes and non-breaking
   spaces all differ between what a job board serves and what a model echoes back, and a citation
   rejected over a typographic apostrophe would be a false accusation of fabrication.
 *
 * EVERY DASH RUN COLLAPSES TO ONE SPACELESS HYPHEN, and that is load-bearing rather than tidy.
 * `requirement` is compared against the RAW job description, but by the time it reaches here it
 * has been through applyResumePolicy's normalizeDashesForPrint, which walks every field of the
 * spec and rewrites an em dash as " - ". So a quote the model copied faithfully out of a posting
 * no longer matches that posting character for character, and a naive comparison would report a
 * fabricated requirement for every posting that happens to contain one. Folding both sides the
 * same way makes the check immune to it. It also, deliberately, reads "end-to-end" and "end to
 * end" as the same string, which is the right answer for a citation check either way. */
export function foldForCitation(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/\s*[-\u2010-\u2015\u2212]+\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Deliberately short. This list only has to stop the words that co-occur in ANY requirement and ANY
   bullet from counting as evidence of a connection; it is not a general-purpose stoplist, and
   anything domain-bearing must stay out of it so it keeps counting. */
const CITATION_STOPWORDS = new Set(
  ('the and for with from that this into using used your our their they them are was were have has will '
    + 'you can all any not but its out who what when how across each other more most new such we us an of in on '
    + 'to at by or as is be it also than then over under both very own same so only work working team teams '
    + 'role about across within while including include includes ability able strong experience experienced')
    .split(/\s+/),
);

/**
 * The forms the suffix rules below cannot reach. The first four are irregular: English does not
 * spell their past tense by adding letters to the end.
 *
 * THE `programm-` GROUP IS NOT IRREGULAR, IT IS A DISAMBIGUATION, and it is here because the suffix
 * rules are RIGHT about it and right is not good enough. "programming" strips its -ing to
 * "programm" and the double-letter rule then correctly restores "program", because English doubles
 * a final consonant before a suffix. The trouble is that the word it correctly restores is a
 * homonym: `program` the verb (to write code) and `program` the noun (a scheme, a cohort, a
 * curriculum) are one string and two unrelated meanings. So "You have strong problem solving and
 * programming skills" shared a token with "Analyzed 183 program surveys using RICE prioritization"
 * and handed a software internship to a Program Management entry.
 *
 * Stopping `program` in LEAD_DECISION_STOPWORDS was tried first and measured identically on this
 * corpus, and it is the worse fix, because it deletes BOTH senses for every posting rather than
 * separating them. Measured on the four probes: with the stopword, "programming" no longer matches
 * "programmer" at all, and "programming skills" still wrongly matches "program surveys". With the
 * split, "programming" matches "programmed" and "programmer" on `programm`, "program" still matches
 * "program" for a genuine programme-management posting, and the two senses no longer touch.
 *
 * Only the doubled spellings are listed. They arise from nothing but the code sense, which is what
 * makes the enumeration closed rather than a guess.
 */
const LEAD_IRREGULAR_TERMS = new Map<string, string>([
  ['built', 'build'],
  ['shipped', 'ship'],
  ['shipping', 'ship'],
  ['wrote', 'write'],
  ['programming', 'programm'],
  ['programmed', 'programm'],
  ['programmer', 'programm'],
  ['programmers', 'programm'],
]);

/**
 * ONE CUT, USED BY BOTH SIDES OF THIS FILE. The selector below decides which entry leads; the check
 * further down decides whether the stored citation is honest. They are the same question asked
 * twice, so they must agree on what a word is.
 *
 * THEY DID NOT. Selection tokenized with `[a-z][a-z0-9+#.]{2,}` and validation with
 * `[a-z][a-z0-9+#]{2,}`: one character class apart, and that character was the full stop. A word
 * ending a sentence kept its period in the selector and lost it in the check, so the two halves of
 * this module read the same posting differently.
 *
 * MEASURED ON PACKET 1d1de862 (SEEKA, "Software Engineer Internship - Testing, Technical Analysis,
 * and Automation"). The posting asks "Work on automation projects to improve development and
 * testing efficiency and reliability." and an AI Engineer bullet reads "...surfaced reliability gaps
 * for prioritization". The shared word is `reliability`, and it did not count, because the JD's copy
 * carried the sentence's period and the bullet's did not. In the same packet
 * "...recommend improvements." matched "...inform UX improvements." - both sentence-final, both
 * padded identically - and a Product Management entry therefore led a test-automation posting on a
 * word the two documents only shared by punctuation. The period also made the token 13 characters
 * against `automation`'s 10, which decided the old length tie-break. One character class, three
 * consequences.
 *
 * THE RULE. A dot at the END of a token is a full stop and is cut off. A dot INSIDE one is the
 * punctuation that says "technical name", and such a token yields BOTH its joined form and each of
 * its parts: `Node.js` gives `nodejs` and `node`, `ASP.NET` gives `aspnet`, `asp` and `net`. The
 * joined form is what makes `Node.js` and `node.js` one term, and it is the treatment normalizeTerm
 * already gives dots in jdMatch. The parts are what keep a posting that writes `Node.js` matching a
 * bullet that writes `Node`, which the old validation tokenizer did by splitting and which a
 * joined-only rule would have quietly taken away. Neither is stemmed: a name is not English, and
 * without that guard `node.js` loses the 's' it is spelled with and keys as `nodej`.
 *
 * A BARE `-js` SPELLING IS ALSO A NAME. No English plural ends in `js`, so `nodejs`, `reactjs` and
 * `vuejs` are exempt from singularisation too; before this they keyed as `nodej`, `reactj` and
 * `vuej` and matched nothing at all.
 *
 * `C++` and `C#` keep the characters they are spelled with. Hyphens remain separators on both sides,
 * which is what already made "real-time" and "real time" read alike.
 *
 * Stemming is otherwise crude singularisation, matching the intent of resumeCovers in jdMatch: a
 * posting that writes "shipping consumer products" and a bullet that writes "shipped consumer
 * product" are talking about the same thing, and the check would be worthless if it were not.
 * Nothing here maps one word onto a DIFFERENT word - only a word onto its own other form.
 */
function comparisonTerms(text: string): Set<string> {
  const terms = new Set<string>();
  /* THREE, not four. A four-character floor silently deleted the shortest and most load-bearing
     words in this domain: gpu, sql, api, aws, git, and "end". Measured on the Redwood Materials
     packet, the ask "You'll own a scoped project end to end" and the bullet "Shipped consumer
     mobile app end-to-end; designed feature set and UX in Figma" were reported as having nothing
     in common, because the only word they share is three letters long. That is a false accusation
     of an arbitrary pairing against a citation that is exactly right.
     Two stays out: it is where the initialisms stop and the prepositions start, and it is also
     where `e.g` lands once its dots are gone, which is the right place for it. */
  const add = (term: string) => {
    if (term.length >= 3 && !CITATION_STOPWORDS.has(term)) terms.add(term);
  };
  for (const raw of foldForCitation(text).match(/[a-z][a-z0-9+#.]*/g) ?? []) {
    const trimmed = raw.replace(/\.+$/, '');
    const token = trimmed.replace(/\./g, '');
    if (!token || CITATION_STOPWORDS.has(token)) continue;
    if (trimmed.includes('.')) {
      add(token);
      for (const part of trimmed.split('.')) add(part);
      continue;
    }
    if (/js$/.test(token)) {
      add(token);
      continue;
    }
    add(LEAD_IRREGULAR_TERMS.get(token) ?? token
      .replace(/ies$/, 'y')
      .replace(/(?:ing|ed)$/, '')
      .replace(/(?:es|s)$/, '')
      .replace(/([a-z])\1$/, '$1'));
  }
  return terms;
}

/**
 * Words that can truthfully occur in both almost any software posting and almost any technical
 * resume bullet, but cannot decide which experience is most like the job. They may strengthen a
 * citation after a specific match exists; they can never create a candidate by themselves.
 *
 * EVERY MEMBER OF THE SECOND GROUP WAS COUNTED BEFORE IT WAS ADDED. Two counts are quoted, both
 * over the 158 packets this applicant has generated: how many winning citations the word appeared
 * in, and - the one that decides whether it belongs here - how many leads move when it is added,
 * holding everything else in this file fixed. A word that changes nothing is not on this list.
 *
 *   through     11 citations, moves 3 leads. A preposition. It joined "Work closely with a mentor
 *               to guide you through the internship" to "identified 6 resource bottlenecks through
 *               utilization analysis" and put a Program Management internship on top of a Cloudflare
 *               software posting, then joined DRW's "immediate responsibility through assignments"
 *               to the same bullet on a Quantitative Trading posting. The module header above
 *               already records that a generic overlap score was tried and rejected for ranking a
 *               Program Management internship first on "intern", "through" and "system". Two of
 *               those three were stopworded at the time and this one was not, so the documented
 *               failure came back.
 *   critical    10 citations, moves 5 leads. An intensifier. "Superior numerical, analytical, and
 *               critical thinking skills" and "Demonstrated critical thinking skills" were both
 *               proved by "...enabling smooth real-time experience critical for content
 *               consumption": two unrelated senses of one word. On the five Palantir packets it
 *               displaced "Build custom applications, LLM workflows, and production solutions
 *               engineered for a specific customer" proved by "Built LLM-agent cost infrastructure".
 *   cros        7 citations, moves 7 leads (the two are inseparable; each alone moves 2). This is
 *   functional  "cross-functional", which the shared tokenizer cuts at the hyphen and reduces the
 *               double letter of, so the compound has to be stopped in both halves or either half
 *               re-creates the candidate. It describes how a team is arranged rather than what it
 *               does, appears in most postings, and appears in this applicant's Program Management
 *               bullet, so it ranked that entry first on GPU, frontend and data-science postings.
 *
 * Words that measured as frequent but NOT generic stayed out. `technical` leads this corpus (23
 * citations, 23 of them the only supported word) and is not here: it separates technical work from
 * non-technical work, which is exactly the distinction this selector exists to draw, and stopping
 * it would leave 23 packets with no supported citation at all. `week` was measured and moves 0
 * leads, so it is not here either. `program` was on this list and has been taken off: it moves 7
 * leads, but it is not a generic word, it is two words sharing a spelling, and LEAD_IRREGULAR_TERMS
 * separates them at the stemmer for the same 7 leads without deleting either sense.
 */
const LEAD_DECISION_STOPWORDS = new Set([
  'application', 'build', 'built', 'create', 'created', 'data', 'develop', 'developed', 'engineer',
  'engineering', 'feature', 'implement', 'implemented', 'intern', 'internship', 'project', 'research',
  'software', 'solution', 'system', 'technology', 'tool', 'work',
  'critical', 'cros', 'functional', 'through',
]);

interface LeadCandidate {
  entryIndex: number;
  askIndex: number;
  evidence: string;
  requirement: string;
  supportedTerms: string[];
  specificTerms: string[];
  /** How much of this resume the supported terms distinguish. See distinguishingPower. */
  distinguishing: number;
}

export interface JdLeadSelectionResult {
  spec: ResumeSpec;
  issues: string[];
  supported_terms: string[];
}

/**
 * HOW MUCH A TERM DISTINGUISHES ONE ENTRY FROM THE REST, which is the only question a tie-break
 * between entries can usefully ask. A word that occurs in the bullets of every entry on the resume
 * is equally available to all of them and therefore cannot be the reason one of them leads; a word
 * only one entry uses is exactly the evidence that separates them. The score is, per supported
 * term, the number of experience entries that do NOT contain it, summed: an integer, so the
 * comparison is exact and independent of the order candidates happen to be visited in.
 *
 * WHAT THIS REPLACED, AND WHY IT HAD TO GO. The tie-break here used to be the total CHARACTER COUNT
 * of the matched terms - longer string wins. Length is a proxy for nothing: it prefers `stakeholder`
 * to `python` and `improvements.` to `automation`, and on packet 1d1de862 it did exactly that, since
 * a trailing full stop padded a coincidental match to 13 characters against a real one at 10. Every
 * one of that packet's four entries tied at one supported term, so two characters of punctuation
 * chose the lead experience on a test-automation posting.
 *
 * RARITY ACROSS THE POSTING'S OWN ASKS WAS TRIED FIRST AND MEASURED WORSE. Scoring a term by how
 * few of the posting's asks mention it sounds like the same idea and is not: it rewards whichever
 * word the posting happens to say once, and on the truveta packet it promoted `program` - the stem
 * of "programming language" - over `technical`, handing a software internship to a Program
 * Management entry. Over the 158 packets this applicant has generated it left 32 leads in the wrong
 * discipline against 30 for the rule above.
 */
function distinguishingPower(terms: string[], entryTermCounts: Map<string, number>, entryCount: number): number {
  return terms.reduce((sum, term) => sum + (entryCount - (entryTermCounts.get(term) ?? entryCount)), 0);
}

/**
 * THE LAST LINE OF THIS FUNCTION IS THE MODEL'S OWN ENTRY ORDER, AND IT IS NOW REACHABLE.
 *
 * That is deliberate: when two entries prove the same ask with the same number of terms and the
 * same distinguishing power, there is no evidence left to separate them, and the model's ordering
 * is the best remaining signal. It was also true before this change and simply never fired, because
 * a sum of character lengths almost never ties, while a sum of small integers often does. Measured
 * over the 158 packets, under every permutation of the experience list: base decided the same lead
 * on 158/158, this chain on 153/158. Of the 5, four are Flow Traders packets where both candidates
 * are engineering entries and the discipline is the same either way; one, Skydio 13bccb2d, is a
 * Product Management posting where the two candidates are a Founder entry and an AI Engineer entry,
 * so the order the model emitted decides whether that lead is in the right discipline.
 *
 * IT MATTERS FOR MEASUREMENT TOO. Stored packets carry their experience list post-selection, so the
 * previously chosen lead sits at index 0, and on those 5 an A/B re-run reproduces the stored answer
 * partly because of where the entry already sat rather than because of the evidence. Any figure
 * quoted from that A/B carries an uncertainty of one packet for this reason.
 */
function candidateIsBetter(next: LeadCandidate, current: LeadCandidate | null): boolean {
  if (!current) return true;
  /* Evidence strength leads. This prevents one coincidental word in the first ask from beating an
   * entry that repeats the posting's actual domain language. How far those words separate this
   * entry from the others breaks equal counts, then posting order, then the model's stable entry
   * order as the final deterministic tie-break. */
  if (next.specificTerms.length !== current.specificTerms.length) {
    return next.specificTerms.length > current.specificTerms.length;
  }
  if (next.supportedTerms.length !== current.supportedTerms.length) {
    return next.supportedTerms.length > current.supportedTerms.length;
  }
  if (next.distinguishing !== current.distinguishing) return next.distinguishing > current.distinguishing;
  if (next.askIndex !== current.askIndex) return next.askIndex < current.askIndex;
  return next.entryIndex < current.entryIndex;
}

/**
 * Choose the lead entry from evidence that occurs on BOTH sides of the application packet.
 *
 * This is deliberately narrower than a semantic similarity score. A term can affect ordering only
 * when the frozen JD requirement and the selected bullet both contain it. Broad words such as
 * "software", "system" and "build" cannot create a match. The function never writes content: it
 * only moves one already-grounded entry to position zero and records verbatim citations.
 */
export function selectJdAlignedLead(
  spec: ResumeSpec,
  jdText: string,
  context?: JdContext,
): JdLeadSelectionResult {
  const asks = leadRequirementCandidates(jdText, context);
  if (asks.length === 0) {
    return {
      spec: { ...spec, lead_alignment: null },
      issues: ['lead experience cannot be chosen: the frozen job description contains no supported primary ask'],
      supported_terms: [],
    };
  }

  const askTermSets = asks.map((ask) => comparisonTerms(ask));
  /* How many of this resume's entries use each term, for the tie-break. Built once here rather than
   * per candidate: it is a property of the document, not of any one pairing. */
  const entryTermCounts = new Map<string, number>();
  for (const entry of spec.experience) {
    for (const term of comparisonTerms(entry.bullets.join(' '))) {
      entryTermCounts.set(term, (entryTermCounts.get(term) ?? 0) + 1);
    }
  }

  let best: LeadCandidate | null = null;
  for (let entryIndex = 0; entryIndex < spec.experience.length; entryIndex++) {
    const entry = spec.experience[entryIndex]!;
    for (let askIndex = 0; askIndex < asks.length; askIndex++) {
      const requirement = asks[askIndex]!;
      const requirementTerms = askTermSets[askIndex]!;
      for (const evidence of entry.bullets) {
        const evidenceTerms = comparisonTerms(evidence);
        const supportedTerms = [...requirementTerms].filter((term) => evidenceTerms.has(term));
        const specificTerms = supportedTerms.filter((term) => !LEAD_DECISION_STOPWORDS.has(term));
        // No broad-word fallback. If the domain-bearing intersection is empty, this bullet does
        // not support ordering, even if it shares "build software systems" with the posting.
        if (specificTerms.length === 0) continue;
        const candidate = {
          entryIndex,
          askIndex,
          evidence,
          requirement,
          supportedTerms,
          specificTerms,
          distinguishing: distinguishingPower(specificTerms, entryTermCounts, spec.experience.length),
        };
        if (candidateIsBetter(candidate, best)) best = candidate;
      }
    }
  }

  if (!best) {
    return {
      spec: { ...spec, lead_alignment: null },
      issues: ['lead experience cannot be chosen: no selected bullet shares supported domain evidence with a primary ask in the frozen job description'],
      supported_terms: [],
    };
  }

  const lead = spec.experience[best.entryIndex]!;
  const experience = best.entryIndex === 0
    ? [...spec.experience]
    : [lead, ...spec.experience.slice(0, best.entryIndex), ...spec.experience.slice(best.entryIndex + 1)];
  return {
    spec: {
      ...spec,
      experience,
      lead_alignment: {
        entry_org: lead.org,
        requirement: best.requirement,
        evidence: best.evidence,
        jd_hash: monitoredDescriptionHash(jdText),
      },
    },
    issues: [],
    supported_terms: best.supportedTerms,
  };
}

/**
 * ONE. This threshold detects an ARBITRARY pairing; it does not grade how good a pairing is, and
 * the difference is why it is set here rather than higher.
 *
 * Two was tried first and measured against real packets, where it rejected honest citations at a
 * rate that would have made the check noise. "Proficient programming in Python" proved by a bullet
 * reading "Built LLM-agent cost infrastructure using Python, LangChain, and the OpenAI API" shares
 * exactly one content word, and it is a perfectly good citation; so is "Own your project
 * end-to-end - design, build, launch, and iterate" proved by "Shipped consumer mobile app
 * end-to-end; designed feature set and UX in Figma". Raising the bar to two does not measure
 * relevance more strictly, it just punishes short requirements and short overlaps.
 *
 * Trying to grade relevance by token overlap is the same mistake as ranking the entries by it, and
 * it fails for the same reason (see the module header). What a lexical test CAN say without
 * overreaching is that a requirement and its evidence have not one content word in common, and that
 * is a real signal: it is what a justification retro-fitted onto an already-chosen lead looks like.
 * On the DRW quant packet the model paired "Advanced quantitative, analytical and problem-solving
 * skills" with a bullet about LLM cost infrastructure, and the two share nothing at all.
 */
export const MIN_SHARED_CITATION_TERMS = 1;

export function sharedCitationTerms(a: string, b: string): string[] {
  const left = comparisonTerms(a);
  return [...comparisonTerms(b)].filter((term) => left.has(term));
}

/**
 * A REQUIREMENT IS SOMETHING ASKED OF THE APPLICANT. A clause that offers something TO her is a
 * benefit, and no experience entry is evidence for one - there is no bullet a person can write that
 * proves they are owed mentorship.
 *
 * MEASURED. Both Cloudflare packets cite, as the requirement their lead entry proves, "Work closely
 * with a mentor to guide you through the internship and help with career goals." A Program
 * Management internship won a software posting on `mentor` plus `through`, out of a sentence that
 * asks the applicant for nothing. The colour bar already refuses to paint a term whose only home in
 * the posting is a perk; the lead decision was never held to the same bar.
 *
 * NOTE WHAT IS NOT A PERK. An eligibility gate - graduation timing, work authorization, availability
 * - asks something OF the applicant and stays in the pool, even though no bullet can prove one. It
 * is a bad citation, not a benefit, and the distinction is not academic: deleting one cost two
 * packets their correct lead. See the second measured limit below.
 *
 * THE TEST IS GRAMMATICAL, NOT TOPICAL: it asks whether the APPLICANT APPEARS AS THE BENEFICIARY OF
 * THE CLAUSE'S MAIN PREDICATE. It is not a list of banned subjects, because "mentor", "training",
 * "benefits" and "compensation" are all perfectly good things to require work ON, and a filter that
 * keyed off those words would delete the most role-defining asks any HR, payroll, benefits,
 * insurance or compensation employer states.
 *
 *   1. She is the OBJECT of a transfer verb: "guide you", "help you", "invest in your growth". She
 *      receives; she does not do. "Work with your mentor to ship a production feature" names the
 *      same person and does not match, because there she is the agent.
 *   2. She is the stated RECIPIENT: "you'll receive", "you will be paired with". A bare imperative
 *      does not match: DRW's "Be given immediate responsibility through assignments like position
 *      tracking, calculating risk" states real work and names no recipient, so it survives.
 *   3. She is the INDIRECT OBJECT of an offer: "we offer you", "provides you with".
 *   4. The clause is a STATEMENT ABOUT the terms of the engagement rather than an instruction. All
 *      three of its parts are required: it opens with a determiner, so it predicates over a thing
 *      instead of telling her to do something; a term-of-engagement noun stands in that opening
 *      subject; and a copula follows it. "The annual base salary for this position is $225,000."
 *      passes all three. "Own the benefits enrollment service used by 3 million members." fails the
 *      first, "The engineer will own the benefits service" fails the third.
 *
 * EVERY TEST READS THE MAIN PREDICATE ONLY, meaning the clause up to its first relative pronoun.
 * What follows one modifies a noun, not the clause: in "Build internal tooling THAT GIVES YOU
 * feedback on every commit" the offer belongs to the tooling and the instruction belongs to her.
 * Without this the module deleted that ask, and "Design a CI system that gives you a green signal",
 * and any other requirement whose deliverable is described by what it does for its user.
 *
 * IT FAILS TOWARD KEEPING, AND THAT LIMIT WAS MEASURED TWICE, NOT ASSUMED.
 *   - A wider version of rule 3 fired on an offering SUBJECT with no named recipient ("we provide",
 *     "this role provides"). It cost real asks: cresta's "This role provides mentorship and exposure
 *     to customer-facing technical problem solving in a fast-moving AI/Product environment" is
 *     phrased as an offer but states what the work IS, and dropping it moved six packets off a
 *     correct lead. So a clause like "we host social activities" survives here.
 *   - Rule 4 was a bare noun list with no structural guard, and it deleted eligibility gates as well
 *     as perks. Virtu's "Rising juniors, or students expected to be ready for full time employment
 *     between December 2027 - June 2028" is a requirement OF the applicant, however unprovable, and
 *     removing it took the last lexical bridge off two packets whose ordering was CORRECT and
 *     shipped, turning a good resume into a resume_quality_hold. It opens with "Rising", not with a
 *     determiner, so it now survives.
 *
 * WHY NOT SEPARATE THE ORDERING FROM THE CITATION, which is the other way to have saved those two
 * packets: because the citation IS the forcing function for the ordering. See the module header. A
 * lead that may proceed without a provable citation is a lead chosen by recency again, which is the
 * one failure this file exists to prevent. The right repair was to stop deleting the requirement,
 * not to stop requiring one.
 */
const BENEFIT_TRANSFER_VERBS =
  'guide|guides|guiding|mentor|mentors|mentoring|coach|coaches|coaching|support|supports|supporting'
  + '|help|helps|helping|pair|pairs|paired|pairing|match|matches|matched|matching'
  + '|introduce|introduces|introducing|connect|connects|connecting|prepare|prepares|preparing'
  + '|invest|invests|investing\\s+in|develop|develops|developing|grow|grows|growing';

/** The applicant as beneficiary: second person in object position after a transfer verb. */
const APPLICANT_IS_BENEFICIARY = new RegExp(
  `\\b(?:${BENEFIT_TRANSFER_VERBS})\\s+(?:you\\b|your\\s+(?:career|growth|development|learning|skills)\\b)`,
  'i',
);

/** The applicant as the stated recipient. "You will receive", "you'll be paired with a mentor". */
const APPLICANT_RECEIVES =
  /\byou(?:'ll|\s+will|\s+can)?\s+(?:also\s+)?(?:receive|enjoy|be\s+(?:given|provided|paired|matched|offered|mentored)|have\s+access\s+to)\b/i;

/** The applicant as the indirect object of an offer. "provides you with", "we offer you". */
const APPLICANT_IS_OFFERED =
  /\b(?:offer|offers|offering|provide|provides|providing|give|gives|giving)\s+you\b/i;

/* The three parts of rule 4. None of them is sufficient alone, and that is the whole point: the
   nouns are topical, so they only count when the clause's SHAPE says it is describing rather than
   instructing. */
const STATEMENT_OPENER = /^\W*(?:the|a|an|our|this|these|those|your|all|each|every)\b/i;
const ENGAGEMENT_NOUN =
  /\b(?:salary|salaries|compensation|pay\s+range|pay\s+rate|hourly\s+rate|stipend|equity|401\s*\(?k\)?|benefits?|perks?|paid\s+(?:time\s+off|holidays?)|health\s+insurance|relocation|housing|start\s+date|end\s+date)\b/i;
const COPULA = /\b(?:is|are|was|were|will\s+be|would\s+be|may\s+vary|ranges?|starts?\s+at)\b/i;

function statesTermsOfEngagement(main: string): boolean {
  if (!STATEMENT_OPENER.test(main)) return false;
  const noun = main.match(ENGAGEMENT_NOUN);
  if (!noun || noun.index === undefined) return false;
  return COPULA.test(main.slice(noun.index + noun[0].length));
}

/** The clause up to its first relative pronoun. Everything after one modifies a noun, not the clause. */
function mainPredicate(clause: string): string {
  const relative = clause.match(/\b(?:that|which|who|whom|whose)\b/i);
  return relative?.index === undefined ? clause : clause.slice(0, relative.index);
}

export function offersRatherThanRequires(clause: string): boolean {
  const main = mainPredicate(clause.replace(/[‘’ʼ]/g, "'"));
  return APPLICANT_IS_BENEFICIARY.test(main)
    || APPLICANT_RECEIVES.test(main)
    || APPLICANT_IS_OFFERED.test(main)
    || statesTermsOfEngagement(main);
}

/**
 * The posting's PRIMARY ASKS: the only clauses a lead entry may be justified against.
 *
 * WHY A CLOSED LIST RATHER THAN "ANY REQUIREMENT IN THE POSTING". The first version of this check
 * accepted any clause quoted verbatim from the job description, and it was measured against the
 * three decisive production packets before this list existed. The model kept its recency-ordered
 * lead on all three and simply went shopping for a sentence that would defend it. On the Databricks
 * Product Management internship it led with an AI Engineer role and cited "You've used AI tooling
 * for both personal productivity and development projects" - a true statement, a real requirement,
 * and the single most incidental line in the posting. Meanwhile the posting's actual asks were
 * "Own your project end-to-end", "Work with engineers and designers to ship features" and
 * "Prototype and test early ideas with customers", every one of which is proved word for word by
 * the bullets of an entry sitting in second place.
 *
 * That is the whole failure in miniature: the lead was chosen first and the justification retro
 * fitted. Free choice of requirement made the check satisfiable without ever reconsidering the
 * ordering, which is the one thing it exists to force.
 *
 * So the citation must come from the posting's own priority map - the same extractJdSignals summary
 * the tailoring prompt already receives and is already told to rank evidence by.
 *
 * RESPONSIBILITIES LEAD THE LIST, AHEAD OF HARD REQUIREMENTS, and that inverts the order the rest
 * of the prompt uses. It is deliberate and it is specific to this one question. Everywhere else the
 * priority map answers "which evidence and which skills should this resume surface", and there a
 * hard requirement genuinely outranks a responsibility because it is what the application is
 * screened on. Here the question is different: which of her jobs is THIS job most like. The
 * responsibilities block is the description of the job; the hard requirements are mostly screening
 * gates about degree, graduation year and tools, which the education block and the skills line
 * already answer and which no experience entry is the right proof of.
 *
 * The first version ordered hard requirements first and it produced exactly the wrong answer on the
 * Databricks packet a second time. That posting's hard requirements open "Pursuing a bachelor's or
 * master's in computer science" and "You've used AI tooling for both personal productivity and
 * development projects", while its responsibilities open "Deeply understand customer problem space"
 * and "Own your project end-to-end - design, build, launch, and iterate on feedback". Ranking the
 * screening bullets first invited the model to prove the least role-defining line on the page, and
 * it did, twice.
 *
 * NOTE WHAT THIS STILL DOES NOT DO: it never says which entry to lead with. It narrows the question
 * to the posting's real asks and leaves the answer to the model, which is the only part of this
 * that needs to read English.
 */
export const MAX_PRIMARY_ASKS = 12;

/* Longer than any single ask is worth quoting, and short enough that a citation cannot become a
   paste of a whole section - which would assert nothing in particular about the lead entry. */
const MAX_REQUIREMENT_CHARS = 300;

export function leadRequirementCandidates(jdText: string, context?: JdContext): string[] {
  const signals = extractJdSignals(jdText, context);
  const seen = new Set<string>();
  const asks: string[] = [];
  for (const clause of [
    ...signals.impact_examples,
    ...signals.hard_requirements,
    ...signals.experience_requirements,
  ]) {
    const value = clause.trim();
    // A clause too long to be one ask is a swallowed paragraph, and quoting it back would assert
    // nothing in particular. A very short one carries no content to match evidence against.
    if (value.length < 12 || value.length > MAX_REQUIREMENT_CHARS) continue;
    // What the employer gives is not what the applicant must prove. See offersRatherThanRequires.
    if (offersRatherThanRequires(value)) continue;
    const key = foldForCitation(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    asks.push(value);
    if (asks.length >= MAX_PRIMARY_ASKS) break;
  }
  return asks;
}

export interface LeadAlignmentOptions {
  /**
   * Retained for source compatibility with older callers. Post-render validation is now as strict
   * as pre-render validation: fitting may not delete the evidence the lead decision cites.
   */
  afterRender?: boolean;
  /** Company and role, so the primary asks are extracted exactly as the tailoring prompt built
   *  them. Both sides call leadRequirementCandidates with the same inputs or the closed list the
   *  model was shown is not the closed list it is judged against. */
  context?: JdContext;
}

/**
 * Empty when the spec's lead entry is justified against this posting. Each string is written to be
 * handed straight back to the model as retry feedback, so it names the defect and not the fix -
 * telling it which entry to lead with would put our guess in place of its reading of the posting.
 */
export function leadAlignmentIssues(
  spec: ResumeSpec,
  jdText: string,
  options: LeadAlignmentOptions = {},
): string[] {
  const first = spec.experience[0];
  // An empty selection is already a hard issue in validateResumeSpec. A one-entry resume still
  // needs a citation: there is no ordering tie, but there is still a claim that this is the right
  // experience to put at the top for this job.
  if (!first) return [];

  const alignment = spec.lead_alignment;
  if (!alignment) {
    return ['lead_alignment is missing: name the posting requirement the first experience entry proves'];
  }

  const issues: string[] = [];
  if (!alignment.jd_hash) {
    issues.push('lead_alignment.jd_hash is missing: regenerate the packet against its frozen job description');
  } else if (alignment.jd_hash !== monitoredDescriptionHash(jdText)) {
    issues.push('lead_alignment.jd_hash does not match the frozen job description used by this packet');
  }
  if (foldForCitation(alignment.entry_org) !== foldForCitation(first.org)) {
    issues.push(
      `lead_alignment.entry_org is "${alignment.entry_org}" but the first entry is "${first.org}": justify the entry you actually led with`,
    );
    // Everything below is a claim ABOUT the lead entry, and it has just been established that the
    // alignment is about a different one. Reporting bullet mismatches on top of that would bury
    // the one defect that matters under noise the model then tries to fix separately.
    return issues;
  }
  const asks = leadRequirementCandidates(jdText, options.context);
  const requirement = foldForCitation(alignment.requirement);
  /* A posting this pipeline could not read into asks at all - a two-line listing, a page that is
     all boilerplate - cannot support the check, and refusing to justify an ordering against a
     posting that states no asks would be a defect report about the posting, not the resume. Fall
     back to the weaker "quoted from somewhere in the job description" bar rather than to nothing:
     it still cannot be satisfied by invention. */
  const matchesAsk = asks.length > 0
    ? asks.some((ask) => foldForCitation(ask) === requirement)
    : foldForCitation(jdText).includes(requirement);
  if (!requirement) {
    issues.push('lead_alignment.requirement is empty: quote one of the posting requirements listed in the prompt');
  } else if (!matchesAsk) {
    issues.push(
      asks.length > 0
        ? `lead_alignment.requirement is not one of this posting's listed requirements: copy one of them exactly, and if the first entry proves none of them, lead with the entry that does (got "${alignment.requirement.slice(0, 90)}")`
        : `lead_alignment.requirement is not in the job description: quote it word for word, do not paraphrase ("${alignment.requirement.slice(0, 90)}")`,
    );
  }

  const evidence = foldForCitation(alignment.evidence);
  const bullets = first.bullets.map(foldForCitation);
  if (!evidence) {
    issues.push('lead_alignment.evidence is empty: quote the bullet from the first entry that proves the requirement');
  } else if (!bullets.includes(evidence)) {
    issues.push(
      `lead_alignment.evidence is not one of the bullets selected for ${first.org}: quote a bullet from that entry exactly as you wrote it`,
    );
  }

  // Only worth asking once both halves are real text; otherwise it restates a failure already
  // reported above.
  if (issues.length === 0) {
    const shared = sharedCitationTerms(alignment.requirement, alignment.evidence);
    if (shared.length < MIN_SHARED_CITATION_TERMS) {
      issues.push(
        `lead_alignment cites a requirement its evidence does not address (nothing in common): lead with the entry whose own work this posting asks for`,
      );
    }
  }
  return issues;
}
