import { randomUUID } from 'node:crypto';
import { decide, isBlocked } from '../engine/eligibility';
import { put } from '@vercel/blob';
import { chromium, type Page } from 'playwright-core';
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
  blockersIncludeCaptcha,
  buildManagedCaptchaProbeActions,
  buildManagedDiscoveryActions,
  detectCaptchaProvider,
  captchaProviderForFamily,
  buildManagedPortalActions,
  CaptchaUnresolvedError,
  clickFinalSubmit,
  detectPortal,
  managedResultRequiresCaptchaAttention,
  fillPortal,
  hasCoverLetterUpload,
  managedResultHasCoverLetterUpload,
  navigateToApplicationForm,
  portalApplicationUrl,
  isAccountWalledFamily,
  isCaptchaGatedFamily,
  portalCanAutoSubmit,
  portalHandoffReason,
  readManagedReceipt,
  unattendedHandoffReason,
  readReceipt,
  type SubmissionPacket,
  type SupportedPortal,
  NoSubmitControlError,
} from '../lib/portalSubmission';
import { applyReviewPatch, beginStall } from '../lib/applicationStall';
import { sanitizeProviderBlockers } from '../lib/fieldLabel';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import { resolveBlobUrl } from '../lib/resumeAccess';
import { decryptRow } from './applicationProfile';
import { readExperienceBank } from '../db/experienceBank';
import { declaredSkillsList } from './profile';
import { draftApplicationAnswer } from '../llm/applicationAnswer';
import { isBillingOrAuthFailure } from './resume';
import { completeEmailVerificationIfPresent, type BrowserVerificationResult } from '../lib/browserVerification';
import {
  discoverPageQuestions,
  isOpenEndedQuestion,
  isRefusedQuestion,
  normalizeDiscoveredLabel,
  normalizeReviewQuestionLabel,
  normalizeStoredPortalQuestions,
  resolveKnownAnswer,
  fitToBudget,
  WORK_ELIGIBILITY_QUESTION,
  workEligibilitySkipReason,
  type ApplicationProfileLike,
  type DiscoveredQuestion,
} from '../lib/questionDiscovery';
import type { ApplicationReviewQuestion } from '../lib/applicationReview';
import { generateStoredCoverLetter, storedCoverLetter } from '../lib/coverLetterService';
import { mayClickFinalSubmit, preparedSubmissionStatus } from '../lib/submissionAuthorization';
import { directPreparationIsSafe } from '../lib/submissionSafety';
import {
  autoRunShouldPrepare,
  dailySubmissionCap,
  hasTimeForAnotherApplication,
  submissionBatchSize,
  withinDailyCap,
} from '../lib/submissionQueue';
import { coverLetterFileNameForRole, resumeFileNameForRole } from '../lib/resumeFileName';

type ResumeRow = typeof generated_resumes.$inferSelect;
type StoredSpec = Record<string, unknown>;

type StandingAuthorization = {
  enabled: boolean;
  consentedAt?: string;
  consentVersion?: string;
};

// Thin wrapper. The merge and the stall bookkeeping live in applicationStall.ts so that
// routes/applications.ts, which writes _review directly and knows nothing about stalls, goes
// through exactly the same code.
function nextReview(current: ApplicationReviewState, patch: Partial<ApplicationReviewState>): ApplicationReviewState {
  return applyReviewPatch(current, patch);
}

async function writeReview(row: ResumeRow, review: ApplicationReviewState) {
  await db.update(generated_resumes).set({
    spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(review)}::jsonb, true)`,
  }).where(eq(generated_resumes.id, row.id));
}

async function standingAuthorization(userId: string): Promise<StandingAuthorization> {
  const [user] = await db.select({
    enabled: users.automatic_submission_enabled,
    consentedAt: users.automatic_submission_consented_at,
    consentVersion: users.automatic_submission_consent_version,
  }).from(users).where(eq(users.id, userId)).limit(1);
  return {
    enabled: user?.enabled === true,
    consentedAt: user?.consentedAt?.toISOString(),
    consentVersion: user?.consentVersion ?? undefined,
  };
}

function preparedReviewPatch(authorization: StandingAuthorization, safe: boolean): Partial<ApplicationReviewState> {
  const status = preparedSubmissionStatus({ safe, standingConsentEnabled: authorization.enabled });
  if (status !== 'submitting') return { status };
  const now = new Date().toISOString();
  return {
    status: 'submitting',
    submission_authorization: {
      source: 'standing_consent',
      authorized_at: now,
      consented_at: authorization.consentedAt,
      consent_version: authorization.consentVersion,
    },
  };
}

// Applications that may have REACHED an employer for this user since 00:00 UTC.
//
// Counted off submission_claimed_at, not submitted_at, and the difference is the whole point of the
// cap. A run that clicks submit and then fails to parse the receipt, upload the screenshot or write
// the row lands in needs_attention with no submitted_at, while the employer already has the
// application. Counting confirmed receipts would let a systematic post-click failure send the
// entire queue while the counter read zero, which is precisely the runaway the cap exists to bound.
// The claim is written atomically immediately before the click, so it is the last honest marker of
// "this one may already be out there".
//
// Compared as TEXT, not cast to timestamptz. _review is unvalidated JSON, and one malformed value
// in one row would abort the whole cron request with "invalid input syntax for type timestamp with
// time zone". Every writer of this field uses toISOString(), which is fixed-width UTC, so
// lexicographic order and chronological order are the same thing and the comparison cannot throw.
async function countSubmissionsClaimedToday(userId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(generated_resumes)
    .where(and(
      eq(generated_resumes.user_id, userId),
      sql`${generated_resumes.spec}->'_review'->>'submission_claimed_at' >= ${startOfDay.toISOString()}`,
    ));
  return counted?.total ?? 0;
}

async function claimSubmission(row: ResumeRow): Promise<ResumeRow | null> {
  const current = readApplicationReview(row.spec);
  if (!current || current.status !== 'submitting' || current.submission_claimed_at) return null;
  const claimed = nextReview(current, {
    submission_claimed_at: new Date().toISOString(),
    submission_claim_id: randomUUID(),
  });
  const rows = await db.update(generated_resumes)
    .set({
      spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(claimed)}::jsonb, true)`,
    })
    .where(and(
      eq(generated_resumes.id, row.id),
      sql`${generated_resumes.spec}->'_review'->>'status' = 'submitting'`,
      sql`${generated_resumes.spec}->'_review'->>'submission_claimed_at' is null`,
    ))
    .returning();
  return rows[0] ?? null;
}

async function claimPreparation(row: ResumeRow): Promise<ResumeRow | null> {
  const current = readApplicationReview(row.spec);
  if (!current || current.status !== 'submit_requested') return null;
  const preparing = nextReview(current, {
    status: 'preparing',
    submission_run_id: current.submission_run_id ?? randomUUID(),
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
  });
  const rows = await db.update(generated_resumes)
    .set({
      spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(preparing)}::jsonb, true)`,
    })
    .where(and(
      eq(generated_resumes.id, row.id),
      sql`${generated_resumes.spec}->'_review'->>'status' = 'submit_requested'`,
    ))
    .returning();
  return rows[0] ?? null;
}

async function authorizationValidAtClick(row: ResumeRow, review: ApplicationReviewState): Promise<boolean> {
  if (review.submission_authorization?.source === 'per_application_approval') return true;
  if (review.submission_authorization?.source !== 'standing_consent') return false;
  return (await standingAuthorization(row.user_id)).enabled;
}

async function holdRevokedSubmission(row: ResumeRow, review: ApplicationReviewState) {
  await writeReview(row, nextReview(review, {
    status: 'ready_for_final_approval',
    submission_authorization: undefined,
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
  }));
}

export async function buildPacket(row: ResumeRow, controlledTest = false): Promise<SubmissionPacket> {
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
  if (!review) throw new Error('We could not find this application');
  let resume: Buffer;
  if (controlledTest && process.env.LITOS_ENABLE_TEST_PORTAL === 'true') {
    resume = Buffer.from('%PDF-1.4\n% Litos controlled submission fixture\n%%EOF\n');
  } else {
    const blobUrl = await resolveBlobUrl(row.resume_object_key);
    if (!blobUrl) throw new Error('Generated resume file is unavailable');
    const response = await fetch(blobUrl);
    if (!response.ok) throw new Error('Generated resume file could not be downloaded');
    resume = Buffer.from(await response.arrayBuffer());
  }
  let coverLetter: Buffer | undefined;
  if (typeof coverLetterMeta.object_key === 'string' && typeof coverLetterMeta.approved_at === 'string') {
    const coverLetterUrl = await resolveBlobUrl(coverLetterMeta.object_key);
    if (!coverLetterUrl) throw new Error('Generated cover letter file is unavailable');
    const coverLetterResponse = await fetch(coverLetterUrl);
    if (!coverLetterResponse.ok) throw new Error('Generated cover letter file could not be downloaded');
    coverLetter = Buffer.from(await coverLetterResponse.arrayBuffer());
  }
  const fullName = String(contact.full_name ?? parsed.full_name ?? '').trim();
  const email = String(contact.email ?? userRow[0]?.email ?? '').trim();
  if (!fullName || !email) throw new Error('Full name and email are required before submission');
  const roleTitle = (row.job_context as { role?: unknown } | null)?.role;
  return {
    fullName,
    email,
    phone: typeof app.phone === 'string' ? app.phone : undefined,
    city: typeof app.address_city === 'string' ? app.address_city : undefined,
    linkedinUrl: typeof app.linkedin_url === 'string' ? app.linkedin_url : undefined,
    githubUrl: typeof app.github_url === 'string' ? app.github_url : undefined,
    portfolioUrl: typeof app.portfolio_url === 'string' ? app.portfolio_url : undefined,
    resume,
    resumeName: resumeFileNameForRole(fullName, roleTitle),
    coverLetter,
    coverLetterName: coverLetter
      ? coverLetterFileNameForRole(fullName, roleTitle)
      : undefined,
    mostRecentRole: readMostRecentRole(parsed),
    questions: review.questions.map((item) => ({ question: item.question, answer: item.answer })),
  };
}

// The first entry of the parsed resume's experience list, for portals that ask for work history as
// structured fields (Paylocity). First, not "latest by date": resumes are written most-recent-first
// and the parser preserves that order, whereas the date strings are free text ("Jun 2025 - Present",
// "Summer 2024") and cannot be reliably compared. Trusting the resume's own ordering is both simpler
// and closer to what the student actually wrote.
export function readMostRecentRole(parsed: Record<string, unknown>): SubmissionPacket['mostRecentRole'] {
  const experience = parsed.experience;
  if (!Array.isArray(experience) || experience.length === 0) return undefined;
  // The `as` cast below is only safe behind this guard: `experience` is whatever the resume parser
  // wrote into parsed_json, so entry[0] can be null, a string, or an array. It used to throw a
  // TypeError on `entry.company` for a null entry - and because buildPacket runs on EVERY prepare
  // and submit, one malformed parsed profile would have failed Greenhouse/Lever/Ashby runs that
  // previously succeeded. A portal-specific nicety must never break the portals that came before it.
  const raw = experience[0];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const company = str(entry.company) ?? str(entry.org);
  const title = str(entry.title);
  // Both are required by every portal that asks for work history at all, so a partial entry is
  // worse than none: it produces a row the student must notice and finish rather than one she can
  // simply confirm.
  if (!company || !title) return undefined;
  return { company, title, summary: str(entry.description), startDate: str(entry.start), endDate: str(entry.end) };
}

function omitCoverLetter(packet: SubmissionPacket): SubmissionPacket {
  return { ...packet, coverLetter: undefined, coverLetterName: undefined };
}

function normalizedFilledFields(fields: readonly string[] | undefined): Set<string> {
  return new Set((fields ?? []).map((field) => field.toLowerCase().replace(/[^a-z0-9]/g, '')));
}

function filledFieldBlockers(fields: readonly string[] | undefined, packet: SubmissionPacket): string[] {
  const normalized = normalizedFilledFields(fields);
  const has = (needle: string) => [...normalized].some((field) => field.includes(needle));
  const issues: string[] = [];
  if (!has('email')) issues.push('The filled form did not record an email field.');
  if (!has('resume')) issues.push('The filled form did not record a resume upload.');
  if (!has('name') && !(has('firstname') && has('lastname'))) {
    issues.push('The filled form did not record the applicant name fields.');
  }
  if (packet.coverLetter && !has('cover')) {
    issues.push('The filled form did not record the cover letter attachment.');
  }
  return issues;
}

function previewContentBlockers(text: string | undefined): string[] {
  const normalized = (text ?? '').toLowerCase();
  if (!normalized.trim()) return ['The filled form preview did not include readable page text.'];
  if (
    /sorry,?\s+but\s+we\s+can(?:not|'t)\s+find\s+that\s+page/.test(normalized)
    || /\b(?:404|page not found|not found|access denied)\b/.test(normalized)
    || /\b(?:sign in|log in|login required)\b/.test(normalized)
  ) {
    return ['The filled form preview looks like an error, login, or missing page instead of a completed application form.'];
  }
  return [];
}

function preparationEvidenceBlockers(result: { text?: string; filledFields?: string[] }, packet: SubmissionPacket): string[] {
  return [
    ...previewContentBlockers(result.text),
    ...filledFieldBlockers(result.filledFields, packet),
  ];
}

/**
 * Build the packet, writing a cover letter first when the portal has somewhere to put one.
 *
 * A cover letter problem MUST NOT kill the run. This used to throw straight out of the middle of a
 * prepare, which took the whole submission down: the dashboard was still showing "Litos is typing
 * in your saved answers" while the run behind it was already dead, and the applicant had no error,
 * no retry and no way to tell. Reproduced in prod on a Greenhouse posting on 2026-08-04, where a
 * cover letter that had merely failed to PARSE aborted a submission that was otherwise fine.
 *
 * Degrading is safe here, and not just tolerable: the generated letter is written unapproved
 * (approved=false), and buildPacket only ATTACHES a cover letter once approved_at is set. So a
 * failure at this step costs the applicant nothing they were about to send - it only means the
 * draft is not waiting for them on the approval screen. They can still write or retry one from the
 * dashboard. Losing the whole submission to protect an artifact the packet would not have carried
 * is strictly worse than continuing without it.
 *
 * The reason is returned rather than swallowed so the caller can put it in front of the applicant
 * as an attention reason. A silent degrade would be its own version of this bug.
 *
 * That reason is a FIXED sentence, and the thrown message is logged instead of interpolated. The
 * two failures this generator actually throws are "Cover letter truncated at max_tokens (1203
 * chars) - raise the cap" and "Claude returned an invalid cover letter: {"body":"I'm writing to
 * apply for the Software Eng..." - one an instruction to an operator, the other 200 characters of
 * raw model output with a vendor name in front of it. Both were reaching a student's screen. They
 * also describe one situation from the applicant's side, with one recovery, so there is nothing a
 * second variant of the sentence could usefully say. Whoever has to fix the generator reads logs.
 */
async function packetForCoverLetterCapability(
  row: ResumeRow,
  supported: boolean,
  fastify: FastifyInstance,
): Promise<{ packet: SubmissionPacket; coverLetterIssue?: string }> {
  if (!supported) return { packet: omitCoverLetter(await buildPacket(row)) };
  if (!storedCoverLetter(row)) {
    try {
      await generateStoredCoverLetter(row, false, true);
    } catch (error) {
      // Raw message to the log, fixed sentence to the applicant. See the note above the function.
      fastify.log.warn({ error, applicationId: row.id }, 'Cover letter generation failed, continuing without it');
      return {
        packet: omitCoverLetter(await buildPacket(row)),
        coverLetterIssue: 'We could not write your cover letter for this one, so it is not attached. Everything else is filled in, and you can write or retry a cover letter from your dashboard.',
      };
    }
  }
  const rows = await db.select().from(generated_resumes).where(eq(generated_resumes.id, row.id)).limit(1);
  if (!rows[0]) throw new Error('This application went missing while we wrote the cover letter');
  return { packet: await buildPacket(rows[0]) };
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
  automaticSubmissionEnabled: boolean,
  portal: SupportedPortal,
): Promise<{ questions: ApplicationReviewQuestion[]; attentionReasons: string[] }> {
  const existingLabels = new Set(current.questions.map((q) => normalizeDiscoveredLabel(q.question).toLowerCase()));
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
    const label = normalizeDiscoveredLabel(field.label);
    const reviewLabel = normalizeReviewQuestionLabel(field.label);
    if (!label || !reviewLabel || normalizeStoredPortalQuestions([{ question: label, answer: '' }], portal).length === 0) continue;
    if (existingLabels.has(reviewLabel.toLowerCase())) continue; // already answered by the client or a prior run

    const known = resolveKnownAnswer(label, field.inputType, ap, current.jd_text);
    if (known && 'value' in known) {
      questions.push({ id: randomUUID(), question: reviewLabel, answer: known.value, kind: 'required', required: false });
      continue;
    }
    if (known && 'skipReason' in known) {
      attentionReasons.push(known.skipReason);
      continue;
    }
    if (isRefusedQuestion(label)) {
      attentionReasons.push(WORK_ELIGIBILITY_QUESTION.test(label)
        ? workEligibilitySkipReason(label)
        : `sensitive question left for you: "${label.slice(0, 60)}"`);
      continue; // EEO/SSN/etc: never answered, never surfaced as a field to fill
    }
    if (!isOpenEndedQuestion(label)) continue; // not a known field, not an essay: leave it alone

    // Open-ended answers remain grounded by draftApplicationAnswer. Standing consent authorizes
    // those grounded drafts to proceed; without it, the existing per-application review remains.
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
      const { answer, warnings } = await draftApplicationAnswer(
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
      questions.push({ id: randomUUID(), question: reviewLabel, answer: fitted, kind: 'essay', required: false });
      if (warnings.length > 0) {
        attentionReasons.push(`drafted answer needs your review: ${warnings.join('; ').slice(0, 300)}`);
      }
      if (!automaticSubmissionEnabled) {
        attentionReasons.push(`AI-drafted answer needs your review before this goes out: "${label.slice(0, 60)}"`);
      }
    } catch (error) {
      if (isBillingOrAuthFailure(error)) throw error; // this is a real outage, not a per-field skip
      attentionReasons.push(`open-ended question left for you (draft generation failed): "${label.slice(0, 60)}"`);
    }
  }

  return { questions, attentionReasons };
}

async function loadApplicationProfileLike(userId: string): Promise<ApplicationProfileLike> {
  const [[appRow], [profileRow]] = await Promise.all([
    db.select().from(application_profile).where(eq(application_profile.user_id, userId)).limit(1),
    db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1),
  ]);
  const app = appRow ? (decryptRow(appRow) as Record<string, unknown>) : {};
  const parsed = (profileRow?.parsed_json && typeof profileRow.parsed_json === 'object'
    ? profileRow.parsed_json
    : {}) as Record<string, unknown>;
  const base = (profileRow?.base_resume_json && typeof profileRow.base_resume_json === 'object'
    ? profileRow.base_resume_json
    : {}) as Record<string, unknown>;
  const str = (key: string): string | undefined => (typeof app[key] === 'string' ? (app[key] as string) : undefined);
  const appBoolean = (key: string): boolean | undefined => (typeof app[key] === 'boolean' ? (app[key] as boolean) : undefined);
  const academicStr = (key: string): string | undefined => {
    const baseValue = base[key];
    if (typeof baseValue === 'string' && baseValue.trim()) return baseValue;
    const parsedValue = parsed[key];
    return typeof parsedValue === 'string' && parsedValue.trim() ? parsedValue : undefined;
  };
  const academicNum = (key: string): number | undefined => {
    const baseValue = base[key];
    if (typeof baseValue === 'number' && baseValue > 0) return baseValue;
    const parsedValue = parsed[key];
    return typeof parsedValue === 'number' && parsedValue > 0 ? parsedValue : undefined;
  };
  const academicBoolean = (key: string): boolean | undefined => {
    const baseValue = base[key];
    if (typeof baseValue === 'boolean') return baseValue;
    const parsedValue = parsed[key];
    return typeof parsedValue === 'boolean' ? parsedValue : undefined;
  };
  return {
    phone: str('phone'),
    address_city: str('address_city'),
    address_state: str('address_state'),
    address_country: str('address_country'),
    linkedin_url: str('linkedin_url'),
    github_url: str('github_url'),
    portfolio_url: str('portfolio_url'),
    citizenship: str('citizenship'),
    work_authorized: appBoolean('work_authorized'),
    needs_sponsorship: appBoolean('needs_sponsorship'),
    date_of_birth: str('date_of_birth'),
    availability_date: str('availability_date'),
    availability_term: str('availability_term'),
    grad_date: academicStr('grad_date'),
    grad_year: academicNum('grad_year'),
    currently_enrolled: academicBoolean('currently_enrolled'),
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
  authorization: StandingAuthorization,
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
  const coverLetterOutcome = await packetForCoverLetterCapability(row, coverLetterSupported, fastify);
  packet = coverLetterOutcome.packet;
  const storedQuestions = normalizeStoredPortalQuestions(current.questions, portal);
  const resolutionCurrent = { ...current, questions: storedQuestions };
  const { questions: discoveredQuestions, attentionReasons: discoveryAttention } = await discoverAndResolveQuestions(
    discoveryResult?.discovered ?? [],
    row,
    resolutionCurrent,
    await loadApplicationProfileLike(row.user_id),
    authorization.enabled,
    portal,
  );
  const mergedQuestions = [...storedQuestions, ...discoveredQuestions];
  packet.questions = mergedQuestions.map((q) => ({ question: q.question, answer: q.answer }));

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
  const verificationHandoff = blockers.some((blocker) =>
    /verification code|security code|one[ -]?time code|passcode|\botp\b/i.test(blocker),
  );
  // A missing cover letter is worth telling the applicant about, but it is not a blocker: the form
  // is filled and sendable without it, so it must not flip the run out of the safe path.
  const coverLetterAttention = coverLetterOutcome.coverLetterIssue ? [coverLetterOutcome.coverLetterIssue] : [];
  const evidenceBlockers = preparationEvidenceBlockers(result, packet);
  const safe = blockers.length === 0 && discoveryAttention.length === 0 && evidenceBlockers.length === 0;
  const review = nextReview(current, {
    ...preparedReviewPatch(authorization, safe),
    submission_run_id: runId,
    filled_fields: result.filledFields ?? [],
    preview_screenshot_url: preview.url,
    verification: { status: verificationHandoff ? 'handoff' : 'not_needed' },
    questions: mergedQuestions,
    cover_letter_supported: coverLetterSupported,
    attention_reason: [...blockers, ...discoveryAttention, ...evidenceBlockers, ...coverLetterAttention].join('\n') || undefined,
    // No stall write here, deliberately. CAPTCHA_BLOCKER is pushed in exactly one place -
    // fillPortal - and the managed path never calls it, so matching on that string here would be
    // dead code that reads like coverage. The managed path's real challenge signal is the probe in
    // submitManaged, which throws CaptchaUnresolvedError and records the stall through fail().
    handoff_expires_at: new Date(Date.now() + 55 * 60_000).toISOString(),
    submission_error: undefined,
  });
  await writeReview(row, review);
  fastify.log.info({ applicationId: row.id, portal, status: review.status }, 'Application portal prepared with Stratus Sandbox');
}

async function prepare(row: ResumeRow, fastify: FastifyInstance, unattended = false) {
  const stored = row.spec as StoredSpec;
  const current = readApplicationReview(stored);
  if (!current?.portal_url) throw new Error('We do not have a link to the company application page');
  const portal = detectPortal(current.portal_url);
  const runId = current.submission_run_id ?? randomUUID();

  /* THE GRADUATION BLOCK, and it stops the unattended run before anything is spent or sent.
   *
   * Only on the UNATTENDED path. A student who clicks Prepare on a role has looked at it and
   * chosen it, and this gate is arithmetic over a parsed title - it is not entitled to overrule a
   * person about their own application. Autopilot has made no such choice, so it gets the strict
   * reading: an application auto-sent to an internship the student cannot legally hold spends a
   * real application slot and a real employer relationship on their behalf, and they never
   * decided to.
   *
   * Placed above prepareControlled and above the account-walled stop for the same reason those
   * sit where they do: a gate that only covers the submit path is not a gate, because prepare
   * runs first, independently, and costs billed browser calls of its own. */
  if (unattended) {
    /* StoredSpec is Record<string, unknown> - the packet spec is not typed at this layer - so the
       two fields are read defensively. A spec missing either one yields `unknown` from decide(),
       which never blocks, and that is the right default for a record we cannot read. */
    const role = typeof (stored.job_context as { role?: unknown } | undefined)?.role === 'string'
      ? ((stored.job_context as { role?: string }).role as string)
      : '';
    const gradDate = typeof stored.grad_date === 'string' ? stored.grad_date : null;
    const gate = decide({ title: role, employment_type: null }, gradDate);
    if (isBlocked(gate)) {
      fastify.log.warn(
        { userId: row.user_id, resumeId: row.id, role, reason: gate.reason },
        'autopilot blocked: graduation',
      );
      await writeReview(row, nextReview(current, {
        status: 'needs_attention',
        submission_run_id: runId,
        /* Named plainly, because this one is worth reading. The student is being told a fact about
           themselves and this role, not that something went wrong. */
        attention_reason: `Not sent: this role ${gate.reason}. Autopilot does not apply to roles you are not eligible for.`,
      }));
      return;
    }
  }

  const authorization = await standingAuthorization(row.user_id);
  assertControlledPortalEnabled(portal);
  if (shouldUseLocalControlledBrowser(portal)) {
    await prepareControlled(row, current, runId, authorization, fastify);
    return;
  }
  // Account-walled portals stop HERE, before any browser opens, and this is a second instance of
  // the 2026-07-28 review finding rather than a new idea: a gate that only covers the submit path
  // is not a gate. portalCanAutoSubmit is already checked at submit time, but prepare runs FIRST
  // and independently, and for these four it would:
  //   1. spend two managed-browser calls (they are billed) discovering and filling a page that has
  //      no application fields on it at all, then
  //   2. capture a preview screenshot of a data-consent page, a login form or an
  //      "enter the code we emailed you" screen, and
  //   3. present that screenshot to the student as the filled application she is approving to send.
  // She would approve a login page, and only at submit time learn nothing was ever filled. Better
  // to say so now, before spending anything, in the words that name her actual next step.
  //
  // The same stop applies to the multi-step and CAPTCHA-gated families once standing consent is on,
  // for the same reason one step further down the funnel: see autoRunShouldPrepare.
  if (
    isAccountWalledFamily(portal)
    || !autoRunShouldPrepare({ canAutoSubmit: portalCanAutoSubmit(portal), unattended })
  ) {
    await writeReview(row, nextReview(current, {
      status: 'needs_attention',
      submission_run_id: runId,
      // Nothing was filled on this path, so the wording has to be the one that does not claim it was.
      attention_reason: unattendedHandoffReason(portal) ?? undefined,
      // Only the CAPTCHA-gated families produce a stall. This branch also catches multi-step and
      // account-walled portals, and those are waiting on something else entirely - typing them as
      // human_verification would put "prove you are human" rows in the queue for a wizard that just
      // needs its last page answered.
      ...(isCaptchaGatedFamily(portal)
        ? beginStall(current, {
          surface: 'server_run',
          provider: captchaProviderForFamily(portal),
          stage: 'before_fill',
          source: 'assumed',
        })
        : {}),
      submission_error: undefined,
    }));
    return;
  }
  if (isManagedStratusProvider()) {
    await prepareManaged(row, current, portal, runId, fastify, authorization);
    return;
  }
  const contextId = current.browser_context_id ?? (await createBrowserContext());
  const session = await createBrowserSession(contextId, current.portal_url);
  {
    const verificationRequestedAt = new Date();
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
    const [verificationSettings] = await db.select({ enabled: users.automatic_verification_enabled })
      .from(users).where(eq(users.id, row.user_id)).limit(1);
    let verification: BrowserVerificationResult = await completeEmailVerificationIfPresent({
      page,
      userId: row.user_id,
      portalUrl: current.portal_url,
      requestedAt: verificationRequestedAt,
      permissionGranted: verificationSettings?.enabled === true,
    });
    const coverLetterSupported = await hasCoverLetterUpload(page, portal);
    const { packet, coverLetterIssue } = await packetForCoverLetterCapability(row, coverLetterSupported, fastify);
    const coverLetterAttention = coverLetterIssue ? [coverLetterIssue] : [];

    // R-055: discover and resolve the posting's own custom questions before filling, so a
    // dashboard-only submission does not depend on the extension having run first.
    const discovered = await discoverPageQuestions(page).catch(() => []);
    const storedQuestions = normalizeStoredPortalQuestions(current.questions, portal);
    const resolutionCurrent = { ...current, questions: storedQuestions };
    const { questions: discoveredQuestions, attentionReasons: discoveryAttention } =
      await discoverAndResolveQuestions(discovered, row, resolutionCurrent, await loadApplicationProfileLike(row.user_id), authorization.enabled, portal);
    const mergedQuestions = [...storedQuestions, ...discoveredQuestions];
    packet.questions = mergedQuestions.map((q) => ({ question: q.question, answer: q.answer }));

    let result = await fillPortal(page, portal, packet);
    const postFillVerification = await completeEmailVerificationIfPresent({
      page,
      userId: row.user_id,
      portalUrl: current.portal_url,
      requestedAt: verificationRequestedAt,
      permissionGranted: verificationSettings?.enabled === true,
    });
    if (postFillVerification.status !== 'not_needed') verification = postFillVerification;
    // Re-scan only after a successful verification so an empty OTP field reported during the
    // first pass cannot remain as a stale blocker. This does not click the final submit control.
    if (postFillVerification.status === 'completed') result = await fillPortal(page, portal, packet);
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    const preview = await put(`users/${row.user_id}/submission-runs/${runId}/filled.png`, screenshot, {
      access: 'public',
      contentType: 'image/png',
      // See the managed path above: a retry reuses the run id and would collide.
      addRandomSuffix: true,
    });
    const sanitizedBlockers = sanitizeProviderBlockers(result.blockers);
    const pageText = await page.locator('body').innerText({ timeout: 1_000 }).catch(() => '');
    const evidenceBlockers = preparationEvidenceBlockers({ text: pageText, filledFields: result.filledFields }, packet);
    const safe = directPreparationIsSafe({
      blockerCount: sanitizedBlockers.length + evidenceBlockers.length,
      attentionCount: discoveryAttention.length,
      verificationStatus: verification.status,
    });
    const review = nextReview(current, {
      ...preparedReviewPatch(authorization, safe),
      submission_run_id: runId,
      browser_context_id: contextId,
      browser_session_id: session.id,
      filled_fields: result.filledFields,
      preview_screenshot_url: preview.url,
      verification: {
        status: verification.status,
        provider: verification.provider,
        completed_at: verification.status === 'completed' ? new Date().toISOString() : undefined,
      },
      questions: mergedQuestions,
      cover_letter_supported: coverLetterSupported,
      // Already human on this path, but the BLOCKERS are sanitized anyway so both providers are
      // held to one guarantee and a future change to either cannot quietly reintroduce identifiers.
      // The other two arrays do not go through the sanitizer and do not need to: they are written
      // here, in this repo, in the product's own voice, and neither one interpolates provider or
      // model text. Sending them through it would not have caught the cover-letter leak either,
      // since that message was prose and prose passes straight through.
      attention_reason:
        [...sanitizedBlockers, ...discoveryAttention, ...evidenceBlockers, ...coverLetterAttention].join('\n') || undefined,
      // The only path that OBSERVES a challenge on a board nobody had typed as gated, which makes it
      // the one that matters most. Without it the stall is written only for JazzHR and BambooHR,
      // families already known to gate, so the instrumentation could confirm what was already
      // assumed and could never discover anything new. Provider is read off the live page here, so
      // it is 'observed'.
      ...(blockersIncludeCaptcha(sanitizedBlockers)
        ? beginStall(current, {
          surface: 'server_run',
          provider: await detectCaptchaProvider(page),
          stage: 'at_submit',
          source: 'observed',
        })
        : {}),
      handoff_expires_at: new Date(Date.now() + 55 * 60_000).toISOString(),
      submission_error: undefined,
    });
    await writeReview(row, review);
    fastify.log.info({ applicationId: row.id, portal, status: review.status }, 'Application portal prepared');
  }
}

function controlledChromeExecutable(): string {
  return process.env.LITOS_TEST_BROWSER_EXECUTABLE
    ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

export function shouldUseLocalControlledBrowser(portal: SupportedPortal): boolean {
  return portal === 'controlled_test' && !isManagedStratusProvider();
}

function assertControlledPortalEnabled(portal: SupportedPortal): void {
  if (portal === 'controlled_test' && process.env.LITOS_ENABLE_TEST_PORTAL !== 'true') {
    throw new Error('Controlled portal is disabled');
  }
}

async function prepareControlled(
  row: ResumeRow,
  current: ApplicationReviewState,
  runId: string,
  authorization: StandingAuthorization,
  fastify: FastifyInstance,
) {
  if (process.env.LITOS_ENABLE_TEST_PORTAL !== 'true') throw new Error('Controlled portal is disabled');
  const browser = await chromium.launch({ executablePath: controlledChromeExecutable(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(current.portal_url!, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const packet = await buildPacket(row, true);
    const result = await fillPortal(page, 'controlled_test', packet);
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    const pageText = await page.locator('body').innerText({ timeout: 1_000 }).catch(() => '');
    const evidenceBlockers = preparationEvidenceBlockers({ text: pageText, filledFields: result.filledFields }, packet);
    const safe = result.blockers.length === 0 && evidenceBlockers.length === 0;
    const review = nextReview(current, {
      ...preparedReviewPatch(authorization, safe),
      submission_run_id: runId,
      filled_fields: result.filledFields,
      preview_screenshot_url: `data:image/png;base64,${screenshot.toString('base64')}`,
      verification: { status: 'not_needed' },
      attention_reason: [...result.blockers, ...evidenceBlockers].join('\n') || undefined,
      handoff_expires_at: new Date(Date.now() + 55 * 60_000).toISOString(),
      submission_error: undefined,
    });
    await writeReview(row, review);
    fastify.log.info({ applicationId: row.id, status: review.status }, 'Controlled application portal prepared');
  } finally {
    await browser.close();
  }
}

async function submitControlled(row: ResumeRow, review: ApplicationReviewState, fastify: FastifyInstance) {
  if (process.env.LITOS_ENABLE_TEST_PORTAL !== 'true') throw new Error('Controlled portal is disabled');
  const browser = await chromium.launch({ executablePath: controlledChromeExecutable(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(review.portal_url!, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await fillPortal(page, 'controlled_test', await buildPacket(row, true));
    await clickFinalSubmit(page);
    const receipt = await readReceipt(page);
    const capturedAt = new Date().toISOString();
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    await writeReview(row, nextReview(review, {
      status: 'submitted',
      submitted_at: capturedAt,
      submission_error: undefined,
      receipt: {
        confirmation_text: receipt.confirmationText,
        final_url: receipt.finalUrl,
        screenshot_url: `data:image/png;base64,${screenshot.toString('base64')}`,
        captured_at: capturedAt,
        reference_id: receipt.referenceId,
      },
    }));
    fastify.log.info({ applicationId: row.id }, 'Controlled application submission receipt verified');
  } finally {
    await browser.close();
  }
}

async function submit(row: ResumeRow, fastify: FastifyInstance) {
  const current = readApplicationReview(row.spec);
  if (!current?.submission_run_id || !current.portal_url) throw new Error('The prepared run is missing');
  const authorization = await standingAuthorization(row.user_id);
  if (!mayClickFinalSubmit({
    source: current.submission_authorization?.source,
    standingConsentEnabled: authorization.enabled,
  })) {
    if (current.submission_authorization?.source === 'standing_consent') {
      await writeReview(row, nextReview(current, {
        status: 'ready_for_final_approval',
        submission_authorization: undefined,
        submission_claimed_at: undefined,
        submission_claim_id: undefined,
      }));
      return;
    }
    throw new Error('Submission authorization is missing');
  }
  const claimedRow = await claimSubmission(row);
  if (!claimedRow) return;
  row = claimedRow;
  const claimedReview = readApplicationReview(row.spec);
  if (!claimedReview) return;
  const claimedPortal = detectPortal(claimedReview.portal_url!);
  assertControlledPortalEnabled(claimedPortal);
  if (shouldUseLocalControlledBrowser(claimedPortal)) {
    await submitControlled(row, claimedReview, fastify);
    return;
  }
  // Portals that cannot be submitted in one run stop HERE, before either provider path.
  //
  // This gate used to live only inside buildManagedPortalActions, which was wrong in two ways that
  // a review caught before it shipped. Removing the click from the managed action list does not stop
  // the code below from calling readManagedReceipt and writing status:'submitted' - so a JazzHR or
  // Paylocity run that clicked nothing could still be recorded as submitted the moment the page text
  // happened to contain "success". And it did nothing at all for the direct-Playwright path, which
  // calls clickFinalSubmit(page) unconditionally: on JazzHR that presses submit behind an unsolved
  // reCAPTCHA, and on Paylocity it presses a control halfway through a four-page wizard.
  //
  // Gating at the call site is the only place that covers both providers and the status write.
  {
    const portal = claimedPortal;
    if (!portalCanAutoSubmit(portal)) {
      await writeReview(row, nextReview(claimedReview, {
        status: 'needs_attention',
        attention_reason: portalHandoffReason(portal) ?? undefined,
        // Same family test as the unattended branch above, different stage: this path DID fill the
        // form, so the applicant is finishing a filled application rather than starting a blank one.
        ...(isCaptchaGatedFamily(portal)
          ? beginStall(claimedReview, {
            surface: 'server_run',
            provider: captchaProviderForFamily(portal),
            stage: 'at_submit',
            source: 'assumed',
          })
          : {}),
      }));
      return;
    }
  }
  if (isManagedStratusProvider()) {
    const portal = claimedPortal;
    if (!await authorizationValidAtClick(row, claimedReview)) {
      await holdRevokedSubmission(row, claimedReview);
      return;
    }
    const applicationUrl = portalApplicationUrl(portal, claimedReview.portal_url!);
    // There is no Playwright Page on this path - the actions run inside the remote runner - so
    // neither fillPortal's blocker check nor clickFinalSubmit's guard executes here, and the code
    // below writes status:'submitted' on a receipt screenshot. Without this probe, portalCanAutoSubmit
    // would be the only CAPTCHA protection: fine for JazzHR and BambooHR, useless for a Greenhouse or
    // Lever board whose employer switched a challenge on last week.
    //
    // A separate call, because /api/run is stateless and runs the whole list before returning: a
    // check inside the submit list cannot stop the click it exists to gate. Deliberately placed
    // ABOVE buildPacket so a stopped application pays for neither the packet nor the fill run, and
    // asks for no screenshot, so it transfers one attribute rather than a full-page PNG.
    //
    // Costs one extra remote session and page load per managed submission. That is the price of the
    // statelessness, and it is worth naming: the challenge state is read from a DIFFERENT page load
    // than the one that submits.
    const captchaProbe = await runManagedBrowser(applicationUrl, buildManagedCaptchaProbeActions(), { screenshot: false })
      // A probe that cannot run must not take down a submission that would otherwise succeed. It
      // fails open to the pre-probe behaviour, same as managedResultRequiresCaptchaAttention does.
      // Only the message is logged, bounded: the runner's error string is remote-controlled and
      // Playwright-shaped failures embed page markup.
      .catch((error: unknown) => {
        const detail = String(error instanceof Error ? error.message : error).slice(0, 200);
        fastify.log.warn({ applicationId: row.id, detail }, 'CAPTCHA probe failed, continuing unprobed');
        return null;
      });
    if (managedResultRequiresCaptchaAttention(captchaProbe)) {
      throw new CaptchaUnresolvedError('before_fill');
    }
    const builtPacket = await buildPacket(row);
    const packet = claimedReview.cover_letter_supported === true ? builtPacket : omitCoverLetter(builtPacket);
    const result = await runManagedBrowser(applicationUrl, buildManagedPortalActions(portal, packet, true));
    const receipt = readManagedReceipt(result);
    if (!result.screenshot) throw new Error('Stratus managed browser did not return a receipt screenshot');
    const capturedAt = new Date().toISOString();
    const blob = await put(
      `users/${row.user_id}/submission-runs/${claimedReview.submission_run_id}/receipt.png`,
      Buffer.from(result.screenshot, 'base64'),
      // A receipt is the proof an application was actually submitted, so a collision here would
      // fail the run at the worst possible moment: after the employer already has it.
      { access: 'public', contentType: 'image/png', addRandomSuffix: true },
    );
    await writeReview(row, nextReview(claimedReview, {
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
  if (!claimedReview.browser_session_id) throw new Error('The prepared run is missing its session.');
  const session = await getBrowserSession(claimedReview.browser_session_id);
  let browser;
  try {
    const connected = await connectToSession(session);
    browser = connected.browser;
    const page = connected.page;
    if (!await authorizationValidAtClick(row, claimedReview)) {
      await holdRevokedSubmission(row, claimedReview);
      return;
    }
    const portal = detectPortal(claimedReview.portal_url!);
    const builtPacket = await buildPacket(row);
    const packet = claimedReview.cover_letter_supported === true ? builtPacket : omitCoverLetter(builtPacket);
    await fillPortal(page, portal, packet);
    await clickFinalSubmit(page);
    const receipt = await readReceipt(page);
    const capturedAt = new Date().toISOString();
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    const blob = await put(
      `users/${row.user_id}/submission-runs/${claimedReview.submission_run_id}/receipt.png`,
      screenshot,
      { access: 'public', contentType: 'image/png', addRandomSuffix: true },
    );
    await writeReview(row, nextReview(claimedReview, {
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


/**
 * What a failed run tells the applicant, derived rather than written inline.
 *
 * EXTRACTED SO IT CAN BE TESTED. This is the user-visible half of the no-submit-control change and
 * it had no behavioural coverage at all - the only thing watching this file was a test that greps
 * it as a string, which cannot tell a correct branch from a deleted one. A review pass proved it by
 * deleting each branch in turn and finding the suite still green.
 *
 * THE PRECEDENCE IS THE POINT, and it runs stop-reason first, uncertainty last. `uncertainAfterClaim`
 * is true on every one of these paths, because the claim is taken at the top of the run - so any
 * branch that does not outrank it inherits "the submission was attempted and we could not verify
 * it", which sends someone hunting for a receipt that cannot exist.
 */
export function submissionFailureOutcome(input: {
  captchaStop: 'before_fill' | 'at_submit' | null;
  noSubmitControl: boolean;
  uncertainAfterClaim: boolean;
  externalGate: boolean;
  currentAttentionReason: string | undefined;
}): { status: ApplicationReviewState['status']; attentionReason: string | undefined } {
  const { captchaStop, noSubmitControl, uncertainAfterClaim, externalGate } = input;
  const status: ApplicationReviewState['status'] = captchaStop || noSubmitControl || uncertainAfterClaim
    ? 'needs_attention'
    : externalGate ? 'submit_requested' : 'failed';
  const attentionReason = captchaStop === 'at_submit'
    ? 'This company\u2019s application page asks you to prove you are human, and that check is still waiting. Litos filled everything in and stopped there, so nothing has been sent. Open it when you have a minute and finish the last step.'
    : captchaStop === 'before_fill'
      ? 'This company asks you to prove you are human before it will take an application, so Litos cannot send this one while you are away. Open it when you have a minute and Litos will fill it in for you.'
      : noSubmitControl
        /* CAUSE-NEUTRAL. NoSubmitControlError is thrown for a multi-step first page, a page that
           renders nothing in a headless browser, a control relabelled mid-run, and a click that
           timed out before dispatching - so naming any one cause would be false most of the time.
           What is always true, and all that matters, is that nothing was sent. */
        ? 'Litos could not find the button that sends this application, so nothing has been sent and there is no confirmation to look for. Open it when you have a minute and finish it off.'
        : uncertainAfterClaim
          ? 'The final submission was attempted, but Litos could not verify the employer confirmation. Check the portal or your email before trying again.'
          : input.currentAttentionReason ?? undefined;
  return { status, attentionReason };
}

async function fail(row: ResumeRow, error: unknown) {
  const latestRows = await db.select().from(generated_resumes).where(eq(generated_resumes.id, row.id)).limit(1);
  const current = latestRows[0] ? readApplicationReview(latestRows[0].spec) : null;
  if (!current) return;
  const message = error instanceof Error ? error.message : 'Submission runner failed';
  const externalGate = /browserbase|stratus managed browser is not configured|secure browser provider is not configured/i.test(message);
  const uncertainAfterClaim = Boolean(current.submission_claimed_at);

  // Takes precedence over uncertainAfterClaim, and that precedence is the whole point. The claim is
  // taken at the top of the run, so by the time clickFinalSubmit refuses to press the button this is
  // ALWAYS "uncertain after claim" - and that branch says the submission was attempted and could not
  // be verified. Here the opposite is true and known: the click provably did not happen, so nothing
  // was sent. Telling someone to go check their email for a confirmation of an application that was
  // never submitted sends them looking for a receipt that cannot exist, and costs the trust to
  // believe the next message. Same reasoning as portalHandoffReason vs unattendedHandoffReason.
  //
  // Derived rather than early-returned so there stays exactly ONE writeReview call here: a second
  // one drifts the moment a field is added to the other.
  const captchaError = error instanceof CaptchaUnresolvedError ? error : null;
  const captchaStop = captchaError?.stage ?? null;
  /* Same precedence, same reason as the captcha branch above. When clickFinalSubmit finds no
     submit control the click PROVABLY did not happen, so uncertainAfterClaim's "check the portal
     or your email" is the one thing that must not be said: there is no receipt to find. This is
     the routine outcome on a multi-step first page, not an edge case. */
  const noSubmitControl = error instanceof NoSubmitControlError;

  const outcome = submissionFailureOutcome({
    captchaStop, noSubmitControl, uncertainAfterClaim, externalGate,
    currentAttentionReason: current.attention_reason,
  });

  await writeReview(latestRows[0], nextReview(current, {
    ...(captchaError
      ? beginStall(current, {
        surface: 'server_run',
        provider: captchaError.provider,
        stage: captchaError.stage,
        source: 'observed',
      })
      : {}),
    status: outcome.status,
    submission_error: message,
    attention_reason: outcome.attentionReason,
  }));
}

// `unattended` is the CRON path saying "nobody is watching this run", and it is deliberately not
// derived from standing consent. Consent is a persistent setting: a user who turned auto-submit on
// is still sitting at their dashboard when they press submit on a Paylocity job, and deriving
// "away" from "consented" would take fill-and-hand-off away from exactly the people who opted into
// the product most. Provenance is a property of the caller, so the caller passes it.
export async function processSubmissionApplication(
  applicationId: string,
  fastify: FastifyInstance,
  options: { unattended?: boolean } = {},
): Promise<ApplicationReviewState | null> {
  const rows = await db.select().from(generated_resumes).where(eq(generated_resumes.id, applicationId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  let activeRow = row;
  try {
    let review = readApplicationReview(activeRow.spec);
    if (review?.status === 'submit_requested') {
      const claimed = await claimPreparation(activeRow);
      if (!claimed) return review;
      activeRow = claimed;
      await prepare(activeRow, fastify, options.unattended === true);
      const prepared = await db.select().from(generated_resumes).where(eq(generated_resumes.id, applicationId)).limit(1);
      if (prepared[0]) activeRow = prepared[0];
      review = readApplicationReview(activeRow.spec);
    }
    if (review?.status === 'submitting') await submit(activeRow, fastify);
  } catch (error) {
    fastify.log.error({ error, applicationId: row.id }, 'Application runner step failed');
    const latest = await db.select().from(generated_resumes).where(eq(generated_resumes.id, applicationId)).limit(1);
    await fail(latest[0] ?? activeRow, error);
  }
  const refreshed = await db.select().from(generated_resumes).where(eq(generated_resumes.id, applicationId)).limit(1);
  return refreshed[0] ? readApplicationReview(refreshed[0].spec) : null;
}

export async function submissionRunnerRoutes(fastify: FastifyInstance) {
  fastify.get('/internal/application-submission-runner', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isCronConfigured() || !isCronAuthorized(request)) return reply.status(401).send({ error: 'Unauthorized' });
    if (!isBrowserbaseConfigured()) return reply.status(503).send({ error: 'Litos cannot fill in company pages yet. Not configured', processed: 0 });
    const startedAt = Date.now();
    // Oldest first. Without an order the queue is whatever Postgres returns, so a row could sit
    // behind newer ones indefinitely once the queue is longer than one batch.
    //
    // Already-claimed rows are excluded, and ordering is exactly why that matters now. A row left
    // in 'submitting' with a claim on it cannot be progressed by anyone: claimSubmission refuses a
    // second claim, so processing it is a no-op. Unordered, such a row was one arbitrary pick among
    // many. Oldest-first, it would sit at the head of every batch forever and consume a slot on
    // every invocation, which turns one stranded row into a permanently narrower queue.
    const rows = await db
      .select()
      .from(generated_resumes)
      .where(and(
        sql`${generated_resumes.spec}->'_review'->>'status' in ('submit_requested', 'submitting')`,
        sql`${generated_resumes.spec}->'_review'->>'submission_claimed_at' is null`,
      ))
      .orderBy(generated_resumes.created_at)
      .limit(submissionBatchSize());
    const cap = dailySubmissionCap();
    let processed = 0;
    let deferredForTime = 0;
    let deferredForCap = 0;
    for (const row of rows) {
      if (!hasTimeForAnotherApplication(Date.now() - startedAt)) {
        deferredForTime = rows.length - processed - deferredForCap;
        break;
      }
      // Recounted per row rather than cached per invocation. The count is a snapshot either way,
      // but a per-invocation cache stays stale for the whole batch, so a run alongside the manual
      // submit endpoint could overshoot by the length of the batch. Per row, the stale window
      // shrinks to one application. This is a ceiling check on a rare path, not a lock: the exact
      // guarantee is "about the cap", and buying an exact one costs a database counter updated
      // inside the submission claim.
      const already = await countSubmissionsClaimedToday(row.user_id);
      if (!withinDailyCap(already, cap)) {
        deferredForCap += 1;
        continue;
      }
      try {
        await processSubmissionApplication(row.id, fastify, { unattended: true });
        processed += 1;
      } catch (error) {
        fastify.log.error({ error, applicationId: row.id }, 'Application runner step failed');
        await fail(row, error);
      }
    }
    // Logged, never silent. A queue that stops moving because everyone hit the cap looks exactly
    // like an empty queue from the outside, which is the failure mode that kept the jobs board at
    // zero postings for months.
    if (deferredForTime || deferredForCap) {
      fastify.log.info(
        { deferredForTime, deferredForCap, cap },
        'Submission batch ended with applications still queued',
      );
    }
    return reply.send({ processed, deferred_for_time: deferredForTime, deferred_for_cap: deferredForCap, configured: true });
  });
}
