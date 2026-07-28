import type { AutonomousPortalFamily } from './portalSubmission';

// The boards the job monitor may poll.
//
// CONSTRAINED, not just declared: `extends AutonomousPortalFamily` means this union can only ever
// contain portals Litos can carry all the way to a confirmation by itself. Adding, say,
// 'smartrecruiters' or 'jazzhr' here is a COMPILE ERROR, not a silent product regression - which is
// the point, because the failure it prevents is invisible at the seam. A job from a portal Litos
// cannot finish looks exactly like any other job on the board; the student only finds out after
// choosing it and tailoring a resume to it.
//
// To add a board: make the portal genuinely autonomous in portalSubmission.ts first (an adapter that
// reaches a real receipt), and it becomes available here automatically. 'workable' is eligible today
// and not yet polled - adding sources for it is pure upside.
// Two different questions, and a source has to satisfy BOTH:
//   1. Can Litos finish an application on that portal alone?  -> AutonomousPortalFamily
//   2. Can this module actually poll that portal's boards?     -> needs a fetchSourceJobs branch
// Workable answers yes to (1) as of 2026-07-28 but has no fetcher, so it is not listed here yet.
// Adding one makes it a one-word change, and the `satisfies` below is what keeps (1) enforced.
export const POLLABLE_JOB_BOARDS = ['greenhouse', 'lever', 'ashby'] as const satisfies readonly AutonomousPortalFamily[];

export type SupportedJobBoard = typeof POLLABLE_JOB_BOARDS[number];

export type JobSourceInput = {
  company_name: string;
  ats_name: SupportedJobBoard;
  board_token: string;
  career_url: string;
  enabled?: boolean;
};

export type NormalizedJob = {
  external_id: string;
  title: string;
  location?: string;
  department?: string;
  employment_type?: string;
  description: string;
  apply_url: string;
  posting_url: string;
  remote: boolean;
  posted_at?: Date;
  raw_json: unknown;
};

function cleanHtml(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function date(value: unknown): Date | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function normalizeGreenhouseJobs(payload: unknown): NormalizedJob[] {
  const jobs = (payload as { jobs?: unknown[] } | null)?.jobs;
  if (!Array.isArray(jobs)) throw new Error('Greenhouse board returned an invalid jobs payload');
  return jobs.flatMap((raw) => {
    const job = raw as Record<string, unknown>;
    const id = String(job.id ?? '').trim();
    const title = text(job.title);
    const postingUrl = text(job.absolute_url);
    if (!id || !title || !postingUrl) return [];
    const location = text((job.location as Record<string, unknown> | undefined)?.name);
    const departments = Array.isArray(job.departments) ? job.departments : [];
    const department = departments
      .map((item) => text((item as Record<string, unknown>)?.name))
      .filter(Boolean)
      .join(', ') || undefined;
    return [{
      external_id: id,
      title,
      location,
      department,
      description: cleanHtml(job.content),
      apply_url: postingUrl,
      posting_url: postingUrl,
      remote: /\bremote\b/i.test(location ?? ''),
      posted_at: date(job.updated_at),
      raw_json: raw,
    }];
  });
}

export function normalizeLeverJobs(payload: unknown): NormalizedJob[] {
  if (!Array.isArray(payload)) throw new Error('Lever board returned an invalid jobs payload');
  return payload.flatMap((raw) => {
    const job = raw as Record<string, unknown>;
    const id = text(job.id);
    const title = text(job.text);
    const postingUrl = text(job.hostedUrl);
    const applyUrl = text(job.applyUrl) ?? postingUrl;
    if (!id || !title || !postingUrl || !applyUrl) return [];
    const categories = (job.categories ?? {}) as Record<string, unknown>;
    const location = text(categories.location);
    const description = [text(job.descriptionPlain), ...(Array.isArray(job.lists)
      ? job.lists.map((item) => cleanHtml((item as Record<string, unknown>).content))
      : [])].filter(Boolean).join('\n\n');
    return [{
      external_id: id,
      title,
      location,
      department: text(categories.department) ?? text(categories.team),
      employment_type: text(categories.commitment),
      description,
      apply_url: applyUrl,
      posting_url: postingUrl,
      remote: /\bremote\b/i.test([location, text(job.workplaceType)].filter(Boolean).join(' ')),
      posted_at: date(job.createdAt),
      raw_json: raw,
    }];
  });
}

export function normalizeAshbyJobs(payload: unknown): NormalizedJob[] {
  const jobs = (payload as { jobs?: unknown[] } | null)?.jobs;
  if (!Array.isArray(jobs)) throw new Error('Ashby board returned an invalid jobs payload');
  return jobs.flatMap((raw) => {
    const job = raw as Record<string, unknown>;
    const postingUrl = text(job.jobUrl);
    const applyUrl = text(job.applyUrl) ?? postingUrl;
    const id = text(job.id) ?? postingUrl;
    const title = text(job.title);
    if (!id || !title || !postingUrl || !applyUrl) return [];
    const location = text(job.location);
    return [{
      external_id: id,
      title,
      location,
      department: text(job.department) ?? text(job.team),
      employment_type: text(job.employmentType),
      description: text(job.descriptionPlain) ?? cleanHtml(job.descriptionHtml),
      apply_url: applyUrl,
      posting_url: postingUrl,
      remote: job.isRemote === true || /\bremote\b/i.test(location ?? ''),
      posted_at: date(job.publishedAt),
      raw_json: raw,
    }];
  });
}

export function sourceEndpoint(source: Pick<JobSourceInput, 'ats_name' | 'board_token'>): string {
  const token = encodeURIComponent(source.board_token.trim());
  if (source.ats_name === 'greenhouse') {
    return `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`;
  }
  if (source.ats_name === 'lever') {
    return `https://api.lever.co/v0/postings/${token}?mode=json`;
  }
  return `https://api.ashbyhq.com/posting-api/job-board/${token}`;
}

export async function fetchSourceJobs(
  source: Pick<JobSourceInput, 'ats_name' | 'board_token'>,
  fetcher: typeof fetch = fetch,
): Promise<NormalizedJob[]> {
  const response = await fetcher(sourceEndpoint(source), {
    headers: { Accept: 'application/json', 'User-Agent': 'LitosJobMonitor/1.0' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${source.ats_name} board returned HTTP ${response.status}`);
  const payload = await response.json();
  if (source.ats_name === 'greenhouse') return normalizeGreenhouseJobs(payload);
  if (source.ats_name === 'lever') return normalizeLeverJobs(payload);
  return normalizeAshbyJobs(payload);
}
