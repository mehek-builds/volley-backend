import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { generated_resumes } from '../db/schema';
import {
  ashbyPostingFromUrl,
  genericKnownPosting,
  greenhousePostingFromUrl,
  leverPostingFromUrl,
} from './atsSubmissionChannels';
import { companyIdentity } from './companyIdentity';

/**
 * WHAT "THE SAME POSTING" MEANS, and why it is three keys rather than one.
 *
 * Employers cap re-applications and say so on the form. Deepgram's own application page states
 * that a candidate may not apply more than twice in any 60 day span within a limit group, and may
 * not re-apply to the same role within 180 days without an offer; Akuna's carries a season-long
 * exclusivity acknowledgement. A second application is not untidy, it is a cost to the applicant's
 * candidacy, and it cannot be withdrawn once the employer has it. So the identity this guard reads
 * has to be right on real data, not on the field we wish existed.
 *
 * `job_context.job_id` is the obvious key and it is not enough on its own. It is NULL on 5 of the
 * owner's 85 packets, and absent by construction on everything generated before 2026-07-28 and on
 * anything the extension creates, which is exactly the population most likely to collide with a
 * newer packet for the same role.
 *
 * MEASURED ON PRODUCTION, all 85 packets of user a18f774b:
 *   - portal_url is present on 85 of 85. job_id is present on 80 of 85.
 *   - The same Greenhouse posting is stored under two different URL strings,
 *     job-boards.greenhouse.io/akunacapital/jobs/8018893 and
 *     job-boards.greenhouse.io/embed/job_app?for=akunacapital&token=8018893, so raw URL equality
 *     misses half the twelve Akuna packets. Both reduce to greenhouse:akunacapital:8018893.
 *   - No ATS posting key mapped to more than one job_id, and none mapped to more than one
 *     company plus role. The employer's own posting id is therefore at least as discriminating as
 *     our surrogate and strictly more available.
 *   - `location` is NOT stable and must stay out of the key: three packets share Deepgram job
 *     ae847ed2 and carry location null, "USA | Remote" and "USA | Remote".
 *   - Two Palantir packets have the SAME truncated title and are genuinely different postings
 *     ("Internship - Intel" in Washington D.C. and "Internship - Commercial" in Chicago). They are
 *     kept apart by every tier here, which is the case that stops this guard from refusing work
 *     the applicant is entitled to do.
 *
 * TIERS, most authoritative first. The first tier where BOTH sides have a value decides, and no
 * lower tier gets to overrule it. A union of all three would let the weakest key veto the
 * strongest, which is how two distinct requisitions with one shared title become one.
 */
export type PostingIdentityBasis = 'ats_posting' | 'job_id' | 'company_role';

export type PostingIdentity = {
  /** "<provider>:<tenant>:<postingId>", parsed from the portal URL. The employer's own id. */
  postingKey: string | null;
  /** The monitored_jobs surrogate. Absent on extension packets and on anything pre-2026-07-28. */
  jobId: string | null;
  /** "<company>|<role>", both normalized. Last resort, and the only key a bare packet has. */
  companyRole: string | null;
};

/** "<provider>:<tenant>:<postingId>" for a portal URL we can read, else null. */
export function atsPostingKey(portalUrl: string | undefined | null): string | null {
  const url = portalUrl?.trim();
  if (!url) return null;
  const greenhouse = greenhousePostingFromUrl(url);
  if (greenhouse) return `greenhouse:${greenhouse.boardToken.toLowerCase()}:${greenhouse.jobId}`;
  const ashby = ashbyPostingFromUrl(url);
  if (ashby) return `ashby:${ashby.organization.toLowerCase()}:${ashby.jobPostingId.toLowerCase()}`;
  const lever = leverPostingFromUrl(url);
  if (lever) return `lever:${lever.site.toLowerCase()}:${lever.postingId.toLowerCase()}`;
  const generic = genericKnownPosting(url);
  if (generic) return `${generic.provider}:${generic.tenant.toLowerCase()}:${generic.jobId.toLowerCase()}`;
  return null;
}

export function postingIdentity(jobContext: unknown, portalUrl: string | undefined | null): PostingIdentity {
  const context = (jobContext && typeof jobContext === 'object' ? jobContext : {}) as Record<string, unknown>;
  const rawJobId = context.job_id;
  const jobId = typeof rawJobId === 'string' && rawJobId.trim() ? rawJobId.trim().toLowerCase() : null;
  /* Both halves fold through lib/companyIdentity.ts, which is where this file's `normalizeText`
     now lives. It is the one definition of "the same company" and it is shared with the
     prior-application resolver, so the guard and the answer cannot come to disagree about which
     employer a stored packet was for. */
  const company = companyIdentity(context.company);
  const role = companyIdentity(context.role);
  return {
    postingKey: atsPostingKey(portalUrl),
    jobId,
    companyRole: company && role ? `${company}|${role}` : null,
  };
}

/**
 * Null is never "no match, carry on" silently. `unidentifiable` is returned when the two packets
 * share no tier at all, so the caller can log that the guard abstained rather than let an absent
 * job_id read as an all-clear.
 */
export function comparePostings(a: PostingIdentity, b: PostingIdentity):
  | { same: true; basis: PostingIdentityBasis }
  | { same: false; basis: PostingIdentityBasis }
  | { same: false; basis: null } {
  if (a.postingKey && b.postingKey) return { same: a.postingKey === b.postingKey, basis: 'ats_posting' } as const;
  if (a.jobId && b.jobId) return { same: a.jobId === b.jobId, basis: 'job_id' } as const;
  if (a.companyRole && b.companyRole) return { same: a.companyRole === b.companyRole, basis: 'company_role' } as const;
  return { same: false, basis: null };
}

export type DuplicateApplicationMatch = {
  application_id: string;
  company: string;
  role: string;
  submitted_at?: string;
  basis: PostingIdentityBasis;
  /* HOW SURE THE GUARD IS THAT THE EMPLOYER HAS THE EARLIER ONE.
   *
   * 'submitted' is a receipt. 'unverified' is Skydio packet 13bccb2d: Litos pressed Send, the run
   * was cut off, and nobody knows. The guard refuses in BOTH cases, because a second application
   * cannot be withdrawn and "probably not" is not a good enough reason to risk one - but the two
   * owe the applicant different sentences, and telling her she has already applied when nobody
   * knows that is the kind of false certainty this codebase keeps having to delete. */
  certainty: 'submitted' | 'unverified';
};

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
});

function submittedOn(submittedAt: string | undefined): string {
  if (!submittedAt) return 'earlier';
  const parsed = Date.parse(submittedAt);
  return Number.isNaN(parsed) ? 'earlier' : `on ${DATE_FORMAT.format(new Date(parsed))}`;
}

/**
 * The sentence the applicant gets, and it is deliberately not a generic failure.
 *
 * It names the employer, the role and the day, because "this did not send" is indistinguishable
 * from a runner crash and would send her to retry the thing the guard just stopped. It says
 * plainly that nothing went out this time, and it does not offer a retry, because there is no
 * version of this that should be tried again.
 *
 * The wording is load-bearing in one more way: attentionCategoriesForReasons matches
 * "you have already applied" to file this as `duplicate_application` rather than `unknown`.
 */
export function duplicateApplicationReason(match: DuplicateApplicationMatch): string {
  const role = match.role.trim() || 'this role';
  const company = match.company.trim();
  const at = company ? ` at ${company}` : '';
  /* THE UNVERIFIED TWIN. Refused for the same reason and with none of the same certainty.
   *
   * Before this the guard could not see these rows at all: it selects on status 'submitted' or
   * pipeline_stage 'applied', and a cut-off submit has neither. So a second application to the same
   * posting sailed through a guard whose whole job is to stop exactly that, and the applicant would
   * have found out from the employer. Now it is stopped, and the sentence sends her to the one
   * action that unblocks both packets rather than leaving her to guess. */
  if (match.certainty === 'unverified') {
    return `Not sent: Litos already pressed Send on ${role}${at} and could not confirm what came back, `
      + 'so the employer may already have that application. Sending this one could make it two, and an '
      + 'application cannot be taken back once it is in. Open that earlier application in your Tracker, '
      + 'check the employer\u2019s page, and tell Litos whether it is there. If it is not, Litos will '
      + 'send it for you.';
  }
  return `Not sent: you have already applied to ${role}${at}, ${submittedOn(match.submitted_at)}. `
    + 'Employers cap re-applications to the same posting and count a second one against you, and an '
    + 'application cannot be taken back once it is in. Nothing has been sent this time. '
    + 'Open the earlier application in your Tracker to see where it stands.';
}

export type SubmittedTwinRow = {
  id: string;
  job_context: unknown;
  portal_url: string | null;
  submitted_at: string | null;
  /* When a submit on this row was pressed and lost, and nobody has looked yet. Null on every row
   * that is either cleanly submitted or cleanly not. */
  unverified_at?: string | null;
};

/**
 * THE PREDICATE FOR "THIS ROW ALREADY GOT TO AN EMPLOYER", written once.
 *
 * `status = 'submitted'` is the receipt; `pipeline_stage = 'applied'` is its twin, written in the
 * same breath by every send path; an unresolved `unverified_submission` is the Send that was
 * pressed and lost. Two callers read it: submittedApplications below, and
 * submittedApplicationCompanies, which the prior-application resolver uses to decide whether it may
 * answer "No" on the applicant's behalf. A second copy of this WHERE clause is how the two would
 * come to disagree about what counts as having applied.
 */
function alreadyAtEmployer() {
  return sql`(${generated_resumes.spec}->'_review'->>'status' = 'submitted'
    or ${generated_resumes.pipeline_stage} = 'applied'
    or (${generated_resumes.spec}->'_review'->'unverified_submission' is not null
      and ${generated_resumes.spec}->'_review'->'unverified_submission'->>'resolution' is null))`;
}

/**
 * Every application this user has already got to an employer.
 *
 * `status = 'submitted'` OR `pipeline_stage = 'applied'`, because the two are written in the same
 * breath by every send path and a row that has one without the other is a torn write, not a
 * not-sent application.
 *
 * NOT `submission_claimed_at`, which is what the daily cap counts, and the difference is
 * deliberate. The cap is bounding a runaway and is right to treat "may have reached the employer"
 * as reaching it. This guard is refusing work the applicant asked for, so it has to be true rather
 * than suspected: 15 of the owner's packets were claimed and then landed in needs_attention, and
 * refusing every retry after a failed run would break the exact recovery path the restart flag was
 * added for. The residual risk is a run that clicked submit and then failed to record the receipt;
 * that one is already reported to the applicant as unverified, and it is hers to judge.
 */
async function submittedApplications(userId: string, excludeId: string): Promise<SubmittedTwinRow[]> {
  const rows = await db
    .select({
      id: generated_resumes.id,
      job_context: generated_resumes.job_context,
      portal_url: sql<string | null>`${generated_resumes.spec}->'_review'->>'portal_url'`,
      submitted_at: sql<string | null>`${generated_resumes.spec}->'_review'->>'submitted_at'`,
      /* THE ROWS THE GUARD USED TO BE BLIND TO. A submit that was pressed and lost has no
         submitted_at and no 'applied' stage, so it matched neither arm below and a second
         application to the same posting was let straight through. Unresolved only: once the
         applicant has said 'not_sent' the employer provably does not have it and it stops being a
         reason to refuse anything. */
      unverified_at: sql<string | null>`case when ${generated_resumes.spec}->'_review'->'unverified_submission'->>'resolution' is null
        then ${generated_resumes.spec}->'_review'->'unverified_submission'->>'at' end`,
    })
    .from(generated_resumes)
    .where(and(
      eq(generated_resumes.user_id, userId),
      ne(generated_resumes.id, excludeId),
      alreadyAtEmployer(),
    ));
  return rows;
}

/**
 * Every employer this user's own Litos history shows an application already at, as the employer's
 * name was recorded on the packet (`job_context.company`).
 *
 * The ONE thing that may stand down the default "No" to "have you applied to us before?". Read the
 * rule at previouslyAppliedAnswer in lib/questionDiscovery.ts: an employer named here does not
 * produce a "Yes", it produces a hand-back, because these rows carry no window ("within the last
 * 12-18 months") and no role scope that the question is actually asking about.
 *
 * IT USES THE FULL alreadyAtEmployer SET, INCLUDING THE UNVERIFIED ROWS, and that is the safe
 * direction rather than a widening. An unverified row is a Send that was pressed and lost, so the
 * employer may hold that application; answering "No" over the top of one would be the same
 * confidently wrong answer as answering "No" over a receipt. `certainty` in this file exists to
 * tell the applicant those two apart in a sentence. Here they have the same consequence - do not
 * speak for her - so they are not told apart.
 */
export async function submittedApplicationCompanies(userId: string): Promise<string[]> {
  const rows = await db
    .select({ company: sql<string | null>`${generated_resumes.job_context}->>'company'` })
    .from(generated_resumes)
    .where(and(eq(generated_resumes.user_id, userId), alreadyAtEmployer()));
  const companies = rows
    .map((row) => row.company?.trim() ?? '')
    .filter((company) => company.length > 0);
  return [...new Set(companies)];
}

function companyRoleOf(jobContext: unknown): { company: string; role: string } {
  const context = (jobContext && typeof jobContext === 'object' ? jobContext : {}) as Record<string, unknown>;
  return {
    company: typeof context.company === 'string' ? context.company : '',
    role: typeof context.role === 'string' ? context.role : '',
  };
}

export type DuplicateApplicationVerdict =
  | { kind: 'clear' }
  /** No tier had a value on both sides for any submitted row. The guard abstained; log it. */
  | { kind: 'unidentifiable' }
  | { kind: 'duplicate'; match: DuplicateApplicationMatch; reason: string };

/**
 * THE GUARD. Refuse to send when this user already has a submitted application for this posting.
 *
 * Called from every point that can reach an employer rather than from one route, because a guard
 * on one of five send paths is not a guard. See submissionRunner.submit (the browser run, the ATS
 * API channel and everything standing consent reaches), POST /submit-request (the unsupported
 * portal email fallback), POST /submission/approve and POST /submission/extension-start.
 */
export async function duplicateApplicationVerdict(input: {
  userId: string;
  applicationId: string;
  jobContext: unknown;
  portalUrl: string | undefined | null;
}): Promise<DuplicateApplicationVerdict> {
  return duplicateAmong(
    input.jobContext,
    input.portalUrl,
    await submittedApplications(input.userId, input.applicationId),
  );
}

/**
 * The decision, with the database taken out of it, so the rule can be tested against the real
 * production rows rather than against a mock of a query. duplicateApplicationVerdict is the same
 * thing with the fetch attached.
 */
export function duplicateAmong(
  jobContext: unknown,
  portalUrl: string | undefined | null,
  rows: readonly SubmittedTwinRow[],
): DuplicateApplicationVerdict {
  const input = { jobContext, portalUrl };
  const mine = postingIdentity(input.jobContext, input.portalUrl);
  let comparedAnything = false;
  for (const row of rows) {
    const theirs = postingIdentity(row.job_context, row.portal_url);
    const verdict = comparePostings(mine, theirs);
    if (verdict.basis !== null) comparedAnything = true;
    if (!verdict.same) continue;
    const { company, role } = companyRoleOf(row.job_context);
    const mineNames = companyRoleOf(input.jobContext);
    /* A row can be both: submitted earlier AND carrying an unresolved record from a later attempt.
       Submitted wins, because a receipt is certainty and the sentence for certainty is the stronger
       and simpler of the two. */
    const certainty = row.submitted_at || !row.unverified_at ? 'submitted' as const : 'unverified' as const;
    const match: DuplicateApplicationMatch = {
      application_id: row.id,
      company: company || mineNames.company,
      role: role || mineNames.role,
      submitted_at: row.submitted_at ?? undefined,
      basis: verdict.basis,
      certainty,
    };
    return { kind: 'duplicate', match, reason: duplicateApplicationReason(match) };
  }
  if (rows.length > 0 && !comparedAnything) return { kind: 'unidentifiable' };
  return { kind: 'clear' };
}

/** The HTTP body every route refusal sends, so the four of them cannot drift apart. */
export function duplicateApplicationResponse(verdict: { match: DuplicateApplicationMatch; reason: string }) {
  return {
    error: verdict.reason,
    code: 'DUPLICATE_APPLICATION' as const,
    duplicate_of: verdict.match.application_id,
    matched_on: verdict.match.basis,
  };
}
