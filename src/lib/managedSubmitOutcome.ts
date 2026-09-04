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
import type { Page } from 'playwright-core';
import { isCrelateHostUrl, receiptProof } from './receiptProof';
import {
  exactFinalSubmitChooserPolicy,
  type FinalSubmitChooserPolicy,
} from './finalSubmitChooserPolicy';
import {
  readWorkableApplicationUrl,
  resolvedApprovedApplicationPageUrl,
  sortManagedPageUrlParams,
} from './workableApplicationUrl';

export type ManagedFinalSubmitChooser = {
  version: 1;
  policyName: 'litos-final-submit';
  policyVersion: 3 | 4;
  grammarHash: string;
  submitKind: 'application' | 'verification';
  /* 'application_scope_invalid' is the runner reporting that the caller-bound application form was
   * unavailable, so no chooser run was possible at all. It is READ rather than rejected because
   * rejecting it made the chooser barrier throw first and hide the confirmation proof's own account
   * of the same refusal - the five application_scope_* reasons could never reach the operator. */
  outcome: 'selected' | 'no_submit_control' | 'ambiguous_submit' | 'application_scope_invalid';
  candidateCount: number;
  viableCandidateCount: number;
  topScore: number | null;
  topScoreCount: number;
  addressedScopeCount: number;
  bareSendCandidateCount: number;
};

type ManagedChooserResult = {
  finalSubmitChooser?: unknown;
  exactPageUrlProof?: unknown;
  screenshot?: unknown;
  submitOutcome?: unknown;
  securityCodeAttempt?: unknown;
  requiredFieldConfirmation?: unknown;
  blockedSubmits?: unknown;
  url?: unknown;
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => (
  Object.keys(value).sort().join(',') === [...keys].sort().join(',')
);

const boundedInteger = (value: unknown, max = 5_000): value is number => (
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max
);

/**
 * Read the privacy-safe chooser telemetry only when every field agrees with the exact requested
 * policy and with the chooser's own outcome. Null means absent or malformed, never no candidates.
 */
export function readManagedFinalSubmitChooser(
  result: ManagedChooserResult | null | undefined,
  expectedPolicy: FinalSubmitChooserPolicy,
  expectedSubmitKind: 'application' | 'verification',
): ManagedFinalSubmitChooser | null {
  const exactPolicy = exactFinalSubmitChooserPolicy(expectedPolicy);
  const raw = result?.finalSubmitChooser;
  if (!exactPolicy || !isObjectRecord(raw) || !hasExactKeys(raw, [
    'version', 'policyName', 'policyVersion', 'grammarHash', 'submitKind', 'outcome',
    'candidateCount', 'viableCandidateCount', 'topScore', 'topScoreCount',
    'addressedScopeCount', 'bareSendCandidateCount',
  ])) return null;
  if (raw.version !== 1
    || raw.policyName !== exactPolicy.name
    || raw.policyVersion !== exactPolicy.version
    || raw.grammarHash !== exactPolicy.grammarHash
    || raw.submitKind !== expectedSubmitKind
    || (raw.outcome !== 'selected'
      && raw.outcome !== 'no_submit_control'
      && raw.outcome !== 'ambiguous_submit'
      && raw.outcome !== 'application_scope_invalid')) return null;
  if (!boundedInteger(raw.candidateCount)
    || !boundedInteger(raw.viableCandidateCount)
    || !boundedInteger(raw.topScoreCount)
    || !boundedInteger(raw.addressedScopeCount)
    || !boundedInteger(raw.bareSendCandidateCount)
    || raw.viableCandidateCount > raw.candidateCount
    || (raw.topScore !== null && (typeof raw.topScore !== 'number'
      || !Number.isInteger(raw.topScore) || raw.topScore < 0 || raw.topScore > 3))) {
    return null;
  }
  if (raw.outcome === 'selected'
    && (raw.viableCandidateCount < 1 || raw.topScore === null || raw.topScoreCount !== 1)) return null;
  if (raw.outcome === 'no_submit_control'
    && (raw.viableCandidateCount !== 0 || raw.topScore !== null || raw.topScoreCount !== 0)) return null;
  /* No scope means nothing was scored at all, so every count must be zero - a scope-invalid report
   * that claims candidates is describing a chooser run it also says could not happen. */
  if (raw.outcome === 'application_scope_invalid'
    && (raw.candidateCount !== 0 || raw.viableCandidateCount !== 0 || raw.topScore !== null
      || raw.topScoreCount !== 0 || raw.addressedScopeCount !== 0
      || raw.bareSendCandidateCount !== 0)) return null;
  if (raw.outcome === 'ambiguous_submit'
    && (raw.viableCandidateCount < 2 || raw.topScore === null
      || raw.topScoreCount < 2 || raw.topScoreCount > raw.viableCandidateCount)) return null;
  if (raw.policyVersion === 3 && (raw.topScore === 0 || raw.bareSendCandidateCount !== 0)) return null;
  if (raw.topScore === 0 && (raw.policyVersion !== 4 || raw.submitKind !== 'application'
    || raw.bareSendCandidateCount < 1 || raw.addressedScopeCount !== 1
    || raw.topScoreCount !== raw.viableCandidateCount)) return null;
  return raw as ManagedFinalSubmitChooser;
}

function canonicalProofUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    sortManagedPageUrlParams(url);
    return url.href;
  } catch {
    return null;
  }
}

function hasPngScreenshot(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 30_000_000
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
}

export type ManagedFinalSubmitNoClick = {
  outcome: 'no_submit_control' | 'ambiguous_submit';
  chooser: ManagedFinalSubmitChooser;
};

/**
 * Evidence strong enough to release an application claim. Every fact is pre-click and independent:
 * exact chooser telemetry, exact URL proof at the chooser boundary, a PNG of that page, the runner's
 * not-attempted outcome, zero guarded submits, and no required-field pass that could say clicked.
 */
export function readManagedFinalSubmitNoClick(
  result: ManagedChooserResult | null | undefined,
  expectedPolicy: FinalSubmitChooserPolicy,
  expectedSubmitKind: 'application' | 'verification',
  expectedPageUrl: string,
): ManagedFinalSubmitNoClick | null {
  const chooser = readManagedFinalSubmitChooser(result, expectedPolicy, expectedSubmitKind);
  if (!chooser || (chooser.outcome !== 'no_submit_control' && chooser.outcome !== 'ambiguous_submit')) return null;
  const expected = canonicalProofUrl(expectedPageUrl);
  const proof = result?.exactPageUrlProof;
  if (!expected || !isObjectRecord(proof) || !hasExactKeys(proof, [
    'expected', 'beforeActions', 'beforeApplicantData', 'beforeFinalChooser', 'beforeSubmit',
  ])) return null;
  const resolvedBoundary = typeof proof.beforeActions === 'string'
    ? resolvedApprovedApplicationPageUrl(expected, proof.beforeActions)
    : null;
  if (canonicalProofUrl(proof.expected) !== expected
    || !resolvedBoundary
    || canonicalProofUrl(proof.beforeApplicantData) !== resolvedBoundary
    || canonicalProofUrl(proof.beforeFinalChooser) !== resolvedBoundary
    || proof.beforeSubmit !== null
    || canonicalProofUrl(result?.url) !== resolvedBoundary) return null;
  const outcome = result?.submitOutcome;
  if (!isObjectRecord(outcome) || !hasExactKeys(outcome, [
    'pressed', 'state', 'source', 'evidence', 'message', 'formStillPresent',
  ]) || outcome.pressed !== false || outcome.state !== 'not_attempted'
    || outcome.source !== null || outcome.evidence !== null || outcome.message !== null
    || outcome.formStillPresent !== null) return null;
  if (!hasPngScreenshot(result?.screenshot)
    || result?.securityCodeAttempt !== null
    || result?.requiredFieldConfirmation !== null
    || result?.blockedSubmits !== 0) return null;
  return { outcome: chooser.outcome, chooser };
}

/** Why an outcome could not be established. Mirrors the review field so the two cannot drift. */
export type UnverifiedCause = NonNullable<ApplicationReviewState['unverified_submission']>['cause'];

/** The runner's own read of the page after the click. Absent on a runner that predates it. */
export type ManagedSubmitOutcome = {
  /** Whether a final submit action was actually pressed. Recorded before the post-click wait. */
  pressed: boolean;
  state: 'confirmed' | 'rejected' | 'unknown' | 'not_attempted';
  /** ATS state is strong evidence. The other sources remain useful context, but cannot promote a receipt-only continuation.
   * 'unmatched_page_text' is the weakest of all: no arm recognised the page. It carries the raw text
   * Stratus actually saw so a genuinely new ATS shape (breezy.hr, workable.com - no arm exists for
   * either) leaves evidence instead of nothing; the verdict logic below never treats it as a claim. */
  source: 'ats_state' | 'ats_route' | 'ats_state_unconfirmed' | 'live_region' | 'page_text' | 'unmatched_page_text' | 'client_validation' | null;
  /** The selector or role that proved it, so a verdict can be argued with. */
  evidence: string | null;
  /** The sentence the employer showed. Evidence for a person, never the thing the verdict rests on. */
  message: string | null;
  formStillPresent: boolean | null;
  /* What the submit request itself came back with, recorded by the runner from the moment before
   * the final press: method, origin plus path, and a status, or a failure text when the request
   * never returned. Measured need on the live Easy Dynamics Rippling form (2026-08-20, twice): Send
   * pressed, the page said nothing either way, and without this the same press could fail the same
   * way forever with nobody able to learn why. Evidence for a person resolving an unverified
   * press; never the thing a verdict rests on, because analytics POSTs are write-shaped too. */
  network: SubmitNetworkEntry[] | null;
};

export type SubmitNetworkEntry = {
  method: string;
  /* Origin plus path only. The runner strips query strings before this ever leaves the sandbox,
   * because submit URLs carry tokens; the parse below cannot inherit that guarantee across the
   * wire, so it re-applies it, fragments included. */
  url: string;
  status: number | null;
  failure?: string;
  /* THREE FIELDS A SIBLING STRATUS PR IS ADDING to the same network entries, read defensively here
   * because that deploy has its own cadence: every run older than it, and every run on a request
   * this module has no reason to describe, carries none of the three. Nothing below may require any
   * of them to reach a verdict a status code alone cannot already prove.
   *
   * body_excerpt is the response body, or the start of it - genuinely an excerpt, so it may be cut
   * mid-object and fail to parse as JSON, which is read as "no code" rather than an error.
   * content_type is the response's own Content-Type header, used only to skip parsing a body that
   * already says it is not JSON. transport_disposition is carried for debugging and read by nothing
   * in this file. */
  body_excerpt?: string;
  content_type?: string;
  transport_disposition?: string;
};

const readSubmitNetwork = (raw: unknown): SubmitNetworkEntry[] | null => {
  if (!Array.isArray(raw)) return null;
  const entries: SubmitNetworkEntry[] = [];
  for (const item of raw.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    if (typeof value.method !== 'string' || typeof value.url !== 'string') continue;
    entries.push({
      method: value.method.slice(0, 10),
      url: value.url.split(/[?#]/)[0].slice(0, 300),
      status: typeof value.status === 'number' ? value.status : null,
      ...(typeof value.failure === 'string' ? { failure: value.failure.slice(0, 120) } : {}),
      ...(typeof value.body_excerpt === 'string' ? { body_excerpt: value.body_excerpt.slice(0, 2_000) } : {}),
      ...(typeof value.content_type === 'string' ? { content_type: value.content_type.slice(0, 100) } : {}),
      ...(typeof value.transport_disposition === 'string'
        ? { transport_disposition: value.transport_disposition.slice(0, 60) }
        : {}),
    });
  }
  return entries.length > 0 ? entries : null;
};

type MaybeOutcome = { submitOutcome?: unknown };

const STATES = new Set(['confirmed', 'rejected', 'unknown', 'not_attempted']);
const SOURCES = new Set(['ats_state', 'ats_route', 'ats_state_unconfirmed', 'live_region', 'page_text', 'unmatched_page_text', 'client_validation']);

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
    network: readSubmitNetwork(value.network),
  };
}

export type ManagedSubmitVerdict =
  /** The employer's own confirmation state was on screen. */
  | { kind: 'confirmed'; confirmationText: string; evidence: string }
  /** The employer's own refusal state was on screen. Nothing was filed, and that is KNOWN. */
  | { kind: 'refused'; message: string }
  /* THE SUBMIT REQUEST'S OWN RESPONSE PROVED THE REFUSAL, not the page's rendered state.
   *
   * Distinct from 'refused' above on purpose: that arm reads what the ATS's DOM shows and, past
   * employer-boundary authorization, is deliberately still treated as uncertain (see the comment at
   * its call site in routes/submissionRunner.ts) because page text is not proof by itself. This one
   * is read from the wire - a 4xx on the exact bound posting's own submit endpoint, corroborated by
   * a recognised refusal banner or a pre-filing refusal code in the response body - which is why it
   * is allowed to close the ledger attempt without asking the applicant. See
   * employerSubmitRefusalProof below for exactly what has to be true before this is returned. */
  | {
    kind: 'employer_refused';
    cause: 'employer_refused_submit';
    httpStatus: number;
    code?: string;
    bannerText?: string;
    securityCodeRecipient?: string;
  }
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
  /* CLIENT VALIDATION IS THE ONE REFUSAL THE LIVE FORM CORROBORATES, so its proof runs the
   * OPPOSITE polarity. Measured on the live transparent-hiring.breezy.hr form (run 549604ee,
   * 2026-08-20): 'Your application contains errors' under the pressed button, zero requests to
   * any breezy host in the press window, the whole form still standing - and the general rule
   * below, written for ATS failure panels that linger over live forms, downgraded the clearest
   * not-sent a page can say to 'unverified'. A validation sentence exists only while the form
   * does, so for this source the form still being present is the corroboration and its absence
   * is the ambiguity: a validation message with the form GONE is a leftover over some other
   * view, and falls to the unverified treatment like any unproven refusal. */
  if (outcome.source === 'client_validation') {
    return Boolean(outcome.message?.trim()) && outcome.formStillPresent === true;
  }
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

export type ManagedReceiptResult = MaybeOutcome & {
  url?: unknown;
  /** The runner's rendered page text; the receipt proof reads the runner's sentence window, not this. */
  text?: unknown;
  screenshot?: string | null;
  continuationOffered?: unknown;
  continuationToken?: unknown;
  continuationExpiresAt?: unknown;
  humanVerification?: unknown;
};

type ManagedAtsFamily = 'ashby' | 'greenhouse' | 'workable';

export const EXACT_WORKABLE_RECEIPT_TEXT = 'Your application has been submitted successfully.';

type ManagedAtsBinding = {
  family: ManagedAtsFamily;
  origin: string;
  tenant: string;
  jobToken: string;
  shape: 'ashby_path' | 'greenhouse_jobs_path' | 'greenhouse_embed_query' | 'workable_bare_apply_path' | 'workable_apply_path';
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
  if (host === 'apply.workable.com') {
    const identity = readWorkableApplicationUrl(url);
    return identity
      ? {
          family: 'workable',
          origin: identity.origin,
          tenant: identity.tenant ?? '',
          jobToken: identity.jobToken,
          shape: identity.shape === 'bare' ? 'workable_bare_apply_path' : 'workable_apply_path',
        }
      : null;
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
  if (family === 'workable' && host === 'apply.workable.com') {
    const identity = readWorkableApplicationUrl(url);
    return identity?.shape === 'tenant'
      ? {
          family,
          origin: identity.origin,
          tenant: identity.tenant!,
          jobToken: identity.jobToken,
          shape: 'workable_apply_path',
        }
      : null;
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

function heldAtsBinding(
  initial: ManagedAtsBinding | null,
  expected: ManagedAtsBinding | null,
): ManagedAtsBinding | null {
  if (sameAtsBinding(initial, expected)) return initial;
  /* Workable's supported public feed can provide /j/<token>/apply. Workable redirects that URL to
   * its canonical /<tenant>/j/<token>/apply page before Stratus reports the initial result. Accept
   * only this one controlled shape transition on the same Workable origin and exact token, then
   * freeze the canonical initial tenant for every observed receipt check that follows. */
  return initial?.family === 'workable'
    && initial.shape === 'workable_apply_path'
    && expected?.family === 'workable'
    && expected.shape === 'workable_bare_apply_path'
    && initial.origin === expected.origin
    && initial.jobToken === expected.jobToken
    ? initial
    : null;
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
  if (outcome.state === 'confirmed' && outcome.formStillPresent !== false) return false;
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
  if (expected.family === 'workable') {
    return url.search === '?success'
      && outcome.state === 'confirmed'
      && outcome.source === 'ats_state'
      && outcome.evidence === '[data-ui="successful-submit"]'
      && outcome.message?.replace(/\s+/g, ' ').trim() === EXACT_WORKABLE_RECEIPT_TEXT
      && outcome.formStillPresent === false;
  }
  const greenhousePath = /\/(?:application_)?confirmation\/?$/.test(url.pathname);
  return expected.family === 'greenhouse'
    && greenhousePath
    && outcome.state === 'confirmed'
    && outcome.source === 'ats_route'
    && outcome.evidence === `greenhouse:${url.pathname}`;
}

/**
 * Verify a terminal managed-browser result against the immutable application URL that the server
 * sent to Stratus. This is the only public confirmation predicate for initial results, delayed
 * observations, and server-retained sessions. Whole-page prose and caller labels never enter it.
 */
export function exactManagedAtsReceipt(input: {
  result: ManagedReceiptResult;
  expectedApplicationUrl: string;
}): boolean {
  const outcome = readManagedSubmitOutcome(input.result);
  if (!outcome || outcome.pressed !== true || outcome.state !== 'confirmed') return false;
  const expectedBinding = managedAtsBinding({ url: input.expectedApplicationUrl });
  if (!expectedBinding) return false;
  const observedLanding = managedAtsBinding(input.result);
  const receiptBinding = expectedBinding.family === 'workable'
    ? heldAtsBinding(observedLanding, expectedBinding)
    : expectedBinding;
  return Boolean(receiptBinding && exactAtsReceipt(input.result, outcome, receiptBinding));
}

/* THE SUBMIT ENDPOINT'S OWN URL SHAPE - A THIRD ONE FOR THE SAME POSTING IDENTITY.
 *
 * managedAtsBinding above already parses two Greenhouse shapes: the tenant path a direct job page
 * uses (/<board>/jobs/<id>) and the embed query FORM page (/embed/job_app?for=<board>&token=<id>).
 * Neither is what the embed form POSTS to. Measured verbatim on two live sends, both 2026-09-04:
 * Sage (packet aae653a3-2d5a-4f3e-ba3b-afea4219df37, run 46f50a9b) and Hudson River Trading (packet
 * 4a79eec1-5c65-4dd4-8e72-e119fbfbd733) both fired
 * `POST https://boards.greenhouse.io/embed/<board>/jobs/<id>` and both got back 428. Same board,
 * same job id as the packet's own application URL, a third path shape for that identity - so this
 * is compared against the SAME tenant/jobToken managedAtsBinding already computed from the packet's
 * expected application URL, never against the network entry's host alone. */
function greenhouseEmbedSubmitBinding(url: URL): { tenant: string; jobToken: string } | null {
  if (!/^(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io$/.test(url.hostname.toLowerCase())) return null;
  const match = url.pathname.match(/^\/embed\/([^/]+)\/jobs\/([^/]+)\/?$/);
  return match && validGreenhouseIdentity(match[1], match[2])
    ? { tenant: match[1], jobToken: match[2] }
    : null;
}

/**
 * The one network entry that is a submit-class request to the bound posting's OWN submit endpoint,
 * or null when none matches - including when the network list is absent, every entry is a read, or
 * every write-shaped request went somewhere else (an analytics beacon, a captcha vendor, or the
 * same board with a DIFFERENT job id). Matching family, board and job id - never host alone - is
 * what keeps a refusal from a foreign endpoint from ever being read as this posting's own answer.
 *
 * Greenhouse only for now: the ashby and workable submit-request shapes have not been measured on a
 * live run, and guessing one wrong would be worse than leaving those two families on the existing
 * 'unverified' path. Widen this the same way CONFIRMATION_LOOKS_LIKE below was widened - one family
 * at a time, once its shape is actually seen.
 */
function boundEmployerSubmitNetworkEntry(
  network: readonly SubmitNetworkEntry[] | null,
  expected: ManagedAtsBinding,
): SubmitNetworkEntry | null {
  if (!network || expected.family !== 'greenhouse') return null;
  for (const entry of network) {
    if (!/^(?:POST|PUT|PATCH)$/i.test(entry.method)) continue;
    let url: URL;
    try {
      url = new URL(entry.url);
    } catch {
      continue;
    }
    const binding = greenhouseEmbedSubmitBinding(url);
    if (binding && binding.tenant === expected.tenant && binding.jobToken === expected.jobToken) {
      return entry;
    }
  }
  return null;
}

/* 4xx, EXCLUDING THE TWO LOGIN WALLS. 401 and 403 mean the request itself was not accepted for
 * evaluation - a session or auth problem, not the employer answering the application - and stay on
 * whatever path already handles them today (unverified). Every other 4xx is the server having
 * looked at the submission and refused it: a CAPTCHA check, a stale or exceeded request token,
 * invalid attributes, or an ordinary validation failure this module has no banner text for yet -
 * which is exactly why the banner/code check below still has to agree before this ever proves
 * anything. A 2xx or 3xx is never a refusal, whatever the DOM says; that case keeps today's
 * unverified handling by construction, since this predicate is the only gate that can produce one. */
function isEmployerSubmitRefusalStatus(status: number | null): status is number {
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 401 && status !== 403;
}

/* THE FAMILY'S OWN REFUSAL VOCABULARY. Same discipline as CONFIRMATION_LOOKS_LIKE below: only a
 * family whose page text has actually been measured gets an entry, so an ATS this has never seen
 * refuse fails closed to 'unverified' rather than guessing at a sentence nobody has read.
 *
 * Greenhouse's embed form renders this sentence IN PLACE of the form while the form itself stays
 * mounted and resubmittable underneath it - measured verbatim, observed page text beginning exactly
 * this way, on both live sends named above. */
const SUBMIT_REFUSAL_BANNER_TEXT: Partial<Record<ManagedAtsFamily, RegExp>> = {
  greenhouse: /There was an error processing your application\.\s*Please try again\./i,
};

/* GREENHOUSE'S OWN PRE-FILING REFUSAL CODES, read from the submit response body rather than from
 * the page: a JSON object whose `code` field names why nothing was filed, returned instead of a 2xx
 * even though the request reached Greenhouse's servers.
 *
 * THE LAST TWO ARE NOT YET MEASURED ON A LIVE RUN. They are named from Greenhouse's own request-
 * token behaviour (its embed form mints a short-lived token per page load and refuses a submit
 * whose token has expired or has been retried past its limit) rather than from a captured
 * body_excerpt, so treat them as the best available guess until a real payload confirms the exact
 * string - and note every code below is matched EXACTLY against the whole parsed string, never by
 * substring or prefix, so a wrong guess or a future Greenhouse rename fails closed to 'unverified'
 * instead of mis-filing an ambiguous code as proven. */
const GREENHOUSE_PRE_FILING_REFUSAL_CODES = new Set([
  'captcha-failed',
  'captcha-retry',
  'invalid-attributes',
  'request-token-expired',
  'request-token-exceeded',
]);
const GREENHOUSE_CAPTCHA_REFUSAL_CODES = new Set(['captcha-failed', 'captcha-retry']);

type SubmitRefusalBody = { code: string | null; securityCodeRecipient: string | null };

/**
 * The submit response's own JSON, read defensively: body_excerpt is a sibling PR's addition and may
 * be absent, truncated mid-object, or not JSON at all - none of which may throw or fabricate a code.
 * `security_code_recipient`, when present, is the address Greenhouse said it emailed a fallback
 * verification code to; carried through so the sentence shown to the applicant can name it.
 */
function submitRefusalBody(entry: SubmitNetworkEntry): SubmitRefusalBody {
  const empty: SubmitRefusalBody = { code: null, securityCodeRecipient: null };
  if (typeof entry.body_excerpt !== 'string' || !entry.body_excerpt.trim()) return empty;
  if (typeof entry.content_type === 'string' && !/json/i.test(entry.content_type)) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.body_excerpt);
  } catch {
    return empty;
  }
  if (!isObjectRecord(parsed)) return empty;
  return {
    code: typeof parsed.code === 'string' ? parsed.code : null,
    securityCodeRecipient: typeof parsed.security_code_recipient === 'string'
      ? parsed.security_code_recipient.slice(0, 200)
      : null,
  };
}

export type EmployerSubmitRefusalProof = {
  httpStatus: number;
  code: string | null;
  bannerText: string | null;
  securityCodeRecipient: string | null;
};

/**
 * THE EMPLOYER'S OWN ANSWER, READ FROM THE WIRE INSTEAD OF FROM THE ATS'S RENDERED STATE.
 *
 * Every arm of managedSubmitVerdict above answers from what the PAGE showed: an ATS container, a
 * route, a body-text phrase. Measured on two live Greenhouse sends, both 2026-09-04 (Sage packet
 * aae653a3-2d5a-4f3e-ba3b-afea4219df37/run 46f50a9b, Hudson River Trading packet
 * 4a79eec1-5c65-4dd4-8e72-e119fbfbd733): the page showed nothing decisive - submitOutcome.state
 * 'unknown', the form still mounted - while the submit REQUEST itself carried the employer's answer
 * the whole time: a 428 on the exact bound posting's own submit endpoint, with Greenhouse's own
 * refusal sentence in the observed page text. That is not "Litos cannot tell"; it is the employer
 * saying no before anything was filed, and it deserves its own verdict rather than another trip
 * through 'unverified'.
 *
 * Fails closed at every step: wrong family, wrong board, wrong job id, a 2xx/3xx, a login wall
 * (401/403), the form actually gone (it navigated, so whatever it navigated to gets to answer), or
 * neither a recognised banner nor a recognised code - and this returns null, leaving the caller's
 * own 'unverified' verdict exactly as it was.
 */
function employerSubmitRefusalProof(
  outcome: ManagedSubmitOutcome,
  expectedApplicationUrl: string,
): EmployerSubmitRefusalProof | null {
  // The page never navigated away from the form - still exactly the condition that would otherwise
  // read as "we do not know" - which is the one this proof exists to resolve instead of leaving open.
  if (outcome.formStillPresent !== true) return null;
  const expected = managedAtsBinding({ url: expectedApplicationUrl });
  if (!expected) return null;
  const entry = boundEmployerSubmitNetworkEntry(outcome.network, expected);
  if (!entry || !isEmployerSubmitRefusalStatus(entry.status)) return null;
  const bannerPattern = SUBMIT_REFUSAL_BANNER_TEXT[expected.family];
  const bannerText = bannerPattern && outcome.message && bannerPattern.test(outcome.message)
    ? outcome.message.trim().slice(0, 300)
    : null;
  const body = submitRefusalBody(entry);
  const provenCode = body.code && GREENHOUSE_PRE_FILING_REFUSAL_CODES.has(body.code) ? body.code : null;
  if (!bannerText && !provenCode) return null;
  return {
    httpStatus: entry.status,
    code: provenCode,
    bannerText,
    securityCodeRecipient: provenCode ? body.securityCodeRecipient : null,
  };
}

/**
 * The plain-words sentence for a submit request the employer's own answer proves was refused
 * before anything was filed. Unlike unverifiedSubmissionReason below, this is not a question:
 * nothing here asks her to go look or to say which she found, because the network status and the
 * employer's own page or response already answered it - see employerSubmitRefusalProof above for
 * how each of the two proofs is read. Greenhouse-only today, matching the proof it describes.
 */
export function employerSubmitRefusalReason(input: {
  code?: string;
  bannerText?: string;
  securityCodeRecipient?: string;
}): string {
  const base = input.code && GREENHOUSE_CAPTCHA_REFUSAL_CODES.has(input.code)
    ? 'Greenhouse’s automated check refused this attempt before anything was filed. Nothing has '
      + 'gone to the employer.'
    : input.code
      ? `Greenhouse refused this submit request before filing it (code “${input.code}”). Nothing `
        + 'has gone to the employer.'
      : 'Greenhouse refused this submit request before filing it'
        + `${input.bannerText ? `, saying: “${input.bannerText}”` : ''}. Nothing has gone to the employer.`;
  const codeHint = input.securityCodeRecipient
    ? ` Greenhouse said it emailed a verification code to ${input.securityCodeRecipient}.`
    : '';
  return `${base}${codeHint} Litos released this attempt: send it again from Review and send `
    + 'whenever you are ready.';
}

/** A managed confirmation verdict is usable only when its portal-specific receipt is exact. */
export function exactManagedSubmitVerdict(
  result: ManagedReceiptResult | null | undefined,
  expectedApplicationUrl: string,
): ManagedSubmitVerdict {
  const verdict = managedSubmitVerdict(result);
  if (verdict.kind === 'unverified' && verdict.cause === 'no_confirmation_state' && result) {
    const outcome = readManagedSubmitOutcome(result);
    const refusal = outcome && employerSubmitRefusalProof(outcome, expectedApplicationUrl);
    if (refusal) {
      return {
        kind: 'employer_refused',
        cause: 'employer_refused_submit',
        httpStatus: refusal.httpStatus,
        ...(refusal.code ? { code: refusal.code } : {}),
        ...(refusal.bannerText ? { bannerText: refusal.bannerText } : {}),
        ...(refusal.securityCodeRecipient ? { securityCodeRecipient: refusal.securityCodeRecipient } : {}),
      };
    }
  }
  if (verdict.kind !== 'confirmed') return verdict;
  if (result && exactManagedAtsReceipt({ result, expectedApplicationUrl })) return verdict;
  if (result && corroboratedFamilyReceipt(result, expectedApplicationUrl, verdict.confirmationText, readManagedSubmitOutcome(result)?.source ?? null)) {
    return { ...verdict, evidence: `${verdict.evidence}+receipt_proof` };
  }
  return { kind: 'unverified', cause: 'no_confirmation_state' };
}

/* THE SEVEN FAMILIES WITHOUT AN EXACT ATS BINDING CAN VERIFY TOO.
 *
 * managedAtsBinding knows three hosts (Ashby, Greenhouse, Workable), and until this arm existed a
 * runner-confirmed press on any other family - Lever, Teamtailor, Crelate, Pinpoint, Personio,
 * Recruitee, Breezy - fell to `unverified` by construction, whatever the receipt page said. The
 * family-aware proof the direct path has always used (receiptProof: Crelate's applythanks route and
 * sentence, the receipt phrases everywhere else) is applied to the runner's rendered page text, and
 * only when the runner landed on the employer's own site: the same host as the application URL, or
 * the same registrable domain (a tenant receipt under the tenant's own subdomain). A redirect to
 * some other site confirms nothing. The runner's own counter-witness gates - the form gone, no doubt
 * cue - have already run; this is the second, independent reading of the same page. */
function corroboratedFamilyReceipt(
  result: ManagedReceiptResult,
  expectedApplicationUrl: string,
  confirmationText: string,
  source: string | null,
): boolean {
  if (managedAtsBinding({ url: expectedApplicationUrl })) return false;
  /* An exact-binding HOST is never corroborated by text, whatever shape its URL took: the binding
   * above answers by shape, and a same-host receipt on jobs.ashbyhq.com, apply.workable.com or a
   * greenhouse board without the expected route belongs to those families' own readers. */
  try {
    const host = new URL(expectedApplicationUrl).hostname.toLowerCase();
    if (host === 'jobs.ashbyhq.com' || host === 'apply.workable.com' || /^(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io$/.test(host)) return false;
  } catch {
    return false;
  }
  /* Only a TEXT reading is corroborated here. An ATS container or route verdict belongs to the
   * exact-binding families that own those hooks; one reported on any other host is a foreign or
   * forged container, not a receipt (review of PR #881, finding 4). */
  if (source !== 'page_text' && source !== 'live_region') return false;
  if (typeof result.url !== 'string') return false;
  let expected: URL;
  let landed: URL;
  try {
    expected = new URL(expectedApplicationUrl);
    landed = new URL(result.url);
  } catch {
    return false;
  }
  if (landed.protocol !== 'https:' || landed.username || landed.password) return false;
  if (!landedOnTheEmployersOwnPage(expected, landed)) return false;
  /* The RUNNER'S SENTENCE WINDOW, never the 50 KB body: the runner already cut the receipt line
   * out of the page, and the whole body is where a footer "thank you" or a job title lives. */
  const body = confirmationText.replace(/\s+/g, ' ').trim();
  if (!body) return false;
  if (RECEIPT_CLOSURE_CUE.test(body)) return false;
  if (isCrelateHostUrl(result.url)) return receiptProof(body, result.url).proven;
  return RECEIPT_APPLICATION_PHRASE.test(body);
}

/* The receipt has to NAME THE APPLICATION. A bare "thank you" or "success" is what a closed posting,
 * a cookie screen and a not-found page say too (review of PR #881, finding 1). */
const RECEIPT_APPLICATION_PHRASE = /\bthank(?:s| you) for (?:submitting|applying|your application)\b|\b(?:your )?application (?:has been |was )?(?:successfully )?(?:submitted|received|sent)\b|\bwe(?: have|'ve)? received your application\b|\bsuccessfully (?:submitted|applied)\b/i;
/* The runner's 400-char window can carry a doubt sentence after the receipt phrase ("Thanks for
 * applying! Verify your email address to finish."), and the runner's own phrase arm is not
 * doubt-gated, so this vocabulary is the only guard on the seven families. It is the UNION of the
 * runner's own BARE_RECEIPT_DOUBT list with the closure words this side needs, checked alternation
 * by alternation (round-3 verification found 24 of the runner's cues missing here, and 22 doubt
 * sentences confirming through the text route because of it).
 *
 * Two carve-outs, both measured as genuine receipt lines rather than doubt: "pending review" and
 * "pending our review" (bare "pending" still refuses, and "under review" already confirmed, so
 * refusing only the review phrasing was arbitrary), and "no further action is required" (the bare
 * word must keep refusing: "a cover letter is required" is exactly what this guard is for). */
const RECEIPT_CLOSURE_CUE = /\b(?:no longer|has been filled|filled|withdrawn|not found|closed|cancell?ed|expired|declined|denied|unfortunately|already applied|not (?:be )?(?:submitted|sent|received|processed|accepted|eligible|found|available)|cannot be accepted|complete (?:the|your)|check your (?:email|inbox)|confirm your|verify|talent (?:network|community|pool)|draft|error|went wrong|try again|fail(?:ed|ure)?|unable|could ?n[o']?t|can ?not|can't|sign(?:ed)? in|log(?:ged)? in|timed? out|not currently|not hiring|on hold|questionnaire|assessment|next step|incomplete|pending(?! (?:our )?review)|invalid|captcha|robot|problem|forbidden|finish(?:ing)? your|continue|saved|redirect(?:ed|ing)?|partner|newsletter|subscribe|cookies?|page not found|404|maintenance|too many|please wait|one moment|submitting|processing|loading|uploading|do(?:es)? not meet|minimum requirements|apply (?:through|via|on))\b|\brequired\b(?<!no further action is required)/i;

/* THE EMPLOYER'S OWN PAGE. On every family this arm serves the tenant IS the subdomain
 * (foo.breezy.hr, x.recruitee.com, acme.teamtailor.com, xolife.jobs.personio.com) or the first
 * path segment (jobs.lever.co/<org>, jobs.crelate.com/portal/<org>), so "same registrable domain"
 * is the wrong unit: another tenant's thank-you would confirm this application (review of PR #881,
 * finding 2). The host must match exactly; the one relaxation is a www prefix coming or going when
 * the expected host is itself the bare registrable domain (an employer's own careers site). On the
 * two shared hosts the landing path must sit under the expected tenant prefix as well. */
export function landedOnTheEmployersOwnPage(expected: URL, landed: URL): boolean {
  const expectedHost = expected.hostname.toLowerCase();
  const landedHost = landed.hostname.toLowerCase();
  const stripWww = (host: string) => host.replace(/^www\./, '');
  const hostAgrees = expectedHost === landedHost
    || (stripWww(expectedHost) === registrableDomain(expectedHost) && stripWww(landedHost) === registrableDomain(expectedHost));
  if (!hostAgrees) return false;
  /* THE SHARED HOSTS, every region: jobs.lever.co and jobs.eu.lever.co carry every Lever tenant
   * under /<org>/<posting>, jobs.crelate.com every Crelate tenant under /portal/<org>. Whatever
   * segments the expected path has, the landing path must repeat them. */
  const sharedHost = /^jobs(?:\.eu)?\.lever\.co$/.test(expectedHost) || expectedHost === 'jobs.crelate.com';
  if (sharedHost) {
    const tenantPrefix = expected.pathname.split('/').filter(Boolean).slice(0, 2);
    if (tenantPrefix.length === 0) return false;
    const landedSegments = landed.pathname.split('/').filter(Boolean);
    if (tenantPrefix.some((segment, index) => landedSegments[index] !== segment)) return false;
  }
  return true;
}

const SECOND_LEVEL_PUBLIC = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);
function registrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const [sld, tld] = labels.slice(-2);
  const take = tld.length === 2 && SECOND_LEVEL_PUBLIC.has(sld) ? 3 : 2;
  return labels.slice(-take).join('.');
}

export type ExactManagedPageReceipt = {
  confirmationText: string;
  finalUrl: string;
  result: ManagedReceiptResult;
};

const EXACT_RECEIPT_FORM_SELECTORS: Record<ManagedAtsFamily, string> = {
  ashby: '.ashby-application-form-container, input[name="_systemfield_email"], input#_systemfield_resume',
  greenhouse: 'form#application_form, input[name="job_application[first_name]"], input[name="first_name"], input[name="email"], input[name="resume"]',
  workable: '[data-ui="application-form"], input[type="file"][data-ui="resume"], input[name="firstname"]',
};

async function locatorHasVisibleMatch(locator: ReturnType<Page['locator']>): Promise<boolean> {
  const count = Math.min(await locator.count().catch(() => 0), 20);
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

/**
 * Read only measured portal-specific terminal state from a trusted server-held Page. It never reads
 * body prose. Unknown families, live forms, missing selectors, and posting mismatches remain null.
 */
export async function readExactManagedPageReceipt(
  page: Pick<Page, 'url' | 'locator' | 'waitForTimeout'>,
  expectedApplicationUrl: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ExactManagedPageReceipt | null> {
  const expectedBinding = managedAtsBinding({ url: expectedApplicationUrl });
  if (!expectedBinding) return null;
  const timeoutMs = Math.max(0, Math.min(options.timeoutMs ?? 30_000, 30_000));
  const pollMs = Math.max(10, Math.min(options.pollMs ?? 500, 1_000));
  const deadline = Date.now() + timeoutMs;
  do {
    const finalUrl = page.url();
    const formStillPresent = await locatorHasVisibleMatch(
      page.locator(EXACT_RECEIPT_FORM_SELECTORS[expectedBinding.family]),
    );
    let source: ManagedSubmitOutcome['source'] = null;
    let evidence: string | null = null;
    let confirmationText = '';
    if (!formStillPresent && expectedBinding.family === 'ashby') {
      const success = page.locator('.ashby-application-form-success-container');
      if (await locatorHasVisibleMatch(success)) {
        confirmationText = (await success.first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        source = 'ats_state';
        evidence = '.ashby-application-form-success-container';
      }
    } else if (!formStillPresent && expectedBinding.family === 'greenhouse') {
      try {
        const url = new URL(finalUrl);
        if (/\/(?:application_)?confirmation\/?$/.test(url.pathname)) {
          const confirmation = page.locator('.confirmation > .confirmation__content');
          if (await locatorHasVisibleMatch(confirmation)) {
            confirmationText = (await confirmation.first().innerText().catch(() => ''))
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 1_000);
            if (confirmationText) {
              source = 'ats_route';
              evidence = `greenhouse:${url.pathname}`;
            }
          }
        }
      } catch {
        // Invalid browser URLs fail closed below.
      }
    } else if (!formStillPresent && expectedBinding.family === 'workable') {
      const success = page.locator('[data-ui="successful-submit"]');
      if (await locatorHasVisibleMatch(success)) {
        confirmationText = (await success.first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (confirmationText === EXACT_WORKABLE_RECEIPT_TEXT) {
          source = 'ats_state';
          evidence = '[data-ui="successful-submit"]';
        }
      }
    }
    if (confirmationText && source && evidence) {
      const result: ManagedReceiptResult = {
        url: finalUrl,
        submitOutcome: {
          pressed: true,
          state: 'confirmed',
          source,
          evidence,
          message: confirmationText,
          formStillPresent,
        },
      };
      if (exactManagedAtsReceipt({ result, expectedApplicationUrl })) {
        return { confirmationText, finalUrl, result };
      }
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(pollMs).catch(() => undefined);
  } while (true);
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
 * publishes for Ashby's success/failure containers, Greenhouse's confirmation route, and
 * Workable's successful-submit state on the exact bound job. A generic live region, body text,
 * another unknown result, or a continuation failure can improve the screenshot shown to the
 * applicant, but none of them can turn the row into submitted or refused.
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
  const receiptBinding = heldAtsBinding(initialBinding, expectedBinding);
  if (!receiptBinding) return unchanged();
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
    && exactAtsReceipt(observed, observedOutcome, receiptBinding);
  const heldPageMatches = sameAtsBinding(managedAtsBinding(observed), receiptBinding);
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
 * This predicate now exists only for historical rows written before the typed submission_stop
 * record. A current run cannot use prose to release its claim. Its no-click result must pass the v4
 * evidence validator and arrive at the writer as a NoSubmitControlError.
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

/** The subset of the row that answers "may something already be at the employer" on its own. */
export type StoredSendEvidence = Pick<
  ApplicationReviewState,
  'submission_attempted_at' | 'receipt' | 'unverified_submission' | 'security_code'
>;

/* THE FOUR STORED FACTS THAT EACH MEAN SOMETHING MAY ALREADY BE AT THE EMPLOYER.
 *
 * ONE DEFINITION, BECAUSE A SECOND ONE IS HOW THIS CLASS OF BUG RECURS. These four lines opened
 * submissionProvablyNotSent, where they were the send path's answer to the question. Then a save
 * gate arrived that had to ask the SAME question and asked it of the status alone instead, so
 * needs_attention fell through to 'save' unconditionally - including for the rows
 * unverifiedSubmissionPatch writes, which is precisely the shape that means a run may have pressed
 * submit: submission_attempted_at set, an unresolved unverified_submission recorded, the claim kept.
 * Two of the 286 live needs_attention rows on 2026-08-13 were exactly that, one carrying a standing
 * security_code as well, and both were saveable through the new route while the dashboard offered
 * "Check the answers" for them. Named and exported so both gates read the same four facts.
 *
 * Deliberately NOT the whole of submissionProvablyNotSent, which demands a POSITIVE proof of a
 * pre-click stop and answers false for a row that simply has no record either way. That strictness
 * is right for reopening a SEND and wrong for a save, which would then refuse the ordinary stopped
 * run whose only remaining ask is the answer the save exists to store.
 *
 * HER LOOK IS THE RELEASE, and this predicate has to read it. An earlier version counted ANY
 * unverified_submission, resolved or not, reasoning that submission_attempted_at is written beside
 * every unverified record so "the resolution never decides this on its own" - a distinction with
 * no row behind it. The Easy Dynamics Rippling packet put a row behind it, measured live on
 * 2026-08-20: press recorded, no readable confirmation, she answered "not there", the resolution
 * route released the claim and promised "Litos can send it again whenever you are ready" - and
 * every send-adjacent surface stayed refused, because this predicate read the RESOLVED record and
 * the SAME press's attempted_at as an employer hold. The resolution route's own comment names her
 * look as "the single fact that makes another run safe"; a predicate that cannot see that fact
 * makes the promise unfulfillable.
 *
 * So a resolution of 'not_sent' neutralises exactly the two facts that describe the press she
 * looked into: the unverified record itself and its sibling submission_attempted_at. It touches
 * nothing else. A receipt is a confirmation somebody captured, a security_code is the employer's
 * own record that an application arrived, and a LATER press overwrites unverified_submission with
 * a fresh unresolved record, so both facts hold again by construction.
 */
export function employerMayHoldApplication(evidence: StoredSendEvidence): boolean {
  const lookedAndNotThere = evidence.unverified_submission?.resolution === 'not_sent';
  if (evidence.receipt) return true;
  if (evidence.security_code) return true;
  if (evidence.unverified_submission && !lookedAndNotThere) return true;
  if (evidence.submission_attempted_at && !lookedAndNotThere) return true;
  return false;
}

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
 * The refusals it opens with are each a case where something may have reached the employer, and the
 * security_code one is the least obvious and the most important: a retained code wall is the
 * employer's own record that an application arrived and is parked at verification, and it stays true
 * even when THIS run never pressed anything. See delayedSecurityCodeHandoffReview. They live in
 * employerMayHoldApplication above, because a second gate now asks the same question.
 */
export function submissionProvablyNotSent(evidence: PreClickNoSendEvidence): boolean {
  if (employerMayHoldApplication(evidence)) return false;
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
/* THE PRESS THAT TALKED ONLY TO A CHALLENGE SERVER. Measured on the live Easy Dynamics Rippling
 * form (2026-08-20, run 858a4f98, after three identical unverified presses): the press-window
 * network record holds two POSTs to challenges.cloudflare.com and not one request to any
 * rippling.com host. The Apply button is gated behind an invisible human-verification challenge;
 * the submit request is never sent, the button spins forever, and the page renders nothing the
 * outcome reader could read - so the same press failed the same unreadable way four times.
 *
 * This predicate reads that shape: a challenge platform was spoken to, and the employer's own host
 * never was. It chooses a SENTENCE, never a verdict: the record is bounded and write-shaped only,
 * so its silence about the portal host is strong but not proof, and the applicant is still the one
 * who looks. A human-verification wall is also a wall Litos does not climb, by policy as much as by
 * ability, so the honest next step on this arm is a person's press, not a re-run. */
/* Hosts by name where the platform owns the whole host; Google's reCAPTCHA lives under a shared
 * host and is recognised by its path instead, which is why the second test reads the URL. */
const CHALLENGE_HOST_RE = /(^|\.)(?:challenges\.cloudflare\.com|hcaptcha\.com|arkoselabs\.com|funcaptcha\.com|recaptcha\.net)$/i;
const CHALLENGE_PATH_RE = /^https:\/\/(?:www\.)?(?:google\.com|gstatic\.com)\/recaptcha\//i;
export function pressReachedOnlyChallengePlatform(
  network: SubmitNetworkEntry[] | null | undefined,
  portalUrl: string | undefined,
): boolean {
  if (!network || network.length === 0 || !portalUrl) return false;
  let portalHost: string;
  try { portalHost = new URL(portalUrl).hostname.toLowerCase(); } catch { return false; }
  // The registrable tail, so ats.rippling.com counts requests to api.rippling.com as reaching it.
  const portalTail = portalHost.split('.').slice(-2).join('.');
  let challenged = false;
  for (const entry of network) {
    let host: string;
    try { host = new URL(entry.url).hostname.toLowerCase(); } catch { continue; }
    if (host === portalHost || host === portalTail || host.endsWith('.' + portalTail)) return false;
    if (CHALLENGE_HOST_RE.test(host) || CHALLENGE_PATH_RE.test(entry.url)) challenged = true;
  }
  return challenged;
}

/* THE TWO SENTENCES FOR AN ATTEMPT THAT NEVER PRESSED ANYTHING.
 *
 * Every arm of unverifiedSubmissionReason asserts a press, and its cause vocabulary has no "never
 * pressed" member, so there was no way to reach that function and say the honest thing. Measured
 * 2026-09-02, attempt 22b9663a: an attempt whose ledger held `attempt_opened` alone - no boundary
 * authorization, no press, 456 ms from open to give-up - was described to the applicant as "Litos
 * pressed Send and the page never showed a confirmation it could read", and she was sent to inspect
 * an employer portal for a submission that was never attempted. The ledger said "never pressed" in
 * one word (submissionAttemptRetrySafety's reason) and the sentence-writer never asked.
 *
 * TWO SENTENCES RATHER THAN ONE, because the STATE differs and the prose has to match the state.
 *
 * attemptNeverPressedReason is for a row whose attempt has been CLOSED: the claim is released, the
 * ledger carries a not_sent_proven, and there is no unverified_submission record. Nothing is with
 * an employer and nothing is pending, so the sentence points at the one action that finishes this,
 * which is inside Litos. It deliberately carries "could not finish this application" so
 * attentionCategoriesForReasons files it as run_failed - a run that broke and should be retried -
 * and deliberately omits "does not know whether this application went through", which would file it
 * as unverified_submission and contradict the row.
 *
 * unpressedUnverifiedSubmissionReason is for a row whose unverified_submission record still STANDS
 * (a legacy row, or any path that could not close the attempt). Here the classification clause must
 * be kept or submissionTerminalCause silently reclassifies the row, so it is kept - but it is
 * placed on Litos not knowing what an unfinished attempt left behind, never on a press. The
 * applicant is still not sent to the employer's page: there is nothing there to find.
 * duplicateApplication.ts:143 makes the same trade for the same reason. */
export function attemptNeverPressedReason(): string {
  /* CAUSE-NEUTRAL, for the same reason noSubmitControl's sentence is. This arm is reached as the
   * ledger-proven fallback, after every typed pre-click stop that has a sentence of its own, so
   * naming a cause here would be a guess. What is always true, and all that matters, is that the
   * run stopped before pressing and nothing reached the employer. */
  return 'Litos stopped this send before pressing anything, so nothing was submitted and there is '
    + 'no confirmation to look for. Litos could not finish this application on that run and has '
    + 'released it, so open it in your dashboard and send it again when you are ready.';
}

export function unpressedUnverifiedSubmissionReason(): string {
  return 'Litos opened an attempt on this application and stopped before pressing Send, so it does '
    + 'not know whether this application went through only in the sense that it never got far '
    + 'enough to try. Nothing on record shows a send, and there is nothing for you to check on the '
    + 'employer’s page. Litos will not send a second one until this attempt is closed: choose '
    + '“It is not there” below to record that nothing was sent and release this saved application.';
}

export function unverifiedSubmissionReason(input: {
  atsName?: string;
  portalUrl?: string;
  cause: UnverifiedCause;
  network?: SubmitNetworkEntry[] | null;
  /* What the immutable attempt ledger records about this attempt, reduced the way
   * duplicateApplication.ts already reduces it: 'opened' means the attempt was opened and never
   * crossed the employer boundary, 'pressed' means a press is on record or an authorization to make
   * one is. Null or absent means the ledger was not consulted, which must keep the pre-existing
   * sentence: an unread ledger is not evidence of anything. */
  sendEvidence?: 'pressed' | 'opened' | null;
  /* The runner SAW a rendered challenge standing after the press (its CAPTCHA blocker). Stronger
   * evidence than the network heuristic below: measured on the live Mytos Lever form, 2026-08-20,
   * run 6757f19a - the press fetched an hCaptcha drag puzzle and the receipt screenshot shows it
   * standing over a fully filled form, but the press window also carried an ordinary POST to the
   * employer's own host (Lever re-parses the resume at submit), so the requests-only predicate
   * rightly withdrew and the applicant was promised a re-send that would hit the same wall. */
  challengeOnScreen?: boolean;
  /** What the runner saw on the page after the press, when it saw anything. Shown, never judged. */
  observedPageText?: string | null;
}): string {
  /* ASKED FIRST, ahead of every cause arm, because no cause can outrank it. The causes below are
   * all descriptions of how a press ended; if the ledger says no press was made, none of them
   * applies no matter what the run reported. */
  if (input.sendEvidence === 'opened') return unpressedUnverifiedSubmissionReason();
  const looksLike = CONFIRMATION_LOOKS_LIKE[(input.atsName ?? '').toLowerCase().trim()]
    ?? 'A sent application usually replaces the form with a short confirmation, and many employers '
      + 'email one too.';
  const where = input.portalUrl
    ? `Open ${input.portalUrl} and look.`
    : 'Open the employer’s application page and look.';
  if (input.cause === 'no_confirmation_state'
    && (input.challengeOnScreen || pressReachedOnlyChallengePlatform(input.network, input.portalUrl))) {
    const how = input.challengeOnScreen
      ? 'Litos pressed Send, and the page put up a human-verification challenge instead of a '
        + 'confirmation, so this application very likely did not go through.'
      : 'Litos pressed Send, but the page ran a human-verification check instead of submitting: '
        + 'the only requests it made went to the verification service, and none reached the '
        + 'employer, so this application very likely did not go through.';
    return `${how} Litos cannot complete a human-verification check or claim a receipt that the `
      + 'employer did not show. Choose “It is not there” below to record that nothing was sent and '
      + 'release this saved application. The filled-form proof and every next action stay in this '
      + 'dashboard.';
  }
  const what = input.cause === 'run_timed_out'
    ? 'Litos pressed Send and the secure browser was cut off before the employer’s answer came back, '
      + 'so it does not know whether this application went through.'
    : input.cause === 'provider_error'
      ? 'Litos pressed Send and the secure browser failed before it could read the employer’s answer, '
        + 'so it does not know whether this application went through.'
      : 'Litos pressed Send and the page never showed a confirmation it could read, so it does not '
        + 'know whether this application went through.';
  /* What the page said travels on the record (unverified_submission.observed_page_text), never
   * inside this sentence: the dashboard passes attention_reason through its technical-error
   * filter, and an observed "Internal Server Error" or "HTTP 502" replaced the whole warning with
   * "Try again in a minute" - the opposite instruction (review of PR #881, finding 3). */
  return `${what} ${where} ${looksLike} Then tell Litos which you found: if it is there, Litos will `
    + 'record it as sent and will not apply again; if it is not, Litos will send this one for you. '
    + 'Do not submit it by hand in the meantime, because two applications to the same posting count '
    + 'against you and cannot be taken back.';
}

/**
 * The review patch for a submit request the employer's own answer proves was refused before
 * anything was filed.
 *
 * PURE, and deliberately extracted from the transaction that writes it
 * (recordManagedAuthorizedAttemptRefused, routes/submissionRunner.ts) so this shape - status
 * needs_attention, the claim released, unverified_submission left unset, employer_refusal set - can
 * be tested without a database. The caller is what makes it durable: it must append the ledger's
 * own not_sent_proven/employer_rejected_not_filed fact in the SAME transaction as this patch, or a
 * released row would sit unclaimed while its ledger attempt still folds to blocked_unverified and
 * every gate that reads the ledger keeps refusing it.
 *
 * Mirrors releaseAttemptThatNeverReachedEmployer (lib/expiredHandoffClaimRelease.ts) in shape: same
 * claim fields cleared, same claim_released record, same reason status stays needs_attention rather
 * than moving to some fourth state nothing else knows how to render. What is deliberately DIFFERENT
 * is unverified_submission and attention_categories: that sibling function is repairing a row that
 * may already carry an unverified record left by an earlier run and is careful to only ever clear
 * one that belongs to the same run; this one is called from inside the run that just received the
 * refusal and never wrote an unverified_submission record at all, so there is nothing to preserve
 * and 'employer_refused' is the one category set, never 'unverified_submission' beside it.
 */
export function employerRefusalReleasePatch(
  review: Pick<ApplicationReviewState, 'submission_claim_id'>,
  input: {
    at: string;
    httpStatus: number;
    code?: string;
    attentionReason: string;
    previewUrl?: string;
  },
): Partial<ApplicationReviewState> {
  return {
    status: 'needs_attention',
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    submission_packet_version: undefined,
    submission_authorization: undefined,
    submission_attempted_at: undefined,
    unverified_submission: undefined,
    submission_error: undefined,
    ...(input.previewUrl ? { preview_screenshot_url: input.previewUrl } : {}),
    attention_reason: input.attentionReason,
    attention_categories: ['employer_refused'],
    employer_refusal: {
      http_status: input.httpStatus,
      ...(input.code ? { code: input.code } : {}),
      at: input.at,
    },
    claim_released: {
      cause: 'employer_refused_before_filing',
      ...(review.submission_claim_id ? { claim_id: review.submission_claim_id } : {}),
      released_at: input.at,
    },
  };
}
