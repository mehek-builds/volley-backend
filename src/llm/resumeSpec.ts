import Anthropic from '@anthropic-ai/sdk';
import type { ExperienceBankEntry } from '../db/schema';
import { extractJdSignals } from '../engine/jdSignals';
import { leadRequirementCandidates, type LeadAlignment } from '../engine/leadAlignment';
import { RESUME_CONTENT_LIMITS } from '../engine/resumeContentPolicy';
import { STRONG_VERBS } from '../engine/resumeValidate';
import { generateOpenAIText, logOpenAIFallback, openAIConfigured } from './openAIProvider';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ResumeSpec {
  // The role this resume targets. This is a targeting headline, not a claim that the candidate
  // previously held the role. applyResumePolicy owns the final value so model drift cannot turn
  // it into a fabricated credential.
  target_role?: string;
  school: string;
  degree: string;
  grad_date: string;
  /* Already formatted for print, e.g. "3.8/4.0" or "3.8". Written by applyResumePolicy from the
     parsed profile, never by the model: see educationGpaLine for why the denominator is never
     defaulted. Empty is normal and means the resume simply does not state one.

     OPTIONAL, unlike the other education fields. Most students have no GPA on file, and a resume
     that never printed one is not missing anything - so a stored spec predating this field is
     complete, not malformed, and nothing should have to migrate to say so. normalizeSpec still
     fills it with '' so the render path only ever sees a string. */
  gpa?: string;
  /** The place printed beside the school. Same provenance rule as an entry location: transcribed
   *  from the student's own resume, never inferred. */
  school_location?: string;
  coursework: string;
  education_position?: 'top' | 'after_experience';
  experience: Array<{
    type?: 'job' | 'project' | 'leadership';
    org: string;
    title: string;
    /* Where the work happened, printed to the right of the organisation. Copied from the
       experience bank by applyResumePolicy, never written by the model: an invented city is a
       fabricated fact about where someone worked, and it is the kind that reads as plausible.
       Optional, and empty for every entry banked before 2026-08-04. */
    location?: string;
    date_range: string;
    bullets: string[];
  }>;
  // The applicant's OWN skills, those matching the JD first. NOT "JD keywords surfaced first", which
  // is what this said and what the prompt asked for - with no skills source in the system, that
  // instruction was an invitation to keyword-stuff, and the model took it (R-015).
  skills: string[];
  /* Why the FIRST experience entry leads this resume, cited against the posting. Metadata, not
     content: no renderer reads it and resumeSpecText excludes it, so it reaches neither the page
     nor the match score. See engine/leadAlignment.ts for what it is checked against and why the
     ordering is decided this way rather than by a relevance score. Optional, and absent on every
     spec generated before 2026-08-09. */
  lead_alignment?: LeadAlignment | null;
  // Rendered-term -> the DECLARED skill it renames. RENAMING IS CURRENTLY DISABLED IN THE PROMPT;
  // this field and the validator support for it are retained deliberately, because the plumbing is
  // right and only the model's judgement was not. See the DISABLED note below before re-enabling.
  //
  // The idea: writing a skill the applicant HAS in the JD's words ("ETL" for their "SQL") is honest ATS
  // tailoring, and declared mode drops anything not verbatim in the list, so a rename needs a
  // declared target to survive. That guard works: a rename can never introduce a skill they never
  // claimed.
  //
  // 🔴 WHY IT IS OFF: the guard stops INVENTION but not GENERALISATION, and generalisation is what
  // the model actually did, on the very first live run, against a prompt that forbade it in those
  // words. Measured on a real Notion generation, 2026-07-17:
  //     {"LLMs": "OpenAI API", "Machine Learning": "Hugging Face", "databases": "SQL"}
  // Every target is genuinely declared, so all three passed. But "Hugging Face" is a library and
  // "Machine Learning" is a discipline; "OpenAI API" is one vendor's API and "LLMs" is a field. Those
  // are not the same skill wearing a different label, they are a specific claim laundered into a
  // broad one. The outputs may even be defensible on other evidence, and that is precisely the trap:
  // an ungrounded step is a defect even when it lands on a true answer (the whole lesson of R-015).
  //
  // Prompt hardening was tried first and failed: the rule already said, verbatim, that a term which is
  // "DIFFERENT, BROADER, or more SPECIFIC" is not a rename, with worked negative examples. The model
  // broadened anyway. A rule the model reads and ignores is not a control.
  //
  // TO RE-ENABLE SAFELY it needs a CURATED synonym whitelist that we own, not model judgement:
  // an explicit table (SQL -> ETL, A/B testing -> experimentation) where every pair is a true alias
  // rather than a hypernym. Until that exists, skills are copied verbatim. Selection and ordering,
  // which carry most of the ATS benefit, are unaffected and stay on.
  skill_source?: Record<string, string>;
}

// Content rules ported from the Dubai off-cycle resume engine's validate_resume.py /
// pressure_test.py (~/Documents/Internship Apps/_resume-engine/), the same quality bar
// applied to Mehek's own resume builds. Encoded here as generation instructions; enforced
// again post-generation by engine/resumeValidate.ts so drift gets caught, not just discouraged.
export const RESUME_SYSTEM_PROMPT = `You are a resume-tailoring engine. Given a job description and an applicant's full
experience bank (every job/project they've ever had, with every bullet-point phrasing they've used for
each achievement), select and lightly rewrite the best-fit subset for THIS specific posting.

Return ONLY valid JSON with no explanation or markdown wrapping, matching this exact shape:
{
  "target_role": string,
  "school": string, "degree": string, "grad_date": string, "coursework": string,
  "education_position": "top" | "after_experience",
  "lead_alignment": {"entry_org": string, "requirement": string, "evidence": string},
  "experience": [{"type": "job" | "project" | "leadership", "org": string, "title": string, "date_range": string, "bullets": [string]}],
  "skills": [string],
  "skill_source": {string: string}
}

Rules:
- If an APPROVED BASE RESUME is supplied, it is your starting point. The applicant has read and
  accepted it, so carrying an entry over is the default and swapping one out is the exception you
  justify against this specific posting. Its wording is the applicant's own corrected phrasing and is
  authoritative over the raw bank text for the same work. The experience bank still holds everything
  they have ever done, and it is where a swap comes FROM when this job is better served by work the
  base resume left off.
- Treat this resume as a proof document for THIS application, not a generic career summary.
- Set "target_role" to the exact role named in the Job line. It is a targeting headline only.
- Pick up to ${RESUME_CONTENT_LIMITS.maxEntries} entries across jobs, projects, and leadership that best match the JD, most relevant first.
- Select up to ${RESUME_CONTENT_LIMITS.maxBulletsPerEntry} grounded bullets per entry, and never fewer than ${RESUME_CONTENT_LIMITS.minBulletsPerEntry}. Prefer ${RESUME_CONTENT_LIMITS.maxBulletsPerEntry} where the evidence supports it. An entry whose grounded evidence cannot reach ${RESUME_CONTENT_LIMITS.minBulletsPerEntry} does not belong on the resume: choose a different entry rather than padding it. Do NOT drop an entry merely because it supports ${RESUME_CONTENT_LIMITS.minBulletsPerEntry} and not ${RESUME_CONTENT_LIMITS.maxBulletsPerEntry} - a real job printed short beats a real job left off, which reads as a gap the applicant cannot explain. Reduce the number of entries rather than reducing bullet counts when one-page space is tight. Reuse a stored bullet_variant verbatim when one already fits well;
  only lightly rewrite (never fabricate achievements) when no stored variant surfaces the JD's language.
- When two stored variants for the same entry describe a clear cause and its result, you may combine
  those exact facts into one stronger bullet. Never combine unrelated accomplishments or move facts
  between entries.
- Follow the JD's priority order: the earliest clearly stated responsibilities and requirements get
  the strongest supported evidence first. Order entries and bullets so a recruiter can compare the
  resume with the posting from top to bottom.
- THE FIRST ENTRY IS A DECISION, NOT A DATE. Choose it by asking one question: which entry's own
  bullets prove the most important thing THIS posting asks for? Recency does not decide it, and
  neither does which entry is on the base resume first. The applicant's newest role is often the
  wrong answer - a product management posting is led by the entry whose bullets define product
  requirements and ship to users, even when a more recent engineering role exists, and an
  infrastructure posting is led by the infrastructure work even when it is older. Reverse
  chronological order is a habit, not a rule; break it whenever a different entry proves more.
- "lead_alignment": EMIT THIS KEY FIRST, BEFORE "experience", and mean it. It is the ordering
  decision itself, not a note about a decision already made. Pick the requirement and the entry
  here, then write "experience" with that entry in position one. Writing the resume first and this
  field afterwards produces a justification retro-fitted to whatever came out on top, which is the
  failure this field exists to prevent. Three fields:
  - "entry_org": the org of your FIRST experience entry, copied exactly from it.
  - "requirement": the one entry from THE POSTING'S PRIMARY ASKS list below that this entry proves,
    copied from that list character for character. Not a paraphrase, not a different line from
    elsewhere in the posting, and not a requirement you have written yourself. Those asks are the
    posting's own priority order, so proving a line near the top of the list is worth more than
    proving one near the bottom.
  - "evidence": the bullet from that first entry, copied EXACTLY as you wrote it in "experience",
    that proves the quoted requirement.
  Work in this order: read the primary asks, decide which entry proves the most important one it
  can, put that entry first, then write the citation. If your first entry proves NONE of the listed
  asks, that is the answer to the ordering question, not a reason to reach further down the posting
  for a line it happens to satisfy. Change the order rather than stretching the citation: a
  requirement paired with a bullet that does not address it is worse than no justification.
- Use the JD extraction summary as the priority map. Hard requirements outrank preferences.
  Preferences outrank general responsibilities. Action verbs are writing guidance, not candidate
  evidence. Tools and skills may appear only when the applicant's source already supports them.
- When the candidate's source evidence genuinely supports the same idea, copy the JD's exact
  multi-word terminology into the bullet. Do not use a creative synonym merely to sound different.
  Exact language never overrides truth: if the source does not support the phrase, omit it.
- If the JD states company values or operating principles, demonstrate the relevant value through a
  grounded achievement or collaboration bullet when the bank supports it. Do not create a separate
  values section, make generic personality claims, or displace stronger role evidence.
- Copy each entry's type from the experience bank. Do not turn a project into a job or a job into leadership.
- "skills": EVERY entry must be one of the applicant's Skills list, either copied as written there or
  renamed under the "skill_source" rule below. If the Skills list is empty, use only skills clearly
  evidenced by a bullet you selected.
- SELECT, do not dump. Choose the 8-10 Skills-list entries most relevant to THIS JD, most relevant
  first, and leave the rest out. A SKILLS line listing every skill the applicant has tells the reader
  nothing about their fit for this role, and pushes the relevant ones below the fold. Omitting a
  skill here does not deny it: it is a different job's resume.
- Each skill appears exactly ONCE, and is written EXACTLY as it appears in the Skills list. Copy the
  applicant's own wording character for character. Do not re-word, re-label, generalise, expand an
  abbreviation, or substitute the job description's vocabulary. If the JD says "ETL" and the applicant
  wrote "SQL", the resume says "SQL".
- "skill_source": leave it out. Renaming is DISABLED (see below).
- NEVER add a skill because the job description asks for it. If the JD wants a tool and the applicant's
  Skills list doesn't have it, they don't have it: leave it out. A resume that omits a skill costs an
  interview; a resume that claims one the applicant lacks costs their credibility in the screen.
- Never invent an employer, title, metric, or skill that isn't grounded in the experience bank.
- Use the applicant's real school, degree, and graduation date exactly as given in the Education line; never invent or
  upgrade a degree, and leave "degree" an empty string if none is provided.
- "coursework": include only courses explicitly listed in the Education source. Never use the job description as evidence for a course.
- Set education_position to "top" when the Education source says the candidate is currently enrolled or graduated within the last two years, otherwise "after_experience". Note this field is RE-DERIVED server-side from the parsed education dates and your answer is not what ships; set it anyway so the object validates.
- THE VERB RULE OUTRANKS VERBATIM REUSE. Reusing a stored bullet word for word is preferred, but not
  when it opens with a verb that is not on the approved list. In that case rewrite the OPENING only,
  keeping every fact, number and noun exactly as the source has them. A bullet that starts with
  Assisted, Supported, Helped, Performed, Participated, Attended, Worked or Engaged must be recast
  around what the applicant actually did.
- KEEP THE APPLICANT'S OWN SPELLING. If their resume writes "optimised", "analysed", "modelled",
  "organisation" or "programme", the resume Litos generates writes it that way too. Never convert
  between British and American spelling in either direction, and never treat a Commonwealth spelling
  as an error to fix. A student applying in London, Dublin, Sydney, Singapore or Toronto is spelling
  it correctly for the employer reading it, and one applying in the US from a British-schooled
  background is spelling their own history the way they have always spelt it. This applies to every
  word on the page, not only to verbs.
- Every bullet starts with a strong action verb, one of: ${[...STRONG_VERBS].join(', ')}.
- Every bullet is 8-30 words, one sentence, no more than two "and"s (prefer ; : or - over a run-on).
- Include a real number, percent, dollar amount, or multiplier in a bullet whenever the source material
  supports one; do not invent metrics that aren't grounded in the experience bank.
- NEVER use an em dash (—) anywhere in the output. Use a comma, colon, hyphen, or period instead.
- Bullets must fit in roughly two lines of a resume (under 235 characters) - be concise, not padded.`;

const RESUME_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    target_role: { type: 'string' },
    school: { type: 'string' },
    degree: { type: 'string' },
    grad_date: { type: 'string' },
    coursework: { type: 'string' },
    education_position: { type: 'string', enum: ['top', 'after_experience'] },
    lead_alignment: {
      anyOf: [
        {
          type: 'object',
          properties: {
            entry_org: { type: 'string' },
            requirement: { type: 'string' },
            evidence: { type: 'string' },
          },
          required: ['entry_org', 'requirement', 'evidence'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    },
    experience: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['job', 'project', 'leadership'] },
          org: { type: 'string' },
          title: { type: 'string' },
          date_range: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
        },
        required: ['type', 'org', 'title', 'date_range', 'bullets'],
        additionalProperties: false,
      },
    },
    skills: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'target_role',
    'school',
    'degree',
    'grad_date',
    'coursework',
    'education_position',
    'lead_alignment',
    'experience',
    'skills',
  ],
  additionalProperties: false,
};

function parseGeneratedResumeSpec(text: string, provider: string, stopReason: string): ResumeSpec {
  try {
    const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    return normalizeSpec(JSON.parse(cleaned));
  } catch {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return normalizeSpec(JSON.parse(text.slice(first, last + 1)));
      } catch {
        // Fall through to the descriptive provider error.
      }
    }
    throw new Error(
      `${provider} returned invalid JSON for resume spec (stop_reason=${stopReason}): ${text.slice(0, 200)}`,
    );
  }
}

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
      type: (e.type === 'project' || e.type === 'leadership' ? e.type : 'job') as 'job' | 'project' | 'leadership',
      org: str(e.org),
      title: str(e.title),
      location: str(e.location),
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
  /* Null rather than a half-built object when any of the three fields is missing or mistyped. A
     partial citation cannot be checked - an evidence bullet with no requirement beside it proves
     nothing - and leadAlignmentIssues already reports absence clearly. Fabricating the missing
     halves here would turn a model that skipped the field into a model that appeared to answer. */
  const leadAlignment = (v: unknown): LeadAlignment | null => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const a = v as Record<string, unknown>;
    const entry_org = str(a.entry_org).trim();
    const requirement = str(a.requirement).trim();
    const evidence = str(a.evidence).trim();
    const jd_hash = str(a.jd_hash).trim();
    if (!entry_org || !requirement || !evidence) return null;
    return { entry_org, requirement, evidence, ...(jd_hash ? { jd_hash } : {}) };
  };
  return {
    target_role: str(o.target_role),
    school: str(o.school),
    degree: str(o.degree),
    grad_date: str(o.grad_date),
    gpa: str(o.gpa),
    school_location: str(o.school_location),
    coursework: str(o.coursework),
    education_position: o.education_position === 'after_experience' ? 'after_experience' : 'top',
    experience,
    lead_alignment: leadAlignment(o.lead_alignment),
    skills: strArr(o.skills),
    skill_source: strMap(o.skill_source),
  };
}

export async function generateResumeSpec(
  jdText: string,
  company: string,
  role: string,
  bank: ExperienceBankEntry[],
  education: {
    school: string;
    degree?: string;
    grad_date?: string;
    grad_year?: number;
    currently_enrolled?: boolean;
    coursework?: string[];
  },
  feedback?: string[],
  // The applicant's declared skills (profiles.skills). Empty/undefined means they never gave us a
  // list, which the validator treats as soft-grounding rather than as "they have no skills".
  skills?: string[] | null,
  // Hard per-call wall-clock bound. The route runs inside Vercel's 60s function ceiling and passes
  // its real remaining budget here; a call that outlives it is aborted (APIUserAbortError), which
  // the route's overload classifier deliberately treats as NOT retryable - it is our own deadline.
  timeoutMs?: number,
  /* The applicant's APPROVED base resume, when they have one.
   *
   * Appended rather than inserted mid-signature so existing positional callers keep working. */
  baseSpec?: ResumeSpec | null,
  priorityEntry?: ExperienceBankEntry | null,
): Promise<ResumeSpec> {
  /* THE BASE RESUME IS THE STARTING POINT, NOT MORE CONTEXT.
   *
   * Without this the tailored path re-selected from the raw bank on every application, which had
   * two consequences. The applicant's approved page was ignored, so a resume they had read and
   * accepted bore no necessary relationship to what actually got submitted. Worse, any bullet they
   * EDITED on /start was stranded: edits are stored on the base resume, while generation read
   * `experience_bank.bullet_variants`, so a correction they made by hand never reached a single
   * application.
   *
   * Framing it as a starting point also matches what tailoring is actually for. Most entries carry
   * over unchanged; the JD's job is to justify SWAPS - pulling in a bank entry that fits this
   * posting better than one already on the page - and to re-order what remains. That is a smaller,
   * better-defined task than reselecting from scratch, and it makes the base resume the stable
   * spine every application is a variation on. */
  const baseBlock = baseSpec?.experience?.length
    ? `\n\nThe applicant's APPROVED BASE RESUME. This is your starting point, and its wording is
authoritative: where a bullet here covers the same work as a bank entry, the bullet BELOW is the
applicant's own corrected phrasing and must be preferred verbatim.
${JSON.stringify({ experience: baseSpec.experience, skills: baseSpec.skills })}

How to use it:
- Keep an entry from the base resume unless the bank holds one that fits THIS posting clearly
  better. Carrying an entry over is the default; swapping is the exception you justify.
- When you do swap, take the replacement from the experience bank below - the bank holds everything
  the applicant has done, including work the base resume left off.
- Re-order entries and bullets so the strongest evidence for THIS job reads first, even when the
  set of entries does not change. The base resume's ORDER carries no authority: it was built with
  no posting in front of it, so it leads with current work by default. Its WORDING is authoritative;
  its sequence is a starting point you are expected to change.
- Never invent. Everything must still trace to the bank or to the base resume above.`
    : '';
  /* INCLUSION, NOT POSITION - and the difference is the whole of criterion 3.
   *
   * This block used to read "Include this entry in the FIRST position on every resume. It may not
   * be swapped out for job-description fit", and routes/resume.ts failed the packet outright when
   * the entry was not first. The entry it names is whatever `selectRecentExperience` found to have
   * the latest end date, so that instruction said, in as many words, that the lead experience is
   * decided by recency and that the posting may not change it. No amount of "most relevant first"
   * elsewhere in this prompt can outrank a rule that explicit.
   *
   * The concern behind it is real but it is a different concern: a resume that OMITS the
   * applicant's current role reads as a gap or as out of date, and the /start impact step spends
   * the applicant's time getting that entry's bullets right. Both are answered by the entry being
   * ON the page. Neither requires it to be at the top of a posting it does not fit. */
  const priorityBlock = priorityEntry
    ? `\n\nREQUIRED EXPERIENCE. This entry must APPEAR on every resume: leaving the applicant's current or most recent work off reads as a gap. Its POSITION is not fixed - order it against this posting like any other entry, and lead with it only when it proves what this posting asks for. Use only its grounded bank evidence. If the bank holds fewer than ${RESUME_CONTENT_LIMITS.minBulletsPerEntry} bullets because the applicant explicitly continued with sparse evidence, include every grounded bullet and invent nothing:\n${JSON.stringify(priorityEntry)}`
    : '';

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
  // The skills list sits in the cached prefix alongside the bank: it is per-applicant, not per-JD, so
  // it is identical across both attempts of a generate and across every application they file.
  const skillsBlock = skills?.length
    ? `\n\nSkills list (the applicant's own skills - the ONLY skills that may appear in "skills"):\n${JSON.stringify(skills)}`
    : `\n\nSkills list: none provided. Use only skills clearly evidenced by a bullet you selected, and do not add skills from the job description.`;
  const jdSignals = extractJdSignals(jdText, { company, role });
  /* The closed list `lead_alignment.requirement` must be drawn from, rendered numbered so the
     posting's priority order is visible rather than implied. Built by the SAME function the
     validator calls with the same (jdText, company, role), which is what makes the list the model
     is shown and the list it is judged against one list. Empty means the posting supports no
     evidence-bearing lead ordering. The selector and verifier preserve the saved experience order
     and store null instead of fabricating a citation from boilerplate or form labels. */
  const primaryAsks = leadRequirementCandidates(jdText, { company, role });
  const asksBlock = primaryAsks.length
    ? `\n\nTHE POSTING'S PRIMARY ASKS, in the posting's own priority order. "lead_alignment.requirement" MUST be one of these lines, copied exactly:\n${primaryAsks.map((ask, i) => `${i + 1}. ${ask}`).join('\n')}`
    : '';
  const contextBlock = `Job: ${role} at ${company}\n\nJD extraction summary (use this to rank evidence; never use it as evidence that the applicant has a skill):\n${JSON.stringify(jdSignals)}${asksBlock}\n\nJob description:\n${jdText}\n\nEducation source (copy facts exactly; this is the only authority for school, degree, graduation date, enrollment, and coursework):\n${JSON.stringify(education)}${skillsBlock}${baseBlock}${priorityBlock}\n\nExperience bank:\n${JSON.stringify(bank)}`;
  const userContent = `Return the tailoring spec JSON.${feedbackBlock}`;

  // A validation retry deliberately goes straight to Claude. It means the first OpenAI result was
  // syntactically usable but did not meet Litos's deterministic quality bar, which is exactly when
  // the independent provider is more valuable than another attempt from the same model.
  if (openAIConfigured() && !feedback?.length) {
    try {
      const generated = await generateOpenAIText({
        instructions: `${RESUME_SYSTEM_PROMPT}\n\n${contextBlock}`,
        input: userContent,
        maxOutputTokens: 16384,
        timeoutMs,
        jsonSchema: { name: 'litos_resume_spec', schema: RESUME_JSON_SCHEMA },
      });
      return parseGeneratedResumeSpec(generated.text, 'OpenAI', 'completed');
    } catch (error) {
      logOpenAIFallback('resume tailoring', error);
    }
  }

  const response = await client.messages.create(
    {
      model: 'claude-sonnet-5',
      // max_tokens is a SHARED budget for thinking AND the JSON, not just the JSON. Measured on a
      // real call: thinking_tokens=1360 of output_tokens=2242, so reasoning ate ~60% of the response
      // before a single character of spec was emitted. At 4096 that left little headroom, and the
      // failure mode is nasty: the JSON truncates mid-object, `stop_reason: max_tokens` throws, and
      // the retry is a second full-price call that tends to truncate the same way -> a hard 500 on a
      // healthy model. It is also INTERMITTENT, since how long the model thinks varies per JD, so it
      // surfaces as a flaky endpoint rather than an obvious bug. Caught when the skills
      // select/translate rules made the prompt richer and pushed a working call over the line.
      // 8192 left roughly 3x headroom over the largest spec observed (~2.2k output tokens). We
      // only pay for what is generated, so a higher ceiling costs nothing on a normal call.
      //
      // RAISED TO 16384 ON 2026-08-09, and by the same mechanism the comment above describes: the
      // lead_alignment rules made the prompt richer and pushed a working call over the line. It
      // reproduced immediately on the Databricks Product Management packet, on the FEEDBACK retry,
      // where the model has to reconsider its ordering rather than emit the obvious subset - the
      // response truncated after 3548 characters of JSON. That is the worst case to truncate on,
      // because the retry is the attempt carrying the fix. Choosing which entry leads is real
      // reasoning and it is now being asked for explicitly, so this call thinks about as hard as
      // the base build does, and it gets the base build's ceiling (baseResume.ts, same value, same
      // argument).
      max_tokens: 16384,
      system: [
        { type: 'text', text: RESUME_SYSTEM_PROMPT },
        { type: 'text', text: contextBlock, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content: userContent,
        },
      ],
    },
    // When the caller supplies a budget, the abort signal hard-bounds the call and maxRetries: 0
    // hands ALL capacity retries to the route's own counter (resume.ts). The SDK's built-in retries
    // would multiply the route's attempts and, worse, honor a long Retry-After with a sleep the
    // route cannot see or budget-gate - which is exactly the hidden stall that 504s a 60s function.
    timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs), maxRetries: 0 } : undefined,
  );

  const textBlock = response.content.find((block) => block.type === 'text');
  const text = textBlock?.type === 'text' ? textBlock.text : '';

  if (response.stop_reason === 'max_tokens') {
    throw new Error(`Resume spec truncated at max_tokens (${text.length} chars) - raise the cap`);
  }

  return parseGeneratedResumeSpec(text, 'Claude', response.stop_reason ?? 'unknown');
}
