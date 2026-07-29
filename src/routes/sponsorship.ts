import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index';
import { users } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import {
  answerRequiresSponsorship,
  sponsorOnlyBoardRequired,
  type SponsorshipAnswer,
} from '../lib/sponsorship';
import { H1B_EMPLOYERS, H1B_FISCAL_YEARS, H1B_SOURCE, LCA_QUARTERS, LCA_SOURCE } from '../lib/sponsorEmployers';

/**
 * THE VISA-SPONSORSHIP DECLARATION AND THE FILTER IT TURNS ON.
 *
 * Three routes, and the asymmetry between them is the feature:
 *
 *   POST /onboarding/sponsorship   asked once, during onboarding, and PERMANENT
 *   PUT  /sponsorship/filter       the settings toggle, which can only ever ADD the filter
 *   GET  /sponsorship              what is on, why, and what evidence sits behind it
 *
 * See src/lib/sponsorship.ts for the rule and the reasoning. The short version: forgetting to
 * re-declare must not put someone back in front of jobs that will reject them at the last question.
 */

const declareSchema = z.object({
  /* Four answers, three of which mean the same thing to the board. They are kept apart in the
     column because the product has to be able to say WHICH one was given - "you told us you will
     need sponsorship in the future" is a different sentence to show someone than "you told us you
     are not authorised to work here", and a single boolean cannot produce either. */
  answer: z.enum(['needs_now', 'needs_future', 'not_authorized', 'no']),
});

const filterSchema = z.object({ enabled: z.boolean() });

type AccountRow = {
  declared: boolean | null;
  declared_at: Date | null;
  answer: string | null;
  setting: boolean;
};

function state(row: AccountRow) {
  return {
    declared_at_onboarding: row.declared,
    declared_at: row.declared_at,
    answer: row.answer,
    setting_enabled: row.setting,
    sponsor_only_board: sponsorOnlyBoardRequired({
      declaredAtOnboarding: row.declared,
      settingEnabled: row.setting,
    }),
    /* True when the toggle is on and cannot be turned off. The client is not TRUSTED with this -
       PUT enforces it - but it has to be TOLD, or the settings screen renders a switch that
       silently refuses. A control that does nothing when pressed is worse than one that explains
       why it is fixed. */
    locked: row.declared === true,
  };
}

async function readAccount(userId: string): Promise<AccountRow | null> {
  const [row] = await db
    .select({
      declared: users.sponsorship_required_at_onboarding,
      declared_at: users.sponsorship_declared_at,
      answer: users.sponsorship_answer,
      setting: users.sponsor_only_jobs_enabled,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

export async function sponsorshipRoutes(fastify: FastifyInstance) {
  fastify.get('/sponsorship', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const row = await readAccount(request.jwtPayload!.userId);
    if (!row) return reply.status(404).send({ error: 'No such user' });
    const confirmed = H1B_EMPLOYERS.filter((employer) => employer.sponsors);
    return reply.send({
      ...state(row),
      /* What the filter is standing on, in numbers the person it affects can check. Somebody whose
         board just lost several thousand postings is owed the reason, and "191 of the 253 employers
         we watch have H-1B filings with the US government" is one. Both sources are named, because
         an approved petition and a certified application are different claims. */
      evidence: {
        source: H1B_SOURCE,
        fiscal_years: H1B_FISCAL_YEARS,
        lca_source: LCA_SOURCE,
        lca_quarters: LCA_QUARTERS,
        confirmed_employers: confirmed.length,
        checked_employers: H1B_EMPLOYERS.length,
      },
    });
  });

  /**
   * The onboarding declaration. FIRST WRITE WINS, permanently.
   *
   * A second call with the same answer succeeds and changes nothing, so a retry, a double-tap or a
   * refreshed tab is never an error. A second call with a DIFFERENT answer is refused with 409 and
   * the answer on file, because silently accepting it is the one thing that would defeat the
   * guarantee: it would make the declaration editable by anyone who can send one request.
   */
  fastify.post('/onboarding/sponsorship', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = declareSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Tell us whether you need visa sponsorship.' });
    const userId = request.jwtPayload!.userId;
    const row = await readAccount(userId);
    if (!row) return reply.status(404).send({ error: 'No such user' });

    const answer = parsed.data.answer as SponsorshipAnswer;
    if (row.declared_at !== null) {
      if (row.answer === answer) return reply.send(state(row));
      return reply.status(409).send({
        error: 'Your sponsorship answer was recorded when you set up your account and cannot be changed here.',
        ...state(row),
      });
    }

    /* THE WRITE IS THE GUARD, not the read above it.
       `where sponsorship_declared_at is null` is what actually makes this one-way. The check above
       is a read-then-write, and two requests arriving together both pass it - which is all it takes
       to overwrite "needs_now" with "no" and unfilter a board that was meant to stay filtered
       forever. Zero rows back means somebody else won the race, and that is the 409 path. */
    const requires = answerRequiresSponsorship(answer);
    const [updated] = await db
      .update(users)
      .set({
        sponsorship_required_at_onboarding: requires,
        sponsorship_declared_at: new Date(),
        sponsorship_answer: answer,
      })
      .where(and(eq(users.id, userId), isNull(users.sponsorship_declared_at)))
      .returning({
        declared: users.sponsorship_required_at_onboarding,
        declared_at: users.sponsorship_declared_at,
        answer: users.sponsorship_answer,
        setting: users.sponsor_only_jobs_enabled,
      });
    if (!updated) {
      // Lost the race. Re-read and answer with what is on file, exactly as the guard above would.
      const current = await readAccount(userId);
      if (!current) return reply.status(404).send({ error: 'No such user' });
      if (current.answer === answer) return reply.send(state(current));
      return reply.status(409).send({
        error: 'Your sponsorship answer was recorded when you set up your account and cannot be changed here.',
        ...state(current),
      });
    }
    return reply.send(state(updated));
  });

  /**
   * The settings toggle. Additive only.
   *
   * Enabling works for anyone. Disabling works only for someone who did not declare a need at
   * onboarding - for everyone else it answers 409 rather than pretending to succeed, because a
   * toggle that reports success and then stays on is a lie the settings screen would repeat.
   */
  fastify.put('/sponsorship/filter', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = filterSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid sponsorship filter' });
    const userId = request.jwtPayload!.userId;
    const row = await readAccount(userId);
    if (!row) return reply.status(404).send({ error: 'No such user' });

    if (!parsed.data.enabled && row.declared === true) {
      return reply.status(409).send({
        error: 'You told us during setup that you need visa sponsorship, so Litos only shows you '
          + 'employers we can confirm sponsor. Contact support if that has changed.',
        ...state(row),
      });
    }

    const [updated] = await db
      .update(users)
      .set({ sponsor_only_jobs_enabled: parsed.data.enabled })
      .where(eq(users.id, userId))
      .returning({
        declared: users.sponsorship_required_at_onboarding,
        declared_at: users.sponsorship_declared_at,
        answer: users.sponsorship_answer,
        setting: users.sponsor_only_jobs_enabled,
      });
    return reply.send(state(updated));
  });
}
