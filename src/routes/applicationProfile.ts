import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { application_profile } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { encryptField, decryptField, looksEncrypted, FieldDecryptError } from '../lib/fieldCrypto';

// Fields sensitive enough to encrypt at rest per PRD-v2 Section 4: phone/address/
// work-authorization status. Links and referral_source are not identity-sensitive
// in the same way and stay plaintext so they remain easily queryable later.
// Exported so /profile/harvest encrypts the same set: two copies of this list would drift, and
// the failure mode of drift is a sensitive value written to the DB in plaintext.
export const ENCRYPTED_FIELDS = [
  'phone',
  'address_city',
  'address_state',
  'address_zip',
  'address_country',
  'citizenship',
  'availability_date',
  'desired_salary',
  'date_of_birth',
  // Academic record (R-005). Encrypted with the identity-sensitive set rather than left plaintext
  // with the links: a specific GPA is a real record about a real person. gpa_scale and major stay
  // plaintext - a scale is meaningless on its own, and a major is no more sensitive than school,
  // which profiles.parsed_json already stores in the clear.
  'gpa',
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
  address_country: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  github_url: z.string().nullable().optional(),
  portfolio_url: z.string().nullable().optional(),
  citizenship: z.string().nullable().optional(),
  work_authorized: z.boolean().nullable().optional(),
  needs_sponsorship: z.boolean().nullable().optional(),
  availability_date: z.string().nullable().optional(),
  desired_salary: z.string().nullable().optional(),
  // The unit `desired_salary` is in. A figure without it cannot be filled honestly onto a
  // posting in another currency, so the adapters require both or neither.
  desired_salary_currency: z.string().nullable().optional(),
  date_of_birth: z.string().nullable().optional(),
  // Academic record (R-005). gpa and gpa_scale are separate on purpose: "3.89" says nothing without
  // "4.0", and a form asking for a UK percentage cannot be answered honestly without knowing the
  // scale the number was earned on.
  gpa: z.string().nullable().optional(),
  gpa_scale: z.string().nullable().optional(),
  major: z.string().nullable().optional(),
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

// R-021: a value that fails to decrypt is NOT automatically legacy plaintext.
//
// The catch that used to sit here assumed it was, and passed the raw value straight through. So a
// missing or rotated ENCRYPTION_KEY did not fail: it quietly served base64 ciphertext, which the
// extension then typed into real job applications. Caught live on Proxima Fusion filling the
// required "When are you available to start?" field, with auto-submit already proven to fire.
//
// The two cases are now told apart by shape. A value that does not look like our envelope is
// genuinely legacy plaintext and passes through exactly as before. A value that DOES look like our
// envelope but will not decrypt means the key is wrong, rotated or gone, which is a config error
// about the server, not data the student can fix.
//
// That case throws, and the route turns it into a 500. It deliberately does NOT degrade to "null
// the bad field and serve the rest", even though a blank field would be safe to fill: the client
// round-trips the fetched profile verbatim on save (see bodySchema above) and PUT writes it back
// with `set`, so a served null would be saved straight over the still-encrypted column and destroy
// the only copy of the data. Refusing to serve keeps a recoverable problem recoverable.
function decryptRow(row: typeof application_profile.$inferSelect) {
  const out: Record<string, unknown> = { ...row };
  for (const field of ENCRYPTED_FIELDS) {
    const value = out[field];
    if (typeof value === 'string' && value.length > 0 && looksEncrypted(value)) {
      out[field] = decryptField(value); // throws FieldDecryptError on a wrong or missing key
    }
  }
  return out;
}

// Serve a profile row, or refuse loudly if it cannot be decrypted. Shared by GET and PUT so the
// two cannot drift: PUT re-reads and returns the row too, and would otherwise emit ciphertext by
// the same route the GET no longer does.
function sendProfile(
  fastify: FastifyInstance,
  reply: FastifyReply,
  row: typeof application_profile.$inferSelect,
  userId: string,
) {
  try {
    return reply.status(200).send(decryptRow(row));
  } catch (err) {
    if (err instanceof FieldDecryptError) {
      fastify.log.error(
        { err, userId },
        'ENCRYPTION_KEY cannot decrypt stored application_profile values. Refusing to serve the profile rather than emit ciphertext into an application (R-021). Check that ENCRYPTION_KEY matches the one the rows were written with.',
      );
      return reply.status(500).send({
        error:
          'Your saved details could not be read on the server. This is a configuration problem on our side, not a problem with your data, and re-entering it will not help. Please contact support.',
      });
    }
    throw err;
  }
}

export async function applicationProfileRoutes(fastify: FastifyInstance) {
  fastify.get('/profile/application', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const rows = await db.select().from(application_profile).where(eq(application_profile.user_id, userId)).limit(1);
    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Application profile not found' });
    }
    return sendProfile(fastify, reply, rows[0], userId);
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
    return sendProfile(fastify, reply, rows[0], userId);
  });
}
