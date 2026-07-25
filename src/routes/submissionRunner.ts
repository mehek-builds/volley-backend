import { randomUUID } from 'node:crypto';
import { put } from '@vercel/blob';
import type { Page } from 'playwright-core';
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
  isManagedStratusProvider,
  runManagedBrowser,
} from '../lib/browserbase';
import {
  buildManagedDiscoveryActions,
  buildManagedPortalActions,
  clickFinalSubmit,
  detectPortal,
  fillPortal,
  hasCoverLetterUpload,
  managedResultHasCoverLetterUpload,
  navigateToApplicationForm,
  portalApplicationUrl,
  readManagedReceipt,
  readReceipt,
  type SubmissionPacket,
  type SupportedPortal,
} from '../lib/portalSubmission';
import { sanitizeProviderBlockers } from '../lib/fieldLabel';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import { resolveBlobUrl } from '../lib/resumeAccess';
import { decryptRow } from './applicationProfile';
import { readExperienceBank } from '../db/experienceBank';
import { declaredSkillsList } from './profile';
import { draftApplicationAnswer } from '../llm/applicationAnswer';
import { isBillingOrAuthFailure } from './resume';
import {
  discoverPageQuestions,
  isOpenEndedQuestion,
  isRefusedQuestion,
  resolveKnownAnswer,
  fitToBudget,
  WORK_ELIGIBILITY_QUESTION,
  workEligibilitySkipReason,
  type ApplicationProfileLike,
  type DiscoveredQuestion,
} from '../lib/questionDiscovery';
import type { ApplicationReviewQuestion } from '../lib/applicationReview';
import { generateStoredCoverLetter, storedCoverLetter } from '../lib/coverLetterService';

type ResumeRow = typeof generated_resumes.$inferSelect;
type StoredSpec = Record<string, unknown>;

function nextReview(current: ApplicationReviewState, patch: Partial<ApplicationReviewState>): ApplicationReviewState {
  return { ...current, ...patch, updated_at: new Date().toISOString() };
}

async function writeReview(row: ResumeRow, review: ApplicationReviewState) {
  await db.update(generated_resumes).set({
    spec: sql`jsonb_set(${generated_resumes.spec}, '{_review}', ${JSON.stringify(review)}::jsonb, true)`,
  }).where(eq(generated_resumes.id, row.id));
}

async function buildPacket(row: ResumeRow): Promise<SubmissionPacket> {
  const stored = row.spec as StoredSpec;
  const contact = (stored._contact ?? {}) as Record<string, unknown>;
  const coverLetterMeta = (stored._cover_letter ?? {}) as Record<string, unknown>;
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
  let coverLetter: Buffer | undefined;
  if (typeof coverLetterMeta.object_key === 'string') {
    const coverLetterUrl = await resolveBlobUrl(coverLetterMeta.object_key);
    if (!coverLetterUrl) throw new Error('Generated cover letter file is unavailable');
    const coverLetterResponse = await fetch(coverLetterUrl);
    if (!coverLetterResponse.ok) throw new Error('Generated cover letter file could not be downloaded');
    coverLetter = Buffer.from(await coverLetterResponse.arrayBuffer());
  }
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
    coverLetter,
    coverLetterName: coverLetter
      ? String(coverLetterMeta.file_name ?? `litos-${row.id}-cover-letter.pdf`)
      : undefined,
    questions: review.questions.map((item) => ({ question: item.question, answer: item.answer })),
  };
}

function omitCoverLetter(packet: SubmissionPacket): SubmissionPacket {
  return { ...packet, coverLetter: undefined, coverLetterName: undefined };
}

async function packetForCoverLetterCapability(row: ResumeRow, supported: boolean): Promise<SubmissionPacket> {
  if (!supported) return omitCoverLetter(await buildPacket(row));
  if (!storedCoverLetter(row)) await generateStoredCoverLetter(row, false, true);
  const rows = await db.select().from(generated_resumes).where(eq(generated_resumes.id, row.id)).limit(1);
  if (!rows[0]) throw new Error('Application packet disappeared while generating its cover letter');
  return buildPacket(rows[0]);
}

// R-055 fix: the dashboard flow used to send only whatever `review.questions` the client already
// supplied (empty on a fresh dashboard-only run), so a real posting's custom questions - GPA,
// sponsorship, GitHub, essays - were never attempted. This resolves a raw discovered-question list
// (however the caller obtained it) against the stored profile, drafts the genuinely open-ended
// ones through the SAME essay endpoint the extension calls, and otherwise leaves a question alone
// rather than guess.
//
// Provider-agnostic on purpose: the direct-Playwright path gets `discovered` from its own live
// Page (discoverPageQuestions), and the managed-Stratus path gets it from the 'discover' action's
// result (buildManagedDiscoveryActions / stratus-browser-cloud PR #7) - this function has no
// browser dependency of its own, so both callers share one resolution path and can never drift on
// what counts as an answerable question.
async function discoverAndResolveQuestions(
  discovered: DiscoveredQuestion[],
  row: ResumeRow,
  current: ApplicationReviewState,
  ap: ApplicationProfileLike,
): Promise<{ questions: ApplicationReviewQuestion[]; attentionReasons: string[] }> {
  const existingLabels = new Set(current.questions.map((q) => q.question.trim().toLowerCase()));
  const questions: ApplicationReviewQuestion[] = [];
  const attentionReasons: string[] = [];

  let bank: Awaited<ReturnType<typeof readExperienceBank>> | null = null;
  let declaredSkills: string[] = [];
  let school: string | undefined;
  let gradYear: number | undefined;
  let company = 'this company';
  try {
    company = new URL(current.portal_url!).hostname.replace(/^www\./, '').split('.')[0];
  } catch {
    // keep the fallback
  }

  for (const field of discovered) {
    const label = field.label;
    if (existingLabels.has(label)) continue; // already answered by the client or a prior run
    if (isRefusedQuestion(label)) {
      if (WORK_ELIGIBILITY_QUESTION.test(label)) attentionReasons.push(workEligibilitySkipReason(label));
      continue; // EEO/SSN/etc: never answered, never surfaced as a field to fill
    }

    const known = resolveKnownAnswer(label, field.inputType, ap, current.jd_text);
    if (known && 'value' in known) {
      questions.push({ id: randomUUID(), question: label, answer: known.value, kind: 'required', required: false });
      continue;
    }
    if (known && 'skipReason' in known) {
      attentionReasons.push(known.skipReason);
      continue;
    }
    if (!isOpenEndedQuestion(label)) continue; // not a known field, not an essay: leave it alone

    // Open-ended: draft it through the same in-house endpoint the extension calls, then always
    // hold it for review (an unreviewed AI draft answering a real employer's question is exactly
    // what the extension's "AI draft - review before submitting" flag exists to catch).
    try {
      if (bank === null) {
        bank = await readExperienceBank(row.user_id);
        const [profileRow] = await db.select().from(profiles).where(eq(profiles.user_id, row.user_id)).limit(1);
        const parsedProfile = profileRow?.parsed_json as { school?: string; grad_year?: number } | undefined;
        school = parsedProfile?.school;
        gradYear = parsedProfile?.grad_year;
        declaredSkills = declaredSkillsList(profileRow?.skills);
      }
      if (bank.length === 0) {
        attentionReasons.push(`open-ended question left for you (no experience bank on file): "${label.slice(0, 60)}"`);
        continue;
      }
      const { answer } = await draftApplicationAnswer(
        label,
        company,
        current.role ?? 'this role',
        current.jd_text,
        bank,
        { school, grad_year: gradYear },
        declaredSkills,
      );
      const fitted = answer ? fitToBudget(answer, field.maxLength ?? 100_000) : null;
      if (!fitted) {
        attentionReasons.push(`open-ended question left for you (could not draft a confident answer): "${label.slice(0, 60)}"`);
        continue;
      }
      questions.push({ id: randomUUID(), question: label, answer: fitted, kind: 'essay', required: false });
      attentionReasons.push(`AI-drafted answer needs your review before this goes out: "${label.slice(0, 60)}"`);
    } catch (error) {
      if (isBillingOrAuthFailure(error)) throw error; // this is a real outage, not a per-field skip
      attentionReasons.push(`open-ended question left for you (draft generation failed): "${label.slice(0, 60)}"`);
    }
  }

  return { questions, attentionReasons };
}

async function loadApplicationProfileLike(userId: string): Promise<ApplicationProfileLike> {
  const [appRow] = await db.select().from(application_profile).where(eq(application_profile.user_id, userId)).limit(1);
  const app = appRow ? (decryptRow(appRow) as Record<string, unknown>) : {};
  const str = (key: string): string | undefined => (typeof app[key] === 'string' ? (app[key] as string) : undefined);
  return {
    phone: str('phone'),
    address_city: str('address_city'),
    address_state: str('address_state'),
    address_country: str('address_country'),
    linkedin_url: str('linkedin_url'),
    github_url: str('github_url'),
    portfolio_url: str('portfolio_url'),
    citizenship: str('citizenship'),
    date_of_birth: str('date_of_birth'),
    availability_date: str('availability_date'),
    availability_term: str('availability_term'),
    desired_salary: str('desired_salary'),
    desired_salary_currency: str('desired_salary_currency'),
    gpa: str('gpa'),
    gpa_scale: str('gpa_scale'),
    major: str('major'),
    referral_source_default: str('referral_source_default'),
  };
}

async function prepareManaged(
  row: ResumeRow,
  current: ApplicationReviewState,
  portal: SupportedPortal,
  runId: string,
  fastify: FastifyInstance,
) {
  await writeReview(row, nextReview(current, {
    status: 'filling',
    submission_run_id: runId,
    submission_error: undefined,
  }));
  let packet = omitCoverLetter(await buildPacket(row));

  // R-055 on the managed path: a cheap first call fills only the fixed fields and asks
  // stratus-browser-cloud's 'discover' action (PR #7) to scan the resulting page for custom
  // questions - the only way this path ever sees the live DOM, since /api/run is otherwise
  // stateless. Resolved through the SAME questionDiscovery.ts logic the direct-Playwright path
  // uses, so the two providers can never answer a question differently.
  const applicationUrl = portalApplicationUrl(portal, current.portal_url!);
  const discoveryResult = await runManagedBrowser(applicationUrl, buildManagedDiscoveryActions(portal, packet)).catch(() => null);
  const coverLetterSupported = managedResultHasCoverLetterUpload(discoveryResult, portal);
  packet = await packetForCoverLetterCapability(row, coverLetterSupported);
  const { questions: discoveredQuestions, attentionReasons: discoveryAttention } = await discoverAndResolveQuestions(
    discoveryResult?.discovered ?? [],
    row,
    current,
    await loadApplicationProfileLike(row.user_id),
  );
  const mergedQuestions = [...current.questions, ...discoveredQuestions];
  packet.questions = [...packet.questions, ...discoveredQuestions.map((q) => ({ question: q.question, answer: q.answer }))];

  const result = await runManagedBrowser(applicationUrl, buildManagedPortalActions(portal, packet));
  if (!result.screenshot) throw new Error('Stratus managed browser did not return a preview screenshot');
  const preview = await put(
    `users/${row.user_id}/submission-runs/${runId}/filled.png`,
    Buffer.from(result.screenshot, 'base64'),
    // addRandomSuffix because a RETRY reuses the run id (runId falls back to
    // current.submission_run_id), so a second attempt writes the same key and Vercel Blob rejects
    // it: "This blob already exists". That turned an otherwise SUCCESSFUL run, five fields filled
    // and a preview captured, into status `failed`. Suffixing also keeps each attempt's evidence
    // instead of overwriting the previous one, which matters when comparing a retry to what it
    // replaced.
    { access: 'public', contentType: 'image/png', addRandomSuffix: true },
  );
  // Sanitized at the boundary, not upstream: the managed provider scans the form in its own
  // service and returns finished sentences, so it never passes through this repo's label
  // resolution. Live QA proved that gap by showing three raw UUIDs on a real Ashby posting.
  const blockers = sanitizeProviderBlockers(result.blockers ?? []);
  const review = nextReview(current, {
    status: blockers.length > 0 || discoveryAttention.length > 0
      ? 'needs_attention'
      : current.submission_authorized_at ? 'submitting' : 'ready_for_final_approval',
    submission_run_id: runId,
    filled_fields: result.filledFields ?? [],
    preview_screenshot_url: preview.url,
    questions: mergedQuestions,
    cover_letter_supported: coverLetterSupported,
    attention_reason: [...blockers, ...discoveryAttention].join('\n') || undefined,
    handoff_expires_at: new Date(Date.now() + 55 * 60_000).toISOString(),
    submission_error: undefined,
  });
  await writeReview(row, review);
  fastify.log.info({ applicationId: row.id, portal, status: review.status }, 'Application portal prepared with Stratus Sandbox');
}

async function prepare(row: ResumeRow, fastify: FastifyInstance) {
  const stored = row.spec as StoredSpec;
  const current = readApplicationReview(stored);
  if (!current?.portal_url) throw new Error('Application portal URL is missing');
  const portal = detectPortal(current.portal_url);
  const runId = current.submission_run_id ?? randomUUID();
  if (isManagedStratusProvider()) {
    await prepareManaged(row, current, portal, runId, fastify);
    return;
  }
  const contextId = current.browser_context_id ?? (await createBrowserContext());
  const session = await createBrowserSession(contextId, current.portal_url);
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
    await navigateToApplicationForm(page, portal); // no-op except SmartRecruiters's JD-page/form-page split
    const coverLetterSupported = await hasCoverLetterUpload(page, portal);
    const packet = await packetForCoverLetterCapability(row, coverLetterSupported);

    // R-055: discover and resolve the posting's own custom questions before filling, so a
    // dashboard-only submission does not depend on the extension having run first.
    const discovered = await discoverPageQuestions(page).catch(() => []);
    const { questions: discoveredQuestions, attentionReasons: discoveryAttention } =
      await discoverAndResolveQuestions(discovered, row, current, await loadApplicationProfileLike(row.user_id));
    const mergedQuestions = [...current.questions, ...discoveredQuestions];
    packet.questions = [...packet.questions, ...discoveredQuestions.map((q) => ({ question: q.question, answer: q.answer }))];

    const result = await fillPortal(page, portal, packet);
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    const preview = await put(`users/${row.user_id}/submission-runs/${runId}/filled.png`, screenshot, {
      access: 'public',
      contentType: 'image/png',
      // See the managed path above: a retry reuses the run id and would collide.
      addRandomSuffix: true,
    });
    const review = nextReview(current, {
      status: result.blockers.length > 0 || discoveryAttention.length > 0
        ? 'needs_attention'
        : current.submission_authorized_at ? 'submitting' : 'ready_for_final_approval',
      submission_run_id: runId,
      browser_context_id: contextId,
      browser_session_id: session.id,
      filled_fields: result.filledFields,
      preview_screenshot_url: preview.url,
      questions: mergedQuestions,
      cover_letter_supported: coverLetterSupported,
      // Already human on this path, but sanitized anyway so both providers are held to one
      // guarantee and a future change to either cannot quietly reintroduce identifiers.
      attention_reason:
        [...sanitizeProviderBlockers(result.blockers), ...discoveryAttention].join('\n') || undefined,
      handoff_expires_at: new Date(Date.now() + 55 * 60_000).toISOString(),
      submission_error: undefined,
    });
    await writeReview(row, review);
    fastify.log.info({ applicationId: row.id, portal, status: review.status }, 'Application portal prepared');
  }
}

async function submit(row: ResumeRow, fastify: FastifyInstance) {
  const current = readApplicationReview(row.spec);
  if (!current?.submission_run_id || !current.portal_url) throw new Error('Prepared browser run is missing');
  if (isManagedStratusProvider()) {
    const portal = detectPortal(current.portal_url);
    const builtPacket = await buildPacket(row);
    const packet = current.cover_letter_supported === true ? builtPacket : omitCoverLetter(builtPacket);
    const result = await runManagedBrowser(portalApplicationUrl(portal, current.portal_url), buildManagedPortalActions(portal, packet, true));
    const receipt = readManagedReceipt(result);
    if (!result.screenshot) throw new Error('Stratus managed browser did not return a receipt screenshot');
    const capturedAt = new Date().toISOString();
    const blob = await put(
      `users/${row.user_id}/submission-runs/${current.submission_run_id}/receipt.png`,
      Buffer.from(result.screenshot, 'base64'),
      // A receipt is the proof an application was actually submitted, so a collision here would
      // fail the run at the worst possible moment: after the employer already has it.
      { access: 'public', contentType: 'image/png', addRandomSuffix: true },
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
    fastify.log.info({ applicationId: row.id }, 'Application submission receipt verified with Stratus Sandbox');
    return;
  }
  if (!current.browser_session_id) throw new Error('Prepared browser session is missing');
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
      { access: 'public', contentType: 'image/png', addRandomSuffix: true },
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
  const externalGate = /browserbase|stratus managed browser is not configured|secure browser provider is not configured/i.test(message);
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
    let workingRow = row;
    let review = readApplicationReview(workingRow.spec);
    if (review?.status === 'submit_requested') {
      await prepare(workingRow, fastify);
      const preparedRows = await db.select().from(generated_resumes).where(eq(generated_resumes.id, applicationId)).limit(1);
      if (!preparedRows[0]) return null;
      workingRow = preparedRows[0];
      review = readApplicationReview(workingRow.spec);
    }
    if (review?.status === 'submitting') await submit(workingRow, fastify);
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
    if (!isBrowserbaseConfigured()) return reply.status(503).send({ error: 'Secure portal runner is not configured', processed: 0 });
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
