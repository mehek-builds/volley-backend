/* The lifecycle vocabulary of the canonical applications table.
 *
 * This lives in lib because writers act on the same fact from different modules: the
 * manual-outcome route (src/routes/canonicalApplications.ts) and the shared packet-submission
 * sync (src/lib/canonicalApplicationSync.ts), which carries it for every writer that stamps a
 * packet submitted - the email confirmation path, the four server submit paths, and the dashboard
 * outcome routes. All of them must mean exactly the same thing by "a confirmed submission", and
 * sharing the constant is what keeps them from drifting apart.
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
