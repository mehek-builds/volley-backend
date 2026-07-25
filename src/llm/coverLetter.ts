import Anthropic from '@anthropic-ai/sdk';
import { numberSignatures, stripEmDashes, ungroundedNumbers, wordSet, ungroundedProperNouns } from '../engine/grounding';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type CoverLetterDraft = {
  body: string;
  word_count: number;
  warnings: string[];
};

export const COVER_LETTER_SYSTEM_PROMPT = `You write highly tailored cover letters for real job applications.

Return only JSON: {"body": string}.

Rules:
- Write 230 to 340 words in 3 or 4 short paragraphs.
- Name the exact role and company in the opening paragraph.
- Connect the earliest and strongest job requirements to specific evidence from the candidate source.
- Use only employers, projects, skills, technologies, titles, dates, and metrics present in the candidate source.
- The job description defines what matters, but it is never evidence that the candidate has done something.
- Do not invent a hiring manager name, address, referral, value, achievement, or personal motivation.
- Do not copy sentences from the job description.
- Sound direct, specific, and human. Avoid generic enthusiasm, flattery, and corporate filler.
- Do not include a greeting, date, address block, or sign-off. The renderer adds those.
- Never use an em dash or en dash. Use commas, colons, hyphens, or periods.`;

export function validateCoverLetter(
  body: string,
  company: string,
  role: string,
  candidateSource: string,
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
  const properNouns = ungroundedProperNouns(cleaned, wordSet(`${candidateSource} ${company} ${role}`));
  if (properNouns.length > 0) warnings.push(`Review names not found in candidate data: ${properNouns.join(', ')}`);
  if (/\bI am writing to (?:apply|express)|\bI believe I would be a great fit\b/i.test(cleaned)) {
    warnings.push('Opening uses generic cover-letter language');
  }
  return { issues, warnings, word_count, body: cleaned };
}

export async function generateCoverLetter(
  input: { company: string; role: string; jd_text: string; candidate_source: string },
  feedback: string[] = [],
): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 2048,
    system: [{ type: 'text', text: COVER_LETTER_SYSTEM_PROMPT }],
    messages: [{
      role: 'user',
      content: `Role: ${input.role}\nCompany: ${input.company}\n\nJob description:\n${input.jd_text}\n\nCandidate source, the only authority for candidate claims:\n${input.candidate_source}${feedback.length ? `\n\nFix these validation issues:\n${feedback.map((item) => `- ${item}`).join('\n')}` : ''}`,
    }],
  });
  const block = response.content.find((item) => item.type === 'text');
  const text = block?.type === 'text' ? block.text : '';
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  const candidate = first >= 0 && last > first ? text.slice(first, last + 1) : text;
  try {
    const parsed = JSON.parse(candidate) as { body?: unknown };
    if (typeof parsed.body !== 'string' || !parsed.body.trim()) throw new Error('body missing');
    return parsed.body;
  } catch {
    throw new Error(`Claude returned an invalid cover letter: ${text.slice(0, 200)}`);
  }
}

