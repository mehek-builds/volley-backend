import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Does this resume evidence what this requirement asks for?
 *
 * ONLY COMPETENCY CLAUSES REACH HERE. Named technologies stay in the literal matcher and structured
 * facts (degree field, graduation window, years of experience) stay in the deterministic one. Those
 * two are decidable without judgement and must not become a model call, because a model that can
 * decide them can also get them wrong in ways nobody can audit.
 *
 * WHY A MODEL AT ALL, when this file's whole neighbourhood distrusts inference. Measured over 600
 * live postings and six real base resumes, regex competency cues score 0 on the thing that matters:
 *
 *   variant                        p50   on-field  off-field  separation
 *   term model (shipped)             0      10.6       4.4       6.2
 *   clause + regex competency       21      30.3      25.2       5.0
 *
 * The clause model's numbers are believable and they DISCRIMINATE WORSE, because a cue list credits
 * nearly every resume with communication, analysis and collaboration. Separating "analysed
 * portfolio allocations across 20+ positions" from "analysed product usage for a data platform" is
 * a judgement about DOMAIN, and a verb list cannot make it. That is the whole reason this call
 * exists, and it is the only thing it is allowed to decide.
 *
 * THE EVIDENCE RULE, which is what keeps this honest: a verdict of `met` is INVALID unless it
 * quotes the bullet it came from, verbatim, and that quote is checked against the real bullet list
 * before the verdict is accepted. A model that decides someone communicates well without being able
 * to point at the sentence is guessing, and guesses are rejected rather than downgraded. This is
 * the same discipline the resume writer already runs under (see engine/grounding.ts): the model may
 * select and judge, never invent.
 */

export interface CompetencyQuestion {
  /** Stable id so answers can be matched back without relying on array order. */
  id: string;
  /** The employer's requirement, verbatim. */
  clause: string;
}

export interface CompetencyRejection {
  /** The question this concerns, when it concerns one. Absent for whole-response failures. */
  id?: string;
  reason: string;
}

export interface CompetencyVerdict {
  id: string;
  met: boolean;
  /** The bullet the model relied on, verbatim. Required when met, ignored when not. */
  quote?: string;
  /** One short sentence, in the student's terms, for the gap list. */
  why?: string;
}

export const COMPETENCY_SYSTEM_PROMPT = `You decide whether a candidate's resume evidences what a job requirement asks for.

Return only JSON: {"verdicts": [{"id": string, "met": boolean, "quote": string, "why": string}]}.

Rules:
- Judge each requirement independently, against the candidate bullets only.
- "met" means a bullet shows the candidate ACTUALLY DID the thing the requirement asks for, in a comparable context. Doing it in a different domain still counts; claiming it without evidence does not.
- When met, "quote" MUST be one bullet copied verbatim from the candidate bullets. Never paraphrase, never combine two bullets, never quote the requirement.
- If no single bullet supports it, set met to false and leave quote empty. A weak or tangential match is false.
- Being adjacent is not evidence. "Led a team" does not evidence "mentored engineers". "Wrote a report" does not evidence "presented to executives".
- The job description is never evidence about the candidate.
- "why" is one short sentence a student would understand, naming what is present or what is missing.
- Never use an em dash or en dash. Use commas, colons, hyphens, or periods.`;

function buildUserMessage(bullets: string[], questions: CompetencyQuestion[]): string {
  const bulletBlock = bullets.map((b, i) => `${i + 1}. ${b}`).join('\n');
  const questionBlock = questions.map((q) => `- id ${q.id}: ${q.clause}`).join('\n');
  return `CANDIDATE BULLETS\n${bulletBlock}\n\nREQUIREMENTS TO JUDGE\n${questionBlock}`;
}

/** Strips fences and pulls the first JSON object, the same shape the other callers here handle. */
function parseJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in response');
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * Normalised for the quote check: the model reproduces a bullet with different whitespace or a
 * curly apostrophe often enough that an exact-string test would reject good answers. Case,
 * punctuation and spacing are not what we are verifying; the WORDS are.
 */
function normalizeQuote(s: string): string {
  return s.toLowerCase().replace(/[‘’“”]/g, "'").replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * A quote counts as grounded when it IS one of the bullets, or is a contiguous run of one.
 * Substring rather than equality because a model asked for "one bullet verbatim" will sometimes
 * hand back the clause of it that did the work, which is still the student's own sentence.
 */
export function quoteIsGrounded(quote: string, bullets: string[]): boolean {
  const q = normalizeQuote(quote);
  if (!q) return false;
  const normalised = bullets.map((b) => normalizeQuote(b));

  /* A WHOLE BULLET IS ALWAYS GROUNDED, whatever its length. The floor below is for substrings.
     A six-word minimum applied to everything made any short bullet permanently uncitable:
     "Built Litos, a Chrome extension" is five words, so every verdict resting on it was downgraded
     to unmet no matter how right the model was. */
  if (normalised.some((b) => b === q)) return true;

  /* SIX WORDS for a SUBSTRING, not twelve characters.
     A twelve-character floor accepted "led the team" or "and analysis" as a citation, which is the
     model echoing a common phrase rather than pointing at a sentence. The gate is the single rule
     the whole design rests on: if a fragment can ground a verdict, the verdict is not grounded. */
  if (q.split(' ').filter(Boolean).length < 6) return false;
  return normalised.some((b) => b.includes(q));
}

export function validateVerdicts(
  raw: unknown,
  questions: CompetencyQuestion[],
  bullets: string[],
): { verdicts: CompetencyVerdict[]; rejected: CompetencyRejection[] } {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const out: CompetencyVerdict[] = [];
  const rejected: CompetencyRejection[] = [];
  const list = (raw as { verdicts?: unknown[] })?.verdicts;
  if (!Array.isArray(list)) return { verdicts: [], rejected: [{ reason: 'response had no verdicts array' }] };

  for (const item of list) {
    const v = item as Partial<CompetencyVerdict>;
    if (typeof v?.id !== 'string' || !byId.has(v.id)) {
      rejected.push({ reason: `unknown id ${String(v?.id)}` });
      continue;
    }
    if (v.met !== true) {
      out.push({ id: v.id, met: false, why: typeof v.why === 'string' ? v.why : undefined });
      continue;
    }
    // THE GATE. A `met` with no grounded quote is downgraded to unmet rather than trusted, and the
    // rejection is reported so a run that starts hallucinating is visible rather than silently
    // generous. This is the one rule that makes an LLM verdict safe to put a number on.
    if (typeof v.quote !== 'string' || !quoteIsGrounded(v.quote, bullets)) {
      rejected.push({ id: v.id, reason: 'met without a grounded quote' });
      out.push({ id: v.id, met: false, why: 'no bullet on the resume supports this' });
      continue;
    }
    out.push({ id: v.id, met: true, quote: v.quote, why: typeof v.why === 'string' ? v.why : undefined });
  }
  // A question the model skipped is unmet, not absent: a missing answer must not quietly shrink the
  // denominator, which is the padding failure preferStatedRequirements exists to prevent.
  /* A question the model skipped is unmet for THIS response, so the denominator does not quietly
     shrink by exactly the requirements that were hardest to judge. It is also reported as rejected,
     which is what keeps it OUT of the cache: writing "not judged" to a store that never expires
     would freeze those clauses at unmet for every student who ever has the same bullets. */
  for (const q of questions) {
    if (!out.some((v) => v.id === q.id)) {
      out.push({ id: q.id, met: false, why: 'not judged' });
      rejected.push({ id: q.id, reason: 'no verdict returned' });
    }
  }
  return { verdicts: out, rejected };
}

export async function judgeCompetencies(
  bullets: string[],
  questions: CompetencyQuestion[],
): Promise<{ verdicts: CompetencyVerdict[]; rejected: CompetencyRejection[] }> {
  if (questions.length === 0 || bullets.length === 0) {
    return { verdicts: questions.map((q) => ({ id: q.id, met: false, why: 'no resume bullets to judge against' })), rejected: [] };
  }
  // ONE call per posting-resume pair, not one per clause. A posting states five to thirteen of
  // these and a job list holds up to 24 postings, so per-clause calls would be the difference
  // between one request and two hundred.
  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    // Scales with the batch instead of a flat ceiling a long posting silently overruns. Each
    // verdict carries an id, a verbatim bullet quote and a sentence, so ~150 tokens apiece.
    max_tokens: Math.min(8_000, 600 + questions.length * 200),
    system: COMPETENCY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserMessage(bullets, questions) }],
  });
  /* A truncated or unparseable response THROWS, and that is deliberate after a review.
   *
   * The first version of this returned met:false for every question with an id-less rejection, and
   * both halves of that were wrong. The verdicts were confident UNMETS for questions nobody
   * answered, which scorePosting keeps in the denominator; and because competencyCache filters the
   * write on `r.id`, an id-less rejection filtered nothing, so one truncated response was written
   * to a store that never expires and froze those clauses at unmet for every student with the same
   * bullets. That is exactly the failure validateVerdicts was changed to prevent, reintroduced two
   * functions below it.
   *
   * Throwing is now the correct answer because scorePosting HAS a catch: it marks the competency
   * clauses `unscoreable` and returns the rejection, which is the honest state - we asked and got
   * no usable answer. Nothing reaches the cache, because the write happens after this returns. */
  if (response.stop_reason === 'max_tokens') {
    throw new Error('response hit the token ceiling before it finished');
  }
  const text = response.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  let parsed: unknown;
  try {
    parsed = parseJson(text);
  } catch (err) {
    throw new Error(`unparseable response: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  return validateVerdicts(parsed, questions, bullets);
}
