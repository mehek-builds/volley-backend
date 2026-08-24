import { chromium, type Browser, type Page } from 'playwright-core';
import { getVercelOidcToken } from '@vercel/oidc';
import { createHash } from 'node:crypto';
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

export type BrowserProvider = 'browserbase' | 'stratus' | 'stratus-managed';

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
         * Emitted by every runner since the submit-scope repair; absent only from older runners. */
        scopeKind?: 'form' | 'container';
        formFingerprint: string;
        submitFingerprint: string;
        formMatchCount: 1;
        submitMatchCount: 1;
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
      blockerReason?: 'submit_node_replaced' | 'ambiguous_submit' | 'form_identity_changed'
        | 'no_submit_control' | 'submit_chooser_changed';
    }>;
  } | null;
};

export type ManagedBrowserRunProgress = {
  version: 1;
  phase: 0 | 1;
  stage: 'launch' | 'phase_started' | 'submit_activation_started'
    | 'submit_blocked' | 'submit_released' | 'result_written';
  submitPressed: boolean;
  applicationSubmitPressed: boolean;
  verificationSubmitPressed: boolean;
  submitKind: 'application' | 'verification' | null;
  policyVersion: 3 | 4 | null;
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
    if (!await retryAuthorized()) return { kind: 'authorization_revoked', error };
    return { kind: 'completed', result: await run(), retried: true };
  }
}

function managedBrowserRunProgress(value: unknown): ManagedBrowserRunProgress | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const stages = new Set([
    'launch', 'phase_started', 'submit_activation_started',
    'submit_blocked', 'submit_released', 'result_written',
  ]);
  if (input.version !== 1
    || (input.phase !== 0 && input.phase !== 1)
    || typeof input.stage !== 'string' || !stages.has(input.stage)
    || typeof input.submitPressed !== 'boolean'
    || typeof input.applicationSubmitPressed !== 'boolean'
    || typeof input.verificationSubmitPressed !== 'boolean'
    || (input.submitKind !== null && input.submitKind !== 'application' && input.submitKind !== 'verification')
    || (input.policyVersion !== null && input.policyVersion !== 3 && input.policyVersion !== 4)) return null;
  return input as ManagedBrowserRunProgress;
}

function managedBrowserRequestError(
  error: ManagedBrowserError | undefined,
  status: number,
  actions: ManagedBrowserAction[] = [],
): Error {
  const message = managedBrowserErrorMessage(error, status, actions);
  if (error && typeof error === 'object' && error.code === 'SANDBOX_RUN_FAILED') {
    const progress = managedBrowserRunProgress(error.runProgress);
    const transportStillContained = progress?.version === 1
      && progress.phase === 0
      && progress.policyVersion === 4
      && progress.submitKind === 'application'
      && (progress.stage === 'phase_started' || progress.stage === 'submit_blocked')
      && progress.submitPressed === false
      && progress.applicationSubmitPressed === false
      && progress.verificationSubmitPressed === false;
    if (progress && transportStillContained) {
      return new ManagedBrowserPreSubmitCrashError(message, progress);
    }
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

type SessionResponse = {
  id: string;
  connectUrl?: string;
  connect_url?: string;
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
    if (canonicalExpected) canonicalExpected.hash = '';
    const proof = result.exactPageUrlProof;
    const v4ChooserAction = actions.find((action) => action.type === 'confirmAndSubmit'
      && action.chooserPolicy?.version === 4);
    const chooserReported = result.finalSubmitChooser !== undefined && result.finalSubmitChooser !== null;
    if (!canonicalExpected || proof?.expected !== canonicalExpected.href
      || proof.beforeActions !== canonicalExpected.href
      || proof.beforeApplicantData !== canonicalExpected.href
      || (chooserReported && proof.beforeFinalChooser !== canonicalExpected.href)
      || (result.submitOutcome?.pressed === true && proof.beforeSubmit !== canonicalExpected.href)) {
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

function config() {
  const provider: BrowserProvider = process.env.BROWSER_PROVIDER === 'stratus-managed'
    ? 'stratus-managed'
    : process.env.BROWSER_PROVIDER === 'stratus' || Boolean(process.env.STRATUS_BASE_URL)
      ? 'stratus'
      : 'browserbase';
  const apiKey = process.env.BROWSER_API_KEY
    ?? (provider !== 'browserbase' ? process.env.STRATUS_API_KEY : process.env.BROWSERBASE_API_KEY);
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  const stratusBaseUrl = process.env.STRATUS_BASE_URL?.replace(/\/$/, '');
  const apiRoot = (process.env.BROWSER_API_ROOT
    ?? (provider === 'stratus' && stratusBaseUrl ? `${stratusBaseUrl}/v1` : 'https://api.browserbase.com/v1'))
    .replace(/\/$/, '');
  if (!apiKey) {
    throw new Error('Secure browser provider is not configured. Add BROWSER_API_KEY or the provider-specific API key.');
  }
  return { apiKey, projectId, provider, apiRoot };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { apiKey, apiRoot, provider } = config();
  const response = await fetch(`${apiRoot}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      [provider === 'stratus' ? 'X-Stratus-API-Key' : 'X-BB-API-Key']: apiKey,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`Secure browser provider request failed with status ${response.status}`);
  return response.json() as Promise<T>;
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
export function managedApplicationSubmitOptions(continuationTtlSeconds: number): {
  allowSubmit: true;
  requestContinuation: true;
  continuationTtlSeconds: number;
} {
  return { allowSubmit: true, requestContinuation: true, continuationTtlSeconds };
}

// `screenshot` defaults to true because every existing caller wants the receipt image. The CAPTCHA
// probe does not: it reads one attribute and throws the result away, so a full-page PNG would be
// rendered, transferred and retained by the third-party runner for nothing.
export async function runManagedBrowser(
  portalUrl: string,
  actions: ManagedBrowserAction[],
  options: {
    screenshot?: boolean;
    allowSubmit?: boolean;
    requestContinuation?: boolean;
    continuationCheckpoint?: boolean;
    continuationTtlSeconds?: number;
  } = {},
): Promise<ManagedBrowserResult> {
  const baseUrl = process.env.STRATUS_BASE_URL?.replace(/\/$/, '');
  const apiKey = process.env.STRATUS_API_KEY?.trim();
  if (!baseUrl) throw new Error('Stratus managed browser is not configured');
  const authorization = !apiKey && (process.env.VERCEL_OIDC_TOKEN?.trim() || process.env.VERCEL_ENV === 'production')
    ? `Bearer ${await getVercelOidcToken()}`
    : undefined;
  if (!apiKey && !authorization) throw new Error('Stratus managed browser is not configured');
  const outboundActions = normalizeStratusActions(actions);
  const response = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'X-Stratus-API-Key': apiKey } : {}),
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({
      url: portalUrl,
      actions: outboundActions,
      screenshot: options.screenshot ?? true,
      allowSubmit: options.allowSubmit === true,
      fullPage: true,
      waitUntil: 'domcontentloaded',
      ...(options.requestContinuation ? {
        requestContinuation: true,
        continuationCheckpoint: options.continuationCheckpoint === true,
        continuationTtlSeconds: Math.min(Math.max(options.continuationTtlSeconds ?? 120, 15), 120),
      } : {}),
    }),
  });
  const payload = await response.json().catch(() => ({})) as { run?: ManagedBrowserResult; error?: ManagedBrowserError };
  if (!response.ok || !payload.run) {
    throw managedBrowserRequestError(payload.error, response.status, outboundActions);
  }
  assertRequiredManagedCapabilities(payload.run, outboundActions);
  return payload.run;
}

export async function continueManagedBrowser(
  continuationToken: string,
  actions: ManagedBrowserAction[],
  options: { screenshot?: boolean } = {},
): Promise<ManagedBrowserResult> {
  const baseUrl = process.env.STRATUS_BASE_URL?.replace(/\/$/, '');
  const apiKey = process.env.STRATUS_API_KEY?.trim();
  if (!baseUrl) throw new Error('Stratus managed browser is not configured');
  const authorization = !apiKey && (process.env.VERCEL_OIDC_TOKEN?.trim() || process.env.VERCEL_ENV === 'production')
    ? `Bearer ${await getVercelOidcToken()}`
    : undefined;
  if (!apiKey && !authorization) throw new Error('Stratus managed browser is not configured');
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(continuationToken)) throw new Error('Managed Stratus continuation token is invalid');
  const outboundActions = normalizeStratusActions(actions);
  const response = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'X-Stratus-API-Key': apiKey } : {}),
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({
      continuationToken,
      actions: outboundActions,
      screenshot: options.screenshot ?? true,
      fullPage: true,
    }),
  });
  const payload = await response.json().catch(() => ({})) as { run?: ManagedBrowserResult; error?: ManagedBrowserError };
  if (!response.ok || !payload.run) {
    throw managedBrowserRequestError(payload.error, response.status, outboundActions);
  }
  assertRequiredManagedCapabilities(payload.run, outboundActions);
  return payload.run;
}

export async function createBrowserContext(): Promise<string> {
  const result = await request<{ id: string }>('/contexts', { method: 'POST', body: '{}' });
  return result.id;
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
  contextId: string,
  portalUrl: string,
  projectId?: string,
  provider: BrowserProvider = 'browserbase',
) {
  const hostname = new URL(portalUrl).hostname;
  if (provider === 'stratus') {
    return {
      keepAlive: true,
      timeout: BROWSER_SESSION_TIMEOUT_SECONDS,
      contextId,
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
    browserSettings: {
      context: { id: contextId, persist: true },
      allowedDomains: [hostname],
      solveCaptchas: false,
    },
  };
}

export async function createBrowserSession(contextId: string, portalUrl: string): Promise<SessionResponse> {
  const { projectId, provider } = config();
  if (provider === 'stratus-managed') throw new Error('Managed Stratus uses bounded runs instead of persistent sessions');
  return request<SessionResponse>('/sessions', {
    method: 'POST',
    body: JSON.stringify(browserSessionBody(contextId, portalUrl, projectId, provider)),
  });
}

export async function getBrowserSession(sessionId: string): Promise<SessionResponse> {
  return request<SessionResponse>(`/sessions/${encodeURIComponent(sessionId)}`);
}

export async function getLiveViewUrl(sessionId: string): Promise<string> {
  const result = await request<{ debuggerFullscreenUrl?: string; debuggerUrl?: string }>(
    `/sessions/${encodeURIComponent(sessionId)}/debug`,
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
