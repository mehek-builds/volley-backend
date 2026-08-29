import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index';
import { generated_resumes } from '../db/schema';

/**
 * THE PREDICATE for "a submission this student personally approved, that actually reached the
 * employer" -- shared so onboarding.ts's informational reviewed-submit count (GET /onboarding/state,
 * standingConsentEligibility) and cardGate.ts's TIER B2 closure check (see cardGateRouteReachable's
 * onboarding-build check below) can never quietly diverge on what counts as evidence of a real send.
 *
 * Two conditions, both written only by the machinery that actually sends an application, never by
 * anything the student's own client can claim on request:
 *
 *   status = 'submitted'                    Written only by submissionRunner.ts, only after a real,
 *                                            verified send -- never at review, click, claim, or
 *                                            'submitting' time (routes/applications.ts POST
 *                                            /applications/:id/submit-request only claims a browser
 *                                            run; grep submissionRunner.ts for `status: 'submitted'`).
 *   submission_authorization.source
 *     = 'per_application_approval'          The one authorization value the student's own
 *                                            review-and-send screen writes (routes/applications.ts
 *                                            POST /applications/:id/submit-request). Excludes
 *                                            'standing_consent' (automatic submission) and
 *                                            'user_initiated_extension' (the Chrome extension's own
 *                                            send route, /applications/:id/submission/extension-start)
 *                                            on purpose: both require the automatic_submission
 *                                            entitlement (requireFeature in routes/applications.ts),
 *                                            which a locked, never-paid account cannot hold, and
 *                                            neither route is reachable by a locked account at all --
 *                                            it is on none of THE CARD GATE's three tiers. So for a
 *                                            locked account, this predicate can only ever become true
 *                                            through exactly the one free application onboarding is
 *                                            meant to grant it.
 */
function approvedSubmissionPredicate(userId: string): SQL {
  return sql`${generated_resumes.user_id} = ${userId}
    and ${generated_resumes.spec}->'_review'->>'status' = 'submitted'
    and ${generated_resumes.spec}->'_review'->'submission_authorization'->>'source' = 'per_application_approval'`;
}

/**
 * How many submissions has this student personally approved AND seen reach the employer?
 *
 * Informational now, not an unlock -- see engine/standingConsent.ts's own comment
 * (MIN_REVIEWED_SUBMITS = 0). Still returned in GET /onboarding/state for transparency.
 */
export async function reviewedSubmitCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(generated_resumes)
    .where(approvedSubmissionPredicate(userId));
  return row?.n ?? 0;
}

/**
 * Has this account EVER had a submission that clears approvedSubmissionPredicate? Used by
 * cardGate.ts to decide whether TIER B2 (the onboarding build routes) is still open for a locked
 * account -- see the comment on approvedSubmissionPredicate above for why that predicate is a safe,
 * server-owned, un-gameable terminal signal for "this account has spent its one free build."
 *
 * An EXISTS-shaped LIMIT 1 rather than reviewedSubmitCount()'s count(*): cardGateRouteReachable calls
 * this on every TIER B2 request, and the caller only ever needs to know whether the count is zero or
 * not.
 */
export async function hasApprovedSubmittedApplication(userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: generated_resumes.id })
    .from(generated_resumes)
    .where(approvedSubmissionPredicate(userId))
    .limit(1);
  return rows.length > 0;
}
