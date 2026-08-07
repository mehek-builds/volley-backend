import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { application_profile, users } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { encryptField, decryptField } from '../lib/fieldCrypto';
import { ENCRYPTED_FIELDS } from './applicationProfile';
import { selectApplicationProfileRow, type ApplicationProfileRow } from '../lib/applicationFacts';

// POST /profile/harvest
//
// During onboarding the student fills ONE real application by hand on a real ATS. The extension
// watches trusted input events and posts what they typed here, so they never type it again. This
// is the only write path in the system whose input is "something we observed" rather than
// "something the student told us directly", so it is deliberately the most restricted one.
//
// Three rules, all enforced here rather than only in the extension. The extension is the thing
// most likely to have the bug - it runs against DOM it does not control, on five ATSes - so the
// server does not trust it:
//
//   1. DENYLIST (hard 400). Work authorization, sponsorship, and EEO are never storable from a
//      harvest, at any time, for any reason. See DENIED below.
//   2. FILL-IF-EMPTY. Harvest may only populate a field that is currently unset. It can never
//      overwrite a value the student typed into Settings or confirmed on a previous screen.
//      Mirrors the adapters' own `if (el.value) continue` invariant, one layer down.
//   3. ONBOARDING-ONLY. Rejected once users.onboarding_completed_at is set. "We watch the first
//      one so you never type it again" is the bargain the student agreed to; silently watching
//      every application forever is a different bargain they did not.

// Never storable from an observed form value.
//
// work_authorized / needs_sponsorship: the profile holds ONE global flag but every real form asks
// a LOCATION-SCOPED question ("authorized to work in the location where this role is based?").
// Capturing a Berlin "no" and replaying it on a Toronto posting states something the student never
// said. This is R-004 - the bug that put a FALSE legal declaration on a live application - and
// harvesting is just the same bug sourced from the other direction. The extension refuses to read
// these (WORK_ELIGIBILITY_QUESTION); this refuses to store them if it ever does.
//
// eeo_prefs: race, gender, disability. A student answering an employer's voluntary
// self-identification survey, under that survey's own framing, has not consented to a permanent
// server-side demographic record. Only ever set by explicit opt-in in Settings (PRD-v2 4B).
export const DENIED = ['work_authorized', 'needs_sponsorship', 'eeo_prefs'] as const;

// Exported for the test suite: this is the R-004 regression surface, and it is the one piece of
// harvest whose failure writes a false legal declaration onto a real application.
export function deniedKeys(fields: Record<string, unknown> | null | undefined): string[] {
  if (!fields) return [];
  return DENIED.filter((k) => k in fields);
}

// Everything a form can legitimately teach us. Bucket 3 of PRD-v2 Section 4D ("always ask, never
// attempt extraction") minus DENIED - which is exactly the set that is invasive to ask cold in a
// settings form and completely ordinary on a job application. That is the whole thesis of putting
// the first application inside onboarding.
export const harvestable = z.object({
  phone: z.string().min(1).max(40).optional(),
  address_city: z.string().min(1).max(80).optional(),
  address_state: z.string().min(1).max(80).optional(),
  address_zip: z.string().min(1).max(20).optional(),
  address_country: z.string().min(1).max(80).optional(),
  linkedin_url: z.string().min(1).max(300).optional(),
  github_url: z.string().min(1).max(300).optional(),
  portfolio_url: z.string().min(1).max(300).optional(),
  // A stable factual attribute, unlike work authorization. Proven correct on a live Lever form
  // (ANYbotics: Nationality = "India" filled, while the separate permit question was left blank).
  citizenship: z.string().min(1).max(80).optional(),
  date_of_birth: z.string().min(1).max(40).optional(),
  availability_date: z.string().min(1).max(80).optional(),
  desired_salary: z.string().min(1).max(40).optional(),
  desired_salary_currency: z.string().min(1).max(10).optional(),
  gpa: z.string().min(1).max(20).optional(),
  gpa_scale: z.string().min(1).max(20).optional(),
  major: z.string().min(1).max(80).optional(),
  referral_source_default: z.string().min(1).max(120).optional(),
});

const bodySchema = z.object({
  fields: harvestable,
  // Where it came from, for the ticker and for debugging a bad adapter. Not stored.
  source: z.object({ ats: z.string().max(40).optional(), url: z.string().max(500).optional() }).optional(),
});

type Harvestable = z.infer<typeof harvestable>;

// The stored value as the student would recognise it. Encrypted columns hold ciphertext at rest,
// so a raw read makes every one look already-set and fill-if-empty would silently no-op forever.
// A value that will not decrypt is treated as absent rather than thrown on: refusing to harvest
// because of a key rotation would be a worse outcome than re-learning the field.
function currentValue(
  row: ApplicationProfileRow,
  key: keyof Harvestable,
): string | null {
  const stored = row[key as keyof typeof row] as unknown;
  if (typeof stored !== 'string' || stored.length === 0) return null;
  if (!(ENCRYPTED_FIELDS as readonly string[]).includes(key)) return stored;
  try {
    return decryptField(stored);
  } catch {
    return null;
  }
}

export async function harvestRoutes(fastify: FastifyInstance) {
  fastify.post('/profile/harvest', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    const raw = request.body as Record<string, unknown> | null;
    const rawFields = (raw?.fields ?? {}) as Record<string, unknown>;

    // Rule 1, and it runs BEFORE the zod parse on purpose. `harvestable` does not declare the
    // denied keys, and zod strips unknown keys silently - so parsing first would drop a work-auth
    // answer and return a cheerful 200, turning the single most important refusal in the product
    // into a no-op nobody could see. Check the RAW body, reject loudly, then parse.
    const denied = deniedKeys(rawFields);
    if (denied.length > 0) {
      fastify.log.warn({ userId, denied }, 'harvest attempted on denylisted fields');
      return reply.status(400).send({
        error: `These are never harvestable: ${denied.join(', ')}. Work authorization and sponsorship are location-scoped, and self-identification is opt-in only.`,
      });
    }

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch {
      return reply.status(400).send({ error: 'Invalid request body' });
    }

    // Rule 3.
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) return reply.status(404).send({ error: 'No such user' });
    if (user.onboarding_completed_at) {
      return reply.status(403).send({ error: 'onboarding_complete' });
    }

    // Tolerant read, see lib/applicationFacts.ts.
    const existing = await selectApplicationProfileRow(userId);

    // Rule 2. Compare against the DECRYPTED value: an encrypted column is always a non-empty
    // string at rest, so testing the raw row would make every field look already-set and harvest
    // would silently no-op forever.
    const kept: string[] = [];
    const skipped: string[] = [];
    const row: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(body.fields) as [keyof Harvestable, string][]) {
      const current = existing ? currentValue(existing, key) : null;

      if (current && current.trim().length > 0) {
        skipped.push(key);
        continue;
      }
      row[key] = (ENCRYPTED_FIELDS as readonly string[]).includes(key) ? encryptField(value) : value;
      kept.push(key);
    }

    if (kept.length > 0) {
      try {
        // COALESCE, not a plain SET. The read above and this write are not atomic, so two flushes
        // racing (a pagehide flush overlapping the idle flush, or two tabs on the same ATS) can
        // both see a field empty and both pass the check - and a plain SET would let the later one
        // win, overwriting a value the earlier one had just learned. COALESCE keeps whatever is
        // already stored, which makes fill-if-empty a property of the DATABASE rather than of the
        // extension happening to serialise its flushes.
        //
        // `kept` above stays best-effort: it only drives the ticker's copy, so a lost race shows a
        // field as learned that a concurrent write already learned. Same outcome, right value.
        const coalesced = Object.fromEntries(
          Object.keys(row).map((k) => [
            k,
            sql`coalesce(${application_profile[k as keyof typeof application_profile]}, ${row[k]})`,
          ]),
        );
        await db
          .insert(application_profile)
          .values({ user_id: userId, ...row, updated_at: new Date() })
          .onConflictDoUpdate({
            target: application_profile.user_id,
            set: { ...coalesced, updated_at: new Date() },
          });
      } catch (err) {
        fastify.log.error(err);
        return reply.status(500).send({ error: 'Failed to save harvested fields' });
      }
    }

    // Drives the "Learning" ticker: kept is what the student sees appear, refused is the
    // refusal list staying true in real time.
    return reply.status(200).send({ kept, skipped, refused: DENIED });
  });
}
