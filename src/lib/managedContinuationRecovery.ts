import { createHash } from 'node:crypto';
import type { ManagedSubmissionAttempt } from './browserbase';

export type ManagedContinuationRecoveryState = {
  runner?: string;
  status?: string;
  continuationResumed?: boolean;
  continuationExecutionFingerprint?: string;
  continuationCallDeadlineAt?: string;
};

export type ManagedContinuationRecoveryPlan =
  | { kind: 'none' }
  | {
      kind: 'invalid';
      reason: 'binding_mismatch' | 'execution_mismatch' | 'deadline_invalid';
      submissionAttempt: ManagedSubmissionAttempt | null;
    }
  | { kind: 'expired'; submissionAttempt: ManagedSubmissionAttempt; providerDeadlineAt: string }
  | { kind: 'poll'; submissionAttempt: ManagedSubmissionAttempt; providerDeadlineAt: string };

export function managedContinuationAttemptFingerprint(
  submissionAttempt: ManagedSubmissionAttempt,
): string {
  return createHash('sha256')
    .update(`${submissionAttempt.runId}:${submissionAttempt.claimId}:${submissionAttempt.executionId}`)
    .digest('hex');
}

export function planManagedContinuationRecovery(input: {
  state: ManagedContinuationRecoveryState | undefined;
  bindingMatches: boolean;
  submissionAttempt: ManagedSubmissionAttempt;
  nowMs: number;
}): ManagedContinuationRecoveryPlan {
  const state = input.state;
  if (state?.runner !== 'stratus-managed'
    || state.status !== 'verification_pending'
    || state.continuationResumed !== true) return { kind: 'none' };
  if (!input.bindingMatches) {
    return { kind: 'invalid', reason: 'binding_mismatch', submissionAttempt: null };
  }
  if (state.continuationExecutionFingerprint
    !== managedContinuationAttemptFingerprint(input.submissionAttempt)) {
    return { kind: 'invalid', reason: 'execution_mismatch', submissionAttempt: null };
  }
  const providerDeadlineAt = state.continuationCallDeadlineAt;
  const providerDeadlineMs = providerDeadlineAt ? Date.parse(providerDeadlineAt) : Number.NaN;
  if (!providerDeadlineAt
    || !Number.isFinite(providerDeadlineMs)
    || providerDeadlineAt !== new Date(providerDeadlineMs).toISOString()) {
    return { kind: 'invalid', reason: 'deadline_invalid', submissionAttempt: input.submissionAttempt };
  }
  return providerDeadlineMs <= input.nowMs
    ? { kind: 'expired', submissionAttempt: input.submissionAttempt, providerDeadlineAt }
    : { kind: 'poll', submissionAttempt: input.submissionAttempt, providerDeadlineAt };
}

export type ManagedContinuationTerminalDecision =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'indeterminate'
  | 'gone'
  | 'deadline_expired';

export function managedRecoveryReviewFoldIsDurable(input: {
  kind: 'initial' | 'continuation';
  hasUnverifiedResult: boolean;
  state: ManagedContinuationRecoveryState | undefined;
  expectedExecutionFingerprint: string;
}): boolean {
  if (!input.hasUnverifiedResult) return false;
  const state = input.state;
  if (input.kind === 'continuation') {
    return state?.runner === 'stratus-managed'
      && state.status === 'handoff'
      && state.continuationResumed === true
      && state.continuationExecutionFingerprint === input.expectedExecutionFingerprint;
  }
  if (state?.runner !== 'stratus-managed') return true;
  if (state.status === 'handoff') return true;
  return state.status === 'verification_pending'
    && state.continuationExecutionFingerprint === input.expectedExecutionFingerprint;
}

export function managedContinuationTerminalDecision(
  state: 'pending' | 'not_found' | 'completed' | 'failed' | 'indeterminate' | 'gone',
  providerDeadlineAt: string,
  nowMs: number,
): ManagedContinuationTerminalDecision {
  if (state === 'completed' || state === 'failed' || state === 'indeterminate' || state === 'gone') {
    return state;
  }
  return nowMs < Date.parse(providerDeadlineAt) ? 'pending' : 'deadline_expired';
}
