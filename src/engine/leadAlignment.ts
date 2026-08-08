import { extractJdSignals } from './jdSignals';
import type { JdContext } from './jdMatch';
import type { ResumeSpec } from '../llm/resumeSpec';

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
 * A SCORE WAS TRIED FIRST AND REJECTED. Ranking her entries by weighted overlap against the
 * posting's own extracted terms was measured over the same 85 packets and it is not defensible:
 * the ATS term extractor yields 5-12 terms per posting and matched almost nothing, and a broader
 * bag-of-words over the priority clauses ranked a Program Management internship top for a Test
 * Automation Engineer posting on the strength of the shared words "intern", "through" and
 * "system". Committing an ordering to arithmetic that coincidental would be vibes with a decimal
 * point on it. Semantics is what the model is for.
 *
 * SO THE MODEL STILL CHOOSES, AND THIS FILE CHECKS ITS WORK. The spec must carry a `lead_alignment`
 * naming (a) a requirement quoted from the posting and (b) the bullet from the first entry that
 * proves it. Both are verified as VERBATIM copies of text that already exists - the requirement
 * against the job description, the evidence against that entry's own selected bullets - and the two
 * must share real content words, so the pairing cannot be arbitrary. The check therefore has three
 * properties that matter here:
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
   * Post-render, one-page fitting may already have trimmed the very bullet the citation named, and
   * a resume must not be blocked because the sentence that justified its ordering was the one that
   * did not fit. After rendering, only the claim that survives the trim is checked: that the entry
   * the alignment is about is still the entry leading the page.
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
  // Nothing to align. An empty selection is already a hard issue in validateResumeSpec, and a
  // one-entry resume has no ordering decision to defend.
  if (!first || spec.experience.length < 2) return [];

  const alignment = spec.lead_alignment;
  if (!alignment) {
    return ['lead_alignment is missing: name the posting requirement the first experience entry proves'];
  }

  const issues: string[] = [];
  if (foldForCitation(alignment.entry_org) !== foldForCitation(first.org)) {
    issues.push(
      `lead_alignment.entry_org is "${alignment.entry_org}" but the first entry is "${first.org}": justify the entry you actually led with`,
    );
    // Everything below is a claim ABOUT the lead entry, and it has just been established that the
    // alignment is about a different one. Reporting bullet mismatches on top of that would bury
    // the one defect that matters under noise the model then tries to fix separately.
    return issues;
  }
  if (options.afterRender) return issues;

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
