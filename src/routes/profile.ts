import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/index';
import { profiles, experience_bank } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { parseResumeWithClaude, ParsedProfile } from '../llm/parse';
import { extractPdfText } from '../lib/pdfText';
import { put } from '@vercel/blob';
import { MultipartFile } from '@fastify/multipart';

// A resume's description blob rendered as bullet variants. Resumes are written as bullets, and
// the bank's whole point is one record per role holding every phrasing of it, so a single
// newline-joined string collapses the structure /resume/generate exists to choose between.
// Falls back to the whole description when there is nothing to split on.
export function toBullets(description: string): string[] {
  const lines = description
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-•·*•]\s*/, '').trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 ? lines : [description.trim()].filter((l) => l.length > 0);
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

// What GET /profile serves (R-027). parsed_json is resume-INFERRED data; profiles.skills is the
// student's own DECLARED list and the one authoritative skills source (R-015). Before this, the
// served profile spread bare parsed_json, so every consumer downstream of GET /profile (outreach
// drafting via /draft's user_profile, the extension's profile cache) kept running on the inferred
// array even after the student declared their real list - two skills sources, disagreeing, in one
// profile, and the R-015 fix reached the resume only. A non-empty declared list now overrides
// parsed_json.skills; parsed_json stays the fallback so un-onboarded users (skills = NULL) are
// served exactly what they were before.
export function serveProfileJson(parsedJson: unknown, declaredSkills: unknown, email: string): Record<string, unknown> {
  const base = (parsedJson && typeof parsedJson === 'object' ? parsedJson : {}) as Record<string, unknown>;
  const declared = declaredSkillsList(declaredSkills);
  return { ...base, ...(declared.length > 0 ? { skills: declared } : {}), email };
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
      title: null,
      date_range: null,
      bullet_variants: toBullets(p.description ?? ''),
      tags: [] as string[],
    }));
  // bullet_variants is .notNull() and the PUT route requires min(1); an entry with no text is
  // not groundable anyway, so it is dropped rather than seeded as an empty shell.
  return [...jobs, ...projects].filter((e) => e.bullet_variants.length > 0);
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
    try {
      // extractPdfText, not bare pdfParse: a small uploaded PDF concat-assembled from multipart
      // chunks lands in Node's shared buffer pool, where pdf-parse's byteOffset bug (R-017, see
      // lib/pdfText.ts) rejects a perfectly valid file as "bad XRef entry" - which here would
      // 400 a student's real resume at signup.
      const parsed = await extractPdfText(resumeBuffer);
      resumeText = parsed.text;
    } catch (err) {
      fastify.log.error(err);
      return reply.status(400).send({ error: 'Failed to parse PDF - ensure the file is a valid PDF' });
    }

    if (!resumeText || resumeText.trim().length < 50) {
      return reply.status(400).send({ error: 'PDF appears to be empty or could not be parsed' });
    }

    let parsedProfile;
    try {
      parsedProfile = await parseResumeWithClaude(resumeText);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to parse resume with AI' });
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

    // Seed the experience bank from the parse - but ONLY when it is empty.
    //
    // Seed-if-empty rather than replace: PUT /profile/experience-bank is a full delete-and-insert,
    // so re-seeding on every upload would silently destroy any bullet variants the student added
    // by hand the moment they swapped in a new resume version. The bank is meant to ACCUMULATE
    // phrasings across resume versions (that is why bullet_variants is a pool), and blowing it
    // away on re-upload would defeat the one thing it exists to do.
    let bank_seeded = 0;
    try {
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(experience_bank)
        .where(eq(experience_bank.user_id, userId));
      if (n === 0) {
        const entries = bankEntriesFrom(parsedProfile, userId);
        if (entries.length > 0) {
          await db.insert(experience_bank).values(entries);
          bank_seeded = entries.length;
        }
      }
    } catch (err) {
      // Loud: an account whose bank stayed empty cannot generate a resume or draft an answer,
      // which is exactly the silent-broken-account failure this seeding exists to end.
      fastify.log.error({ err, userId }, 'failed to seed experience bank from resume parse');
    }

    return reply.status(200).send({ ...parsedProfile, bank_seeded });
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
}
