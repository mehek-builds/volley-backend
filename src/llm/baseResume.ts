import Anthropic from '@anthropic-ai/sdk';
import type { ExperienceBankEntry } from '../db/schema';
import { RESUME_CONTENT_LIMITS } from '../engine/resumeContentPolicy';
import { STRONG_VERBS } from '../engine/resumeValidate';
import { normalizeSpec, type ResumeSpec } from './resumeSpec';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/* The BASE resume: one resume, no job description.
 *
 * Every other resume in the product is tailored - generateResumeSpec takes a JD and selects the
 * evidence that posting asks for. That is the right default for an application and the wrong one
 * for onboarding, because at onboarding there is no posting yet. The student has just handed us a
 * two- or three-page document and has no idea whether we understood it.
 *
 * So this builds the resume they would send if they could only send one. It is the artifact the
 * student reviews once, and it is the fallback every later generation falls back TO when a JD is
 * thin, unreadable, or missing.
 *
 * WHY THE SELECTION RULE IS DIFFERENT, and it is the whole design:
 * generateResumeSpec ranks by overlap with the JD. With no JD there is nothing to overlap with,
 * and the tempting substitute - "pick the most impressive" - is a value judgement the model is bad
 * at and that quietly buries a student's most recent work under a flashier old internship. The
 * rule here is RECENCY-WEIGHTED BREADTH: cover the distinct kinds of work the student has done,
 * most recent first. A resume that shows one research internship, one build project and one
 * leadership role survives contact with any posting; four variations on the same internship does
 * not.
 *
 * Everything else - three bullets, strong verbs, grounded metrics, no em dash, one page - is the
 * SAME bar as the tailored path, enforced by the same validator afterwards. This file changes what
 * gets selected, never what counts as good.
 */

export const BASE_RESUME_SYSTEM_PROMPT = `You are a resume engine building a student's BASE resume: the single
general-purpose resume they would send if they could only send one, with no job description to tailor against.

Return ONLY valid JSON with no explanation or markdown wrapping, matching this exact shape:
{
  "school": string, "degree": string, "grad_date": string, "coursework": string,
  "education_position": "top" | "after_experience",
  "experience": [{"type": "job" | "project" | "leadership", "org": string, "title": string, "date_range": string, "bullets": [string]}],
  "skills": [string]
}

Selection rules (these differ from tailored generation - read them carefully):
- There is NO job description. Do not invent a target role, and do not optimise for an imagined one.
- Pick ${RESUME_CONTENT_LIMITS.maxEntries} entries whenever the bank holds ${RESUME_CONTENT_LIMITS.maxEntries} worth including, chosen for RECENCY-WEIGHTED BREADTH: the most
  recent work first, and across the set, cover the distinct KINDS of work the student has done rather
  than repeating one kind. Given two entries of similar strength, prefer the more recent one and the
  one that adds a kind the set does not have yet.
- THE RESUME MUST FILL ONE PAGE. Not "fit within one page" - fill it. A resume that stops two thirds
  down the page reads as a thin candidate no matter how strong the content is, and it is the most
  common way a good student's resume looks weak. If the selection above leaves the page short, add the
  next best entry from the bank and give every entry its full ${RESUME_CONTENT_LIMITS.maxBulletsPerEntry} bullets. Only drop back toward the
  minimum when the page would otherwise overflow.
- Prefer each entry's strongest and most transferable stored bullet_variant, reused VERBATIM whenever one
  fits. Only lightly rewrite when no stored variant reads well without a posting's context to lean on.
  Never fabricate an achievement.
- Give every entry ${RESUME_CONTENT_LIMITS.maxBulletsPerEntry} bullets. Drop to ${RESUME_CONTENT_LIMITS.minBulletsPerEntry} only when the bank genuinely holds nothing worth a third
  bullet for that entry. Within an entry, lead with the bullet carrying the clearest outcome.
- NEVER give an entry fewer than ${RESUME_CONTENT_LIMITS.minBulletsPerEntry} bullets. A single-bullet entry looks like an afterthought and weakens the
  whole page. If an entry cannot support ${RESUME_CONTENT_LIMITS.minBulletsPerEntry}, it does not belong on the resume: choose a different entry
  from the bank instead.
- Copy each entry's type from the experience bank. Do not turn a project into a job or a job into leadership.
- "skills": 8-10 entries, EVERY one copied EXACTLY as written in the student's Skills list, character for
  character. Order them most broadly useful first. Never add a skill that is not on that list; if the list
  is empty, use only skills clearly evidenced by a bullet you selected.
- Use the student's real school, degree and graduation date exactly as given in the Education line. Never
  invent or upgrade a degree; leave "degree" an empty string if none is provided.
- "coursework": only courses explicitly listed in the Education source.
- Set education_position to "top" only when the Education source says the candidate is currently enrolled.
  Otherwise use "after_experience".

Writing rules (identical to the tailored path):
- Every bullet starts with a strong action verb, one of: ${[...STRONG_VERBS].join(', ')}.
- Every bullet is 8-30 words, one sentence, no more than two "and"s (prefer ; : or - over a run-on).
- Include a real number, percent, dollar amount or multiplier whenever the source supports one. Never
  invent a metric that is not grounded in the experience bank.
- NEVER use an em dash (-) anywhere in the output. Use a comma, colon, hyphen or period instead.
- Bullets must fit roughly two lines of a resume (under 235 characters). Concise, not padded.
- Exactly ONE page: it must not overflow, and it must not leave the bottom third empty.`;

export interface BaseResumeEducation {
  school: string;
  degree?: string;
  grad_date?: string;
  grad_year?: number;
  currently_enrolled?: boolean;
  coursework?: string[];
}

/** Emitted as the model streams, so /start can draw the resume as it is decided rather than after. */
export type BaseResumeEvent =
  | { type: 'education'; education_position: 'top' | 'after_experience' }
  | { type: 'entry'; index: number; entry: ResumeSpec['experience'][number] }
  | { type: 'skills'; skills: string[] };

/* Progressive parse of a streaming JSON spec.
 *
 * The model emits one JSON object over ~10-20 seconds. Waiting for the closing brace and then
 * painting the whole resume at once wastes the most interesting part of the build, so this reads
 * the buffer after every chunk and emits each piece the moment it is syntactically complete.
 *
 * It is deliberately a scanner over balanced braces rather than a streaming JSON parser: the only
 * shapes it must recognise are "one more object closed inside the experience array" and "the skills
 * array closed", both of which are cheap and unambiguous to detect, and anything it fails to
 * recognise simply arrives later in the final parse. A partial emit can never be WRONG, only early
 * or absent, which is the correct failure direction for a progress display.
 */
export class BaseResumeStreamReader {
  private buffer = '';
  private emittedEntries = 0;
  private emittedSkills = false;
  private emittedEducation = false;

  push(chunk: string): BaseResumeEvent[] {
    this.buffer += chunk;
    const events: BaseResumeEvent[] = [];

    if (!this.emittedEducation) {
      const match = this.buffer.match(/"education_position"\s*:\s*"(top|after_experience)"/);
      if (match) {
        this.emittedEducation = true;
        events.push({ type: 'education', education_position: match[1] as 'top' | 'after_experience' });
      }
    }

    for (const entry of this.completedEntries().slice(this.emittedEntries)) {
      events.push({ type: 'entry', index: this.emittedEntries, entry });
      this.emittedEntries += 1;
    }

    if (!this.emittedSkills) {
      const skills = this.completedSkills();
      if (skills) {
        this.emittedSkills = true;
        events.push({ type: 'skills', skills });
      }
    }

    return events;
  }

  /** Every object inside "experience": [...] whose braces have closed. */
  private completedEntries(): ResumeSpec['experience'] {
    const start = this.buffer.indexOf('"experience"');
    if (start === -1) return [];
    const arrayStart = this.buffer.indexOf('[', start);
    if (arrayStart === -1) return [];

    const out: ResumeSpec['experience'] = [];
    let depth = 0;
    let objectStart = -1;
    let inString = false;
    let escaped = false;

    for (let i = arrayStart + 1; i < this.buffer.length; i += 1) {
      const ch = this.buffer[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') {
        if (depth === 0) objectStart = i;
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0 && objectStart !== -1) {
          try {
            const parsed = normalizeSpec({ experience: [JSON.parse(this.buffer.slice(objectStart, i + 1))] });
            if (parsed.experience[0]?.org) out.push(parsed.experience[0]);
          } catch {
            // Not a complete entry after all; the final parse will pick it up.
          }
          objectStart = -1;
        }
      } else if (ch === ']' && depth === 0) {
        break;
      }
    }
    return out;
  }

  private completedSkills(): string[] | null {
    const start = this.buffer.indexOf('"skills"');
    if (start === -1) return null;
    const arrayStart = this.buffer.indexOf('[', start);
    if (arrayStart === -1) return null;
    const arrayEnd = this.buffer.indexOf(']', arrayStart);
    if (arrayEnd === -1) return null;
    try {
      const parsed = JSON.parse(this.buffer.slice(arrayStart, arrayEnd + 1));
      return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : null;
    } catch {
      return null;
    }
  }

  text(): string {
    return this.buffer;
  }
}

/** Strip a markdown fence, then fall back to the outermost brace pair. Same recovery as resumeSpec. */
export function parseSpecText(text: string): ResumeSpec {
  const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  try {
    return normalizeSpec(JSON.parse(cleaned));
  } catch {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) {
      return normalizeSpec(JSON.parse(text.slice(first, last + 1)));
    }
    throw new Error(`Claude returned invalid JSON for the base resume: ${text.slice(0, 200)}`);
  }
}

export async function generateBaseResumeSpec(
  bank: ExperienceBankEntry[],
  education: BaseResumeEducation,
  skills: string[] | null | undefined,
  onEvent: (event: BaseResumeEvent) => void,
  options: { timeoutMs?: number; feedback?: string[] } = {},
): Promise<ResumeSpec> {
  const feedbackBlock = options.feedback?.length
    ? `\n\nThe previous attempt had these issues - fix them in this revision:\n${options.feedback.map((f) => `- ${f}`).join('\n')}`
    : '';

  // Same cache shape as resumeSpec.ts: the bank and education are per-student and identical across
  // both attempts of a build, so they sit in the cached prefix and a retry re-reads them free.
  const skillsBlock = skills?.length
    ? `\n\nSkills list (the student's own skills - the ONLY skills that may appear in "skills"):\n${JSON.stringify(skills)}`
    : `\n\nSkills list: none provided. Use only skills clearly evidenced by a bullet you selected.`;
  const contextBlock = `Education source (copy facts exactly; this is the only authority for school, degree, graduation date, enrollment, and coursework):\n${JSON.stringify(education)}${skillsBlock}\n\nExperience bank:\n${JSON.stringify(bank)}`;

  const reader = new BaseResumeStreamReader();

  const stream = client.messages.stream(
    {
      model: 'claude-sonnet-5',
      max_tokens: 8192,
      system: [
        { type: 'text', text: BASE_RESUME_SYSTEM_PROMPT },
        { type: 'text', text: contextBlock, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: `Return the base resume JSON.${feedbackBlock}` }],
    },
    options.timeoutMs !== undefined
      ? { signal: AbortSignal.timeout(options.timeoutMs), maxRetries: 0 }
      : undefined,
  );

  stream.on('text', (delta) => {
    for (const event of reader.push(delta)) onEvent(event);
  });

  const response = await stream.finalMessage();
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Base resume truncated at max_tokens - raise the cap');
  }
  return parseSpecText(reader.text());
}
