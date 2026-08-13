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
  /** ATS state is strong evidence. The other sources remain useful context, but cannot promote a receipt-only continuation. */
  source: 'ats_state' | 'ats_route' | 'ats_state_unconfirmed' | 'live_region' | 'page_text' | null;
  /** The selector or role that proved it, so a verdict can be argued with. */
  evidence: string | null;
  /** The sentence the employer showed. Evidence for a person, never the thing the verdict rests on. */
  message: string | null;
  formStillPresent: boolean | null;
};

type MaybeOutcome = { submitOutcome?: unknown };

const STATES = new Set(['confirmed', 'rejected', 'unknown', 'not_attempted']);
const SOURCES = new Set(['ats_state', 'ats_route', 'ats_state_unconfirmed', 'live_region', 'page_text']);

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

/* A REFUSAL IS A DEFINITE STATEMENT, SO IT HAS TO BE PROVEN LIKE ONE.
 *
 * The confirmed arm has been gated on both sides of the wire for a while: this module refuses an
 * empty confirmation just below, and Stratus refuses a confirmed container that is empty or that
 * sits over a live form. The rejected arm had neither gate on either side, and Stratus's rejected
 * arm returns the FIRST visible '.ashby-application-form-failure-container' it finds without
 * reading its text or asking whether the form is gone. So an empty container was enough to make
 * this function say 'refused'.
 *
 * WHAT THAT COSTS, and it is the worst pair of outputs in the system arriving together. The runner
 * writes "Nothing was filed, so there is no confirmation to look for" onto a packet whose submit
 * request may well have reached the employer, AND it releases submission_claimed_at, so the packet
 * becomes re-runnable and a second application follows the first.
 *
 * SO THE FAILURE DIRECTION IS FIXED HERE: a rejection that cannot prove itself falls to 'unknown',
 * which keeps the claim and asks the applicant to look. It never falls to 'refused'.
 *
 * NOTE WHAT THIS COSTS IN THE OTHER DIRECTION, honestly: an ATS that renders its refusal banner
 * ABOVE a still-live form so the applicant can correct and retry will now be reported unverified
 * rather than refused. That is one extra question asked of her on a packet that is still fully
 * resolvable, against a duplicate application filed at an employer who may cap re-applications.
 */
function refusalIsProven(outcome: ManagedSubmitOutcome): boolean {
  return Boolean(outcome.message?.trim()) && outcome.formStillPresent === false;
}

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
    if (refusalIsProven(outcome)) return { kind: 'refused', message: outcome.message!.trim() };
    /* An unproven refusal must not fall through to the confirmed arm below - a page that has both
     * refused and congratulated is a page that refused - so the two honest answers are taken here.
     * A runner that says it never pressed is still believed, because that is a claim about this
     * process rather than about the employer's page. */
    if (outcome.pressed === false) return { kind: 'not_attempted' };
    return { kind: 'unverified', cause: 'no_confirmation_state' };
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

type ManagedReceiptResult = MaybeOutcome & {
  url?: unknown;
  screenshot?: string | null;
  continuationOffered?: unknown;
  continuationToken?: unknown;
  continuationExpiresAt?: unknown;
  humanVerification?: unknown;
};

type ManagedAtsFamily = 'ashby' | 'greenhouse';

type ManagedAtsBinding = {
  family: ManagedAtsFamily;
  origin: string;
  tenant: string;
  jobToken: string;
  shape: 'ashby_path' | 'greenhouse_jobs_path' | 'greenhouse_embed_query';
};

function exactQueryIdentity(url: URL): { tenant: string; jobToken: string } | null {
  const tenants = url.searchParams.getAll('for');
  const tokens = url.searchParams.getAll('token');
  return tenants.length === 1
    && tokens.length === 1
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(tenants[0])
    && /^\d{5,20}$/.test(tokens[0])
    ? { tenant: tenants[0], jobToken: tokens[0] }
    : null;
}

function validGreenhouseIdentity(tenant: string, jobToken: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(tenant) && /^\d{5,20}$/.test(jobToken);
}

function managedAtsBinding(result: ManagedReceiptResult): ManagedAtsBinding | null {
  if (typeof result.url !== 'string') return null;
  let url: URL;
  try {
    url = new URL(result.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  const host = url.hostname.toLowerCase();
  if (host === 'jobs.ashbyhq.com') {
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/application\/?$/);
    return match ? { family: 'ashby', origin: url.origin, tenant: match[1], jobToken: match[2], shape: 'ashby_path' } : null;
  }
  if (/^(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io$/.test(host)) {
    const match = url.pathname.match(/^\/([^/]+)\/jobs\/([^/]+)\/?$/);
    if (match && validGreenhouseIdentity(match[1], match[2])) {
      return { family: 'greenhouse', origin: url.origin, tenant: match[1], jobToken: match[2], shape: 'greenhouse_jobs_path' };
    }
    if (/^\/embed\/job_app\/?$/.test(url.pathname)) {
      const identity = exactQueryIdentity(url);
      return identity ? { family: 'greenhouse', origin: url.origin, ...identity, shape: 'greenhouse_embed_query' } : null;
    }
  }
  return null;
}

function observedAtsIdentity(result: ManagedReceiptResult, family: ManagedAtsFamily): ManagedAtsBinding | null {
  if (typeof result.url !== 'string') return null;
  let url: URL;
  try {
    url = new URL(result.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  const host = url.hostname.toLowerCase();
  if (family === 'ashby' && host === 'jobs.ashbyhq.com') {
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/application\/?$/);
    return match ? { family, origin: url.origin, tenant: match[1], jobToken: match[2], shape: 'ashby_path' } : null;
  }
  if (family === 'greenhouse' && /^(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io$/.test(host)) {
    const match = url.pathname.match(/^\/([^/]+)\/jobs\/([^/]+)\/(?:application_)?confirmation\/?$/);
    if (match && validGreenhouseIdentity(match[1], match[2])) {
      return { family, origin: url.origin, tenant: match[1], jobToken: match[2], shape: 'greenhouse_jobs_path' };
    }
    if (/^\/embed\/job_app\/confirmation\/?$/.test(url.pathname)) {
      const identity = exactQueryIdentity(url);
      return identity ? { family, origin: url.origin, ...identity, shape: 'greenhouse_embed_query' } : null;
    }
  }
  return null;
}

function sameAtsBinding(left: ManagedAtsBinding | null, right: ManagedAtsBinding | null): boolean {
  return !!left && !!right
    && left.family === right.family
    && left.origin === right.origin
    && left.tenant === right.tenant
    && left.jobToken === right.jobToken
    && left.shape === right.shape;
}

function exactAtsReceipt(
  result: ManagedReceiptResult,
  outcome: ManagedSubmitOutcome,
  expected: ManagedAtsBinding,
): boolean {
  const observed = observedAtsIdentity(result, expected.family);
  if (!observed
      || observed.origin !== expected.origin
      || observed.tenant !== expected.tenant
      || observed.jobToken !== expected.jobToken
      || observed.shape !== expected.shape
      || typeof result.url !== 'string') return false;
  const url = new URL(result.url);
  if (expected.family === 'ashby' && outcome.source === 'ats_state') {
    if (outcome.state === 'confirmed') return outcome.evidence === '.ashby-application-form-success-container';
    // Same gate as managedSubmitVerdict, applied one step earlier so an unproven refusal cannot even
    // become the receipt result. The two are deliberately checked twice: this decides which page the
    // row is written from, and that decides what the row says.
    if (outcome.state === 'rejected') {
      return outcome.evidence === '.ashby-application-form-failure-container' && refusalIsProven(outcome);
    }
    return false;
  }
  const greenhousePath = /\/(?:application_)?confirmation\/?$/.test(url.pathname);
  return expected.family === 'greenhouse'
    && greenhousePath
    && outcome.state === 'confirmed'
    && outcome.source === 'ats_route'
    && outcome.evidence === `greenhouse:${url.pathname}`;
}

export type ManagedReceiptObservation<T extends ManagedReceiptResult> = {
  /** The only result the caller may use to decide submitted/refused/unverified. */
  receiptResult: T;
  /** The latest trustworthy post-click picture, even when its verdict remains unknown. */
  evidenceResult: T;
  /** The one result returned by the consumed continuation, for a newly rendered typed challenge. */
  observedResult?: T;
  attempted: boolean;
  error?: unknown;
};

/**
 * Re-read an exact held Stratus page once when its first post-click verdict is still unknown.
 *
 * This helper owns the fail-closed boundary. It accepts only the ATS hooks the runner already
 * publishes for Ashby's success/failure containers and Greenhouse's confirmation route. A live
 * region, body text, another unknown result, or a continuation failure can improve the screenshot
 * shown to the applicant, but none of them can turn the row into submitted or refused.
 *
 * The observer receives only the capability copied from this exact result. It receives no URL and
 * no action list, so it cannot reopen the employer page or press Send a second time. Stratus binds
 * the capability to its held sandbox and consumes it atomically on the first claim.
 */
export async function observeManagedReceiptOnce<T extends ManagedReceiptResult>(input: {
  initial: T;
  /** Frozen from the packet before the employer page runs. Employer-returned URLs cannot set it. */
  expectedApplicationUrl: string;
  observe: (continuationToken: string) => Promise<T>;
  nowMs?: number;
}): Promise<ManagedReceiptObservation<T>> {
  const unchanged = (over: Partial<ManagedReceiptObservation<T>> = {}): ManagedReceiptObservation<T> => ({
    receiptResult: input.initial,
    evidenceResult: input.initial,
    attempted: false,
    ...over,
  });
  const initialOutcome = readManagedSubmitOutcome(input.initial);
  if (initialOutcome?.pressed !== true || initialOutcome.state !== 'unknown') return unchanged();
  const expectedBinding = managedAtsBinding({ url: input.expectedApplicationUrl });
  const initialBinding = managedAtsBinding(input.initial);
  if (!sameAtsBinding(initialBinding, expectedBinding)) return unchanged();
  if (input.initial.humanVerification != null || input.initial.continuationOffered !== true) return unchanged();
  const token = input.initial.continuationToken;
  const expiresAt = input.initial.continuationExpiresAt;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,200}$/.test(token)) return unchanged();
  if (typeof expiresAt !== 'string') return unchanged();
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= (input.nowMs ?? Date.now())) return unchanged();

  let observed: T;
  try {
    observed = await input.observe(token);
  } catch (error) {
    return unchanged({ attempted: true, error });
  }
  const observedOutcome = readManagedSubmitOutcome(observed);
  const atsTerminal = observedOutcome?.pressed === true
    && (observedOutcome.state === 'confirmed' || observedOutcome.state === 'rejected')
    && !!expectedBinding
    && exactAtsReceipt(observed, observedOutcome, expectedBinding);
  const heldPageMatches = sameAtsBinding(managedAtsBinding(observed), expectedBinding);
  const evidenceResult = observed.screenshot && (atsTerminal || heldPageMatches) ? observed : input.initial;
  return {
    receiptResult: atsTerminal ? observed : input.initial,
    evidenceResult,
    ...(heldPageMatches ? { observedResult: observed } : {}),
    attempted: true,
  };
}

/** The stratus error codes that mean the run stopped without ever reporting what it did. */
export function isManagedRunTimeout(message: string): boolean {
  return /run timed out before it produced a result|continuation timed out|did not produce a (?:continuation )?result/i.test(message);
}

/** The exact sentence the Stratus atomic chooser throws before submitHandle.click executes. */
const MANAGED_NO_SUBMIT_CONTROL_MESSAGE = 'Atomic submit control was missing or ambiguous';

/* The prefix an Error acquires when it is stringified, and nothing else.
 *
 * `String(new Error(m))` is `Error: m`, and a subclass gives `TypeError: m`, `SomeError: m`. That is
 * the shape a thrown error takes crossing the Stratus HTTP boundary: the runner serializes its own
 * error, the message travels in `payload.error`, and managedBrowserErrorMessage passes it through
 * VERBATIM into `new Error(...)`. So the row stores the wrapped form and the predicate below was
 * comparing against the unwrapped one.
 *
 * DELIBERATELY REQUIRES THE NAME TO END IN "Error", and deliberately anchored with a single literal
 * ": ". `Stratus: Atomic submit control...` is not stripped, arbitrary employer text before the
 * sentence is not stripped, and only ONE layer comes off, so `Error: Error: ...` still fails. This
 * widens the key by exactly the wrapping that occurs on this path and by nothing else.
 */
const THROWN_ERROR_WRAPPER = /^(?:[A-Za-z][A-Za-z0-9_$]*)?Error: /;

/**
 * The message a thrown error carried, with one stringification wrapper removed.
 *
 * Exported so the predicate below and its tests are arguing about the same function rather than two
 * copies of the same regex.
 */
export function unwrapThrownErrorMessage(message: string): string {
  return message.trim().replace(THROWN_ERROR_WRAPPER, '').trim();
}

/* THE KEY HAS TO FIT THE LOCK IN THE FORMAT THE LOCK IS ACTUALLY WRITTEN IN.
 *
 * kos.ai, production, 2026-08-11, after PR 497 shipped. Try again still answered "This application
 * cannot start another submission run from its current state". The row cleared all five evidence
 * checks in submissionProvablyNotSent and fell to its last line, which asked this function about a
 * stored `Error: Atomic submit control was missing or ambiguous` and got false.
 *
 * ONE PREDICATE, TWO FAILURES, and the second one is why the row was ever stuck. This is also the
 * test fail() uses to decide whether to take the preClickNoSubmitReview early return - the branch PR
 * 494 added to RELEASE the claim at write time. The wrapped form missed there first, so the run
 * landed at needs_attention still wearing its claim; then it missed again at read time, so the
 * reopen could not lift it. Fixing the format fixes both ends at once.
 *
 * STILL EXACT AND STILL ANCHORED. Everything an adversarial read of the old key probed is still
 * refused: a lowercase copy, a trailing period, a one-character truncation, an appended stack, an
 * inner newline. The comparison is equality against one constant, never a substring or a search over
 * free text, because a value an employer or a truncating log pipeline can influence must not be able
 * to reach it.
 */
export function isManagedNoSubmitControl(message: string): boolean {
  return unwrapThrownErrorMessage(message) === MANAGED_NO_SUBMIT_CONTROL_MESSAGE;
}

/**
 * Everything a stored row keeps about whether its last run reached the employer.
 *
 * An ApplicationReviewState satisfies this structurally, so callers pass the row itself. The
 * `submitOutcome` field is the runner's own post-click read, which is NOT persisted: a caller still
 * holding the result can supply it, and a row read back out of the database cannot.
 */
export type PreClickNoSendEvidence = Pick<
  ApplicationReviewState,
  'submission_attempted_at' | 'receipt' | 'unverified_submission' | 'security_code' | 'submission_error'
  /* The runner's own typed answer, written at failure time. Present on rows written by builds that
   * carry submission_stop and absent on every older one, which is why the string match below stays
   * where it is rather than being replaced today. */
  | 'submission_stop'
> & MaybeOutcome;

/* NOTHING WAS SENT, AND THE ROW CAN PROVE IT.
 *
 * kos.ai, production, 2026-08-11. The managed run stopped inside the atomic chooser, which throws
 * before submitHandle.click is ever reached, and the row it left behind carried: no
 * submission_attempted_at, no receipt, no unverified_submission, no security_code, no
 * browser_session_id, and submission_error 'Atomic submit control was missing or ambiguous'. Every
 * one of those is a statement that no application exists on the employer side. The packet still sat
 * at needs_attention wearing the claim its run had taken, which submitRequestDisposition refuses,
 * and "Try again" answered "This application cannot start another submission run from its current
 * state" forever. PR 494 releases the claim on this path, but a fix that only runs at write time
 * cannot reach a row that was already written.
 *
 * SO THE PROOF IS ASKED OF THE ROW RATHER THAN OF THE CLOCK, and it has to be a POSITIVE proof.
 * Absence alone proves nothing: the Skydio shape - a run killed mid-submit on a build that predates
 * unverified_submission - has all the same fields empty and is precisely the case where an employer
 * may hold the application. What separates them is a recorded stop that is known to occur before the
 * click, which is what isManagedNoSubmitControl and managedSubmitVerdict's 'not_attempted' arm
 * already mean. This function adds no new classification of its own; it asks the two that exist.
 *
 * The five refusals below are each a case where something may have reached the employer, and the
 * security_code one is the least obvious and the most important: a retained code wall is the
 * employer's own record that an application arrived and is parked at verification, and it stays true
 * even when THIS run never pressed anything. See delayedSecurityCodeHandoffReview.
 */
export function submissionProvablyNotSent(evidence: PreClickNoSendEvidence): boolean {
  if (evidence.submission_attempted_at) return false;
  if (evidence.receipt) return false;
  if (evidence.unverified_submission) return false;
  if (evidence.security_code) return false;
  // Checked ahead of the verdict rather than through it. managedSubmitVerdict believes a runner that
  // reports state 'not_attempted', and a result that says both 'not_attempted' and pressed:true is
  // contradicting itself about the one fact that matters here.
  if (readManagedSubmitOutcome(evidence)?.pressed === true) return false;
  const verdict = managedSubmitVerdict(evidence);
  if (verdict.kind === 'not_attempted') return true;
  // Any other reported verdict describes a click that landed, so it is not this function's case.
  if (verdict.kind !== 'unreported') return false;
  /* THE TYPED ANSWER FIRST, THE STRING MATCH ONLY AS THE FALLBACK IT ALWAYS WAS.
   *
   * The runner knows where it stopped at the moment it stops, and submission_stop is that knowledge
   * written down. Asking it here is what lets the sentence-matching line below eventually be
   * DELETED rather than have a second copy of itself grow beside it: once no row predating the field
   * is still open, this branch answers every case the string one does.
   *
   * before_click is not a licence on its own. It is read after the five evidence refusals above, so
   * a stop that provably preceded THIS run's click still cannot reopen a row that carries a receipt,
   * a standing code wall, an unresolved unverified record or a recorded attempt from an earlier one. */
  if (evidence.submission_stop?.before_click === true) return true;
  // No outcome was reported at all, and no typed stop was recorded, which is every row written
  // before submission_stop existed. The stored sentence is the only proof left, and it must name the
  // chooser that throws before the click.
  return isManagedNoSubmitControl(evidence.submission_error ?? '');
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
