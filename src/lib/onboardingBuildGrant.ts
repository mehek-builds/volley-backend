import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { users } from '../db/schema';

/**
 * The one tailored resume a new account gets before it is asked for a card.
 *
 * WHY THIS EXISTS. The onboarding flow shows a real posting at step 3 and builds a real application
 * for it, and the card is taken at step 10. That order is the whole argument of the redesign: the
 * student sees Litos do the thing before being asked to pay for it. But tailoring is a Litos+
 * feature, and a new account is `free_new` with no trial - the trial is a Stripe subscription with
 * a card attached now, granted by the webhook rather than by the act of signing up. Measured on
 * production 2026-08-19 with a fresh account: step 3 answered 402 "This action is part of Litos+"
 * and the flow could not be finished by anybody.
 *
 * WHAT KEEPS IT FROM BEING A FREE TIER. Two conditions, both server-side facts rather than client
 * claims, and both in the same statement as the write:
 *
 *   1. `onboarding_build_granted_at IS NULL` - it has not already been spent. One per account.
 *   2. `onboarding_completed_at IS NULL` - the account is still IN setup. A finished account
 *      asking for a tailored resume is an ordinary paid request and is refused like any other.
 *
 * Both live in the WHERE clause of a conditional UPDATE rather than in a read followed by a write,
 * so two concurrent builds cannot both see an unspent grant and both take it. The statement either
 * returns a row, meaning this caller took it, or returns nothing, meaning somebody else did or it
 * was never available. There is no third answer and no window between the check and the take.
 */
export async function claimOnboardingBuildGrant(userId: string): Promise<boolean> {
  const claimed = await db
    .update(users)
    .set({ onboarding_build_granted_at: sql`now()` })
    .where(
      and(
        eq(users.id, userId),
        isNull(users.onboarding_build_granted_at),
        isNull(users.onboarding_completed_at),
      ),
    )
    .returning({ id: users.id });
  return claimed.length === 1;
}

/**
 * Hands the grant back when the generation it was taken for did not produce anything.
 *
 * A student must not lose their one free build to a model timeout or a render failure. This is
 * deliberately NOT a general "unspend" - it clears the stamp only for an account still in setup, so
 * it cannot be used to refund a build that was actually delivered and then completed.
 *
 * Best-effort on purpose: it runs on a failure path, and a failure to release must not replace the
 * error the caller is already reporting with a different one.
 */
export async function releaseOnboardingBuildGrant(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ onboarding_build_granted_at: null })
    .where(and(eq(users.id, userId), isNull(users.onboarding_completed_at)))
    .catch(() => undefined);
}
