/**
 * GET /postings/:jobId/questions - what this posting's application form asks, and which of those
 * questions only the applicant can answer.
 *
 * This is the endpoint behind "ask her at the moment she hits Apply". Everything it does was
 * previously done in the middle of a submission run, which is why a run could discover an
 * unanswerable question after building a packet, opening a browser and typing into an employer's
 * form, and then stop: 21 of 25 applications on 2026-08-08 ended that way, several of them on
 * questions no amount of engineering could ever answer for her.
 *
 * The scan is cached per posting and shared by every applicant (see lib/postingQuestions.ts for the
 * cost argument and why the board is deliberately NOT swept in advance), and the per-applicant
 * split is computed fresh on every call because it depends on her profile and on the answers she
 * has given since.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index';
import { career_page_sources, monitored_jobs, posting_questions } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { allowHourly, LIMITS, rateLimitedReply } from '../middleware/quota';
import { isBrowserbaseConfigured, isManagedStratusProvider, runManagedBrowser } from '../lib/browserbase';
import {
  attachManagedFieldOptions,
  buildManagedDiscoveredOptionProbeBatches,
  buildManagedPrescriptActions,
  canonicalMonitoredPortalUrl,
  detectPortal,
  managedOptionProbeAnalysis,
  managedOptionProbeControlId,
  managedResultFieldOptions,
  managedResultSupportsDiscoveryRole,
  type SupportedPortal,
} from '../lib/portalSubmission';
import {
  postingQuestionsAreFresh,
  postingQuestionInventoryFromDiscovered,
  postingQuestionInventoryStatus,
  prescriptAskExplanation,
  readStoredPostingQuestionInventory,
  resolvePrescript,
  storedPostingQuestionInventory,
  type PostingQuestion,
  type PostingQuestionsDiscoveryStatus,
} from '../lib/postingQuestions';
import {
  dedupeQuestionMetadataBlockers,
  discoveredQuestionsForExactOptionProbe,
  questionMetadataBlockersForOptionProbeFailures,
  type QuestionMetadataBlocker,
} from '../lib/questionMetadata';
import { loadApplicationProfileLike } from '../lib/applicationProfileLike';
import { loadSavedAnswers } from '../lib/savedAnswerStore';
import type { DiscoveredQuestion } from '../lib/questionDiscovery';
import { postingCountryCodeFromJobContext, postingCountryFromJobContext } from '../lib/jobLocation';
import { boardConditions } from './jobMonitor';

const paramsSchema = z.object({ jobId: z.string().uuid() });

/** The board row a pre-script is about, plus what is needed to open its form. */
export type PostingTarget = {
  applyUrl: string;
  portal: SupportedPortal | null;
  company: string;
  title: string;
  description: string;
  location: string | null;
};

async function loadPostingTarget(jobId: string): Promise<PostingTarget | null> {
  const [row] = await db.select({
    external_id: monitored_jobs.external_id,
    apply_url: monitored_jobs.apply_url,
    posting_url: monitored_jobs.posting_url,
    company_name: monitored_jobs.company_name,
    title: monitored_jobs.title,
    // Capped the same way jdMatch caps it. The JD is read here only so that the handful of
    // resolution rules which consult it (location preference, posting season) see the same text the
    // submission runner will, and a multi-kilobyte read on the Apply path is affordable exactly
    // once per apply.
    description: sql<string>`left(${monitored_jobs.description}, 20000)`,
    location: monitored_jobs.location,
    ats_name: career_page_sources.ats_name,
    board_token: career_page_sources.board_token,
  })
    .from(monitored_jobs)
    .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
    /* This endpoint can spend a managed-browser run and starts the Apply flow for any supplied
       UUID. Only a posting that still satisfies the strict current-board evidence contract may
       cross that action boundary. There is no owner-bound historical application read here. */
    .where(and(
      eq(monitored_jobs.id, jobId),
      ...boardConditions({ sponsorOnly: false, requireVerifiedEvidence: true }),
    ))
    .limit(1);
  if (!row) return null;
  const applyUrl = canonicalMonitoredPortalUrl(
    row.apply_url,
    row.ats_name,
    row.board_token,
    row.external_id,
    row.posting_url,
  );
  if (!applyUrl) return null;
  let portal: SupportedPortal;
  try {
    portal = detectPortal(applyUrl);
  } catch {
    return null;
  }
  return {
    applyUrl,
    portal,
    company: row.company_name,
    title: row.title,
    description: row.description ?? '',
    location: row.location,
  };
}

type StoredScan = {
  apply_url: string;
  portal: string | null;
  questions: PostingQuestion[];
  metadata_blockers: QuestionMetadataBlocker[];
  discovery_status: PostingQuestionsDiscoveryStatus;
  discovered_at: Date;
};

async function loadStoredScan(jobId: string): Promise<StoredScan | null> {
  try {
    const [row] = await db.select().from(posting_questions)
      .where(eq(posting_questions.job_id, jobId)).limit(1);
    if (!row) return null;
    const inventory = readStoredPostingQuestionInventory(row.questions);
    const storedStatus = row.discovery_status as PostingQuestionsDiscoveryStatus;
    const measuredStatus = postingQuestionInventoryStatus(inventory);
    return {
      apply_url: row.apply_url,
      portal: row.portal,
      questions: inventory.questions,
      metadata_blockers: inventory.metadata_blockers,
      discovery_status: storedStatus === 'ok' && measuredStatus === 'metadata_incomplete'
        ? 'metadata_incomplete'
        : storedStatus,
      discovered_at: row.discovered_at,
    };
  } catch (error) {
    // The table may not exist yet: on Vercel a merge is a deploy, and this code can be live before
    // the migration has run. A missing cache degrades to "scan it now", never to a 500.
    if ((error as { code?: string } | null)?.code === '42P01') return null;
    throw error;
  }
}

async function storeScan(
  jobId: string,
  target: PostingTarget,
  questions: PostingQuestion[],
  metadataBlockers: QuestionMetadataBlocker[],
  status: PostingQuestionsDiscoveryStatus,
): Promise<void> {
  const now = new Date();
  try {
    await db.insert(posting_questions).values({
      job_id: jobId,
      apply_url: target.applyUrl,
      portal: target.portal,
      questions: storedPostingQuestionInventory(questions, metadataBlockers),
      discovery_status: status,
      discovered_at: now,
      scan_count: 1,
    }).onConflictDoUpdate({
      target: posting_questions.job_id,
      set: {
        apply_url: sql`excluded.apply_url`,
        portal: sql`excluded.portal`,
        questions: sql`excluded.questions`,
        discovery_status: sql`excluded.discovery_status`,
        discovered_at: now,
        scan_count: sql`${posting_questions.scan_count} + 1`,
      },
    });
  } catch (error) {
    if ((error as { code?: string } | null)?.code === '42P01') return;
    throw error;
  }
}

/**
 * Read the employer's form. One discovery run plus bounded option probes, no fills, no upload,
 * no screenshot.
 *
 * The option lists come back as separate extracts and are stitched onto the discovered questions
 * the same way the submission runner stitches them, because a closed list without its options is
 * the difference between "choose one of these four" and a blank box.
 */
export async function scanPostingQuestions(
  target: PostingTarget,
  browserRunner: typeof runManagedBrowser = runManagedBrowser,
): Promise<{
  questions: PostingQuestion[];
  metadata_blockers: QuestionMetadataBlocker[];
  status: PostingQuestionsDiscoveryStatus;
}> {
  const portal = target.portal;
  if (!portal) return { questions: [], metadata_blockers: [], status: 'failed' };
  // A read scan, not a submission: the discover pass plus Greenhouse option probes drive clicks that
  // stratus classifies as mutations, so under correlationRequired the run must carry correlation.
  // scanCorrelation attaches a fresh ephemeral attempt and deadline for exactly that, with no
  // allowSubmit and no submit-only terminal-result assertion. See runManagedBrowser.
  const result = await browserRunner(target.applyUrl, buildManagedPrescriptActions(portal), { screenshot: false, scanCorrelation: true });
  const scanFieldOptions = managedResultFieldOptions(result);
  const discoveryRoleCapability = managedResultSupportsDiscoveryRole(result);
  const discoveredRaw = (result.discovered ?? []) as DiscoveredQuestion[];
  const discoveredForOptionProbe = discoveredQuestionsForExactOptionProbe(discoveredRaw);
  /* Bounded follow-up reads, for the closed controls the scan could not name in advance.
   *
   * buildManagedPrescriptActions probes the four ids Greenhouse owns. An employer's own questions
   * carry ids only the live page knows, so their option lists can only be read after the DOM walk
   * has reported them. Read-only exactly like the pass above: open, read the listbox, Escape, and
   * skipped entirely when there is nothing left to read. A failed batch removes its affected
   * controls from the answerable list and records typed metadata blockers instead of guessing. */
  const probeBatches = buildManagedDiscoveredOptionProbeBatches(
    portal,
    discoveredForOptionProbe,
    scanFieldOptions,
    discoveryRoleCapability,
  );
  const probeResults = [];
  const probeFailures: Array<{ controlIds: string[]; reason: string }> = [];
  for (const actions of probeBatches) {
    const controlIds = [...new Set(actions.flatMap((action) => {
      const label = action.label ?? '';
      if (label.startsWith('options:')) return [label.slice('options:'.length)];
      const closedControlId = label.match(/^closed_control:(.+)$/)?.[1];
      return closedControlId ? [closedControlId] : [];
    }))];
    // Each option-probe batch also opens listboxes and presses Escape (mutations), so it needs its
    // own read-scan correlation for the same reason the main pass above does.
    const probeResult = await browserRunner(target.applyUrl, actions, { screenshot: false, scanCorrelation: true })
      .catch(() => null);
    probeResults.push(probeResult);
    if (probeResult === null) {
      probeFailures.push({
        controlIds,
        reason: 'the bounded posting question option probe did not complete',
      });
    }
  }
  const optionProbe = managedOptionProbeAnalysis(
    portal,
    discoveredForOptionProbe,
    scanFieldOptions,
    [result, ...probeResults],
    probeFailures,
    discoveryRoleCapability,
  );
  const discovered = attachManagedFieldOptions(discoveredRaw, optionProbe.options);
  const probeMetadataBlockers = questionMetadataBlockersForOptionProbeFailures(
    portal,
    discoveredRaw,
    optionProbe.failures,
  );
  const inventoryWithoutProbeFailures = postingQuestionInventoryFromDiscovered(
    discovered.filter((field) => {
      const controlId = managedOptionProbeControlId(field);
      return !controlId || !optionProbe.failedIds.has(controlId);
    }),
    portal,
  );
  const inventory = {
    questions: inventoryWithoutProbeFailures.questions,
    metadata_blockers: dedupeQuestionMetadataBlockers([
      ...inventoryWithoutProbeFailures.metadata_blockers,
      ...probeMetadataBlockers,
    ]),
  };
  // Zero controls is not "this form has no questions". It is a page this run could not read, and
  // storing it as a good scan would tell every later applicant the form is empty for a fortnight.
  return { ...inventory, status: postingQuestionInventoryStatus(inventory) };
}

export async function postingQuestionsRoutes(fastify: FastifyInstance) {
  fastify.get('/postings/:jobId/questions', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    let params: z.infer<typeof paramsSchema>;
    try {
      params = paramsSchema.parse(request.params);
    } catch {
      return reply.status(400).send({ error: 'Invalid posting id' });
    }

    const target = await loadPostingTarget(params.jobId);
    if (!target) {
      return reply.status(409).send({
        error: 'Current verified posting not found',
        code: 'job_not_available',
      });
    }

    const stored = await loadStoredScan(params.jobId);
    let questions = stored?.questions ?? [];
    let metadataBlockers = stored?.metadata_blockers ?? [];
    let status: PostingQuestionsDiscoveryStatus = stored?.discovery_status ?? 'failed';
    let scanned = false;

    if (!postingQuestionsAreFresh(stored, target.applyUrl)) {
      if (!isBrowserbaseConfigured() && !isManagedStratusProvider()) {
        // No browser on this deployment. Answer honestly with whatever is cached rather than 503:
        // an empty pre-script means the Apply screen asks nothing extra, which is exactly today's
        // behaviour, and a 503 would break Apply on a deployment where it currently works.
        return reply.status(200).send(prescriptResponse(params.jobId, target, questions, metadataBlockers, status, stored?.discovered_at ?? null, false, await resolveFor(userId, questions, target)));
      }
      // A managed browser run per call would be a loop waiting to happen if the client retried, so
      // it sits behind the same hourly ceiling as the other browser-backed endpoint.
      if (!(await allowHourly(userId, 'postingQuestions', LIMITS.perHour.postingQuestions))) {
        return rateLimitedReply(reply);
      }
      try {
        const scan = await scanPostingQuestions(target);
        questions = scan.questions;
        metadataBlockers = scan.metadata_blockers;
        status = scan.status;
        scanned = true;
        await storeScan(params.jobId, target, questions, metadataBlockers, status);
      } catch (err) {
        fastify.log.warn({ err, userId, jobId: params.jobId }, 'posting question pre-scan failed');
        // Keep whatever was cached. A failed scan must not empty a good one.
        if (!stored) {
          questions = [];
          metadataBlockers = [];
          status = 'failed';
          await storeScan(params.jobId, target, [], [], 'failed');
        }
      }
    }

    const resolution = await resolveFor(userId, questions, target);
    return reply.status(200).send(
      prescriptResponse(params.jobId, target, questions, metadataBlockers, status, scanned ? new Date() : (stored?.discovered_at ?? null), scanned, resolution),
    );
  });
}

async function resolveFor(userId: string, questions: PostingQuestion[], target: PostingTarget) {
  const [profile, saved] = await Promise.all([
    loadApplicationProfileLike(userId),
    loadSavedAnswers(userId),
  ]);
  const jobContext = { location: target.location };
  return resolvePrescript(questions, profile, saved, {
    company: target.company,
    jdText: target.description,
    postingCountry: postingCountryFromJobContext(jobContext),
    postingCountryCode: postingCountryCodeFromJobContext(jobContext),
  });
}

export function prescriptResponse(
  jobId: string,
  target: PostingTarget,
  questions: PostingQuestion[],
  metadataBlockers: QuestionMetadataBlocker[],
  status: PostingQuestionsDiscoveryStatus,
  discoveredAt: Date | null,
  scanned: boolean,
  resolution: ReturnType<typeof resolvePrescript>,
) {
  const responseMetadataBlockers = dedupeQuestionMetadataBlockers([
    ...metadataBlockers,
    ...resolution.metadata_blockers,
  ]);
  return {
    job_id: jobId,
    company: target.company,
    role: target.title,
    apply_url: target.applyUrl,
    portal: target.portal,
    discovery_status: status === 'ok' && responseMetadataBlockers.length > 0
      ? 'metadata_incomplete'
      : status,
    discovered_at: discoveredAt ? discoveredAt.toISOString() : null,
    scanned_now: scanned,
    question_count: questions.length,
    metadata_blockers: responseMetadataBlockers,
    /* Only the questions that need her. The ones Litos already answers are counted above and not
     * listed: this screen exists to be the shortest possible interruption, and a list of forty
     * fields with thirty-two of them already filled is not that. */
    ask: resolution.ask.map((item) => ({
      question: item.label,
      input_type: item.input_type,
      options: item.options,
      required: item.required,
      max_length: item.max_length,
      answer: item.answer,
      reusable: item.reusable,
      remembered: item.remembered,
      reason: item.reason,
      explanation: item.reason ? prescriptAskExplanation(item.reason, item.label) : undefined,
    })),
    /* What she does NOT have to do, as a number rather than a list. It is the honest counterweight
     * to the ask list and the thing that makes a four-question screen read as progress. */
    already_answered: resolution.questions.filter((item) => !item.ask && item.answer.trim()).length,
  };
}
