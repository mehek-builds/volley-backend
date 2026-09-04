import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { career_page_sources, generated_resumes, monitored_jobs } from '../db/schema';
import type { ApplicationReviewState } from './applicationReview';
import {
  canonicalMonitoredPortalUrl,
  canonicalSupportedPortalUrl,
  detectPortal,
  greenhousePortalUrlNeedsBoardToken,
  isPortalSupported,
} from './portalSubmission';

/* THE POSTING THE MONITOR STOPPED SEEING, told in postingClosedReason's own sentence style
 * (submissionRunner.ts) without importing from it: that file is a route module, this one is lib/
 * and other lib/ files (applicationStall.ts's withTerminalCause) already cannot import a route
 * module, so this stays a sibling sentence rather than a shared export. Deliberately does not
 * quote a scraped page banner the way postingClosedReason does - there is no page text here, only
 * the monitor's own is_active flip - so the opening clause names the monitor instead. */
export const POSTING_CLOSED_BY_MONITOR_REASON =
  'The employer has taken this posting down: Litos\u2019 job monitor stopped seeing this listing '
  + 'during its regular check. There is no application form any more, nothing was filled in and '
  + 'nothing was sent. There is nothing left to do on this one.';

/**
 * Statuses where a browser or an employer may already be MID-ACTION on this exact packet.
 *
 * Shared by BOTH posting_status derivers - this file's own monitor-inactive check and
 * postingDeadline.ts's derivePostingDeadlineStatus - because the argument is identical for each:
 * this is read-time evidence about the POSTING, not about what THIS RUN already did, and the run's
 * own facts always outrank it. A managed fill that is mid-flight, or a submission already claimed,
 * sitting on a security code, or filed, must not be relitigated because the posting happened to go
 * inactive, or its stated deadline happened to pass, in the middle - see keepUsedPortal above for
 * the identical argument about the URL itself. Before derivePostingDeadlineStatus read this too, a
 * packet already 'submitted' (sent, done) whose jd_text names a deadline that has since passed -
 * true of nearly every submitted packet with a deadline sentence at all, since sending necessarily
 * happens before it - had its OWN attention_reason overwritten with the deadline-passed sentence on
 * every read of GET /resume/history and /applications/:id/submission. Left completely untouched
 * (not even portal_url is refreshed) rather than partially patched, because a run in one of these
 * statuses reads its own review moments after this runs and must see exactly what it wrote, not a
 * new posting_status wedged in beside it.
 */
export const POSTING_STATUS_MID_RUN_STATUSES: ReadonlySet<ApplicationReviewState['status']> = new Set([
  'submitting',
  'submission_claimed',
  'awaiting_security_code',
  'submitted',
]);

/**
 * The read-time verdict once a monitored posting's own row says is_active = false, shared by both
 * repair variants below (the live DB-query one and the /resume/history batched one) so a packet
 * reads identically from either projection.
 *
 * portal_url and ats_name are RESTORED here, same as the ordinary success path, deliberately not
 * withheld: monitoredPortalProofUnavailable reads `!current.portal_url` as "no verified destination
 * at all" and answers the generic job_not_available 409 everywhere it is checked (submit-request,
 * packet-audit, the runner's own prepare). A closed posting is a MORE specific fact than that - Litos
 * knows exactly where it was and that it is gone - so keeping the URL lets every one of those call
 * sites reach postingStatusBlocksSend's specific refusal instead of falling into the generic one.
 */
function closedPostingReview(
  current: ApplicationReviewState,
  applyUrl: string,
  observedAt: Date | string | null | undefined,
): ApplicationReviewState {
  if (POSTING_STATUS_MID_RUN_STATUSES.has(current.status)) return current;
  const observed = observedAt instanceof Date
    ? observedAt.toISOString()
    : typeof observedAt === 'string' && observedAt.trim()
      ? observedAt
      : new Date().toISOString();
  return {
    ...current,
    portal_url: applyUrl,
    ats_name: detectPortal(applyUrl),
    portal_supported: false,
    posting_status: { state: 'closed', reason: 'monitor_inactive', observed_at: observed },
    attention_reason: POSTING_CLOSED_BY_MONITOR_REASON,
    attention_categories: ['posting_closed'],
  };
}

/**
 * Whether posting_status, as it stands on this exact read, means Litos must refuse to send this
 * packet - the same predicate checked everywhere monitoredPortalProofUnavailable already is
 * (submit-request, the runner's own prepare, packet-audit), so a closed or unconfirmed-expired
 * posting is refused at every one of those gates rather than only hidden from the dashboard.
 *
 * 'closed' always blocks - there is no confirmation route for a take-down, on purpose (see
 * PostingStatus's own doc comment). 'deadline_passed' blocks UNLESS she has confirmed the employer
 * still accepts applications, which is the one thing that can turn this back on.
 */
export function postingStatusBlocksSend(review: Pick<ApplicationReviewState, 'posting_status'>): boolean {
  const status = review.posting_status;
  if (!status) return false;
  if (status.state === 'closed') return true;
  return status.state === 'deadline_passed' && !status.confirmed_open_at;
}

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
  /* submission_run_id is DELIBERATELY NOT a marker. freshSubmitRequestReview mints it when the
   * submit is REQUESTED, before any browser opens, and nothing ever clears it, so one press of
   * Apply would mark a packet used forever even if the run died before touching the URL. The three
   * markers below are written only after a browser worked against this URL. */
  const used = (current.filled_fields?.length ?? 0) > 0
    || Boolean(current.preview_screenshot_url)
    || Boolean(current.submission_attempted_at);
  /* Re-derived, never inherited: withoutPortal always forced this false, and returning `current`
   * verbatim would carry a stale true on a URL that is no longer supported. */
  return used ? { ...current, portal_supported: isPortalSupported(current.portal_url) } : null;
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
  /** monitored_jobs.is_active, batched in by GET /resume/history alongside the rest of this map. */
  isActive: boolean;
  /** monitored_jobs.last_seen_at - the monitor's own last sighting, carried into posting_status.observed_at. */
  lastSeenAt: Date | string | null;
};

export function repairHistoryReviewPortalFromMonitoredJob(
  row: ResumeRow,
  current: ApplicationReviewState,
  monitoredJobs: ReadonlyMap<string, MonitoredHistoryPortal>,
): ApplicationReviewState {
  const jobId = jobContextJobId(row);
  if (!jobId) return repairManualPortal(current);
  /* THE SAME TWO RULES AS THE READ PATH ABOVE, and they have to be here as well as there: this is
   * the variant GET /resume/history uses to project the packet LIST, and the list is where the
   * stripped Hudson River Trading row rendered "This record has no employer form URL. Add the job
   * again". Healing only the detail path would leave the two projections of one packet disagreeing. */
  const job = monitoredJobs.get(jobId);
  if (!job) return keepUsedPortal(current) ?? withoutPortal(current);
  if (normalizedIdentity(job.company) !== normalizedIdentity(jobContextText(row, 'company'))) {
    return keepUsedPortal(current) ?? withoutPortal(current);
  }
  if (normalizedIdentity(job.role) !== normalizedIdentity(jobContextText(row, 'role'))) {
    return keepUsedPortal(current) ?? withoutPortal(current);
  }
  try {
    // THE SAME THIRD RULE AS THE READ PATH BELOW: once identity agrees, is_active is checked
    // before restoring an ordinary sendable URL, so the Tracker board and the packet detail screen
    // never disagree about whether a posting has closed either.
    // Strict === false, not a falsy check: is_active is NOT NULL in the schema and always true or
    // false in production, but a fixture built before this field existed (or a caller that never
    // populated it) must read as "unknown", not as "closed".
    if (job.isActive === false) return closedPostingReview(current, job.applyUrl, job.lastSeenAt);
    return {
      ...current,
      portal_url: job.applyUrl,
      ats_name: detectPortal(job.applyUrl),
      portal_supported: true,
    };
  } catch {
    return keepUsedPortal(current) ?? withoutPortal(current);
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
  /* jd_hash is deliberately NOT read any more: the description is prose the board rewrites, and
   * company plus title plus the source-owned job id are the identity. See the restore below. */
  if (!expectedCompany || !expectedRole) return keepUsedPortal(current) ?? withoutPortal(current);
  const [job] = await db.select({
    external_id: monitored_jobs.external_id,
    apply_url: monitored_jobs.apply_url,
    posting_url: monitored_jobs.posting_url,
    ats_name: career_page_sources.ats_name,
    board_token: career_page_sources.board_token,
    company_name: monitored_jobs.company_name,
    title: monitored_jobs.title,
    description: sql<string>`left(${monitored_jobs.description}, 60000)`,
    is_active: monitored_jobs.is_active,
    last_seen_at: monitored_jobs.last_seen_at,
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
  /* THE MONITOR'S OWN VERDICT, checked once identity is established and before the ordinary
   * restore below - a posting that is still this packet's posting but that the monitor's regular
   * sweep has stopped seeing is closed, not merely unproven. See closedPostingReview. */
  // Strict === false, not a falsy check - see the identical comment on the /resume/history variant
  // above for why an absent value must read as "unknown" rather than "closed".
  if (job.is_active === false) return closedPostingReview(current, applyUrl, job.last_seen_at);
  /* THE POSTING'S PROSE IS NOT ITS IDENTITY. Company and title agree and the source owns a
   * canonical URL for this job id; a refreshed description changes the hash and nothing about where
   * the application goes. The source-owned URL is RESTORED - always, never merely kept - so a
   * wrong or stale current URL is replaced and a row an earlier, stricter pass stripped heals on
   * its next read. Only the JD text itself stays as the packet recorded it. */
  return {
    ...current,
    portal_url: applyUrl,
    ats_name: detectPortal(applyUrl),
    portal_supported: true,
  };
}
