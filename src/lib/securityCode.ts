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

/** A typed code wall belongs to this packet only when it names the packet's frozen portal email. */
export function securityCodeChallengeMatchesRecipient(
  challenge: SecurityCodeChallenge | null,
  expectedRecipient: string,
): challenge is SecurityCodeChallenge & { sentTo: string } {
  if (!challenge?.sentTo) return false;
  const observed = challenge.sentTo.trim().toLowerCase();
  const expected = expectedRecipient.trim().toLowerCase();
  return observed.length > 0 && expected.length > 0 && observed === expected;
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
  const attempts = state.attempts ?? [];
  const lastRejected = attempts.some((attempt) => attempt.outcome === 'rejected');
  const superseded = attempts.some((attempt) => attempt.outcome === 'superseded');
  /* WHAT SHE IS ACTUALLY BEING ASKED FOR, which is no longer a code.
   *
   * The old sentence ended "Enter the code from that email and Litos will finish it", and on a
   * rejection it added "use the newest email". Both were wrong in the same way, and the way is
   * structural rather than a wording problem: the employer issues a new code on every send and
   * invalidates the last, and a code control only exists on a page that has just been sent. So by
   * the time any code she pastes reaches a form, the send that got Litos back to a code field has
   * already replaced it. "Use the newest email" asked her to win a race that cannot be won.
   *
   * What finishes this application is Litos reading the code itself, in the same run and on the
   * same page, in the seconds between the send and the email landing. So the sentence says what
   * Litos will do, what it needs to be able to do it, and - when it has already tried - what
   * actually happened. The three tails are mutually exclusive and ordered by what she needs first.
   */
  const tail = superseded
    ? ' The code you gave Litos could not be used: this employer issues a new code every time the'
      + ' form is sent, and Litos has to send the form to reach the code field at all, so the code'
      + ' in your hand is replaced before it can be typed. Litos now reads the new code itself from'
      + ' your connected mailbox on the same page it was asked for.'
    : lastRejected
      ? ' Litos read a code from your mailbox and the employer did not accept it, so this one needs'
        + ' you: open the portal and finish it there.'
      : ' Litos reads the code from your connected mailbox and enters it on the same page that asked'
        + ' for it. If your mailbox is not connected, or automatic verification is off, that is what'
        + ' is missing here.';
  return `Litos submitted this application and the employer asked for a human check: a ${length}security code was emailed${address}, and the application is not filed until that code is entered and the form is sent again.${tail}`;
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
 * THE CODE CONTROL HAS TO ALREADY BE ON THE PAGE WHEN THIS LIST RUNS. The runner's atomic action
 * types the code FIRST and clicks once, in that order, because clicking a verification form before
 * the code is in it resubmits empty and rotates the code. So this is the action list for a run that
 * is already standing on the challenge DOM, which in practice means a continuation of the run that
 * raised it. Handing it to a list that begins with a fresh page load is what packet
 * 9810bdcf-fc3d-44bb-a8cb-b09c51aaf131 did on 2026-08-09: on first paint a Greenhouse application
 * form has no code control at all, the runner reported 'no_control' and threw 'Security code was not
 * entered before atomic verification', and nothing was typed and nothing was sent.
 * securityCodeContinuationActions below is the shape that gets used against a live employer.
 *
 * ZERO EXTRA ACTIONS, and that is not tidiness. MANAGED_ACTION_LIMIT is 120; a reconstruction of a
 * real Greenhouse packet's action list came to exactly 120 with trimGreenhouseManagedActionsToBudget
 * having already shaved preferred_first_name and preferred_last_name off the end. Every action added
 * to a submit run displaces a field the applicant expects filled. The code cannot be queued as its
 * own top-level action anyway.
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
 * The whole action list for the second half of a security-code submission: one atomic action,
 * carrying the code, run as a continuation of the browser that is already looking at the challenge.
 *
 * IT IS THE PACKET'S OWN SUBMIT ACTION, not a second copy of one. buildManagedPortalActions ends in
 * an atomic submit whose selector, chooser policy, contract version and retry budget the runner
 * validates field by field and rejects outright on any mismatch. Writing those out again here would
 * be a fifth place they have to agree, and the runner's answer to a disagreement is to refuse the
 * whole run - so the list is derived from the one production already built.
 *
 * Returns null when the packet's list does not end in an atomic submit. That is the same upstream
 * gate withSecurityCode respects: a packet Litos may not auto-submit does not become submittable by
 * arriving here with a code in hand.
 */
export function securityCodeContinuationActions(
  actions: readonly ManagedBrowserAction[],
  code: string,
): ManagedBrowserAction[] | null {
  const last = actions[actions.length - 1];
  if (!last || last.type !== 'confirmAndSubmit' || last.contractVersion !== 2 || last.submitKind !== 'application') {
    return null;
  }
  return withSecurityCode([last], code);
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
  return withSecurityCodeAttempts(state, [attempt]);
}

/* WHICH OUTCOMES MEAN THE CODE ITSELF IS BURNT.
 *
 * 'no_control' and 'not_entered' say Litos never got the string into the page, so the code is as
 * good as it ever was and forgetting it costs nothing. Every other outcome says the code was used,
 * or was killed by a send, and its fingerprint is the only thing standing between it and being
 * selected again by the standing 24 hour mailbox lookback.
 */
function attemptBurnsTheCode(attempt: SecurityCodeAttempt): boolean {
  return attempt.outcome !== 'no_control' && attempt.outcome !== 'not_entered';
}

/**
 * One run can now produce two attempts, and both have to survive.
 *
 * A finishing run carries the applicant's code, which it records as 'superseded' because it cannot
 * be typed, and then reads the code its own submit caused and records what happened to that one.
 * Appending them one at a time through separate state objects lost whichever was written first, and
 * losing the superseded record is the one that matters: its fingerprint is the only thing standing
 * between a dead code and an endless sequence of resends, each of which emails her another code.
 *
 * THE CAP USED TO BE A PLAIN slice(-10), AND THAT GAVE A SPENT CODE A WAY BACK. Ten further
 * attempts - reachable by supplying ten wrong codes, each of which records one 'superseded' row -
 * pushed the spent fingerprint off the front, findSecurityCodeAttempt stopped finding it, and the
 * 24 hour mailbox lookback was free to select and re-spend it. The blast radius is bounded (a
 * verification click on a wall that is already standing, not a second application send), but the
 * fix is cheap: the rows that mark a code burnt are evicted last and are held to a much larger cap,
 * so the trimming falls on the rows that were never protecting anything. Still nothing but
 * fingerprints, so the larger cap is a few kilobytes at its very worst.
 */
const SECURITY_CODE_ATTEMPT_CAP = 10;
const SECURITY_CODE_BURNT_ATTEMPT_CAP = 200;

export function withSecurityCodeAttempts(
  state: SecurityCodeState,
  attempts: readonly SecurityCodeAttempt[],
): SecurityCodeState {
  if (attempts.length === 0) return state;
  let merged = [...(state.attempts ?? [])];
  for (const attempt of attempts) {
    // A code is spent before the remote continuation so a process crash cannot replay it. When the
    // continuation returns, replace that provisional error with the measured terminal outcome.
    // Keeping two rows for one fingerprint would make findSecurityCodeAttempt return the stale one.
    merged = merged.filter((existing) => existing.fingerprint !== attempt.fingerprint);
    merged.push(attempt);
  }
  if (merged.length > SECURITY_CODE_ATTEMPT_CAP) {
    // Order is preserved: the kept rows are re-read out of `merged` rather than concatenated, so
    // the newest-last invariant every reader of `attempts` relies on survives the trim.
    const keep = new Set([
      ...merged.filter(attemptBurnsTheCode).slice(-SECURITY_CODE_BURNT_ATTEMPT_CAP),
      ...merged.slice(-SECURITY_CODE_ATTEMPT_CAP),
    ]);
    merged = merged.filter((attempt) => keep.has(attempt));
  }
  return { ...state, attempts: merged };
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
