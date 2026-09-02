import Anthropic from '@anthropic-ai/sdk';
import type { ExperienceBankEntry } from '../db/schema';
import {
  wordSet,
  numberSignatures,
  ungroundedNumbers,
  ungroundedProperNouns,
  stripEmDashes,
  isRankingAsk,
  extractRankedItems,
  claimedUnheldItems,
} from '../engine/grounding';
import { generateOpenAIText, logOpenAIFallback, openAIConfigured } from './openAIProvider';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Drafts an answer to an open-ended application question ("Why do you want to work here?",
// "Tell us about a project", ...) grounded ONLY in the applicant's real experience bank + the
// JD. The extension flags every field this fills as "AI draft - review before submitting", so
// the applicant always edits before it goes out; the job here is a strong, honest first draft in
// their voice, never a fabricated one.
//
// Anti-AI-tells discipline is deliberate (see the vault's letterstory-email-voice doc): these
// answers must read hand-written, or they hurt the applicant more than a blank box would.
//
// Exported so the premise rule (R-029) and the ranking rule (R-042) can be pinned by tests: the
// live incidents showed the failure is a missing rule, and a silent edit to this prompt would
// silently re-open them.
export const SYSTEM_PROMPT = `You draft a first-person answer to ONE job-application question for an applicant.

Every strong answer to a "why this role / tell us about yourself / why you" question does two
things. Do BOTH, woven together in the applicant's own voice, never as labeled sections:

1. INTEREST - why the applicant is genuinely, specifically interested in THIS role at THIS company.
   Pull concrete specifics from the job description (the actual product, team, problem, mission,
   or tech named in the JD) and connect them to something real about the applicant. No generic
   "I admire your innovative culture." If the JD names a product or problem, name it back.

2. FIT - why the applicant is a strong, qualified candidate for it: talented and a good match. Use
   ONLY real evidence from their experience bank (specific projects, roles, skills, and their
   actual metrics). Show the fit with a concrete example, don't just assert "I am a great fit."

Grounding (hard rule): never invent an employer, project, title, metric, or skill the applicant
doesn't actually have, and never invent a fact about the company beyond what the JD states. If the
experience bank or JD doesn't support a claim, stay general and honest rather than fabricating a
specific.

Premise (hard rule): a question can presuppose an artifact, event, or status that the applicant's
material does not support - "tell us about your submitted project" when nothing was submitted,
"the portfolio piece you attached", "as we discussed". NEVER adopt such a premise. An answer built
from true facts under a false frame is still false: "For my submission I built X" lies even when X
is real. When the substance exists, answer from what is actually true and refuse the frame - "The
project I would point to is X, which I built..." - describing past work in the past tense, tied to
its real employer or project name, never claiming to have submitted, attached, linked, or built
anything for THIS application. When no honest answer exists without the missing artifact, output
exactly CANNOT_DRAFT and nothing else, so the field is flagged for the applicant instead of filled
with a false frame.

Ranking (hard rule): when the question asks you to rank, order, or list items by preference or
proficiency (languages, skills, tools, technologies), every item you place in that ranking is a
skill claim in the applicant's name. Rank ONLY items that appear in the applicant's declared skills
list. An item the question names that is not on that list must not be ranked, claimed, or
described as used: leave it out of the answer entirely, without apologizing for the gap. When
that leaves fewer items than the question asks for, rank the real ones rather than padding the
list with skills the applicant does not hold.

Factual history (hard rule): when a question asks a checkable fact about the applicant's own past
(competitions entered, internships completed, publications, clearances, certifications, awards),
answer it from the experience bank. ABSENCE IS AN ANSWER, not a gap to escalate: if the bank holds
no evidence of the thing asked about, the applicant has not done it, and the correct output is the
plain negative ("I have not participated in any of these competitions"). Do not hedge, do not
apologise for it, and do not treat it as unknown. When the bank DOES hold the evidence, answer yes
and name the real roles, employers and dates from it rather than describing them vaguely. Never
invent an entry to make an answer look stronger; the negative is always safe, a fabricated
positive never is.

Voice and format:
- First person, the applicant's own plain voice. Direct and specific, not corporate.
- 60-130 words unless the question implies shorter. One or two short paragraphs.
- NEVER use an em dash (—). Use a comma, colon, hyphen, or period instead.
- Banned AI-tell words/moves: "delve", "leverage", "tapestry", "testament to", "in today's
  ever-evolving", "passionate about" as an opener, "I am excited to" as an opener, "furthermore",
  "moreover", tricolons like "X, Y, and Z" as filler, and hollow superlatives.
- No preamble, no "Here's my answer", no quotes around it. Output ONLY the answer text.`;

export interface AnswerResult {
  answer: string;
  warnings: string[];
  /* TRUE WHEN THIS PARAGRAPH IS THE HONEST SUBSTITUTE, not a direct answer.
   *
   * The premise rule refused the question as asked, and the second pass wrote what the applicant
   * HAS done instead. The caller uses it to say so on the review screen: a draft that deliberately
   * answers a narrower question than the employer asked is exactly the draft she most needs to read
   * before it goes out. Absent/false on an ordinary draft. */
  honestSubstitute?: boolean;
}

export interface DraftedAnswerValidation extends AnswerResult {
  blockingIssues: string[];
}

/* THE SECOND PASS, and the reason a premise refusal stopped being a blank box.
 *
 * MEASURED, prod, 2026-09-02. EQL Tech "Founding AI Engineer (Computer Vision)" on Workable, packet
 * 9bbf3ba1: question 3 of 5, REQUIRED, type text, "Describe a multimodal/cv system you personally
 * shipped to production, and your role in it." The applicant has no computer-vision system in
 * production, so the premise rule (R-029) correctly output CANNOT_DRAFT, and the whole of what the
 * product then did was leave the box empty. The employer screen offers Previous and a disabled Save
 * and next, no Skip: the refusal was right and its terminal state was a dead end.
 *
 * A refusal is a statement about the QUESTION AS ASKED, never about whether the applicant has
 * anything to say. So the refusal now opens a second, narrower ask instead of closing the field:
 * describe the nearest thing she has actually built, in the past tense, tied to its real project or
 * employer, without adopting the question's frame and without naming the thing she has not done.
 *
 * WHAT KEEPS IT HONEST is not this prose. It is unheldExperienceTerms below, which is computed from
 * the applicant's OWN material with the job description deliberately excluded, and enforced with
 * claimedUnheldItems exactly as the ranking rule enforces its own list. The prompt asks; the
 * deterministic check decides.
 *
 * WHAT MAKES IT SAFE TO ATTEMPT AT ALL is provenance. The caller stores this paragraph with
 * answer_source 'litos_draft', and the send gate counts an unapproved draft as an unanswered
 * required question, so an imperfect substitute costs the applicant a read and an edit. It cannot
 * cost her a false claim to an employer. */
export const HONEST_SUBSTITUTE_INSTRUCTION = `You already judged that this question presumes work the applicant's material does not support, and you were right: do NOT answer it as asked.

Write instead the honest substitute. Rules, all of them hard:
- Describe the CLOSEST real work in the experience bank: what she actually built, at its real project or employer, in the past tense.
- Do NOT claim, imply, or even name the thing the question presumes she has done. Leave those words out of the answer entirely rather than disclaiming them; a sentence about what she has not done is not what this box is for.
- Do NOT name a technology, tool, framework, method or field that is not in the experience bank or the declared skills list, whatever the question or the job description says. The posting asking for something is never evidence she has done it.
- Do not apologise, do not hedge, and do not describe the answer as a substitute. State the real work plainly and let it stand on its own.
- Same voice and format rules as before: first person, plain, 60-130 words, no em dash, no AI-tell words, output ONLY the answer text.

If the experience bank holds nothing at all that is adjacent to the question, output exactly CANNOT_DRAFT and nothing else.`;

/* Common capitalised English that a naive acronym rule would otherwise treat as a technology. Kept
 * short on purpose: this list only ever narrows enforcement, and a term wrongly kept costs one
 * regeneration while a term wrongly dropped costs a claim she does not hold. */
const NON_TECHNICAL_QUESTION_TERMS = new Set([
  'and', 'or', 'the', 'not', 'yes', 'no', 'you', 'your', 'our', 'we', 'us', 'it', 'in', 'of', 'to',
  'a', 'an', 'is', 'are', 'was', 'were', 'be', 'do', 'did', 'how', 'why', 'what', 'when', 'who',
  'ok', 'na', 'n/a', 'tbd', 'etc', 'eg', 'ie', 'ceo', 'cto', 'hr', 'usa', 'uk', 'eu', 'us',
]);

/**
 * The technology-shaped terms a free-text question names, extracted conservatively.
 *
 * NOT a general noun-phrase extractor and deliberately not trying to be one. Four sources, each one
 * a shape that is a technology far more often than it is prose:
 *   - an explicit candidate list the question itself writes out (the ranking extractor's own rule)
 *   - slash groups, which is how a posting compresses a field pair: "multimodal/cv" -> multimodal, cv
 *   - short all-caps acronyms: CV, NLP, GPU, ETL
 *   - internally capitalised or digit-bearing tokens: PyTorch, TensorFlow, K8s, S3, C++, C#
 *
 * Missing a term only NARROWS enforcement - the prompt rule and the existing gates still apply - so
 * the extraction stays conservative and can never manufacture a false refusal on its own.
 */
export function questionExperienceTerms(question: string): string[] {
  const terms = new Set<string>();
  for (const item of extractRankedItems(question)) terms.add(item);
  for (const match of question.matchAll(/[A-Za-z][A-Za-z0-9+#.]*(?:\/[A-Za-z][A-Za-z0-9+#.]*)+/g)) {
    for (const part of match[0].split('/')) terms.add(part);
  }
  for (const match of question.matchAll(/[A-Za-z][A-Za-z0-9]*(?:\+\+|#)|[A-Za-z][A-Za-z0-9.]*/g)) {
    const token = match[0].replace(/\.+$/, '');
    if (token.length < 2) continue;
    const alphabetic = token.replace(/[^A-Za-z]/g, '');
    if (/^[A-Z]{2,6}$/.test(alphabetic) && alphabetic === token) terms.add(token);
    else if (/[a-z]/.test(token) && /[A-Z]/.test(token.slice(1))) terms.add(token);
    else if (/[0-9]/.test(token) && /[A-Za-z]/.test(token)) terms.add(token);
    else if (/(?:\+\+|#)$/.test(token)) terms.add(token);
  }
  return [...terms]
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !NON_TECHNICAL_QUESTION_TERMS.has(term.toLowerCase()));
}

/**
 * The terms this question names that the applicant's OWN material does not evidence.
 *
 * THE JOB DESCRIPTION IS NOT IN THIS CORPUS, and that exclusion is the whole guarantee. The ordinary
 * answer corpus (answerGroundingCorpus) includes the JD, which is right for "does this number exist"
 * but exactly wrong for "has she done this": a posting that asks for computer vision would otherwise
 * ground a sentence claiming she has shipped computer vision. The cover-letter prompt has stated the
 * rule in words since it was written - the job description defines what matters and is never
 * evidence that the candidate has done something - and this is that rule made deterministic.
 *
 * Held is decided with the same whole-item mention test the ranking rule uses, so "C" is not held by
 * a bank that says "C++" and "Java" is not held by one that says "JavaScript".
 */
export function unheldExperienceTerms(
  question: string,
  bank: ExperienceBankEntry[],
  education: ApplicantGroundingFacts,
  declaredSkills?: string[] | null,
): string[] {
  const terms = questionExperienceTerms(question);
  if (terms.length === 0) return [];
  const declared = (declaredSkills ?? []).filter(
    (skill) => typeof skill === 'string' && skill.trim().length > 0,
  );
  const ownMaterial = `${experienceBankCorpus(bank)} ${groundingFactsText(education)} ${declared.join(' ')}`;
  const held = new Set(claimedUnheldItems(ownMaterial, terms));
  return terms.filter((term) => !held.has(term));
}

// The drafter's refusal sentinel (R-029). When the prompt's premise rule concludes no honest
// answer exists, the model outputs CANNOT_DRAFT; mapping it to '' routes the refusal through the
// module's existing cannot-draft path - the route already 502s on an empty answer ("Empty draft
// returned") and the extension already flags an undrafted field for the applicant - so a refusal
// surfaces exactly like any other failed draft instead of inventing a new channel. Prefix-matched
// rather than equality: a model that appends its reason ("CANNOT_DRAFT: the question presumes a
// submission") is still refusing. A sentinel mentioned MID-answer is not a refusal and passes
// through untouched.
export function normalizeDraftedAnswer(raw: string): string {
  const text = raw.trim();
  return /^CANNOT_DRAFT\b/.test(text) ? '' : text;
}

// R-042: what a ranking ask is allowed to rank, computed against the declared skills list
// (R-015's authority, same normalization as the resume validator's findUngroundedSkills).
// null means there is nothing to enforce: either the question is not a ranking ask, or the
// applicant never declared a skills list ([] / NULL means "never declared", not "holds nothing",
// the same semantics the declared list carries everywhere else, R-027) - the prompt's ranking
// rule is the remaining guard in that case.
export interface RankingGrounding {
  items: string[]; // the question's own candidate list ([] when it names none)
  held: string[]; // items also on the declared list, in the question's order and casing
  unheld: string[]; // items the applicant never declared: never rankable, never mentionable
}

export function rankingGroundingFor(
  question: string,
  declaredSkills?: string[] | null,
): RankingGrounding | null {
  const declared = (declaredSkills ?? []).filter(
    (s) => typeof s === 'string' && s.trim().length > 0,
  );
  if (declared.length === 0) return null;
  if (!isRankingAsk(question)) return null;
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const allowed = new Set(declared.map(norm));
  const items = extractRankedItems(question);
  return {
    items,
    held: items.filter((i) => allowed.has(norm(i))),
    unheld: items.filter((i) => !allowed.has(norm(i))),
  };
}

// The per-question half of the ranking rule. The system prompt carries the general rule; the
// held/unheld split is per-question, so it rides the user turn (the cached context prefix must
// stay identical across every essay box of a form) and names the exact items either way.
export function rankingRuleText(ranking: RankingGrounding): string {
  if (ranking.items.length === 0) {
    return 'This is a ranking question. Rank only skills on the declared skills list; never rank or claim anything the applicant has not declared.';
  }
  const held = `Of the items the question names, the applicant's declared skills cover only: ${ranking.held.join(', ')}. Rank only these.`;
  const unheld = ranking.unheld.length
    ? ` The question also names ${ranking.unheld.join(', ')}, which the applicant has NOT declared: do not rank, claim, or mention them at all.`
    : '';
  return `This is a ranking question. ${held}${unheld}`;
}

// The review warning a thinner-than-the-ask ranking carries (R-042's "flag when the intersection
// is thinner than the ask"): the applicant sees exactly what the question wanted and what the draft
// honestly left out, instead of a confident answer that silently shrank the list.
export function thinRankingWarning(ranking: RankingGrounding): string | null {
  if (ranking.items.length === 0 || ranking.unheld.length === 0) return null;
  return `Ranking ask names ${ranking.items.length} items but your declared skills cover ${ranking.held.length} (${ranking.held.join(', ')}); the draft omits: ${ranking.unheld.join(', ')}.`;
}

/**
 * The applicant's own stored background, as the grounding check must see it.
 *
 * This used to be `{ school, grad_year }`, and the corpus built from it therefore held the name of
 * the university and nothing else about where the applicant actually is. Measured on the Anduril
 * packet of 2026-08-08: `profiles.parsed_json.school_location` is "Los Angeles, CA", the draft
 * said Los Angeles, and the applicant was told
 *   "Names/orgs not found in your background or the job post (verify): Los Angeles"
 * about a place named in her own profile. The corpus was wrong, not the answer.
 *
 * Every field here is a fact the applicant stored herself, so any of them may legitimately appear
 * in a drafted answer. Nothing derived and nothing inferred goes on this list: the corpus is what
 * decides whether a name is a fabrication, so widening it with anything Litos guessed would make
 * the check endorse Litos's own guesses.
 */
export type ApplicantGroundingFacts = {
  school?: string;
  grad_year?: number;
  /** profiles.parsed_json.school_location, e.g. "Los Angeles, CA". */
  school_location?: string;
  degree?: string;
  major?: string;
  /** Where the applicant lives, from application_profile (city, state, country). */
  residence?: string;
};

function buildContextBlock(
  company: string,
  role: string,
  jdText: string,
  bank: ExperienceBankEntry[],
  education: ApplicantGroundingFacts,
  declaredSkills: string[],
): string {
  // The declared list rides the cached prefix like the bank: per-applicant, not per-question, so it
  // is identical across every essay box of a form and never busts the cache. Before R-042 the
  // drafter had no skills source at all, which left both the prose grounding rule and the ranking
  // rule with nothing authoritative to rank against.
  const skillsBlock = declaredSkills.length
    ? `\n\nDeclared skills (the applicant's own list, the only skills you may claim or rank):\n${JSON.stringify(declaredSkills)}`
    : '';
  const educationLine = [
    education.degree,
    education.major ? `in ${education.major}` : '',
    education.school,
    education.school_location ? `(${education.school_location})` : '',
    education.grad_year ? `, class of ${education.grad_year}` : '',
  ].filter((part) => part && part.trim().length > 0).join(' ').replace(/\s+,/g, ',').trim();
  const residenceLine = education.residence ? `\n\nApplicant is based in: ${education.residence}` : '';
  return `Role: ${role} at ${company}\n\nJob description:\n${jdText.slice(0, 6000)}\n\nEducation: ${educationLine}${residenceLine}${skillsBlock}\n\nExperience bank:\n${JSON.stringify(bank)}`;
}

/**
 * Build the grounding facts from the two places the applicant's own data actually lives.
 *
 * One function rather than a literal at each call site, because the two call sites are the
 * dashboard runner and the extension's /application/answer route, and the corpus they ground
 * against has to be the same set of facts or the same draft gets a warning on one surface and not
 * the other. Fields are read defensively: parsed_json is model output stored as jsonb, so anything
 * in it may be missing or the wrong type.
 */
export function applicantGroundingFacts(
  parsedJson: unknown,
  profile?: {
    address_city?: string;
    address_state?: string;
    address_country?: string;
    school?: string;
    degree?: string;
    major?: string;
  } | null,
): ApplicantGroundingFacts {
  const parsed = (parsedJson && typeof parsedJson === 'object' ? parsedJson : {}) as Record<string, unknown>;
  const str = (value: unknown): string | undefined =>
    (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined);
  const residence = [profile?.address_city, profile?.address_state, profile?.address_country]
    .map((part) => str(part))
    .filter(Boolean)
    .join(', ');
  return {
    school: str(parsed.school) ?? str(profile?.school),
    grad_year: typeof parsed.grad_year === 'number' ? parsed.grad_year : undefined,
    school_location: str(parsed.school_location),
    degree: str(parsed.degree) ?? str(profile?.degree),
    major: str(parsed.major) ?? str(profile?.major),
    residence: residence || undefined,
  };
}

/** Every stored fact the grounding corpus is allowed to treat as the applicant's own material. */
export function groundingFactsText(education: ApplicantGroundingFacts): string {
  return [
    education.school,
    education.school_location,
    education.degree,
    education.major,
    education.residence,
    education.grad_year ? String(education.grad_year) : '',
  ].filter((value) => typeof value === 'string' && value.trim().length > 0).join(' ');
}

/** The applicant's experience bank as flat text. Her own material and nothing else. */
export function experienceBankCorpus(bank: ExperienceBankEntry[]): string {
  return bank
    .map((entry) => {
      const variants = Array.isArray(entry.bullet_variants) ? (entry.bullet_variants as string[]) : [];
      const tags = Array.isArray(entry.tags) ? (entry.tags as string[]) : [];
      return [entry.org, entry.title ?? '', entry.date_range ?? '', ...variants, ...tags].join(' ');
    })
    .join(' ');
}

function answerGroundingCorpus(
  bank: ExperienceBankEntry[],
  jdText: string,
  education: ApplicantGroundingFacts,
): string {
  return `${experienceBankCorpus(bank)} ${jdText} ${groundingFactsText(education)}`;
}

/**
 * Grade a model-produced answer without making another model call.
 *
 * The compact packet generator uses this exact gate before one of its answers may enter an
 * application. Blocking issues route that one answer back through draftApplicationAnswer, whose
 * existing feedback retries remain the final authority. This keeps batching a transport and cost
 * optimization rather than a weaker generation path.
 */
export function validateDraftedApplicationAnswer(
  rawAnswer: string,
  question: string,
  jdText: string,
  bank: ExperienceBankEntry[],
  education: ApplicantGroundingFacts,
  declaredSkills?: string[] | null,
): DraftedAnswerValidation {
  const declared = (declaredSkills ?? []).filter(
    (skill) => typeof skill === 'string' && skill.trim().length > 0,
  );
  const ranking = rankingGroundingFor(question, declared);
  if (ranking && ranking.items.length > 0 && ranking.held.length === 0) {
    return { answer: '', warnings: [], blockingIssues: ['none of the ranked items are declared skills'] };
  }

  let answer = normalizeDraftedAnswer(rawAnswer);
  if (!answer) return { answer: '', warnings: [], blockingIssues: ['the model could not draft an honest answer'] };

  const corpusText = answerGroundingCorpus(bank, jdText, education);
  const badNumbers = ungroundedNumbers(answer, numberSignatures(corpusText));
  const unheldClaims = ranking ? claimedUnheldItems(answer, ranking.unheld) : [];
  const blockingIssues: string[] = [];
  if (badNumbers.length > 0) blockingIssues.push(`ungrounded numbers: ${badNumbers.join(', ')}`);
  if (unheldClaims.length > 0) blockingIssues.push(`undeclared ranked skills: ${unheldClaims.join(', ')}`);

  answer = stripEmDashes(answer);
  const warnings: string[] = [];
  const suspectNames = ungroundedProperNouns(answer, wordSet(corpusText));
  if (suspectNames.length > 0) {
    warnings.push(`Names/orgs not found in your background or the job post (verify): ${suspectNames.slice(0, 5).join(', ')}`);
  }
  const thinRanking = ranking ? thinRankingWarning(ranking) : null;
  if (thinRanking) warnings.push(thinRanking);
  const wordCount = answer.split(/\s+/).filter(Boolean).length;
  if (wordCount > 160) warnings.push(`Answer is ${wordCount} words - consider trimming.`);

  return { answer, warnings, blockingIssues };
}

export async function draftApplicationAnswer(
  question: string,
  company: string,
  role: string,
  jdText: string,
  bank: ExperienceBankEntry[],
  education: ApplicantGroundingFacts,
  // The applicant's declared skills (profiles.skills, R-015's authority). Empty/undefined means
  // "never declared", which disables the deterministic ranking check (R-042) but must never be
  // read as "holds no skills" - the same NULL-vs-[] semantics the list carries everywhere else.
  declaredSkills?: string[] | null,
  /* THE MODEL, INJECTABLE, so the drafting PIPELINE can be tested without a network call.
   *
   * Everything this module actually decides - the premise refusal, the second ask, the unheld-term
   * check and its one regeneration, the fail-closed - lives between the model calls, and none of it
   * was reachable from a test before this seam existed: the two providers are module-level clients,
   * so the only assertions possible were on prompt TEXT and on the two branches that short-circuit
   * before any call. That is precisely the wrong half to have covered, and the EQL Tech dead end
   * (prod, 2026-09-02) sat in the uncovered half.
   *
   * Optional and unused in production: every real caller omits it and gets the OpenAI-then-Anthropic
   * path unchanged. It is not a provider abstraction and must not grow into one. */
  generate?: (input: { system: string; context: string; user: string }) => Promise<string>,
): Promise<AnswerResult> {
  const declared = (declaredSkills ?? []).filter(
    (s) => typeof s === 'string' && s.trim().length > 0,
  );

  // R-042: a ranking ask is graded against the declared list before any model call.
  const ranking = rankingGroundingFor(question, declared);

  // The question names candidates and the applicant holds NONE of them: no honest ranking exists,
  // so this rides the cannot-draft path deterministically (empty answer -> route 502 -> the
  // extension flags the field for the applicant, same signal as an R-029 premise refusal) instead
  // of asking the model to write around an impossible ask.
  if (ranking && ranking.items.length > 0 && ranking.held.length === 0) {
    return { answer: '', warnings: [] };
  }

  // A form with N essay boxes fires N of these with the SAME role/JD/bank and only the question
  // differing. Putting the shared context in the cached system prefix (and the question in the
  // user turn) lets every essay after the first read the JD + experience bank from cache instead
  // of re-sending them per box. The cache_control marker sits on this large block, not on the
  // short rules block where it was below the minimum cacheable size and cached nothing. Compact
  // JSON (no 2-space indent) roughly halves the bank's token weight.
  const contextBlock = buildContextBlock(company, role, jdText, bank, education, declared);

  // Present on every attempt of a ranking question, not only the retry: the model must know the
  // held intersection before its first draft, not be corrected into it afterwards.
  const rankingRule = ranking ? rankingRuleText(ranking) : '';

  async function callModel(feedback?: string): Promise<string> {
    const userContent = `Question: ${question}\n\nWrite the answer.${rankingRule ? `\n\n${rankingRule}` : ''}${feedback ? `\n\n${feedback}` : ''}`;
    if (generate) return generate({ system: SYSTEM_PROMPT, context: contextBlock, user: userContent });
    if (openAIConfigured() && !feedback) {
      try {
        const generated = await generateOpenAIText({
          instructions: `${SYSTEM_PROMPT}\n\n${contextBlock}`,
          input: userContent,
          maxOutputTokens: 600,
          reasoningEffort: 'medium',
        });
        return generated.text;
      } catch (error) {
        logOpenAIFallback('application answer', error);
      }
    }

    const response = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 600,
      system: [
        { type: 'text', text: SYSTEM_PROMPT },
        { type: 'text', text: contextBlock, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content: userContent,
        },
      ],
    });
    const block = response.content.find((b) => b.type === 'text');
    return block?.type === 'text' ? block.text.trim() : '';
  }

  // Grounding source = the applicant's real material only: experience bank text + the JD (facts
  // about the company are allowed only if the JD states them) + every academic and location fact
  // she has stored. That last part is the whole of groundingFactsText and it is not decoration:
  // with only `school` in the corpus, a draft naming the city her university is in was reported to
  // her as an unverifiable name.
  const corpusText = answerGroundingCorpus(bank, jdText, education);
  const sourceSignatures = numberSignatures(corpusText);
  const corpusWords = wordSet(corpusText);

  let answer = normalizeDraftedAnswer(await callModel());
  /* A PREMISE REFUSAL OPENS THE SECOND ASK RATHER THAN CLOSING THE FIELD.
   *
   * It used to be final: '' flowed out through the empty-answer path and the applicant got a blank
   * required box she had to write from nothing (the EQL Tech computer-vision question, prod
   * 2026-09-02). The refusal itself was correct and is unchanged - what changed is that "I cannot
   * answer THIS question" is now followed by "so answer the honest one", and the result reaches her
   * as an unapproved draft she can take, edit, or replace.
   *
   * Everything below still applies to the substitute: the number check, the em dash strip, the
   * proper-noun warning. The unheld-experience check is ADDITIONAL and specific to this path. */
  let honestSubstitute = false;
  const unheldTerms = answer === ''
    ? unheldExperienceTerms(question, bank, education, declared)
    : [];
  if (answer === '') {
    answer = normalizeDraftedAnswer(await callModel(HONEST_SUBSTITUTE_INSTRUCTION));
    honestSubstitute = answer !== '';
    if (answer !== '' && claimedUnheldItems(answer, unheldTerms).length > 0) {
      answer = normalizeDraftedAnswer(await callModel(
        `${HONEST_SUBSTITUTE_INSTRUCTION}\n\nYour previous draft named ${claimedUnheldItems(answer, unheldTerms).join(', ')}, which the applicant's own experience does not evidence. Rewrite it without those words anywhere in the answer, describing only work the experience bank actually holds.`,
      ));
      /* STILL CLAIMING AFTER EXPLICIT FEEDBACK: never ship it. Same fail-closed direction as the
       * ranking rule - a blank box she can write herself is a cost, a claim she never made is a
       * harm, and only one of the two is recoverable. */
      if (claimedUnheldItems(answer, unheldTerms).length > 0) return { answer: '', warnings: [] };
    }
    if (answer === '') return { answer: '', warnings: [], honestSubstitute: false };
  }

  // If the draft used numbers not present in the applicant's material, regenerate once with that as
  // explicit feedback (same self-correcting pattern as the resume path).
  let badNumbers = ungroundedNumbers(answer, sourceSignatures);
  if (badNumbers.length > 0) {
    answer = normalizeDraftedAnswer(
      await callModel(
        `Your previous draft included numbers that are NOT in the applicant's experience bank or the job description: ${badNumbers.join(', ')}. Rewrite it using only facts and figures that appear in the provided material. Do not invent metrics.`,
      ),
    );
    badNumbers = ungroundedNumbers(answer, sourceSignatures);
  }

  // R-042 deterministic check: an unheld question item in the answer is an unheld-skill claim
  // ("Python first, JAVA second" against a declared list with no Java - the live miss). One
  // feedback regeneration, same self-correcting pattern as the numbers check above.
  let unheldClaims = ranking ? claimedUnheldItems(answer, ranking.unheld) : [];
  if (unheldClaims.length > 0 && ranking) {
    answer = normalizeDraftedAnswer(
      await callModel(
        `Your previous draft named ${unheldClaims.join(', ')}, which the applicant has NOT declared as skills. Rewrite it ranking only ${ranking.held.join(', ')}, and do not mention the undeclared items at all.`,
      ),
    );
    unheldClaims = claimedUnheldItems(answer, ranking.unheld);
    // The regenerated answer is new text: re-derive the numbers verdict from it, or the
    // "Unverified numbers" warning below would be stale (or silently absent) for rankings.
    badNumbers = ungroundedNumbers(answer, sourceSignatures);
  }
  // Still claiming an unheld skill after explicit feedback: never ship it. Unlike a suspect
  // number (a review warning the applicant edits), an unheld-skill claim is the exact R-015 harm,
  // so this fails closed through the cannot-draft path: empty answer -> route 502 -> the
  // extension flags the field for the applicant instead of filling it with a false claim.
  if (unheldClaims.length > 0) {
    return { answer: '', warnings: [] };
  }

  // L6: enforce the zero-em-dash rule by STRIPPING dashes from the returned answer, not just
  // warning. The extension fills essay fields directly and never surfaces these warnings, so an
  // em dash would otherwise reach a submitted application.
  answer = stripEmDashes(answer);

  // Remaining grounding + quality signals are surfaced as review warnings (the applicant edits
  // before submitting); they never block returning a draft.
  const warnings: string[] = [];
  if (badNumbers.length > 0) {
    warnings.push(`Unverified numbers (edit before sending): ${badNumbers.join(', ')}`);
  }
  const suspectNames = ungroundedProperNouns(answer, corpusWords);
  if (suspectNames.length > 0) {
    warnings.push(`Names/orgs not found in your background or the job post (verify): ${suspectNames.slice(0, 5).join(', ')}`);
  }
  // R-042: a ranking that could honestly cover only part of the question's list is flagged for
  // the applicant rather than presented as a confident complete answer.
  const thinRanking = ranking ? thinRankingWarning(ranking) : null;
  if (thinRanking) warnings.push(thinRanking);
  const wordCount = answer.split(/\s+/).filter(Boolean).length;
  if (wordCount > 160) warnings.push(`Answer is ${wordCount} words - consider trimming.`);
  /* The one warning the applicant most needs beside a substitute: it says, in her own review screen,
   * that the draft answers a narrower question than the employer asked. */
  if (honestSubstitute) {
    warnings.push('This question asks about work your resume does not show, so the draft describes the closest real work instead. Read it before it goes out.');
  }

  return { answer, warnings, honestSubstitute };
}
