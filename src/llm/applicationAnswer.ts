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
// "Tell us about a project", ...) grounded ONLY in the student's real experience bank + the
// JD. The extension flags every field this fills as "AI draft - review before submitting", so
// the student always edits before it goes out; the job here is a strong, honest first draft in
// their voice, never a fabricated one.
//
// Anti-AI-tells discipline is deliberate (see the vault's letterstory-email-voice doc): these
// answers must read hand-written, or they hurt the student more than a blank box would.
//
// Exported so the premise rule (R-029) and the ranking rule (R-042) can be pinned by tests: the
// live incidents showed the failure is a missing rule, and a silent edit to this prompt would
// silently re-open them.
export const SYSTEM_PROMPT = `You draft a first-person answer to ONE job-application question for a student.

Every strong answer to a "why this role / tell us about yourself / why you" question does two
things. Do BOTH, woven together in the student's own voice, never as labeled sections:

1. INTEREST - why the student is genuinely, specifically interested in THIS role at THIS company.
   Pull concrete specifics from the job description (the actual product, team, problem, mission,
   or tech named in the JD) and connect them to something real about the student. No generic
   "I admire your innovative culture." If the JD names a product or problem, name it back.

2. FIT - why the student is a strong, qualified candidate for it: talented and a good match. Use
   ONLY real evidence from their experience bank (specific projects, roles, skills, and their
   actual metrics). Show the fit with a concrete example, don't just assert "I am a great fit."

Grounding (hard rule): never invent an employer, project, title, metric, or skill the student
doesn't actually have, and never invent a fact about the company beyond what the JD states. If the
experience bank or JD doesn't support a claim, stay general and honest rather than fabricating a
specific.

Premise (hard rule): a question can presuppose an artifact, event, or status that the student's
material does not support - "tell us about your submitted project" when nothing was submitted,
"the portfolio piece you attached", "as we discussed". NEVER adopt such a premise. An answer built
from true facts under a false frame is still false: "For my submission I built X" lies even when X
is real. When the substance exists, answer from what is actually true and refuse the frame - "The
project I would point to is X, which I built..." - describing past work in the past tense, tied to
its real employer or project name, never claiming to have submitted, attached, linked, or built
anything for THIS application. When no honest answer exists without the missing artifact, output
exactly CANNOT_DRAFT and nothing else, so the field is flagged for the student instead of filled
with a false frame.

Ranking (hard rule): when the question asks you to rank, order, or list items by preference or
proficiency (languages, skills, tools, technologies), every item you place in that ranking is a
skill claim in the student's name. Rank ONLY items that appear in the student's declared skills
list. An item the question names that is not on that list must not be ranked, claimed, or
described as used: leave it out of the answer entirely, without apologizing for the gap. When
that leaves fewer items than the question asks for, rank the real ones rather than padding the
list with skills the student does not hold.

Voice and format:
- First person, the student's own plain voice. Direct and specific, not corporate.
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

// The drafter's refusal sentinel (R-029). When the prompt's premise rule concludes no honest
// answer exists, the model outputs CANNOT_DRAFT; mapping it to '' routes the refusal through the
// module's existing cannot-draft path - the route already 502s on an empty answer ("Empty draft
// returned") and the extension already flags an undrafted field for the student - so a refusal
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
// student never declared a skills list ([] / NULL means "never declared", not "holds nothing",
// the same semantics the declared list carries everywhere else, R-027) - the prompt's ranking
// rule is the remaining guard in that case.
export interface RankingGrounding {
  items: string[]; // the question's own candidate list ([] when it names none)
  held: string[]; // items also on the declared list, in the question's order and casing
  unheld: string[]; // items the student never declared: never rankable, never mentionable
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
    return 'This is a ranking question. Rank only skills on the declared skills list; never rank or claim anything the student has not declared.';
  }
  const held = `Of the items the question names, the student's declared skills cover only: ${ranking.held.join(', ')}. Rank only these.`;
  const unheld = ranking.unheld.length
    ? ` The question also names ${ranking.unheld.join(', ')}, which the student has NOT declared: do not rank, claim, or mention them at all.`
    : '';
  return `This is a ranking question. ${held}${unheld}`;
}

// The review warning a thinner-than-the-ask ranking carries (R-042's "flag when the intersection
// is thinner than the ask"): the student sees exactly what the question wanted and what the draft
// honestly left out, instead of a confident answer that silently shrank the list.
export function thinRankingWarning(ranking: RankingGrounding): string | null {
  if (ranking.items.length === 0 || ranking.unheld.length === 0) return null;
  return `Ranking ask names ${ranking.items.length} items but your declared skills cover ${ranking.held.length} (${ranking.held.join(', ')}); the draft omits: ${ranking.unheld.join(', ')}.`;
}

function buildContextBlock(
  company: string,
  role: string,
  jdText: string,
  bank: ExperienceBankEntry[],
  education: { school?: string; grad_year?: number },
  declaredSkills: string[],
): string {
  // The declared list rides the cached prefix like the bank: per-student, not per-question, so it
  // is identical across every essay box of a form and never busts the cache. Before R-042 the
  // drafter had no skills source at all, which left both the prose grounding rule and the ranking
  // rule with nothing authoritative to rank against.
  const skillsBlock = declaredSkills.length
    ? `\n\nDeclared skills (the student's own list, the only skills you may claim or rank):\n${JSON.stringify(declaredSkills)}`
    : '';
  return `Role: ${role} at ${company}\n\nJob description:\n${jdText.slice(0, 6000)}\n\nEducation: ${education.school ?? ''}${education.grad_year ? `, class of ${education.grad_year}` : ''}${skillsBlock}\n\nExperience bank:\n${JSON.stringify(bank)}`;
}

export async function draftApplicationAnswer(
  question: string,
  company: string,
  role: string,
  jdText: string,
  bank: ExperienceBankEntry[],
  education: { school?: string; grad_year?: number },
  // The student's declared skills (profiles.skills, R-015's authority). Empty/undefined means
  // "never declared", which disables the deterministic ranking check (R-042) but must never be
  // read as "holds no skills" - the same NULL-vs-[] semantics the list carries everywhere else.
  declaredSkills?: string[] | null,
): Promise<AnswerResult> {
  const declared = (declaredSkills ?? []).filter(
    (s) => typeof s === 'string' && s.trim().length > 0,
  );

  // R-042: a ranking ask is graded against the declared list before any model call.
  const ranking = rankingGroundingFor(question, declared);

  // The question names candidates and the student holds NONE of them: no honest ranking exists,
  // so this rides the cannot-draft path deterministically (empty answer -> route 502 -> the
  // extension flags the field for the student, same signal as an R-029 premise refusal) instead
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

  // Grounding source = the student's real material only: experience bank text + the JD (facts
  // about the company are allowed only if the JD states them) + their school.
  const bankCorpus = bank
    .map((e) => {
      const variants = Array.isArray(e.bullet_variants) ? (e.bullet_variants as string[]) : [];
      const tags = Array.isArray(e.tags) ? (e.tags as string[]) : [];
      return [e.org, e.title ?? '', e.date_range ?? '', ...variants, ...tags].join(' ');
    })
    .join(' ');
  const corpusText = `${bankCorpus} ${jdText} ${education.school ?? ''}`;
  const sourceSignatures = numberSignatures(corpusText);
  const corpusWords = wordSet(corpusText);

  let answer = normalizeDraftedAnswer(await callModel());
  // A premise refusal (R-029) is final: '' flows out through the empty-answer path below and the
  // route's existing 502, so the field is flagged for the student rather than drafted.
  if (answer === '') return { answer: '', warnings: [] };

  // If the draft used numbers not present in the student's material, regenerate once with that as
  // explicit feedback (same self-correcting pattern as the resume path).
  let badNumbers = ungroundedNumbers(answer, sourceSignatures);
  if (badNumbers.length > 0) {
    answer = normalizeDraftedAnswer(
      await callModel(
        `Your previous draft included numbers that are NOT in the student's experience bank or the job description: ${badNumbers.join(', ')}. Rewrite it using only facts and figures that appear in the provided material. Do not invent metrics.`,
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
        `Your previous draft named ${unheldClaims.join(', ')}, which the student has NOT declared as skills. Rewrite it ranking only ${ranking.held.join(', ')}, and do not mention the undeclared items at all.`,
      ),
    );
    unheldClaims = claimedUnheldItems(answer, ranking.unheld);
  }
  // Still claiming an unheld skill after explicit feedback: never ship it. Unlike a suspect
  // number (a review warning the student edits), an unheld-skill claim is the exact R-015 harm,
  // so this fails closed through the cannot-draft path: empty answer -> route 502 -> the
  // extension flags the field for the student instead of filling it with a false claim.
  if (unheldClaims.length > 0) {
    return { answer: '', warnings: [] };
  }

  // L6: enforce the zero-em-dash rule by STRIPPING dashes from the returned answer, not just
  // warning. The extension fills essay fields directly and never surfaces these warnings, so an
  // em dash would otherwise reach a submitted application.
  answer = stripEmDashes(answer);

  // Remaining grounding + quality signals are surfaced as review warnings (the student edits
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
  // the student rather than presented as a confident complete answer.
  const thinRanking = ranking ? thinRankingWarning(ranking) : null;
  if (thinRanking) warnings.push(thinRanking);
  const wordCount = answer.split(/\s+/).filter(Boolean).length;
  if (wordCount > 160) warnings.push(`Answer is ${wordCount} words - consider trimming.`);

  return { answer, warnings };
}
