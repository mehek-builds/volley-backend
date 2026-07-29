/* VENDORED COPY. Source of truth: role-quick-website `lib/daily-matches.ts` (origin/main @ 1728236).
 *
 * Same arrangement and same known cost as website-job-rows.vendored.ts: copied because this test
 * spans two repositories, and NOTHING DETECTS DRIFT. The ONLY change from the original is that
 * its type-only import on line 1 is replaced by the local aliases below; every other line is
 * byte-identical. Re-copy if the matcher changes. Verify with:
 *   diff <(git -C <website> show origin/main:lib/daily-matches.ts | tail -n +2) \
 *        <(tail -n +15 e2e/website-daily-matches.vendored.ts)
 */
type MonitoredJob = { id: string; company_name: string; title: string; description: string; apply_url: string; posted_at?: string | null; first_seen_at: string; location?: string | null; department?: string | null; employment_type?: string | null; remote?: boolean; ats_name?: string };
type GeneratedResume = { id?: string; job_context: { company?: string; role?: string; jd_hash?: string; job_id?: string | null } };
type ApplicationProfile = Record<string, string | undefined>;
type ParsedProfile = { skills?: string[]; target_roles?: string[] };
type Targeting = { categories: string[] | null; titles: string[] | null; role_types: string[] | null; primary_period: string | null; backup_period: string | null };

export type RankedJob = MonitoredJob & {
  match: number;
  reasons: string[];
};

export type ProfileIdentity = { full_name?: string; email?: string };

/**
 * How many of the day's top matches get a resume built ahead of time, for students who have turned
 * automatic submission ON.
 *
 * IT APPLIES TO NOBODY ELSE. Building a packet is a real cost: it spends a resume from the
 * student's monthly quota and runs a model call, so doing it speculatively for everyone spent
 * people's quota on jobs they never opened. With automatic submission on, the build-ahead is the
 * point, because the runner needs a packet ready to send. With it off, the packet is created when
 * the student asks for one.
 *
 * Replaces DAILY_PREPARED_RESUME_LIMIT (30), which fed the same loop for every account.
 */
export const AUTO_SUBMIT_PREPARED_LIMIT = 20;

export function rankJobs(
  jobs: MonitoredJob[],
  targeting: Targeting | null,
  profile: Partial<ParsedProfile> | null,
): RankedJob[] {
  const titleTerms = tokens([...(targeting?.titles ?? []), ...(profile?.target_roles ?? [])].join(" "));
  const skillTerms = tokens([...(profile?.skills ?? []), ...(targeting?.categories ?? [])].join(" "));

  return jobs
    .map((job) => {
      const title = tokens(job.title);
      const corpus = tokens(`${job.title} ${job.department ?? ""} ${job.description}`);
      const titleMatches = [...titleTerms].filter((term) => title.has(term));
      const skillMatches = [...skillTerms].filter((term) => corpus.has(term));
      const match = Math.min(98, 72 + titleMatches.length * 6 + Math.min(14, skillMatches.length * 2));
      const reasons = [...new Set([...titleMatches, ...skillMatches])].slice(0, 3).map(readableTerm);
      return {
        ...job,
        match,
        reasons: reasons.length ? reasons : [job.department || job.employment_type || "Role fit"],
      };
    })
    .sort((a, b) => b.match - a.match || (b.posted_at ?? b.first_seen_at).localeCompare(a.posted_at ?? a.first_seen_at));
}

/**
 * Whether this packet is the one for this posting.
 *
 * PREFERS THE POSTING ID, and when the packet has one it is the ONLY thing consulted. A packet
 * built for the Mountain View req must not answer for the New York req of the same title, and
 * company+role cannot tell those apart. That mattered more than it looked: this decides whether
 * "Apply now" reuses an existing packet or builds a new one, so a wrong match showed the student a
 * resume tailored to a different posting and skipped the build for the one they actually opened.
 *
 * The same rule as the "Applied" badge in lib/job-rows.ts, for the same reason: where a precise
 * identity exists it has to REPLACE the imprecise one, not sit alongside it. Falling back to
 * company+role for a packet that has an id would let the sibling match anyway and change nothing.
 *
 * The fallback stays for packets that have no id and never will: everything generated before the
 * id was recorded, and anything from the extension, where there is no monitored posting to point
 * at. Those keep the old imprecision, which is unfixable rather than merely unfixed.
 */
export function packetMatchesJob(
  packet: GeneratedResume,
  job: Pick<MonitoredJob, "id" | "company_name" | "title">,
): boolean {
  const packetJobId = packet.job_context.job_id;
  if (packetJobId) return packetJobId === job.id;
  return normalized(packet.job_context.company) === normalized(job.company_name)
    && normalized(packet.job_context.role) === normalized(job.title);
}

export function countPreparedJobs(jobs: RankedJob[], packets: GeneratedResume[]): number {
  return jobs.filter((job) => packets.some((packet) => packetMatchesJob(packet, job))).length;
}

/** Shortest job description the generator will accept. Mirrors the backend's `jd_text` minimum. */
export const MIN_JD_CHARS = 20;

/**
 * Whether a draft can be generated from without the request being rejected.
 *
 * Exists because "Apply now" generates immediately, with nothing typed by the student. A posting
 * that arrives with a stub description or a link the generator refuses would otherwise spend the
 * attempt and come back with "Fill in all four boxes first", which is nonsense to someone who
 * filled in nothing. Checking first lets the page say what is actually missing.
 *
 * Deliberately the same shape as the guard inside createApplication, sharing MIN_JD_CHARS so the
 * two cannot drift into disagreeing about what is generatable.
 */
export function canGenerateFrom(draft: {
  company: string;
  role: string;
  portalUrl: string;
  jobDescription: string;
}): boolean {
  if (!draft.company.trim() || !draft.role.trim()) return false;
  if (draft.jobDescription.trim().length < MIN_JD_CHARS) return false;
  const portalUrl = draft.portalUrl.trim();
  if (!portalUrl) return false;
  try {
    return new URL(portalUrl).protocol === "https:";
  } catch {
    return false;
  }
}

export function resumeGenerationBody(
  job: MonitoredJob,
  identity: ProfileIdentity,
  applicationProfile: ApplicationProfile,
  storedEmail: string | null,
) {
  return {
    company: job.company_name,
    role: job.title,
    jd_text: job.description,
    /* The posting this resume is for, recorded at creation so the jobs list can later mark exactly
       this row "Applied" rather than every posting sharing its company and title.

       IT HAS TO BE SET HERE, not only where the student fills the form by hand. This function feeds
       the dashboard's prewarm loop, which generates a resume per matched job automatically, so it
       is how most packets come into existence. And once a packet exists, opening the posting from
       the jobs list takes the "existing packet" branch in app/dashboard/applications/page.tsx and
       never calls /resume/generate at all. Leaving it out here therefore did not just miss the
       prewarmed rows; it meant the id was almost never recorded for anyone. */
    job_id: job.id,
    application: {
      ats_name: portalName(job.apply_url),
      portal_url: job.apply_url,
    },
    contact: {
      full_name: identity.full_name?.trim(),
      email: identity.email?.trim() || storedEmail,
      phone: applicationProfile.phone || undefined,
      linkedin_url: applicationProfile.linkedin_url || undefined,
      github_url: applicationProfile.github_url || undefined,
      portfolio_url: applicationProfile.portfolio_url || undefined,
    },
  };
}

export function portalName(portalUrl: string): string {
  const hostname = new URL(portalUrl).hostname.toLowerCase();
  if (hostname.includes("greenhouse")) return "Greenhouse";
  if (hostname.includes("lever")) return "Lever";
  if (hostname.includes("ashby")) return "Ashby";
  if (hostname.includes("workday")) return "Workday";
  if (hostname.includes("linkedin")) return "LinkedIn";
  return "the company's application page";
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z][a-z0-9+#.]{1,}/g)?.filter((term) => !STOP_WORDS.has(term)) ?? []);
}

function readableTerm(term: string): string {
  if (term === "api" || term === "apis") return "API experience";
  if (term === "typescript") return "TypeScript";
  if (term === "react") return "React";
  return term.charAt(0).toUpperCase() + term.slice(1);
}

function normalized(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const STOP_WORDS = new Set(["and", "the", "with", "for", "from", "that", "this", "your", "engineer", "engineering", "intern", "internship", "new", "grad"]);
