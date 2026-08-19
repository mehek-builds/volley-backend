import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { targeting } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { IMMEDIATE_PERIOD, ROLE_TYPES } from '../lib/jobPreferences';

// The five questions /start asks last. Nothing here is identity-sensitive - it is a stated
// preference about future postings - so unlike application_profile this is plaintext and IS
// allowed into a drafting prompt (it is what aims resume tailoring).

// e.g. "summer-2027". Derived from grad_year at render time rather than enumerated here: the
// valid set slides forward every term, and an enum would need a migration each year to say
// nothing new. The regex is the only real contract - it keeps a free-text field from becoming
// a junk drawer without pretending to know which terms exist.
//
// IMMEDIATE_PERIOD is the one non-seasonal answer, and it is a real answer rather than a blank:
// a student who can start now is saying the cycle does not constrain them, which is not what a
// null says (null is "never asked"). It widens the regex instead of getting its own column
// because every reader of these two fields already treats them as an opaque slug, and the one
// place the value changes behaviour - the recommendation gate in lib/jobPreferences.ts - has to
// branch on it either way. The constant lives in lib/jobPreferences.ts, which this file already
// imports and which must not import back from it.
const PERIOD_RE = new RegExp(`^(${IMMEDIATE_PERIOD}|(?:spring|summer|fall|winter)-20\\d{2})$`);
const period = z.string().regex(PERIOD_RE, 'period must look like "summer-2027" or "immediately"');

// Categories and role types are NO LONGER CAPPED (Mehek, 2026-08-02). They used to be 3 and 2,
// on the argument that "interested in everything" and "hasn't chosen" produce the same unusable
// feed. The counter-argument won: a student who genuinely wants software engineering AND data AND
// product AND research was being told by the product that they are not allowed to, and answered by
// picking three and never coming back to fix it. A wide preference is still a stated preference,
// and ranking already sorts a broad feed - a hard stop at three does not.
//
// Both lists are closed enums, so they bound themselves at 8 and 4. What remains below is a
// payload guard on the free-text arrays, not a product rule: the column is a client-controlled
// jsonb blob and something has to keep a script from writing ten thousand strings into it.
export const MAX_FREE_TEXT_ENTRIES = 200;

/* The eight categories, mirrored from the web app's lib/periods.ts CATEGORIES.
 *
 * Closed here as well as there, because the closed list IS the product rule: this steers which
 * postings a student is shown, and free text produces forty spellings of "SWE" that match nothing.
 * The column accepted any string up to 40 characters, so the rule lived entirely in the client -
 * the wrong layer for an invariant the matcher reads. Caught 2026-07-27 when a test harness saved
 * "engineering", which is not a category, and got a 200.
 *
 * Adding a category means adding it in both places. That is the cost of the list being closed, and
 * it is cheaper than a silently unmatchable preference. */
export const CATEGORIES = [
  'software-engineering',
  'data-ml',
  'product',
  'design',
  'quant-trading',
  'hardware',
  'research',
  'other',
] as const;

export const targetingBodySchema = z.object({
  categories: z.array(z.enum(CATEGORIES)).nullable().optional(),
  titles: z.array(z.string().min(1).max(80)).max(MAX_FREE_TEXT_ENTRIES).nullable().optional(),
  role_types: z.array(z.enum(ROLE_TYPES)).nullable().optional(),
  locations: z
    .array(z.string().trim().min(1).max(100))
    .max(MAX_FREE_TEXT_ENTRIES)
    .nullable()
    .optional(),
  remote_only: z.boolean().optional(),
  primary_period: period.nullable().optional(),
  backup_period: period.nullable().optional(),
});

const EMPTY = {
  categories: null,
  titles: null,
  role_types: null,
  locations: null,
  remote_only: false,
  primary_period: null,
  backup_period: null,
};

function shape(row: typeof targeting.$inferSelect | undefined) {
  if (!row) return EMPTY;
  return {
    categories: row.categories ?? null,
    titles: row.titles ?? null,
    role_types: row.role_types ?? null,
    locations: row.locations ?? null,
    remote_only: row.remote_only,
    primary_period: row.primary_period ?? null,
    backup_period: row.backup_period ?? null,
  };
}

export async function targetingRoutes(fastify: FastifyInstance) {
  // Returns 200 with nulls when unset, NOT 404. /profile and /profile/application both 404 on an
  // empty row and every client has to special-case it; "this student has not stated preferences"
  // is a normal state, not a missing resource. Follows experience-bank's precedent instead.
  fastify.get('/profile/targeting', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const [row] = await db.select().from(targeting).where(eq(targeting.user_id, userId));
    return reply.status(200).send(shape(row));
  });

  // PUT, but partial-by-omission like /profile/application: zod drops absent keys, so an omitted
  // field keeps its stored value and an explicit null clears it. /start saves the whole object at
  // once; Settings can later patch one field without reading first.
  fastify.put('/profile/targeting', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    let body: z.infer<typeof targetingBodySchema>;
    try {
      body = targetingBodySchema.parse(request.body);
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues[0]?.message : undefined;
      return reply.status(400).send({ error: message ?? 'Invalid request body' });
    }

    try {
      await db
        .insert(targeting)
        .values({ user_id: userId, ...body, updated_at: new Date() })
        .onConflictDoUpdate({
          target: targeting.user_id,
          set: { ...body, updated_at: new Date() },
        });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to save targeting' });
    }

    const [row] = await db.select().from(targeting).where(eq(targeting.user_id, userId));
    return reply.status(200).send(shape(row));
  });
}
