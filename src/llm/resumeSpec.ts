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
  // Rendered-term -> the DECLARED skill it renames, for entries written in the JD's vocabulary
  // rather than the student's own ("ETL" -> "SQL", "model evals" -> "LLM evaluation").
  //
  // Why this exists: matching the JD's wording for a skill the student ACTUALLY HAS is legitimate
  // ATS tailoring, but the declared-mode validator drops anything not verbatim in the declared list,
  // so a rename would be silently deleted. This map is what makes a rename survivable AND auditable:
  // the validator only accepts a translated term if it maps to a real declared skill, so a rename
  // cannot smuggle in a skill the student never claimed. Renaming is the ONLY licence granted here;
  // adding is still forbidden (R-015).
  skill_source?: Record<string, string>;
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
  "skills": [string],
  "skill_source": {string: string}
}

Rules:
- Pick up to 3 experience entries that best match the JD, most relevant first.
- For each entry pick exactly 3 bullets: reuse a stored bullet_variant verbatim when one already fits well;
  only lightly rewrite (never fabricate achievements) when no stored variant surfaces the JD's language.
- "skills": EVERY entry must be one of the student's Skills list, either copied as written there or
  renamed under the "skill_source" rule below. If the Skills list is empty, use only skills clearly
  evidenced by a bullet you selected.
- SELECT, do not dump. Choose the 8-10 Skills-list entries most relevant to THIS JD, most relevant
  first, and leave the rest out. A SKILLS line listing every skill the student has tells the reader
  nothing about their fit for this role, and pushes the relevant ones below the fold. Omitting a
  skill here does not deny it: it is a different job's resume.
- Each skill appears exactly ONCE. If you rename one under "skill_source", list it ONLY under the new
  label: writing both "SQL" and "ETL" spends two slots on one skill and reads like padding.
- "skill_source": OPTIONAL renaming, for ATS matching. When the JD names the SAME skill in different
  words, you may write the student's skill in the JD's words, and you MUST record it as
  {"the term you wrote": "the exact Skills-list entry it renames"}. Examples of a legitimate rename:
  JD says "ETL" and the student has "SQL" -> write "ETL", record {"ETL": "SQL"}. JD says
  "experimentation" and they have "A/B testing" -> {"experimentation": "A/B testing"}.
  A rename is one skill wearing the JD's label. It is NEVER a bridge to a skill they lack:
  "Kubernetes" is NOT a rename of "Production deployment". "BigQuery" is NOT a rename of "SQL".
  "React" is NOT a rename of "JavaScript". If the JD's term names a DIFFERENT, BROADER, or more
  SPECIFIC thing than the student's skill - a distinct product, vendor, or technology - it is not a
  rename, and you must leave it out entirely. When in doubt, use the student's own wording.
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
  // skill_source is jsonb-ish free-form from the model, so drop anything that isn't a string->string
  // pair. A malformed entry must not throw here and must not silently read as "grounded" downstream:
  // an omitted mapping simply means the term has to stand on its own against the declared list.
  const strMap = (v: unknown): Record<string, string> | undefined => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof val === 'string' && k.trim() && val.trim()) out[k] = val;
    }
    return Object.keys(out).length ? out : undefined;
  };
  return {
    school: str(o.school),
    degree: str(o.degree),
    grad_date: str(o.grad_date),
    coursework: str(o.coursework),
    experience,
    skills: strArr(o.skills),
    skill_source: strMap(o.skill_source),
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
    // max_tokens is a SHARED budget for thinking AND the JSON, not just the JSON. Measured on a real
    // call: thinking_tokens=1360 of output_tokens=2242, so reasoning ate ~60% of the response before
    // a single character of spec was emitted. At 4096 that left little headroom, and the failure mode
    // is nasty: the JSON truncates mid-object, `stop_reason: max_tokens` throws, and the retry is a
    // second full-price call that tends to truncate the same way -> a hard 500 on a healthy model.
    // It is also INTERMITTENT, since how long the model thinks varies per JD, so it surfaces as a
    // flaky endpoint rather than an obvious bug. Caught when the skills select/translate rules made
    // the prompt richer and pushed a working call over the line.
    // 8192 leaves roughly 3x headroom over the largest spec observed (~2.2k output tokens). We only
    // pay for what is generated, so a higher ceiling costs nothing on a normal call.
    max_tokens: 8192,
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
