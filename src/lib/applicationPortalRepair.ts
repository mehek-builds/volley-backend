import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { career_page_sources, generated_resumes, monitored_jobs } from '../db/schema';
import type { ApplicationReviewState } from './applicationReview';
import { monitoredJdAgrees } from './monitoredPortalRepair';
import {
  isTrustedSuccessFactorsWrapperUrl,
  resolveSuccessFactorsWrapperApplicationUrl,
  sameTrustedSuccessFactorsWrapperIdentity,
  type SuccessFactorsWrapperFetch,
} from './successFactorsWrapper';
import {
  canonicalMonitoredPortalUrl,
  canonicalSupportedPortalUrl,
  detectPortal,
  greenhousePortalUrlNeedsBoardToken,
  isPortalSupported,
} from './portalSubmission';

type ResumeRow = typeof generated_resumes.$inferSelect;

function jobContextJobId(row: ResumeRow): string | null {
  const jobContext = row.job_context;
  if (!jobContext || typeof jobContext !== 'object' || Array.isArray(jobContext)) return null;
  const jobId = (jobContext as Record<string, unknown>).job_id;
  return typeof jobId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)
    ? jobId
    : null;
}

function jobContextText(row: ResumeRow, key: 'company' | 'role' | 'jd_hash'): string | null {
  const jobContext = row.job_context;
  if (!jobContext || typeof jobContext !== 'object' || Array.isArray(jobContext)) return null;
  const value = (jobContext as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizedIdentity(value: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

export async function repairSuccessFactorsWrapperReview(
  current: ApplicationReviewState,
  fetchImpl: SuccessFactorsWrapperFetch = fetch,
): Promise<ApplicationReviewState> {
  if (!current.portal_url || !isTrustedSuccessFactorsWrapperUrl(current.portal_url)) return current;
  const applicationUrl = await resolveSuccessFactorsWrapperApplicationUrl(current.portal_url, fetchImpl);
  if (!applicationUrl) return { ...current, portal_supported: false };
  return {
    ...current,
    portal_url: applicationUrl,
    ats_name: 'sap_successfactors',
    portal_supported: true,
  };
}

export async function repairReviewPortalFromMonitoredJob(
  row: ResumeRow,
  current: ApplicationReviewState,
): Promise<ApplicationReviewState> {
  const currentCanonicalUrl = canonicalSupportedPortalUrl(current.portal_url, current.ats_name);
  if (currentCanonicalUrl && currentCanonicalUrl !== current.portal_url) {
    return {
      ...current,
      portal_url: currentCanonicalUrl,
      ats_name: detectPortal(currentCanonicalUrl),
      portal_supported: true,
    };
  }
  if (current.portal_url) {
    if (
      isPortalSupported(current.portal_url)
      && !greenhousePortalUrlNeedsBoardToken(current.portal_url)
    ) return current;
  }
  const jobId = jobContextJobId(row);
  if (!jobId) return current;
  const expectedCompany = jobContextText(row, 'company');
  const expectedRole = jobContextText(row, 'role');
  const expectedJdHash = jobContextText(row, 'jd_hash');
  if (!expectedCompany || !expectedRole || !expectedJdHash) return current;
  const [job] = await db.select({
    apply_url: monitored_jobs.apply_url,
    ats_name: career_page_sources.ats_name,
    board_token: career_page_sources.board_token,
    company_name: monitored_jobs.company_name,
    title: monitored_jobs.title,
    description: sql<string>`left(${monitored_jobs.description}, 60000)`,
  })
    .from(monitored_jobs)
    .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
    .where(and(
      eq(monitored_jobs.id, jobId),
      eq(career_page_sources.enabled, true),
    ))
    .limit(1);
  if (!job) return current;
  if (normalizedIdentity(job.company_name) !== normalizedIdentity(expectedCompany)) return current;
  if (normalizedIdentity(job.title) !== normalizedIdentity(expectedRole)) return current;
  if (!monitoredJdAgrees(expectedJdHash, current.jd_text, job.description)) return current;
  const currentWrapperUrl = current.portal_url && isTrustedSuccessFactorsWrapperUrl(current.portal_url)
    ? current.portal_url
    : undefined;
  const monitoredWrapperUrl = job.apply_url && isTrustedSuccessFactorsWrapperUrl(job.apply_url)
    ? job.apply_url
    : undefined;
  if (currentWrapperUrl || monitoredWrapperUrl) {
    // The wrapper exposes a tenant and requisition only in public Jobs2Web bindings. Its URL must
    // first be the exact monitored posting whose company, role, and JD already agreed above. A
    // failed or ambiguous read stays unsupported, so neither a request URL nor another monitored
    // SAP posting can select the tenant form for this packet.
    if (
      !monitoredWrapperUrl
      || (currentWrapperUrl
        && !sameTrustedSuccessFactorsWrapperIdentity(currentWrapperUrl, monitoredWrapperUrl))
    ) return { ...current, portal_supported: false };
    return repairSuccessFactorsWrapperReview({
      ...current,
      portal_url: monitoredWrapperUrl,
      ats_name: job.ats_name ?? current.ats_name,
    });
  }
  const applyUrl = canonicalMonitoredPortalUrl(job.apply_url, job.ats_name, job.board_token);
  if (!applyUrl) return current;
  return {
    ...current,
    portal_url: applyUrl,
    ats_name: detectPortal(applyUrl),
    portal_supported: true,
  };
}
