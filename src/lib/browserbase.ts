import { chromium, type Browser, type Page } from 'playwright-core';
import { getVercelOidcToken } from '@vercel/oidc';
import { createHash, randomUUID } from 'node:crypto';
import {
  exactFinalSubmitChooserPolicy,
  FINAL_SUBMIT_CHOOSER_POLICY,
  FINAL_SUBMIT_CHOOSER_POLICY_V4,
  type FinalSubmitChooserPolicy,
} from './finalSubmitChooserPolicy';
import {
  readManagedFinalSubmitChooser,
  type ManagedFinalSubmitChooser,
} from './managedSubmitOutcome';
import { resolvedApprovedApplicationPageUrl, sortManagedPageUrlParams } from './workableApplicationUrl';

export type BrowserProvider = 'browserbase' | 'stratus' | 'stratus-managed';

export type ManagedSubmissionAttempt = {
  runId: string;
  claimId: string;
  executionId: string;
};

const MANAGED_SUBMISSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANAGED_TERMINAL_RESULT_ID = /^[a-f0-9]{64}$/;

function readManagedSubmissionAttempt(value: unknown): ManagedSubmissionAttempt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'claimId,executionId,runId'
    || typeof input.runId !== 'string' || !MANAGED_SUBMISSION_UUID.test(input.runId)
    || typeof input.claimId !== 'string' || !MANAGED_SUBMISSION_UUID.test(input.claimId)
    || typeof input.executionId !== 'string' || !MANAGED_SUBMISSION_UUID.test(input.executionId)) return null;
  return {
    runId: input.runId.toLowerCase(),
    claimId: input.claimId.toLowerCase(),
    executionId: input.executionId.toLowerCase(),
  };
}

function managedSubmissionAttempt(value: unknown, required: boolean): ManagedSubmissionAttempt | null {
  if (value == null && !required) return null;
  if (value == null) throw new Error('Managed Stratus submission attempt correlation is required');
  const normalized = readManagedSubmissionAttempt(value);
  if (!normalized) {
    throw new Error('Managed Stratus submission attempt correlation must contain only UUID runId, claimId, and executionId fields');
  }
  return normalized;
}

function sameManagedSubmissionAttempt(left: unknown, right: ManagedSubmissionAttempt): boolean {
  const normalized = readManagedSubmissionAttempt(left);
  return Boolean(normalized
    && normalized.runId === right.runId
    && normalized.claimId === right.claimId
    && normalized.executionId === right.executionId);
}

function assertManagedSubmissionAttemptEcho(result: ManagedBrowserResult, expected: ManagedSubmissionAttempt): void {
  if (!sameManagedSubmissionAttempt(result.submissionAttempt, expected)) {
    throw new Error('Managed browser result did not match its durable submission attempt');
  }
}

function managedTerminalResultId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !MANAGED_TERMINAL_RESULT_ID.test(value)) {
    throw new Error(`Managed Stratus ${label} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

/** Exact identifier of the durable terminal record referenced by a correlated synchronous run. */
export function managedBrowserTerminalResultId(result: ManagedBrowserResult): string {
  if (!result.terminalResult || typeof result.terminalResult !== 'object') {
    throw new Error('Managed Stratus synchronous result is missing its durable terminal result ID');
  }
  return managedTerminalResultId(result.terminalResult.resultId, 'terminal result ID');
}

export const MANAGED_SUBMIT_CHOOSER_POLICY = FINAL_SUBMIT_CHOOSER_POLICY;
/** Managed application v4 policy. Its caller gate is narrower than managed submissions generally. */
export const MANAGED_APPLICATION_SUBMIT_CHOOSER_POLICY = FINAL_SUBMIT_CHOOSER_POLICY_V4;
/** Stratus result capability that proves discovered controls include their live DOM role. */
export const MANAGED_DISCOVERY_ROLE_CAPABILITY = 'discovery-control-role-v1';
/**
 * Stratus runner capability for fail-closed selector uniqueness, exact digit assertions, and
 * three-sample stability reads. A `requireCapability` action makes an older Stratus reject the
 * whole request during action normalization, before it can execute any browser action.
 */
export const MANAGED_EXTRACT_ASSERTIONS_CAPABILITY = 'extract-assertions-v1';
/** The remote runner verifies the exact posting URL before any action and again at the submit click. */
export const MANAGED_EXACT_PAGE_URL_CAPABILITY = 'exact-page-url-v1';
/** Stratus v4 containment and form-binding capability for the measured native submit path. */
export const MANAGED_ATOMIC_SUBMIT_V4_CAPABILITY = 'atomic-submit-v4';
/**
 * Stratus result capability that proves an `extract` carrying `requireVisible` was answered by a
 * real layout read, one entry per match that is painting something, rather than by the ordinary
 * first-match attribute read.
 *
 * WHAT IT IS FOR, and what it is deliberately NOT for. A runner older than the field drops it during
 * normalization and answers under the same label with the same `{selector,label,value}` entry, so
 * nothing else in the payload distinguishes "filtered by layout" from "this runner never heard of
 * the question". This string is what makes the two legible, and the captcha contract test asserts
 * every emission carries it, so the field silently ceasing to be honoured is a red suite rather than
 * a quiet regression.
 *
 * NO PREDICATE BRANCHES ON IT, and that was tried and rejected rather than overlooked. The obvious
 * use is to refuse to let corroborateManagedCaptchaBlockers overrule the runner's CAPTCHA claim when
 * the evidence was never asked a layout question. It reads well and it is wrong: the only runners
 * that lack the capability are OLDER runners, and the further back one is, the worse the predicate
 * raising the claim. The guard would therefore be most active exactly where the claim it protects
 * deserves the least trust, and it broke three tests that encode a policy bought with fourteen
 * production stalls: an uncorroborated CAPTCHA verdict is dropped on an autonomous family, and a
 * claim backed by nothing is not believed on any family. The fix for a blind channel is to stop the
 * channel being blind, which is what `requireVisible` does.
 */
export const MANAGED_CAPTCHA_VISIBILITY_CAPABILITY = 'extract-require-visible-v1';

export type ManagedBrowserAction = {
  type: 'click' | 'fill' | 'fillByLabelText' | 'upload' | 'waitForSelector' | 'press' | 'select' | 'extract' | 'discover' | 'requireCapability' | 'confirmAndSubmit';
  selector?: string;
  value?: string;
  text?: string;
  label?: string;
  optional?: boolean;
  timeout?: number;
  attribute?: string;
  /** Selector-backed actions only. Refuse the action unless exactly one node matches. */
  requireUnique?: boolean;
  /** Extract only. Refuse the action when the live value is empty after trimming. */
  requireNonEmpty?: boolean;
  /** Extract only. Refuse the action unless the live value contains this exact text. */
  expectedValueIncludes?: string;
  /** Extract only. Refuse unless the live value's digits exactly equal this digit string. */
  expectedValueDigits?: string;
  /** Extract only. Require three passing reads spanning this bounded interval. */
  stabilityWindowMs?: number;
  /**
   * Extract only. Asks the runner for the attribute of every match that a person could actually see,
   * one entry per visible node in DOM order, instead of the first match's attribute whether or not
   * it has a box.
   *
   * A FIELD RATHER THAN A NEW ACTION TYPE, deliberately: the runner rejects an unknown action type
   * outright with a 400 that fails the entire run, and this repo cannot know which revision is
   * answering before it calls. An unknown field is dropped and the run proceeds on the older
   * reading, so the two services can deploy in either order without an outage. Whether the field was
   * honoured is read back from MANAGED_CAPTCHA_VISIBILITY_CAPABILITY, never assumed.
   */
  requireVisible?: boolean;
  file?: { name: string; mimeType: string; base64: string };
  /**
   * Only used by confirmAndSubmit. In contract v2 this one action owns both confirmation and the
   * authorized physical submit click, so no re-render can replace the proved node between actions.
   * The runner rescans required controls after the ordinary
   * fills, commits framework state on the affected controls, and may repeat that affected set this
   * many times. It must stop the action list when any field remains unresolved, so a later submit
   * click is unreachable. This is intentionally a single bounded action rather than one blind click
   * per field: the runner has the live DOM and can choose the exact label/control without spending
   * the application-wide action budget on speculative selectors.
   */
  maxRetries?: number;
  /** Versioned runner capability required by the atomic confirmAndSubmit action. */
  contractVersion?: 2;
  /** Distinguishes the employer application send from an emailed-code continuation send. */
  submitKind?: 'application' | 'verification';
  /** Shared semantic candidate policy. Runner must reject an unknown name or version. */
  chooserPolicy?: FinalSubmitChooserPolicy;
  /* The emailed code that finishes a Greenhouse submit, carried on the atomic action itself.
   *
   * On the click, and not as its own action, because the control it types into does not exist until
   * that click has happened - and because MANAGED_ACTION_LIMIT is 120, a real Greenhouse packet
   * already reconstructs to exactly 120, and an action added here would displace a field fill. The
   * runner does click, type, click and reports the outcome in securityCodeAttempt. */
  securityCode?: string;
  /** confirmAndSubmit only. Exact hash-free posting URL required at the two irreversible boundaries. */
  expectedPageUrl?: string;
  /** atomic-submit-v4 capability only. Durable selector for exactly one native application form. */
  applicationScopeSelector?: string;
};

// One entry per text-shaped custom question the 'discover' action found on the live page.
// Mirrors questionDiscovery.ts's DiscoveredQuestion so the managed and direct-Playwright paths
// hand the same shape to the same resolution code (see discoverAndResolveQuestions).
export type ManagedDiscoveredQuestion = {
  label: string;
  selector: string;
  // Stable group or widget selector emitted by newer managed runners. Choice controls can have a
  // unique name per option, so replay must be able to return to the semantic question container.
  durableSelector?: string | null;
  inputType: string;
  // The DOM role is distinct from inputType. Greenhouse React-selects are text inputs whose role
  // is combobox, while end-year--0 is a genuine text input. This optional wire field lets the
  // backend distinguish those controls without treating every text input or every --0 id as closed.
  // It remains optional during the runner rollout, and its absence never closes a dynamic control.
  role?: string | null;
  maxLength: number | null;
  // The managed provider's `discover` action does not report option lists and, as of 2026-08-08,
  // shows no sign of learning to: it enumerates text-shaped inputs and returns four fields per
  // control. Waiting for it was measured as the reason PR #361's option snapping never fired in
  // production. So this is filled in by THIS repo instead, from the discovery pass's own option
  // extracts (portalSubmission.ts: pushManagedReactSelectOptionProbeActions,
  // managedResultFieldOptions, attachManagedFieldOptions). Still optional, because the direct
  // Playwright path reads options straight off the Page and an unprobed control has none.
  options?: string[] | null;
  /** False means at least one employer option could not be retained exactly. */
  optionsComplete?: boolean;
  // Optional for the same reason as options: the managed provider does not report required-ness
  // yet. Until it does, discoveredFieldIsRequired reads the employer's own required marker out of
  // the raw label, which this provider DOES report, so the managed path is not left waiting on a
  // change in another service. When stratus starts sending the flag it is believed with no further
  // change here.
  required?: boolean;
};

export type ManagedBrowserResult = {
  title: string;
  url: string;
  text: string;
  /** Exact non-PII correlation echoed for every submit-capable run and continuation. */
  submissionAttempt?: ManagedSubmissionAttempt;
  /** Exact durable result reference, required on every correlated synchronous response. */
  terminalResult?: { resultId: string };
  screenshot?: string | null;
  filledFields?: string[];
  /**
   * Privacy-safe structural breadcrumbs for exact provider-owned question controls. The managed
   * runner emits only control ids, counts, booleans, and bounded outcome names. No applicant
   * answer, employer question text, option text, or page content is part of this contract.
   */
  actionDiagnostics?: Array<{
    controlId: string;
    locatorCount: number;
    targetResolved: boolean;
    targetVisible: boolean;
    targetTag: string;
    targetInChoiceShell: boolean;
    targetPlaceholderSignal: boolean;
    targetValuePlaceholderSignal: boolean;
    targetPseudoPlaceholderSignal: boolean;
    labelCount: number;
    labelledQuestionCount: number;
    locatorChoicePlaceholderCount: number;
    labelChoicePlaceholderCount: number;
    choicePeerCount: number;
    nearbyChoiceIndicator: boolean;
    route: string;
    choiceAttempted: boolean;
    choiceFilled: boolean;
    choiceLanded: boolean;
    choiceControlOpened: boolean;
    choiceUnreadable: boolean;
    choiceRefused: boolean;
    choiceStateKind: string;
    outcome: string;
  }>;
  blockers?: string[];
  skipped?: string[];
  discovered?: ManagedDiscoveredQuestion[];
  /** Additive runner features this exact result contract supports. Absence means unsupported. */
  capabilities?: string[];
  exactPageUrlProof?: {
    expected: string;
    beforeActions: string;
    beforeApplicantData: string;
    beforeFinalChooser?: string | null;
    beforeSubmit: string | null;
  };
  extracted?: Array<{
    selector: string;
    label?: string;
    value: string | null;
    /** Echoed only when the runner enforced this exact digit assertion on every stability read. */
    expectedValueDigits?: string;
  }>;
  continuationToken?: string;
  continuationExpiresAt?: string;
  /* The human check the page is holding the application behind, read off the CONTROL by the runner
   * at zero action cost. Greenhouse emails an 8-character code and renders a code field, and files
   * nothing until that code is entered and the form is sent again. See lib/securityCode.ts.
   *
   * Absent on a runner deployed before this shipped, which is the ordinary case during a rollout,
   * and absent means "not observed" and never "not present" - so nothing downstream may read its
   * absence as proof a form has no challenge. */
  humanVerification?: { kind: 'security_code'; fieldCount: number; sentTo: string | null; label?: string | null } | null;
  /* What happened to a code this run was given, or null when it was given none. */
  securityCodeAttempt?: {
    supplied: boolean;
    entered: boolean;
    resubmitted?: boolean;
    outcome: 'accepted' | 'rejected' | 'no_control' | 'not_entered';
  } | null;
  /* How many form submissions the runner's guard stopped. Zero on a run that was allowed to submit,
   * because the guard is not installed there. NON-ZERO ON A FILL RUN IS A DEFECT REPORT: something
   * in the action list tried to send a real application to a real employer with no authorization
   * behind it, which is exactly what happened to three packets on 2026-08-08. */
  blockedSubmits?: number;
  /* WHAT THE PAGE SAID AFTER THE SUBMIT CLICK, read by the runner off the state the ATS renders
   * rather than inferred here from scraped prose. See lib/managedSubmitOutcome.ts, which is the only
   * thing allowed to interpret it, and managed-browser.js's readSubmitOutcome, which produces it.
   *
   * Absent on a runner deployed before this shipped. Absent means "the run did not say", which is
   * different from every value it can take, and the reader degrades to the old body scrape rather
   * than to a wrong answer. */
  submitOutcome?: {
    pressed?: boolean;
    state?: 'confirmed' | 'rejected' | 'unknown' | 'not_attempted';
    source?: 'ats_state' | 'ats_route' | 'ats_state_unconfirmed' | 'live_region' | 'page_text' | null;
    evidence?: string | null;
    message?: string | null;
    formStillPresent?: boolean | null;
  } | null;
  /** Privacy-safe structural result from the managed final-control chooser. */
  finalSubmitChooser?: ManagedFinalSubmitChooser | null;
  /* Whether the run is holding a second phase open for a security-code continuation. The RUNNER
   * decides this, because it is the only party that has seen the page; the caller used to guess it
   * from a text sweep that reads an employer's own "check your email for confirmation" as a
   * challenge. */
  continuationOffered?: boolean;
  /**
   * Fail-closed proof emitted by confirmAndSubmit. One record is required for every required field
   * the runner inspected, including fields that were already committed. A runner that predates the
   * protocol returns no proof, which callers treat as unsupported and never as success.
   */
  requiredFieldConfirmation?: {
    version: 2;
    status: 'confirmed' | 'blocked';
    passes: Array<{
      submitKind: 'application' | 'verification';
      scope: {
        /* Which resolved scope the runner bound the submit to. 'form' is a real <form> ancestor;
         * 'container' is the nearest field-bearing ancestor on a formless page (Ashby's div#form).
         * Emitted by every runner since the submit-scope repair; absent only from older runners.
         * `null` is the UNBOUND scope described below: the runner resolved no scope at all. */
        scopeKind?: 'form' | 'container' | null;
        /* NULLABLE ONLY ON A PASS THAT BOUND NOTHING, and the runtime gate is what enforces that.
         *
         * managed-browser.js builds two SYNTHETIC passes at points where no scope was ever
         * fingerprinted - the caller-bound application form was unusable (15390), and the security
         * code controls did not retain the exact code (15458). Both carry a blockerReason naming a
         * refusal that PRECEDES any press, and both are the runner's way of saying "there was
         * nothing here to identify", which is a truthful report and not a malformed one.
         *
         * These fields stay loose here and strict in assertManagedRequiredFieldsConfirmed, which
         * admits the null combination only as one pinned shape and keeps every existing check for a
         * pass that DOES claim a bound scope. Read `unboundScopeProof` there for the whole rule; do
         * not infer from this type that a null fingerprint is acceptable anywhere else. */
        formFingerprint: string | null;
        submitFingerprint: string | null;
        formMatchCount: 0 | 1;
        submitMatchCount: 0 | 1;
        requiredControlCount: number;
        sameNode: boolean;
      };
      requiredControls: Array<{
        selector: string;
        label: string | null;
        fieldType: 'text' | 'date' | 'select' | 'react-select' | 'radio' | 'checkbox' | 'file' | 'custom';
        matchCount: 1;
      }>;
      attempts: Array<{
        selector: string;
        label: string | null;
        fieldType: 'text' | 'date' | 'select' | 'react-select' | 'radio' | 'checkbox' | 'file' | 'custom';
        outcome: 'already_committed' | 'confirmed' | 'failed';
        attemptCount: 1 | 2;
        reason?: string;
      }>;
      retries: number;
      unresolved: string[];
      submissionOutcome: 'clicked' | 'blocked';
      /* Mirrors MANAGED_BLOCKER_REASONS in portalSubmission.ts, which is the runtime gate and the
       * list the runner is pinned against. Kept as a union so a reason this service reads by name
       * is a compile error when it is not a reason the runner can emit. Add, never remove. */
      blockerReason?:
        // Chooser and scope binding: the control this run bound is not the control it would press.
        | 'submit_node_replaced' // the bound submit element was replaced before the press
        | 'ambiguous_submit' // more than one control tied for final submit (v3 chooser outcome)
        | 'form_identity_changed' // the bound form's identity changed between scan and press
        | 'no_submit_control' // no submit control was selected at all (v3 chooser outcome)
        | 'submit_chooser_changed' // the chooser's selection changed between scan and press
        // Caller-supplied values: what was confirmed is no longer what would be sent.
        | 'successful_address_changed' // a confirmed application value or file changed after confirmation
        | 'security_code_binding_changed' // the verification code's bound control changed before the press
        | 'security_code_payload_unaddressed' // the exact code reached no successful native payload control
        // Application scope: the caller-bound form was unusable at submit time.
        | 'application_scope_missing' // the bound application form was not found
        | 'application_scope_ambiguous' // the scope selector matched more than one form
        | 'application_scope_not_form' // the bound scope resolved to a node that is not a form
        | 'application_scope_detached' // the bound scope left the document before the press
        | 'application_scope_unavailable' // the scope could not be read at all
        // Transport binding, before the press: the exact native request could not be pinned.
        | 'submit_payload_unverifiable' // the native submit transport or payload could not be bound
        | 'submit_transport_unsupported' // the form's method, target or enctype is outside atomic submit v4
        | 'submit_transport_unpinned' // the page attempted an unbound network transport
        | 'submit_transport_guard_unavailable' // the transport gate could not be armed or authorized
        // Activation guard, while arming: the submit-time binding could not be fixed.
        | 'submit_activation_guard_unavailable' // the submit-time binding guard could not be armed
        | 'submit_activation_binding_changed' // the binding fingerprint changed before arming completed
        // Activation witnesses, during the press: the press was not the one that was authorized.
        | 'submit_binding_changed_during_activation' // the gate blocked without naming a narrower reason
        | 'submit_click_failed' // the press itself threw
        | 'submit_identity_changed' // the bound form or submitter identity changed mid-activation
        | 'protected_surface_mutated' // a protected node was mutated during activation
        | 'submit_activation_unobserved' // the guard produced no verdict for the activation
        | 'submit_event_unobserved' // no submit event was seen
        | 'submit_event_canceled' // the submit event was default-prevented
        | 'submit_document_bubble_missing' // the submit event never bubbled to the document
        | 'submit_window_bubble_missing' // the submit event never bubbled to the window
        | 'submit_bubble_witness_missing' // a required bubble witness was missing at finalize
        | 'submit_formdata_unobserved' // no formdata event accompanied the submit
        | 'post_click_binding_changed' // the binding no longer matched after the click
        // Native request matching, after the press: the observed request is not the bound one.
        | 'submit_request_unobserved' // no native document request followed the press
        | 'submit_multiple_native_requests' // more than one native document request followed the press
        | 'submit_method_changed' // the observed request's method differed from the bound one
        | 'submit_destination_changed' // the observed request's URL differed from the bound one
        | 'submit_enctype_changed' // the observed request's enctype differed from the bound one
        | 'submit_payload_changed' // the observed request's payload differed from the bound one
        | 'submit_transport_release_failed'; // the matched request could not be released to the network
    }>;
  } | null;
};

export type ManagedBrowserRunProgress = {
  version: 1;
  phase: 0 | 1;
  stage: 'launch' | 'phase_started' | 'submit_activation_started'
    | 'submit_blocked' | 'submit_released' | 'result_ready' | 'result_written';
  submitPressed: boolean;
  applicationSubmitPressed: boolean;
  verificationSubmitPressed: boolean;
  submitKind: 'application' | 'verification' | null;
  policyVersion: 3 | 4 | null;
  employerOutcome?: {
    kind: 'not_attempted' | 'pressed' | 'confirmed';
    state: 'confirmed' | 'rejected' | 'unknown' | 'not_attempted';
    source: 'ats_state' | 'ats_route' | 'ats_state_unconfirmed' | 'live_region'
      | 'page_text' | 'unmatched_page_text' | 'client_validation' | null;
    evidence: string | null;
    message: string | null;
    formStillPresent: boolean | null;
  };
  requiredFieldConfirmationStatus?: 'confirmed' | 'blocked';
  securityCodeOutcome?: 'accepted' | 'rejected' | 'no_control' | 'not_entered';
  submissionAttempt?: ManagedSubmissionAttempt;
};

type ManagedBrowserError = string | {
  message?: string;
  code?: string;
  runProgress?: unknown;
};

/**
 * A chooser-v4 sandbox crash whose last durable checkpoint proves the employer transport was still
 * contained. Only this typed error may turn a provider crash into a retryable pre-submit stop.
 */
export class ManagedBrowserPreSubmitCrashError extends Error {
  readonly code = 'SANDBOX_RUN_FAILED';
  readonly runProgress: ManagedBrowserRunProgress;

  constructor(message: string, runProgress: ManagedBrowserRunProgress) {
    super(message);
    this.name = 'ManagedBrowserPreSubmitCrashError';
    this.runProgress = runProgress;
  }
}

/* A DETERMINISTIC RUNNER ASSERTION REFUSAL, told apart from a sandbox crash BY ITS OWN SENTENCE.
 *
 * The runner reports a failed required extract assertion through the same SANDBOX_RUN_FAILED code a
 * genuine crash uses, so until now a `filled_field:phone: expected exactly one match for ..., found
 * 0` with durable chooser-v4 containment progress was typed ManagedBrowserPreSubmitCrashError,
 * retried once by runWithManagedPreSubmitCrashRetry, and finally told the applicant Litos had hit
 * "a temporary secure-browser error ... try this one again in a few minutes". Measured five times
 * on Workable's phone readback (fdcf4ccb, 8c81e9ad and the three before them): the refusal is the
 * assertion doing its fail-closed job on a page whose DOM no longer matches the proof selector, it
 * reproduces on every attempt, and nothing about it is temporary. The retry costs a full sandbox
 * run and the sentence costs the trust to believe the next real transient.
 *
 * Matched on the runner's exact uniqueness-refusal shape and nothing looser. requireNonEmpty and
 * digit refusals keep today's typing until their live wording has been measured, because a wrong
 * match here converts a crash into a non-retryable stop, and that is the direction that must not
 * be guessed in.
 */
const MANAGED_ASSERTION_REFUSAL_RE =
  /(?:^|[\s;])(?:([A-Za-z0-9_.:-]+): )?expected exactly one match for .{1,600}, found \d+/;

/** The deterministic assertion refusal inside a runner error message, or null when it is not one. */
export function managedDeterministicAssertionRefusal(message: string): { label: string | null } | null {
  const match = message.match(MANAGED_ASSERTION_REFUSAL_RE);
  if (!match) return null;
  return { label: match[1] ?? null };
}

/**
 * A required extract assertion the runner refused, on a run whose durable chooser-v4 progress
 * proves the employer transport was still contained. Deliberately NOT a subclass of
 * ManagedBrowserPreSubmitCrashError: the crash retry helper must not spend a second sandbox run
 * reproducing a deterministic refusal, and the applicant sentence must stop calling it temporary.
 */
export class ManagedBrowserAssertionFailureError extends Error {
  readonly code = 'SANDBOX_RUN_FAILED';
  readonly runProgress: ManagedBrowserRunProgress;
  /** The failing action's label as the runner spelled it, e.g. `filled_field:phone`. */
  readonly assertionLabel: string | null;

  constructor(message: string, runProgress: ManagedBrowserRunProgress, assertionLabel: string | null) {
    super(message);
    this.name = 'ManagedBrowserAssertionFailureError';
    this.runProgress = runProgress;
    this.assertionLabel = assertionLabel;
  }

  /** Appends bounded, redacted structural evidence so submission_error carries the diagnosis. */
  attachEvidence(evidence: string) {
    this.message = `${this.message}; ${evidence}`;
  }
}

/** Correlated provider progress that crossed or resolved an employer boundary before its response. */
export class ManagedBrowserProviderProgressError extends Error {
  readonly code: string;
  readonly runProgress: ManagedBrowserRunProgress;

  constructor(message: string, code: string, runProgress: ManagedBrowserRunProgress) {
    super(message);
    this.name = 'ManagedBrowserProviderProgressError';
    this.code = code;
    this.runProgress = runProgress;
  }
}

export type ManagedPreSubmitCrashRetryResult<T> =
  | { kind: 'completed'; result: T; retried: boolean }
  | { kind: 'authorization_revoked'; error: ManagedBrowserPreSubmitCrashError };

/**
 * Retry one chooser-v4 crash only when Stratus proved the application submit transport was still
 * contained. The caller owns the fresh authorization read because revocation between sandboxes
 * must stop the retry. A second crash or any untyped failure escapes unchanged, so this helper can
 * never turn an uncertain click into another employer transmission.
 */
export async function runWithManagedPreSubmitCrashRetry<T>(
  run: () => Promise<T>,
  retryAuthorized: () => Promise<boolean>,
): Promise<ManagedPreSubmitCrashRetryResult<T>> {
  try {
    return { kind: 'completed', result: await run(), retried: false };
  } catch (error) {
    if (!(error instanceof ManagedBrowserPreSubmitCrashError)) throw error;
    if (!managedBrowserProgressAllowsPreSubmitRetry(error.runProgress)) {
      throw new Error(error.message);
    }
    if (!await retryAuthorized()) return { kind: 'authorization_revoked', error };
    return { kind: 'completed', result: await run(), retried: true };
  }
}

type ManagedBrowserEmployerOutcome = NonNullable<ManagedBrowserRunProgress['employerOutcome']>;

function exactManagedNotAttemptedOutcome(outcome: ManagedBrowserEmployerOutcome): boolean {
  return outcome.kind === 'not_attempted'
    && outcome.state === 'not_attempted'
    && outcome.source === null
    && outcome.evidence === null
    && outcome.message === null
    && outcome.formStillPresent === null;
}

function managedBrowserProgressStateIsConsistent(progress: ManagedBrowserRunProgress): boolean {
  const applicationPressed = progress.applicationSubmitPressed;
  const verificationPressed = progress.verificationSubmitPressed;
  const anyPressed = applicationPressed || verificationPressed;
  const finalProgress = progress.stage === 'result_ready' || progress.stage === 'result_written';
  const activationProgress = progress.stage === 'submit_activation_started'
    || progress.stage === 'submit_blocked';
  const currentKindPressed = progress.submitKind === 'application'
    ? applicationPressed
    : progress.submitKind === 'verification'
      ? verificationPressed
      : false;

  if (progress.submitPressed !== anyPressed) return false;
  if (anyPressed && progress.submitKind === null) return false;
  if (progress.phase === 0
    && (verificationPressed || progress.submitKind === 'verification')) return false;
  if (verificationPressed
    && (progress.phase !== 1 || progress.submitKind !== 'verification')) return false;
  if (progress.phase === 1 && progress.submitKind === 'application'
    && (activationProgress || progress.stage === 'submit_released')) return false;

  if (progress.stage === 'launch') {
    if (progress.phase !== 0 || progress.submitKind !== null || anyPressed
      || progress.policyVersion !== null || progress.employerOutcome
      || progress.requiredFieldConfirmationStatus || progress.securityCodeOutcome) return false;
  } else if (progress.stage === 'phase_started') {
    if (progress.phase === 0 && anyPressed) return false;
  } else if (activationProgress) {
    if (progress.submitKind === null || currentKindPressed || progress.securityCodeOutcome) return false;
  } else if (progress.stage === 'submit_released') {
    if (progress.submitKind === null || !currentKindPressed || progress.securityCodeOutcome) return false;
  }

  const outcome = progress.employerOutcome;
  if (finalProgress && !outcome) return false;
  if (!finalProgress && progress.phase === 0 && outcome
    && !exactManagedNotAttemptedOutcome(outcome)) return false;
  if (outcome) {
    if (outcome.kind === 'not_attempted') {
      if (!exactManagedNotAttemptedOutcome(outcome) || anyPressed) return false;
    } else if (!anyPressed || outcome.state === 'not_attempted') {
      return false;
    }
    if (outcome.kind === 'confirmed'
      && progress.requiredFieldConfirmationStatus !== 'confirmed') return false;
  }

  if (progress.requiredFieldConfirmationStatus === 'confirmed' && !anyPressed) return false;
  if (progress.securityCodeOutcome) {
    if (!finalProgress || progress.phase !== 1 || progress.submitKind !== 'verification') return false;
    const reachedEmployer = progress.securityCodeOutcome === 'accepted'
      || progress.securityCodeOutcome === 'rejected';
    if (reachedEmployer !== verificationPressed) return false;
    if (progress.securityCodeOutcome === 'accepted' && outcome?.state === 'rejected') return false;
  }
  return true;
}

function managedBrowserProgressAllowsPreSubmitRetry(progress: ManagedBrowserRunProgress): boolean {
  return managedBrowserProgressStateIsConsistent(progress)
    && progress.phase === 0
    && progress.policyVersion === 4
    && progress.submitKind === 'application'
    && (progress.stage === 'phase_started' || progress.stage === 'submit_blocked')
    && progress.submitPressed === false
    && progress.applicationSubmitPressed === false
    && progress.verificationSubmitPressed === false
    && (!progress.employerOutcome || exactManagedNotAttemptedOutcome(progress.employerOutcome));
}

function managedBrowserRunProgress(
  value: unknown,
  expectedSubmissionAttempt: ManagedSubmissionAttempt | null,
): ManagedBrowserRunProgress | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const stages = new Set([
    'launch', 'phase_started', 'submit_activation_started',
    'submit_blocked', 'submit_released', 'result_ready', 'result_written',
  ]);
  const rawEmployerOutcome = input.employerOutcome;
  const employerOutcome = (() => {
    if (rawEmployerOutcome == null) return null;
    if (typeof rawEmployerOutcome !== 'object' || Array.isArray(rawEmployerOutcome)) return undefined;
    const outcome = rawEmployerOutcome as Record<string, unknown>;
    if (Object.keys(outcome).sort().join(',') !== 'evidence,formStillPresent,kind,message,source,state') return undefined;
    const kinds = new Set(['not_attempted', 'pressed', 'confirmed']);
    const states = new Set(['confirmed', 'rejected', 'unknown', 'not_attempted']);
    const sources = new Set([
      'ats_state', 'ats_route', 'ats_state_unconfirmed', 'live_region', 'page_text',
      'unmatched_page_text', 'client_validation',
    ]);
    const boundedNullableString = (entry: unknown) => entry === null
      || (typeof entry === 'string' && entry.length <= 500);
    if (typeof outcome.kind !== 'string' || !kinds.has(outcome.kind)
      || typeof outcome.state !== 'string' || !states.has(outcome.state)
      || (outcome.source !== null && (typeof outcome.source !== 'string' || !sources.has(outcome.source)))
      || !boundedNullableString(outcome.evidence)
      || !boundedNullableString(outcome.message)
      || (outcome.formStillPresent !== null && typeof outcome.formStillPresent !== 'boolean')
      || (outcome.kind === 'confirmed' && outcome.state !== 'confirmed')
      || (outcome.kind === 'not_attempted' && outcome.state !== 'not_attempted')) return undefined;
    return outcome as ManagedBrowserRunProgress['employerOutcome'];
  })();
  const finalProgress = input.stage === 'result_ready' || input.stage === 'result_written';
  if (input.version !== 1
    || (input.phase !== 0 && input.phase !== 1)
    || typeof input.stage !== 'string' || !stages.has(input.stage)
    || typeof input.submitPressed !== 'boolean'
    || typeof input.applicationSubmitPressed !== 'boolean'
    || typeof input.verificationSubmitPressed !== 'boolean'
    || (input.submitKind !== null && input.submitKind !== 'application' && input.submitKind !== 'verification')
    || (input.policyVersion !== null && input.policyVersion !== 3 && input.policyVersion !== 4)
    || employerOutcome === undefined
    || (finalProgress && !employerOutcome)
    || (input.requiredFieldConfirmationStatus != null
      && input.requiredFieldConfirmationStatus !== 'confirmed'
      && input.requiredFieldConfirmationStatus !== 'blocked')
    || (input.securityCodeOutcome != null
      && input.securityCodeOutcome !== 'accepted'
      && input.securityCodeOutcome !== 'rejected'
      && input.securityCodeOutcome !== 'no_control'
      && input.securityCodeOutcome !== 'not_entered')
    || (expectedSubmissionAttempt != null
      && !sameManagedSubmissionAttempt(input.submissionAttempt, expectedSubmissionAttempt))) return null;
  const progressAttempt = readManagedSubmissionAttempt(input.submissionAttempt);
  const progress = {
    version: 1,
    phase: input.phase,
    stage: input.stage,
    submitPressed: input.submitPressed,
    applicationSubmitPressed: input.applicationSubmitPressed,
    verificationSubmitPressed: input.verificationSubmitPressed,
    submitKind: input.submitKind,
    policyVersion: input.policyVersion,
    ...(employerOutcome ? { employerOutcome } : {}),
    ...(input.requiredFieldConfirmationStatus != null
      ? { requiredFieldConfirmationStatus: input.requiredFieldConfirmationStatus }
      : {}),
    ...(input.securityCodeOutcome != null ? { securityCodeOutcome: input.securityCodeOutcome } : {}),
    ...(progressAttempt ? { submissionAttempt: progressAttempt } : {}),
  } as ManagedBrowserRunProgress;
  return managedBrowserProgressStateIsConsistent(progress) ? progress : null;
}

function managedBrowserRequestError(
  error: ManagedBrowserError | undefined,
  status: number,
  actions: ManagedBrowserAction[] = [],
  expectedSubmissionAttempt: ManagedSubmissionAttempt | null = null,
): Error {
  const message = managedBrowserErrorMessage(error, status, actions);
  if (error && typeof error === 'object' && typeof error.code === 'string') {
    const progress = managedBrowserRunProgress(error.runProgress, expectedSubmissionAttempt);
    const transportStillContained = expectedSubmissionAttempt != null
      && progress != null
      && managedBrowserProgressAllowsPreSubmitRetry(progress);
    if (progress && transportStillContained) {
      /* Same containment proof, different fact. A deterministic assertion refusal under this exact
       * progress is the runner refusing to proceed past a failed required proof, not the sandbox
       * dying, so it must neither be retried as a crash nor described as temporary. */
      const assertion = managedDeterministicAssertionRefusal(message);
      if (assertion) {
        return new ManagedBrowserAssertionFailureError(message, progress, assertion.label);
      }
      return new ManagedBrowserPreSubmitCrashError(message, progress);
    }
    if (progress) return new ManagedBrowserProviderProgressError(message, error.code, progress);
  }
  return new Error(message);
}

function managedBrowserErrorMessage(
  error: ManagedBrowserError | undefined,
  status: number,
  actions: ManagedBrowserAction[] = [],
): string {
  const message = typeof error === 'string' && error.trim()
    ? error
    : error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()
      ? error.message
      : `Stratus managed browser request failed with status ${status}`;
  if (!/selector/i.test(message)) return message;
  return `${message}; action_audit=${managedActionAudit(actions)}`;
}

export type SessionResponse = {
  id: string;
  connectUrl?: string;
  connect_url?: string;
  status?: string;
  userMetadata?: Record<string, string>;
};

const STRATUS_SELECTOR_MAX_LENGTH = 500;

function stratusAction(action: ManagedBrowserAction): ManagedBrowserAction {
  if (action.type !== 'requireCapability' && action.applicationScopeSelector !== undefined) {
    throw new Error('Managed application scope selector requires the atomic submit v4 capability');
  }
  if (action.type === 'requireCapability') {
    if (action.value !== MANAGED_EXTRACT_ASSERTIONS_CAPABILITY
      && action.value !== MANAGED_EXACT_PAGE_URL_CAPABILITY
      && action.value !== MANAGED_ATOMIC_SUBMIT_V4_CAPABILITY) {
      throw new Error('Managed Stratus runner capability requirement is invalid');
    }
    let normalized = action;
    if (action.applicationScopeSelector !== undefined) {
      if (action.value !== MANAGED_ATOMIC_SUBMIT_V4_CAPABILITY) {
        throw new Error('Managed application scope selector requires the atomic submit v4 capability');
      }
      const applicationScopeSelector = action.applicationScopeSelector.trim();
      if (!applicationScopeSelector || applicationScopeSelector.length > STRATUS_SELECTOR_MAX_LENGTH) {
        throw new Error('Managed application scope selector is invalid');
      }
      normalized = { ...normalized, applicationScopeSelector };
    }
    if (action.expectedPageUrl !== undefined) {
      if (action.value !== MANAGED_EXACT_PAGE_URL_CAPABILITY) {
        throw new Error('Managed employer page URL requires the exact page URL capability');
      }
      const expectedPageUrl = new URL(action.expectedPageUrl);
      expectedPageUrl.hash = '';
      if (!/^https?:$/.test(expectedPageUrl.protocol)) {
        throw new Error('Managed employer page URL must use HTTP or HTTPS');
      }
      return { ...normalized, expectedPageUrl: expectedPageUrl.href };
    }
    return normalized;
  }
  if (action.type === 'discover' && !action.selector?.trim()) {
    return { ...action, selector: 'body' };
  }
  if (action.type === 'fillByLabelText') {
    if (!action.text?.trim()) return action;
    return { ...action, selector: action.selector?.trim() || 'body' };
  }
  if (action.type === 'confirmAndSubmit') {
    if (action.contractVersion !== 2) throw new Error('Managed required-field confirmation contract version is invalid');
    if (action.maxRetries !== 0 && action.maxRetries !== 1) {
      throw new Error('Managed required-field confirmation maxRetries must be 0 or 1');
    }
    if (!exactFinalSubmitChooserPolicy(action.chooserPolicy)) {
      throw new Error('Managed final-submit chooser policy is invalid');
    }
    if (action.expectedPageUrl !== undefined) {
      const expectedPageUrl = new URL(action.expectedPageUrl);
      expectedPageUrl.hash = '';
      if (!/^https?:$/.test(expectedPageUrl.protocol)) {
        throw new Error('Managed employer page URL must use HTTP or HTTPS');
      }
      return { ...action, expectedPageUrl: expectedPageUrl.href };
    }
    return action;
  }
  return action;
}

function invalidSelectorReason(action: ManagedBrowserAction): string | undefined {
  if (action.type === 'confirmAndSubmit' || action.type === 'requireCapability') return undefined;
  const selector = action.selector?.trim();
  if (!selector) return 'empty';
  if (selector.length > STRATUS_SELECTOR_MAX_LENGTH) return 'too_long';
  return undefined;
}

function normalizeStratusActions(actions: ManagedBrowserAction[]): ManagedBrowserAction[] {
  const outbound: ManagedBrowserAction[] = [];
  const invalidRequired: ManagedBrowserAction[] = [];
  for (const action of actions.map(stratusAction)) {
    const reason = invalidSelectorReason(action);
    if (!reason) {
      outbound.push(action);
      continue;
    }
    const audited = { ...action, label: action.label ? `${action.label}:${reason}` : reason };
    if (action.optional) continue;
    invalidRequired.push(audited);
  }
  if (invalidRequired.length > 0) {
    throw new Error(`Managed Stratus action has an invalid selector; action_audit=${managedActionAudit(invalidRequired)}`);
  }
  const exactPageUrlActions = outbound.filter((action) => action.type === 'requireCapability'
    && action.value === MANAGED_EXACT_PAGE_URL_CAPABILITY);
  const atomicSubmitV4Actions = outbound.filter((action) => action.type === 'requireCapability'
    && action.value === MANAGED_ATOMIC_SUBMIT_V4_CAPABILITY);
  const v4SubmitActions = outbound.filter((action) => action.type === 'confirmAndSubmit'
    && action.chooserPolicy?.version === 4);
  if (atomicSubmitV4Actions.length > 0 && v4SubmitActions.length === 0) {
    throw new Error('Managed atomic submit v4 capability requires a chooser v4 submit');
  }
  for (const action of outbound) {
    if (action.type !== 'confirmAndSubmit' || action.chooserPolicy?.version !== 4) continue;
    const exactPageUrlAction = exactPageUrlActions[0];
    if (!action.expectedPageUrl || exactPageUrlActions.length !== 1
      || exactPageUrlAction?.optional !== false
      || exactPageUrlAction.expectedPageUrl !== action.expectedPageUrl) {
      throw new Error('Managed final-submit chooser policy v4 requires an exact employer page URL boundary');
    }
    const atomicSubmitV4Action = atomicSubmitV4Actions[0];
    if (atomicSubmitV4Actions.length !== 1
      || atomicSubmitV4Action?.optional !== false
      || !atomicSubmitV4Action.applicationScopeSelector) {
      throw new Error('Managed final-submit chooser policy v4 requires one exact application form boundary');
    }
  }
  return outbound;
}

function assertRequiredManagedCapabilities(
  result: ManagedBrowserResult,
  actions: readonly ManagedBrowserAction[],
) {
  const required = [...new Set(actions
    .filter((action) => action.type === 'requireCapability')
    .map((action) => action.value)
    .filter((value): value is string => Boolean(value)))];
  const missing = required.filter((capability) => !result.capabilities?.includes(capability));
  if (missing.length > 0) {
    throw new Error(`Managed Stratus result did not advertise required runner capability: ${missing.join(', ')}`);
  }
  if (required.includes(MANAGED_EXACT_PAGE_URL_CAPABILITY)) {
    const expected = actions.find((action) => action.expectedPageUrl)?.expectedPageUrl;
    const canonicalExpected = expected ? new URL(expected) : null;
    if (canonicalExpected) {
      canonicalExpected.hash = '';
      sortManagedPageUrlParams(canonicalExpected);
    }
    const proof = result.exactPageUrlProof;
    const v4ChooserAction = actions.find((action) => action.type === 'confirmAndSubmit'
      && action.chooserPolicy?.version === 4);
    const chooserReported = result.finalSubmitChooser !== undefined && result.finalSubmitChooser !== null;
    const resolvedBoundary = canonicalExpected && typeof proof?.beforeActions === 'string'
      ? resolvedApprovedApplicationPageUrl(canonicalExpected, proof.beforeActions)
      : null;
    if (!canonicalExpected || proof?.expected !== canonicalExpected.href
      || !resolvedBoundary
      || proof.beforeApplicantData !== resolvedBoundary
      || (chooserReported && proof.beforeFinalChooser !== resolvedBoundary)
      || (result.submitOutcome?.pressed === true && proof.beforeSubmit !== resolvedBoundary)) {
      throw new Error('Managed Stratus result did not prove the exact employer page URL boundaries');
    }
    if (v4ChooserAction) {
      const chooser = readManagedFinalSubmitChooser(
        result,
        v4ChooserAction.chooserPolicy!,
        v4ChooserAction.submitKind!,
      );
      if (chooserReported ? !chooser : result.humanVerification?.kind !== 'security_code') {
        throw new Error('Managed Stratus result did not prove the final-submit chooser outcome');
      }
    }
  }
}

export function managedActionsWithExactPageUrl(
  actions: readonly ManagedBrowserAction[],
  expectedPageUrl: string,
): ManagedBrowserAction[] {
  const expected = new URL(expectedPageUrl);
  expected.hash = '';
  if (!/^https?:$/.test(expected.protocol)) throw new Error('Managed employer page URL must use HTTP or HTTPS');
  return [
    {
      type: 'requireCapability',
      value: MANAGED_EXACT_PAGE_URL_CAPABILITY,
      optional: false,
      expectedPageUrl: expected.href,
    },
    ...actions.map((action) => action.type === 'confirmAndSubmit'
      ? { ...action, expectedPageUrl: expected.href }
      : { ...action }),
  ];
}

function preview(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

function managedActionAudit(actions: ManagedBrowserAction[]): string {
  const selectorless = actions
    .filter((action) => !action.selector?.trim())
    .slice(0, 5)
    .map((action) => ({ type: action.type, label: preview(action.label), text: preview(action.text) }));
  const tooLong = actions
    .filter((action) => (action.selector?.length ?? 0) > STRATUS_SELECTOR_MAX_LENGTH)
    .slice(0, 5)
    .map((action) => ({
      type: action.type,
      label: preview(action.label),
      length: action.selector?.length ?? 0,
      selector: preview(action.selector),
    }));
  const maxSelectors = actions
    .filter((action) => action.selector?.trim())
    .map((action) => ({
      type: action.type,
      label: preview(action.label),
      length: action.selector?.length ?? 0,
      selector: preview(action.selector),
    }))
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  const applicationScopes = actions
    .filter((action) => action.applicationScopeSelector?.trim())
    .map((action) => ({
      type: action.type,
      capability: preview(action.value),
      optional: action.optional,
      length: action.applicationScopeSelector?.length ?? 0,
      selector: preview(action.applicationScopeSelector),
    }));
  const typeCounts = actions.reduce<Record<string, number>>((counts, action) => {
    counts[action.type] = (counts[action.type] ?? 0) + 1;
    return counts;
  }, {});
  return JSON.stringify({
    count: actions.length,
    typeCounts,
    selectorless,
    tooLong,
    maxSelectors,
    applicationScopes,
  });
}

function config(providerOverride?: Exclude<BrowserProvider, 'stratus-managed'>) {
  const provider: BrowserProvider = providerOverride ?? (process.env.BROWSER_PROVIDER === 'stratus-managed'
    ? 'stratus-managed'
    : process.env.BROWSER_PROVIDER === 'stratus' || Boolean(process.env.STRATUS_BASE_URL)
      ? 'stratus'
      : 'browserbase');
  const apiKey = providerOverride === 'browserbase'
    ? process.env.BROWSERBASE_API_KEY ?? process.env.BROWSER_API_KEY
    : providerOverride === 'stratus'
      ? process.env.STRATUS_API_KEY ?? process.env.BROWSER_API_KEY
      : process.env.BROWSER_API_KEY
        ?? (provider !== 'browserbase' ? process.env.STRATUS_API_KEY : process.env.BROWSERBASE_API_KEY);
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  const stratusBaseUrl = process.env.STRATUS_BASE_URL?.replace(/\/$/, '');
  const apiRoot = ((providerOverride === 'browserbase'
    ? process.env.BROWSERBASE_API_ROOT
    : providerOverride === 'stratus'
      ? undefined
      : process.env.BROWSER_API_ROOT)
    ?? (provider === 'stratus' && stratusBaseUrl ? `${stratusBaseUrl}/v1` : 'https://api.browserbase.com/v1'))
    .replace(/\/$/, '');
  if (!apiKey) {
    throw new Error('Secure browser provider is not configured. Add BROWSER_API_KEY or the provider-specific API key.');
  }
  return { apiKey, projectId, provider, apiRoot };
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  options: { timeoutMs?: number; provider?: Exclude<BrowserProvider, 'stratus-managed'> } = {},
): Promise<T> {
  const { apiKey, apiRoot, provider } = config(options.provider);
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)) {
    throw new Error('Secure browser provider timeout must be between 1 ms and 60 seconds');
  }
  const response = await fetch(`${apiRoot}${path}`, {
    ...init,
    ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
    headers: {
      'Content-Type': 'application/json',
      [provider === 'stratus' ? 'X-Stratus-API-Key' : 'X-BB-API-Key']: apiKey,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new BrowserProviderRequestError(response.status);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export class BrowserProviderRequestError extends Error {
  constructor(readonly status: number) {
    super(`Secure browser provider request failed with status ${status}`);
    this.name = 'BrowserProviderRequestError';
  }
}

export function isBrowserbaseConfigured(): boolean {
  const provider: BrowserProvider = process.env.BROWSER_PROVIDER === 'stratus-managed'
    ? 'stratus-managed'
    : process.env.BROWSER_PROVIDER === 'stratus' || Boolean(process.env.STRATUS_BASE_URL)
      ? 'stratus'
      : 'browserbase';
  if (provider === 'stratus-managed') {
    return Boolean(
      process.env.STRATUS_BASE_URL?.trim()
      && (process.env.STRATUS_API_KEY?.trim()
        || process.env.VERCEL_OIDC_TOKEN?.trim()
        || process.env.VERCEL_ENV === 'production'),
    );
  }
  return Boolean(process.env.BROWSER_API_KEY
    ?? (provider === 'stratus' ? process.env.STRATUS_API_KEY : process.env.BROWSERBASE_API_KEY));
}

export function isManagedStratusProvider(): boolean {
  return process.env.BROWSER_PROVIDER === 'stratus-managed';
}

/** Secret-free identity for the browser runtime that will receive and replay employer data. */
export function browserDeliveryRuntimeIdentity(env: NodeJS.ProcessEnv = process.env): {
  provider: BrowserProvider;
  apiRoot: string | undefined;
  projectId: string | undefined;
} {
  const provider: BrowserProvider = env.BROWSER_PROVIDER === 'stratus-managed'
    ? 'stratus-managed'
    : env.BROWSER_PROVIDER === 'stratus' || Boolean(env.STRATUS_BASE_URL)
      ? 'stratus'
      : 'browserbase';
  const stratusBaseUrl = env.STRATUS_BASE_URL?.replace(/\/$/, '');
  const apiRoot = (env.BROWSER_API_ROOT
    ?? (provider === 'stratus' && stratusBaseUrl ? `${stratusBaseUrl}/v1` : 'https://api.browserbase.com/v1'))
    .replace(/\/$/, '');
  return {
    provider,
    apiRoot: provider === 'stratus-managed' ? stratusBaseUrl : apiRoot,
    projectId: provider === 'browserbase' ? env.BROWSERBASE_PROJECT_ID : undefined,
  };
}

export function managedContinuationFingerprint(token: string): string {
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(token)) throw new Error('Managed Stratus continuation token is invalid');
  return createHash('sha256').update(`stratus-managed-continuation-v1:${token}`).digest('hex').slice(0, 24);
}

/* THE OPTIONS FOR A MANAGED APPLICATION SUBMIT, IN ONE PLACE THAT CAN BE ARGUED WITH.
 *
 * They used to be an object literal buried in the runner, and one field of it was wrong on a false
 * premise for a whole deploy: continuationCheckpoint was set because "an ordinary unknown receipt
 * does not offer a continuation", which merged Stratus contradicts - its own pressedUnknown term
 * offers one already. Setting it anyway suppressed the 15 second receipt-observation cap AND made
 * continuationOffered true on confirmed, rejected and not_attempted outcomes, so keepAlive held a
 * sandbox open after every successful submission.
 *
 * Named and exported so the shape a real submit sends is a thing a test can hold, rather than a
 * literal that can only be grepped for.
 */
export function managedApplicationSubmitOptions(
  continuationTtlSeconds: number,
  submissionAttempt: ManagedSubmissionAttempt,
): {
  allowSubmit: true;
  requestContinuation: true;
  continuationTtlSeconds: number;
  submissionAttempt: ManagedSubmissionAttempt;
} {
  return {
    allowSubmit: true,
    requestContinuation: true,
    continuationTtlSeconds,
    submissionAttempt: managedSubmissionAttempt(submissionAttempt, true)!,
  };
}

/** Acquire a hosted service token inside the same deadline as the provider request. */
export async function acquireManagedStratusOidcAuthorization(
  signal: AbortSignal | undefined,
  acquireToken: () => Promise<string> = getVercelOidcToken,
): Promise<string> {
  signal?.throwIfAborted();
  if (!signal) return `Bearer ${await acquireToken()}`;
  return new Promise<string>((resolve, reject) => {
    const rejectForAbort = () => reject(signal.reason);
    signal.addEventListener('abort', rejectForAbort, { once: true });
    if (signal.aborted) rejectForAbort();
    Promise.resolve().then(acquireToken).then(
      (token) => {
        signal.removeEventListener('abort', rejectForAbort);
        if (signal.aborted) reject(signal.reason);
        else resolve(`Bearer ${token}`);
      },
      (error) => {
        signal.removeEventListener('abort', rejectForAbort);
        reject(error);
      },
    );
  });
}

export type ManagedBrowserRequestBudget = Readonly<{
  signal: AbortSignal;
  timeoutMs: number;
  startedAtMs: number;
}>;

function assertManagedBrowserTimeout(timeoutMs: number, label: string): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5 * 60 * 1000) {
    throw new Error(`${label} timeout must be between 1 ms and 5 minutes`);
  }
}

function managedProviderDeadline(value: string | undefined, required: boolean): string | undefined {
  if (value == null && !required) return undefined;
  if (value == null) throw new Error('Managed Stratus absolute provider deadline is required');
  const deadlineMs = Date.parse(value);
  if (!Number.isFinite(deadlineMs) || value !== new Date(deadlineMs).toISOString()) {
    throw new Error('Managed Stratus absolute provider deadline must be a canonical ISO timestamp');
  }
  if (deadlineMs <= Date.now()) throw new DOMException('Managed Stratus provider deadline expired', 'TimeoutError');
  return value;
}

function managedProviderRequestTimeoutMs(
  timeoutMs: number | undefined,
  providerDeadlineAt: string | undefined,
): number | undefined {
  const absoluteRemainingMs = providerDeadlineAt === undefined
    ? undefined
    : Math.floor(Date.parse(providerDeadlineAt) - Date.now());
  const effective = timeoutMs === undefined
    ? absoluteRemainingMs
    : absoluteRemainingMs === undefined
      ? timeoutMs
      : Math.min(timeoutMs, absoluteRemainingMs);
  if (effective !== undefined) assertManagedBrowserTimeout(effective, 'Managed Stratus request');
  return effective;
}

/** Start one provider-call budget before any locked gate or credential lookup. */
export function startManagedBrowserRequestBudget(timeoutMs: number): ManagedBrowserRequestBudget {
  assertManagedBrowserTimeout(timeoutMs, 'Managed Stratus request');
  return Object.freeze({
    signal: AbortSignal.timeout(timeoutMs),
    timeoutMs,
    startedAtMs: performance.now(),
  });
}

export function assertManagedBrowserRequestBudgetAtClock(
  budget: ManagedBrowserRequestBudget,
  providerDeadlineAt: string,
  minimumDispatchBudgetMs: number,
  clockNowMs = Date.now(),
): void {
  assertManagedBrowserTimeout(budget.timeoutMs, 'Managed Stratus request');
  if (!Number.isFinite(budget.startedAtMs) || budget.startedAtMs < 0) {
    throw new Error('Managed Stratus request budget start must be a monotonic timestamp');
  }
  if (!Number.isSafeInteger(minimumDispatchBudgetMs)
    || minimumDispatchBudgetMs <= 0
    || minimumDispatchBudgetMs > budget.timeoutMs) {
    throw new Error('Managed Stratus minimum dispatch budget must fit inside the request timeout');
  }
  const providerDeadlineMs = Date.parse(providerDeadlineAt);
  if (!Number.isFinite(providerDeadlineMs)
    || providerDeadlineAt !== new Date(providerDeadlineMs).toISOString()) {
    throw new Error('Managed Stratus provider deadline must be a canonical timestamp');
  }
  if (!Number.isFinite(clockNowMs)) {
    throw new Error('Managed Stratus dispatch clock must be a valid timestamp');
  }
  budget.signal.throwIfAborted();
  const remainingBudgetMs = Math.floor(budget.timeoutMs - Math.max(0, performance.now() - budget.startedAtMs));
  const remainingAbsoluteMs = Math.floor(providerDeadlineMs - clockNowMs);
  if (remainingBudgetMs < minimumDispatchBudgetMs || remainingAbsoluteMs < minimumDispatchBudgetMs) {
    throw new DOMException(
      'Managed Stratus continuation no longer has a safe provider dispatch window',
      'TimeoutError',
    );
  }
}

async function managedStratusAuthorization(signal?: AbortSignal): Promise<{
  baseUrl: string;
  headers: Record<string, string>;
}> {
  const baseUrl = process.env.STRATUS_BASE_URL?.replace(/\/$/, '');
  const apiKey = process.env.STRATUS_API_KEY?.trim();
  if (!baseUrl) throw new Error('Stratus managed browser is not configured');
  const authorization = !apiKey && (process.env.VERCEL_OIDC_TOKEN?.trim() || process.env.VERCEL_ENV === 'production')
    ? await acquireManagedStratusOidcAuthorization(signal)
    : undefined;
  if (!apiKey && !authorization) throw new Error('Stratus managed browser is not configured');
  return {
    baseUrl,
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'X-Stratus-API-Key': apiKey } : {}),
      ...(authorization ? { Authorization: authorization } : {}),
    },
  };
}

/**
 * Bounded lifetime of the ephemeral correlation a read scan carries. Stratus rejects a
 * providerDeadlineAt that does not leave a bounded employer-action window: it must sit strictly
 * inside (PROVIDER_RESPONSE_MARGIN_MS + PROVIDER_MINIMUM_SUBMIT_WINDOW_MS, MAX_PROVIDER_DEADLINE_MS],
 * i.e. more than 12s and at most 5min out. Four minutes is a generous ceiling for a discover-plus-probe
 * read of one form (well under stratus's own 270s run budget) and leaves a full minute of headroom
 * below the 300s maximum, so ordinary request latency or clock skew can never push it out of bounds.
 */
const MANAGED_READ_SCAN_DEADLINE_MS = 240_000;

/**
 * The employer-action window for a prepare-path fill or discovery run, and 280s is the LARGEST
 * VALUE STRATUS CAN ACTUALLY SERVICE, not a round number with headroom.
 *
 * These runs are bigger than a discover-plus-probe read: up to 120 actions including document
 * uploads, and stratus caps its own run execution at 270s (MANAGED_RUN_TIMEOUT_MS), so the 240s
 * read-scan window would abort a run stratus was still legitimately finishing. Widening it has an
 * upper bound that is easy to overshoot, because stratus derives TWO different clocks from the one
 * deadline we send:
 *
 *   sandbox action window = deadline - PROVIDER_RESPONSE_MARGIN_MS (10s)
 *   host wait for the result = min(MANAGED_RUN_TIMEOUT_MS 270s, deadline - PROVIDER_RETURN_MARGIN_MS)
 *
 * The host must outlast the sandbox, or a run that finishes inside its own window has its result
 * thrown away. That constraint is deadline - 10s <= 270s, i.e. 280s. At 290s the sandbox keeps
 * acting until the 280s mark while the host abandons the wait at 270s and returns 504
 * RUN_TIMED_OUT: a fill finishing in that band has already mutated the employer form, stratus
 * writes a valid result, and the packet fails on a generic timeout with the fill lost.
 *
 * 280s makes the sandbox window exactly stratus's own 270s budget, and leaves 20s against the 300s
 * provider maximum for latency and clock skew between this host and stratus.
 */
export const MANAGED_PREPARE_FILL_DEADLINE_MS = 280_000;

/**
 * The action types stratus classifies as read-only (its READ_ONLY_ACTIONS set). Every other action
 * type is a mutation of the employer page, and under stratus's correlation-required policy - the
 * DEFAULT policy; compat is an explicit rollout state - a mutating run without a submissionAttempt
 * is refused at the provider with SUBMISSION_ATTEMPT_REQUIRED. Keep this set in lockstep with
 * stratus-browser-cloud src/managed-browser.js.
 */
export const MANAGED_READ_ONLY_ACTION_TYPES: ReadonlySet<ManagedBrowserAction['type']> =
  new Set(['waitForSelector', 'extract', 'requireCapability', 'discover']);

/**
 * The correlation a prepare-path discovery or fill run launches with, in one place rather than as a
 * literal at each call site. Both runs mutate the employer form and neither can submit, so they
 * take the ephemeral scan pair at the widest window stratus can service.
 */
export const MANAGED_PREPARE_SCAN_OPTIONS = Object.freeze({
  scanCorrelation: true as const,
  scanDeadlineMs: MANAGED_PREPARE_FILL_DEADLINE_MS,
});

/**
 * The prepare-path FILL run, and only it: the same correlation as the discovery pass plus the
 * one thing the fill needs that discovery does not, a preview screenshot the host is willing to
 * wait for.
 *
 * The stratus runner publishes the terminal result first (the authority moment must not wait on
 * pixels) and captures the screenshot afterwards, so an immediate artifact read races the writer
 * and loses on any long page. Measured live 2026-09-01: two complete seven-question Breezy fills,
 * both failed here on "did not return a preview screenshot" while the capture was still rendering.
 * stratus-browser-cloud #137 adds an opt-in, bounded wait for exactly that race, keyed on the
 * literal `screenshotWait: true` and taken only for an unpressed result through clean absence; a
 * caller that does not say the word keeps the immediate single read. The fill is the one run whose
 * missing screenshot is fatal (submissionRunner throws on it), so it is the one run that asks.
 */
export const MANAGED_PREPARE_FILL_OPTIONS = Object.freeze({
  ...MANAGED_PREPARE_SCAN_OPTIONS,
  screenshotWait: true as const,
});

/**
 * The correlation a MUTATING READ SCAN carries, distinct in every way from a submission's durable
 * correlation. A submission derives its attempt from the durable submission-attempt ledger (a real
 * DB row bound to a packet) and sends allowSubmit; this is a fresh, throwaway UUID triple with no
 * ledger row, no allowSubmit, and no continuation. Its only job is to satisfy stratus's
 * correlation-required policy for the probe clicks (which classify as mutations) and to let stratus
 * echo it back so the result is provably the one this call asked for. It never mints a terminal
 * result, because a read scan is not a submission.
 */
export function managedReadScanCorrelation(
  nowMs: number = Date.now(),
  deadlineMs: number = MANAGED_READ_SCAN_DEADLINE_MS,
): {
  submissionAttempt: ManagedSubmissionAttempt;
  providerDeadlineAt: string;
} {
  return {
    submissionAttempt: {
      runId: randomUUID(),
      claimId: randomUUID(),
      executionId: randomUUID(),
    },
    providerDeadlineAt: new Date(nowMs + deadlineMs).toISOString(),
  };
}

// `screenshot` defaults to true because every existing caller wants the receipt image. The CAPTCHA
// probe does not: it reads one attribute and throws the result away, so a full-page PNG would be
// rendered, transferred and retained by the third-party runner for nothing.
export async function runManagedBrowser(
  portalUrl: string,
  actions: ManagedBrowserAction[],
  options: {
    screenshot?: boolean;
    /**
     * Ask stratus to wait (bounded, clean-absence only, never for a pressed result) for the
     * preview screenshot the runner captures after publishing its result. Sent only as the
     * literal true, which is the only value stratus honours; see MANAGED_PREPARE_FILL_OPTIONS.
     */
    screenshotWait?: boolean;
    allowSubmit?: boolean;
    requestContinuation?: boolean;
    continuationCheckpoint?: boolean;
    continuationTtlSeconds?: number;
    submissionAttempt?: ManagedSubmissionAttempt;
    providerDeadlineAt?: string;
    timeoutMs?: number;
    /**
     * Correlate this run as a NON-SUBMIT MUTATION: a run whose actions change the employer page
     * (option-probe clicks, a prepare-path fill of the form) but that never sends anything to the
     * employer - no allowSubmit, no final action, no continuation, all of which stratus enforces
     * server-side regardless of what the correlation claims. Under stratus correlationRequired, any
     * mutation needs a submissionAttempt and a providerDeadlineAt; this supplies a fresh ephemeral
     * pair (see managedReadScanCorrelation) so the mutations are accepted and bound to this exact
     * call, WITHOUT the submit-only durable-terminal-result assertion. The DURABLE attempt from the
     * submission ledger remains reserved for submit-capable runs (managedApplicationSubmitOptions):
     * an attempt row means "an employer may have been sent this packet", which is never true here.
     * It is a usage error to combine this with allowSubmit or requestContinuation: a run that can
     * submit must carry its durable attempt instead.
     */
    scanCorrelation?: boolean;
    /**
     * Employer-action window for the ephemeral scan pair, defaulting to the 240s read-scan window.
     * Prepare-path fill and discovery runs pass MANAGED_PREPARE_FILL_DEADLINE_MS because they can
     * legitimately run to stratus's own 270s budget. Only meaningful with scanCorrelation; minted at
     * dispatch time inside the account fence, so a lock wait never erodes the window.
     */
    scanDeadlineMs?: number;
  } = {},
): Promise<ManagedBrowserResult> {
  if (options.timeoutMs !== undefined) assertManagedBrowserTimeout(options.timeoutMs, 'Managed Stratus run');
  const submitCorrelated = options.allowSubmit === true || options.requestContinuation === true;
  const scanCorrelated = options.scanCorrelation === true;
  if (scanCorrelated && submitCorrelated) {
    throw new Error('A managed read-scan correlation cannot also release a submission or request a continuation');
  }
  if (options.scanDeadlineMs !== undefined) {
    if (!scanCorrelated) {
      throw new Error('A managed scan deadline is only meaningful on a scan-correlated run');
    }
    /* Range-checked here rather than left to the deadline minter, because every downstream refusal
     * describes the SYMPTOM. A zero or negative window (easy to reach from remaining-budget
     * arithmetic, since a default parameter only replaces undefined) mints an already-expired
     * deadline and throws a TimeoutError, which the discovery call site's .catch then files as a
     * provider failure - a configuration bug wearing a network bug's clothes. The bounds are
     * stratus's own: strictly more than PROVIDER_RESPONSE_MARGIN_MS + PROVIDER_MINIMUM_SUBMIT_WINDOW_MS
     * (12s) and at most MAX_PROVIDER_DEADLINE_MS (5min). */
    if (!Number.isSafeInteger(options.scanDeadlineMs)
      || options.scanDeadlineMs <= 12_000
      || options.scanDeadlineMs > 5 * 60 * 1000) {
      throw new Error('A managed scan deadline must be more than 12 seconds and at most 5 minutes');
    }
  }
  // A read scan mints its own ephemeral correlation unless the caller pinned an exact pair (tests do).
  const scanPair = scanCorrelated && (options.submissionAttempt == null || options.providerDeadlineAt == null)
    ? managedReadScanCorrelation(Date.now(), options.scanDeadlineMs)
    : null;
  const providerDeadlineAt = managedProviderDeadline(
    options.providerDeadlineAt ?? scanPair?.providerDeadlineAt,
    submitCorrelated || scanCorrelated,
  );
  const effectiveTimeoutMs = managedProviderRequestTimeoutMs(options.timeoutMs, providerDeadlineAt);
  const outboundActions = normalizeStratusActions(actions);
  /* THE GUARD THAT WOULD HAVE CAUGHT THE FIRST POST-CUTOVER MANAGED FILL, at home instead of in an
   * employer-facing run. Application e4b0420c (OpenAI, Ashby, 2026-09-01): the prepare-path fill
   * launched with no correlation at all, stratus's required mode refused it with
   * SUBMISSION_ATTEMPT_REQUIRED, and the packet failed fail-closed with a sentence about durable
   * attempts that no backend code had ever decided to omit - the launch site simply predated the
   * policy. Stratus classifies ANY mutating action as boundary-capable, not just submits, so the
   * question "does this run need correlation" is answerable right here from the outbound action
   * list. Refusing locally turns the next uncorrelated call site into a loud test failure rather
   * than a prod refusal, and spends neither an OIDC token nor a provider session on a run stratus
   * is certain to reject. Classified on the OUTBOUND list, after optional invalid-selector actions
   * are dropped, because that is the exact list stratus will classify. */
  const uncorrelatedMutation = !submitCorrelated && !scanCorrelated
    && outboundActions.find((action) => !MANAGED_READ_ONLY_ACTION_TYPES.has(action.type));
  if (uncorrelatedMutation) {
    throw new Error(
      'A managed run whose actions mutate the employer page requires a durable submission attempt '
      + `or a scan correlation; first mutating action: ${uncorrelatedMutation.type}`,
    );
  }
  const signal = effectiveTimeoutMs === undefined ? undefined : AbortSignal.timeout(effectiveTimeoutMs);
  const { baseUrl, headers } = await managedStratusAuthorization(signal);
  const expectedSubmissionAttempt = managedSubmissionAttempt(
    options.submissionAttempt ?? scanPair?.submissionAttempt,
    submitCorrelated || scanCorrelated,
  );
  const response = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers,
    ...(signal ? { signal } : {}),
    body: JSON.stringify({
      url: portalUrl,
      actions: outboundActions,
      screenshot: options.screenshot ?? true,
      ...(options.screenshotWait === true ? { screenshotWait: true } : {}),
      allowSubmit: options.allowSubmit === true,
      ...(expectedSubmissionAttempt ? { submissionAttempt: expectedSubmissionAttempt } : {}),
      ...(providerDeadlineAt ? { providerDeadlineAt } : {}),
      fullPage: true,
      waitUntil: 'domcontentloaded',
      ...(options.requestContinuation ? {
        requestContinuation: true,
        continuationCheckpoint: options.continuationCheckpoint === true,
        continuationTtlSeconds: Math.min(Math.max(options.continuationTtlSeconds ?? 120, 15), 180),
      } : {}),
    }),
  });
  const payload = await response.json().catch(() => ({})) as { run?: ManagedBrowserResult; error?: ManagedBrowserError };
  if (!response.ok || !payload.run) {
    throw managedBrowserRequestError(payload.error, response.status, outboundActions, expectedSubmissionAttempt);
  }
  // The echo binds the result to the exact correlation we sent, for a scan and a submit alike, so it
  // is always asserted when an attempt was sent. The durable terminal result ID, however, is a
  // submit-only concept: it identifies the immutable employer-submission receipt. A read scan mints
  // no such receipt (stratus runs it ephemerally), so asserting one here would fail a correct scan.
  if (expectedSubmissionAttempt) assertManagedSubmissionAttemptEcho(payload.run, expectedSubmissionAttempt);
  if (expectedSubmissionAttempt && !scanCorrelated) managedBrowserTerminalResultId(payload.run);
  assertRequiredManagedCapabilities(payload.run, outboundActions);
  return payload.run;
}

export async function continueManagedBrowser(
  continuationToken: string,
  actions: ManagedBrowserAction[],
  options: {
    screenshot?: boolean;
    submissionAttempt: ManagedSubmissionAttempt;
    timeoutMs?: number;
    requestBudget?: ManagedBrowserRequestBudget;
    providerDeadlineAt?: string;
    minimumDispatchBudgetMs?: number;
  },
): Promise<ManagedBrowserResult> {
  if (options.timeoutMs !== undefined) assertManagedBrowserTimeout(options.timeoutMs, 'Managed Stratus continuation');
  if (options.requestBudget && options.timeoutMs !== undefined) {
    throw new Error('Managed Stratus continuation must not restart a pre-existing request budget');
  }
  if (options.requestBudget) {
    if (!options.providerDeadlineAt || options.minimumDispatchBudgetMs === undefined) {
      throw new Error('Managed Stratus pre-gate request budget requires its provider deadline and minimum dispatch budget');
    }
    assertManagedBrowserRequestBudgetAtClock(
      options.requestBudget,
      options.providerDeadlineAt,
      options.minimumDispatchBudgetMs,
    );
  } else if (options.providerDeadlineAt !== undefined || options.minimumDispatchBudgetMs !== undefined) {
    throw new Error('Managed Stratus provider deadline requires a pre-gate request budget');
  }
  const signal = options.requestBudget?.signal
    ?? (options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs));
  const providerDeadlineAt = options.providerDeadlineAt
    ?? (options.timeoutMs !== undefined ? new Date(Date.now() + options.timeoutMs).toISOString() : undefined);
  managedProviderDeadline(providerDeadlineAt, true);
  const { baseUrl, headers } = await managedStratusAuthorization(signal);
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(continuationToken)) throw new Error('Managed Stratus continuation token is invalid');
  const outboundActions = normalizeStratusActions(actions);
  const expectedSubmissionAttempt = managedSubmissionAttempt(options.submissionAttempt, true)!;
  if (options.requestBudget) {
    assertManagedBrowserRequestBudgetAtClock(
      options.requestBudget,
      options.providerDeadlineAt!,
      options.minimumDispatchBudgetMs!,
    );
  }
  const response = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers,
    ...(signal ? { signal } : {}),
    body: JSON.stringify({
      continuationToken,
      submissionAttempt: expectedSubmissionAttempt,
      providerDeadlineAt,
      actions: outboundActions,
      screenshot: options.screenshot ?? true,
      fullPage: true,
    }),
  });
  const payload = await response.json().catch(() => ({})) as { run?: ManagedBrowserResult; error?: ManagedBrowserError };
  if (!response.ok || !payload.run) {
    throw managedBrowserRequestError(payload.error, response.status, outboundActions, expectedSubmissionAttempt);
  }
  assertManagedSubmissionAttemptEcho(payload.run, expectedSubmissionAttempt);
  managedBrowserTerminalResultId(payload.run);
  assertRequiredManagedCapabilities(payload.run, outboundActions);
  return payload.run;
}

export type ManagedBrowserTerminalResult =
  | {
    state: 'completed';
    resultId: string;
    submissionAttempt: ManagedSubmissionAttempt;
    completedAt: string;
    expiresAt: string;
    run: ManagedBrowserResult;
  }
  | {
    state: 'failed' | 'indeterminate';
    resultId: string;
    submissionAttempt: ManagedSubmissionAttempt;
    completedAt: string;
    expiresAt: string;
    error: ManagedBrowserError;
    runProgress?: ManagedBrowserRunProgress;
  }
  | {
    state: 'pending';
    submissionAttempt: ManagedSubmissionAttempt;
    expiresAt: string;
  }
  | { state: 'not_found' | 'gone' };

function canonicalManagedTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Managed Stratus ${label} is missing`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error(`Managed Stratus ${label} must be a canonical ISO timestamp`);
  }
  return value;
}

/** Recover one correlated terminal response after the original HTTP response was lost. */
export async function getManagedBrowserTerminalResult(
  submissionAttempt: ManagedSubmissionAttempt,
  options: { timeoutMs?: number; actions?: ManagedBrowserAction[] } = {},
): Promise<ManagedBrowserTerminalResult> {
  const expected = managedSubmissionAttempt(submissionAttempt, true)!;
  const timeoutMs = options.timeoutMs ?? 10_000;
  assertManagedBrowserTimeout(timeoutMs, 'Managed Stratus terminal result');
  const signal = AbortSignal.timeout(timeoutMs);
  const { baseUrl, headers } = await managedStratusAuthorization(signal);
  const query = new URLSearchParams(expected);
  const response = await fetch(`${baseUrl}/api/run-results?${query.toString()}`, {
    method: 'GET',
    headers,
    signal,
  });
  if (response.status === 404) return { state: 'not_found' };
  if (response.status === 410) return { state: 'gone' };
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.status === 202) {
    if (payload.state !== 'pending' || !sameManagedSubmissionAttempt(payload.submissionAttempt, expected)) {
      throw new Error('Managed Stratus pending terminal result did not match its durable submission attempt');
    }
    return {
      state: 'pending',
      submissionAttempt: expected,
      expiresAt: canonicalManagedTimestamp(payload.expiresAt, 'terminal result expiry'),
    };
  }
  if (!response.ok || (payload.state !== 'completed'
    && payload.state !== 'failed'
    && payload.state !== 'indeterminate')) {
    const providerError = payload.error as ManagedBrowserError | undefined;
    throw managedBrowserRequestError(providerError, response.status, [], expected);
  }
  if (!sameManagedSubmissionAttempt(payload.submissionAttempt, expected)) {
    throw new Error('Managed Stratus terminal result did not match its durable submission attempt');
  }
  const resultId = managedTerminalResultId(payload.resultId, 'terminal result ID');
  const completedAt = canonicalManagedTimestamp(payload.completedAt, 'terminal completion time');
  const expiresAt = canonicalManagedTimestamp(payload.expiresAt, 'terminal result expiry');
  if (payload.state === 'completed') {
    if (!payload.run || typeof payload.run !== 'object') {
      throw new Error('Managed Stratus completed terminal result is missing its run');
    }
    const run = payload.run as ManagedBrowserResult;
    assertManagedSubmissionAttemptEcho(run, expected);
    if (options.actions) {
      assertRequiredManagedCapabilities(run, normalizeStratusActions(options.actions));
    }
    return { state: 'completed', resultId, submissionAttempt: expected, completedAt, expiresAt, run };
  }
  const providerError = payload.error as ManagedBrowserError | undefined;
  if (providerError == null) throw new Error(`Managed Stratus ${payload.state} terminal result is missing its error`);
  const runProgress = payload.runProgress === undefined
    ? null
    : managedBrowserRunProgress(payload.runProgress, expected);
  if (payload.runProgress !== undefined && !runProgress) {
    throw new Error('Managed Stratus terminal progress did not match its durable submission attempt');
  }
  return {
    state: payload.state,
    resultId,
    submissionAttempt: expected,
    completedAt,
    expiresAt,
    error: providerError,
    ...(runProgress ? { runProgress } : {}),
  };
}

/** Recreate the same typed provider error for a durably retained failed run. */
export function managedBrowserTerminalFailureError(
  result: Extract<ManagedBrowserTerminalResult, { state: 'failed' | 'indeterminate' }>,
  actions: ManagedBrowserAction[] = [],
): Error {
  const error = result.runProgress && typeof result.error === 'object'
    ? { ...result.error, runProgress: result.runProgress }
    : result.error;
  return managedBrowserRequestError(
    error,
    result.state === 'indeterminate' ? 409 : 502,
    normalizeStratusActions(actions),
    result.submissionAttempt,
  );
}

/** Acknowledge only after the correlated result has been durably folded into Litos state. */
export async function acknowledgeManagedBrowserTerminalResult(
  submissionAttempt: ManagedSubmissionAttempt,
  resultId: string,
  options: { timeoutMs?: number } = {},
): Promise<{
  acknowledged: true;
  submissionAttempt: ManagedSubmissionAttempt;
  resultId: string;
  acknowledgedAt: string;
  cleanupState: 'completed';
}> {
  const expected = managedSubmissionAttempt(submissionAttempt, true)!;
  const expectedResultId = managedTerminalResultId(resultId, 'terminal acknowledgement result ID');
  const timeoutMs = options.timeoutMs ?? 10_000;
  assertManagedBrowserTimeout(timeoutMs, 'Managed Stratus terminal acknowledgement');
  const signal = AbortSignal.timeout(timeoutMs);
  const { baseUrl, headers } = await managedStratusAuthorization(signal);
  const response = await fetch(`${baseUrl}/api/run-results/acknowledge`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({ submissionAttempt: expected, resultId: expectedResultId }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw managedBrowserRequestError(payload.error as ManagedBrowserError | undefined, response.status, [], expected);
  }
  if (payload.acknowledged !== true || !sameManagedSubmissionAttempt(payload.submissionAttempt, expected)) {
    throw new Error('Managed Stratus terminal acknowledgement did not match its durable submission attempt');
  }
  const acknowledgedResultId = managedTerminalResultId(
    payload.resultId,
    'terminal acknowledgement result ID',
  );
  if (acknowledgedResultId !== expectedResultId) {
    throw new Error('Managed Stratus terminal acknowledgement did not match its durable result ID');
  }
  if (payload.cleanupState !== 'completed') {
    throw new Error('Managed Stratus terminal acknowledgement did not complete durable cleanup');
  }
  return {
    acknowledged: true,
    submissionAttempt: expected,
    resultId: expectedResultId,
    acknowledgedAt: canonicalManagedTimestamp(payload.acknowledgedAt, 'terminal acknowledgement time'),
    cleanupState: 'completed',
  };
}

/**
 * How long a PERSISTENT browser session stays alive, in seconds.
 *
 * The provider kills the session at this mark. Anything that intends to reconnect to it later,
 * which on this codebase is exactly one thing - submit()'s non-managed path, via
 * getBrowserSession(review.browser_session_id) followed by connectToSession - has until then and
 * not a second longer. HANDOFF_WINDOW_MS below is derived from it rather than written out again.
 */
export const BROWSER_SESSION_TIMEOUT_SECONDS = 3600;

/**
 * The handoff window: how long a run that LEFT A LIVE SESSION BEHIND may be finished by hand.
 *
 * 55 minutes, and until now that was a bare `55 * 60_000` repeated at three call sites with nothing
 * saying where the 55 came from. It is the session timeout above minus a five minute margin, so the
 * window closes slightly before the thing it is a window onto. Written as a subtraction so that
 * raising the session timeout raises this with it, which is the whole point: these two numbers were
 * never independent, they only looked independent.
 *
 * IT IS A FACT ABOUT A BROWSER SESSION, NOT ABOUT A FILLED FORM. See preparedRunHandoffExpired.
 */
export const HANDOFF_WINDOW_MS = (BROWSER_SESSION_TIMEOUT_SECONDS - 5 * 60) * 1_000;

export function browserSessionBody(
  contextId: string | undefined,
  portalUrl: string,
  projectId?: string,
  provider: BrowserProvider = 'browserbase',
  resourceReservationId?: string,
) {
  const hostname = new URL(portalUrl).hostname;
  if (provider === 'stratus') {
    return {
      keepAlive: true,
      timeout: BROWSER_SESSION_TIMEOUT_SECONDS,
      ...(contextId ? { contextId } : {}),
      ...(resourceReservationId
        ? { userMetadata: { litos_resource_reservation_id: resourceReservationId } }
        : {}),
      browserSettings: {
        protectionPolicy: {
          allowedHosts: [hostname],
          minNavigationIntervalMs: 1000,
          challengeBehavior: 'pause',
          captureEvidence: true,
        },
      },
    };
  }
  return {
    ...(projectId ? { projectId } : {}),
    keepAlive: true,
    ...(resourceReservationId
      ? { userMetadata: { litos_resource_reservation_id: resourceReservationId } }
      : {}),
    browserSettings: {
      ...(contextId ? { context: { id: contextId, persist: true } } : {}),
      allowedDomains: [hostname],
      solveCaptchas: false,
      recordSession: false,
      logSession: false,
    },
  };
}

export async function createReservedBrowserSession(
  portalUrl: string,
  resourceReservationId: string,
  providerOverride?: Exclude<BrowserProvider, 'stratus-managed'>,
): Promise<SessionResponse> {
  if (!MANAGED_SUBMISSION_UUID.test(resourceReservationId)) {
    throw new Error('Browser provider resource reservation must be a UUID');
  }
  const { projectId, provider } = config(providerOverride);
  if (provider === 'stratus-managed') throw new Error('Managed Stratus uses bounded runs instead of persistent sessions');
  return request<SessionResponse>('/sessions', {
    method: 'POST',
    body: JSON.stringify(browserSessionBody(undefined, portalUrl, projectId, provider, resourceReservationId)),
  }, { timeoutMs: 15_000, provider });
}

export async function releaseBrowserSession(
  sessionId: string,
  provider?: Exclude<BrowserProvider, 'stratus-managed'>,
): Promise<void> {
  const { projectId } = config(provider);
  await request<void>(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    body: JSON.stringify({ status: 'REQUEST_RELEASE', ...(projectId ? { projectId } : {}) }),
  }, { timeoutMs: 10_000, provider });
}

export async function browserSessionIsConfirmedGone(
  sessionId: string,
  provider?: Exclude<BrowserProvider, 'stratus-managed'>,
): Promise<boolean> {
  try {
    const session = await request<SessionResponse>(`/sessions/${encodeURIComponent(sessionId)}`, {}, { timeoutMs: 10_000, provider });
    return ['ERROR', 'TIMED_OUT', 'COMPLETED'].includes(String(session.status ?? '').toUpperCase());
  } catch (error) {
    if (error instanceof BrowserProviderRequestError && error.status === 404) return true;
    throw error;
  }
}

export async function browserSessionsForResourceReservation(
  reservationId: string,
  provider?: Exclude<BrowserProvider, 'stratus-managed'>,
): Promise<SessionResponse[]> {
  const query = `user_metadata['litos_resource_reservation_id']:'${reservationId}'`;
  const result = await request<unknown>(
    `/sessions?q=${encodeURIComponent(query)}`,
    {},
    { timeoutMs: 10_000, provider },
  );
  const sessions = Array.isArray(result)
    ? result
    : result !== null
      && typeof result === 'object'
      && !Array.isArray(result)
      && Object.prototype.hasOwnProperty.call(result, 'sessions')
      ? (result as { sessions?: unknown }).sessions
      : undefined;
  if (!Array.isArray(sessions)) {
    throw new Error('Browser provider reservation query returned an invalid session list');
  }
  return sessions.map((session) => {
    if (session === null || typeof session !== 'object' || Array.isArray(session)) {
      throw new Error('Browser provider reservation query returned an invalid session record');
    }
    const id = (session as { id?: unknown }).id;
    if (typeof id !== 'string' || !id.trim() || id !== id.trim()) {
      throw new Error('Browser provider reservation query returned a session without an exact resource id');
    }
    return session as SessionResponse;
  });
}

export async function deleteBrowserContext(
  contextId: string,
  provider?: Exclude<BrowserProvider, 'stratus-managed'>,
): Promise<void> {
  try {
    await request<void>(`/contexts/${encodeURIComponent(contextId)}`, { method: 'DELETE' }, { timeoutMs: 10_000, provider });
  } catch (error) {
    if (error instanceof BrowserProviderRequestError && error.status === 404) return;
    throw error;
  }
}

export async function getBrowserSession(sessionId: string): Promise<SessionResponse> {
  return request<SessionResponse>(`/sessions/${encodeURIComponent(sessionId)}`);
}

export async function getLiveViewUrl(
  sessionId: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const result = await request<{ debuggerFullscreenUrl?: string; debuggerUrl?: string }>(
    `/sessions/${encodeURIComponent(sessionId)}/debug`,
    {},
    { timeoutMs: options.timeoutMs ?? 5_000 },
  );
  const url = result.debuggerFullscreenUrl ?? result.debuggerUrl;
  if (!url) throw new Error('Secure browser provider did not return a live view URL');
  return url;
}

export async function connectToSession(session: SessionResponse): Promise<{ browser: Browser; page: Page }> {
  const connectUrl = session.connectUrl ?? session.connect_url;
  if (!connectUrl) throw new Error('Secure browser provider did not return a connection URL');
  const browser = await chromium.connectOverCDP(connectUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  return { browser, page };
}
