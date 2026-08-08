import { randomUUID } from 'node:crypto';
import { decide, isBlocked } from '../engine/eligibility';
import { put } from '@vercel/blob';
import { chromium, type Page } from 'playwright-core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { application_profile, generated_resumes, profiles, users } from '../db/schema';
import {
  normalizeApplicationReviewQuestions,
  readApplicationReview,
  type ApplicationAttentionCategory,
  type ApplicationReviewState,
} from '../lib/applicationReview';
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
  corroborateManagedCaptchaBlockers,
  managedCaptchaProvider,
  detectCaptchaProvider,
  captchaProviderForFamily,
  buildManagedPortalActions,
  attachManagedFieldOptions,
  managedResultFieldOptions,
  CaptchaUnresolvedError,
  clickFinalSubmit,
  detectPortal,
  managedResultRequiresCaptchaAttention,
  isManagedCaptchaEvidenceExtract,
  fillPortal,
  hasCoverLetterUpload,
  managedResultFilledFields,
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
import {
  attentionCategoriesForReasons,
  UNEXPLAINED_RUN_FAILURE_REASON,
  type TerminalRunStatus,
} from '../lib/submissionTerminalCause';
import { sanitizeProviderBlockers } from '../lib/fieldLabel';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import { resolveBlobUrl } from '../lib/resumeAccess';
import { decryptRow } from './applicationProfile';
import { readExperienceBank } from '../db/experienceBank';
import { declaredSkillsList } from './profile';
import { applicantGroundingFacts, draftApplicationAnswer, type ApplicantGroundingFacts } from '../llm/applicationAnswer';
import { isBillingOrAuthFailure } from './resume';
import { completeEmailVerificationIfPresent, type BrowserVerificationResult } from '../lib/browserVerification';
import {
  discoverPageQuestions,
  discoveredFieldIsRequired,
  isCoreIdentityField,
  isOpenEndedQuestion,
  isRefusedQuestion,
  normalizeDiscoveredLabel,
  normalizeReviewQuestionLabel,
  normalizeStoredPortalQuestions,
  refreshKnownQuestionAnswers,
  resolveKnownAnswer,
  fitToBudget,
  WORK_ELIGIBILITY_QUESTION,
  workEligibilitySkipReason,
  type ApplicationProfileLike,
  type DiscoveredQuestion,
} from '../lib/questionDiscovery';
import { profileBackedBlockerLabels, resolveProfileField, usableOptions } from '../lib/profileFieldResolution';
import { loadApplicationProfileLike } from '../lib/applicationProfileLike';
import type { ApplicationReviewQuestion } from '../lib/applicationReview';
import { jobCountry } from '../lib/jobLocation';
import { generateStoredCoverLetter, storedCoverLetter } from '../lib/coverLetterService';
import { repairReviewPortalFromMonitoredJob } from '../lib/applicationPortalRepair';
import { selectApplicationProfileRow } from '../lib/applicationFacts';
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
import { assessAtsSubmissionChannel, tryAtsSubmissionChannel } from '../lib/atsSubmissionChannels';
import { resolveApplicantEmail } from '../lib/applicationEmail';

export type ResumeRow = typeof generated_resumes.$inferSelect;
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

export function atsApiSubmissionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LITOS_ATS_API_SUBMISSION_ENABLED === 'true';
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

const SUBMISSION_GRAD_MONTH_NAMES: Record<string, string> = {
  '01': 'January',
  '02': 'February',
  '03': 'March',
  '04': 'April',
  '05': 'May',
  '06': 'June',
  '07': 'July',
  '08': 'August',
  '09': 'September',
  '10': 'October',
  '11': 'November',
  '12': 'December',
};

export function submissionGraduationDateParts(
  gradDate: string | undefined,
  gradYear: number | undefined,
): { month?: string; year?: string } {
  const text = gradDate?.trim();
  if (!text && !gradYear) return {};
  const isoMatches = [...(text?.matchAll(/\b((?:19|20)\d{2})-(\d{2})(?:-\d{2})?\b/g) ?? [])];
  const iso = isoMatches.find((match) => match[1] === String(gradYear ?? '')) ?? isoMatches.at(-1);
  if (iso) return { year: iso[1], month: SUBMISSION_GRAD_MONTH_NAMES[iso[2]] };
  const years = text?.match(/\b(?:19|20)\d{2}\b/g) ?? [];
  const year = String(gradYear ?? years.at(-1) ?? '').trim() || undefined;
  const monthYearMatches = [...(text?.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b[^0-9]{0,20}\b((?:19|20)\d{2})\b/gi) ?? [])];
  const monthYear = monthYearMatches.find((match) => match[2] === year) ?? monthYearMatches.at(-1);
  const month = monthYear?.[1] ?? text?.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i)?.[1];
  return { month: month ? month[0].toUpperCase() + month.slice(1).toLowerCase() : undefined, year };
}

export function sanitizeEeoPrefs(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cleaned: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed) cleaned[key] = trimmed;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

function majorFromAcademicProfile(major: string | undefined, degree: string | undefined): string | undefined {
  if (major?.trim()) return major.trim();
  const trimmed = degree?.trim();
  if (!trimmed) return undefined;
  const cleaned = trimmed
    .replace(/\b(?:b\.?s\.?|b\.?a\.?|m\.?s\.?|m\.?a\.?|m\.?b\.?a\.?)\b/gi, ' ')
    .replace(/\b(?:bachelor|bachelor's|bachelors|master|master's|masters|doctor|doctorate|ph\.?d)\s+(?:of\s+)?(?:science|arts|business\s+administration)?\s+(?:degree\s+)?(?:in\s+)?/gi, ' ')
    .replace(/\b(?:degree\s+in|with\s+a\s+degree\s+in|in)\b/gi, ' ')
    .replace(/(?:,\s*)?[^,;&()]{0,40}\b(?:emphasis|concentration|minor)\b.*$/i, '')
    .replace(/[(),]/g, ' ')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || trimmed;
}

export async function buildPacket(row: ResumeRow, controlledTest = false): Promise<SubmissionPacket> {
  const stored = row.spec as StoredSpec;
  const contact = (stored._contact ?? {}) as Record<string, unknown>;
  const coverLetterMeta = (stored._cover_letter ?? {}) as Record<string, unknown>;
  const [userRow, appRow, profileRow] = await Promise.all([
    db.select().from(users).where(eq(users.id, row.user_id)).limit(1),
    // Tolerant read, see lib/applicationFacts.ts.
    selectApplicationProfileRow(row.user_id),
    db.select().from(profiles).where(eq(profiles.user_id, row.user_id)).limit(1),
  ]);
  const app = appRow ? decryptRow(appRow) : {};
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
  const accountEmail = String(userRow[0]?.email ?? '').trim();
  /* THE ADDRESS THE EMPLOYER WILL BE ASKED TO WRITE TO.
   *
   * This line used to take the minted alias first and fall through to the contact and account
   * addresses only if there was no alias, which put a generated alias on a real employer's form on
   * the strength of an environment variable being set. On 2026-08-08 apply.trylitos.com had no MX
   * record, so that address could not receive
   * mail: every confirmation and every recruiter reply bounced, and the applicant was unreachable
   * on an application she cannot send twice.
   *
   * resolveApplicantEmail will not hand back an alias unless the alias domain has been MEASURED
   * able to receive mail, and falls back to her real address otherwise. The decision, including
   * why, is recorded on the review state by the callers of buildPacket, so nothing can tell her
   * her replies are being tracked when they are not. */
  const applicantEmail = await resolveApplicantEmail({
    userId: row.user_id,
    applicationId: row.id,
    accountEmail,
    contactEmail: typeof contact.email === 'string' ? contact.email : null,
  });
  const email = applicantEmail.address.trim();
  if (!fullName || !email) throw new Error('Full name and email are required before submission');
  const roleTitle = (row.job_context as { role?: unknown } | null)?.role;
  const base = (profileRow[0]?.base_resume_json && typeof profileRow[0].base_resume_json === 'object'
    ? profileRow[0].base_resume_json
    : {}) as Record<string, unknown>;
  const academicStr = (key: string): string | undefined => {
    const parsedValue = parsed[key];
    if (typeof parsedValue === 'string' && parsedValue.trim()) return parsedValue.trim();
    const baseValue = base[key];
    return typeof baseValue === 'string' && baseValue.trim() ? baseValue.trim() : undefined;
  };
  const academicNum = (key: string): number | undefined => {
    const parsedValue = parsed[key];
    if (typeof parsedValue === 'number' && parsedValue > 0) return parsedValue;
    const baseValue = base[key];
    return typeof baseValue === 'number' && baseValue > 0 ? baseValue : undefined;
  };
  const academicBoolean = (key: string): boolean | undefined => {
    const parsedValue = parsed[key];
    if (typeof parsedValue === 'boolean') return parsedValue;
    const baseValue = base[key];
    return typeof baseValue === 'boolean' ? baseValue : undefined;
  };
  const graduationDate = academicStr('grad_date');
  const graduationYear = academicNum('grad_year');
  const graduationParts = submissionGraduationDateParts(graduationDate, graduationYear);
  const degree = academicStr('degree');
  const appStr = (key: string): string | undefined => (typeof app[key] === 'string' && (app[key] as string).trim()
    ? (app[key] as string).trim()
    : undefined);
  const applicationProfile = await loadApplicationProfileLike(row.user_id);
  const context = (row.job_context && typeof row.job_context === 'object' ? row.job_context : {}) as Record<string, unknown>;
  const roleLocations = Array.isArray(context.locations)
    ? context.locations.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : undefined;
  const refreshedQuestions = refreshKnownQuestionAnswers(review.questions, applicationProfile, review.jd_text);
  return {
    fullName,
    email,
    phone: typeof app.phone === 'string' ? app.phone : undefined,
    city: typeof app.address_city === 'string' ? app.address_city : undefined,
    country: typeof app.address_country === 'string' ? app.address_country : undefined,
    linkedinUrl: typeof app.linkedin_url === 'string' ? app.linkedin_url : undefined,
    githubUrl: typeof app.github_url === 'string' ? app.github_url : undefined,
    portfolioUrl: typeof app.portfolio_url === 'string' ? app.portfolio_url : undefined,
    school: academicStr('school'),
    degree,
    graduationDate,
    graduationMonth: graduationParts.month,
    graduationYear: graduationParts.year,
    gpa: appStr('gpa') ?? academicStr('gpa'),
    major: appStr('major') ?? majorFromAcademicProfile(academicStr('major'), degree),
    currentlyEnrolled: academicBoolean('currently_enrolled'),
    referralSourceDefault: typeof app.referral_source_default === 'string' ? app.referral_source_default : undefined,
    roleLocation: typeof context.location === 'string' ? context.location : undefined,
    roleLocations,
    applicationProfile,
    jdText: review.jd_text,
    resume,
    resumeName: resumeFileNameForRole(fullName, roleTitle),
    coverLetter,
    coverLetterName: coverLetter
      ? coverLetterFileNameForRole(fullName, roleTitle)
      : undefined,
    eeoPrefs: sanitizeEeoPrefs(app.eeo_prefs),
    // Metadata, not a fill field: `email` above is what gets typed. Carried on the packet so the
    // prepare paths can write which address was used, and why, onto the review state.
    applicantEmail,
    mostRecentRole: readMostRecentRole(parsed),
    questions: refreshedQuestions.map((item) => ({
      question: item.question,
      answer: item.answer,
      portalSelector: item.portal_selector,
      portalInputType: item.portal_input_type,
      atsApiField: item.ats_api_field,
    })),
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
  if (!has('name') && !(has('first') && has('last'))) {
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

function compactEvidenceText(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function gpaEvidenceValues(value: string | undefined): string[] {
  const match = value?.match(/\b([0-4](?:\.\d+)?)\b/);
  if (!match) return [];
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric)) return [];
  return [numeric.toFixed(1).replace(/\.0$/, '.0')];
}

function selectEvidenceValues(answer: string | undefined): string[] {
  const trimmed = answer?.trim();
  if (!trimmed) return [];
  const values = [trimmed];
  const lower = trimmed.toLowerCase();
  if (lower === 'yes') values.push('Yes');
  if (lower === 'no') values.push('No');
  if (/^company website$/i.test(trimmed)) values.push('Other', 'Company Website', 'Company website');
  if (/\bbachelor/.test(lower)) values.push('Bachelors');
  if (/\bmaster/.test(lower)) values.push('Masters');
  values.push(...gpaEvidenceValues(trimmed));
  return [...new Set(values)];
}

function academicEvidenceValuesForLabel(label: string, packet: SubmissionPacket): string[] {
  const normalizedLabel = normalizeReviewQuestionLabel(label).toLowerCase();
  const values: string[] = [];
  if (/\bgraduation\s+month\b/.test(normalizedLabel)) values.push(...selectEvidenceValues(packet.graduationMonth));
  if (/\bgraduation\s+year\b|\byear\s+of\s+graduation\b|\bexpected\s+graduation\s+year\b/.test(normalizedLabel)) {
    values.push(...selectEvidenceValues(packet.graduationYear));
  }
  if (/\bgraduation\s+date\b|\bexpected\s+graduation\b|\bexpect\s+to\s+graduate\b|\bgraduate\s+or\s+complete\s+your\s+program\b/.test(normalizedLabel)) {
    values.push(...selectEvidenceValues(packet.graduationDate));
    values.push(...selectEvidenceValues(packet.graduationYear));
  }
  if (/\bgpa\b|\boverall\s+gpa\b|\bgrade\s+point\b/.test(normalizedLabel)) values.push(...selectEvidenceValues(packet.gpa));
  if (/\bdiscipline\b|\bfield\s+of\s+study\b|\bmajor\b|\bcourse\b/.test(normalizedLabel)) {
    values.push(...selectEvidenceValues(packet.major));
    if (/computer science/i.test(packet.degree ?? '')) values.push('Computer Science');
  }
  if (/\bschool\b|\buniversity\b|\bcollege\b|\binstitution\b/.test(normalizedLabel)
    && !/\bhigh\s+school\b/.test(normalizedLabel)
    && !/\bgraduat/.test(normalizedLabel)) {
    values.push(...selectEvidenceValues(packet.school));
    if (/university of southern california/i.test(packet.school ?? '')) values.push('University of Southern California');
  }
  if (/\bdegree\b|\beducation\s+level\b|\blevel\s+of\s+education\b/.test(normalizedLabel)) {
    values.push(...selectEvidenceValues(packet.degree));
  }
  if (/\bhow\s+did\s+you\s+hear\b|\bhear\s+about\b|\breferral\s+source\b|\bsource\b/.test(normalizedLabel)) {
    values.push(...selectEvidenceValues(packet.referralSourceDefault ?? 'Company website'));
  }
  if (/\b(?:candidate|applicant)\s+privacy\s+(?:policy|notice)\b|\bnotice\s+at\s+collection\b|\bprocess\s+your\s+personal\s+data\b|\bprocessing\s+of\s+personal\s+data\b/.test(normalizedLabel)) {
    values.push('Yes', 'I agree', 'Acknowledge/Confirm', 'Yes, I consent');
  }
  return [...new Set(values)];
}

function expectedGreenhouseRequiredValues(label: string, packet: SubmissionPacket): string[] {
  const normalizedLabel = normalizeReviewQuestionLabel(label);
  const values: string[] = [];
  values.push(...academicEvidenceValuesForLabel(label, packet));
  for (const question of packet.questions) {
    const normalizedQuestion = normalizeReviewQuestionLabel(question.question);
    if (!normalizedQuestion) continue;
    if (!normalizedQuestion.includes(normalizedLabel) && !normalizedLabel.includes(normalizedQuestion.slice(0, 80))) continue;
    values.push(...selectEvidenceValues(question.answer));
  }
  return [...new Set(values)];
}

function resultEvidenceMatchesRequiredLabel(
  label: string,
  result: { text?: string; filledFields?: string[] },
  packet: SubmissionPacket,
): boolean {
  const labelKey = compactEvidenceText(label).slice(0, 80);
  if (!labelKey) return false;
  const text = compactEvidenceText(result.text);
  if (!text.includes(labelKey)) return false;
  return expectedGreenhouseRequiredValues(label, packet).some((value) => {
    const valueKey = compactEvidenceText(value);
    return valueKey.length > 0 && text.includes(`${labelKey}${valueKey}`);
  });
}

export function reconcileManagedProviderBlockers(
  portal: SupportedPortal,
  blockers: readonly string[],
  result: { text?: string; filledFields?: string[] },
  packet: SubmissionPacket,
): string[] {
  if (portal !== 'greenhouse') return [...blockers];
  return blockers.filter((blocker) => {
    const match = blocker.match(/^"(.+)" is required and is still empty$/);
    if (!match) return true;
    return !resultEvidenceMatchesRequiredLabel(match[1]!, result, packet);
  });
}

/**
 * The one sentence for a run that has no evidence it ever reached the application form.
 *
 * It claims only what zero evidence supports: not that the form was absent, but that Litos cannot
 * confirm reaching it. That distinction is the point. Saying "the form did not record your email"
 * asserts a form was filled, and the five owner packets of 2026-08-06 that said exactly that had
 * preview screenshots of a job description page - Jump Trading's was a branded careers page whose
 * only application control is an "Apply" button, with no form on it anywhere.
 */
export const FORM_NOT_REACHED_REASON =
  'Litos could not confirm it reached this company\u2019s application form. Nothing was filled in and nothing has been sent. Open it when you have a minute and finish it off.';

const REQUIRED_AND_EMPTY_BLOCKER = /^"(.+)" is required and is still empty$/;

/**
 * Whether the run has POSITIVE evidence it was looking at the application form.
 *
 * Positive evidence only. The absence of a filled field is not evidence of anything on its own,
 * which is precisely how "filled nothing" got reported as "the filled form is missing an email":
 * the old code read an empty filled_fields list and described the form it assumed was there.
 *
 * Each signal below is something that cannot be produced by a page with no form on it:
 *  - a recorded filled field means a control was located and typed into;
 *  - a provider blocker naming a specific control as required-and-still-empty means the provider
 *    found that control (this is what makes the Nuro run of 2026-08-06 genuinely "form reached,
 *    fields empty" while the Jump Trading run beside it was not);
 *  - a discovered question means the discover pass enumerated real inputs;
 *  - a non-null extract of something on the FORM means the probed element existed;
 *  - the applicant's own email appearing in the page text means it was typed there, whatever the
 *    provider did or did not report back.
 *
 * CAPTCHA EVIDENCE IS SUBTRACTED FIRST, and this is the part that has to stay. Every managed fill
 * run appends the challenge reads to its extract list, and one of them is a reCAPTCHA anchor iframe
 * whose selector deliberately does not exclude the badge, because the badge's own anchor is the
 * only thing that identifies an invisible-only page. That anchor exists on a large share of
 * employer pages, application form or not - the Akuna Greenhouse page carries one over a page this
 * runner never filled a field on. Counting it as reach turned "we cannot confirm we reached your
 * application form" into the three-sentence description of a form that was never opened, on every
 * reCAPTCHA-bearing page, which is precisely the sentence the not-reached reason exists to delete.
 *
 * A challenge widget is evidence that a page loaded. It is not evidence of an application form.
 */
export function applicationFormWasReached(input: {
  filledFields?: readonly string[];
  providerBlockers?: readonly string[];
  discoveredQuestionCount?: number;
  extracted?: ReadonlyArray<{ label?: string; selector?: string; value: string | null }>;
  text?: string;
  email?: string;
}): boolean {
  if ((input.filledFields?.length ?? 0) > 0) return true;
  if ((input.providerBlockers ?? []).some((blocker) => REQUIRED_AND_EMPTY_BLOCKER.test(blocker))) return true;
  if ((input.discoveredQuestionCount ?? 0) > 0) return true;
  const formExtracts = (input.extracted ?? []).filter((item) => !isManagedCaptchaEvidenceExtract(item));
  if (formExtracts.some((item) => item.value?.trim())) return true;
  const email = compactEvidenceText(input.email);
  return email.length > 0 && compactEvidenceText(input.text).includes(email);
}

export function preparationEvidenceBlockers(
  result: {
    text?: string;
    filledFields?: string[];
    blockers?: readonly string[];
    discovered?: ReadonlyArray<unknown>;
    extracted?: ReadonlyArray<{ label?: string; selector?: string; value: string | null }>;
  },
  packet: SubmissionPacket,
): string[] {
  const previewBlockers = previewContentBlockers(result.text);
  if (previewBlockers.length > 0) return previewBlockers;
  // The abort case gets ONE honest sentence and no fabricated field list. Returning the per-field
  // blockers here is what made those runs unreadable, and inventing a blocker list to fill the
  // space would repeat the same lie in different words.
  if (!applicationFormWasReached({
    filledFields: result.filledFields,
    providerBlockers: result.blockers,
    discoveredQuestionCount: result.discovered?.length ?? 0,
    extracted: result.extracted,
    text: result.text,
    email: packet.email,
  })) {
    return [FORM_NOT_REACHED_REASON];
  }
  return filledFieldBlockers(result.filledFields, packet);
}

// Classification now lives in lib/submissionTerminalCause so that applyReviewPatch, which is in
// lib/ and cannot import a route module, enforces the terminal-cause invariant with the SAME
// classifier the runner uses. Re-exported here because that is where every existing caller and
// test reaches for it.
export { attentionCategoriesForReasons };

export function attentionBlockersForManagedResult(
  portal: SupportedPortal,
  blockers: readonly string[],
  result: { text?: string; filledFields?: string[] },
  packet: SubmissionPacket,
): string[] {
  if (!blockersIncludeCaptcha(blockers)) return [...blockers];
  return reconcileManagedProviderBlockers(portal, blockers, result, packet);
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

export function applicationContextForQuestionResolution(row: ResumeRow, current: ApplicationReviewState): string {
  const context = (row.job_context && typeof row.job_context === 'object' ? row.job_context : {}) as Record<string, unknown>;
  const locationValues = [
    typeof context.location === 'string' ? context.location : '',
    ...(Array.isArray(context.locations) ? context.locations.filter((value): value is string => typeof value === 'string') : []),
  ].map((value) => value.trim()).filter(Boolean);
  const classifiedLocations = [...new Set(locationValues)].map((value) => ({ value, country: jobCountry(value) }));
  const safeLocations = classifiedLocations.length > 0 && classifiedLocations.every((item) => item.country === 'us')
    ? classifiedLocations.map((item) => item.value).join('\n')
    : '';
  return [current.role, current.jd_text, safeLocations]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
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
export async function discoverAndResolveQuestions(
  discovered: DiscoveredQuestion[],
  row: ResumeRow,
  current: ApplicationReviewState,
  ap: ApplicationProfileLike,
  automaticSubmissionEnabled: boolean,
  portal: SupportedPortal,
): Promise<{ questions: ApplicationReviewQuestion[]; attentionReasons: string[] }> {
  const existingByLabel = new Map(
    current.questions.map((q) => [normalizeReviewQuestionLabel(q.question).toLowerCase(), q] as const),
  );
  const questions: ApplicationReviewQuestion[] = [];
  const attentionReasons: string[] = [];

  let bank: Awaited<ReturnType<typeof readExperienceBank>> | null = null;
  let declaredSkills: string[] = [];
  let groundingFacts: ApplicantGroundingFacts = {};
  let company = 'this company';
  try {
    company = new URL(current.portal_url!).hostname.replace(/^www\./, '').split('.')[0];
  } catch {
    // keep the fallback
  }
  const questionContext = applicationContextForQuestionResolution(row, current);
  // Tested against the RAW label on purpose: normalizeDiscoveredLabel now strips the `--0`
  // section handle, because leaving it in the stored question text is what made every
  // `label:has-text(...)` scope miss. The handle is still the honest signal for "this is an
  // education-section combobox", so read it before it is stripped rather than after.
  const managedGreenhouseEducationCombobox = (field: DiscoveredQuestion): boolean =>
    portal === 'greenhouse'
    && /\b(?:school|degree|discipline)--\d+\b/i.test(field.label);
  const portalSelectorForField = (field: DiscoveredQuestion): string | undefined => {
    if (managedGreenhouseEducationCombobox(field)) return undefined;
    if (portal === 'greenhouse' && /^combobox$/i.test(field.inputType)) return field.selector;
    return /^(?:text|email|tel|url|number|date|textarea)?$/i.test(field.inputType)
      ? field.selector
      : undefined;
  };

  /* R-096. A required field the applicant is the only one who can answer.
   *
   * This loop used to record a question ONLY when Litos had produced an answer for it, and drop the
   * field otherwise - by `continue` on a refusal, on a skip, and, at the end, on anything that was
   * neither a known field nor an essay. The fill pass then met the same control, found it required
   * and empty, and wrote '"Discipline" is required and is still empty' into attention_reason. So the
   * dashboard named a field it had no input for, and the applicant could not answer it inside the
   * product no matter which button she pressed. 126 of 242 blocker sentences across the owner's 83
   * packets named a field with no question record at all.
   *
   * The record carries NO answer, and that is the point. Discovery reaches here precisely when
   * profile resolution, the refusals, and the drafter have all declined, and the refusals are load
   * bearing: legal attestations, export controls, and every self-declaration must stay unanswered
   * until the applicant answers them herself. Surfacing the field is what makes that refusal
   * actionable instead of terminal. */
  const unansweredRequiredQuestion = (
    field: DiscoveredQuestion,
    reviewLabel: string,
    existing: ApplicationReviewQuestion | undefined,
  ): ApplicationReviewQuestion => ({
    id: existing?.id ?? randomUUID(),
    question: reviewLabel,
    // Whatever the applicant has already typed survives; Litos never overwrites her answer with a
    // blank just because it has since decided it cannot answer the question itself.
    answer: existing?.answer ?? '',
    kind: 'required',
    required: true,
    portal_selector: portalSelectorForField(field),
    portal_input_type: field.inputType,
  });

  for (const field of discovered) {
    const label = normalizeDiscoveredLabel(field.label);
    const reviewLabel = normalizeReviewQuestionLabel(field.label);
    if (!label || !reviewLabel || normalizeStoredPortalQuestions([{ question: label, answer: '' }], portal).length === 0) continue;
    // Read from the RAW label, so it has to happen before the normalized label is used anywhere:
    // normalizeDiscoveredLabel strips the employer's `*` required marker along with the handles.
    // Name and email are excluded: the fixed-field pass has already typed them into the page, and
    // making them "required answer missing" would block every application on data Litos supplied.
    const fieldIsRequired = discoveredFieldIsRequired(field) && !isCoreIdentityField(label);
    const existing = existingByLabel.get(reviewLabel.toLowerCase());
    const known = resolveKnownAnswer(label, field.inputType, ap, questionContext);
    // One resolution layer for the value itself. resolveKnownAnswer still decides WHETHER the
    // question is answerable (and owns every skip and refusal); resolveProfileField decides what
    // the answer should LOOK LIKE for this particular control, snapping it onto the field's real
    // option list when discovery reported one. Without this a closed list was handed the
    // profile's own phrasing and selected nothing at all.
    const resolvedField = known && 'value' in known
      ? resolveProfileField(
        { label, inputType: field.inputType, options: field.options },
        ap,
        questionContext,
      )
      : null;
    const knownValue = resolvedField?.value ?? (known && 'value' in known ? known.value : '');
    // "I had an answer and deliberately did not pick anything off this list."
    //
    // resolveProfileField reports that as matchedOption: false, and this loop used to throw the
    // flag away, so the one case where Litos KNOWS a control will be left unfilled was the one case
    // the applicant never heard about. The refusal itself is correct: snapping a stored answer onto
    // a closed list it does not actually appear in is how a wrong answer gets submitted under a
    // question with legal weight. But a select nobody chose from is a required field left empty at
    // the portal, so it is work for her, and it has to reach her as work rather than as silence.
    //
    // Only when the control really had a list. matchedOption is false for every free-text field
    // too, and those are filled with the value beside it.
    if (resolvedField && !resolvedField.matchedOption && usableOptions(field.options).length > 0) {
      attentionReasons.push(`none of the options match your saved answer, so this one is left for you: "${label.slice(0, 60)}"`);
    }
    if (existing) {
      if (known && 'skipReason' in known) {
        attentionReasons.push(known.skipReason);
        // Litos declined, so the question belongs to the applicant. Keeping the record (with her own
        // answer if she has already given one) is what lets her give it; dropping it here is how a
        // stored answer used to be thrown away by a later run that had decided to refuse.
        if (fieldIsRequired) questions.push(unansweredRequiredQuestion(field, reviewLabel, existing));
      } else if (known && 'value' in known) {
        questions.push({
          ...existing,
          question: reviewLabel,
          answer: knownValue,
          kind: 'required',
          required: fieldIsRequired,
          portal_selector: portalSelectorForField(field),
          portal_input_type: field.inputType,
        });
      } else if (existing.answer.trim()) {
        questions.push({
          ...existing,
          question: reviewLabel,
          required: existing.required || fieldIsRequired,
          portal_selector: portalSelectorForField(field),
          portal_input_type: field.inputType,
        });
      } else if (fieldIsRequired) {
        questions.push(unansweredRequiredQuestion(field, reviewLabel, existing));
      }
      continue; // already answered by the client or a prior run
    }

    if (known && 'value' in known) {
      questions.push({
        id: randomUUID(),
        question: reviewLabel,
        answer: knownValue,
        kind: 'required',
        required: fieldIsRequired,
        portal_selector: portalSelectorForField(field),
        portal_input_type: field.inputType,
      });
      continue;
    }
    if (known && 'skipReason' in known) {
      attentionReasons.push(known.skipReason);
      if (fieldIsRequired) questions.push(unansweredRequiredQuestion(field, reviewLabel, existing));
      continue;
    }
    if (isRefusedQuestion(label)) {
      attentionReasons.push(WORK_ELIGIBILITY_QUESTION.test(label)
        ? workEligibilitySkipReason(label)
        : `sensitive question left for you: "${label.slice(0, 60)}"`);
      // Still never answered. Surfaced now, with an empty answer, when the employer requires it -
      // otherwise a required attestation is a wall: Litos will not answer it and the applicant has
      // nowhere to. An optional sensitive field is left alone exactly as before.
      if (fieldIsRequired) questions.push(unansweredRequiredQuestion(field, reviewLabel, existing));
      continue;
    }
    if (!isOpenEndedQuestion(label)) {
      // The single biggest source of unanswerable blockers. "Discipline", "Graduation Month",
      // "EXPORT CONTROLS - ...": not a field Litos knows, not an essay it can draft, and until now
      // dropped without even an attention reason. Required means the employer will not accept the
      // form without it, so it is the applicant's to answer and she has to be able to see it.
      if (fieldIsRequired) questions.push(unansweredRequiredQuestion(field, reviewLabel, existing));
      continue;
    }

    // Open-ended answers remain grounded by draftApplicationAnswer. Standing consent authorizes
    // those grounded drafts to proceed; without it, the existing per-application review remains.
    try {
      if (bank === null) {
        bank = await readExperienceBank(row.user_id);
        const [profileRow] = await db.select().from(profiles).where(eq(profiles.user_id, row.user_id)).limit(1);
        groundingFacts = applicantGroundingFacts(profileRow?.parsed_json, ap);
        declaredSkills = declaredSkillsList(profileRow?.skills);
      }
      if (bank.length === 0) {
        attentionReasons.push(`open-ended question left for you (no experience bank on file): "${label.slice(0, 60)}"`);
        if (fieldIsRequired) questions.push(unansweredRequiredQuestion(field, reviewLabel, existing));
        continue;
      }
      const { answer, warnings } = await draftApplicationAnswer(
        label,
        company,
        current.role ?? 'this role',
        current.jd_text,
        bank,
        groundingFacts,
        declaredSkills,
      );
      const fitted = answer ? fitToBudget(answer, field.maxLength ?? 100_000) : null;
      if (!fitted) {
        attentionReasons.push(`open-ended question left for you (could not draft a confident answer): "${label.slice(0, 60)}"`);
        if (fieldIsRequired) questions.push(unansweredRequiredQuestion(field, reviewLabel, existing));
        continue;
      }
      questions.push({ id: randomUUID(), question: reviewLabel, answer: fitted, kind: 'essay', required: fieldIsRequired, portal_selector: field.selector, portal_input_type: field.inputType });
      if (warnings.length > 0) {
        attentionReasons.push(`drafted answer needs your review: ${warnings.join('; ').slice(0, 300)}`);
      }
      if (!automaticSubmissionEnabled) {
        attentionReasons.push(`AI-drafted answer needs your review before this goes out: "${label.slice(0, 60)}"`);
      }
    } catch (error) {
      if (isBillingOrAuthFailure(error)) throw error; // this is a real outage, not a per-field skip
      attentionReasons.push(`open-ended question left for you (draft generation failed): "${label.slice(0, 60)}"`);
      if (fieldIsRequired) questions.push(unansweredRequiredQuestion(field, reviewLabel, existing));
    }
  }

  return { questions, attentionReasons };
}

/**
 * Shortest label worth comparing by prefix. Providers truncate a long blocker label, so a stored
 * question and a blocker naming the same field agree only on their opening; below this length that
 * agreement is a coincidence rather than a match.
 */
const BLOCKER_PREFIX_MATCH_MIN_LENGTH = 8;

/**
 * The required fields this run has left the applicant no way to answer.
 *
 * A blocker is Litos saying "the employer will not accept the form without this". A question record
 * is Litos giving her somewhere to put the answer. When the first exists without the second, the
 * dashboard names an obstacle and offers no control that can clear it, and the run has, until now,
 * reported no error at all - the DRW packet carried 27 of these and called itself
 * `needs_attention` with an empty `questions` array and `submission_error: null`.
 *
 * Counting them is what turns that into a sentence she can act on and an engineer can measure. It
 * says nothing about WHY the field is unanswerable: a transcript upload she has never given Litos
 * and a question the discovery pass simply never saw both land here, and both are honest to report.
 */
export function unansweredRequiredBlockerLabels(
  blockers: readonly string[],
  questions: readonly { question: string }[],
): string[] {
  const asked = questions
    .map((item) => normalizeReviewQuestionLabel(item.question).toLowerCase())
    .filter(Boolean);
  const out: string[] = [];
  for (const blocker of blockers) {
    const label = blocker.match(REQUIRED_AND_EMPTY_BLOCKER)?.[1];
    if (!label) continue;
    const needle = normalizeReviewQuestionLabel(label).toLowerCase();
    if (!needle) continue;
    const matched = asked.some((question) => {
      if (question === needle) return true;
      if (question.length < BLOCKER_PREFIX_MATCH_MIN_LENGTH || needle.length < BLOCKER_PREFIX_MATCH_MIN_LENGTH) return false;
      return question.startsWith(needle) || needle.startsWith(question);
    });
    if (matched) continue;
    out.push(label);
  }
  return [...new Set(out)];
}

/**
 * What the run owes the applicant about its own blind spots, in her words.
 *
 * Two separate admissions, and they are not the same failure. The first is "the scan did not run";
 * the second is "the scan ran and still there are required fields you cannot answer here". A run
 * can produce either, both, or neither.
 */
export function discoveryHonestyReasons(
  discoveryFailure: string | undefined,
  unansweredRequired: readonly string[],
): string[] {
  const reasons: string[] = [];
  if (discoveryFailure) {
    reasons.push(
      'we could not read the questions this form asks, so anything beyond the standard fields is not '
      + `answerable in Litos on this run (${discoveryFailure.slice(0, 200)})`,
    );
  }
  if (unansweredRequired.length > 0) {
    const named = unansweredRequired.map((label) => `"${label.slice(0, 60)}"`).join(', ');
    reasons.push(
      `${unansweredRequired.length} required ${unansweredRequired.length === 1 ? 'field has' : 'fields have'} `
      + `no question you can answer in Litos: ${named.slice(0, 400)}`,
    );
  }
  return reasons;
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
  /* `.catch(() => null)` used to be the whole error handling here, and it is how a total failure of
   * the discovery pass became indistinguishable from a form that simply had no custom questions.
   *
   * Measured on DRW's Software Developer Intern packet, 2026-08-08: the action list was 145 long,
   * the runner rejects anything over 120 before opening a browser, so this call returned HTTP 400
   * and nothing at all was discovered. The run then filled the fixed fields, recorded 27 separate
   * "is required and is still empty" blockers, wrote zero question records, and reported no error.
   * The applicant was handed 27 named obstacles and no way to answer any of them.
   *
   * The budget bug is fixed in buildManagedDiscoveryActions. This is the second half: a discovery
   * pass that fails for ANY reason now says so, in the applicant's own attention list, and the run
   * cannot be called safe on the strength of a page it never read. */
  // An array rather than a nullable local so the assignment inside the catch callback is visible to
  // the code below it; TypeScript does not narrow across a closure it cannot prove ran.
  const discoveryFailures: string[] = [];
  const discoveryResult = await runManagedBrowser(applicationUrl, buildManagedDiscoveryActions(portal, packet))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      discoveryFailures.push(message);
      fastify.log.error(
        { applicationId: row.id, portal, error: message },
        'Question discovery pass failed, so this run cannot see the questions this form asks',
      );
      return null;
    });
  // The closed lists' REAL option texts, read off the live page by the discovery pass. Without
  // these, resolveProfileField's option snapping (PR #361) is inert on this path: the managed
  // provider's discover action reports no options at all, so a control offering "Computer Science"
  // was handed the stored major, matched nothing, and came back required-and-empty.
  const fieldOptions = managedResultFieldOptions(discoveryResult);
  const discoveredFields = attachManagedFieldOptions(discoveryResult?.discovered ?? [], fieldOptions);
  const coverLetterSupported = managedResultHasCoverLetterUpload(discoveryResult, portal);
  const coverLetterOutcome = await packetForCoverLetterCapability(row, coverLetterSupported, fastify);
  packet = coverLetterOutcome.packet;
  const storedQuestions = normalizeStoredPortalQuestions(current.questions, portal);
  const resolutionCurrent = { ...current, questions: storedQuestions };
  const applicationProfile = await loadApplicationProfileLike(row.user_id);
  const { questions: discoveredQuestions, attentionReasons: discoveryAttention } = await discoverAndResolveQuestions(
    discoveredFields,
    row,
    resolutionCurrent,
    applicationProfile,
    authorization.enabled,
    portal,
  );
  const mergedQuestions = normalizeApplicationReviewQuestions([...discoveredQuestions, ...storedQuestions]);
  packet.questions = mergedQuestions.map((q) => ({
    question: q.question,
    answer: q.answer,
    portalSelector: q.portal_selector,
    portalInputType: q.portal_input_type,
  }));
  // The fill run gets the same option lists, so the fixed education comboboxes type an exact option
  // instead of the profile's own phrasing. It only ever gets ONE attempt at a react-select (a second
  // click closes the menu the first one opened), so the first value has to be the right one.
  packet.fieldOptions = fieldOptions;

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
  //
  // THIS IS WHERE EVERY STALLED PACKET ACTUALLY STOPPED, measured against prod on 2026-08-08: all
  // fourteen open stalls in the database were written below by this function, not by the submit
  // path's probe. Each one carries `submission_error: null` and an attention_reason whose first line
  // is the provider's own "CAPTCHA requires your attention" - the throw at the submit probe writes a
  // submission_error and a different sentence, and neither appears on any row Litos has ever
  // written. So the runner's CAPTCHA verdict, arriving here in result.blockers, is what stopped
  // them, on Greenhouse pages whose only challenge is an invisible reCAPTCHA behind the badge.
  // corroborateManagedCaptchaBlockers is the layer that asks the page rather than the provider.
  const blockers = corroborateManagedCaptchaBlockers(
    portal,
    attentionBlockersForManagedResult(
      portal,
      sanitizeProviderBlockers(result.blockers ?? []),
      result,
      packet,
    ),
    result,
  );
  // A blocker naming a field the stored profile CAN answer is a Litos defect, never work for the
  // applicant. Twenty-five prod packets carried exactly these lines (GPA, university, education
  // level, graduation month and year, referral source) with the resolved answer already sitting
  // in the same row, and nothing recorded that the two facts contradicted each other. Logging it
  // by name is what turns the next occurrence into a bug report instead of another silent stall.
  const unattemptedProfileFields = profileBackedBlockerLabels(
    blockers,
    applicationProfile,
    applicationContextForQuestionResolution(row, resolutionCurrent),
  );
  if (unattemptedProfileFields.length > 0) {
    fastify.log.error(
      { applicationId: row.id, portal, fields: unattemptedProfileFields },
      'Profile-backed fields reported as required and still empty',
    );
  }
  const verificationHandoff = blockers.some((blocker) =>
    /verification code|security code|one[ -]?time code|passcode|\botp\b/i.test(blocker),
  );
  // A missing cover letter is worth telling the applicant about, but it is not a blocker: the form
  // is filled and sendable without it, so it must not flip the run out of the safe path.
  const coverLetterAttention = coverLetterOutcome.coverLetterIssue ? [coverLetterOutcome.coverLetterIssue] : [];
  const filledFields = managedResultFilledFields(result);
  // Both passes count as evidence the form was reached. The discovery pass enumerates the live
  // inputs and probes the core fields, so a run whose fill pass came back empty can still have
  // proven the form was there - and a run where NEITHER pass saw anything has proven the opposite.
  const evidenceBlockers = preparationEvidenceBlockers({
    ...result,
    filledFields,
    blockers: [...(result.blockers ?? []), ...(discoveryResult?.blockers ?? [])],
    discovered: discoveredFields,
    extracted: [...(result.extracted ?? []), ...(discoveryResult?.extracted ?? [])],
  }, packet);
  // The gap between what the employer demands and what Litos can offer her a place to type. See
  // unansweredRequiredBlockerLabels: this is the measurement the DRW run should have carried and did
  // not, and it is logged as an error because a non-zero count is a product defect first and the
  // applicant's problem second.
  const unansweredRequired = unansweredRequiredBlockerLabels(blockers, mergedQuestions);
  if (unansweredRequired.length > 0 || discoveryFailures.length > 0) {
    fastify.log.error({
      applicationId: row.id,
      portal,
      discoveryFailure: discoveryFailures[0],
      discoveredCount: discoveredFields.length,
      questionCount: mergedQuestions.length,
      unansweredRequired,
    }, 'Required fields with no answerable question record');
  }
  const honestyReasons = discoveryHonestyReasons(discoveryFailures[0], unansweredRequired);
  const attentionReasons = [
    ...blockers,
    ...discoveryAttention,
    ...evidenceBlockers,
    ...coverLetterAttention,
    ...honestyReasons,
  ];
  const attentionCategories = attentionCategoriesForReasons(attentionReasons);
  const captchaAttention = blockersIncludeCaptcha(blockers);
  // A discovery pass that never ran cannot be the basis for calling a form complete, so its failure
  // is a gate on `safe` in its own right: without this, a page whose fixed fields all filled would
  // still be sent while every question the employer asked went unread.
  const safe = blockers.length === 0
    && discoveryAttention.length === 0
    && evidenceBlockers.length === 0
    && discoveryFailures.length === 0;
  const review = nextReview(current, {
    ...preparedReviewPatch(authorization, safe),
    ...(captchaAttention
      ? beginStall(current, {
        surface: 'server_run',
        // Read off the page's own markup rather than hard-coded. `unknown` was written on every one
        // of the fourteen stalls in prod, including pages carrying a reCAPTCHA anchor iframe, which
        // made the instrumentation unable to answer the single question it exists for: which
        // providers actually gate us. A run that stops owes a reason, and "I did not look" is not one.
        provider: managedCaptchaProvider(result, portal),
        /* 'at_submit', because by the time this line runs THE FILL ALREADY HAPPENED. The managed run
           above filled the form and returned the preview screenshot; filled_fields below is written
           off that same result. Measured against prod on 2026-08-08, the fourteen open stalls this
           site wrote carry between 5 and 15 filled fields each, and every one of them was labelled
           'before_fill'. That is the sentence stallNudge renders as "Nothing is filled in yet" about
           a form Litos had completed and screenshotted for them: the exact mistake the stage field
           exists to prevent, pointed the other way round. Latent rather than delivered so far, and
           only because /internal/captcha-stall-nudge has no scheduler in vercel.json or in Actions.
           A label that is wrong until someone wires up the cron is still wrong.
           The direct Playwright path in prepare() draws it the same way, for the identical
           fill-then-observe shape - it records 'at_submit' from prepare too. 'before_fill' still
           belongs to the two sites that genuinely stop before touching the form: the pre-browser
           family gate in prepare(), and the submit path's CAPTCHA probe. */
        stage: 'at_submit',
        source: 'observed',
      })
      : {}),
    submission_run_id: runId,
    filled_fields: filledFields,
    // Which address this form was filled with, and why. See ApplicationReviewState.applicant_email.
    ...(packet.applicantEmail ? { applicant_email: packet.applicantEmail } : {}),
    preview_screenshot_url: preview.url,
    verification: { status: verificationHandoff ? 'handoff' : 'not_needed' },
    questions: mergedQuestions,
    cover_letter_supported: coverLetterSupported,
    attention_reason: attentionReasons.join('\n') || undefined,
    attention_categories: attentionCategories.length > 0 ? attentionCategories : undefined,
    handoff_expires_at: new Date(Date.now() + 55 * 60_000).toISOString(),
    submission_error: undefined,
  });
  await writeReview(row, review);
  fastify.log.info({
    applicationId: row.id,
    portal,
    status: review.status,
    attentionCategories,
    attentionReasonCount: attentionReasons.length,
    captchaOnly: attentionCategories.length === 1 && attentionCategories[0] === 'captcha',
  }, 'Application portal prepared with Stratus Sandbox');
}

async function prepare(row: ResumeRow, fastify: FastifyInstance, unattended = false) {
  const stored = row.spec as StoredSpec;
  let current = readApplicationReview(stored);
  if (!current) throw new Error('We do not have a link to the company application page');
  current = await repairReviewPortalFromMonitoredJob(row, current);
  const portalUrl = current.portal_url;
  if (!portalUrl) throw new Error('We do not have a link to the company application page');
  const portal = detectPortal(portalUrl);
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
  const atsAssessment = atsApiSubmissionEnabled() ? assessAtsSubmissionChannel(portalUrl) : null;
  if (atsAssessment?.status === 'available') {
    await writeReview(row, nextReview(current, {
      ...preparedReviewPatch(authorization, true),
      submission_run_id: runId,
      browser_context_id: undefined,
      browser_session_id: undefined,
      attention_reason: undefined,
      submission_error: undefined,
    }));
    fastify.log.info(
      { applicationId: row.id, provider: atsAssessment.provider },
      'Application prepared for employer-authorized ATS API submission',
    );
    return;
  }
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
  const session = await createBrowserSession(contextId, portalUrl);
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
    await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await navigateToApplicationForm(page, portal); // no-op except SmartRecruiters's JD-page/form-page split
    const [verificationSettings] = await db.select({ enabled: users.automatic_verification_enabled })
      .from(users).where(eq(users.id, row.user_id)).limit(1);
    let verification: BrowserVerificationResult = await completeEmailVerificationIfPresent({
      page,
      userId: row.user_id,
      portalUrl,
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
    const mergedQuestions = normalizeApplicationReviewQuestions([...discoveredQuestions, ...storedQuestions]);
    packet.questions = mergedQuestions.map((q) => ({
      question: q.question,
      answer: q.answer,
      portalSelector: q.portal_selector,
      portalInputType: q.portal_input_type,
    }));

    let result = await fillPortal(page, portal, packet);
    const postFillVerification = await completeEmailVerificationIfPresent({
      page,
      userId: row.user_id,
      portalUrl,
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
    // Same reach evidence as the managed path: the live-page question scan and the portal's own
    // required-field blockers both prove the form was in front of us, which is what separates
    // "reached it and left fields empty" from "never reached it".
    const evidenceBlockers = preparationEvidenceBlockers({
      text: pageText,
      filledFields: result.filledFields,
      blockers: result.blockers,
      discovered,
    }, packet);
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
      // Which address this form was filled with, and why. See ApplicationReviewState.applicant_email.
      ...(packet.applicantEmail ? { applicant_email: packet.applicantEmail } : {}),
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
    const evidenceBlockers = preparationEvidenceBlockers({
      text: pageText,
      filledFields: result.filledFields,
      blockers: result.blockers,
    }, packet);
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

function packetForApiSubmission(review: ApplicationReviewState, builtPacket: SubmissionPacket): SubmissionPacket {
  return review.cover_letter_supported === false ? omitCoverLetter(builtPacket) : builtPacket;
}

async function submitViaAtsSubmissionChannel(
  row: ResumeRow,
  review: ApplicationReviewState,
  fastify: FastifyInstance,
): Promise<boolean> {
  if (!atsApiSubmissionEnabled()) return false;
  review = await repairReviewPortalFromMonitoredJob(row, review);
  if (!await authorizationValidAtClick(row, review)) {
    await holdRevokedSubmission(row, review);
    return true;
  }
  const packet = packetForApiSubmission(review, await buildPacket(row));
  const atsResult = await tryAtsSubmissionChannel(review.portal_url, packet);
  if (atsResult.kind === 'submitted') {
    const capturedAt = new Date().toISOString();
    await writeReview(row, nextReview(review, {
      status: 'submitted',
      submitted_at: capturedAt,
      submission_error: undefined,
      receipt: {
        confirmation_text: atsResult.confirmationText,
        final_url: atsResult.finalUrl,
        captured_at: capturedAt,
        reference_id: atsResult.referenceId,
        source: 'ats_api',
      },
    }));
    fastify.log.info({ applicationId: row.id, provider: atsResult.provider }, 'Application submission accepted by ATS API');
    return true;
  }
  if (atsResult.assessment.status === 'unavailable') {
    fastify.log.info(
      { applicationId: row.id, provider: atsResult.assessment.provider, reason: atsResult.assessment.reason },
      'ATS API submission channel unavailable, continuing with browser submission',
    );
  }
  return false;
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
  let claimedReview = readApplicationReview(row.spec);
  if (!claimedReview) return;
  claimedReview = await repairReviewPortalFromMonitoredJob(row, claimedReview);
  const claimedPortal = detectPortal(claimedReview.portal_url!);
  assertControlledPortalEnabled(claimedPortal);
  if (shouldUseLocalControlledBrowser(claimedPortal)) {
    await submitControlled(row, claimedReview, fastify);
    return;
  }
  if (await submitViaAtsSubmissionChannel(row, claimedReview, fastify)) return;
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
    // ONE check, named once. This used to read
    //   managedResultRequiresCaptchaAttention(probe) && managedCaptchaVerdictIsCorroborated(portal, probe)
    // and presented itself as probe-plus-corroboration. It was not. Both terms call
    // readManagedCaptchaEvidence on the same probe result and short-circuit on the same invisible
    // predicate, so on an autonomous family the second cannot disagree with the first and the
    // conjunction is a tautology. Corroboration is a real question exactly where the two sources
    // differ - the prepare path, which is judging the REMOTE RUNNER's blocker list against markup
    // this repo read itself - and it is still asked there. Here there is only one source, so
    // writing it as two invited the next reader to trust a layer that does not exist.
    if (managedResultRequiresCaptchaAttention(captchaProbe)) {
      // The provider is passed, not defaulted. Defaulting recorded `unknown` on pages carrying a
      // g-recaptcha-response and a reCAPTCHA anchor iframe, which is a reporting defect of its own:
      // the stall's whole job is to say what stopped the run, and this was the one stop site in the
      // codebase that declined to.
      throw new CaptchaUnresolvedError('before_fill', managedCaptchaProvider(captchaProbe, portal));
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
export type SubmissionFailureOutcome =
  /* Requeued, not terminal: the provider was unreachable, so the run goes back to the queue and
     the applicant is owed nothing yet. This is the ONLY arm allowed a missing reason. */
  | { status: 'submit_requested'; attentionReason: string | undefined; attentionCategories: ApplicationAttentionCategory[] }
  /* Terminal. `attentionReason: string` is not a style choice: it makes "a stopped run with no
     stated cause" fail to compile here, which is the half of the invariant that catches a mistake
     before it can ever be written, with withTerminalCause catching whatever gets past it. */
  | { status: TerminalRunStatus; attentionReason: string; attentionCategories: ApplicationAttentionCategory[] };

export function submissionFailureOutcome(input: {
  captchaStop: 'before_fill' | 'at_submit' | null;
  noSubmitControl: boolean;
  uncertainAfterClaim: boolean;
  externalGate: boolean;
  providerSessionFailure: boolean;
  currentAttentionReason: string | undefined;
}): SubmissionFailureOutcome {
  const { captchaStop, noSubmitControl, uncertainAfterClaim, externalGate, providerSessionFailure } = input;
  const status: TerminalRunStatus | 'submit_requested' = captchaStop || noSubmitControl || uncertainAfterClaim || providerSessionFailure
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
        : providerSessionFailure
          ? 'Litos hit a temporary secure-browser error before it could finish this application. Nothing was sent. Try this one again in a few minutes.'
          : uncertainAfterClaim
            ? 'The final submission was attempted, but Litos could not verify the employer confirmation. Check the portal or your email before trying again.'
          : input.currentAttentionReason?.trim() || undefined;
  if (status === 'submit_requested') {
    return { status, attentionReason, attentionCategories: attentionCategoriesForReasons(attentionReason ? [attentionReason] : []) };
  }
  /* THE HOLE THAT WAS HERE. This branch used to end at `input.currentAttentionReason ?? undefined`,
     so a run that threw during PREPARE - before any blocker had been written, which is when the
     runner throws most often - reached status 'failed' with attention_reason unset. Three owner
     packets did exactly that on 2026-08-06: the only record of why was submission_error, holding
     "Each selector must be a non-empty string no longer than 500 characters", which is the remote
     runner talking to whoever maintains it and is not shown to anyone. The row read as a run that
     had simply stopped.

     The fallback is deliberately generic and says so. Guessing a cause here would mean inventing
     one, and an invented cause is the failure this whole change exists to remove. */
  const reason = attentionReason ?? UNEXPLAINED_RUN_FAILURE_REASON;
  const attentionCategories = attentionCategoriesForReasons(reason.split('\n').filter((line) => line.trim()));
  return {
    status,
    attentionReason: reason,
    attentionCategories: attentionCategories.length > 0 ? attentionCategories : ['unknown'],
  };
}

export function isProviderSessionFailureMessage(message: string): boolean {
  return /sandbox stream was closed|not accepting commands/i.test(message);
}

async function fail(row: ResumeRow, error: unknown) {
  const latestRows = await db.select().from(generated_resumes).where(eq(generated_resumes.id, row.id)).limit(1);
  const current = latestRows[0] ? readApplicationReview(latestRows[0].spec) : null;
  if (!current) return;
  const message = error instanceof Error ? error.message : 'Submission runner failed';
  const externalGate = /browserbase|stratus managed browser is not configured|secure browser provider is not configured/i.test(message);
  const providerSessionFailure = isProviderSessionFailureMessage(message);
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
    captchaStop, noSubmitControl, uncertainAfterClaim, externalGate, providerSessionFailure,
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
    // The typed half. attention_reason is prose written for the applicant and cannot be counted;
    // without this a 'failed' row was unqueryable as well as unreadable, so "how often does the
    // runner break, and on what" had no answer at all.
    attention_categories: outcome.attentionCategories.length > 0 ? outcome.attentionCategories : undefined,
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
