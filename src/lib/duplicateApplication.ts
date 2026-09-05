import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { generated_resumes } from '../db/schema';
import {
  canonicalExactPostingUrl,
  loadPostingDistinctionCandidateByKey,
  postingDistinctionApplies,
  postingDistinctionCandidateIdentity,
  postingDistinctionsForCurrentCandidate,
  PostingDistinctionError,
  type PostingDistinctionCandidateIdentity,
  type PostingDistinctionRecord,
} from './postingIdentityDistinction';
import {
  blockingSubmissionAttemptsForUser,
  comparePostings,
  freezePostingIdentity,
  frozenPostingIdentityHasExactScope,
  type BlockingSubmissionAttempt,
  type FrozenPostingIdentity,
  type PostingIdentity,
  type PostingIdentityBasis,
  type SubmissionAttemptLedgerExecutor,
} from './submissionAttemptLedger';
import {
  authoritativeSubmissionProjection,
  type AuthoritativeSubmissionProjection,
} from './authoritativeSubmissionProjection';

export {
  atsPostingKey,
  comparePostings,
  freezePostingIdentity,
  postingIdentity,
  type FrozenPostingIdentity,
  type PostingIdentity,
  type PostingIdentityBasis,
} from './submissionAttemptLedger';

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
 * TIERS, most authoritative first. Equality on an employer posting key, internal job id, exact
 * public URL, or packet proves sameness. Difference is stricter: only distinct requisitions inside
 * one trusted provider and tenant namespace prove it automatically. Everything else fails closed
 * until the applicant records an exact pairwise distinction. A union of all tiers would let the
 * weakest key veto the strongest, which is how two distinct requisitions with one shared title
 * become one.
 */
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
  certainty: 'submitted' | 'unverified' | 'repair_required';
  /* WITHIN 'unverified', WHETHER A SEND IS ACTUALLY IN EVIDENCE.
   *
   * 'pressed' is the real unverified press - a boundary was authorized or a press was observed and
   * the outcome was lost (the Skydio case), or a legacy runner recorded the same in prose. 'opened'
   * is an attempt that never got past attempt_opened: no boundary, no press, nothing that shows a
   * send happened (submissionAttemptRetrySafety reason 'opened'), which the legacy_backfill rows are.
   * The refusal is identical - a second application still cannot be withdrawn - but the two owe the
   * applicant different sentences, and telling her Litos "already pressed Send" over an attempt that
   * only opened is the false certainty this file exists to avoid. Absent means 'pressed'. */
  send_evidence?: 'pressed' | 'opened';
  tracker_available?: boolean;
  /* WHICH ROW, EXACTLY. `application_id` above is the Tracker row the sentence sends her to, which
   * for a ledger twin is the attempt's canonical application when it has one and its packet when it
   * does not - so the reader cannot always tell from it which packet, or which attempt, the guard
   * actually matched. These name them, for the read that lets her (or the next session) see the
   * ledger the refusal is naming. Absent on a legacy Sent/Applied row with no attempt. */
  attempt_id?: string;
  packet_id?: string;
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
    /* THE OPENED-ONLY TWIN. An attempt exists but nothing in the ledger shows a send: no boundary was
     * authorized and no press was observed (submissionAttemptRetrySafety reason 'opened'), which is
     * every legacy_backfill attempt reconstructed as an open with no completion. Saying "Litos already
     * pressed Send" here is the false certainty this file otherwise deletes, so the sentence claims
     * only what is true - an earlier attempt whose outcome is unknown - while keeping the identical
     * fail-closed refusal and the same resolution path. It still carries the phrase "does not know
     * whether this application went through" so attentionCategoriesForReasons files it as
     * unverified_submission, exactly as the pressed sentence's "could not confirm what came back" does. */
    if (match.send_evidence === 'opened') {
      return `Not sent: Litos has an earlier attempt on ${role}${at} and does not know whether this `
        + 'application went through, so the employer may already have it. Sending this one could make '
        + 'it two, and an application cannot be taken back once it is in. Open that earlier attempt in '
        + 'your Tracker, check the employer\u2019s page, and tell Litos whether it is there. If it is '
        + 'not, Litos will send it for you.';
    }
    return `Not sent: Litos already pressed Send on ${role}${at} and could not confirm what came back, `
      + 'so the employer may already have that application. Sending this one could make it two, and an '
      + 'application cannot be taken back once it is in. Open that earlier application in your Tracker, '
      + 'check the employer\u2019s page, and tell Litos whether it is there. If it is not, Litos will '
      + 'send it for you.';
  }
  if (match.certainty === 'repair_required') {
    return `Not sent: Litos has an earlier record for ${role}${at} that may represent a completed application, `
      + 'but its durable receipt projection is incomplete. Sending this one could create a duplicate. '
      + 'Open the earlier application in your Tracker and repair or confirm its receipt before trying again.';
  }
  return `Not sent: you have already applied to ${role}${at}, ${submittedOn(match.submitted_at)}. `
    + 'Employers cap re-applications to the same posting and count a second one against you, and an '
    + 'application cannot be taken back once it is in. Nothing has been sent this time. '
    + (match.tracker_available === false
      ? 'Review the confirmed duplicate-risk record in Litos to see where it stands.'
      : 'Open the earlier application in your Tracker to see where it stands.');
}

export type SubmittedTwinRow = {
  id: string;
  /** Immutable packet key when `id` is the newer canonical application key. */
  packet_id?: string;
  job_context: unknown;
  portal_url: string | null;
  submitted_at: string | null;
  /* When a submit on this row was pressed and lost, and nobody has looked yet. Null on every row
   * that is either cleanly submitted or cleanly not. */
  unverified_at?: string | null;
  /* Whether the unverified evidence is an actual send ('pressed': a boundary was authorized or a
   * press observed, or a legacy prose press) or only an opened attempt with nothing showing a send
   * ('opened'). Drives the sentence, not the refusal. Absent is treated as 'pressed'. */
  unverified_send_evidence?: 'pressed' | 'opened';
  /* Older runners recorded the uncertain press only as attention_reason prose. Those rows have no
   * unverified_submission object and therefore no timestamp, but they carry the same duplicate-send
   * risk until the applicant resolves the earlier attempt. */
  legacy_unverified_attempt?: boolean;
  /** Frozen on an immutable attempt fact. Legacy rows derive the same value from job_context. */
  posting_identity?: FrozenPostingIdentity;
  application_id?: string | null;
  attempt_id?: string;
  exact_url_scope?: boolean;
  user_wide_scope?: boolean;
  tracker_available?: boolean;
  /** Public certainty from the authoritative receipt projection. Missing is kept for pure legacy
   * comparison fixtures; every database-backed verdict fills it before rendering a response. */
  receipt_authority?: 'confirmed' | 'repair_required';
  /** A mutable Sent or Applied marker selected only to keep duplicate safety closed. It never
   * supplies public confirmation authority by itself. */
  mutable_sent_marker?: boolean;
};

/* THE LEGACY UNVERIFIED MARKER.
 *
 * Before unverified_submission existed, the runner persisted this exact leading sentence in
 * attention_reason after a final press it could not confirm. Deepgram 4bfd5827 is the production
 * witness: status needs_attention, pipeline_stage null, no structured attempt, and this prose still
 * present. The modern duplicate query otherwise cannot see it and permits a second send.
 *
 * Prefix matching preserves the fixed first sentence while allowing the older writer's follow-up
 * guidance to vary. It is deliberately narrower than words such as "attempted" or "could not
 * verify", which also occur in safe pre-submit failures. */
const LEGACY_UNVERIFIED_ATTEMPT_PREFIX =
  'the final submission was attempted, but litos could not verify the employer confirmation.';

export function isLegacyUnverifiedAttemptReason(value: unknown): boolean {
  return typeof value === 'string'
    && value.trim().toLowerCase().startsWith(LEGACY_UNVERIFIED_ATTEMPT_PREFIX);
}

function legacyUnverifiedAttempt() {
  return sql`(
    coalesce(jsonb_typeof(${generated_resumes.spec}->'_review'->'unverified_submission'), 'null') = 'null'
    and lower(btrim(coalesce(${generated_resumes.spec}->'_review'->>'attention_reason', '')))
      like ${`${LEGACY_UNVERIFIED_ATTEMPT_PREFIX}%`}
  )`;
}

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
export function alreadyAtEmployer() {
  return sql`(${generated_resumes.spec}->'_review'->>'status' = 'submitted'
    or ${generated_resumes.pipeline_stage} in ('applied', 'interview', 'offer', 'closed')
    or (${generated_resumes.spec}->'_review'->'unverified_submission' is not null
      and ${generated_resumes.spec}->'_review'->'unverified_submission'->>'resolution' is null)
    or ${legacyUnverifiedAttempt()})`;
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
async function submittedApplications(
  userId: string,
  executor: Pick<typeof db, 'select'> = db,
): Promise<SubmittedTwinRow[]> {
  const rows = await executor
    .select({
      id: generated_resumes.id,
      job_context: generated_resumes.job_context,
      portal_url: sql<string | null>`${generated_resumes.spec}->'_review'->>'portal_url'`,
      submitted_at: sql<string | null>`${generated_resumes.spec}->'_review'->>'submitted_at'`,
      mutable_sent_marker: sql<boolean>`(
        ${generated_resumes.spec}->'_review'->>'status' = 'submitted'
        or ${generated_resumes.pipeline_stage} in ('applied', 'interview', 'offer', 'closed')
        or ${generated_resumes.spec}->'_review'->>'submitted_at' is not null
      )`,
      /* THE ROWS THE GUARD USED TO BE BLIND TO. A submit that was pressed and lost has no
         submitted_at and no 'applied' stage, so it matched neither arm below and a second
         application to the same posting was let straight through. Unresolved only: once the
         applicant has said 'not_sent' the employer provably does not have it and it stops being a
         reason to refuse anything. */
      unverified_at: sql<string | null>`case when ${generated_resumes.spec}->'_review'->'unverified_submission'->>'resolution' is null
        then ${generated_resumes.spec}->'_review'->'unverified_submission'->>'at' end`,
      legacy_unverified_attempt: sql<boolean>`${legacyUnverifiedAttempt()}`,
    })
    .from(generated_resumes)
    .where(and(
      eq(generated_resumes.user_id, userId),
      alreadyAtEmployer(),
    ));
  return rows.map((row) => {
    const identity = freezePostingIdentity(row.job_context, row.portal_url);
    return {
      ...row,
      exact_url_scope: Boolean(
        !identity.postingKey
        && !identity.jobId
        && frozenPostingIdentityHasExactScope(identity),
      ),
    };
  });
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
export async function submittedApplicationCompanies(
  userId: string,
  executor: Pick<typeof db, 'select'> = db,
): Promise<string[]> {
  const [rows, ledgerAttempts] = await Promise.all([
    executor.select({ company: sql<string | null>`${generated_resumes.job_context}->>'company'` })
      .from(generated_resumes)
      .where(and(eq(generated_resumes.user_id, userId), alreadyAtEmployer())),
    blockingSubmissionAttemptsForUser(userId, { executor }),
  ]);
  const companies = [
    ...rows.map((row) => row.company?.trim() ?? ''),
    ...ledgerAttempts.map((attempt) => attempt.postingIdentity.company.trim()),
  ]
    .filter((company) => company.length > 0);
  /* SORTED, because this array's ORDER is hashed and its order used to be the query planner's.
   *
   * The select above has no ORDER BY, so Postgres owes it nothing: on the live Neon database the
   * row order flipped between two plans, the Set dedupe baked whichever order arrived into the
   * array, and the array rides applicantSnapshot.application_profile into applicantSnapshotSha256
   * (canonicalValue sorts object KEYS and rightly preserves array order). Measured on Quandela
   * f9022b36, 2026-08-20: packet_version alternated between two values across consecutive audits,
   * so every acknowledge-then-send compare refused with "This application changed after you
   * approved the exact packet" - forever, on a packet nothing had changed. This is a membership
   * set; its order carries no meaning, so the canonical order is the sorted one. */
  return [...new Set(companies)].sort();
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
  /** Existing employer risk cannot be compared safely. This is a refusal, not an abstention. */
  | {
    kind: 'unidentifiable';
    application_id: string;
    reason: string;
    prior_attempt_id: string | null;
    prior_application_id: string | null;
    prior_packet_id: string;
    prior_company: string;
    prior_role: string;
    prior_portal_url: string | null;
    prior_identity_exact: boolean;
    candidate_application_id: string | null;
    candidate_packet_id: string | null;
    candidate_company: string;
    candidate_role: string;
    candidate_portal_url: string | null;
    candidate_identity_version: PostingDistinctionCandidateIdentity['version'] | null;
    candidate_identity_digest: string | null;
  }
  | { kind: 'duplicate'; match: DuplicateApplicationMatch; reason: string };

const UNIDENTIFIABLE_DUPLICATE_REASON = 'Not sent: Litos has an earlier application attempt whose '
  + 'posting identity cannot be safely compared with this one. Sending now could create a duplicate. '
  + 'Open the earlier application in your Tracker and resolve whether the employer received it first.';

export function ledgerTwin(
  attempt: BlockingSubmissionAttempt,
  projection?: AuthoritativeSubmissionProjection,
): SubmittedTwinRow {
  const exactConfirmed = projection?.state === 'confirmed'
    && projection.attemptId === attempt.attemptId
    && projection.packetId === (attempt.applicationId === attempt.packetId ? null : attempt.packetId);
  const submittedAt = exactConfirmed ? projection.submittedAt : null;
  const unverifiedAt = attempt.retrySafety.kind === 'blocked_unverified'
    ? attempt.retrySafety.at
    : attempt.retrySafety.kind === 'blocked_confirmed' && !exactConfirmed
      ? attempt.retrySafety.confirmedAt
      : null;
  // 'opened' is the retry-safety reason for an attempt that never authorized a boundary or observed a
  // press: real for every legacy_backfill attempt reconstructed as a bare open. Any other unverified
  // reason (boundary_authorized, pressed, invalid_sequence) is a real or ambiguous send and stays
  // 'pressed'. Only the sentence differs; the block does not.
  const unverifiedSendEvidence: 'pressed' | 'opened' | undefined = attempt.retrySafety.kind === 'blocked_unverified'
    ? (attempt.retrySafety.reason === 'opened' ? 'opened' : 'pressed')
    : undefined;
  const hasExactScope = frozenPostingIdentityHasExactScope(attempt.postingIdentity);
  const isRootAutofillOrphan = attempt.applicationId === null
    && !attempt.parentAttemptId
    && attempt.operation === 'initial_submission'
    && (attempt.source === 'chrome_extension' || attempt.source === 'legacy_backfill');
  return {
    id: attempt.applicationId ?? attempt.packetId,
    packet_id: attempt.packetId,
    application_id: attempt.applicationId,
    attempt_id: attempt.attemptId,
    job_context: {
      company: attempt.postingIdentity.company,
      role: attempt.postingIdentity.role,
      ...(attempt.postingIdentity.jobId ? { job_id: attempt.postingIdentity.jobId } : {}),
    },
    portal_url: attempt.postingIdentity.portalUrl,
    posting_identity: attempt.postingIdentity,
    exact_url_scope: Boolean(
      !attempt.postingIdentity.postingKey
      && !attempt.postingIdentity.jobId
      && hasExactScope,
    ),
    /* A root autofill orphan with no exact URL scope is treated as user-wide: it could be any
       posting, so the duplicate gate refuses every new send until it is resolved. But an orphan
       that carries a normalized company|role is NOT identity-less - it names a company and role,
       and comparePostings can decide it against the candidate like any other weak-identity row (a
       different company|role is a different posting; an equal one is still caught as a duplicate).
       Only a truly label-less orphan stays user-wide, so one confirmed application to a named
       company can no longer fail-closed every unrelated new application. */
    user_wide_scope: isRootAutofillOrphan
      && !hasExactScope
      && !attempt.postingIdentity.companyRole,
    tracker_available: Boolean(attempt.applicationId),
    submitted_at: submittedAt,
    unverified_at: unverifiedAt,
    ...(unverifiedSendEvidence ? { unverified_send_evidence: unverifiedSendEvidence } : {}),
    ...(exactConfirmed
      ? { receipt_authority: 'confirmed' as const }
      : attempt.retrySafety.kind === 'blocked_confirmed'
        ? { receipt_authority: 'repair_required' as const }
        : {}),
  };
}

function compareExactAttributedUrls(left: string, right: string): 'same' | 'unknown' {
  if (left === right) return 'same';
  const leftUrl = new URL(left);
  const rightUrl = new URL(right);
  if (leftUrl.origin !== rightUrl.origin) return 'unknown';
  const leftSegments = leftUrl.pathname.split('/').filter(Boolean);
  const rightSegments = rightUrl.pathname.split('/').filter(Boolean);
  if (leftSegments.length !== rightSegments.length || leftSegments.length === 0) return 'unknown';
  if (leftSegments.slice(0, -1).join('/') !== rightSegments.slice(0, -1).join('/')) return 'unknown';
  const leftKey = leftSegments.at(-1)!;
  const rightKey = rightSegments.at(-1)!;
  if (/^\d+$/.test(leftKey) && /^\d+$/.test(rightKey)) {
    const normalizedLeft = leftKey.replace(/^0+(?=\d)/, '');
    const normalizedRight = rightKey.replace(/^0+(?=\d)/, '');
    /* Leading zeroes may be presentation padding or part of an opaque employer key. Either way,
       treating two spellings of the same number as proven different would permit a duplicate. */
    if (normalizedLeft === normalizedRight) return 'unknown';
    return 'unknown';
  }
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (uuidPattern.test(leftKey) && uuidPattern.test(rightKey)) {
    return leftKey.toLowerCase() === rightKey.toLowerCase() ? 'same' : 'unknown';
  }
  return 'unknown';
}

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
  /** Only for resuming the same already-open employer-boundary attempt. */
  excludeAttemptId?: string;
}, executor: SubmissionAttemptLedgerExecutor = db): Promise<DuplicateApplicationVerdict> {
  // This guard runs inside several submission transactions. Keep each query sequential on a
  // transaction executor so node-postgres never has concurrent client.query calls while the user
  // submission lock is held.
  const attempts = await blockingSubmissionAttemptsForUser(input.userId, { executor });
  const legacyProjectionRows = await submittedApplications(input.userId, executor);
  const distinctions = await postingDistinctionsForCurrentCandidate(
    input.userId,
    input.applicationId,
    input.jobContext,
    input.portalUrl,
    executor,
  );
  const projections = await authoritativeSubmissionProjection({
    userId: input.userId,
    packetIds: [...new Set([
      ...attempts.map((attempt) => attempt.packetId),
      ...legacyProjectionRows.map((row) => row.id),
    ])],
    applicationIds: [...new Set(attempts
      .map((attempt) => attempt.applicationId)
      .filter((applicationId): applicationId is string => Boolean(applicationId)))],
    executor,
  });
  const projectionForAttempt = (attempt: BlockingSubmissionAttempt) => {
    const packetProjection = projections.byPacketId.get(attempt.packetId);
    if (packetProjection?.state === 'confirmed'
      && packetProjection.attemptId === attempt.attemptId) return packetProjection;
    const applicationProjection = attempt.applicationId
      ? projections.byApplicationId.get(attempt.applicationId)
      : undefined;
    if (applicationProjection?.state === 'confirmed'
      && applicationProjection.attemptId === attempt.attemptId) return applicationProjection;
    return packetProjection ?? applicationProjection;
  };
  const allLedgerRows = attempts.map((attempt) => ledgerTwin(
    attempt,
    projectionForAttempt(attempt),
  ));
  const ledgerRows = allLedgerRows.filter((row) => row.attempt_id !== input.excludeAttemptId);
  const authoritativeLegacyRows = legacyProjectionRows.map((row) => {
    const projection = projections.byPacketId.get(row.id);
    if (projection?.state === 'confirmed') return {
      ...row,
      submitted_at: projection.submittedAt,
      receipt_authority: 'confirmed' as const,
    };
    return {
      ...row,
      submitted_at: null,
      ...(row.mutable_sent_marker ? { receipt_authority: 'repair_required' as const } : {}),
    };
  });
  const legacyRows = legacyProjectionRowsNotCoveredByLedger(authoritativeLegacyRows, allLedgerRows);
  const verdict = duplicateAmong(
    input.jobContext,
    input.portalUrl,
    [...ledgerRows, ...legacyRows],
    input.applicationId,
    distinctions,
  );
  if (verdict.kind !== 'unidentifiable') return verdict;
  try {
    const candidate = await loadPostingDistinctionCandidateByKey(
      input.userId,
      input.applicationId,
      executor,
    );
    const candidateNames = companyRoleOf(candidate.jobContext);
    return {
      ...verdict,
      candidate_application_id: candidate.applicationId,
      candidate_packet_id: candidate.packetId,
      candidate_company: candidateNames.company,
      candidate_role: candidateNames.role,
      candidate_portal_url: candidate.portalUrl,
      candidate_identity_version: candidate.identity.version,
      candidate_identity_digest: candidate.identity.digest,
    };
  } catch (error) {
    if (error instanceof PostingDistinctionError) return verdict;
    throw error;
  }
}

/** Mutable packet projections must not reintroduce a second, weaker copy of ledger evidence. */
export function legacyProjectionRowsNotCoveredByLedger(
  legacyRows: readonly SubmittedTwinRow[],
  ledgerRows: readonly SubmittedTwinRow[],
): SubmittedTwinRow[] {
  const coveredPacketIds = new Set(
    ledgerRows.map((row) => row.packet_id).filter((packetId): packetId is string => Boolean(packetId)),
  );
  return legacyRows.filter((row) => !coveredPacketIds.has(row.id));
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
  applicationId?: string,
  postingDistinctions: readonly PostingDistinctionRecord[] = [],
): DuplicateApplicationVerdict {
  const input = { jobContext, portalUrl };
  const mine = freezePostingIdentity(input.jobContext, input.portalUrl);
  const candidateIdentity = postingDistinctionCandidateIdentity(input.jobContext, input.portalUrl);
  let unidentifiable: SubmittedTwinRow | null = null;
  let repairMatch: { match: DuplicateApplicationMatch; reason: string } | null = null;
  let unverifiedMatch: { match: DuplicateApplicationMatch; reason: string } | null = null;
  for (const row of rows) {
    const samePacket = Boolean(applicationId && (row.id === applicationId || row.packet_id === applicationId));
    const priorIdentity = row.posting_identity ?? freezePostingIdentity(row.job_context, row.portal_url);
    const exactUrlScope = Boolean(
      row.exact_url_scope
      || (!priorIdentity.postingKey
        && !priorIdentity.jobId
        && frozenPostingIdentityHasExactScope(priorIdentity)),
    );
    const verdict = (() => {
      if (samePacket) return { same: true as const, basis: 'same_packet' as const };
      if (row.user_wide_scope) return { same: false as const, basis: null };
      const currentUrl = canonicalExactPostingUrl(input.portalUrl);
      const priorUrl = canonicalExactPostingUrl(row.portal_url);
      const urlComparison = currentUrl && priorUrl
        ? compareExactAttributedUrls(currentUrl, priorUrl)
        : 'unknown' as const;
      if (mine.postingKey && priorIdentity.postingKey
        && mine.postingKey === priorIdentity.postingKey) {
        return { same: true as const, basis: 'ats_posting' as const };
      }
      if (mine.jobId && priorIdentity.jobId && mine.jobId === priorIdentity.jobId) {
        return { same: true as const, basis: 'job_id' as const };
      }
      if (urlComparison === 'same') return { same: true as const, basis: 'portal_url' as const };
      if (mine.postingKey || priorIdentity.postingKey) {
        if (mine.postingKey && priorIdentity.postingKey) {
          const strongComparison = comparePostings(mine, priorIdentity);
          if (strongComparison.same || strongComparison.basis === 'ats_posting') return strongComparison;
          return { same: false as const, basis: null };
        }
        return { same: false as const, basis: null };
      }
      if (mine.jobId || priorIdentity.jobId) {
        if (mine.jobId && priorIdentity.jobId) {
          return mine.jobId === priorIdentity.jobId
            ? { same: true as const, basis: 'job_id' as const }
            : { same: false as const, basis: null };
        }
        return { same: false as const, basis: null };
      }
      if (exactUrlScope) {
        if (!currentUrl || !priorUrl) return { same: false as const, basis: null };
        return { same: false as const, basis: null };
      }
      return comparePostings(mine, priorIdentity);
    })();
    if (verdict.basis === null) {
      const repaired = Boolean(candidateIdentity && row.attempt_id && applicationId
        && postingDistinctions.some((relation) => (
          (relation.candidate_application_id === applicationId
            || relation.candidate_packet_id === applicationId)
          && postingDistinctionApplies({
            relation,
            priorAttemptId: row.attempt_id,
            candidateApplicationId: relation.candidate_application_id,
            candidatePacketId: relation.candidate_packet_id,
            candidateIdentity,
            priorIdentity,
          })
        )));
      if (repaired) continue;
      /* Last comparable signal before a user-facing unidentifiable refusal: the normalized
         company|role. The verdict reached basis null because the strong tiers could not be
         compared - mismatched or one-sided ATS posting keys (a different Greenhouse tenant like
         cresta vs verkada resolves to null here, not to a proven-different ats_posting), mismatched
         job ids, or no shared tier at all. But if BOTH postings still name a company|role and those
         DIFFER, they are different postings and cannot be duplicates: a confirmed application to one
         company or role is not a prior submission of another, and re-sending this one cannot
         duplicate an application the employer never received for it. Only a genuinely absent or
         equal company|role leaves the unidentifiable hold standing (an equal one reaches this branch
         only when the strong tiers were ambiguous, where staying careful is correct). */
      if (mine.companyRole
        && priorIdentity.companyRole
        && mine.companyRole !== priorIdentity.companyRole) continue;
      unidentifiable ??= row;
      continue;
    }
    if (!verdict.same) continue;
    const { company, role } = companyRoleOf(row.job_context);
    const mineNames = companyRoleOf(input.jobContext);
    /* A row can be both: submitted earlier AND carrying an unresolved record from a later attempt.
       Submitted wins, because a receipt is certainty and the sentence for certainty is the stronger
       and simpler of the two. */
    const hasUnverifiedEvidence = Boolean(row.unverified_at || row.legacy_unverified_attempt);
    const certainty = row.receipt_authority === 'confirmed'
      ? 'submitted' as const
      : row.receipt_authority === 'repair_required'
        ? 'repair_required' as const
        : row.submitted_at || !hasUnverifiedEvidence
          ? 'submitted' as const
          : 'unverified' as const;
    const match: DuplicateApplicationMatch = {
      application_id: row.id,
      company: company || mineNames.company,
      role: role || mineNames.role,
      submitted_at: row.submitted_at ?? undefined,
      basis: verdict.basis,
      certainty,
      // Only the 'unverified' sentence reads it; an opened-only attempt gets the honest wording that
      // does not claim a press, while a real or legacy press stays 'pressed'.
      ...(certainty === 'unverified' ? { send_evidence: row.unverified_send_evidence ?? 'pressed' } : {}),
      ...(row.tracker_available === false ? { tracker_available: false } : {}),
      ...(row.attempt_id ? { attempt_id: row.attempt_id } : {}),
      packet_id: row.packet_id ?? row.id,
    };
    const reason = duplicateApplicationReason(match);
    if (certainty === 'submitted') return { kind: 'duplicate', match, reason };
    if (certainty === 'repair_required') repairMatch ??= { match, reason };
    else unverifiedMatch ??= { match, reason };
  }
  if (repairMatch) return { kind: 'duplicate', ...repairMatch };
  if (unverifiedMatch) return { kind: 'duplicate', ...unverifiedMatch };
  if (unidentifiable) {
    const priorNames = companyRoleOf(unidentifiable.job_context);
    const priorExactUrl = canonicalExactPostingUrl(unidentifiable.portal_url);
    return {
      kind: 'unidentifiable',
      application_id: unidentifiable.id,
      reason: UNIDENTIFIABLE_DUPLICATE_REASON,
      prior_attempt_id: unidentifiable.attempt_id ?? null,
      prior_application_id: unidentifiable.application_id ?? null,
      prior_packet_id: unidentifiable.packet_id ?? unidentifiable.id,
      prior_company: priorNames.company,
      prior_role: priorNames.role,
      prior_portal_url: priorExactUrl,
      prior_identity_exact: Boolean(priorExactUrl),
      candidate_application_id: applicationId ?? null,
      candidate_packet_id: applicationId ?? null,
      candidate_company: companyRoleOf(input.jobContext).company,
      candidate_role: companyRoleOf(input.jobContext).role,
      candidate_portal_url: candidateIdentity?.portalUrl ?? null,
      candidate_identity_version: candidateIdentity?.version ?? null,
      candidate_identity_digest: candidateIdentity?.digest ?? null,
    };
  }
  return { kind: 'clear' };
}

/** The HTTP body every route refusal sends, so the four of them cannot drift apart. */
export function duplicateApplicationResponse(verdict: { match: DuplicateApplicationMatch; reason: string }) {
  return {
    error: verdict.reason,
    code: 'DUPLICATE_APPLICATION' as const,
    duplicate_of: verdict.match.application_id,
    matched_on: verdict.match.basis,
    duplicate_certainty: verdict.match.certainty,
  };
}

export function unidentifiableDuplicateApplicationResponse(
  verdict: Extract<DuplicateApplicationVerdict, { kind: 'unidentifiable' }>,
) {
  return {
    error: verdict.reason,
    code: 'DUPLICATE_RISK_UNIDENTIFIABLE' as const,
    duplicate_of: verdict.application_id,
    matched_on: null,
    resolution: {
      prior_attempt_id: verdict.prior_attempt_id,
      prior_application_id: verdict.prior_application_id,
      prior_packet_id: verdict.prior_packet_id,
      prior_company: verdict.prior_company,
      prior_role: verdict.prior_role,
      prior_portal_url: verdict.prior_portal_url,
      prior_identity_exact: verdict.prior_identity_exact,
      candidate_application_id: verdict.candidate_application_id,
      candidate_packet_id: verdict.candidate_packet_id,
      candidate_company: verdict.candidate_company,
      candidate_role: verdict.candidate_role,
      candidate_portal_url: verdict.candidate_portal_url,
      candidate_identity_version: verdict.candidate_identity_version,
      candidate_identity_digest: verdict.candidate_identity_digest,
    },
  };
}
