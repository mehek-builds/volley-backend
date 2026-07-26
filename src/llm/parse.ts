import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ParsedProfile {
  full_name: string;
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
    role?: string;
    date_range?: string;
    description: string;
  }>;
  leadership?: Array<{
    organization: string;
    title: string;
    start: string;
    end: string;
    description: string;
  }>;
  school: string;
  degree?: string;
  grad_date?: string;
  grad_year: number;
  currently_enrolled?: boolean;
  coursework?: string[];
  target_roles: string[];
  // Page count of the file this parse came from, measured by extractPdfText and stamped on by
  // routes/profile.ts - NOT produced by the model, which never sees the page structure. /start
  // states it back to the student when it shows the one-page base resume. 0 means unmeasured.
  source_pages?: number;
}

// R-047, the failure the degree rule below exists to prevent. An uploaded resume reading
// "Bachelor of Science in Computer Science & Business Administration, Finance Emphasis" was stored
// as "Bachelor of Science in Business Administration, Emphasis in Finance": the Computer Science
// half dropped and the emphasis reworded, turning a computer science candidate into a finance
// candidate on every software application.
//
// The concrete strings stay HERE, in a comment, and deliberately NOT in the prompt. A plausible
// verbatim degree inside the model-visible text is few-shot contamination: for a resume whose
// education section is unclear, it hands the model a ready-made degree to emit, which is exactly
// the fabrication the rule forbids two lines later.
//
// The prompt is the only defence. resumeValidate.ts's guard ("education degree differs from
// uploaded resume") compares the generated spec against whatever THIS parser stored, so a degree
// corrupted here is corrupted everywhere downstream with nothing left to catch it. Exported so a
// test can pin the rule against a later prompt cleanup.
export const SYSTEM_PROMPT = `You are a resume parser. Extract structured information from resume text and return ONLY valid JSON with no explanation or markdown wrapping.

The JSON must match this exact shape:
{
  "full_name": string,
  "experience": [{"company": string, "title": string, "start": string, "end": string, "description": string}],
  "skills": [string],
  "projects": [{"name": string, "role": string, "date_range": string, "description": string}],
  "leadership": [{"organization": string, "title": string, "start": string, "end": string, "description": string}],
  "school": string,
  "degree": string,
  "grad_date": string,
  "grad_year": number,
  "currently_enrolled": boolean,
  "coursework": [string],
  "target_roles": [string]
}

Rules:
- "full_name" is the applicant's name from the resume header, not a company or school name
- "end" should be "Present" if the role is current
- Preserve the education wording from the uploaded resume. Do not upgrade or infer a degree.
- "degree" is the degree line copied VERBATIM from the Education section. Carry BOTH halves of a
  joint or dual degree; keep every field, emphasis or concentration exactly as printed and in the
  same order; do not shorten, reorder or summarise. Never let the school or college name influence
  the degree: a business school hosts non-business degrees, an engineering school hosts
  non-engineering ones. If the resume states no degree, return an empty string rather than
  inferring one.
- "grad_date" must preserve the most precise date printed on the resume, such as "May 2028". Use an empty string when absent.
- "grad_year" should be the 4-digit year from grad_date. Use 0 when it is absent.
- "currently_enrolled" is true only when the resume explicitly says expected graduation, candidate, current student, or otherwise clearly shows an unfinished degree with a future graduation date.
- "coursework" may contain only courses explicitly printed on the resume.
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

  const textBlock = response.content.find((block) => block.type === 'text');
  const text = textBlock?.type === 'text' ? textBlock.text : '';

  try {
    // Strip any accidental markdown code fences
    const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    return JSON.parse(cleaned) as ParsedProfile;
  } catch {
    throw new Error(`Claude returned invalid JSON for resume parsing: ${text.slice(0, 200)}`);
  }
}
