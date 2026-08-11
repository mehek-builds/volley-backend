import type { ApplicationAttentionCategory, ApplicationReviewState } from './applicationReview';

/**
 * The states in which a submission run has STOPPED and owes the applicant a cause.
 *
 * Everything else in the status union is a stage the pipeline is still moving through
 * ('preparing', 'filling', 'submitting'), a stage waiting on a decision that is not a failure
 * ('ready_for_final_approval'), or a success carrying its own evidence ('submitted' carries a
 * receipt). These are the ones where the run is over and the applicant is left holding it.
 *
 * 'awaiting_security_code' belongs here even though nothing failed. The run is over, an application
 * has reached the employer, and it will not be filed until a human does something. That is exactly
 * the condition this list encodes, and putting it here is what forces it through withTerminalCause
 * and guarantees it can never be persisted as a bare status with no sentence attached - which is
 * precisely how the three measured packets were stored.
 *
 * Kept as a value, not just a type, because the test enumerates it against the status union in
 * applicationReview.ts: a status added later is either classified here on purpose or the
 * enumeration fails.
 */
export const TERMINAL_RUN_STATUSES = ['needs_attention', 'failed', 'awaiting_security_code'] as const;

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

/**
 * The last-resort sentence for a security-code state whose details did not survive.
 *
 * It has its own fallback because the other two both say some version of "nothing has been sent",
 * and here that is FALSE: the employer has already received a submission. A generic sentence is
 * recoverable; a generic sentence that contradicts the state is not.
 */
export const UNEXPLAINED_SECURITY_CODE_REASON =
  'Litos submitted this application and the employer asked for a security code by email before it will file it. Litos could not read which address it went to. Check your inbox for the code and enter it here, and Litos will finish sending this one.';

export function attentionCategoriesForReasons(reasons: readonly string[]): ApplicationAttentionCategory[] {
  const categories = new Set<ApplicationAttentionCategory>();
  for (const reason of reasons) {
    const normalized = reason.toLowerCase();
    /* FIRST, and it has to be: this is the one state that has already reached an employer, and it
     * must not be reclassified as one that has not.
     *
     * Matched on the CLAUSE, not on the bare phrase "security code". Both sentences that produce
     * this category are written in securityCode.ts and in this file, and both contain one of these
     * two. A bare /security code/ would also fire on an employer's own field label arriving through
     * a blocker line - "\"Security code\" is required and is still empty" is exactly the shape the
     * runner's required-field scan emits - and that would label a form Litos merely failed to fill
     * as an application already sitting with an employer. */
    if (/security code was emailed|asked for a security code by email/.test(normalized)) {
      categories.add('security_code');
    } else if (/privacy notice before the application form opens|data consent/.test(normalized)) {
      categories.add('privacy_consent');
    } else if (/sign in|log in|make an account|create an account|account login/.test(normalized)) {
      categories.add('account_login');
    } else if (/does not know whether this application went through|pressed send on .*and could not confirm what came back|could not confirm what came back/.test(normalized)) {
      /* SECOND, immediately after the other state that may already be with an employer, and ahead of
       * everything that says nothing was sent. A submit whose outcome is unknown is not a breakage
       * and must never land in the "Litos broke, try again" bucket: trying again is the one action
       * that could turn one application into two. Skydio packet 13bccb2d filed as 'unknown', which
       * is the bucket with no next step attached to it. */
      categories.add('unverified_submission');
    } else if (/^captcha requires your attention$|prove you are human/.test(normalized)) {
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
    } else if (/\b(?:transcripts?|uploads?|uploaded|uploading|attach(?:es|ed|ing|ment|ments)?|files?|documents?|documentation)\b/.test(normalized)) {
      /* WORD BOUNDARIES, BECAUSE `file` LIVES INSIDE `profile`.
       *
       * Unbounded, this arm read `"linkedin profile" is required and is still empty` as a document
       * the employer wants uploaded, and filed it here instead of one arm further down under
       * required_field. Both the LinkedIn URL and the GitHub URL field are common enough on these
       * forms that the miscount was routine rather than exotic.
       *
       * COUNTING ONLY. Nothing keys a control off this category, and nothing should: it stays a
       * rough sort of what a run stopped on. The dashboard reads review.required_documents, a
       * structured measurement of the employer's own labels, for the separate reason that no regex
       * here can fix withholdInvalidLeadAlignment writing 'required_document' for a resume
       * alignment failure involving no document at all. See lib/requiredDocuments.ts.
       *
       * The inflections are spelled out rather than left to a trailing \w* so the boundary is real
       * on both ends. They are here so that adding the boundaries only ever REMOVES the substring
       * false positives: every sentence the unbounded version matched on a whole word still
       * matches, and a plural or a participle is a whole word. */
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
      : review.status === 'awaiting_security_code'
        // Never the generic attention sentence for this one. That sentence ends "nothing has been
        // sent", and on a packet in this state an employer already holds a submission.
        ? UNEXPLAINED_SECURITY_CODE_REASON
        : UNEXPLAINED_ATTENTION_REASON;
  const derived = attentionCategoriesForReasons(reason.split('\n').filter((line) => line.trim()));
  const categories = review.attention_categories?.length
    ? review.attention_categories
    : derived.length > 0 ? derived : ['unknown' as const];
  if (reason === review.attention_reason && categories === review.attention_categories) return review;
  return { ...review, attention_reason: reason, attention_categories: categories };
}
