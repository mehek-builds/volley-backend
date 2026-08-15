import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/index';
import { profiles, experience_bank, application_profile, targeting } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { encryptField } from '../lib/fieldCrypto';
import { decryptRow } from './applicationProfile';
import {
  parseResumeWithClaude,
  parseResumeFromPdf,
  mergeLanguages,
  splitSpokenLanguages,
  ParsedProfile,
} from '../llm/parse';
import { courseworkFromParsed } from '../engine/resumePolicy';
import { extractPdfText } from '../lib/pdfText';
import {
  MODEL_UNAVAILABLE_CODE,
  MODEL_UNAVAILABLE_MESSAGE,
  isModelUnavailable,
} from '../lib/llmFailure';
import { MultipartFile } from '@fastify/multipart';
import { z } from 'zod';
import { resumeEmailForUpload, resumeEmailOfRecord } from '../lib/resumeEmail';
import {
  extractDocxText,
  inspectResumeUpload,
  ResumeUploadError,
  type ResumeSourceFormat,
} from '../lib/resumeUpload';
import {
  deleteUploadedResumeBlobsForUser,
  deleteUploadedResumeThenClear,
} from '../lib/resumeAccess';
import { selectApplicationProfileRow, type ApplicationProfileRow } from '../lib/applicationFacts';
import {
  applyImpactAnswers,
  assessImpactBullet,
  buildRecentExperienceReview,
  type ImpactAnswerSet,
  type RecentExperienceEntry,
  type RecentExperienceReview,
} from '../engine/recentExperience';

// R-052. Bounded on purpose: these are the only parsed fields a student may correct by hand, and
// the ceilings stop a paste of an entire resume landing in the school field. Every value is trimmed
// by the handler, so " " is rejected here as empty rather than stored as whitespace.
/**
 * The graduation year implied by a typed grad_date.
 *
 * Takes the LAST year in the string, not the first. Students correcting this field paste what their
 * resume prints, and resumes print ranges: "Aug 2024 - May 2028". Taking the first match stored
 * grad_year 2024, which every eligibility filter reads as "already graduated", quietly disqualifying
 * the student from the internships this product exists to win. The last year in a range is the one
 * they finish in. Returns undefined when no year is present, so the stored value is left alone
 * rather than being zeroed by a partial edit.
 */
export function graduationYearFrom(gradDate: string): number | undefined {
  const years = gradDate.match(/\b(?:19|20)\d{2}\b/g);
  if (!years || years.length === 0) return undefined;
  return Number(years[years.length - 1]);
}

export const educationPatchSchema = z
  .object({
    full_name: z.string().trim().min(1).max(120).optional(),
    school: z.string().trim().min(1).max(200).optional(),
    // Joint degrees are long: "Bachelor of Science in Computer Science & Business Administration,
    // Finance Emphasis" is 88 characters, and truncating one is the exact failure R-047 was.
    degree: z.string().trim().max(200).optional(),
    grad_date: z.string().trim().max(40).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Send at least one field to update' });

const editableListItem = z.string().trim().min(1).max(80);

/* The cap on the languages list, named because applyParsedProfilePatch has to respect it too.
 *
 * The patch schema is the shape the review screen sends AND, on the next visit, the shape it sends
 * back after the server has written parsed_json. So anything this route STORES in `languages` must
 * still validate here, or the student's next Save is a 400 on a value we produced ourselves. The
 * language reclassifier below can add entries the caller never sent, which is exactly how that
 * ceiling gets crossed, so the constant is shared rather than written twice. */
const MAX_EDITABLE_LANGUAGES = 30;

// The resume review screen is the student's correction layer over an AI parse. Keep this bounded
// to profile facts that are safe to edit as plain text. Work history has its own structured bank,
// and account email comes from the verified login, so neither can be changed through this route.
export const parsedProfilePatchSchema = z
  .object({
    full_name: z.string().trim().min(1).max(120).optional(),
    resume_email: z.string().trim().email().max(254).optional(),
    phone: z.string().trim().max(40).optional(),
    school: z.string().trim().min(1).max(200).optional(),
    degree: z.string().trim().max(200).optional(),
    grad_date: z.string().trim().max(40).optional(),
    /* Relevant coursework, as one line. PRINTS on the generated resume (the spec copies it from
       here) and was the last resume-visible parse with no way to correct it: not on this schema,
       not on the education patch, not on the settings form. A mis-read course list could only be
       fixed by producing a new PDF, which is R-052's failure wearing a different field. Bounded
       like objective rather than like a title: it is a list of course names, and a parse that runs
       past this length is a section-boundary error, not a busy semester.

       ACCEPTED AS ONE LINE, STORED AS A LIST (ISSUE-044). The review screen edits this as a single
       comma separated input, so the wire shape is a string; every reader of parsed_json.coursework
       expects `string[]` - llm/parse.ts emits one, engine/resumePolicy.ts educationFrom() gates on
       Array.isArray, lib/submissionEducationGuard.ts compares entry by entry, and
       engine/resumeValidate.ts courseworkIsUngrounded() needs the individual course titles to
       ground the rendered line against. Writing the raw string through turned the array into a
       string, educationFrom() then read undefined, and the generated resume printed an EMPTY
       coursework line while the dashboard still displayed the text the student had typed. A 200,
       no error, and the loss only visible in a PDF.

       So the split happens HERE, at the boundary, rather than at any one reader: the transform is
       the single place the wire shape becomes the stored shape. An array is accepted too, because
       this schema is also what the screen sends BACK after the server has written parsed_json (see
       the MAX_EDITABLE_LANGUAGES note above) and a client that round-trips the stored list must not
       400 on our own data. */
    coursework: z
      .union([z.string().trim().max(600), z.array(editableListItem).max(40)])
      .transform(courseworkList)
      .optional(),
    objective: z.string().trim().max(1200).optional(),
    skills: z.array(editableListItem).max(100).optional(),
    /* Spoken languages the resume printed. Editable here for the same reason skills is: the parser
     * used to file languages under skills, so this screen is where a student both sees the
     * separation and fixes a language the reader mis-sorted.
     *
     * This writes parsed_json ONLY. It must never reach application_profile.languages, which is the
     * student's declaration of fluency and is collected by the onboarding question - see schema.ts
     * on why a fluency claim may not be inferred from a resume line. Bounded lower than skills
     * because a language list that runs past twenty is a parse failure, not a polyglot. */
    languages: z.array(editableListItem).max(MAX_EDITABLE_LANGUAGES).optional(),
    // The parser and onboarding contract both use five titles. Students may replace any inferred
    // title with any real role, while keeping the downstream targeting shape complete.
    target_roles: z
      .array(editableListItem)
      .length(5)
      .refine((roles) => new Set(roles.map((role) => role.toLowerCase())).size === 5, {
        message: 'Target roles must be distinct',
      })
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Send at least one field to update' });

export type ParsedProfilePatch = z.infer<typeof parsedProfilePatchSchema>;

const impactAnswerSchema = z.object({
  action: z.string().trim().max(40).optional(),
  noun: z.string().trim().max(180).optional(),
  metric_or_scope: z.string().trim().max(120).optional(),
  outcome: z.string().trim().max(180).optional(),
}).strict();

const recentExperiencePatchSchema = z.object({
  selected_entry_id: z.string().uuid(),
  answers: z.array(impactAnswerSchema).max(3).default([]),
  continue_with_found: z.boolean().default(false),
}).strict();

const storedImpactAssessmentSchema = z.object({
  draft: z.string(),
  score: z.number().int().min(0).max(4),
  components: z.object({
    action: z.object({ present: z.boolean(), evidence: z.string().nullable() }),
    noun: z.object({ present: z.boolean(), evidence: z.string().nullable() }),
    metric_or_scope: z.object({ present: z.boolean(), evidence: z.string().nullable() }),
    outcome: z.object({ present: z.boolean(), evidence: z.string().nullable() }),
  }),
});

const storedRecentExperienceReviewSchema = z.object({
  status: z.enum(['ready', 'choose_entry', 'optional_enrichment', 'needs_input', 'continued']),
  selected_entry_id: z.string().uuid().nullable(),
  user_selected: z.boolean(),
  impact_candidate: storedImpactAssessmentSchema.nullable(),
  grounded_bullet_count: z.number().int().nonnegative(),
  missing_bullets: z.number().int().min(0).max(3),
  completed: z.boolean(),
  continue_with_found: z.boolean(),
});

function reviewFromProfile(value: unknown): RecentExperienceReview | null {
  if (!value || typeof value !== 'object') return null;
  const review = (value as { recent_experience_review?: unknown }).recent_experience_review;
  const parsed = storedRecentExperienceReviewSchema.safeParse(review);
  return parsed.success ? parsed.data : null;
}

function reviewPayload(entries: RecentExperienceEntry[], review: RecentExperienceReview) {
  return {
    ...review,
    candidates: entries.map((entry) => ({
      entry_id: entry.id,
      type: entry.type,
      org: entry.org,
      title: entry.title ?? '',
      date_range: entry.date_range ?? '',
      bullet_variants: (Array.isArray(entry.bullet_variants) ? entry.bullet_variants : [])
        .filter((value): value is string => typeof value === 'string'),
    })),
  };
}

export function normalizeEditableList(values: string[]): string[] {
  const normalized: string[] = [];
  for (const candidate of values) {
    const value = candidate.trim();
    if (!value || normalized.some((existing) => existing.toLowerCase() === value.toLowerCase())) continue;
    normalized.push(value);
  }
  return normalized;
}

/* The stored shape of `parsed_json.coursework`, from either wire shape. Defined in the engine
 * beside its reader so the write path and the read path cannot drift apart again (ISSUE-044);
 * re-exported here because the patch schema is the boundary that applies it. */
export function courseworkList(value: unknown): string[] {
  return courseworkFromParsed(value) ?? [];
}

/**
 * The value the DECLARED `profiles.skills` column takes for a given patch.
 *
 * A named function rather than an expression inline in the handler, because this is the single most
 * consequential line on this route and it needs to be reachable by a test. `profiles.skills` is read
 * with NO parsed fallback (routes/resume.ts, the resume generator's SKILLS line), so unlike
 * parsed_json it is never rewritten by a later upload: whatever lands here is permanent. The
 * handler used to normalize the raw patch list straight into it, which sorts nothing and therefore
 * promoted spoken languages into the permanent column the moment a student pressed Save.
 *
 * The obvious repair - guarding applyParsedProfilePatch and reading its result - leaves that
 * unguarded one-liner a plausible thing for a future edit to reach for, and a unit test of the
 * patch function cannot see the handler reach for it. So the guarded computation lives HERE, the
 * handler is one call, and parsedProfilePatch.test.ts asserts that the unguarded spelling appears
 * nowhere in this file.
 *
 * `stored` is returned untouched when the patch omits skills, because an omitted field is not an
 * instruction to clear a column.
 */
export function declaredSkillsForPatch(patch: ParsedProfilePatch, stored: unknown): unknown {
  if (patch.skills === undefined) return stored;
  return normalizeEditableList(splitSpokenLanguages(patch.skills).skills);
}

export function applyParsedProfilePatch(
  current: Record<string, unknown>,
  patch: ParsedProfilePatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  /* coursework is NOT in this loop. It is the one field on this schema whose wire shape is not its
   * stored shape - the transform above has already turned the screen's one line into a list - and
   * copying it through a loop named for plain strings is how it got stored as a string (ISSUE-044).
   * It is assigned below, with the other list-shaped fields, where it belongs. */
  for (const key of ['full_name', 'resume_email', 'phone', 'school', 'degree', 'grad_date', 'objective'] as const) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  /* Spoken languages are pulled back out of `skills` HERE as well as in the parser (ISSUE-020).
   *
   * Not belt and braces, and not a duplicate of that fix. The parser guard is SELF-HEALING: it runs
   * on parsed_json, which every resume upload rewrites wholesale, so a polluted parse repairs
   * itself on the next upload. This path is the opposite. `patch.skills` is also what the PATCH
   * /profile/parsed handler writes to the DECLARED profiles.skills column, and that column is read
   * with NO parsed fallback (routes/resume.ts, the resume generator's skills line), so a language
   * that lands in it is permanent - no re-upload, no re-parse and no later edit of the parse can
   * take it back out. The review screen sends `skills` on EVERY save with no change-gate, so a
   * student whose profile was parsed before ISSUE-020 shipped only has to open that screen and
   * click Save once to make the pollution permanent. That is why the second guard sits on the
   * promotion path rather than only on the parse.
   *
   * The recovered languages MOVE, they are not dropped. The student is looking at both boxes on
   * that screen and left the word in one of them, so deleting it is deleting their content; the
   * field it belongs in is the one the same form already edits. An explicit `languages` in the same
   * patch LEADS the union, exactly as the model's own answer leads on the parse path, because it is
   * the more direct statement of the same fact - and when the caller sent no `languages` at all,
   * the union starts from what is already stored, so a save that only touches skills cannot wipe a
   * language list the student set earlier. */
  const sorted = patch.skills === undefined ? null : splitSpokenLanguages(patch.skills);
  if (sorted) next.skills = normalizeEditableList(sorted.skills);
  if (patch.languages !== undefined) next.languages = normalizeEditableList(patch.languages);
  if (sorted && sorted.languages.length > 0) {
    /* Capped at the schema's own ceiling: this value comes back through parsedProfilePatchSchema on
     * the student's next save, and a stored list one entry over the limit is a 400 on our own data.
     *
     * THE TRADEOFF THIS SLICE MAKES, stated rather than hidden. Entries past the cap are DELETED,
     * not moved: they were already taken out of `skills` above, so a recovered language that falls
     * off the end of the union is gone from both fields. That is real data loss and it is chosen on
     * purpose. It needs a student who already has 30 stored languages, which the schema comment
     * calls a parse failure rather than a polyglot, and the only alternative is storing 31 and
     * 400ing every subsequent save of their whole profile. A truncated list the student can still
     * edit beats a profile they can no longer save. The declared list leads the union, so what
     * survives is always the student's own statement and never the reclassifier's guess. */
    next.languages = mergeLanguages(next.languages, sorted.languages).slice(0, MAX_EDITABLE_LANGUAGES);
  }
  if (patch.coursework !== undefined) next.coursework = patch.coursework;
  if (patch.target_roles !== undefined) next.target_roles = normalizeEditableList(patch.target_roles);

  if (patch.grad_date !== undefined) {
    const year = graduationYearFrom(patch.grad_date);
    if (year === undefined) delete next.grad_year;
    else next.grad_year = year;
  }
  return next;
}

/* Tokens that end in a period without ending a sentence. Without these, splitting on ". " turns
 * "ZymoGenetics, Inc. Executed a DNA fingerprinting project" into two bullets and cuts the employer
 * name in half. Degrees are here for the same reason resumes are full of them. */
const NON_TERMINAL_ABBREVIATIONS = new Set([
  'inc', 'ltd', 'llc', 'llp', 'corp', 'co', 'plc', 'gmbh',
  'dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'jr', 'sr',
  'vs', 'etc', 'approx', 'dept', 'univ', 'no', 'fig', 'est',
  'ph.d', 'm.s', 'b.s', 'b.a', 'm.a', 'm.b.a', 'u.s', 'u.k', 'e.g', 'i.e', 'a.m', 'p.m',
]);

/* One prose paragraph split back into the bullets a resume actually printed.
 *
 * WHY THIS EXISTS. The parser returns each role's `description` as prose - the resume's separate
 * bullet points run together into one string with no newlines - so splitting on newlines alone
 * produced exactly ONE variant per role, every time. Measured 2026-07-27 on a real 2-page CV: all
 * ten bank entries came back with a single bullet_variant, each one a run-on of three or four
 * distinct achievements.
 *
 * That quietly defeats the bank. Its whole point is one record per role holding every phrasing of
 * it, so /resume/generate has something to choose between; with one giant variant there is nothing
 * to choose. Worse, the grounding pass checks each generated bullet against these variants, and a
 * model that (correctly) wrote three bullets out of the blob had one of them pruned as unsupported
 * - a real achievement, off the student's own resume, dropped from their resume.
 *
 * Sentence splitting is CONSERVATIVE by design. A split that fires where it should not corrupts a
 * bullet, while one that fails to fire only leaves the old behaviour, so every ambiguous case is
 * resolved by not splitting: a period is a boundary only when the next character is a capital and
 * the word before it is neither an initial nor a known abbreviation.
 */
export function splitSentences(line: string): string[] {
  const pieces = line.split(/(?<=[.!?])\s+(?=[A-Z(])/);
  const out: string[] = [];
  for (const piece of pieces) {
    const previous = out[out.length - 1];
    if (previous !== undefined) {
      const tail = previous.replace(/[)\]"']+$/, '');
      const lastWord = tail.slice(0, -1).split(/[\s]/).pop()?.toLowerCase() ?? '';
      // "A." is an initial, not the end of a sentence. Abbreviations are the same case by list.
      const isInitial = /^\p{L}$/u.test(lastWord);
      if (tail.endsWith('.') && (isInitial || NON_TERMINAL_ABBREVIATIONS.has(lastWord))) {
        out[out.length - 1] = `${previous} ${piece}`;
        continue;
      }
    }
    out.push(piece);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

// A resume's description blob rendered as bullet variants. Resumes are written as bullets, and
// the bank's whole point is one record per role holding every phrasing of it, so a single
// newline-joined string collapses the structure /resume/generate exists to choose between.
// Falls back to the whole description when there is nothing to split on.
export function toBullets(description: string): string[] {
  const lines = description
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-•·*•]\s*/, '').trim())
    .filter((l) => l.length > 0);
  // Newlines are the reliable signal and are used whenever they are there. Sentences are the
  // fallback for the common case where the parse returned prose, and are applied per line so a
  // resume that gives us both structures keeps its own.
  const bullets = lines.flatMap((line) => splitSentences(line));
  if (bullets.length > 0) return bullets;
  return [description.trim()].filter((l) => l.length > 0);
}

// The student's DECLARED skills (profiles.skills), filtered to non-empty strings. Same filtering
// discipline as /resume/generate: the column is jsonb, so a hand-edited row can hold anything,
// and junk here would flow into prompts and validators as unmatchable entries. Returns [] for
// NULL/absent/malformed, which callers must treat as "never declared", not "has no skills".
export function declaredSkillsList(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).filter(
    (s): s is string => typeof s === 'string' && s.trim().length > 0,
  );
}

export function parsedTargetRolesForSeed(value: unknown): string[] {
  const roles: string[] = [];
  for (const candidate of Array.isArray(value) ? value : []) {
    if (typeof candidate !== 'string') continue;
    const role = candidate.trim().slice(0, 80).trim();
    if (!role || roles.some((existing) => existing.toLowerCase() === role.toLowerCase())) continue;
    roles.push(role);
    if (roles.length === 12) break;
  }
  return roles;
}

// What GET /profile serves (R-027). parsed_json is resume-INFERRED data; profiles.skills is the
// student's own DECLARED list and the one authoritative skills source (R-015). Before this, the
// served profile spread bare parsed_json, so every consumer downstream of GET /profile (outreach
// drafting via /draft's user_profile, the extension's profile cache) kept running on the inferred
// array even after the student declared their real list - two skills sources, disagreeing, in one
// profile, and the R-015 fix reached the resume only. A non-empty declared list now overrides
// parsed_json.skills; parsed_json stays the fallback so un-onboarded users (skills = NULL) are
// served exactly what they were before.
/* THE SOURCE OF TRUTH FOR THE ACADEMIC RECORD IS application_profile, NOT THIS PARSE.
 *
 * Two stores held the same real-world fact and nothing reconciled them. On a live account on
 * 2026-08-03 the parse said gpa "3.8" while application_profile said "3.89"; the resume printed
 * "GPA: 3.89/4.0", so the parse was simply wrong (fixed at the source in llm/parse.ts). The number
 * that reaches an employer comes from application_profile - the extension reads GET
 * /profile/application (adapters/grades.ts) and the managed runner reads the same row
 * (submissionRunner.ts) - so autofill was already correct. The parse was the wrong copy, and it was
 * the copy the dashboard displayed back to the student as her profile.
 *
 * That ordering is not an accident and is now enforced here rather than left implicit:
 *
 *   application_profile  - what the student typed, or what /profile/harvest watched her type into a
 *                          real employer form. A first-hand claim by the person it is about.
 *   parsed_json          - an LLM's reading of a PDF, seeded into the blanks of the above by
 *                          academicSeedFrom and never allowed to overwrite it.
 *
 * So an existing application_profile row is the whole answer for these three fields, including when
 * it is blank: blank there means "not on record", and the value autofill would send is nothing.
 * Serving the parse's number in that case would show the student a grade the product will never
 * use. Users with no row at all are untouched - there is no second value to contradict.
 *
 * This is a read-time override only. Nothing here is written back: PATCH /profile/education and
 * PATCH /profile/parsed both patch the STORED parsed_json and cannot address gpa, gpa_scale or
 * major, and the application-profile round-trip re-reads its own row.
 */
const ACADEMIC_FIELDS = ['gpa', 'gpa_scale', 'major'] as const;

export function academicsOfRecord(
  applicationRow: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!applicationRow) return {};
  const out: Record<string, unknown> = {};
  for (const field of ACADEMIC_FIELDS) {
    const value = applicationRow[field];
    out[field] = typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
  }
  return out;
}

export function serveProfileJson(
  parsedJson: unknown,
  declaredSkills: unknown,
  email?: string,
  // The decrypted application_profile row, when the student has one. Undefined means "no row",
  // which leaves the parse's academic fields exactly as they were.
  applicationRow?: Record<string, unknown>,
): Record<string, unknown> {
  const base = (parsedJson && typeof parsedJson === 'object' ? parsedJson : {}) as Record<string, unknown>;
  const declared = declaredSkillsList(declaredSkills);
  return {
    ...base,
    ...(declared.length > 0 ? { skills: declared } : {}),
    ...(email ? { email } : {}),
    ...(resumeEmailOfRecord(base) ? { resume_email: resumeEmailOfRecord(base) } : {}),
    ...academicsOfRecord(applicationRow),
  };
}

/* The application_profile row behind serveProfileJson's academic override, decrypted.
 *
 * gpa is in ENCRYPTED_FIELDS, so reading it can fail on a wrong or rotated ENCRYPTION_KEY. This
 * route does not 500 on that the way GET /profile/application does (R-021), because the caller here
 * wants a resume profile and a config problem with one field should not take the whole page down.
 * It returns a row with the academic fields blank instead, which suppresses the number rather than
 * falling back to the parse: falling back is what put a contradicting grade on the screen in the
 * first place. Nothing is written, so the ciphertext stays recoverable.
 */
async function applicationRowForProfile(
  userId: string,
  fastify: FastifyInstance,
): Promise<Record<string, unknown> | undefined> {
  // Tolerant read, see lib/applicationFacts.ts.
  const row = await selectApplicationProfileRow(userId);
  return academicRecordRowFor(row, (err) =>
    fastify.log.error(
      { err, userId },
      'application_profile could not be decrypted while serving the resume profile. Serving the academic record as blank rather than falling back to the resume parse, which is not the source of truth for it.',
    ),
  );
}

/* The same read, for callers that already hold the row.
 *
 * EXPORTED so the two resume-generation routes resolve the academic record through this exact
 * decrypt-and-degrade rule rather than each writing their own try/catch. There were three plausible
 * behaviours on a decrypt failure - throw, blank, fall back to the parse - and only one of them is
 * right; a second copy of the choice is a second chance to make it differently.
 *
 * Takes the row rather than a userId because /resume/base/stream already selects
 * application_profile for the ATS gate's contact lines, and a second query for a column it is
 * holding would be a round trip bought with nothing. */
export function academicRecordRowFor(
  row: ApplicationProfileRow | undefined,
  onDecryptError: (err: unknown) => void,
): Record<string, unknown> | undefined {
  if (!row) return undefined;
  try {
    return decryptRow(row) as Record<string, unknown>;
  } catch (err) {
    onDecryptError(err);
    return {};
  }
}

// ParsedProfile -> experience_bank rows.
//
// Nothing did this before, and that was a real break rather than a nicety: /resume/generate and
// /application/answer both hard-400 with "No experience bank found - complete onboarding first"
// when the bank is empty, and NO client ever called PUT /profile/experience-bank. So every
// account created through the web app looked set up and could not generate anything.
export function bankEntriesFrom(parsed: ParsedProfile, userId: string) {
  const jobs = (parsed.experience ?? [])
    .filter((e) => e.company?.trim())
    .map((e) => ({
      user_id: userId,
      type: 'job',
      org: e.company.trim(),
      title: e.title?.trim() || null,
      location: e.location?.trim() || null,
      date_range: [e.start, e.end].filter(Boolean).join(' - ') || null,
      bullet_variants: toBullets(e.description ?? ''),
      tags: [] as string[],
    }));
  const projects = (parsed.projects ?? [])
    .filter((p) => p.name?.trim())
    .map((p) => ({
      user_id: userId,
      type: 'project',
      org: p.name.trim(),
      title: p.role?.trim() || null,
      // Projects carry no location: a personal project has no workplace, and a resume does not
      // print one beside it.
      location: null,
      date_range: p.date_range?.trim() || null,
      bullet_variants: toBullets(p.description ?? ''),
      tags: [] as string[],
    }));
  const leadership = (parsed.leadership ?? [])
    .filter((entry) => entry.organization?.trim())
    .map((entry) => ({
      user_id: userId,
      type: 'leadership',
      org: entry.organization.trim(),
      title: entry.title?.trim() || null,
      location: entry.location?.trim() || null,
      date_range: [entry.start, entry.end].filter(Boolean).join(' - ') || null,
      bullet_variants: toBullets(entry.description ?? ''),
      tags: [] as string[],
    }));
  // bullet_variants is .notNull() and the PUT route requires min(1); an entry with no text is
  // not groundable anyway, so it is dropped rather than seeded as an empty shell.
  return [...jobs, ...projects, ...leadership].filter((e) => e.bullet_variants.length > 0);
}

/* A resume header printed in capitals is a typographic choice, not a name.
 *
 * Measured on a real University of Washington sample resume, 2026-07-27: the header reads
 * "MIRANDA W. HUDSON", so that is what was stored, and it is what the extension then types into an
 * employer's First name and Last name boxes. Nobody writes their own name in block capitals on an
 * application, and a form filled that way reads as machine-filled at a glance - which is the one
 * impression this product cannot afford to make.
 *
 * Recased ONLY when the whole string is uppercase. A name with any lowercase in it has already told
 * us how it wants to be written - "McDonald", "van der Berg", "DeShawn" - and touching those would
 * break names this rule exists to protect. Within an all-caps string the same care applies going the
 * other way: Mc/Mac prefixes, O', hyphens and the lowercase particles of a compound surname are all
 * handled, because "MCDONALD-O'BRIEN" must not come back as "Mcdonald-o'brien".
 */
const NAME_PARTICLES = new Set([
  'de', 'del', 'della', 'der', 'di', 'da', 'dos', 'du', 'la', 'le', 'van', 'von', 'bin', 'binte',
  'ibn', 'al', 'el', 'ter', 'ten',
]);

export function normalizeDisplayName(name: string): string {
  const trimmed = (name ?? '').trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return trimmed;
  // Any lowercase letter at all means the name is already cased deliberately. Leave it alone.
  if (/\p{Ll}/u.test(trimmed)) return trimmed;

  const capitalize = (word: string): string => {
    if (word.length === 0) return word;
    const lower = word.toLowerCase();
    // A particle keeps its lowercase form, but only in the middle of a name: "Van Der Berg" is
    // wrong, "van der Berg" is right, and a surname that STARTS a string stays capitalised.
    const cap = lower.charAt(0).toUpperCase() + lower.slice(1);
    // Mc/Mac and O' carry an internal capital that title-casing alone loses.
    if (/^mc[a-z]{2,}$/.test(lower)) return `Mc${lower.charAt(2).toUpperCase()}${lower.slice(3)}`;
    if (/^mac[a-z]{3,}$/.test(lower)) return `Mac${lower.charAt(3).toUpperCase()}${lower.slice(4)}`;
    if (/^o'[a-z]{2,}$/.test(lower)) return `O'${lower.charAt(2).toUpperCase()}${lower.slice(3)}`;
    return cap;
  };

  return trimmed
    .split(' ')
    .map((word, index) => {
      // A middle initial stays an initial: "W." must not become "W". (it already is) and must not
      // be lowercased.
      if (/^\p{Lu}\.?$/u.test(word)) return word;
      const lower = word.toLowerCase();
      if (index > 0 && NAME_PARTICLES.has(lower.replace(/\.$/, ''))) return lower;
      // Hyphenated and apostrophised names are two names wearing one token.
      return word
        .split('-')
        .map((part) => capitalize(part))
        .join('-');
    })
    .join(' ');
}

/* The academic record a resume STATES, ready for application_profile.
 *
 * /start's gaps screen (onboarding.ts GAP_FIELDS) asks for gpa, gpa_scale, major, languages and a
 * desired salary. Four of those genuinely cannot be read off a resume. Three of them can, and
 * before this nothing tried: the parser had no field for them, so the screen asked all six of
 * every student, including the ones whose upload printed "GPA: 3.75" and "Bachelor of Arts,
 * Psychology" two seconds earlier. Measured across 15 real resumes on 2026-07-27, 8 printed a GPA.
 *
 * Two rules, both load-bearing:
 *
 * 1. NEVER OVERWRITE. A value already on application_profile came from the student or from the
 *    harvest watching a real form, and both beat a parse of a PDF. This only fills blanks, so a
 *    re-upload can correct nothing and can also destroy nothing.
 * 2. gpa_scale is not defaulted. A bare "3.75" with no printed denominator stays a gap, because
 *    guessing 4.0 quietly restates an Indian 10.0 or German 5.0 record as a near-perfect one.
 */
export function academicSeedFrom(
  parsed: Pick<ParsedProfile, 'gpa' | 'gpa_scale' | 'major'>,
  existing: Record<string, unknown> | undefined,
): { gpa?: string; gpa_scale?: string; major?: string } {
  const seed: { gpa?: string; gpa_scale?: string; major?: string } = {};
  const held = (key: string) => {
    const v = existing?.[key];
    return typeof v === 'string' && v.trim().length > 0;
  };
  for (const key of ['gpa', 'gpa_scale', 'major'] as const) {
    const value = parsed[key];
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    if (held(key)) continue;
    // gpa is in ENCRYPTED_FIELDS; the other two are stored in the clear on purpose (see
    // applicationProfile.ts for why a scale and a major are not identity-sensitive).
    seed[key] = key === 'gpa' ? encryptField(value.trim()) : value.trim();
  }
  return seed;
}

interface ExistingBankEntry {
  id: string;
  type: string;
  org: string;
  title: string | null;
  date_range: string | null;
  location: string | null;
}

export function planBankReconciliation(
  parsed: ParsedProfile,
  userId: string,
  existing: ExistingBankEntry[],
) {
  const normalize = (value: string | null | undefined) =>
    (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const inserts: ReturnType<typeof bankEntriesFrom> = [];
  /* ENRICHMENT IS HOW AN EXISTING ROW EVER GAINS A NEW FIELD, and forgetting to list one here makes
     that field unreachable for everybody who already has a bank - which, for any field added after
     launch, is everybody. `location` shipped on the insert path only and was therefore dead on
     arrival: 135 real rows matched by org and took this branch, so no amount of re-uploading could
     have filled a single city in. */
  const enrichments: Array<{ id: string; title?: string; date_range?: string; location?: string }> = [];

  for (const candidate of bankEntriesFrom(parsed, userId)) {
    const candidateTitle = normalize(candidate.title);
    const match = existing.find((entry) => {
      if (entry.type !== candidate.type || normalize(entry.org) !== normalize(candidate.org)) return false;
      const existingTitle = normalize(entry.title);
      return !candidateTitle || !existingTitle || candidateTitle === existingTitle;
    });
    if (!match) {
      inserts.push(candidate);
      continue;
    }
    const enrichment: { id: string; title?: string; date_range?: string; location?: string } = { id: match.id };
    if (!match.title && candidate.title) enrichment.title = candidate.title;
    if (!match.date_range && candidate.date_range) enrichment.date_range = candidate.date_range;
    /* Fill-only, never overwrite, exactly like the two above. A stored location came off an earlier
       upload of the student's own resume; a later resume that omits the city is silence, not a
       correction, and silence must not erase a fact they already gave us. */
    if (!match.location && candidate.location) enrichment.location = candidate.location;
    if (enrichment.title || enrichment.date_range || enrichment.location) enrichments.push(enrichment);
  }

  return { inserts, enrichments };
}

export async function profileRoutes(fastify: FastifyInstance) {
  // POST /profile - upload resume + parse
  fastify.post('/profile', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    let resumeBuffer: Buffer | null = null;
    let resumeFilename: string | undefined;
    let resumeMimetype: string | undefined;
    let voice_pref: string | undefined;

    try {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'resume') {
          const resumePart = part as MultipartFile;
          resumeFilename = resumePart.filename;
          resumeMimetype = resumePart.mimetype;
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk);
          }
          resumeBuffer = Buffer.concat(chunks);
        } else if (part.type === 'field' && part.fieldname === 'voice_pref') {
          voice_pref = part.value as string;
        }
      }
    } catch (err) {
      fastify.log.error(err);
      return reply.status(400).send({ error: 'Failed to parse multipart form data' });
    }

    if (!resumeBuffer || resumeBuffer.length === 0) {
      return reply.status(400).send({ error: 'resume file is required' });
    }

    let sourceFormat: ResumeSourceFormat;
    try {
      sourceFormat = inspectResumeUpload(resumeBuffer, {
        filename: resumeFilename,
        mimetype: resumeMimetype,
      });
    } catch (err) {
      fastify.log.info({ err, resumeFilename, resumeMimetype }, 'rejected unsupported resume upload');
      const message = err instanceof ResumeUploadError
        ? err.message
        : 'Unsupported resume file type. Upload a PDF or DOCX file.';
      return reply.status(400).send({ error: message });
    }

    let resumeText: string;
    // The uploaded file's real page count. Measured here and nowhere else: the buffer is gone by
    // the time anything downstream runs, so a page count not captured now can only ever be guessed
    // at later. /start's base-resume screen states it back to the student ("3 pages, one page"), so
    // it has to be a measurement rather than an assumption.
    let sourcePages = 0;
    try {
      // extractPdfText, not bare pdfParse: a small uploaded PDF concat-assembled from multipart
      // chunks lands in Node's shared buffer pool, where pdf-parse's byteOffset bug (R-017, see
      // lib/pdfText.ts) rejects a perfectly valid file as "bad XRef entry" - which here would
      // 400 a student's real resume at signup.
      if (sourceFormat === 'pdf') {
        const parsed = await extractPdfText(resumeBuffer);
        resumeText = parsed.text;
        sourcePages = parsed.numpages;
      } else {
        resumeText = await extractDocxText(resumeBuffer);
      }
    } catch (err) {
      fastify.log.error(err);
      const error = err instanceof ResumeUploadError
        ? err.message
        : sourceFormat === 'pdf'
          ? 'Failed to parse PDF. Ensure the file is a valid PDF and try again.'
          : 'Failed to parse DOCX. Ensure the file is a valid Word document and try again.';
      return reply.status(400).send({ error });
    }

    /* A scanned resume extracts as a trickle of text, not as nothing, so a flat 50-character floor
     * waves it through. Measured 2026-07-27 on a real 2-page CV: 623 characters extracted, the
     * parse came back with an empty name, empty school and zero experience, and the account was
     * left in a state where the base resume hard-400s and onboarding cannot advance.
     *
     * Scaling by page count is what distinguishes the two cases: a genuine one-page resume runs
     * 2,500-4,000 characters (measured across five real resumes), so 700 per page is far below any
     * real document and far above the handful of characters a scan yields.
     *
     * Below the floor we do NOT reject. Rejecting was the first fix and it was the wrong one: it
     * told the student to go and re-export a file they may not have the source for, and locked out
     * anyone whose only copy of their resume is a scan or a phone photo. Two of eight real resumes
     * tested were image-only. We read those pages visually instead. */
    const minimumChars = Math.max(50, 700 * Math.max(1, sourcePages));
    const looksScanned = sourceFormat === 'pdf' && (!resumeText || resumeText.trim().length < minimumChars);

    /* THE ADDRESS AN EMPLOYER REPLIES TO, resolved BEFORE the parse try below and deliberately
     * outside it.
     *
     * `resume_email` is read by the base resume, the tailored resume, the packet audit and the
     * academic-email answer, and NOTHING wrote it: the parser extracts no email at all
     * (llm/parse.ts has no email field), so its only source was a text box under "Edit parsed
     * details" in Documents, which onboarding never mentions. Measured 2026-08-16: 16 of 17
     * production profiles had none, which is what made the base resume's ATS gate refuse nearly
     * every account with "Add a personal resume email to your profile".
     *
     * OUTSIDE THE TRY, because that catch attributes everything it sees to the model. A database
     * read that failed in there would be reported to the student as "Failed to parse resume with
     * AI" on a parse that actually succeeded, which is the same wrong-blame defect the 503 twenty
     * lines down exists to fix. A failure here reaches the global error boundary instead, which
     * says "Internal server error" and claims nothing about their file.
     *
     * PRESERVE BEATS SEED. parsed_json is replaced WHOLESALE by each upload, so an address the
     * student typed themselves was being destroyed by their next re-upload. Their value wins; the
     * verified login email is only the default under it. See lib/resumeEmail.ts. */
    const [existingProfile] = await db
      .select({ parsed_json: profiles.parsed_json })
      .from(profiles)
      .where(eq(profiles.user_id, userId))
      .limit(1);
    const resumeEmail = resumeEmailForUpload(existingProfile?.parsed_json, request.jwtPayload!.email);

    // Annotated rather than inferred: an evolving `let` takes its type from every later use, so the
    // narrow Pick that academicSeedFrom accepts would otherwise become this variable's type and
    // reject the source_pages stamp two lines down.
    let parsedProfile: ParsedProfile;
    try {
      parsedProfile = looksScanned
        ? await parseResumeFromPdf(resumeBuffer)
        : await parseResumeWithClaude(resumeText);
      // Carried on the parse rather than in its own column: it is a fact ABOUT this parse of this
      // file, so it should be replaced wholesale when a student re-uploads, which is exactly what
      // parsed_json already does.
      parsedProfile = {
        ...parsedProfile,
        full_name: normalizeDisplayName(parsedProfile.full_name ?? ''),
        ...(resumeEmail ? { resume_email: resumeEmail } : {}),
        ...(sourcePages > 0 ? { source_pages: sourcePages } : {}),
      };
    } catch (err) {
      fastify.log.error(err);
      /* THE MODEL BEING UNAVAILABLE IS NOT A VERDICT ON THE UPLOAD.
       *
       * On 2026-08-15 the Anthropic balance ran out and every upload got "Failed to parse resume
       * with AI" printed above a Choose a file button. Everything on that screen said the resume
       * was at fault, so the student's only move was to go looking for a file that would work, and
       * none would have. A 503 that names our side, plus a code the client can act on, is the
       * difference between "come back shortly" and "your resume is broken". See lib/llmFailure.ts. */
      if (isModelUnavailable(err)) {
        return reply.status(503).send({
          error: MODEL_UNAVAILABLE_MESSAGE,
          code: MODEL_UNAVAILABLE_CODE,
        });
      }
      return reply.status(500).send({ error: 'Failed to parse resume with AI' });
    }

    /* Vision can fail on a genuinely unreadable page - a photo too blurry to transcribe, a blank
     * scan. Say so specifically instead of letting the student through to an account with no name
     * and no experience, which is the dead end this whole branch exists to prevent. Checked only
     * on the scanned path: a text resume that parses to nothing is a different problem, already
     * surfaced by the bank_seeded warning on /start. */
    if (looksScanned && !parsedProfile.full_name?.trim() && (parsedProfile.experience ?? []).length === 0) {
      return reply.status(400).send({
        error:
          'That looks like a scan, and we could not make out the text on the page. A clearer scan or photo usually works. If you have the original in Word, Google Docs or Overleaf, exporting a PDF from there will always read cleanly.',
      });
    }

    try {
      await db
        .insert(profiles)
        .values({
          user_id: userId,
          parsed_json: parsedProfile,
          // The uploaded bytes are parsing input, not account storage. A new row starts with no
          // pointers. Conflict updates omit these fields until legacy Blob deletion succeeds.
          resume_object_key: null,
          resume_url: null,
          voice_pref: voice_pref ?? null,
          updated_at: new Date(),
        })
        .onConflictDoUpdate({
          target: profiles.user_id,
          set: {
            parsed_json: parsedProfile,
            voice_pref: voice_pref ?? null,
            updated_at: new Date(),
          },
        });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to save profile to database' });
    }

    // Replacement must not strand the previous raw upload. Keep its legacy DB pointers until Blob
    // deletion succeeds, then clear them. A failure leaves a recoverable pointer and the daily
    // sweep retries the same delete-then-clear order. The new upload itself is never stored.
    try {
      await deleteUploadedResumeThenClear(
        () => deleteUploadedResumeBlobsForUser(userId),
        () => db
          .update(profiles)
          .set({ resume_object_key: null, resume_url: null })
          .where(eq(profiles.user_id, userId)),
      );
    } catch (err) {
      fastify.log.warn({ err, userId }, 'could not retire legacy uploaded resume; retention sweep will retry');
    }

    // Compatibility bridge for clients that saved category and role type before uploading their
    // resume. The new state machine requires titles too, and an old cached client has no title
    // field to send. Seed only an absent or empty list from the parse, never overwrite titles the
    // applicant already chose. New clients immediately show the focus step and can replace this
    // seed with their confirmed selection.
    const parsedTargetRoles = parsedTargetRolesForSeed(parsedProfile.target_roles);
    if (parsedTargetRoles.length > 0) {
      try {
        const encodedRoles = JSON.stringify(parsedTargetRoles);
        await db
          .insert(targeting)
          .values({ user_id: userId, titles: parsedTargetRoles, updated_at: new Date() })
          .onConflictDoUpdate({
            target: targeting.user_id,
            set: {
              titles: sql`case
                when ${targeting.titles} is null or jsonb_array_length(${targeting.titles}) = 0
                then ${encodedRoles}::jsonb
                else ${targeting.titles}
              end`,
              updated_at: new Date(),
            },
          });
      } catch (err) {
        fastify.log.warn({ err, userId }, 'could not seed targeting titles from resume parse');
      }
    }

    // Reconcile the parse into the experience bank without replacing anything the student edited.
    // New roles are inserted, and blank title/date metadata may be filled. Existing bullets,
    // titles, and dates are never overwritten.
    let bank_seeded = 0;
    let bank_enriched = 0;
    let bank_total = 0;
    let recentReview: RecentExperienceReview | null = null;
    try {
      const existing = await db
        .select({
          id: experience_bank.id,
          type: experience_bank.type,
          org: experience_bank.org,
          title: experience_bank.title,
          date_range: experience_bank.date_range,
          location: experience_bank.location,
        })
        .from(experience_bank)
        .where(eq(experience_bank.user_id, userId));
      const reconciliation = planBankReconciliation(parsedProfile, userId, existing);
      if (reconciliation.inserts.length > 0) {
        await db.insert(experience_bank).values(reconciliation.inserts);
        bank_seeded = reconciliation.inserts.length;
      }
      bank_total = existing.length + bank_seeded;
      for (const enrichment of reconciliation.enrichments) {
        const values = {
          ...(enrichment.title ? { title: enrichment.title } : {}),
          ...(enrichment.date_range ? { date_range: enrichment.date_range } : {}),
          ...(enrichment.location ? { location: enrichment.location } : {}),
        };
        await db.update(experience_bank).set(values).where(eq(experience_bank.id, enrichment.id));
        bank_enriched += 1;
      }
      const bank = await db.select().from(experience_bank).where(eq(experience_bank.user_id, userId));
      recentReview = buildRecentExperienceReview(bank as RecentExperienceEntry[]);
      parsedProfile = { ...parsedProfile, recent_experience_review: recentReview };
      await db
        .update(profiles)
        .set({ parsed_json: parsedProfile, updated_at: new Date() })
        .where(eq(profiles.user_id, userId));
    } catch (err) {
      fastify.log.error({ err, userId }, 'failed to seed experience bank from resume parse'); // vocab-allow: server log
      return reply.status(500).send({ error: 'Failed to prepare the recent experience review' });
    }

    // Fill the academic gaps the upload already answered. Best-effort and non-fatal: the parse is
    // what the student came for, and a failure here costs one extra question rather than signup.
    let gaps_prefilled: string[] = [];
    let seedRowExists = false;
    try {
      const existing = await selectApplicationProfileRow(userId);
      seedRowExists = Boolean(existing);
      const seed = academicSeedFrom(parsedProfile, existing as Record<string, unknown> | undefined);
      if (Object.keys(seed).length > 0) {
        await db
          .insert(application_profile)
          .values({ user_id: userId, ...seed })
          .onConflictDoUpdate({ target: application_profile.user_id, set: seed });
        gaps_prefilled = Object.keys(seed);
        seedRowExists = true;
      }
    } catch (err) {
      fastify.log.warn({ err, userId }, 'could not prefill academic fields from resume parse');
    }

    /* The academic record as it stands AFTER seeding, so this response states the same gpa, scale
     * and major that GET /profile will serve and that autofill will type. Without it a re-upload
     * answers with the parse's own numbers, which is the contradiction the seed rule (never
     * overwrite) creates by design: a held value wins in the database and loses in the reply.
     *
     * Read in its own try, NOT inside the seeding one above. Sharing that catch meant a failed read
     * left this undefined, which serves the parse's numbers - the precise fallback the other three
     * serving sites refuse to make. A row that is known to exist but could not be read resolves to
     * {} instead, which blanks the three fields rather than stating a number nothing will use. */
    let academicRecord: Record<string, unknown> | undefined;
    try {
      academicRecord = await applicationRowForProfile(userId, fastify);
    } catch (err) {
      fastify.log.warn({ err, userId }, 'could not read the academic record back after seeding');
      academicRecord = seedRowExists ? {} : undefined;
    }

    return reply.status(200).send({
      ...parsedProfile,
      ...academicsOfRecord(academicRecord),
      bank_seeded,
      bank_total,
      bank_enriched,
      gaps_prefilled,
      recent_experience_review: recentReview,
    });
  });

  fastify.get('/profile/recent-experience', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const [[profile], entries] = await Promise.all([
      db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1),
      db.select().from(experience_bank).where(eq(experience_bank.user_id, userId)),
    ]);
    if (!profile) return reply.status(404).send({ error: 'Profile not found - upload a resume first' });
    const stored = reviewFromProfile(profile.parsed_json);
    const review = stored ?? buildRecentExperienceReview(entries as RecentExperienceEntry[]);
    return reply.status(200).send(reviewPayload(entries as RecentExperienceEntry[], review));
  });

  fastify.put('/profile/recent-experience', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const body = recentExperiencePatchSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'Invalid recent experience review' });

    try {
      const result = await db.transaction(async (tx) => {
        const [profile] = await tx.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1);
        if (!profile) return { error: 'profile' as const };
        // Serialize updates to this one bank row so a double click or request retry cannot read the
        // same old bullet array twice and silently discard the first accepted enrichment.
        await tx.execute(sql`select id from ${experience_bank}
          where ${experience_bank.id} = ${body.data.selected_entry_id}
          and ${experience_bank.user_id} = ${userId}
          for update`);
        const entries = await tx.select().from(experience_bank).where(eq(experience_bank.user_id, userId));
        const selected = entries.find((entry) => entry.id === body.data.selected_entry_id);
        if (!selected) return { error: 'entry' as const };

        const existing = (Array.isArray(selected.bullet_variants) ? selected.bullet_variants : [])
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
        const applied = applyImpactAnswers(existing, body.data.answers as ImpactAnswerSet[]);
        if ('error' in applied) return { error: applied.error };
        const { additions, bullets } = applied;
        if (additions.length > 0) {
          await tx.update(experience_bank).set({ bullet_variants: bullets }).where(eq(experience_bank.id, selected.id));
        }
        const assessment = assessImpactBullet(bullets);
        const review: RecentExperienceReview = {
          status: body.data.continue_with_found ? 'continued' : assessment.score < 4 || bullets.length < 3 ? 'optional_enrichment' : 'ready',
          selected_entry_id: selected.id,
          user_selected: reviewFromProfile(profile.parsed_json)?.selected_entry_id !== selected.id,
          impact_candidate: assessment,
          grounded_bullet_count: bullets.length,
          missing_bullets: Math.max(0, 3 - bullets.length),
          completed: body.data.continue_with_found || (assessment.score === 4 && bullets.length >= 3),
          continue_with_found: body.data.continue_with_found,
        };
        const parsed = (profile.parsed_json ?? {}) as Record<string, unknown>;
        await tx.update(profiles).set({
          parsed_json: { ...parsed, recent_experience_review: review },
          updated_at: new Date(),
        }).where(eq(profiles.user_id, userId));
        const nextEntries = entries.map((entry) => entry.id === selected.id ? { ...entry, bullet_variants: bullets } : entry);
        return { review, entries: nextEntries as RecentExperienceEntry[] };
      });
      if ('error' in result) {
        if (result.error === 'profile') return reply.status(404).send({ error: 'Profile not found - upload a resume first' });
        if (result.error === 'entry') return reply.status(404).send({ error: 'Experience does not belong to this upload' });
        /* Two different refusals, because they are two different problems for the student to fix.
           'unreadable' means the answer folded down to nothing this pipeline can read as a bullet:
           the resume is built against an ASCII verb whitelist, so an answer with no Latin letters
           has no opener to judge at all. Telling that student to pick a stronger verb sends them
           to edit a word that is not the reason.

           The message names BOTH exits, because this refusal also blocks "Continue with what you
           found." A student who cannot rewrite the answer is otherwise held on the screen with no
           stated way off it, and clearing the field is the way off it. */
        if (result.error === 'unreadable') {
          return reply.status(400).send({
            error: 'Write this answer in English so it can go on your resume, or clear it to continue',
          });
        }
        return reply.status(400).send({ error: 'Each new bullet must start with a strong action verb' });
      }
      return reply.status(200).send(reviewPayload(result.entries, result.review));
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to save recent experience review' });
    }
  });

  // GET /profile - retrieve user profile
  fastify.get('/profile', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    try {
      const profile = await db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1);

      if (profile.length === 0) {
        return reply.status(404).send({ error: 'Profile not found - upload a resume first' });
      }

      // parsed_json is resume-extracted data and was never guaranteed to carry an email (most
      // resumes don't put one in a parseable spot); the account's verified login email is a
      // more reliable source and autofill (Lever/Greenhouse/etc.) needs one to fill the email
      // field at all - confirmed missing on every live-tested application until this fix.
      // Skills come from serveProfileJson: declared list first, parsed_json as fallback (R-027).
      // The academic record comes from application_profile, which is the store autofill actually
      // types from - see the source-of-truth note on serveProfileJson.
      const applicationRow = await applicationRowForProfile(userId, fastify);
      return reply.status(200).send(
        serveProfileJson(profile[0].parsed_json, profile[0].skills, request.jwtPayload!.email, applicationRow),
      );
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to retrieve profile' });
    }
  });

  // PATCH /profile/education - correct a mis-parsed education block (R-052).
  //
  // These four fields were previously write-once at resume-upload time and read-only everywhere
  // else, so a single wrong word could only be fixed by producing an entirely new PDF. That is what
  // made R-047 unfixable from inside the product: the parser dropped "Computer Science &" from a
  // joint degree, and there was no way to put it back. Deliberately narrow: it touches only the
  // education keys and cannot reach experience, skills or any encrypted application field.
  fastify.patch('/profile/education', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const parsed = educationPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid education patch', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const rows = await db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1);
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Profile not found - upload a resume first' });
      }

      const current = (rows[0].parsed_json ?? {}) as Record<string, unknown>;
      const next = applyParsedProfilePatch(current, parsed.data);

      await db.update(profiles).set({ parsed_json: next, updated_at: new Date() }).where(eq(profiles.user_id, userId));
      const applicationRow = await applicationRowForProfile(userId, fastify);
      return reply.status(200).send(serveProfileJson(next, rows[0].skills, request.jwtPayload!.email, applicationRow));
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to update education' });
    }
  });

  // PATCH /profile/parsed - review and correct the safe, user-owned portion of an AI parse.
  fastify.patch('/profile/parsed', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const parsed = parsedProfilePatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid profile changes', details: parsed.error.flatten().fieldErrors });
    }

    try {
      // Read outside the transaction on purpose: this patch cannot touch the academic fields (they
      // are not in parsedProfilePatchSchema), so the row it overrides with is the same row before
      // and after, and holding the transaction open for it would buy nothing.
      const applicationRow = await applicationRowForProfile(userId, fastify);
      const result = await db.transaction(async (tx) => {
        const rows = await tx.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1);
        if (rows.length === 0) return null;

        const patch = parsed.data;
        const current = (rows[0].parsed_json ?? {}) as Record<string, unknown>;
        const next = applyParsedProfilePatch(current, patch);
        // One call, deliberately. Computing this inline is how the unguarded promotion got here in
        // the first place: profiles.skills is the write no re-upload can repair, so the decision
        // belongs in a function a test can reach rather than in an expression only prod exercises.
        const skills = declaredSkillsForPatch(patch, rows[0].skills);

        await tx
          .update(profiles)
          .set({ parsed_json: next, skills, updated_at: new Date() })
          .where(eq(profiles.user_id, userId));

        if (patch.target_roles !== undefined) {
          const titles = normalizeEditableList(patch.target_roles);
          await tx
            .insert(targeting)
            .values({ user_id: userId, titles, updated_at: new Date() })
            .onConflictDoUpdate({
              target: targeting.user_id,
              set: { titles, updated_at: new Date() },
            });
        }

        return serveProfileJson(next, skills, request.jwtPayload!.email, applicationRow);
      });

      if (!result) return reply.status(404).send({ error: 'Profile not found - upload a resume first' });
      return reply.status(200).send(result);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to update profile' });
    }
  });
}
