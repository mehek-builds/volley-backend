import { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginOptions } from 'fastify';
import { inArray } from 'drizzle-orm';
import { db } from '../db/index';
import { profiles } from '../db/schema';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import {
  legacyOriginalOwnerIds,
  sweepExpiredResumeBlobs,
  RESUME_RETENTION_DAYS,
  SUBMISSION_PREVIEW_RETENTION_DAYS,
  type UserBlobCategory,
} from '../lib/resumeAccess';
import { purgeExpiredEntitledUsageResults } from '../lib/entitlements';
import { purgeExpiredNetworkImportPreviews } from '../lib/networkPreviewRetention';

// The breakdown fields are optional because they describe a sweep's own bookkeeping, not the
// contract a caller depends on: the production implementation always fills them, and a test
// double that only cares about ordering can still return the two counts and nothing else.
//
// deletedPathnames is NOT optional, because it is the only one that decides a write. The pointer
// clear below is scoped from it, so a double that omitted it would silently scope to nobody and
// the test asserting the scoping would pass without ever exercising it.
type SweepResult = {
  scanned: number;
  deleted: number;
  deletedPathnames: string[];
  deletedByCategory?: Partial<Record<UserBlobCategory, number>>;
  unclassified?: number;
  unclassifiedSample?: string[];
};

export type ResumeRetentionDependencies = {
  sweepExpiredResumeBlobs: () => Promise<SweepResult>;
  clearLegacyPointers: (userIds: string[]) => Promise<void>;
  purgeExpiredUsageResults: () => Promise<number>;
  purgeExpiredNetworkPreviews: () => Promise<number>;
};

type ResumeRetentionRouteOptions = FastifyPluginOptions & {
  dependencies?: Partial<ResumeRetentionDependencies>;
};

const productionDependencies: ResumeRetentionDependencies = {
  sweepExpiredResumeBlobs,
  purgeExpiredUsageResults: purgeExpiredEntitledUsageResults,
  purgeExpiredNetworkPreviews: purgeExpiredNetworkImportPreviews,
  // Scoped to the owners whose legacy original was actually deleted on this run. It was
  // previously an unscoped `db.update(profiles).set({...: null})` with no WHERE, which nulled both
  // columns for EVERY profile on every successful sweep, including the zero-deletion nights that
  // are now all of them. That is a no-op against today's data (0 of 17 profiles have either column
  // set) but it is a standing trap for any future feature that legitimately populates them: the
  // nightly cron would silently blank it. Note a bare `.where(isNotNull(...))` would NOT have
  // closed that - a future non-null value matches the filter and still gets nulled. Only "the
  // owners whose file we just destroyed" is the correct set.
  clearLegacyPointers: async (userIds) => {
    if (userIds.length === 0) return;
    await db
      .update(profiles)
      .set({ resume_object_key: null, resume_url: null })
      .where(inArray(profiles.user_id, userIds));
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
// alone; only the PDF goes. A still-valid capability may safely re-render the immutable saved
// content in memory, while the swept blob remains deleted and the capability expires on schedule.
//
// There is deliberately no query parameter that can narrow or skip the sweep. One used to exist:
// `?run=<operation id>` claimed a one-shot usage_counters slot to perform an approved legacy
// -original cleanup, and it is why this endpoint returned `{"already_processed": true}` at HTTP 200
// without sweeping anything for the eight days after 2026-08-03. The operation completed, the slot
// is spent, and the branch was redundant even when it claimed, since the sweep deletes legacy
// originals unconditionally on both paths. A future gated one-shot belongs on its own endpoint,
// not as a query string on the endpoint the privacy promise depends on.
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

  try {
    const { scanned, deleted, deletedPathnames, deletedByCategory, unclassified, unclassifiedSample } =
      await dependencies.sweepExpiredResumeBlobs();
    // The blob deletion succeeded, so stale legacy pointers can no longer lead an export or
    // onboarding response to claim the original still exists.
    await dependencies.clearLegacyPointers(legacyOriginalOwnerIds(deletedPathnames));
    const expiredUsageReceipts = await dependencies.purgeExpiredUsageResults();
    const expiredNetworkPreviews = await dependencies.purgeExpiredNetworkPreviews();
    // A key shape no retention rule recognises is kept, because deleting an artifact nobody has
    // classified is the worse mistake - but it is never kept SILENTLY. Form previews sat
    // unswept for the life of the feature because a new prefix simply fell through the old
    // allowlist and nothing said so; this is the line that would have said so on day one.
    if (unclassified) {
      fastify.log.warn(
        { unclassified, sample: unclassifiedSample },
        'resume retention sweep found blobs no retention rule classifies: they are being KEPT indefinitely and need a retention decision',
      );
    }
    // Logged at info on every run, including no-op runs: a retention promise that quietly stops
    // running looks identical to one that has nothing to do, and the privacy policy now states
    // this window as fact.
    fastify.log.info(
      {
        scanned,
        deleted,
        deletedByCategory,
        retentionDays: RESUME_RETENTION_DAYS,
        previewRetentionDays: SUBMISSION_PREVIEW_RETENTION_DAYS,
        expiredUsageReceipts,
        expiredNetworkPreviews,
      },
      'resume retention sweep complete',
    );
    return reply.status(200).send({
      scanned,
      deleted,
      deleted_by_category: deletedByCategory,
      unclassified,
      retention_days: RESUME_RETENTION_DAYS,
      preview_retention_days: SUBMISSION_PREVIEW_RETENTION_DAYS,
      expired_usage_receipts: expiredUsageReceipts,
      expired_network_previews: expiredNetworkPreviews,
    });
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
