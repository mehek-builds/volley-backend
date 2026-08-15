import Anthropic from '@anthropic-ai/sdk';
import { isUpstreamApiError } from '../lib/llmFailure';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ParsedProfile {
  full_name: string;
  experience: Array<{
    company: string;
    title: string;
    /* Transcribed from the page, never inferred: see the "location" rule in the system prompt.
       Optional because every parse predating 2026-08-04 lacks it, and an older profile is not
       malformed for having no city on a job. */
    location?: string;
    start: string;
    end: string;
    description: string;
  }>;
  skills: string[];
  /* Spoken languages the resume PRINTED, e.g. ["English","Hindi","French"].
   *
   * WHY THIS FIELD EXISTS. Before it, the schema had nowhere to put a spoken language, so the model
   * did the only thing left and filed them under `skills`. Measured 2026-08-03 on the live account
   * used to demo the product: `skills` read English, Hindi, Punjabi, French, Arabic, Spanish, MS
   * PowerPoint, Adobe Photoshop, C++, Figma, Python - six of eleven were spoken languages, and
   * because a resume's language line usually sits above its technical line they sorted FIRST. That
   * list is not decorative: baseResume.ts's skillsSourceFor falls back to it whenever the declared
   * profiles.skills column is null, which is every student at onboarding, and it is authoritative in
   * declared mode. So every tailored resume Litos generated for that account led its skills section
   * with six languages before reaching C++.
   *
   * SEPARATE FROM application_profile.languages, deliberately and permanently. That column is the
   * student's own declaration of FLUENCY, collected once in onboarding, and schema.ts spells out why
   * it may never be inferred - including from resume text. This field is weaker by construction: it
   * records what a page printed, and "French" on a resume line is not a claim of fluency to an
   * employer. Nothing here may flow into that column without the student confirming it.
   */
  languages?: string[];
  projects: Array<{
    name: string;
    role?: string;
    date_range?: string;
    description: string;
  }>;
  leadership?: Array<{
    organization: string;
    title: string;
    location?: string;
    start: string;
    end: string;
    description: string;
  }>;
  school: string;
  school_location?: string;
  degree?: string;
  grad_date?: string;
  grad_year: number;
  currently_enrolled?: boolean;
  coursework?: string[];
  objective?: string;
  target_roles: string[];
  /* Academic record, PRINTED not inferred. These three exist because /start's gaps screen asks for
   * exactly them, and before this the parser had no field for any of them - so the screen asked
   * every student for a GPA and a major their own upload had just stated. Measured 2026-07-27
   * across 15 real resumes: 8 printed a GPA verbatim ("GPA: 3.75") and every one printed a degree
   * line the major is inside. See routes/profile.ts for the seeding, and onboarding.ts GAP_FIELDS
   * for the questions this removes.
   *
   * Empty string, never a guess. A GPA is a claim on an employment application: a fabricated one is
   * worse than an absent one, and an absent one is only one question. */
  gpa?: string;
  gpa_scale?: string;
  major?: string;
  // Page count of the file this parse came from, measured by extractPdfText and stamped on by
  // routes/profile.ts - NOT produced by the model, which never sees the page structure. /start
  // states it back to the student when it shows the one-page base resume. 0 means unmeasured.
  source_pages?: number;
  // Filled by the upload route after reconciling this parse with durable experience-bank rows.
  bank_total?: number;
  // Replaced on every upload. It is the durable cursor for the evidence review that must happen
  // before the uploaded experience becomes the spine of generated resumes.
  recent_experience_review?: unknown;
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
  "experience": [{"company": string, "title": string, "location": string, "start": string, "end": string, "description": string}],
  "skills": [string],
  "languages": [string],
  "projects": [{"name": string, "role": string, "date_range": string, "description": string}],
  "leadership": [{"organization": string, "title": string, "location": string, "start": string, "end": string, "description": string}],
  "school": string,
  "school_location": string,
  "degree": string,
  "grad_date": string,
  "grad_year": number,
  "currently_enrolled": boolean,
  "coursework": [string],
  "objective": string,
  "target_roles": [string],
  "gpa": string,
  "gpa_scale": string,
  "major": string
}

Rules:
- "full_name" is the applicant's name from the resume header, not a company or school name
- "end" should be "Present" if the role is current
- "location" is the place printed beside that role, copied verbatim, e.g. "Los Angeles, CA" or
  "London, United Kingdom". TRANSCRIBE, NEVER INFER. Do not derive it from the company's
  headquarters, from where the company is famous for being, from the school, or from anywhere else
  on the page. A resume that prints no place for a role gets an empty string, and an empty string
  is the correct answer far more often than a guessed city. Where someone worked is a checkable
  claim on an employment document.
- "school_location" follows the same rule for the education entry: the place printed beside the
  school, verbatim, or an empty string.
- "description" must keep the resume's own bullet structure: one printed bullet per line, separated
  by a newline character, with the bullet marker itself removed. Do not merge separate bullets into
  a paragraph. Each bullet is a distinct achievement, and running them together destroys the only
  structure the resume gave us.
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
- "skills" is TECHNICAL and professional ability only: tools, software, programming languages,
  methods, certifications. It must NEVER contain a spoken or natural language such as English,
  Hindi, French, Arabic, Mandarin or Spanish. Those go in "languages" and nowhere else. A resume
  usually prints its language line above its technical line, so copying the page order puts spoken
  languages at the head of the skills list, which is exactly the failure this rule prevents.
- "languages" holds the spoken or natural languages printed on the resume, copied as printed and
  keeping any proficiency the resume states, e.g. "Spanish (conversational)". Programming languages
  are NOT spoken languages and belong in "skills". Return an empty array when the resume prints no
  language line; never infer a language from the applicant's name, school, or country.
- "coursework" may contain only courses explicitly printed on the resume.
- "objective" is the objective or summary copied from the resume. Use an empty string when absent.
- "gpa" is the grade average printed on the resume, digits only, e.g. "3.75" from "GPA: 3.75/4.0".
  Empty string when the resume does not print one. NEVER estimate, round or infer a GPA from
  honours, Latin honours, or anything else - an invented GPA is a false claim on a job application.
- "gpa_scale" is the denominator when the resume prints one, e.g. "4.0" from "3.75/4.0". When the
  resume prints a bare number with no scale, return an empty string rather than assuming 4.0:
  scales differ by country (10.0 in India, 5.0 in Germany) and a wrong denominator silently
  misstates the applicant's record.
- "major" is the field of study alone, taken from the degree line, e.g. "Psychology" from
  "Bachelor of Arts, Psychology" or "Computer Science" from "BS in Computer Science". Drop the
  award words (Bachelor, BS, Master). For a joint or dual degree carry both, comma-separated, in
  the printed order. Empty string when no degree is stated.
- "target_roles" must contain exactly five distinct job titles, ordered from strongest to weakest
  fit. Infer them from the resume objective, the candidate's dated years of experience, past job
  titles, projects, skills, and stated degree. Match the seniority shown by the evidence and do not
  invent a field the resume does not support. Each title must be supported by at least one of those
  sources. Give the strongest role first, then adjacent careers the same evidence genuinely supports.
  Do not return five cosmetic variations of one title, but never add an unsupported field merely to
  create variety.
- The space of valid job titles is open-ended. Never restrict recommendations to common careers, a
  predefined occupation list, or the examples familiar to you. Specialized, emerging, regional and
  interdisciplinary roles are valid when the resume evidence supports them.
- Return empty arrays for missing sections, never null
- If grad_year is truly unknown, use 0`;

/* Spoken language names, lowercased, used to pull a language back out of `skills`.
 *
 * WHY A LIST AND NOT JUST THE PROMPT. R-047's comment argues the prompt is the only defence for the
 * degree line, and that is right THERE, because a degree is free text no list could enumerate. A
 * spoken language is the opposite: the set is small, closed and stable, so it can be checked without
 * a model. That matters because the text path runs on Haiku, the prompt rule is one instruction
 * among twenty, and the cost of the rule being ignored is silent - a language sitting in `skills`
 * looks exactly like a skill to every consumer downstream. This is the deterministic floor under the
 * instruction, and it is what the tests can actually assert.
 *
 * NO PROGRAMMING LANGUAGES OR TOOL NAMES APPEAR HERE, and the omissions are load-bearing rather than
 * accidental: Go, R, Rust, Swift, Ruby, Julia, Scheme, Basic and Processing are all names a careless
 * language list would swallow, and each one is a real technical skill on a real student's resume.
 * "Javanese" is listed while "Java" deliberately is not, for the same reason. A false positive here
 * deletes an engineering skill from a resume, which is strictly worse than the bug being fixed, so
 * anything ambiguous stays off the list. */
const SPOKEN_LANGUAGES = new Set([
  'english', 'spanish', 'french', 'german', 'italian', 'portuguese', 'dutch', 'flemish',
  'russian', 'polish', 'ukrainian', 'belarusian', 'czech', 'slovak', 'romanian', 'hungarian',
  'greek', 'turkish', 'swedish', 'norwegian', 'danish', 'finnish', 'icelandic', 'estonian',
  'latvian', 'lithuanian', 'serbian', 'croatian', 'bosnian', 'slovenian', 'bulgarian',
  'macedonian', 'albanian', 'maltese', 'luxembourgish', 'catalan', 'basque', 'galician',
  'irish', 'welsh', 'scottish gaelic', 'latin',
  'arabic', 'hebrew', 'persian', 'farsi', 'dari', 'pashto', 'kurdish', 'armenian', 'georgian',
  'azerbaijani', 'kazakh', 'uzbek', 'turkmen', 'mongolian',
  'hindi', 'urdu', 'punjabi', 'gujarati', 'marathi', 'bengali', 'bangla', 'tamil', 'telugu',
  'kannada', 'malayalam', 'sinhala', 'nepali', 'sindhi', 'assamese', 'odia', 'oriya',
  'hindustani', 'sanskrit',
  'chinese', 'mandarin', 'mandarin chinese', 'simplified chinese', 'traditional chinese',
  'cantonese', 'japanese', 'korean', 'vietnamese', 'thai', 'khmer', 'lao', 'burmese',
  'indonesian', 'malay', 'bahasa indonesia', 'bahasa melayu', 'filipino', 'tagalog', 'javanese',
  'swahili', 'amharic', 'somali', 'hausa', 'yoruba', 'igbo', 'zulu', 'xhosa', 'afrikaans',
  'american sign language', 'asl', 'british sign language', 'bsl',
  'haitian creole', 'creole', 'yiddish', 'esperanto',
]);

/* One skills entry reduced to the bare language name it might be.
 *
 * Resumes annotate a language rather than naming it alone: "Spanish (conversational)", "French -
 * fluent", "Hindi: native", "Arabic (professional working proficiency)". Matching the raw string
 * would miss every one of those, so the qualifier is stripped for the COMPARISON only. The entry is
 * still stored verbatim, because the proficiency is the honest part of the claim and dropping it
 * would turn "Spanish (basic)" into a bare "Spanish" that reads as fluency. */
function languageKeyOf(entry: string): string {
  return entry
    .replace(/\s*[([{].*$/, '')
    // \u2013 and \u2014 are the en and em dash. Written as escapes rather than literals so the
    // separators a resume actually prints are still matched without those characters appearing here.
    .replace(/\s*[-\u2013\u2014:|/]\s.*$/, '')
    .trim()
    .toLowerCase();
}

/* Split a parsed `skills` array into the technical skills it should have held and the spoken
 * languages that were only ever there because the schema had no other field.
 *
 * Exported as a pure function on purpose. It is the same operation a one-off backfill over stored
 * parsed_json rows would need, and keeping it callable means such a script can reuse this exact
 * classification rather than growing a second, drifting copy of the language list. */
export function splitSpokenLanguages(skills: unknown): { skills: string[]; languages: string[] } {
  const technical: string[] = [];
  const languages: string[] = [];
  for (const entry of Array.isArray(skills) ? skills : []) {
    if (typeof entry !== 'string') continue;
    const value = entry.trim();
    if (!value) continue;
    if (SPOKEN_LANGUAGES.has(languageKeyOf(value))) languages.push(value);
    else technical.push(value);
  }
  return { skills: technical, languages };
}

/* Case-insensitive union that keeps first-seen spelling and order. The DIRECT statement leads and
 * anything the reclassifier recovered from `skills` follows: on the parse path that is the model's
 * own "languages" answer, because it read the page; on the PATCH path (routes/profile.ts) it is the
 * student's own edit of the languages box on the review screen.
 *
 * Exported for the same reason splitSpokenLanguages is. The two always travel together - a split
 * that produces recovered languages and no union to put them in silently deletes them - so keeping
 * one implementation is what stops the second caller from inventing a subtly different merge. */
export function mergeLanguages(fromModel: unknown, reclassified: string[]): string[] {
  const merged: string[] = [];
  const candidates = [...(Array.isArray(fromModel) ? fromModel : []), ...reclassified];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const value = candidate.trim();
    if (!value || merged.some((existing) => existing.toLowerCase() === value.toLowerCase())) continue;
    merged.push(value);
  }
  return merged;
}

export function parsedProfileFromModelText(text: string): ParsedProfile {
  const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  const parsed = JSON.parse(cleaned) as ParsedProfile;
  /* Runs on EVERY parse, which is also how an already-polluted account repairs itself: parsed_json
   * is rewritten wholesale by each resume upload, so the next upload lands a clean `skills`. No
   * stored row is touched here - a student who has since declared their own profiles.skills list
   * keeps it untouched, because that declaration is theirs and outranks any parse (R-015). */
  const split = splitSpokenLanguages(parsed.skills);
  parsed.skills = split.skills;
  parsed.languages = mergeLanguages(parsed.languages, split.languages);
  const roles: string[] = [];
  // A prior fallback padded an incomplete recommendation with past experience titles. That made
  // malformed output look valid and could present a former campus or volunteer title as a job the
  // student should pursue. The model has the full evidence and one bounded repair attempt, so only
  // its explicit target-role answer belongs in this field.
  const candidates = Array.isArray(parsed.target_roles) ? parsed.target_roles : [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const clean = candidate.trim().slice(0, 80).trim();
    if (!clean || roles.some((role) => role.toLowerCase() === clean.toLowerCase())) continue;
    roles.push(clean);
    if (roles.length === 5) break;
  }
  if (roles.length !== 5) throw new Error('resume parse did not contain five evidence-backed target roles');
  parsed.target_roles = roles;
  return parsed;
}

/* The GPA the resume itself prints, read deterministically from the source text.
 *
 * Exists because the model does not always transcribe the number correctly. Caught on a live
 * account 2026-08-03: a resume printing "GPA: 3.89/4.0" parsed to gpa "3.8", scale "4.0". The scale
 * survived and the last digit of the grade did not, which is the worst shape this failure can take
 * - "3.8" is a plausible GPA, so nothing downstream had any reason to doubt it, and the number
 * feeds application_profile (see routes/profile.ts academicSeedFrom) which is what autofill types
 * into employer forms. A misread GPA is a false factual claim about a real person on a real job
 * application, and it is not the kind of error a student is likely to spot in a JSON dump.
 *
 * DECLINING IS ALWAYS SAFE HERE AND GUESSING NEVER IS. This function only ever overrules the model,
 * and it only fires when it DISAGREES with the model, so every wrong reading it produces lands on a
 * case where the model was already right. The first draft of it took the first number after the
 * label and did exactly that: "GPA (out of 4.0): 3.89" read as 4.0, turning a correct 3.89 into a
 * claimed perfect score on an employment application. Every rule below therefore returns null on
 * doubt rather than picking, and a null costs nothing - the model's own answer stands.
 *
 * It returns a reading only when ALL of the following hold:
 *
 *   - Nothing between the label and the number announces a denominator ("out of", "scale", "/").
 *     Those phrasings put the SCALE first and the grade second, which is common on international
 *     resumes and is precisely how a 3.89 becomes a 4.0.
 *   - Nothing immediately after the number announces one either, when no "x/y" was captured. Same
 *     reversal written the other way round ("GPA on a 4.0 scale: 3.89").
 *   - The number is not a percentage, is not cut short by a following digit, and is not the integer
 *     half of a European decimal comma ("3,89/4,0" must never read as 3).
 *   - The grade does not exceed its denominator, captured or implied. A GPA above its own scale is
 *     not a GPA, it is a misread of something else on the line.
 *   - Every GPA-labelled number in the document is the same number. A resume printing a major GPA
 *     and a cumulative GPA states two different facts, and choosing between them is the judgement
 *     the model is here to make.
 *
 * The scale is taken ONLY from an explicit "x/y" denominator, never from prose, because inventing a
 * denominator restates an Indian 10.0 or a German 5.0 record as a near-perfect one - the same rule
 * the system prompt states above.
 */
const PRINTED_GPA =
  // "CGPA" is the same label outside the US and is spelled as one word, so the leading C is part of
  // the alternation rather than left to a word boundary that would never fire inside it.
  // "cumulative average" is deliberately NOT here: it is the usual label for a percentage average,
  // and reading "Cumulative Average: 92.4" as a GPA is the same falsification in another costume.
  /(?:\bc?gpa\b|grade[\s-]?point[\s-]?average)([^0-9\n]{0,15})(\d{1,2}(?:\.\d{1,3})?)(?:\s*\/\s*(\d{1,2}(?:\.\d{1,2})?))?/gi;

// A denominator announced BEFORE the number, so the number captured is the scale, not the grade.
const SCALE_LEADS = /out\s*of|scale|\//i;
// The same announcement made AFTER the number, which the "x/y" branch cannot see.
const SCALE_TRAILS = /^\s*\)?\s*(?:out\s*of\b|(?:point[\s-]*)?scale\b|-?point\b)/i;

export function printedGpaIn(resumeText: string): { gpa: string; scale?: string } | null {
  if (!resumeText) return null;
  let reading: { gpa: string; scale?: string } | null = null;
  for (const match of resumeText.matchAll(PRINTED_GPA)) {
    const [whole, gap, gpa, scale] = match;
    const trailing = resumeText.slice((match.index ?? 0) + whole.length);

    if (SCALE_LEADS.test(gap)) return null;
    if (!scale && SCALE_TRAILS.test(trailing)) return null;
    // A percentage, a number the pattern cut short, or a comma decimal. None of the three is the
    // grade this resume printed, and all three are silently plausible once stored.
    if (/^(?:%|\d|,\d)/.test(trailing)) return null;

    const grade = Number(gpa);
    if (!Number.isFinite(grade)) return null;
    if (scale) {
      const denominator = Number(scale);
      if (!Number.isFinite(denominator) || denominator <= 0 || grade > denominator) return null;
    } else if (grade > 10) {
      // No printed denominator, and no grading scale in use tops out below the number we read. This
      // is a percentage, a credit count or a year that happened to sit next to the label.
      return null;
    }

    if (!reading) {
      reading = scale ? { gpa, scale } : { gpa };
      continue;
    }
    // Two GPA-labelled numbers that disagree: ambiguous document, no deterministic answer.
    if (reading.gpa !== gpa) return null;
    // Same grade printed twice, one occurrence carrying the denominator. Keep the denominator.
    if (!reading.scale && scale) reading.scale = scale;
  }
  return reading;
}

/* Correct a transcription error in the parsed GPA against what the resume text actually prints.
 *
 * Deliberately one-directional: this only ever REPLACES a value the model already claimed. When the
 * model returned no GPA it stays empty, even if the text prints one, because an empty answer can be
 * a deliberate one - a resume printing only "Major GPA: 3.95" states no overall grade, and filling
 * the field from that line would turn a careful abstention into a claim the student never made.
 *
 * Only the text path can use this. A scanned or photographed resume has no reliable text layer to
 * check against (that is why parseResumeFromPdf exists), so its GPA remains model-transcribed and
 * unverified. That gap is why application_profile, not this parse, is the source of truth for the
 * GPA that reaches an employer - see routes/profile.ts.
 */
export function reconcileGpaWithSource<T extends { gpa?: string; gpa_scale?: string }>(
  parsed: T,
  resumeText: string,
): T {
  const claimed = parsed.gpa?.trim();
  if (!claimed) return parsed;
  const printed = printedGpaIn(resumeText);
  if (!printed || printed.gpa === claimed) return parsed;

  /* The denominator has to be reconciled along with the grade, not left behind.
   *
   * A printed "x/y" is authoritative and replaces whatever the model said. Where the resume printed
   * no denominator the model's stays - EXCEPT when the corrected grade no longer fits inside it. A
   * kept "4.0" under a corrected 8.94 reads as "8.94 out of 4.0", which is not a record anyone has,
   * and it is the model's scale that is now unsupported, not the printed grade. Blanking it puts
   * the field back on /start's gaps screen for the student to answer, which is what an unknown
   * denominator is supposed to do (see the gpa_scale rule in the system prompt above). */
  const modelScale = parsed.gpa_scale?.trim();
  let gpa_scale = modelScale;
  if (printed.scale) {
    gpa_scale = printed.scale;
  } else if (modelScale && Number(printed.gpa) > Number(modelScale)) {
    gpa_scale = '';
  }

  return {
    ...parsed,
    gpa: printed.gpa,
    ...(gpa_scale === modelScale ? {} : { gpa_scale }),
  };
}

export async function parsedProfileWithOneRepair(
  initialText: string,
  repair: (failure: string) => Promise<string>,
): Promise<ParsedProfile> {
  try {
    return parsedProfileFromModelText(initialText);
  } catch (error) {
    const failure = error instanceof Error ? error.message : 'invalid resume JSON';
    return parsedProfileFromModelText(await repair(failure));
  }
}

export async function parseResumeWithClaude(resumeText: string): Promise<ParsedProfile> {
  try {
    const request = async (repairFailure?: string) => {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: repairFailure
            ? `Parse this resume again. The prior JSON failed validation: ${repairFailure}. Return one complete corrected JSON object, including exactly five supported and adjacent target_roles.\n\n${resumeText}`
            : `Parse this resume text and return the JSON:\n\n${resumeText}`,
        }],
      });
      const textBlock = response.content.find((block) => block.type === 'text');
      return textBlock?.type === 'text' ? textBlock.text : '';
    };
    const initial = await request();
    const parsed = await parsedProfileWithOneRepair(initial, request);
    // The one field on this parse that becomes a factual claim to an employer, checked against the
    // document instead of trusted. See reconcileGpaWithSource for the live misread that forced it.
    return reconcileGpaWithSource(parsed, resumeText);
  } catch (error) {
    /* An error that arrived with an HTTP status came from the API, so it keeps its own message.
       This catch used to wrap everything, which is how a 400 "Your credit balance is too low"
       reached production logs on 2026-08-15 described as invalid JSON. See lib/llmFailure.ts. */
    if (isUpstreamApiError(error)) throw error;
    throw new Error(`Claude returned invalid JSON for resume parsing: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`);
  }
}

/* Parse a resume the text layer cannot read: a scan, a photo, an export that embedded the page as
 * an image.
 *
 * These are not rare and they are not the student's fault - phone scans of a printed CV, PDFs
 * produced by a scanner, older files. Two of the eight real resumes tested on 2026-07-27 were
 * image-only (623 characters across two pages, and 0 characters across one). Before this they were
 * rejected at upload, which meant those students could not use Litos at all.
 *
 * Sends the PDF itself instead of extracted text: Claude reads the pages visually, so no OCR
 * dependency, no separate service, and the SAME system prompt and JSON shape as the text path.
 * That last part matters - a second parser would be a second set of rules to keep in step with
 * R-047's degree handling and the enrollment rule.
 *
 * Sonnet rather than Haiku here on purpose: reading a page image is materially harder than reading
 * text, this runs once per student at signup, and a misread degree is the R-047 failure this parser
 * exists to prevent.
 */
export async function parseResumeFromPdf(pdf: Buffer): Promise<ParsedProfile> {
  try {
    const request = async (repairFailure?: string) => {
      const response = await client.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
            },
            {
              type: 'text',
              text: repairFailure
                ? `Read this resume again. The prior JSON failed validation: ${repairFailure}. Return one complete corrected JSON object, including exactly five supported and adjacent target_roles. Transcribe exactly what is printed and leave uncertain fields empty.`
                : 'This resume is a scan or an image, so there is no text layer to read. Read the pages visually and return the JSON. Transcribe exactly what is printed; never guess at a word you cannot make out, and leave a field empty rather than inventing a plausible value.',
            },
          ],
        }],
      });
      const textBlock = response.content.find((block) => block.type === 'text');
      return textBlock?.type === 'text' ? textBlock.text : '';
    };
    const initial = await request();
    return await parsedProfileWithOneRepair(initial, request);
  } catch (error) {
    // Same rule as the text path above: their errors keep their words, ours get ours.
    if (isUpstreamApiError(error)) throw error;
    throw new Error(`Claude returned invalid JSON for scanned resume parsing: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`);
  }
}
