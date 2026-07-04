import Anthropic from '@anthropic-ai/sdk';
import type { ExperienceBankEntry } from '../db/schema';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Drafts an answer to an open-ended application question ("Why do you want to work here?",
// "Tell us about a project", ...) grounded ONLY in the student's real experience bank + the
// JD. The extension flags every field this fills as "AI draft - review before submitting", so
// the student always edits before it goes out; the job here is a strong, honest first draft in
// their voice, never a fabricated one.
//
// Anti-AI-tells discipline is deliberate (see the vault's letterstory-email-voice doc): these
// answers must read hand-written, or they hurt the student more than a blank box would.
const SYSTEM_PROMPT = `You draft a first-person answer to ONE job-application question for a student.

Ground every claim in the provided experience bank and job description. Never invent an
employer, project, metric, or skill the student doesn't actually have. If the experience bank
doesn't support a specific claim, stay general and honest rather than fabricating.

Voice and format:
- First person, the student's own plain voice. Direct and specific, not corporate.
- 60-130 words unless the question implies shorter. One or two short paragraphs.
- Reference something concrete from the student's background and something specific about THIS
  role/company from the JD - show the fit, don't assert it.
- NEVER use an em dash (—). Use a comma, colon, hyphen, or period.
- Banned AI-tell words/moves: "delve", "leverage", "tapestry", "testament to", "in today's
  ever-evolving", "passionate about" as an opener, "I am excited to" as an opener, "furthermore",
  "moreover", tricolons like "X, Y, and Z" as filler, and hollow superlatives.
- No preamble, no "Here's my answer", no quotes around it. Output ONLY the answer text.`;

export async function draftApplicationAnswer(
  question: string,
  company: string,
  role: string,
  jdText: string,
  bank: ExperienceBankEntry[],
  education: { school?: string; grad_year?: number },
): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 600,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `Question: ${question}\n\nRole: ${role} at ${company}\n\nJob description:\n${jdText.slice(0, 6000)}\n\nEducation: ${education.school ?? ''}${education.grad_year ? `, class of ${education.grad_year}` : ''}\n\nExperience bank:\n${JSON.stringify(bank, null, 2)}\n\nWrite the answer.`,
      },
    ],
  });
  const block = response.content.find((b) => b.type === 'text');
  return block?.type === 'text' ? block.text.trim() : '';
}
