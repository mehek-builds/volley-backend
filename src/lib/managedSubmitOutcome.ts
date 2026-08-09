/* WHAT HAPPENED AFTER THE SUBMIT CLICK, AND THE THREE ANSWERS THERE REALLY ARE.
 *
 * Skydio packet 13bccb2d-d726-4c47-80bc-e8090ae1463e, Ashby, 2026-08-09. Litos clicked Send, the run
 * was killed 60 seconds later, and the packet landed at needs_attention with submitted_at null,
 * receipt null, submission_attempted_at null and the sentence "The final submission was attempted,
 * but Litos could not verify the employer confirmation. Check the portal or your email before trying
 * again." Every one of those is a correct statement of ignorance and the combination is a dead end:
 * the packet's own status, needs_attention AFTER a claim, is one submitRequestDisposition refuses to
 * re-run, so the applicant was invited to do something the system had already decided to refuse.
 *
 * Two separate mistakes sat underneath that, and this module is the answer to both.
 *
 * THE FIRST is that nothing ever READ the page. `readManagedReceipt` scrapes the whole body for
 * RECEIPT_PROOF_RE - a list that includes the bare word "success" and the bare phrase "thank you" -
 * and calls a match a filed application. An unsubmitted careers page carries plenty of both, and a
 * submitted one is free to confirm in words that are on neither list. The runner now reads the state
 * the ATS actually renders and reports it as `submitOutcome`; this module is where the caller keys
 * off that instead of off prose.
 *
 * THE SECOND is that "we do not know" was being written as though it were a kind of failure. It is
 * not a failure, it is a state, it is sometimes the only honest state available, and what it owes
 * the applicant is not an apology but a next step: where to look, what a sent application looks like
 * when she gets there, and what Litos will do with either answer.
 */
import type { ApplicationReviewState } from './applicationReview';

/** Why an outcome could not be established. Mirrors the review field so the two cannot drift. */
export type UnverifiedCause = NonNullable<ApplicationReviewState['unverified_submission']>['cause'];

/** The runner's own read of the page after the click. Absent on a runner that predates it. */
export type ManagedSubmitOutcome = {
  /** Whether a final submit action was actually pressed. Recorded before the post-click wait. */
  pressed: boolean;
  state: 'confirmed' | 'rejected' | 'unknown' | 'not_attempted';
  /** 'ats_state' is the published container, 'live_region' the page's own status role, 'page_text' the fallback. */
  source: 'ats_state' | 'live_region' | 'page_text' | null;
  /** The selector or role that proved it, so a verdict can be argued with. */
  evidence: string | null;
  /** The sentence the employer showed. Evidence for a person, never the thing the verdict rests on. */
  message: string | null;
  formStillPresent: boolean | null;
};

type MaybeOutcome = { submitOutcome?: unknown };

const STATES = new Set(['confirmed', 'rejected', 'unknown', 'not_attempted']);
const SOURCES = new Set(['ats_state', 'live_region', 'page_text']);

/**
 * Normalise what came back over the wire. Returns null when the runner said nothing at all, which
 * is a real case during a deploy and must degrade to the old behaviour rather than to a wrong one.
 */
export function readManagedSubmitOutcome(result: MaybeOutcome | null | undefined): ManagedSubmitOutcome | null {
  const raw = result?.submitOutcome;
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const state = typeof value.state === 'string' && STATES.has(value.state)
    ? value.state as ManagedSubmitOutcome['state']
    : 'unknown';
  const source = typeof value.source === 'string' && SOURCES.has(value.source)
    ? value.source as NonNullable<ManagedSubmitOutcome['source']>
    : null;
  return {
    pressed: value.pressed === true,
    state,
    source,
    evidence: typeof value.evidence === 'string' ? value.evidence.slice(0, 200) : null,
    message: typeof value.message === 'string' ? value.message.slice(0, 1000) : null,
    formStillPresent: typeof value.formStillPresent === 'boolean' ? value.formStillPresent : null,
  };
}

export type ManagedSubmitVerdict =
  /** The employer's own confirmation state was on screen. */
  | { kind: 'confirmed'; confirmationText: string; evidence: string }
  /** The employer's own refusal state was on screen. Nothing was filed, and that is KNOWN. */
  | { kind: 'refused'; message: string }
  /** The click landed and the page never said. The applicant has to look, and she is told where. */
  | { kind: 'unverified'; cause: UnverifiedCause }
  /** The runner never pressed Send, so nothing reached the employer and nothing is uncertain. */
  | { kind: 'not_attempted' }
  /** The runner is older than submitOutcome. Fall back to whatever the caller did before. */
  | { kind: 'unreported' };

/**
 * The verdict, from the run's own reading of the page.
 *
 * 'rejected' outranks everything, because a page that has both refused and congratulated is a page
 * that refused. 'not_attempted' is a distinct and much better answer than 'unverified': the click
 * provably did not happen, so there is nothing to go and look for.
 */
export function managedSubmitVerdict(result: MaybeOutcome | null | undefined): ManagedSubmitVerdict {
  const outcome = readManagedSubmitOutcome(result);
  if (!outcome) return { kind: 'unreported' };
  if (outcome.state === 'rejected') {
    return { kind: 'refused', message: outcome.message ?? 'The employer refused this application.' };
  }
  if (outcome.state === 'confirmed') {
    /* An empty confirmation is not a confirmation. The runner will not emit 'confirmed' without a
     * message any more, but this module is the half that ships on a different deploy cadence from
     * the runner, and the cost of the two disagreeing is an application recorded as sent that no
     * employer received. So the check is made twice on purpose. */
    const confirmationText = outcome.message?.trim();
    if (!confirmationText) return { kind: 'unverified', cause: 'no_confirmation_state' };
    return {
      kind: 'confirmed',
      confirmationText,
      evidence: outcome.evidence ?? outcome.source ?? 'ats_state',
    };
  }
  /* THE DOCSTRING ABOVE PROMISED THIS ARM AND THE CODE DID NOT HAVE IT, so a run that never pressed
   * Send was reported as an uncertain submission. That is wrong in three directions at once: she is
   * told Litos pressed Send when the runner knows it did not, she is sent looking for a receipt that
   * cannot exist, and the unresolved unverified record then blocks every future application to that
   * posting. The pre-submit gate declines to click whenever a required field is still blank, so this
   * is an ordinary outcome, not a rare one. */
  if (outcome.state === 'not_attempted' || outcome.pressed === false) return { kind: 'not_attempted' };
  return { kind: 'unverified', cause: 'no_confirmation_state' };
}

/** The stratus error codes that mean the run stopped without ever reporting what it did. */
export function isManagedRunTimeout(message: string): boolean {
  return /run timed out before it produced a result|continuation timed out|did not produce a (?:continuation )?result/i.test(message);
}

/* WHAT A SENT APPLICATION LOOKS LIKE ONCE SHE GETS THERE, per board.
 *
 * "Check the portal" is not an instruction, it is a shrug. Ashby's confirmation is a green panel
 * headed Success carrying the employer's own thank-you sentence, and it is what she will be looking
 * at or not looking at; saying so is the difference between a task and a chore. Only boards whose
 * confirmation state has actually been read belong here. Everything else gets the generic sentence,
 * which promises nothing it has not measured. */
const CONFIRMATION_LOOKS_LIKE: Record<string, string> = {
  ashby: 'On this employer’s board a sent application shows a green panel headed "Success" with a '
    + 'thank-you message, and the form is gone.',
  greenhouse: 'On this employer’s board a sent application replaces the form with a short '
    + 'confirmation, and Greenhouse usually emails you as well.',
};

/**
 * The sentence for a submit whose outcome is unknown, and the whole point of it is that it ENDS
 * SOMEWHERE.
 *
 * The old one was "The final submission was attempted, but Litos could not verify the employer
 * confirmation. Check the portal or your email before trying again." Three things wrong with it, all
 * of them measured on packet 13bccb2d:
 *
 *   - it does not say where. The portal URL is on the row and was not in the sentence.
 *   - it does not say what she is looking FOR, so "check the portal" means reading a page and
 *     guessing.
 *   - "before trying again" invites the one action the system then refuses. A needs_attention packet
 *     that has been claimed is not re-runnable, so she would have hit a second wall, and if she
 *     built a fresh application for the same posting instead, the duplicate guard would refuse that
 *     too if the first one HAD landed.
 *
 * So this one names the place, names the evidence, and asks a question with two answers Litos can
 * act on. Nothing here decides anything on her behalf: an application that may be with an employer
 * is not a thing to guess about.
 */
export function unverifiedSubmissionReason(input: {
  atsName?: string;
  portalUrl?: string;
  cause: UnverifiedCause;
}): string {
  const looksLike = CONFIRMATION_LOOKS_LIKE[(input.atsName ?? '').toLowerCase().trim()]
    ?? 'A sent application usually replaces the form with a short confirmation, and many employers '
      + 'email one too.';
  const where = input.portalUrl
    ? `Open ${input.portalUrl} and look.`
    : 'Open the employer’s application page and look.';
  const what = input.cause === 'run_timed_out'
    ? 'Litos pressed Send and the secure browser was cut off before the employer’s answer came back, '
      + 'so it does not know whether this application went through.'
    : input.cause === 'provider_error'
      ? 'Litos pressed Send and the secure browser failed before it could read the employer’s answer, '
        + 'so it does not know whether this application went through.'
      : 'Litos pressed Send and the page never showed a confirmation it could read, so it does not '
        + 'know whether this application went through.';
  return `${what} ${where} ${looksLike} Then tell Litos which you found: if it is there, Litos will `
    + 'record it as sent and will not apply again; if it is not, Litos will send this one for you. '
    + 'Do not submit it by hand in the meantime, because two applications to the same posting count '
    + 'against you and cannot be taken back.';
}
