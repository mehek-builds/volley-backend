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
}

export interface DraftedAnswerValidation extends AnswerResult {
  blockingIssues: string[];
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

function answerGroundingCorpus(
  bank: ExperienceBankEntry[],
  jdText: string,
  education: ApplicantGroundingFacts,
): string {
  const bankCorpus = bank
    .map((entry) => {
      const variants = Array.isArray(entry.bullet_variants) ? (entry.bullet_variants as string[]) : [];
      const tags = Array.isArray(entry.tags) ? (entry.tags as string[]) : [];
      return [entry.org, entry.title ?? '', entry.date_range ?? '', ...variants, ...tags].join(' ');
    })
    .join(' ');
  return `${bankCorpus} ${jdText} ${groundingFactsText(education)}`;
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
          content: `Question: ${question}\n\nWrite the answer.${rankingRule ? `\n\n${rankingRule}` : ''}${feedback ? `\n\n${feedback}` : ''}`,
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
  // A premise refusal (R-029) is final: '' flows out through the empty-answer path below and the
  // route's existing 502, so the field is flagged for the applicant rather than drafted.
  if (answer === '') return { answer: '', warnings: [] };

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

  return { answer, warnings };
}
