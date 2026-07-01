import Anthropic from '@anthropic-ai/sdk';
import type { ExperienceBankEntry } from '../db/schema';
import { STRONG_VERBS } from '../engine/resumeValidate';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ResumeSpec {
  school: string;
  degree: string;
  grad_date: string;
  coursework: string;
  experience: Array<{
    org: string;
    title: string;
    date_range: string;
    bullets: string[]; // exactly 3, chosen/lightly rewritten from bullet_variants
  }>;
  skills: string[]; // ordered by relevance to the JD, JD keywords surfaced first
}

// Content rules ported from the Dubai off-cycle resume engine's validate_resume.py /
// pressure_test.py (~/Documents/Internship Apps/_resume-engine/), the same quality bar
// applied to Mehek's own resume builds. Encoded here as generation instructions; enforced
// again post-generation by engine/resumeValidate.ts so drift gets caught, not just discouraged.
const SYSTEM_PROMPT = `You are a resume-tailoring engine. Given a job description and a student's full
experience bank (every job/project they've ever had, with every bullet-point phrasing they've used for
each achievement), select and lightly rewrite the best-fit subset for THIS specific posting.

Return ONLY valid JSON with no explanation or markdown wrapping, matching this exact shape:
{
  "school": string, "degree": string, "grad_date": string, "coursework": string,
  "experience": [{"org": string, "title": string, "date_range": string, "bullets": [string, string, string]}],
  "skills": [string]
}

Rules:
- Pick up to 3 experience entries that best match the JD, most relevant first.
- For each entry pick exactly 3 bullets: reuse a stored bullet_variant verbatim when one already fits well;
  only lightly rewrite (never fabricate achievements) when no stored variant surfaces the JD's language.
- Order skills so the ones matching JD keywords come first.
- Never invent an employer, title, or metric that isn't grounded in the experience bank.
- Every bullet starts with a strong action verb, one of: ${[...STRONG_VERBS].join(', ')}.
- Every bullet is 8-30 words, one sentence, no more than two "and"s (prefer ; : or - over a run-on).
- Include a real number, percent, dollar amount, or multiplier in a bullet whenever the source material
  supports one; do not invent metrics that aren't grounded in the experience bank.
- NEVER use an em dash (—) anywhere in the output. Use a comma, colon, hyphen, or period instead.
- Bullets must fit in roughly two lines of a resume (under 235 characters) - be concise, not padded.`;

export async function generateResumeSpec(
  jdText: string,
  company: string,
  role: string,
  bank: ExperienceBankEntry[],
  education: { school: string; degree?: string; grad_year?: number },
  feedback?: string[],
): Promise<ResumeSpec> {
  const feedbackBlock = feedback?.length
    ? `\n\nThe previous attempt had these issues - fix them in this revision:\n${feedback.map((f) => `- ${f}`).join('\n')}`
    : '';

  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 2048,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `Job: ${role} at ${company}\n\nJob description:\n${jdText}\n\nEducation: ${education.school}${education.grad_year ? `, class of ${education.grad_year}` : ''}\n\nExperience bank:\n${JSON.stringify(bank, null, 2)}\n\nReturn the tailoring spec JSON.${feedbackBlock}`,
      },
    ],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  try {
    const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    return JSON.parse(cleaned) as ResumeSpec;
  } catch {
    throw new Error(`Claude returned invalid JSON for resume spec: ${text.slice(0, 200)}`);
  }
}
