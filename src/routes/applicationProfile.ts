import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { application_profile } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { encryptField, decryptField } from '../lib/fieldCrypto';

// Fields sensitive enough to encrypt at rest per PRD-v2 Section 4: phone/address/
// work-authorization status. Links and referral_source are not identity-sensitive
// in the same way and stay plaintext so they remain easily queryable later.
const ENCRYPTED_FIELDS = [
  'phone',
  'address_city',
  'address_state',
  'address_zip',
  'citizenship',
  'availability_date',
  'desired_salary',
  'date_of_birth',
] as const;

// Every column is nullable in the DB (application_profile has no .notNull() fields), and
// GET echoes back null for anything unset. The client round-trips the fetched profile
// verbatim on save, so every field here must accept null, not just undefined - `.optional()`
// alone rejects null and 400s on every save-after-load.
const bodySchema = z.object({
  phone: z.string().nullable().optional(),
  address_city: z.string().nullable().optional(),
  address_state: z.string().nullable().optional(),
  address_zip: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  github_url: z.string().nullable().optional(),
  portfolio_url: z.string().nullable().optional(),
  citizenship: z.string().nullable().optional(),
  work_authorized: z.boolean().nullable().optional(),
  needs_sponsorship: z.boolean().nullable().optional(),
  availability_date: z.string().nullable().optional(),
  desired_salary: z.string().nullable().optional(),
  date_of_birth: z.string().nullable().optional(),
  // Only ever set if the student explicitly opts in (PRD-v2 Section 4B); absent/null
  // means every autofill selects "Decline to Self-Identify" where that option exists.
  eeo_prefs: z.record(z.string()).nullable().optional(),
  referral_source_default: z.string().nullable().optional(),
});

function encryptRow(body: z.infer<typeof bodySchema>) {
  const row: Record<string, unknown> = { ...body };
  for (const field of ENCRYPTED_FIELDS) {
    const value = row[field];
    if (typeof value === 'string' && value.length > 0) {
      row[field] = encryptField(value);
    }
  }
  return row;
}

function decryptRow(row: typeof application_profile.$inferSelect) {
  const out: Record<string, unknown> = { ...row };
  for (const field of ENCRYPTED_FIELDS) {
    const value = out[field];
    if (typeof value === 'string' && value.length > 0) {
      try {
        out[field] = decryptField(value);
      } catch {
        // Legacy/plaintext row (e.g. pre-encryption data) — return as-is rather than 500ing.
      }
    }
  }
  return out;
}

export async function applicationProfileRoutes(fastify: FastifyInstance) {
  fastify.get('/profile/application', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const rows = await db.select().from(application_profile).where(eq(application_profile.user_id, userId)).limit(1);
    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Application profile not found' });
    }
    return reply.status(200).send(decryptRow(rows[0]));
  });

  fastify.put('/profile/application', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch {
      return reply.status(400).send({ error: 'Invalid request body' });
    }

    const encrypted = encryptRow(body);

    try {
      await db
        .insert(application_profile)
        .values({ user_id: userId, ...encrypted, updated_at: new Date() })
        .onConflictDoUpdate({
          target: application_profile.user_id,
          set: { ...encrypted, updated_at: new Date() },
        });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to save application profile' });
    }

    const rows = await db.select().from(application_profile).where(eq(application_profile.user_id, userId)).limit(1);
    return reply.status(200).send(decryptRow(rows[0]));
  });
}
