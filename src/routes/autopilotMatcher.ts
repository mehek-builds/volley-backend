import { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginOptions } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import { db } from '../db/index';
import { users, generated_resumes } from '../db/schema';
import { mintInternalAutomationToken } from '../lib/internalAutomationAuth';
import { getEntitlementSnapshot } from '../lib/entitlements';
import {
  nextPreferredReadyPacket,
  type MatchableJob,
  type MatchablePacket,
} from '../lib/autopilotMatch';

/* THE HALF OF AUTOPILOT THAT NEVER NEEDED A BROWSER OPEN TO WORK.
 *
 * /internal/application-submission-runner (submissionRunner.ts) has run every 15 minutes since it
 * shipped and is not the gap - it PROCESSES whatever sits in submit_requested/submitting. Nothing
 * in this codebase ever PUT anything there except one client-side effect: NextMatchCard's 15-second
 * countdown, in a component that only exists while a real browser has the Applications page
 * mounted. Measured live 2026-08-20: automatic_submission_enabled true for three hours, tab not
 * open, zero packets queued, zero sends - the runner had nothing to do on any of its ~12 passes.
 *
 * This route is the other half: find each autopilot user's next best match (the SAME two rules
 * the dashboard uses - nextPreferredReadyPacket, ported byte-for-byte in lib/autopilotMatch.ts -
 * so "next best match" means the same thing with or without a tab open) and queue it, by calling
 * the REAL /jobs and /applications/:id/submit-request routes in-process via fastify.inject(),
 * authenticated as that user with a 5-minute internal token (lib/internalAutomationAuth.ts). That
 * reuses every safety check submit-request already makes - duplicate-posting, education drift,
 * packet-audit acknowledgment, the daily submission cap in the runner that processes what this
 * queues - rather than re-deriving any of them here. This route only decides WHAT to queue; the
 * existing routes decide, exactly as they always have, whether it may actually go.
 */

export type AutopilotMatcherDependencies = {
  eligibleUserIds: () => Promise<string[]>;
  hasQueuedWork: (userId: string) => Promise<boolean>;
  matchablePackets: (userId: string) => Promise<MatchablePacket[]>;
  mintToken: (userId: string) => Promise<string>;
  rankedJobs: (fastify: FastifyInstance, token: string) => Promise<MatchableJob[]>;
  queueSend: (
    fastify: FastifyInstance,
    token: string,
    packet: MatchablePacket,
  ) => Promise<{ queued: boolean; statusCode: number }>;
};

/* Every account with automatic submission on, is not a guest (mintInternalAutomationToken refuses
 * one anyway; excluded here so a guest never even reaches that throw), and has a real applicant
 * profile row - the same population NextMatchCard would have shown a countdown to. */
async function defaultEligibleUserIds(): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.automatic_submission_enabled, true), eq(users.is_guest, false)));

  /* THE TOGGLE IS NOT THE ENTITLEMENT, and queueing without checking the second one is what made
   * this matcher spend money on accounts it could never send for.
   *
   * `automatic_submission_enabled` is a preference the account keeps forever once set. The right to
   * act on it is `features.automatic_submission`, which only trial_plus, plus_paid, legacy_paid and
   * an explicitly granted free_grandfathered carry. The SEND side has always enforced both - see
   * standingAuthorization in submissionRunner.ts, which reads the entitlement before it will let a
   * run reach `submitting`. This side read only the toggle.
   *
   * So an account that switched autopilot on during a trial and then lapsed to Free kept getting a
   * packet queued every fifteen minutes, forever. Each one boots a managed browser, spends LLM
   * credits building answers, moves updated_at, and clears the row's attention acknowledgements -
   * and then correctly stops at ready_for_final_approval, because the send side does check. The
   * work was never wasted at the end; it was wasted at the start, and it is the likeliest reason a
   * Free account's API credits drain and its applications appear to move on their own.
   *
   * Sequential rather than Promise.all: this runs on a cron with no deadline pressure, and the
   * eligible population is small enough that a burst of snapshot reads is the wrong trade. */
  const eligible: string[] = [];
  for (const row of rows) {
    const entitlement = await getEntitlementSnapshot(row.id);
    if (entitlement.features.automatic_submission) eligible.push(row.id);
  }
  return eligible;
}

/* Never queue a second one on top of a pass this account already has in flight. The submission
 * runner's own daily cap bounds how much of a queue gets PROCESSED, but nothing bounds how much
 * gets QUEUED - this is the only backstop against one matcher pass piling up duplicate
 * submit-requests for the same account across repeated 15-minute runs. */
async function defaultHasQueuedWork(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: generated_resumes.id })
    .from(generated_resumes)
    .where(and(
      eq(generated_resumes.user_id, userId),
      sql`${generated_resumes.spec}->'_review'->>'status' in ('submit_requested', 'submitting')`,
    ))
    .limit(1);
  return Boolean(row);
}

/* NOT FILTERED ON pipeline_stage. That is the student's own Tracker stage ("saved / applied /
 * interview / offer / closed") and a different axis from spec._review.status entirely - the
 * dashboard's own candidate list (autopilotCandidates in app/dashboard/applications/page.tsx)
 * never reads it either, only reviewablePackets (has a _review object at all) minus the client's
 * own transient unsendable set. reviewCanBeSent below is what actually decides sendability; adding
 * a pipeline_stage filter here that the feature this ports has never had would be inventing a new
 * exclusion rule rather than matching the one already proven safe. */
async function defaultMatchablePackets(userId: string): Promise<MatchablePacket[]> {
  const rows = await db
    .select({
      id: generated_resumes.id,
      created_at: generated_resumes.created_at,
      job_context: generated_resumes.job_context,
      spec: generated_resumes.spec,
    })
    .from(generated_resumes)
    .where(eq(generated_resumes.user_id, userId));
  return rows.map((row) => {
    const spec = (row.spec && typeof row.spec === 'object' ? row.spec : {}) as Record<string, unknown>;
    const review = (spec._review && typeof spec._review === 'object' ? spec._review : null) as
      | { status?: string; portal_supported?: boolean; updated_at?: string }
      | null;
    const context = (row.job_context && typeof row.job_context === 'object' ? row.job_context : {}) as Record<string, unknown>;
    return {
      id: row.id,
      created_at: row.created_at ? row.created_at.toISOString() : null,
      job_context: {
        company: typeof context.company === 'string' ? context.company : null,
        role: typeof context.role === 'string' ? context.role : null,
        job_id: typeof context.job_id === 'string' ? context.job_id : null,
      },
      review,
      reviewUpdatedAt: review?.updated_at ?? null,
    };
  });
}

/* The current ranked feed, exactly as the dashboard would see it: same route, same query shape,
 * bounded to the pool a real "next best match" pick would ever consider. */
async function defaultRankedJobs(fastify: FastifyInstance, token: string): Promise<MatchableJob[]> {
  const response = await fastify.inject({
    method: 'GET',
    url: '/jobs?limit=50',
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.statusCode >= 400) return [];
  const body = response.json() as { jobs?: Array<{ id: string; company_name: string; title: string }> };
  return Array.isArray(body.jobs) ? body.jobs : [];
}

async function defaultQueueSend(
  fastify: FastifyInstance,
  token: string,
  packet: MatchablePacket,
): Promise<{ queued: boolean; statusCode: number }> {
  const questions = (packet.review as { questions?: unknown })?.questions ?? [];
  const response = await fastify.inject({
    method: 'POST',
    url: `/applications/${packet.id}/submit-request`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ questions }),
  });
  return { queued: response.statusCode < 300, statusCode: response.statusCode };
}

const productionDependencies: AutopilotMatcherDependencies = {
  eligibleUserIds: defaultEligibleUserIds,
  hasQueuedWork: defaultHasQueuedWork,
  matchablePackets: defaultMatchablePackets,
  mintToken: mintInternalAutomationToken,
  rankedJobs: defaultRankedJobs,
  queueSend: defaultQueueSend,
};

type RouteOptions = FastifyPluginOptions & {
  dependencies?: Partial<AutopilotMatcherDependencies>;
};

async function handleMatch(
  request: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  deps: AutopilotMatcherDependencies,
) {
  if (!isCronConfigured()) {
    return reply.status(503).send({ error: 'autopilot matcher not configured (set INTERNAL_CRON_SECRET or CRON_SECRET)' });
  }
  if (!isCronAuthorized(request)) {
    return reply.status(401).send({ error: 'unauthorized' });
  }

  const userIds = await deps.eligibleUserIds();
  let queued = 0;
  let skippedAlreadyQueued = 0;
  let skippedNoMatch = 0;
  let failed = 0;

  for (const userId of userIds) {
    try {
      if (await deps.hasQueuedWork(userId)) {
        skippedAlreadyQueued += 1;
        continue;
      }
      const packets = await deps.matchablePackets(userId);
      let token: string;
      try {
        token = await deps.mintToken(userId);
      } catch (error) {
        fastify.log.error({ error, userId }, 'autopilot matcher could not mint an internal token');
        failed += 1;
        continue;
      }
      const jobs = await deps.rankedJobs(fastify, token);
      const match = nextPreferredReadyPacket(packets, jobs);
      if (!match) {
        skippedNoMatch += 1;
        continue;
      }
      const outcome = await deps.queueSend(fastify, token, match);
      if (outcome.queued) {
        queued += 1;
      } else {
        fastify.log.warn(
          { userId, applicationId: match.id, statusCode: outcome.statusCode },
          'autopilot matcher could not queue the packet it selected',
        );
        failed += 1;
      }
    } catch (error) {
      fastify.log.error({ error, userId }, 'autopilot matcher failed on this account');
      failed += 1;
    }
  }

  return reply.send({
    checked: userIds.length,
    queued,
    skipped_already_queued: skippedAlreadyQueued,
    skipped_no_match: skippedNoMatch,
    failed,
  });
}

export async function autopilotMatcherRoutes(
  fastify: FastifyInstance,
  options: RouteOptions = {},
) {
  const deps = { ...productionDependencies, ...options.dependencies };
  // GET for the cron; POST for manual/tooling triggers. Same pairing every other internal route
  // in this file uses.
  fastify.get('/internal/autopilot-matcher', (request, reply) => handleMatch(request, reply, fastify, deps));
  fastify.post('/internal/autopilot-matcher', (request, reply) => handleMatch(request, reply, fastify, deps));
}
