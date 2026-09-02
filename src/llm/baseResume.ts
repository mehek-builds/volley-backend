import Anthropic from '@anthropic-ai/sdk';
import type { ExperienceBankEntry } from '../db/schema';
import { RESUME_CONTENT_LIMITS } from '../engine/resumeContentPolicy';

export const BASE_RESUME_MODEL_CALL_CAP_MS = 15_000;
export const BASE_RESUME_REPAIR_CALL_CAP_MS = 8_000;
/* Exported and pinned by a test, because a typo here does not error: generateBaseResumeSpec's
 * fallback chain converts an unknown-model 404 into a degraded local-fallback resume that logs
 * outcome=success, so a misspelled id would ship as a silent quality regression. */
export const BASE_RESUME_GENERATION_MODEL = 'claude-haiku-4-5-20251001';
export const BASE_RESUME_GENERATION_FALLBACK_MODEL = 'claude-sonnet-5';

export function baseResumeModelTimeoutMs(callerAllowanceMs?: number): number {
  return Math.min(callerAllowanceMs ?? BASE_RESUME_MODEL_CALL_CAP_MS, BASE_RESUME_MODEL_CALL_CAP_MS);
}

export function baseResumeRepairTimeoutMs(callerAllowanceMs?: number): number {
  return Math.min(callerAllowanceMs ?? BASE_RESUME_REPAIR_CALL_CAP_MS, BASE_RESUME_REPAIR_CALL_CAP_MS);
}
import { relevanceScore } from '../engine/resumePolicy';
import { BULLET_MAX_CHARS, BULLET_MIN_WORDS, BULLET_MAX_WORDS, STRONG_VERBS, startsWithStrongVerb } from '../engine/resumeValidate';
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

export const BASE_RESUME_SYSTEM_PROMPT = `You are a resume engine building an applicant's BASE resume: the single
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
- Pick ${RESUME_CONTENT_LIMITS.maxEntries} entries whenever the bank holds ${RESUME_CONTENT_LIMITS.maxEntries} worth including. Selection has two tiers and the order matters.

  TIER 1, the primary axis: RECENCY-WEIGHTED BREADTH. Take the most recent work first, and across
  the set cover the distinct KINDS of work the applicant has done rather than repeating one kind.

  TIER 2, a TIEBREAK ONLY: among entries that tier 1 leaves genuinely close, prefer the one with the
  strongest evidence - a concrete outcome, a number, real scope or responsibility. Judge the
  EVIDENCE, not the logo. "Impressive" is a biased instinct: it over-rewards famous employers and
  under-rewards an applicant's own project or a small organisation where they actually ran something,
  and that is exactly the evidence this product exists to surface. So this tier never displaces a more recent
  entry and never collapses the breadth rule by stacking four of the same kind of work.
- THE RESUME MUST FILL ONE PAGE. Not "fit within one page" - fill it. A resume that stops two thirds
  down the page reads as a thin candidate no matter how strong the content is, and it is the most
  common way a good resume looks weak. If the selection above leaves the page short, add the
  next best entry from the bank and give every entry its full ${RESUME_CONTENT_LIMITS.maxBulletsPerEntry} bullets. Only drop back toward the
  minimum when the page would otherwise overflow.
 - Prefer each entry's strongest and most transferable stored bullet_variant, reused VERBATIM whenever one
   fits. Only lightly rewrite when no stored variant reads well without a posting's context to lean on.
   Never fabricate an achievement.
 - When two stored variants for the same entry describe a clear cause and its result, you may combine
   those exact facts into one stronger bullet. Never combine unrelated accomplishments or move facts
   between entries.
- Give every entry up to ${RESUME_CONTENT_LIMITS.maxBulletsPerEntry} grounded bullets, and prefer ${RESUME_CONTENT_LIMITS.maxBulletsPerEntry} where the
  evidence supports it. Within an entry, lead with the bullet carrying the clearest outcome.
- NEVER give an entry fewer than ${RESUME_CONTENT_LIMITS.minBulletsPerEntry} bullets. A single-bullet entry looks like an afterthought and weakens the
  whole page. If an entry cannot support ${RESUME_CONTENT_LIMITS.minBulletsPerEntry}, it does not belong on the resume: choose a different entry
  from the bank instead. The only exception is an entry named in the REQUIRED PRIORITY ENTRIES
  block whose source contains fewer than ${RESUME_CONTENT_LIMITS.minBulletsPerEntry} bullets because the applicant explicitly continued
  with the evidence found. Include all of its grounded bullets and never invent or duplicate one.
- An entry that supports ${RESUME_CONTENT_LIMITS.minBulletsPerEntry} and not ${RESUME_CONTENT_LIMITS.maxBulletsPerEntry} STAYS ON THE RESUME. Do not drop a
  real job for being short: a short entry costs a line of the page, and leaving the job off reads as
  a gap in the applicant's history that nothing on the document explains.
- KEEP THE APPLICANT'S OWN SPELLING. If their resume writes "optimised", "analysed", "modelled",
  "organisation" or "programme", the resume Litos generates writes it that way too. Never convert
  between British and American spelling in either direction, and never treat a Commonwealth spelling
  as an error to fix. A student applying in London, Dublin, Sydney, Singapore or Toronto is spelling
  it correctly for the employer reading it, and one applying in the US from a British-schooled
  background is spelling their own history the way they have always spelt it. This applies to every
  word on the page, not only to verbs.
- Copy each entry's type from the experience bank. Do not turn a project into a job or a job into leadership.
- "skills": 8-10 entries, EVERY one copied EXACTLY as written in the applicant's Skills list, character for
  character. Order them most broadly useful first. Never add a skill that is not on that list; if the list
  is empty, use only skills clearly evidenced by a bullet you selected.
- Use the applicant's real school, degree and graduation date exactly as given in the Education line. Never
  invent or upgrade a degree; leave "degree" an empty string if none is provided.
- "coursework": only courses explicitly listed in the Education source.
- Set education_position to "top" when the Education source says the candidate is currently enrolled or graduated within the last two years, otherwise "after_experience". Note this field is RE-DERIVED server-side from the parsed education dates and your answer is not what ships; set it anyway so the object validates.
  Otherwise use "after_experience".

Writing rules (identical to the tailored path):
- THE VERB RULE OUTRANKS VERBATIM REUSE. Reusing a stored bullet word for word is preferred, but not
  when it opens with a verb that is not on the approved list. In that case rewrite the OPENING only,
  keeping every fact, number and noun exactly as the source has them. A bullet that starts with
  Assisted, Supported, Helped, Performed, Participated, Attended, Worked or Engaged must be recast
  around what the applicant actually did.
- Every bullet starts with a strong action verb, one of: ${[...STRONG_VERBS].join(', ')}.
- A CURRENT role may keep the present tense. The same approved verb in its present or "-ing" form is
  approved: "Driving full SDLC", "Facilitating cross-functional collaboration" and "Leading a team of
  four" are all correct for a job the applicant still holds. Do NOT re-tense a bullet to the past to
  satisfy the rule above; the checker accepts both tenses and re-tensing only costs the applicant
  their own words.
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

function normalizedIdentity(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function entryIdentity(entry: Pick<ExperienceBankEntry, 'org' | 'title'>): string {
  return `${normalizedIdentity(entry.org)}\u0000${normalizedIdentity(entry.title)}`;
}

function latestYear(entry: ExperienceBankEntry): number {
  const years = (entry.date_range ?? '').match(/\b(?:19|20)\d{2}\b/g) ?? [];
  return years.length > 0 ? Math.max(...years.map(Number)) : 0;
}

function isCurrentEntry(entry: ExperienceBankEntry): boolean {
  return /\b(?:present|current|ongoing|now|today)\b/i.test(entry.date_range ?? '');
}

function bankEntryText(entry: ExperienceBankEntry): string {
  const bullets = Array.isArray(entry.bullet_variants)
    ? entry.bullet_variants.filter((bullet): bullet is string => typeof bullet === 'string')
    : [];
  return [entry.org, entry.title ?? '', entry.date_range ?? '', ...bullets].join(' ');
}

/**
 * Evidence the base resume may not displace with older work.
 *
 * After onboarding, the entry the applicant confirmed is the one mandatory entry and must lead the
 * page. Before that review exists, the legacy fallback protects up to three current or role-defining
 * entries so older accounts retain the selection behavior they had before this flow shipped.
 */
export function priorityEntriesForBaseResume(
  bank: ExperienceBankEntry[],
  targetRoleText: string,
  selectedEntryId?: string | null,
): ExperienceBankEntry[] {
  if (bank.length === 0) return [];
  const explicitlySelected = bank.find((entry) => entry.id === selectedEntryId);
  if (explicitlySelected) return [explicitlySelected];
  /* THE LEGACY FALLBACK MAY NOT REQUIRE AN ENTRY THE FLOOR IS GUARANTEED TO DROP. The gate
   * (baseResumeSelectionIssues) demands every priority entry appear on the page, while
   * enforceExperienceBulletFloor drops any entry that cannot reach minBulletsPerEntry grounded
   * bank variants - and on this path there is no sparse allowance, because allowSparsePriority
   * covers only the explicitly selected entry above. So a current entry whose bank row holds one
   * bullet variant made the two rules contradict by construction: the model includes it, the
   * floor removes it, the fail-closed ATS gate refuses the build, and a rebuild reproduces it
   * deterministically - the student is stranded with nothing saved, forever. Reproduced live
   * 2026-09-02/03 on production trial accounts ("required current or role-defining entry
   * missing: Events Coordinator at Smith Pre-Health Society" on every build). A one-variant
   * current role is still perfectly selectable - the model may put it on the page and the floor
   * will drop it with an honest warning - it just cannot be MANDATORY. The explicit selection
   * above is untouched: a student who confirmed a sparse entry has the continue_with_found
   * escape, which is the allowance this path lacks. */
  const groundedVariants = (entry: ExperienceBankEntry): number =>
    (Array.isArray(entry.bullet_variants) ? entry.bullet_variants : [])
      .filter((bullet): bullet is string => typeof bullet === 'string' && bullet.trim().length > 0)
      .length;
  const survivable = bank.filter((entry) => groundedVariants(entry) >= RESUME_CONTENT_LIMITS.minBulletsPerEntry);
  const rankedByRecency = survivable
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) =>
      Number(isCurrentEntry(b.entry)) - Number(isCurrentEntry(a.entry)) ||
      latestYear(b.entry) - latestYear(a.entry) ||
      a.index - b.index,
    );
  const selected: ExperienceBankEntry[] = [];
  const add = (entry: ExperienceBankEntry | undefined) => {
    if (!entry || selected.some((candidate) => entryIdentity(candidate) === entryIdentity(entry))) return;
    if (selected.length < 3) selected.push(entry);
  };

  add(rankedByRecency[0]?.entry);
  for (const { entry } of rankedByRecency.filter(({ entry }) => isCurrentEntry(entry))) add(entry);

  if (targetRoleText.trim()) {
    const roleRanked = rankedByRecency
      .map(({ entry, index }) => ({
        entry,
        index,
        score: relevanceScore(bankEntryText(entry), targetRoleText),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || latestYear(b.entry) - latestYear(a.entry) || a.index - b.index);
    for (const { entry } of roleRanked) add(entry);
  }
  return selected;
}

/**
 * INCLUSION IS ALWAYS REQUIRED; POSITION IS ONLY REQUIRED WHERE THERE IS NO POSTING.
 *
 * `priorities` is ranked by recency (selectPriorityEntries leads with rankedByRecency[0]), so the
 * position half of this check is a recency rule wearing the word "priority". On the BASE resume
 * that is correct and should stay: it is built with no job description in front of it, nothing else
 * could decide the order, and leading with current work is the right default for a page the
 * applicant reviews as a general summary.
 *
 * On a TAILORED resume it was the defect. It hard-failed any packet whose lead entry was chosen
 * against the posting rather than by date, which made "the top experience is aligned for their
 * role" unachievable by construction no matter what the prompt asked for. The tailored path passes
 * `requireFirst: false` and hands the ordering to leadAlignmentIssues, which asks the posting.
 *
 * The missing-entry half is unchanged for both, and it is what actually protects the applicant:
 * her current role stays on the page either way.
 */
export function baseResumeSelectionIssues(
  spec: ResumeSpec,
  priorities: ExperienceBankEntry[],
  options: { requireFirst?: boolean } = {},
): string[] {
  const selected = new Set(spec.experience.map((entry) => entryIdentity(entry)));
  const issues = priorities
    .filter((entry) => !selected.has(entryIdentity(entry)))
    .map((entry) => `required current or role-defining entry missing: ${entry.title ? `${entry.title} at ` : ''}${entry.org}`);
  const first = spec.experience[0];
  const priority = priorities[0];
  if (
    options.requireFirst !== false
    && priority && first
    && selected.has(entryIdentity(priority))
    && entryIdentity(first) !== entryIdentity(priority)
  ) {
    issues.push(`required priority entry is not first: ${priority.title ? `${priority.title} at ` : ''}${priority.org}`);
  }
  return issues;
}

/**
 * Deterministically put the required priority entries back on the page. No model call.
 *
 * The regeneration this replaces was the slowest arm of the repair loop: a displaced priority
 * entry cost a full re-generation (~5-8 seconds live) to fix what is, mechanically, an insert and
 * a reorder. This mirrors baseResumeSelectionIssues exactly - every priority entry present, and
 * priorities[0] first - so one application of it always clears the selection defect: an entry the
 * model already wrote keeps its written bullets and is only moved; a missing one is rebuilt from
 * its own bank variants verbatim, and the bullet-repair pass that follows fixes any variant that
 * breaks a writing rule, the same division of labour the floor's backstop uses. Non-priority
 * entries keep the model's order and are dropped from the END when the page is over the cap.
 */
export function enforcePrioritySelection(
  spec: ResumeSpec,
  priorities: ExperienceBankEntry[],
  limits: { maxEntries: number; maxBulletsPerEntry: number },
): ResumeSpec {
  if (priorities.length === 0) return spec;

  const specByIdentity = new Map(spec.experience.map((entry) => [entryIdentity(entry), entry]));
  const priorityIdentities = new Set(priorities.map((entry) => entryIdentity(entry)));

  const specEntryFor = (priority: ExperienceBankEntry): ResumeSpec['experience'][number] => {
    const written = specByIdentity.get(entryIdentity(priority));
    if (written) return written;
    const bullets = (Array.isArray(priority.bullet_variants) ? priority.bullet_variants : [])
      .filter((bullet): bullet is string => typeof bullet === 'string' && bullet.trim().length > 0)
      .map((bullet) => bullet.trim())
      .slice(0, limits.maxBulletsPerEntry);
    const type: ResumeSpec['experience'][number]['type'] =
      priority.type === 'project' || priority.type === 'leadership' ? priority.type : 'job';
    return {
      type,
      org: priority.org,
      title: priority.title ?? '',
      date_range: priority.date_range ?? '',
      bullets,
    };
  };

  // priorities[0] leads; the rest of the model's ordering survives, with missing priorities
  // inserted right behind the lead so they cannot be pushed off the end they must not fall off.
  const lead = specEntryFor(priorities[0]);
  const missingRest = priorities
    .slice(1)
    .filter((priority) => !specByIdentity.has(entryIdentity(priority)))
    .map(specEntryFor);
  const rest = spec.experience.filter((entry) => {
    const identity = entryIdentity(entry);
    return identity !== entryIdentity(priorities[0])
      && !missingRest.some((inserted) => entryIdentity(inserted) === identity);
  });
  const experience = [lead, ...missingRest, ...rest];
  /* Over the cap, non-priority entries fall off the END first, so the policy pass's own
   * maxEntries slice can never be the thing that cuts a protected entry back off the page.
   * priorityEntriesForBaseResume caps itself below maxEntries, so priorities alone never
   * overflow the page. */
  for (let i = experience.length - 1; i >= 0 && experience.length > limits.maxEntries; i -= 1) {
    if (!priorityIdentities.has(entryIdentity(experience[i]))) experience.splice(i, 1);
  }
  return { ...spec, experience };
}

/** Emitted as the model streams, so /start can draw the resume as it is decided rather than after. */
export type BaseResumeEvent =
  | { type: 'restart' }
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

/** A grounded continuity spec used only when the base-resume model call fails. */
export function baseResumeSpecFromEvidence(
  bank: ExperienceBankEntry[],
  education: BaseResumeEducation,
  skills: string[] | null | undefined,
  priorityEntries: ExperienceBankEntry[] = [],
): ResumeSpec {
  const ordered: ExperienceBankEntry[] = [];
  const seen = new Set<string>();
  const add = (entry: ExperienceBankEntry) => {
    if (ordered.length >= RESUME_CONTENT_LIMITS.maxEntries) return;
    const key = entryIdentity(entry);
    if (seen.has(key) || !Array.isArray(entry.bullet_variants) || entry.bullet_variants.length === 0) return;
    seen.add(key);
    ordered.push(entry);
  };
  priorityEntries.forEach(add);
  [...bank]
    .sort((a, b) => Number(isCurrentEntry(b)) - Number(isCurrentEntry(a)) || latestYear(b) - latestYear(a))
    .forEach(add);
  const experience = ordered.flatMap((entry) => {
    const bullets = uniqueStrings(Array.isArray(entry.bullet_variants) ? entry.bullet_variants : [])
      .map((bullet) => bullet.replace(/\u2014/g, '-'))
      .slice(0, RESUME_CONTENT_LIMITS.maxBulletsPerEntry);
    if (bullets.length === 0) return [];
    return [{
      type: entry.type as 'job' | 'project' | 'leadership',
      org: entry.org,
      title: entry.title ?? '',
      location: entry.location ?? '',
      date_range: entry.date_range ?? '',
      bullets,
    }];
  });
  if (experience.length === 0) throw new Error('No grounded experience entries are available for a main resume');
  return {
    ...normalizeSpec({
    school: education.school,
    degree: education.degree ?? '',
    grad_date: education.grad_date ?? (education.grad_year ? String(education.grad_year) : ''),
    coursework: education.coursework?.join(', ') ?? '',
    education_position: education.currently_enrolled ? 'top' : 'after_experience',
    experience,
      skills: uniqueStrings(skills ?? []).slice(0, 10),
    }),
    generation_method: 'local_fallback',
  };
}

function uniqueStrings(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const clean = value.trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

export async function generateBaseResumeSpec(
  bank: ExperienceBankEntry[],
  education: BaseResumeEducation,
  skills: string[] | null | undefined,
  onEvent: (event: BaseResumeEvent) => void,
  options: {
    timeoutMs?: number;
    feedback?: string[];
    priorityEntries?: ExperienceBankEntry[];
  } = {},
): Promise<ResumeSpec> {
  const feedbackBlock = options.feedback?.length
    ? `\n\nThe previous attempt had these issues - fix them in this revision:\n${options.feedback.map((f) => `- ${f}`).join('\n')}`
    : '';

  // Same cache shape as resumeSpec.ts: the bank and education are per-student and identical across
  // both attempts of a build, so they sit in the cached prefix and a retry re-reads them free.
  const skillsBlock = skills?.length
    ? `\n\nSkills list (the applicant's own skills - the ONLY skills that may appear in "skills"):\n${JSON.stringify(skills)}`
    : `\n\nSkills list: none provided. Use only skills clearly evidenced by a bullet you selected.`;
  const priorityBlock = options.priorityEntries?.length
    ? `\n\nREQUIRED PRIORITY ENTRIES (include every one, copying org, title, dates, type and grounded bullets from the bank; these may not be displaced by older or secondary work):\n${JSON.stringify(options.priorityEntries)}`
    : '';
  const contextBlock = `Education source (copy facts exactly; this is the only authority for school, degree, graduation date, enrollment, and coursework):\n${JSON.stringify(education)}${skillsBlock}\n\nExperience bank:\n${JSON.stringify(bank)}${priorityBlock}`;

  /* Whether the FAILED attempt painted anything: a retry must clear those pieces before emitting
   * its own (appending a second full set would double every entry), but a restart when nothing
   * was painted is noise the client has to process for no change. */
  let piecesEmitted = false;
  const attempt = async (model: string, isRetry: boolean): Promise<ResumeSpec> => {
    const reader = new BaseResumeStreamReader();
    if (isRetry && piecesEmitted) {
      onEvent({ type: 'restart' });
      piecesEmitted = false;
    }
    const stream = client.messages.stream(
    {
      model,
      /* Thinking is OFF explicitly. Haiku 4.5 runs no thinking when the parameter is omitted, so
       * for the primary model this line is a no-op - it stays because the FALLBACK model below is
       * Sonnet 5, which runs adaptive thinking when the parameter is omitted, and on this exact
       * call that meant ~12 silent seconds before the first entry streamed (measured 2026-08-29
       * against production: 12.7s to first piece, 3s for everything after it). One request shape
       * serves both models, and quality does not lean on the reasoning pass: every rule is
       * enforced after generation by the deterministic gates. */
      thinking: { type: 'disabled' },
      /* Sized for the WORST bank, not a typical one. Measured 2026-07-27 on a real two-page resume
       * with 7 bank entries: an 8192 cap truncated mid-object and failed the build outright, and a
       * long resume compressed to one page is the headline case for this feature. Output is billed
       * on what is generated, so the higher ceiling costs nothing on a small resume. */
      max_tokens: 16384,
      /* TWO breakpoints, not one. The second caches the per-student context for the retry within
       * one build. The first caches the static rules prefix ACROSS students so a new student's
       * context does not force the rule block to be re-read at full price on the very first call
       * of every onboarding. CAVEAT, measured into the numbers above rather than assumed away:
       * Haiku 4.5's minimum cacheable prefix is 4096 tokens and the rules prefix alone (~1.8K
       * tokens) sits under it, so on the primary model the FIRST breakpoint does not produce a
       * cache entry - the 6-8s Haiku generations were measured with that cache cold. The
       * breakpoints stay: the second one covers large banks and the within-build retry on both
       * models, and the first works whenever the fallback model (1024-token minimum) runs. */
      system: [
        { type: 'text', text: BASE_RESUME_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: contextBlock, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: `Return the base resume JSON.${feedbackBlock}` }],
    },
    {
      signal: AbortSignal.timeout(baseResumeModelTimeoutMs(options.timeoutMs)),
      maxRetries: 0,
    },
  );

    stream.on('text', (delta) => {
      for (const event of reader.push(delta)) {
        piecesEmitted = true;
        onEvent(event);
      }
    });

    const response = await stream.finalMessage();
    if (response.stop_reason === 'max_tokens') {
      throw new Error('Base resume truncated at max_tokens - raise the cap');
    }
    return parseSpecText(reader.text());
  };

  try {
    /* Haiku first, and the choice is measured rather than assumed. This call selects entries and
     * mostly reuses bank wording verbatim; every quality rule is enforced AFTER generation by
     * weakVerbBullets, overlongBullets, misWordedBullets, the grounding prune and the fail-closed
     * ATS gate, so the model is not the quality bar here - the gates are. Measured 2026-09-03
     * across seven banks (five varied trial resumes through the e2e harness plus a real 14-entry
     * production bank twice): Haiku cleared the same gates with equal-or-fewer violations than
     * Sonnet (ZERO repair passes on the 14-entry bank where Sonnet needed one or two) and
     * generated 30-40% faster - 6.3-10.3s full-pipeline runs against Sonnet's 8.4-11.8s on
     * identical inputs. A slow generation is what the onboarding build screen spends most of its
     * time on, so this is the single biggest lever on the sub-30s resume-creation promise. */
    return await attempt(BASE_RESUME_GENERATION_MODEL, false);
  } catch (primaryError) {
    /* Sonnet before the local fallback, so generation and repair do not share one provider fate:
     * both this call and repairBaseResumeBullets now run Haiku, and without this step a Haiku-only
     * capacity event (429s, a retired or misconfigured model id) would silently turn EVERY
     * onboarding build into the local-fallback spec - no repairs, a relaxed style gate - while
     * logging outcome=success. The common outage shapes fail in well under a second, so this
     * retry usually costs nothing; a genuine double stall is bounded by the same per-call cap. */
    console.warn(`[llm] base_resume model=${BASE_RESUME_GENERATION_MODEL} outcome=error reason=${primaryError instanceof Error ? primaryError.name : 'error'}; retrying on ${BASE_RESUME_GENERATION_FALLBACK_MODEL}`);
    try {
      return await attempt(BASE_RESUME_GENERATION_FALLBACK_MODEL, true);
    } catch (error) {
      const fallback = baseResumeSpecFromEvidence(bank, education, skills, options.priorityEntries);
      console.warn(`[llm] base_resume provider=local outcome=success entries=${fallback.experience.length} reason=${error instanceof Error ? error.name : 'error'}`);
      onEvent({ type: 'restart' });
      onEvent({ type: 'education', education_position: fallback.education_position ?? 'after_experience' });
      fallback.experience.forEach((entry, index) => onEvent({ type: 'entry', index, entry }));
      onEvent({ type: 'skills', skills: fallback.skills });
      return fallback;
    }
  }
}

/** One bullet the repair pass must rewrite, with the reasons stated for the prompt. */
export interface BulletRepairTarget {
  org: string;
  bullet: string;
  reasons: string[];
}

/* A short menu of approved verbs, named in the repair prompt and in regeneration feedback.
 *
 * Chosen to span the KINDS of work students actually describe rather than to be a best-of list:
 * operations and service, people, analysis, building, and writing. The bullets that stall are
 * almost always operational ones ("Stocked and handled food items"), which is exactly where a
 * software-flavoured suggestion is no help. Repeating "use an approved verb" was measured NOT to
 * converge (2026-07-27, "Stocked" survived three passes); a concrete menu is what broke it, so the
 * menu must reach every path that asks for a verb rewrite. Every entry is on STRONG_VERBS. */
export const VERB_REPAIR_MENU = [
  'Managed', 'Organized', 'Coordinated', 'Processed', 'Administered',
  'Delivered', 'Prepared', 'Trained', 'Supervised', 'Facilitated',
  'Analyzed', 'Evaluated', 'Tracked', 'Documented',
  'Built', 'Designed', 'Improved', 'Streamlined',
];

const BULLET_REPAIR_SYSTEM_PROMPT = `You repair individual resume bullets that broke a house rule. You receive a JSON
array of {"index", "org", "bullet", "reasons"} and return ONLY a JSON array of {"index", "rewritten"} with no
explanation or markdown wrapping, where "index" is copied unchanged from the input item and "rewritten" is that
item's corrected bullet.

Rules for every rewritten bullet:
- Start with one of these approved verbs: ${[...STRONG_VERBS].join(', ')}.
- For an operational or service bullet, these approved verbs fit most actions: ${VERB_REPAIR_MENU.join(', ')}.
- Keep every fact, number, tool and outcome exactly as the original has them. Rewording is allowed; invention is not,
  and dropping a metric to save space is not.
- One sentence, ${BULLET_MIN_WORDS}-${BULLET_MAX_WORDS} words, under ${BULLET_MAX_CHARS} characters. Cut filler, not facts. When a
  bullet is too SHORT, expand it using only the facts already in it: name the tool, the scope or the outcome it
  states, never a new one.
- NEVER use an em dash anywhere. Use a comma, colon, hyphen or period instead.
- Keep the applicant's own spelling. Never convert between British and American spelling in either direction.`;

/**
 * Rewrite ONLY the offending bullets, in place, instead of regenerating the whole resume.
 *
 * The repair loop used to re-run the full generation with feedback appended, which re-decided the
 * entire selection to fix one weak opener: measured 2026-08-29 against production, three such
 * passes turned a 16-second build into 94 seconds, and the third pass alone took 41. A targeted
 * rewrite is a few hundred tokens on the small model and leaves the selection - which already
 * passed its own checks - untouched.
 *
 * Merging is by the index this call assigns to each target (see applyBulletRepairs for why the
 * model's echo can never be the key), and an unmatched or empty reply keeps the original bullet:
 * the caller re-checks the merged spec, so a failed repair surfaces as the same violation
 * on the next pass rather than as silent damage. Selection defects (a missing required priority
 * entry) still go through the full regeneration, because no bullet rewrite can change which
 * entries are on the page.
 */
export async function repairBaseResumeBullets(
  spec: ResumeSpec,
  targets: BulletRepairTarget[],
  options: { timeoutMs?: number } = {},
): Promise<ResumeSpec> {
  if (targets.length === 0) return spec;

  try {
    const response = await client.messages.create(
      {
        model: 'claude-haiku-4-5-20251001',
        /* The reply is only {index, rewritten} per target now, but a worst-case pass still
         * rewrites every bullet on the page (12 at the 4-entry x 3-bullet cap, each up to a few
         * hundred characters), and a truncated array parses to nothing, which turns the pass into
         * a silent no-op. Output is billed on what is generated, so the headroom costs nothing. */
        max_tokens: 8192,
        // Static across every repair of every student: cached, so the repair pass's latency is
        // the rewrite itself rather than re-reading the rule block each time.
        system: [{ type: 'text', text: BULLET_REPAIR_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: `Repair these bullets:\n${JSON.stringify(targets.map((target, index) => ({ index, ...target })))}`,
        }],
      },
      {
        signal: AbortSignal.timeout(baseResumeRepairTimeoutMs(options.timeoutMs)),
        maxRetries: 0,
      },
    );
    // Truncation means an unparseable array; fail toward the original like every other bad reply.
    if (response.stop_reason === 'max_tokens') return spec;
    const textBlock = response.content.find((block) => block.type === 'text');
    return applyBulletRepairs(spec, textBlock?.type === 'text' ? textBlock.text : '', targets);
  } catch {
    /* A rejected promise here - a timeout, an overloaded model, a transient 5xx - must not cost
     * the student a complete, otherwise-shippable resume over one bullet's opener. The caller's
     * re-check sees the surviving violation and either spends another pass or ships with the
     * warning, which is the same contract as a malformed reply. */
    return spec;
  }
}

/**
 * Merge a repair reply into the spec. Pure, exported for tests.
 *
 * KEYED BY THE INDEX WE ASSIGNED, NEVER BY THE MODEL'S ECHO. The first shape of this asked the
 * model to echo org and bullet back and merged on that pair; measured 2026-08-29, the model
 * sometimes writes the REWRITTEN text into the echoed "bullet" field, which silently strands the
 * rewrite, burns every pass on an identical no-op, and dies at the fail-closed ATS gate - the
 * exact stranding the loop exists to prevent. The caller already knows precisely which (org,
 * bullet) each target names, so the reply only needs to say which target a rewrite belongs to.
 *
 * Fails toward the original on every malformed shape: unparseable text, a non-array, an entry
 * with no valid index, an empty rewrite, or a rewrite that breaks a deterministic rule all leave
 * that bullet untouched, and the caller's re-check turns that into another pass or a warning.
 */
export function applyBulletRepairs(spec: ResumeSpec, replyText: string, targets: BulletRepairTarget[]): ResumeSpec {
  const cleaned = replyText.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  let repairs: unknown;
  try {
    repairs = JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf('[');
    const last = cleaned.lastIndexOf(']');
    if (first === -1 || last <= first) return spec;
    try {
      repairs = JSON.parse(cleaned.slice(first, last + 1));
    } catch {
      return spec;
    }
  }
  if (!Array.isArray(repairs)) return spec;

  /* The reply names targets by index; the ORIGINAL (org, bullet) comes from our own target list.
   * Whitespace-normalized when matching the spec, so the target text always finds its bullet. */
  const repairKey = (org: string, bullet: string) =>
    `${org.replace(/\s+/g, ' ').trim()}\u0000${bullet.replace(/\s+/g, ' ').trim()}`;

  const rewrittenFor = new Map<string, string>();
  for (const item of repairs) {
    if (!item || typeof item !== 'object') continue;
    const { index, rewritten } = item as { index?: unknown; rewritten?: unknown };
    if (typeof index !== 'number' || !Number.isInteger(index)) continue;
    const target = targets[index];
    if (!target) continue;
    if (typeof rewritten !== 'string' || rewritten.trim().length === 0) continue;
    /* A rewrite is only mergeable when it clears the deterministic house rules it exists to fix.
     * The final pass's merge is never model-checked again before the fail-closed ATS gate, so a
     * rewrite that is itself overlong, weak-opened, or outside the word band would be strictly
     * worse than keeping the original: same gate outcome, one more mutation. Refusing it here can
     * never make the spec worse than what the reply offered. */
    const candidate = rewritten.trim();
    const candidateWords = candidate.split(/\s+/).filter(Boolean).length;
    if (
      candidate.length > BULLET_MAX_CHARS
      || candidateWords < BULLET_MIN_WORDS
      || candidateWords > BULLET_MAX_WORDS
      || !startsWithStrongVerb(candidate)
    ) continue;
    rewrittenFor.set(repairKey(target.org, target.bullet), candidate);
  }
  if (rewrittenFor.size === 0) return spec;

  let changed = false;
  const experience = spec.experience.map((entry) => ({
    ...entry,
    bullets: entry.bullets.map((bullet) => {
      const rewritten = rewrittenFor.get(repairKey(entry.org, bullet));
      if (rewritten === undefined || rewritten === bullet) return bullet;
      changed = true;
      return rewritten;
    }),
  }));
  // Same-reference return when nothing landed, so the caller can skip a pointless repaint.
  return changed ? { ...spec, experience } : spec;
}
