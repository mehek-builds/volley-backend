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
  buildManagedPrescriptActions,
  canonicalMonitoredPortalUrl,
  detectPortal,
  managedResultFieldOptions,
  type SupportedPortal,
} from '../lib/portalSubmission';
import {
  postingQuestionsAreFresh,
  postingQuestionsFromDiscovered,
  prescriptAskExplanation,
  resolvePrescript,
  type PostingQuestion,
  type PostingQuestionsDiscoveryStatus,
} from '../lib/postingQuestions';
import { loadApplicationProfileLike } from '../lib/applicationProfileLike';
import { loadSavedAnswers } from '../lib/savedAnswerStore';
import type { DiscoveredQuestion } from '../lib/questionDiscovery';

const paramsSchema = z.object({ jobId: z.string().uuid() });

/** The board row a pre-script is about, plus what is needed to open its form. */
type PostingTarget = {
  applyUrl: string;
  portal: SupportedPortal | null;
  company: string;
  title: string;
  description: string;
};

async function loadPostingTarget(jobId: string): Promise<PostingTarget | null> {
  const [row] = await db.select({
    apply_url: monitored_jobs.apply_url,
    company_name: monitored_jobs.company_name,
    title: monitored_jobs.title,
    // Capped the same way jdMatch caps it. The JD is read here only so that the handful of
    // resolution rules which consult it (location preference, posting season) see the same text the
    // submission runner will, and a multi-kilobyte read on the Apply path is affordable exactly
    // once per apply.
    description: sql<string>`left(${monitored_jobs.description}, 20000)`,
    ats_name: career_page_sources.ats_name,
    board_token: career_page_sources.board_token,
  })
    .from(monitored_jobs)
    .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
    .where(and(eq(monitored_jobs.id, jobId), eq(career_page_sources.enabled, true)))
    .limit(1);
  if (!row) return null;
  const applyUrl = canonicalMonitoredPortalUrl(row.apply_url, row.ats_name, row.board_token) ?? row.apply_url;
  if (!applyUrl) return null;
  return {
    applyUrl,
    portal: detectPortal(applyUrl),
    company: row.company_name,
    title: row.title,
    description: row.description ?? '',
  };
}

type StoredScan = {
  apply_url: string;
  portal: string | null;
  questions: PostingQuestion[];
  discovery_status: PostingQuestionsDiscoveryStatus;
  discovered_at: Date;
};

async function loadStoredScan(jobId: string): Promise<StoredScan | null> {
  try {
    const [row] = await db.select().from(posting_questions)
      .where(eq(posting_questions.job_id, jobId)).limit(1);
    if (!row) return null;
    return {
      apply_url: row.apply_url,
      portal: row.portal,
      questions: Array.isArray(row.questions) ? (row.questions as PostingQuestion[]) : [],
      discovery_status: row.discovery_status as PostingQuestionsDiscoveryStatus,
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
  status: PostingQuestionsDiscoveryStatus,
): Promise<void> {
  const now = new Date();
  try {
    await db.insert(posting_questions).values({
      job_id: jobId,
      apply_url: target.applyUrl,
      portal: target.portal,
      questions,
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
 * Read the employer's form. One managed browser run, no fills, no upload, no screenshot.
 *
 * The option lists come back as separate extracts and are stitched onto the discovered questions
 * the same way the submission runner stitches them, because a closed list without its options is
 * the difference between "choose one of these four" and a blank box.
 */
export async function scanPostingQuestions(
  target: PostingTarget,
): Promise<{ questions: PostingQuestion[]; status: PostingQuestionsDiscoveryStatus }> {
  const portal = target.portal;
  if (!portal) return { questions: [], status: 'failed' };
  const result = await runManagedBrowser(target.applyUrl, buildManagedPrescriptActions(portal), { screenshot: false });
  const discovered = attachManagedFieldOptions(
    (result.discovered ?? []) as DiscoveredQuestion[],
    managedResultFieldOptions(result),
  );
  const questions = postingQuestionsFromDiscovered(discovered);
  // Zero controls is not "this form has no questions". It is a page this run could not read, and
  // storing it as a good scan would tell every later applicant the form is empty for a fortnight.
  return { questions, status: questions.length > 0 ? 'ok' : 'form_not_reached' };
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
    if (!target) return reply.status(404).send({ error: 'That posting is not on the board.' });

    const stored = await loadStoredScan(params.jobId);
    let questions = stored?.questions ?? [];
    let status: PostingQuestionsDiscoveryStatus = stored?.discovery_status ?? 'failed';
    let scanned = false;

    if (!postingQuestionsAreFresh(stored, target.applyUrl)) {
      if (!isBrowserbaseConfigured() && !isManagedStratusProvider()) {
        // No browser on this deployment. Answer honestly with whatever is cached rather than 503:
        // an empty pre-script means the Apply screen asks nothing extra, which is exactly today's
        // behaviour, and a 503 would break Apply on a deployment where it currently works.
        return reply.status(200).send(prescriptResponse(params.jobId, target, questions, status, stored?.discovered_at ?? null, false, await resolveFor(userId, questions, target)));
      }
      // A managed browser run per call would be a loop waiting to happen if the client retried, so
      // it sits behind the same hourly ceiling as the other browser-backed endpoint.
      if (!(await allowHourly(userId, 'postingQuestions', LIMITS.perHour.postingQuestions))) {
        return rateLimitedReply(reply);
      }
      try {
        const scan = await scanPostingQuestions(target);
        questions = scan.questions;
        status = scan.status;
        scanned = true;
        await storeScan(params.jobId, target, questions, status);
      } catch (err) {
        fastify.log.warn({ err, userId, jobId: params.jobId }, 'posting question pre-scan failed');
        // Keep whatever was cached. A failed scan must not empty a good one.
        if (!stored) {
          questions = [];
          status = 'failed';
          await storeScan(params.jobId, target, [], 'failed');
        }
      }
    }

    const resolution = await resolveFor(userId, questions, target);
    return reply.status(200).send(
      prescriptResponse(params.jobId, target, questions, status, scanned ? new Date() : (stored?.discovered_at ?? null), scanned, resolution),
    );
  });
}

async function resolveFor(userId: string, questions: PostingQuestion[], target: PostingTarget) {
  const [profile, saved] = await Promise.all([
    loadApplicationProfileLike(userId),
    loadSavedAnswers(userId),
  ]);
  return resolvePrescript(questions, profile, saved, { company: target.company, jdText: target.description });
}

function prescriptResponse(
  jobId: string,
  target: PostingTarget,
  questions: PostingQuestion[],
  status: PostingQuestionsDiscoveryStatus,
  discoveredAt: Date | null,
  scanned: boolean,
  resolution: ReturnType<typeof resolvePrescript>,
) {
  return {
    job_id: jobId,
    company: target.company,
    role: target.title,
    apply_url: target.applyUrl,
    portal: target.portal,
    discovery_status: status,
    discovered_at: discoveredAt ? discoveredAt.toISOString() : null,
    scanned_now: scanned,
    question_count: questions.length,
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
