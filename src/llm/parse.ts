import Anthropic from '@anthropic-ai/sdk';
import { unsupportedTargetRoles } from './targetRoleEvidence';

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
  "objective": string,
  "target_roles": [string],
  "gpa": string,
  "gpa_scale": string,
  "major": string
}

Rules:
- "full_name" is the applicant's name from the resume header, not a company or school name
- "end" should be "Present" if the role is current
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
- Return empty arrays for missing sections, never null
- If grad_year is truly unknown, use 0`;

export function parsedProfileFromModelText(text: string, rawResumeText = ''): ParsedProfile {
  const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  const parsed = JSON.parse(cleaned) as ParsedProfile;
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
  const unsupported = unsupportedTargetRoles(roles, parsed, rawResumeText);
  if (unsupported.length > 0) {
    throw new Error(`resume parse contained unsupported target roles: ${unsupported.join(', ')}`);
  }
  parsed.target_roles = roles;
  return parsed;
}

export async function parsedProfileWithOneRepair(
  initialText: string,
  repair: (failure: string) => Promise<string>,
  rawResumeText = '',
): Promise<ParsedProfile> {
  try {
    return parsedProfileFromModelText(initialText, rawResumeText);
  } catch (error) {
    const failure = error instanceof Error ? error.message : 'invalid resume JSON';
    return parsedProfileFromModelText(await repair(failure), rawResumeText);
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
    return await parsedProfileWithOneRepair(initial, request, resumeText);
  } catch (error) {
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
    throw new Error(`Claude returned invalid JSON for scanned resume parsing: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`);
  }
}
