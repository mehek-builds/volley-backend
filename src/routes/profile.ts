import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/index';
import { profiles, experience_bank, application_profile, targeting } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { encryptField } from '../lib/fieldCrypto';
import { parseResumeWithClaude, parseResumeFromPdf, ParsedProfile } from '../llm/parse';
import { extractPdfText } from '../lib/pdfText';
import { put } from '@vercel/blob';
import { MultipartFile } from '@fastify/multipart';
import { z } from 'zod';

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

// The resume review screen is the student's correction layer over an AI parse. Keep this bounded
// to profile facts that are safe to edit as plain text. Work history has its own structured bank,
// and account email comes from the verified login, so neither can be changed through this route.
export const parsedProfilePatchSchema = z
  .object({
    full_name: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().max(40).optional(),
    school: z.string().trim().min(1).max(200).optional(),
    degree: z.string().trim().max(200).optional(),
    grad_date: z.string().trim().max(40).optional(),
    objective: z.string().trim().max(1200).optional(),
    skills: z.array(editableListItem).max(100).optional(),
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

export function normalizeEditableList(values: string[]): string[] {
  const normalized: string[] = [];
  for (const candidate of values) {
    const value = candidate.trim();
    if (!value || normalized.some((existing) => existing.toLowerCase() === value.toLowerCase())) continue;
    normalized.push(value);
  }
  return normalized;
}

export function applyParsedProfilePatch(
  current: Record<string, unknown>,
  patch: ParsedProfilePatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const key of ['full_name', 'phone', 'school', 'degree', 'grad_date', 'objective'] as const) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (patch.skills !== undefined) next.skills = normalizeEditableList(patch.skills);
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
export function serveProfileJson(parsedJson: unknown, declaredSkills: unknown, email?: string): Record<string, unknown> {
  const base = (parsedJson && typeof parsedJson === 'object' ? parsedJson : {}) as Record<string, unknown>;
  const declared = declaredSkillsList(declaredSkills);
  return { ...base, ...(declared.length > 0 ? { skills: declared } : {}), ...(email ? { email } : {}) };
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
}

export function planBankReconciliation(
  parsed: ParsedProfile,
  userId: string,
  existing: ExistingBankEntry[],
) {
  const normalize = (value: string | null | undefined) =>
    (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const inserts: ReturnType<typeof bankEntriesFrom> = [];
  const enrichments: Array<{ id: string; title?: string; date_range?: string }> = [];

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
    const enrichment: { id: string; title?: string; date_range?: string } = { id: match.id };
    if (!match.title && candidate.title) enrichment.title = candidate.title;
    if (!match.date_range && candidate.date_range) enrichment.date_range = candidate.date_range;
    if (enrichment.title || enrichment.date_range) enrichments.push(enrichment);
  }

  return { inserts, enrichments };
}

export async function profileRoutes(fastify: FastifyInstance) {
  // POST /profile - upload resume + parse
  fastify.post('/profile', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    let resumeBuffer: Buffer | null = null;
    let voice_pref: string | undefined;

    try {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'resume') {
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
      const parsed = await extractPdfText(resumeBuffer);
      resumeText = parsed.text;
      sourcePages = parsed.numpages;
    } catch (err) {
      fastify.log.error(err);
      return reply.status(400).send({ error: 'Failed to parse PDF - ensure the file is a valid PDF' });
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
    const looksScanned = !resumeText || resumeText.trim().length < minimumChars;

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
        source_pages: sourcePages,
      };
    } catch (err) {
      fastify.log.error(err);
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

    const resumeObjectKey = `users/${userId}/resume.pdf`;

    // Actually store the file this time. Best-effort on purpose: the parse above is what the
    // student came for, and a blob outage (or a missing BLOB_READ_WRITE_TOKEN in local dev)
    // must not fail their signup. resume_url stays NULL and everything else still works.
    let resumeUrl: string | null = null;
    try {
      const blob = await put(resumeObjectKey, resumeBuffer, {
        access: 'public',
        contentType: 'application/pdf',
      });
      resumeUrl = blob.url;
    } catch (err) {
      fastify.log.warn({ err }, 'could not store original resume; continuing with the parse');
    }

    try {
      await db
        .insert(profiles)
        .values({
          user_id: userId,
          parsed_json: parsedProfile,
          resume_object_key: resumeObjectKey,
          resume_url: resumeUrl,
          voice_pref: voice_pref ?? null,
          updated_at: new Date(),
        })
        .onConflictDoUpdate({
          target: profiles.user_id,
          set: {
            parsed_json: parsedProfile,
            resume_object_key: resumeObjectKey,
            // Don't null out a previously stored file just because this upload failed.
            ...(resumeUrl ? { resume_url: resumeUrl } : {}),
            voice_pref: voice_pref ?? null,
            updated_at: new Date(),
          },
        });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to save profile to database' });
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
    try {
      const existing = await db
        .select({
          id: experience_bank.id,
          type: experience_bank.type,
          org: experience_bank.org,
          title: experience_bank.title,
          date_range: experience_bank.date_range,
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
        };
        await db.update(experience_bank).set(values).where(eq(experience_bank.id, enrichment.id));
        bank_enriched += 1;
      }
    } catch (err) {
      // Loud: an account whose bank stayed empty cannot generate a resume or draft an answer,
      // which is exactly the silent-broken-account failure this seeding exists to end.
      fastify.log.error({ err, userId }, 'failed to seed experience bank from resume parse'); // vocab-allow: server log
    }

    // Fill the academic gaps the upload already answered. Best-effort and non-fatal for the same
    // reason the blob write is: the parse is what the student came for, and a failure here costs
    // them one extra question rather than their signup.
    let gaps_prefilled: string[] = [];
    try {
      const [existing] = await db
        .select()
        .from(application_profile)
        .where(eq(application_profile.user_id, userId));
      const seed = academicSeedFrom(parsedProfile, existing as Record<string, unknown> | undefined);
      if (Object.keys(seed).length > 0) {
        await db
          .insert(application_profile)
          .values({ user_id: userId, ...seed })
          .onConflictDoUpdate({ target: application_profile.user_id, set: seed });
        gaps_prefilled = Object.keys(seed);
      }
    } catch (err) {
      fastify.log.warn({ err, userId }, 'could not prefill academic fields from resume parse');
    }

    return reply.status(200).send({ ...parsedProfile, bank_seeded, bank_total, bank_enriched, gaps_prefilled });
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
      return reply.status(200).send(serveProfileJson(profile[0].parsed_json, profile[0].skills, request.jwtPayload!.email));
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
      return reply.status(200).send(serveProfileJson(next, rows[0].skills, request.jwtPayload!.email));
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
      const result = await db.transaction(async (tx) => {
        const rows = await tx.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1);
        if (rows.length === 0) return null;

        const patch = parsed.data;
        const current = (rows[0].parsed_json ?? {}) as Record<string, unknown>;
        const next = applyParsedProfilePatch(current, patch);
        const skills = patch.skills === undefined ? rows[0].skills : normalizeEditableList(patch.skills);

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

        return serveProfileJson(next, skills, request.jwtPayload!.email);
      });

      if (!result) return reply.status(404).send({ error: 'Profile not found - upload a resume first' });
      return reply.status(200).send(result);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to update profile' });
    }
  });
}
