import { sql } from 'drizzle-orm';
import { db } from '../db/index';
import { onboarding_flow_runs, onboarding_flow_step_acknowledgements } from '../db/schema';

/**
 * THE APPLICATION-SEQUENCE ACKNOWLEDGEMENT LEDGER, split out of routes/onboarding.ts so
 * middleware/auth.ts and lib/cardGate.ts can read it without importing a route file (and without
 * onboarding.ts importing back from auth.ts or cardGate.ts -- the same layering reason
 * cardGateInstant/requiresPaymentMethodFor live in lib/cardGate.ts rather than here).
 *
 * onboarding.ts re-exports CURRENT_ONBOARDING_FLOW_VERSION and onboardingFlowLedger from here so
 * every existing reference to them -- there were none outside onboarding.ts itself at the time of
 * this split, but the re-export keeps that free to change without a second move -- keeps working
 * unchanged.
 */

/* Bumped to 3 by the roles-first reorder. The bump is what keeps the change off accounts that are
   already through setup: onboardingFlowLedger only reads runs and acknowledgements AT THIS
   VERSION, so an account carrying a completed version-2 run starts version 3 with an empty ledger
   and `replayRequired` false (the column is only ever written false in code and defaults false).
   Nothing replays unless a migration deliberately sets replay_required, and onboardingStepFrom
   short-circuits on `completed` before it reads a single order-dependent branch. */
export const CURRENT_ONBOARDING_FLOW_VERSION = 3;

function isUndefinedTableError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01';
}

export async function onboardingFlowLedger(userId: string) {
  try {
    const [[run], acknowledgements] = await Promise.all([
      db.select().from(onboarding_flow_runs).where(sql`${onboarding_flow_runs.user_id} = ${userId}
        and ${onboarding_flow_runs.flow_version} = ${CURRENT_ONBOARDING_FLOW_VERSION}`).limit(1),
      db.select({ step: onboarding_flow_step_acknowledgements.step })
        .from(onboarding_flow_step_acknowledgements)
        .where(sql`${onboarding_flow_step_acknowledgements.user_id} = ${userId}
          and ${onboarding_flow_step_acknowledgements.flow_version} = ${CURRENT_ONBOARDING_FLOW_VERSION}`),
    ]);
    return {
      available: true as const,
      /* DELIBERATELY UNREAD, and not a substitute for replayRequired. A version bump leaves every
         pre-existing account with an empty ledger AT THE NEW VERSION, so this is false for exactly
         the accounts a bump means to leave alone. Gating on it once served those accounts `done`
         and then refused to record it, which locked all of them out of the dashboard. Enrolment is
         replay_required and nothing else. */
      exists: !!run,
      completed: run?.completed_at != null,
      replayRequired: run?.replay_required === true,
      acknowledged: acknowledgements.map((row) => row.step),
    };
  } catch (error) {
    if (!isUndefinedTableError(error)) throw error;
    return { available: false as const, exists: false, completed: false, replayRequired: false, acknowledged: [] as string[] };
  }
}
