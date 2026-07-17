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
  // The student's OWN skills, those matching the JD first. NOT "JD keywords surfaced first", which
  // is what this said and what the prompt asked for - with no skills source in the system, that
  // instruction was an invitation to keyword-stuff, and the model took it (R-015).
  skills: string[];
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
- "skills": list ONLY skills from the student's Skills list, copied as they are written there. Of those,
  put the ones matching the JD first. If the Skills list is empty, use only skills clearly evidenced by a
  bullet you selected.
- NEVER add a skill because the job description asks for it. If the JD wants a tool and the student's
  Skills list doesn't have it, they don't have it: leave it out. A resume that omits a skill costs an
  interview; a resume that claims one the student lacks costs their credibility in the screen.
- Never invent an employer, title, metric, or skill that isn't grounded in the experience bank.
- Use the student's real school and degree exactly as given in the Education line; never invent or
  upgrade a degree, and leave "degree" an empty string if none is provided.
- "coursework": include only courses grounded in the experience bank or the job description; if none
  are grounded, return an empty string. Never invent course names to look more relevant.
- Every bullet starts with a strong action verb, one of: ${[...STRONG_VERBS].join(', ')}.
- Every bullet is 8-30 words, one sentence, no more than two "and"s (prefer ; : or - over a run-on).
- Include a real number, percent, dollar amount, or multiplier in a bullet whenever the source material
  supports one; do not invent metrics that aren't grounded in the experience bank.
- NEVER use an em dash (—) anywhere in the output. Use a comma, colon, hyphen, or period instead.
- Bullets must fit in roughly two lines of a resume (under 235 characters) - be concise, not padded.`;

// Coerce a parsed model response into a well-formed ResumeSpec: missing/mistyped fields become safe
// empties and a non-array experience/skills/bullets becomes []. Without this, a syntactically valid
// but partial JSON (e.g. no "experience" key) later crashed validateResumeSpec/renderResumePdf on
// `spec.experience.flatMap` / `spec.skills.length` with an uncaught TypeError -> opaque 500 that
// also bypassed the retry loop. An empty experience array is preserved (not faked), so the route's
// validation still flags "no experience entries" and retries/handles it cleanly.
export function normalizeSpec(raw: unknown): ResumeSpec {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const experience = (Array.isArray(o.experience) ? o.experience : [])
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({
      org: str(e.org),
      title: str(e.title),
      date_range: str(e.date_range),
      bullets: strArr(e.bullets),
    }));
  return {
    school: str(o.school),
    degree: str(o.degree),
    grad_date: str(o.grad_date),
    coursework: str(o.coursework),
    experience,
    skills: strArr(o.skills),
  };
}

export async function generateResumeSpec(
  jdText: string,
  company: string,
  role: string,
  bank: ExperienceBankEntry[],
  education: { school: string; degree?: string; grad_year?: number },
  feedback?: string[],
  // The student's declared skills (profiles.skills). Empty/undefined means they never gave us a
  // list, which the validator treats as soft-grounding rather than as "they have no skills".
  skills?: string[] | null,
): Promise<ResumeSpec> {
  const feedbackBlock = feedback?.length
    ? `\n\nThe previous attempt had these issues - fix them in this revision:\n${feedback.map((f) => `- ${f}`).join('\n')}`
    : '';

  // The rules are static and the job/JD/bank block is identical across the two attempts of a
  // single generate (only `feedbackBlock`, in the user turn, differs on the retry), so both go
  // in the cached system prefix: the retry then reads ~all of its input from cache instead of
  // re-sending the full JD + experience bank at full price. The bank/JD block carries the
  // cache_control marker because it is the large one - a marker on the short rules block alone
  // was below the model's minimum cacheable prefix and silently cached nothing. Bank is
  // serialized compactly (no 2-space pretty-print) to nearly halve its token weight.
  // The skills list sits in the cached prefix alongside the bank: it is per-student, not per-JD, so
  // it is identical across both attempts of a generate and across every application they file.
  const skillsBlock = skills?.length
    ? `\n\nSkills list (the student's own skills - the ONLY skills that may appear in "skills"):\n${JSON.stringify(skills)}`
    : `\n\nSkills list: none provided. Use only skills clearly evidenced by a bullet you selected, and do not add skills from the job description.`;
  const contextBlock = `Job: ${role} at ${company}\n\nJob description:\n${jdText}\n\nEducation: ${education.school}${education.degree ? `, ${education.degree}` : ''}${education.grad_year ? `, class of ${education.grad_year}` : ''}${skillsBlock}\n\nExperience bank:\n${JSON.stringify(bank)}`;
  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4096,
    system: [
      { type: 'text', text: SYSTEM_PROMPT },
      { type: 'text', text: contextBlock, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: `Return the tailoring spec JSON.${feedbackBlock}`,
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  const text = textBlock?.type === 'text' ? textBlock.text : '';

  if (response.stop_reason === 'max_tokens') {
    throw new Error(`Resume spec truncated at max_tokens (${text.length} chars) - raise the cap`);
  }

  try {
    const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    return normalizeSpec(JSON.parse(cleaned));
  } catch {
    // Fence stripping can miss (explanation text around the fence, stray trailing output);
    // the outermost brace pair is the spec whenever one parses.
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return normalizeSpec(JSON.parse(text.slice(first, last + 1)));
      } catch {
        // fall through to the descriptive error
      }
    }
    throw new Error(
      `Claude returned invalid JSON for resume spec (stop_reason=${response.stop_reason}): ${text.slice(0, 200)}`,
    );
  }
}
