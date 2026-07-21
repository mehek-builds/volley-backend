import { randomUUID } from 'node:crypto';
import { put } from '@vercel/blob';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { application_profile, generated_resumes, profiles, users } from '../db/schema';
import { readApplicationReview, type ApplicationReviewState } from '../lib/applicationReview';
import {
  connectToSession,
  createBrowserContext,
  createBrowserSession,
  getBrowserSession,
  isBrowserbaseConfigured,
} from '../lib/browserbase';
import { clickFinalSubmit, detectPortal, fillPortal, readReceipt, type SubmissionPacket } from '../lib/portalSubmission';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import { resolveBlobUrl } from '../lib/resumeAccess';
import { decryptRow } from './applicationProfile';

type ResumeRow = typeof generated_resumes.$inferSelect;
type StoredSpec = Record<string, unknown>;

function nextReview(current: ApplicationReviewState, patch: Partial<ApplicationReviewState>): ApplicationReviewState {
  return { ...current, ...patch, updated_at: new Date().toISOString() };
}

async function writeReview(row: ResumeRow, review: ApplicationReviewState) {
  await db.update(generated_resumes).set({ spec: { ...(row.spec as StoredSpec), _review: review } }).where(eq(generated_resumes.id, row.id));
}

async function buildPacket(row: ResumeRow): Promise<SubmissionPacket> {
  const stored = row.spec as StoredSpec;
  const contact = (stored._contact ?? {}) as Record<string, unknown>;
  const [userRow, appRow, profileRow] = await Promise.all([
    db.select().from(users).where(eq(users.id, row.user_id)).limit(1),
    db.select().from(application_profile).where(eq(application_profile.user_id, row.user_id)).limit(1),
    db.select().from(profiles).where(eq(profiles.user_id, row.user_id)).limit(1),
  ]);
  const app = appRow[0] ? decryptRow(appRow[0]) : {};
  const parsed = (profileRow[0]?.parsed_json ?? {}) as Record<string, unknown>;
  const review = readApplicationReview(stored);
  if (!review) throw new Error('Application review packet is missing');
  const blobUrl = await resolveBlobUrl(row.resume_object_key);
  if (!blobUrl) throw new Error('Generated resume file is unavailable');
  const response = await fetch(blobUrl);
  if (!response.ok) throw new Error('Generated resume file could not be downloaded');
  const resume = Buffer.from(await response.arrayBuffer());
  const fullName = String(contact.full_name ?? parsed.full_name ?? '').trim();
  const email = String(contact.email ?? userRow[0]?.email ?? '').trim();
  if (!fullName || !email) throw new Error('Full name and email are required before submission');
  return {
    fullName,
    email,
    phone: typeof app.phone === 'string' ? app.phone : undefined,
    city: typeof app.address_city === 'string' ? app.address_city : undefined,
    linkedinUrl: typeof app.linkedin_url === 'string' ? app.linkedin_url : undefined,
    githubUrl: typeof app.github_url === 'string' ? app.github_url : undefined,
    portfolioUrl: typeof app.portfolio_url === 'string' ? app.portfolio_url : undefined,
    resume,
    resumeName: `litos-${row.id}.pdf`,
    questions: review.questions.map((item) => ({ question: item.question, answer: item.answer })),
  };
}

async function prepare(row: ResumeRow, fastify: FastifyInstance) {
  const stored = row.spec as StoredSpec;
  const current = readApplicationReview(stored);
  if (!current?.portal_url) throw new Error('Application portal URL is missing');
  const portal = detectPortal(current.portal_url);
  const runId = current.submission_run_id ?? randomUUID();
  const contextId = current.browser_context_id ?? (await createBrowserContext());
  const session = await createBrowserSession(contextId);
  {
    const connected = await connectToSession(session);
    const page = connected.page;
    await writeReview(row, nextReview(current, {
      status: 'filling',
      submission_run_id: runId,
      browser_context_id: contextId,
      browser_session_id: session.id,
      submission_error: undefined,
    }));
    await page.goto(current.portal_url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const packet = await buildPacket(row);
    const result = await fillPortal(page, portal, packet);
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    const preview = await put(`users/${row.user_id}/submission-runs/${runId}/filled.png`, screenshot, {
      access: 'public',
      contentType: 'image/png',
    });
    const review = nextReview(current, {
      status: result.blockers.length > 0 ? 'needs_attention' : 'ready_for_final_approval',
      submission_run_id: runId,
      browser_context_id: contextId,
      browser_session_id: session.id,
      filled_fields: result.filledFields,
      preview_screenshot_url: preview.url,
      attention_reason: result.blockers.join('\n') || undefined,
      handoff_expires_at: new Date(Date.now() + 55 * 60_000).toISOString(),
      submission_error: undefined,
    });
    await writeReview(row, review);
    fastify.log.info({ applicationId: row.id, portal, status: review.status }, 'Application portal prepared');
  }
}

async function submit(row: ResumeRow, fastify: FastifyInstance) {
  const current = readApplicationReview(row.spec);
  if (!current?.browser_session_id || !current.submission_run_id) throw new Error('Prepared browser session is missing');
  const session = await getBrowserSession(current.browser_session_id);
  let browser;
  try {
    const connected = await connectToSession(session);
    browser = connected.browser;
    const page = connected.page;
    await clickFinalSubmit(page);
    const receipt = await readReceipt(page);
    const capturedAt = new Date().toISOString();
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    const blob = await put(
      `users/${row.user_id}/submission-runs/${current.submission_run_id}/receipt.png`,
      screenshot,
      { access: 'public', contentType: 'image/png' },
    );
    await writeReview(row, nextReview(current, {
      status: 'submitted',
      submitted_at: capturedAt,
      submission_error: undefined,
      receipt: {
        confirmation_text: receipt.confirmationText,
        final_url: receipt.finalUrl,
        screenshot_url: blob.url,
        captured_at: capturedAt,
        reference_id: receipt.referenceId,
      },
    }));
    fastify.log.info({ applicationId: row.id }, 'Application submission receipt verified');
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function fail(row: ResumeRow, error: unknown) {
  const current = readApplicationReview(row.spec);
  if (!current) return;
  const message = error instanceof Error ? error.message : 'Submission runner failed';
  const externalGate = message.includes('Browserbase is not configured');
  await writeReview(row, nextReview(current, {
    status: externalGate ? 'submit_requested' : 'failed',
    submission_error: message,
  }));
}

export async function processSubmissionApplication(applicationId: string, fastify: FastifyInstance): Promise<ApplicationReviewState | null> {
  const rows = await db.select().from(generated_resumes).where(eq(generated_resumes.id, applicationId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  try {
    const review = readApplicationReview(row.spec);
    if (review?.status === 'submit_requested') await prepare(row, fastify);
    if (review?.status === 'submitting') await submit(row, fastify);
  } catch (error) {
    fastify.log.error({ error, applicationId: row.id }, 'Application runner step failed');
    await fail(row, error);
  }
  const refreshed = await db.select().from(generated_resumes).where(eq(generated_resumes.id, applicationId)).limit(1);
  return refreshed[0] ? readApplicationReview(refreshed[0].spec) : null;
}

export async function submissionRunnerRoutes(fastify: FastifyInstance) {
  fastify.get('/internal/application-submission-runner', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isCronConfigured() || !isCronAuthorized(request)) return reply.status(401).send({ error: 'Unauthorized' });
    if (!isBrowserbaseConfigured()) return reply.status(503).send({ error: 'Browserbase is not configured', processed: 0 });
    const rows = await db
      .select()
      .from(generated_resumes)
      .where(sql`${generated_resumes.spec}->'_review'->>'status' in ('submit_requested', 'submitting')`)
      .limit(2);
    let processed = 0;
    for (const row of rows) {
      try {
        await processSubmissionApplication(row.id, fastify);
        processed += 1;
      } catch (error) {
        fastify.log.error({ error, applicationId: row.id }, 'Application runner step failed');
        await fail(row, error);
      }
    }
    return reply.send({ processed, configured: true });
  });
}
