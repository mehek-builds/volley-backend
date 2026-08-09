import { createHash } from 'node:crypto';
import type { ManagedBrowserAction, ManagedBrowserResult } from './browserbase';
import type { ApplicationReviewState, SecurityCodeAttempt, SecurityCodeState } from './applicationReview';

/**
 * GREENHOUSE'S EMAILED SECURITY CODE: the step that sits between a submit and a filed application,
 * and that Litos could not see, name or finish.
 *
 * WHAT WAS MEASURED, 2026-08-08. Three packets for one applicant (Redwood Materials, Scale AI,
 * Cresta) sat at status 'ready_for_final_approval' with submitted_at null, receipt null and
 * attention_reason null - a state that says, in both directions, something untrue. Her mailbox held
 * three emails from no-reply@us.greenhouse-mail.io timestamped to the same minute as those three
 * runs: "Copy and paste this code into the security code field on your application: TPHJrFMJ. After
 * you enter the code, resubmit your application." The Cresta run's own preview screenshot shows the
 * form carrying eight single-character boxes under a "Security code" label.
 *
 * So the application had been submitted once, which the state said it had not, and it was parked on
 * a human check, which the state also said it was not. The dashboard offered a green "Send it"
 * button. Pressing it submits again with no code, which issues another code and files nothing.
 *
 * THIS IS NOT THE CAPTCHA. A previous investigation read 31 live employer forms, found no reCAPTCHA
 * bframe on any of them, and concluded the CAPTCHA was never real. That conclusion is correct about
 * reCAPTCHA and it missed this entirely, because this is a different mechanism: an email round trip,
 * not a challenge widget. Code and comments asserting "no human check exists" are talking about
 * something else.
 *
 * WHERE IT IS DETECTED, and where it is deliberately not. The trigger is the CONTROL - the runner
 * reports the code input group structurally, from the DOM, at zero action cost (see
 * readSecurityCodeChallenge in stratus-browser-cloud). Nothing here matches page prose, and in
 * particular nothing matches '* indicates a required field', which is on every Greenhouse form ever
 * rendered and which an earlier gate in this repo did match. The address is prose, read from inside
 * the control's own group, and only ever as a detail of a state something else established.
 */

export type SecurityCodeChallenge = {
  sentTo?: string;
  digits: number;
};

/**
 * The challenge as the runner saw it, or null.
 *
 * `fieldCount` is sized off the control: eight boxes means eight characters. It is not read off the
 * sentence, which says "8-character" on Greenhouse today and is free to stop saying it tomorrow. A
 * count of zero (a single field with no maxlength) is carried through as zero and means "unknown
 * length", never "no challenge" - the challenge is the control's existence.
 */
export function readManagedSecurityCodeChallenge(
  result: Pick<ManagedBrowserResult, 'humanVerification'>,
): SecurityCodeChallenge | null {
  const verification = result.humanVerification;
  if (!verification || verification.kind !== 'security_code') return null;
  const digits = Number.isInteger(verification.fieldCount) && verification.fieldCount > 0
    ? verification.fieldCount
    : 0;
  return { digits, ...(verification.sentTo ? { sentTo: verification.sentTo } : {}) };
}

/**
 * The sentence the applicant reads.
 *
 * It says the two things the previous state got wrong, in the order she needs them: an application
 * HAS gone in, and it is not finished. Both facts are known, neither is inferred, and nothing here
 * is invented - the address and the length come off the page, and when either is missing the
 * sentence simply says less rather than guessing.
 *
 * Kept as prose because attention_reason is prose and always will be. The countable half is the
 * 'security_code' attention category, which attentionCategoriesForReasons derives from this text.
 */
export function securityCodeAttentionReason(state: SecurityCodeState): string {
  const length = state.digits > 0 ? `${state.digits}-character ` : '';
  const address = state.sent_to ? ` to ${state.sent_to}` : '';
  const lastRejected = state.attempts?.some((attempt) => attempt.outcome === 'rejected') === true;
  const tail = lastRejected
    ? ' The last code Litos tried was not accepted, so use the newest email.'
    : '';
  return `Litos submitted this application and the employer asked for a human check: a ${length}security code was emailed${address}, and the application is not filed until that code is entered and the form is sent again.${tail} Enter the code from that email and Litos will finish it.`;
}

/**
 * Whitespace out, shape checked, nothing else touched.
 *
 * NOT uppercased and NOT lowercased. Greenhouse's own example code is 'TPHJrFMJ', which is mixed
 * case on purpose, so normalising the case would silently destroy a valid code and produce a
 * rejection nobody could explain. Spaces and dashes come out because that is how a code arrives
 * when it is copied out of an email or read off a phone.
 *
 * Length is checked against what the CONTROL asked for when it said, and against a permissive bound
 * when it did not. Never against the sentence.
 */
export function normalizeSecurityCode(raw: unknown, digits: number): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[\s-]/g, '');
  if (!/^[A-Za-z0-9]+$/.test(cleaned)) return null;
  if (digits > 0) return cleaned.length === digits ? cleaned : null;
  return cleaned.length >= 4 && cleaned.length <= 12 ? cleaned : null;
}

/**
 * How an attempt is recognised again without the code itself ever being stored.
 *
 * IDEMPOTENCY IS THE WHOLE REASON THIS EXISTS. Supplying the same code twice must not submit twice,
 * and the only honest way to know it is the same code is to compare it. Storing the code to compare
 * it would mean keeping a live credential to a real employer's form in an unvalidated JSON blob
 * that is serialized to the dashboard and the extension; a digest compares just as well and cannot
 * be replayed. Salted with the application id so the same code on two applications does not produce
 * the same fingerprint, and so a fingerprint cannot be looked up in a rainbow table of eight-
 * character codes.
 */
export function securityCodeFingerprint(applicationId: string, code: string): string {
  return createHash('sha256').update(`${applicationId}:${code}`).digest('hex').slice(0, 32);
}

export function findSecurityCodeAttempt(
  state: SecurityCodeState | undefined,
  fingerprint: string,
): SecurityCodeAttempt | undefined {
  return state?.attempts?.find((attempt) => attempt.fingerprint === fingerprint);
}

/**
 * Hand a code to the atomic confirmation and submit action the list already ends with.
 *
 * ZERO EXTRA ACTIONS, and that is not tidiness. MANAGED_ACTION_LIMIT is 120; a reconstruction of a
 * real Greenhouse packet's action list came to exactly 120 with trimGreenhouseManagedActionsToBudget
 * having already shaved preferred_first_name and preferred_last_name off the end. Every action added
 * to a submit run displaces a field the applicant expects filled. The code cannot be queued as its
 * own top-level action anyway. The runner enters the supplied code first, then performs exactly one
 * fresh verification confirmation pass and one physical click. This action is never permitted to
 * click an application form first, and the list stays the length it already was.
 *
 * Returns the list unchanged when it does not end in an atomic submit, rather than appending one. A
 * caller that has no atomic submit has been gated somewhere upstream (portalCanAutoSubmit, the
 * multi-step wizards), and adding one here would walk straight through that gate.
 */
export function withSecurityCode(
  actions: readonly ManagedBrowserAction[],
  code: string,
): ManagedBrowserAction[] {
  const next = actions.map((action) => ({ ...action }));
  const last = next[next.length - 1];
  if (!last || last.type !== 'confirmAndSubmit' || last.contractVersion !== 2 || last.submitKind !== 'application') {
    return next;
  }
  last.securityCode = code;
  last.submitKind = 'verification';
  return next;
}

/**
 * The state written when the page asks for a code, whether the submit behind it was authorized or
 * not.
 *
 * `submit_was_authorized` is recorded rather than assumed because BOTH answers happen and they mean
 * different things. On the submit path it is true and this is the ordinary next step of a send the
 * applicant asked for. On the prepare path it is false, and that is a defect report: a run that was
 * only supposed to fill has put an application in front of an employer with no authorization behind
 * it. The applicant is owed the same sentence either way - an application went in and it is not
 * finished - and Litos is owed a way to count how often the second one happens.
 */
export function beginSecurityCodeState(options: {
  challenge: SecurityCodeChallenge;
  attemptedAt: string;
  authorized: boolean;
  existing?: SecurityCodeState;
}): SecurityCodeState {
  return {
    digits: options.challenge.digits,
    ...(options.challenge.sentTo ? { sent_to: options.challenge.sentTo } : {}),
    requested_at: options.attemptedAt,
    submit_was_authorized: options.authorized,
    // Attempts survive a re-issue. The clock restarts, the history does not: without it, the second
    // code an employer sends erases the record that the first one was already tried and refused,
    // and the idempotency check has nothing left to recognise.
    ...(options.existing?.attempts?.length ? { attempts: options.existing.attempts } : {}),
  };
}

export function withSecurityCodeAttempt(
  state: SecurityCodeState,
  attempt: SecurityCodeAttempt,
): SecurityCodeState {
  return { ...state, attempts: [...(state.attempts ?? []), attempt].slice(-10) };
}

/**
 * The reason a packet in this state must not be re-runnable by the ordinary path.
 *
 * Exported as a predicate rather than left implicit at each call site, for the same reason
 * withTerminalCause exists: "every caller remembers" is a convention, not a rule.
 */
export function awaitsSecurityCode(review: ApplicationReviewState): boolean {
  return review.status === 'awaiting_security_code';
}
