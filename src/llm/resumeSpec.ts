import Anthropic from '@anthropic-ai/sdk';
import type { ExperienceBankEntry } from '../db/schema';

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
- Never invent an employer, title, or metric that isn't grounded in the experience bank.`;

export async function generateResumeSpec(
  jdText: string,
  company: string,
  role: string,
  bank: ExperienceBankEntry[],
  education: { school: string; degree?: string; grad_year?: number },
): Promise<ResumeSpec> {
  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 2048,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `Job: ${role} at ${company}\n\nJob description:\n${jdText}\n\nEducation: ${education.school}${education.grad_year ? `, class of ${education.grad_year}` : ''}\n\nExperience bank:\n${JSON.stringify(bank, null, 2)}\n\nReturn the tailoring spec JSON.`,
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
