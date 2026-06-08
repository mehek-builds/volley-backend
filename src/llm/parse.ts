import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ParsedProfile {
  experience: Array<{
    company: string;
    title: string;
    start: string;
    end: string;
    description: string;
  }>;
  skills: string[];
  projects: Array<{
    name: string;
    description: string;
  }>;
  school: string;
  grad_year: number;
  target_roles: string[];
}

const SYSTEM_PROMPT = `You are a resume parser. Extract structured information from resume text and return ONLY valid JSON with no explanation or markdown wrapping.

The JSON must match this exact shape:
{
  "experience": [{"company": string, "title": string, "start": string, "end": string, "description": string}],
  "skills": [string],
  "projects": [{"name": string, "description": string}],
  "school": string,
  "grad_year": number,
  "target_roles": [string]
}

Rules:
- "end" should be "Present" if the role is current
- "grad_year" should be a 4-digit integer; infer from graduation date or expected graduation
- "target_roles" should be inferred from the resume objective, job titles, or skills (e.g. ["Software Engineer", "ML Engineer"])
- Return empty arrays for missing sections, never null
- If grad_year is truly unknown, use 0`;

export async function parseResumeWithClaude(resumeText: string): Promise<ParsedProfile> {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Parse this resume text and return the JSON:\n\n${resumeText}`,
      },
    ],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  try {
    // Strip any accidental markdown code fences
    const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    return JSON.parse(cleaned) as ParsedProfile;
  } catch {
    throw new Error(`Claude returned invalid JSON for resume parsing: ${text.slice(0, 200)}`);
  }
}
