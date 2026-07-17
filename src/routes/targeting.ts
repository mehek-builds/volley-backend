import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { targeting } from '../db/schema';
import { requireAuth } from '../middleware/auth';

// The five questions /start asks last. Nothing here is identity-sensitive - it is a stated
// preference about future postings - so unlike application_profile this is plaintext and IS
// allowed into a drafting prompt (it is what aims resume tailoring).

const ROLE_TYPES = ['internship', 'co-op', 'new-grad', 'full-time'] as const;

// e.g. "summer-2027". Derived from grad_year at render time rather than enumerated here: the
// valid set slides forward every term, and an enum would need a migration each year to say
// nothing new. The regex is the only real contract - it keeps a free-text field from becoming
// a junk drawer without pretending to know which terms exist.
const PERIOD_RE = /^(spring|summer|fall|winter)-20\d{2}$/;
const period = z.string().regex(PERIOD_RE, 'period must look like "summer-2027"');

// The caps on categories and role_types are a PRODUCT rule, not just a bound on a
// client-controlled jsonb column.
//
// An uncapped multi-select lets a student tick every category and quietly destroy their own
// matching: "I'm interested in everything" is indistinguishable from "I haven't chosen", and both
// produce a feed that matches nothing in particular. Simplify forces exactly one category and at
// most two experience levels (walked 2026-07-17) - aggressive, but it means every answer they
// hold is a real preference. These caps are looser than theirs, because our categories are
// broader, while still forcing a choice: 3 of 8 categories, and 2 of 4 role types (internship +
// co-op, or new-grad + full-time, are the real pairs a student actually wants).
//
// The titles cap stays a plain bound. A student with more than 12 target titles has not answered
// the question, but titles are seeded from their own resume, so there is no matching to protect.
export const MAX_CATEGORIES = 3;
export const MAX_ROLE_TYPES = 2;

export const targetingBodySchema = z.object({
  categories: z
    .array(z.string().min(1).max(40))
    .max(MAX_CATEGORIES, `pick at most ${MAX_CATEGORIES} categories`)
    .nullable()
    .optional(),
  titles: z.array(z.string().min(1).max(80)).max(12).nullable().optional(),
  role_types: z
    .array(z.enum(ROLE_TYPES))
    .max(MAX_ROLE_TYPES, `pick at most ${MAX_ROLE_TYPES} role types`)
    .nullable()
    .optional(),
  primary_period: period.nullable().optional(),
  backup_period: period.nullable().optional(),
});

const EMPTY = {
  categories: null,
  titles: null,
  role_types: null,
  primary_period: null,
  backup_period: null,
};

function shape(row: typeof targeting.$inferSelect | undefined) {
  if (!row) return EMPTY;
  return {
    categories: row.categories ?? null,
    titles: row.titles ?? null,
    role_types: row.role_types ?? null,
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
