import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { users } from '../db/schema';

/**
 * The free tailored builds a new account gets before it is asked for a card.
 *
 * WHY THIS EXISTS. The onboarding flow shows a real posting at step 3 and builds a real application
 * for it, and the card is taken at step 10. That order is the whole argument of the redesign: the
 * student sees Litos do the thing before being asked to pay for it. But tailoring is a Litos+
 * feature, and a new account is `free_new` with no trial - the trial is a Stripe subscription with
 * a card attached now, granted by the webhook rather than by the act of signing up. Measured on
 * production 2026-08-19 with a fresh account: step 3 answered 402 "This action is part of Litos+"
 * and the flow could not be finished by anybody.
 *
 * THE LIMIT IS TWO (Mehek, 2026-09-01). It was one, and one free build made going back a paid
 * action: a student who returned to the resume step and uploaded a better file hit the paywall on
 * the rebuild, three screens into a flow whose argument is "see it work before paying". The second
 * build exists for exactly that student. Not three, because the grant funds seeing the product
 * work, not using it: from the third build on it is an ordinary paid request.
 *
 * WHAT KEEPS IT FROM BEING A FREE TIER. Two conditions, both server-side facts rather than client
 * claims, and both in the same statement as the write:
 *
 *   1. `onboarding_builds_used < ONBOARDING_BUILD_LIMIT` - the account has claims left.
 *   2. `onboarding_completed_at IS NULL` - the account is still IN setup. A finished account
 *      asking for a tailored resume is an ordinary paid request and is refused like any other.
 *
 * Both live in the WHERE clause of a conditional UPDATE rather than in a read followed by a write,
 * so concurrent builds serialize on the row: each increment re-evaluates the WHERE under the row
 * lock, and the claim past the limit returns no row. There is no window between the check and the
 * take. `onboarding_build_granted_at` is still stamped on every claim (most recent claim time) so
 * the old column keeps meaning something, but the counter is what enforces the limit.
 */
export const ONBOARDING_BUILD_LIMIT = 2;

export async function claimOnboardingBuildGrant(userId: string): Promise<boolean> {
  const claimed = await db
    .update(users)
    .set({
      onboarding_builds_used: sql`${users.onboarding_builds_used} + 1`,
      onboarding_build_granted_at: sql`now()`,
    })
    .where(
      and(
        eq(users.id, userId),
        lt(users.onboarding_builds_used, ONBOARDING_BUILD_LIMIT),
        isNull(users.onboarding_completed_at),
      ),
    )
    .returning({ id: users.id });
  return claimed.length === 1;
}

/**
 * Hands a claim back when the generation it was taken for did not produce anything.
 *
 * A student must not lose a free build to a model timeout or a render failure. This is
 * deliberately NOT a general "unspend" - it decrements only for an account still in setup, so it
 * cannot be used to refund a build that was actually delivered and then completed, and it never
 * goes below zero. The stamp clears only when the count returns to zero, so it keeps reading as
 * "when was a free build last outstanding".
 *
 * Best-effort on purpose: it runs on a failure path, and a failure to release must not replace the
 * error the caller is already reporting with a different one.
 */
export async function releaseOnboardingBuildGrant(userId: string): Promise<void> {
  await db
    .update(users)
    .set({
      onboarding_builds_used: sql`greatest(${users.onboarding_builds_used} - 1, 0)`,
      // The old value, read before this statement's own write, which is exactly SQL's semantics
      // for a column referenced on the right-hand side of its own UPDATE.
      onboarding_build_granted_at: sql`case when ${users.onboarding_builds_used} <= 1 then null else ${users.onboarding_build_granted_at} end`,
    })
    .where(and(eq(users.id, userId), isNull(users.onboarding_completed_at)))
    .catch(() => undefined);
}
