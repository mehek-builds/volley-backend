import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { career_page_sources, generated_resumes, monitored_jobs } from '../db/schema';
import type { ApplicationReviewState } from './applicationReview';
import { monitoredJdAgrees } from './monitoredPortalRepair';
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

function jobContextDeclaresJobId(row: ResumeRow): boolean {
  const jobContext = row.job_context;
  return Boolean(jobContext && typeof jobContext === 'object' && !Array.isArray(jobContext)
    && Object.hasOwn(jobContext, 'job_id'));
}

/** A job-bound packet may act only after the monitored row proves its executable destination. */
export function monitoredPortalProofUnavailable(
  row: ResumeRow,
  current: ApplicationReviewState,
): boolean {
  return jobContextDeclaresJobId(row) && !current.portal_url;
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

function withoutPortal(current: ApplicationReviewState): ApplicationReviewState {
  const { portal_url: _portalUrl, ats_name: _atsName, ...rest } = current;
  return { ...rest, portal_supported: false };
}

/* A URL A MANAGED RUN HAS ALREADY USED IS A FACT ABOUT HOW SHE APPLIED, not a claim this repair
 * gets to re-prove. Measured 2026-09-02 21:10:30 on Hudson River Trading (packet 4a79eec1): the
 * fill had just completed 41 fields on job-boards.greenhouse.io/wehrtyou when a read-time repair
 * could not re-prove the monitored row (the posting's text had been refreshed, so its hash no
 * longer matched the packet's) and stripped portal_url and ats_name from the review. The
 * dashboard then showed "This record has no employer form URL. Add the job again", and every
 * managed action on a packet that had been one press from ready disappeared. The strip exists for
 * a packet that never had a provable URL; a packet that has filled, previewed or run against its
 * URL keeps it whatever the monitored row says today. */
function keepUsedPortal(current: ApplicationReviewState): ApplicationReviewState | null {
  if (!current.portal_url) return null;
  const used = (current.filled_fields?.length ?? 0) > 0
    || Boolean(current.submission_run_id)
    || Boolean(current.preview_screenshot_url)
    || Boolean(current.submission_attempted_at);
  return used ? current : null;
}

function repairManualPortal(current: ApplicationReviewState): ApplicationReviewState {
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
  return current;
}

export type MonitoredHistoryPortal = {
  applyUrl: string;
  company: string;
  role: string;
  description: string;
  jdHash: string;
};

export function repairHistoryReviewPortalFromMonitoredJob(
  row: ResumeRow,
  current: ApplicationReviewState,
  monitoredJobs: ReadonlyMap<string, MonitoredHistoryPortal>,
): ApplicationReviewState {
  const jobId = jobContextJobId(row);
  if (!jobId) return repairManualPortal(current);
  const job = monitoredJobs.get(jobId);
  if (!job) return withoutPortal(current);
  if (normalizedIdentity(job.company) !== normalizedIdentity(jobContextText(row, 'company'))) {
    return withoutPortal(current);
  }
  if (normalizedIdentity(job.role) !== normalizedIdentity(jobContextText(row, 'role'))) {
    return withoutPortal(current);
  }
  if (!monitoredJdAgrees(jobContextText(row, 'jd_hash'), current.jd_text, job.description, job.jdHash)) {
    return withoutPortal(current);
  }
  try {
    return {
      ...current,
      portal_url: job.applyUrl,
      ats_name: detectPortal(job.applyUrl),
      portal_supported: true,
    };
  } catch {
    return withoutPortal(current);
  }
}

export async function repairReviewPortalFromMonitoredJob(
  row: ResumeRow,
  current: ApplicationReviewState,
): Promise<ApplicationReviewState> {
  const jobId = jobContextJobId(row);
  /* A monitored job is the destination authority. A supported URL already stored in the review is
     still caller-controlled historical state, so it must not bypass the source tenant and posting
     checks below. Manual packets have no monitored identity to resolve and keep the generic URL
     canonicalization used before monitored jobs existed. */
  if (!jobContextDeclaresJobId(row)) return repairManualPortal(current);
  if (!jobId) return withoutPortal(current);

  const expectedCompany = jobContextText(row, 'company');
  const expectedRole = jobContextText(row, 'role');
  const expectedJdHash = jobContextText(row, 'jd_hash');
  if (!expectedCompany || !expectedRole || !expectedJdHash) return withoutPortal(current);
  const [job] = await db.select({
    external_id: monitored_jobs.external_id,
    apply_url: monitored_jobs.apply_url,
    posting_url: monitored_jobs.posting_url,
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
  if (!job) return keepUsedPortal(current) ?? withoutPortal(current);
  const applyUrl = canonicalMonitoredPortalUrl(
    job.apply_url,
    job.ats_name,
    job.board_token,
    job.external_id,
    job.posting_url,
  );
  if (!applyUrl) return keepUsedPortal(current) ?? withoutPortal(current);
  if (normalizedIdentity(job.company_name) !== normalizedIdentity(expectedCompany)) return keepUsedPortal(current) ?? withoutPortal(current);
  if (normalizedIdentity(job.title) !== normalizedIdentity(expectedRole)) return keepUsedPortal(current) ?? withoutPortal(current);
  /* THE POSTING'S PROSE IS NOT ITS IDENTITY. Company and title agree and the source owns a
   * canonical URL for this job id; a refreshed description changes the hash and nothing about where
   * the application goes. The URL is restored (or kept), which is also what heals a row an earlier,
   * stricter pass stripped. Only the JD text itself stays as the packet recorded it. */
  if (!monitoredJdAgrees(expectedJdHash, current.jd_text, job.description) && !current.portal_url) {
    return { ...current, portal_url: applyUrl, ats_name: detectPortal(applyUrl), portal_supported: true };
  }
  return {
    ...current,
    portal_url: applyUrl,
    ats_name: detectPortal(applyUrl),
    portal_supported: true,
  };
}
