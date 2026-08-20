import Anthropic from '@anthropic-ai/sdk';
import {
  contestedMetricsUsed,
  numberSignatures,
  stripEmDashes,
  ungroundedNumbers,
  unsupportedCommitments,
  wordSet,
  ungroundedProperNouns,
} from '../engine/grounding';
import { generateOpenAIText, logOpenAIFallback, openAIConfigured } from './openAIProvider';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type CoverLetterDraft = {
  body: string;
  word_count: number;
  warnings: string[];
};

/* THE TWO RULES THAT ARE NOT STYLE.
 *
 * "Never state where the candidate is" and "never promise" are one rule with two halves, and they
 * are written out at length because the model has a strong pull the other way: the posting asks
 * "will you be in the Seattle area?", the letter is prose, and answering it reads like being
 * helpful. It is not. See engine/grounding.ts unsupportedCommitments for the incident and the
 * reasoning. The prompt is the cheap half of the fix; validateCoverLetter is the half that holds.
 */
export const COVER_LETTER_SYSTEM_PROMPT = `You write highly tailored cover letters for real job applications.

Return only JSON: {"body": string}.

Rules:
- Write 230 to 340 words in 3 or 4 short paragraphs.
- Name the exact role and company in the opening paragraph.
- Connect the earliest and strongest job requirements to specific evidence from the candidate source.
- Use only employers, projects, skills, technologies, titles, dates, and metrics present in the candidate source.
- Attribute every metric to the same employer or project the candidate source attributes it to. Never move a result from one employer or project to another.
- The job description defines what matters, but it is never evidence that the candidate has done something.
- Do not invent a hiring manager name, address, referral, value, achievement, or personal motivation.
- Never state where the candidate lives, is based, or will be located.
- Never promise anything on the candidate's behalf. That includes relocating, moving, being in an office, working on-site or in person, commuting, being available on a date or for a length of time, start dates, hours, exclusivity, and non-competes.
- If the job description asks about location, relocation, office attendance, availability, or a start date, say nothing about it. A person answers those questions separately. Leaving it out is correct and expected.
- Do not copy sentences from the job description.
- Sound direct, specific, and human. Avoid generic enthusiasm, flattery, and corporate filler.
- Do not include a greeting, date, address block, or sign-off. The renderer adds those.
- Never use an em dash or en dash. Use commas, colons, hyphens, or periods.`;

export function validateCoverLetter(
  body: string,
  company: string,
  role: string,
  candidateSource: string,
  contested: { labels: string[]; signatures: Set<string> } = { labels: [], signatures: new Set() },
): { issues: string[]; warnings: string[]; word_count: number; body: string } {
  const cleaned = stripEmDashes(body).replace(/\n{3,}/g, '\n\n').trim();
  const word_count = cleaned.split(/\s+/).filter(Boolean).length;
  const issues: string[] = [];
  const warnings: string[] = [];
  if (word_count < 210 || word_count > 370) issues.push(`cover letter is ${word_count} words; target 230 to 340`);
  if (!cleaned.toLowerCase().includes(company.toLowerCase())) issues.push('cover letter does not name the company');
  const roleTerms = [...wordSet(role)];
  if (roleTerms.length > 0 && !roleTerms.some((term) => cleaned.toLowerCase().includes(term))) {
    issues.push('cover letter does not name the target role');
  }
  const fabricatedNumbers = ungroundedNumbers(cleaned, numberSignatures(candidateSource));
  if (fabricatedNumbers.length > 0) issues.push(`cover letter contains ungrounded numbers: ${fabricatedNumbers.join(', ')}`);
  const promises = unsupportedCommitments(cleaned);
  for (const sentence of promises) {
    issues.push(
      'cover letter promises something on the candidate\'s behalf, which only she can do. '
      + `Delete this sentence and do not replace it: "${sentence.slice(0, 160)}"`,
    );
  }
  const reused = contestedMetricsUsed(cleaned, contested.signatures);
  if (reused.length > 0) {
    issues.push(
      `cover letter uses figures the candidate source attributes to more than one employer or project, so they cannot be credited to any of them: ${reused.join(', ')}. `
      + 'Remove the claims that carry them. Do not substitute a different number.',
    );
  }
  /* THE PROPER-NOUN SIGNAL STAYS ADVISORY, and it was measured before that was decided.
   *
   * It is what half-caught the Greater Seattle promise (the packet carries "Review names not found
   * in candidate data: Greater Seattle" and shipped anyway), so promoting it to a blocking issue is
   * the obvious move. Run over all 136 stored letters on 2026-08-09 it fires on 96 of them, 70.6%,
   * and of the 38 distinct phrases it flags only two are locations: 73 of the hits are "Oriented
   * Design" and "Oriented Programming", a tokenizer artifact where wordSet keeps "object-oriented"
   * whole and this regex cannot cross the hyphen, and most of the rest are acronyms lifted from the
   * job description (BS, ML, CS, CI, CD, SPI, JTAG, CUDA). Gating on it would refuse seven letters
   * in ten over a hyphen.
   *
   * So the blocking moved to unsupportedCommitments above, which is about the ACT rather than the
   * vocabulary: "Greater Seattle" is not the problem, promising to be in it is, and that check ran
   * over the same 136 letters and flagged 8, every one a real promise and no false positives. An
   * unfamiliar name stays a warning because an unfamiliar name is worth a glance and nothing more.
   */
  const properNouns = ungroundedProperNouns(cleaned, wordSet(`${candidateSource} ${company} ${role}`));
  /* USER-FACING, so it reads like a note to the applicant reviewing her own letter, not like the
   * internal diagnostic it used to be. The old text, "Review names not found in candidate data:
   * X", is written for whoever maintains the grounding check: "candidate data" names an internal
   * corpus and "review" with no object reads as an imperative aimed at a developer. It shipped
   * verbatim into the applicant-facing panel because nothing between here and the screen was ever
   * meant to translate it, the same shape of leak documented in fieldLabel.ts. Phrased to match the
   * identical check's already-shipped applicant-facing wording in applicationAnswer.ts. */
  if (properNouns.length > 0) {
    warnings.push(`Names/orgs not found in your background, ${company}, or ${role} (verify before sending): ${properNouns.join(', ')}`);
  }
  if (/\bI am writing to (?:apply|express)|\bI believe I would be a great fit\b/i.test(cleaned)) {
    warnings.push('Opening uses generic cover-letter language');
  }
  return { issues, warnings, word_count, body: cleaned };
}

/**
 * Re-encode control characters that are already inside a JSON string literal.
 *
 * This is the whole reason a healthy model kept producing an "invalid" cover letter. The prompt
 * asks for a 3-or-4 PARAGRAPH letter returned inside a JSON string, so every single response has to
 * encode paragraph breaks somehow. Claude escapes them as \n most of the time and emits a RAW
 * newline the rest of the time. JSON.parse rejects a raw control character inside a string literal
 * ("Bad control character in string literal"), so a complete, well-formed, perfectly usable letter
 * was discarded as garbage. Measured 2 failures in 8 calls against a real Gemini SEI posting on
 * 2026-08-04, which is why it read as a flaky portal rather than a parser bug.
 *
 * The stored submission_error is truncated to 200 characters, so the operator only ever saw a JSON
 * prefix that cut off mid-word and looked like a token-limit truncation. It was not: stop_reason
 * was end_turn on every observed failure. The generateCoverLetter max_tokens guard below covers the
 * truncation case separately, so the two are never confused again.
 *
 * This invents nothing. It only re-encodes characters that are already inside a string literal, so
 * a response that is genuinely malformed still fails.
 */
export function escapeRawControlCharacters(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const char of json) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      out += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }
    if (inString && char < ' ') {
      out += char === '\n' ? '\\n'
        : char === '\r' ? '\\r'
          : char === '\t' ? '\\t'
            : `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Pull the letter body out of whatever Claude actually returned.
 *
 * Deliberately tolerant of the three shapes observed live - a bare object, a ```json fence, and an
 * object whose string values carry raw newlines - and deliberately intolerant of anything else. A
 * truncated or genuinely broken response still throws, because silently accepting half a cover
 * letter would put half a cover letter in front of an employer.
 */
export function parseCoverLetterBody(text: string): string {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/m, '').replace(/```\s*$/m, '');
  const first = unfenced.indexOf('{');
  const last = unfenced.lastIndexOf('}');
  const candidate = first >= 0 && last > first ? unfenced.slice(first, last + 1) : unfenced;
  for (const attempt of [candidate, escapeRawControlCharacters(candidate)]) {
    try {
      const parsed = JSON.parse(attempt) as { body?: unknown };
      if (typeof parsed.body === 'string' && parsed.body.trim()) return parsed.body;
    } catch {
      // Fall through to the repaired form, then to the honest failure below.
    }
  }
  throw new Error(`Claude returned an invalid cover letter: ${text.slice(0, 200)}`);
}

export async function generateCoverLetter(
  input: {
    company: string;
    role: string;
    jd_text: string;
    candidate_source: string;
    /* Figures the candidate source attributes to two different orgs, so no org may be credited with
     * them. Named in the request rather than only caught in validation, because the retry loop costs
     * a whole extra call and the model has no way to see the conflict from inside the source. */
    contested_metrics?: string[];
  },
  feedback: string[] = [],
): Promise<string> {
  const userContent = `Role: ${input.role}\nCompany: ${input.company}\n\nJob description:\n${input.jd_text}\n\nCandidate source, the only authority for candidate claims:\n${input.candidate_source}${
    input.contested_metrics?.length
      ? `\n\nThese figures appear under more than one employer or project in the candidate source, so which one they belong to is not established: ${input.contested_metrics.join(', ')}. Do not use any of them, and do not use any claim built on them. Do not substitute a different number.`
      : ''
  }${feedback.length ? `\n\nFix these validation issues:\n${feedback.map((item) => `- ${item}`).join('\n')}` : ''}`;

  if (openAIConfigured() && feedback.length === 0) {
    try {
      const generated = await generateOpenAIText({
        instructions: COVER_LETTER_SYSTEM_PROMPT,
        input: userContent,
        maxOutputTokens: 8192,
        jsonSchema: {
          name: 'litos_cover_letter',
          schema: {
            type: 'object',
            properties: { body: { type: 'string' } },
            required: ['body'],
            additionalProperties: false,
          },
        },
      });
      return parseCoverLetterBody(generated.text);
    } catch (error) {
      logOpenAIFallback('cover letter', error);
    }
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    // max_tokens is a SHARED budget for thinking AND the emitted JSON, not just the JSON. Adaptive
    // thinking is on by default on this model and its depth varies per posting: measured on a real
    // Gemini SEI call, output_tokens ranged from 654 (no thinking block at all) to 1188 (thinking
    // ran) for the SAME prompt. At the old 2048 that left as little as ~850 tokens of headroom on a
    // long posting, and the failure mode is the nasty one the sibling generators already document:
    // the JSON truncates mid-string and the letter is lost. 8192 clears the largest observed
    // response by roughly 7x. Output is billed on what is generated, so the higher ceiling costs
    // nothing on a normal call.
    max_tokens: 8192,
    system: [{ type: 'text', text: COVER_LETTER_SYSTEM_PROMPT }],
    messages: [{
      role: 'user',
      content: userContent,
    }],
  });
  const block = response.content.find((item) => item.type === 'text');
  const text = block?.type === 'text' ? block.text : '';
  // Named separately from the parse failure on purpose. Both used to surface as "invalid cover
  // letter", which is how a raw-newline bug spent its life being read as a token-limit problem.
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`Cover letter truncated at max_tokens (${text.length} chars) - raise the cap`);
  }
  return parseCoverLetterBody(text);
}
