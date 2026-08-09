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

/* Crude singularisation, matching the intent of resumeCovers in jdMatch: a posting that writes
   "shipping consumer products" and a bullet that writes "shipped consumer product" are talking
   about the same thing, and the check would be worthless if it were not. Nothing here maps one word
   onto a DIFFERENT word - only a word onto its own other form. */
function citationTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const raw of foldForCitation(text).match(/[a-z][a-z0-9+#]{2,}/g) ?? []) {
    if (CITATION_STOPWORDS.has(raw)) continue;
    const stem = raw
      .replace(/(?:ing|ed|es|s)$/, '')
      .replace(/([a-z])\1$/, '$1');
    /* THREE, not four. A four-character floor silently deleted the shortest and most load-bearing
       words in this domain: gpu, sql, api, aws, git, and "end". Measured on the Redwood Materials
       packet, the ask "You'll own a scoped project end to end" and the bullet "Shipped consumer
       mobile app end-to-end; designed feature set and UX in Figma" were reported as having nothing
       in common, because the only word they share is three letters long. That is a false
       accusation of an arbitrary pairing against a citation that is exactly right.
       Two stays out: it is where the initialisms stop and the prepositions start. */
    if (stem.length >= 3) terms.add(stem);
  }
  return terms;
}

/* Words that can truthfully occur in both almost any software posting and almost any technical
 * resume bullet, but cannot decide which experience is most like the job. They may strengthen a
 * citation after a specific match exists; they can never create a candidate by themselves. */
const LEAD_DECISION_STOPWORDS = new Set([
  'application', 'build', 'built', 'create', 'created', 'data', 'develop', 'developed', 'engineer',
  'engineering', 'feature', 'implement', 'implemented', 'intern', 'internship', 'project', 'research',
  'software', 'solution', 'system', 'technology', 'tool', 'work',
]);

const LEAD_IRREGULAR_TERMS = new Map<string, string>([
  ['built', 'build'],
  ['shipped', 'ship'],
  ['shipping', 'ship'],
  ['wrote', 'write'],
]);

/** Normalized only for the private comparison. The citation stored on the packet remains verbatim. */
function leadDecisionTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const raw of foldForCitation(text).match(/[a-z][a-z0-9+#.]{2,}/g) ?? []) {
    if (CITATION_STOPWORDS.has(raw)) continue;
    const irregular = LEAD_IRREGULAR_TERMS.get(raw);
    const stem = irregular ?? raw
      .replace(/ies$/, 'y')
      .replace(/(?:ing|ed)$/, '')
      .replace(/(?:es|s)$/, '')
      .replace(/([a-z])\1$/, '$1');
    if (stem.length >= 3) terms.add(stem);
  }
  return terms;
}

interface LeadCandidate {
  entryIndex: number;
  askIndex: number;
  evidence: string;
  requirement: string;
  supportedTerms: string[];
  specificTerms: string[];
}

export interface JdLeadSelectionResult {
  spec: ResumeSpec;
  issues: string[];
  supported_terms: string[];
}

function candidateIsBetter(next: LeadCandidate, current: LeadCandidate | null): boolean {
  if (!current) return true;
  /* Evidence strength leads. This prevents one coincidental word in the first ask from beating an
   * entry that repeats the posting's actual domain language. Posting order then breaks equal
   * evidence, followed by the model's stable entry order as the final deterministic tie-break. */
  if (next.specificTerms.length !== current.specificTerms.length) {
    return next.specificTerms.length > current.specificTerms.length;
  }
  if (next.supportedTerms.length !== current.supportedTerms.length) {
    return next.supportedTerms.length > current.supportedTerms.length;
  }
  const nextSpecificChars = next.specificTerms.reduce((sum, term) => sum + term.length, 0);
  const currentSpecificChars = current.specificTerms.reduce((sum, term) => sum + term.length, 0);
  if (nextSpecificChars !== currentSpecificChars) return nextSpecificChars > currentSpecificChars;
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

  let best: LeadCandidate | null = null;
  for (let entryIndex = 0; entryIndex < spec.experience.length; entryIndex++) {
    const entry = spec.experience[entryIndex]!;
    for (let askIndex = 0; askIndex < asks.length; askIndex++) {
      const requirement = asks[askIndex]!;
      const requirementTerms = leadDecisionTerms(requirement);
      for (const evidence of entry.bullets) {
        const evidenceTerms = leadDecisionTerms(evidence);
        const supportedTerms = [...requirementTerms].filter((term) => evidenceTerms.has(term));
        const specificTerms = supportedTerms.filter((term) => !LEAD_DECISION_STOPWORDS.has(term));
        // No broad-word fallback. If the domain-bearing intersection is empty, this bullet does
        // not support ordering, even if it shares "build software systems" with the posting.
        if (specificTerms.length === 0) continue;
        const candidate = { entryIndex, askIndex, evidence, requirement, supportedTerms, specificTerms };
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
  const left = citationTerms(a);
  return [...citationTerms(b)].filter((term) => left.has(term));
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
