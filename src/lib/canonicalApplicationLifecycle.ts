/* The lifecycle vocabulary of the canonical applications table.
 *
 * This lives in lib because two writers act on the same fact from different modules: the
 * manual-outcome route (src/routes/canonicalApplications.ts) and the email confirmation sync
 * (src/lib/applicationEmail.ts). Both must mean exactly the same thing by "a confirmed
 * submission", and sharing the constant is what keeps them from drifting apart.
 */
export type ManualSubmissionOutcome = 'confirmed' | 'failed' | 'unknown';

export const confirmedSubmissionLifecycle = {
  submissionState: 'submitted',
  trackerState: 'applied',
} as const;

export function manualSubmissionTransition(currentState: string, outcome: ManualSubmissionOutcome) {
  if (currentState === 'submitted') return confirmedSubmissionLifecycle;
  if (outcome === 'confirmed') return confirmedSubmissionLifecycle;
  if (currentState === 'failed') return { submissionState: 'failed', trackerState: 'applying' } as const;
  if (outcome === 'failed') return { submissionState: 'failed', trackerState: 'applying' } as const;
  return { submissionState: 'needs_attention', trackerState: 'applying' } as const;
}
