import type { ApplicationAttentionCategory, ApplicationReviewState } from './applicationReview';

/**
 * The states in which a submission run has STOPPED and owes the applicant a cause.
 *
 * Everything else in the status union is a stage the pipeline is still moving through
 * ('preparing', 'filling', 'submitting'), a stage waiting on a decision that is not a failure
 * ('ready_for_final_approval'), or a success carrying its own evidence ('submitted' carries a
 * receipt). These two are the ones where the run is over and the applicant is left holding it.
 *
 * Kept as a value, not just a type, because the test enumerates it against the status union in
 * applicationReview.ts: a status added later is either classified here on purpose or the
 * enumeration fails.
 */
export const TERMINAL_RUN_STATUSES = ['needs_attention', 'failed'] as const;

export type TerminalRunStatus = typeof TERMINAL_RUN_STATUSES[number];

export function isTerminalRunStatus(status: ApplicationReviewState['status']): status is TerminalRunStatus {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * The last-resort sentence for a run that stopped without anyone naming why.
 *
 * It exists so that the fallback is a HONEST GENERIC rather than nothing. Three owner packets on
 * 2026-08-06 landed in status 'failed' with attention_reason unset and no stall, carrying only
 * submission_error "Each selector must be a non-empty string no longer than 500 characters" -
 * provider text, written for whoever maintains the runner, never shown and never meant to be.
 * From the dashboard those rows were indistinguishable from a row that had simply stopped.
 *
 * "Nothing has gone to the employer" is safe to say here and only here: the reasoned branches that
 * outrank this one (see submissionFailureOutcome) own every case where a click may have landed,
 * and this fallback is only reachable when the run is 'failed', which requires the submission
 * claim to be absent.
 */
export const UNEXPLAINED_RUN_FAILURE_REASON =
  'Litos could not finish this application, and it stopped before anything was sent. Nothing has gone to the employer. You can try this one again from your dashboard.';

/**
 * The last-resort sentence for a run parked on the applicant without a stated reason.
 *
 * Separate from the failure sentence because the two ask for different things: a failed run is
 * offering a retry, and a needs_attention run is asking the applicant to open the page.
 */
export const UNEXPLAINED_ATTENTION_REASON =
  'Litos stopped on this application and could not describe what it stopped on, so nothing has been sent. Open it when you have a minute and finish it off.';

export function attentionCategoriesForReasons(reasons: readonly string[]): ApplicationAttentionCategory[] {
  const categories = new Set<ApplicationAttentionCategory>();
  for (const reason of reasons) {
    const normalized = reason.toLowerCase();
    if (/^captcha requires your attention$|prove you are human/.test(normalized)) {
      categories.add('captcha');
    } else if (/you have already applied to/.test(normalized)) {
      // Ahead of run_failed and of the generic arm on purpose. A refused duplicate is not a
      // breakage, and filing it as one would put it in the "Litos broke, try again" bucket that
      // the applicant is meant to retry. This is the one stop she must not retry.
      categories.add('duplicate_application');
    } else if (/could not confirm it reached|never reached the application form/.test(normalized)) {
      // Ahead of evidence_gap on purpose. Both sentences mention the form; only one of them is
      // claiming the form was filled, and confusing the two is the defect this branch names.
      categories.add('form_not_reached');
    } else if (/could not finish this application|could not describe what it stopped on/.test(normalized)) {
      categories.add('run_failed');
    } else if (/filled form did not record|preview did not include|preview looks like/.test(normalized)) {
      categories.add('evidence_gap');
    } else if (/transcript|upload|attach|file|document/.test(normalized)) {
      categories.add('required_document');
    } else if (/export control|sanctions|legally authorized|sponsorship|visa|sensitive question|work authorization/.test(normalized)) {
      categories.add('sensitive_attestation');
    } else if (/required.+still empty|required field|still blank/.test(normalized)) {
      categories.add('required_field');
    } else if (/cover letter/.test(normalized)) {
      categories.add('cover_letter');
    } else if (normalized.trim()) {
      categories.add('unknown');
    }
  }
  return [...categories];
}

/**
 * The invariant: a run that has stopped carries a sentence for the applicant AND at least one
 * machine-readable category, always.
 *
 * ENFORCED IN ONE PLACE, and that is the whole design. The previous shape of this rule was "every
 * call site that writes a terminal status also writes a reason", which is not a rule, it is a
 * convention: submissionRunner.ts alone has four terminal writes, applications.ts has two more,
 * extensionSubmission.ts has two, and the ones that used `attention_reason: someHelper() ??
 * undefined` were one null return away from writing nothing. Three prod rows proved it. Putting
 * the check inside applyReviewPatch, the single merge every writer already goes through, means a
 * reasonless terminal state cannot be persisted no matter who adds the next call site.
 *
 * It NEVER invents a specific cause. The fallbacks say only what is known - the run stopped, and
 * nothing was sent - because a generic sentence that admits it is generic is recoverable, while a
 * fabricated blocker list sends someone to look at fields on a page that was never opened.
 */
export function withTerminalCause(review: ApplicationReviewState): ApplicationReviewState {
  if (!isTerminalRunStatus(review.status)) return review;
  const reason = review.attention_reason?.trim()
    ? review.attention_reason
    : review.status === 'failed'
      ? UNEXPLAINED_RUN_FAILURE_REASON
      : UNEXPLAINED_ATTENTION_REASON;
  const derived = attentionCategoriesForReasons(reason.split('\n').filter((line) => line.trim()));
  const categories = review.attention_categories?.length
    ? review.attention_categories
    : derived.length > 0 ? derived : ['unknown' as const];
  if (reason === review.attention_reason && categories === review.attention_categories) return review;
  return { ...review, attention_reason: reason, attention_categories: categories };
}
