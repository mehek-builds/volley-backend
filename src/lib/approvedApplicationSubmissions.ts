import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index';
import { generated_resumes } from '../db/schema';
import { alreadyAtEmployer } from './duplicateApplication';

/**
 * THE PREDICATE for "a submission this student personally approved, that actually reached the
 * employer" -- read only by onboarding.ts's informational reviewed-submit count (GET
 * /onboarding/state, standingConsentEligibility). NOT read by cardGate.ts any more -- see THE
 * FINDING #1 FIX (round 3, 2026-08-29) on hasApprovedSubmittedApplication below for why TIER B2's
 * closure signal moved to a different, broader predicate.
 *
 * Two conditions:
 *
 *   status = 'submitted'                    Written by the several places that actually complete a
 *                                            send, never at review, click, claim, or 'submitting'
 *                                            time: submissionRunner.ts (the automated browser/API
 *                                            pipeline), extensionSubmission.ts's extensionOutcomePatch
 *                                            (the Chrome extension's own confirmed send),
 *                                            applicationEmail.ts's reviewFromSubmissionConfirmation
 *                                            (an employer's email receipt for the unsupported-portal
 *                                            fallback), and routes/applications.ts itself in the
 *                                            unsupported-portal-email branch of POST
 *                                            /applications/:id/submit-request, the verified-receipt
 *                                            branch of POST /submission/extension-start, the
 *                                            "finish it from here" manual-finish route, and the
 *                                            found=true branch of POST /submission/unverified. (grep
 *                                            every one of these files for `status: 'submitted'` to
 *                                            re-verify this list rather than trust it blind.)
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
 * Has this account EVER had a row that clears lib/duplicateApplication.ts's alreadyAtEmployer()?
 * Used by cardGate.ts to decide whether TIER B2 (the onboarding build routes) is still open for a
 * locked account.
 *
 * THE FINDING #1 FIX (round 3 code review, 2026-08-29): this used to run its own predicate here,
 * approvedSubmissionPredicate above -- status='submitted' AND
 * submission_authorization.source='per_application_approval' ONLY. That missed a real, common
 * outcome: an account whose one free send attempt lands in needs_attention with an unresolved
 * unverified_submission (submissionRunner.ts's own comments cite production incidents -- "4 of 25
 * packets stuck exactly here on 2026-08-08") never wrote status='submitted', so TIER B2 never closed
 * for it. That is unbounded free job-board/build access on the exact outcome the duplicate-application
 * guard (lib/duplicateApplication.ts) already treats as "reached an employer," because a Send that was
 * pressed and lost is a real risk the employer already has it, not evidence that nothing happened.
 *
 * Rather than write a THIRD version of "has this account already reached an employer" here, this now
 * delegates to alreadyAtEmployer() directly -- the same predicate the duplicate-application guard
 * uses to refuse a second send and the prior-application resolver uses to decide whether it may
 * answer "No" on the applicant's behalf. Broader than approvedSubmissionPredicate on purpose: it also
 * closes on pipeline_stage='applied' (written in the same breath as status='submitted' by every send
 * path) and on an unresolved unverified_submission or its legacy attention-text twin. It does NOT
 * check submission_authorization.source, and does not need to -- a locked account cannot reach
 * standing_consent or the extension's own send route at all (see approvedSubmissionPredicate's
 * comment above), so every row alreadyAtEmployer() can find for a locked account was necessarily
 * reached through the one free per_application_approval send onboarding grants.
 *
 * The companion fix: POST /applications/:id/submission/unverified, the route that lets the applicant
 * resolve an unverified send ("did the employer get it or not"), is now on TIER B1
 * (cardGate.ts's CARD_GATE_PROFILE_PATHS) precisely so a locked account in this state is not walled
 * off with no way to get out of it.
 *
 * An EXISTS-shaped LIMIT 1 rather than reviewedSubmitCount()'s count(*): cardGateRouteReachable calls
 * this on every TIER B2 request, and the caller only ever needs to know whether the count is zero or
 * not.
 */
export async function hasApprovedSubmittedApplication(userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: generated_resumes.id })
    .from(generated_resumes)
    .where(and(eq(generated_resumes.user_id, userId), alreadyAtEmployer()))
    .limit(1);
  return rows.length > 0;
}
