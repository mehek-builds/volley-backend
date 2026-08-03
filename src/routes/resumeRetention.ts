import { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginOptions } from 'fastify';
import { db } from '../db/index';
import { profiles } from '../db/schema';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import { sweepExpiredResumeBlobs, RESUME_RETENTION_DAYS } from '../lib/resumeAccess';
import { claimCounterSlot } from '../middleware/quota';

export const LEGACY_ORIGINAL_CLEANUP_OPERATION_ID =
  'issue-007-approved-legacy-original-cleanup-2026-08-03';
export const RETENTION_OPERATION_COUNTER_KEY = 'system:resume-retention-operation';
export const RETENTION_OPERATION_COUNTER_KIND = 'one-shot';

type SweepResult = { scanned: number; deleted: number };

export type ResumeRetentionDependencies = {
  claimCounterSlot: (
    key: string,
    period: string,
    kind: string,
    limit: number,
  ) => Promise<number | null>;
  sweepExpiredResumeBlobs: () => Promise<SweepResult>;
  clearLegacyPointers: () => Promise<void>;
};

type ResumeRetentionRouteOptions = FastifyPluginOptions & {
  dependencies?: Partial<ResumeRetentionDependencies>;
};

const productionDependencies: ResumeRetentionDependencies = {
  claimCounterSlot,
  sweepExpiredResumeBlobs,
  clearLegacyPointers: async () => {
    await db.update(profiles).set({ resume_object_key: null, resume_url: null });
  },
};

// Daily sweep deleting legacy originals immediately and generated files past the retention window.
//
// This is the only control that reaches blobs whose URL was already handed to a client. Before
// the /resume/download change, POST /resume/generate returned the raw public blob URL, so those
// URLs are now loose in browser histories, service-worker caches and anywhere else a fetched
// URL ends up - permanent, unauthenticated, and impossible to revoke one by one. Deleting the
// object is the revocation. New blobs are never exposed that way, but they age out on the same
// schedule so the exposure of any future leak is bounded by time rather than by luck.
//
// The generated_resumes row (the tailoring decision, kept for audit) is deliberately left
// alone; only the PDF goes. GET /resume/download 404s for a swept file, which is the intended
// end state, not an error.
async function handleSweep(
  request: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  dependencies: ResumeRetentionDependencies,
) {
  // Every refusal logs. The success path already logs on every run because "a retention promise
  // that quietly stops running looks identical to one that has nothing to do" - but that reasoning
  // applies twice as hard here, where the sweep never runs at all. A 503 answered to Vercel Cron
  // in silence is exactly how the adapter-health job died unnoticed (see lib/cronAuth.ts), and the
  // privacy policy now states the 30-day window as fact, so a silently-dead sweep makes the page
  // lie rather than merely degrading a feature.
  if (!isCronConfigured()) {
    fastify.log.warn('resume retention sweep REFUSED: neither INTERNAL_CRON_SECRET nor CRON_SECRET is set, so resume files are NOT being deleted and the privacy policy overstates retention');
    return reply
      .status(503)
      .send({ error: 'resume retention sweep not configured (set INTERNAL_CRON_SECRET or CRON_SECRET)' });
  }
  if (!isCronAuthorized(request)) {
    fastify.log.warn('resume retention sweep REFUSED: caller presented no valid secret; if this is Vercel Cron, CRON_SECRET does not match and the sweep is not running');
    return reply.status(401).send({ error: 'unauthorized' });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    fastify.log.warn('resume retention sweep REFUSED: BLOB_READ_WRITE_TOKEN is not set, so resume files are NOT being deleted');
    return reply.status(503).send({ error: 'BLOB_READ_WRITE_TOKEN not configured' });
  }

  const rawRun = (request.query as { run?: unknown }).run;
  if (rawRun !== undefined && rawRun !== '' && rawRun !== LEGACY_ORIGINAL_CLEANUP_OPERATION_ID) {
    return reply.status(400).send({ error: 'unknown retention operation' });
  }

  if (rawRun === LEGACY_ORIGINAL_CLEANUP_OPERATION_ID) {
    try {
      const claim = await dependencies.claimCounterSlot(
        RETENTION_OPERATION_COUNTER_KEY,
        LEGACY_ORIGINAL_CLEANUP_OPERATION_ID,
        RETENTION_OPERATION_COUNTER_KIND,
        1,
      );
      if (claim === null) {
        fastify.log.info(
          { operationId: LEGACY_ORIGINAL_CLEANUP_OPERATION_ID },
          'resume retention one-shot already processed',
        );
        return reply.status(200).send({ already_processed: true });
      }
    } catch (err) {
      fastify.log.error(err, 'resume retention one-shot claim failed');
      return reply.status(500).send({ error: 'operation claim failed' });
    }
  }

  try {
    const { scanned, deleted } = await dependencies.sweepExpiredResumeBlobs();
    // The blob deletion succeeded, so stale legacy pointers can no longer lead an export or
    // onboarding response to claim the original still exists.
    await dependencies.clearLegacyPointers();
    // Logged at info on every run, including no-op runs: a retention promise that quietly stops
    // running looks identical to one that has nothing to do, and the privacy policy now states
    // this window as fact.
    fastify.log.info({ scanned, deleted, retentionDays: RESUME_RETENTION_DAYS }, 'resume retention sweep complete');
    return reply.status(200).send({ scanned, deleted, retention_days: RESUME_RETENTION_DAYS });
  } catch (err) {
    fastify.log.error(err, 'resume retention sweep failed');
    return reply.status(500).send({ error: 'sweep failed' });
  }
}

export async function resumeRetentionRoutes(
  fastify: FastifyInstance,
  options: ResumeRetentionRouteOptions = {},
) {
  const dependencies = { ...productionDependencies, ...options.dependencies };
  // GET for Vercel Cron (it only issues GETs); POST for manual/tooling triggers. Same shape as
  // /internal/adapter-health-check.
  fastify.get('/internal/resume-retention-sweep', (request, reply) =>
    handleSweep(request, reply, fastify, dependencies));
  fastify.post('/internal/resume-retention-sweep', (request, reply) =>
    handleSweep(request, reply, fastify, dependencies));
}
