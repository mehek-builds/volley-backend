import type { ExperienceBankEntry } from '../db/schema';
import type { ResumeSpec } from '../llm/resumeSpec';
import { canonicalSupportedPortalUrl, detectPortal, isPortalSupported } from './portalSubmission';

export type ApplicationReviewQuestion = {
  id: string;
  question: string;
  answer: string;
  kind: 'essay' | 'required';
  required: boolean;
  portal_selector?: string;
  portal_input_type?: string;
  ats_api_field?: string;
};

export type ApplicationAttentionCategory =
  | 'captcha'
  /* The run never got to the application form at all: no field was typed, no control was located,
   * nothing was discovered. Deliberately NOT 'evidence_gap', which means the opposite - the form
   * was reached and the evidence of specific fields is missing. Five owner packets on 2026-08-06
   * (Akuna x3, Jump Trading, Nuro) were filed as evidence_gap with three sentences describing a
   * filled form, when the preview screenshots show a job description page and, for Jump Trading, a
   * branded careers page with no form on it at all. */
  | 'form_not_reached'
  /* The run threw and stopped. Every terminal state owes a cause, and before this existed a run
   * could end in status 'failed' with attention_reason unset, which is unactionable for the
   * applicant and undebuggable for us. */
  | 'run_failed'
  | 'required_document'
  | 'sensitive_attestation'
  | 'required_field'
  | 'evidence_gap'
  | 'cover_letter'
  | 'unknown';

export function normalizeApplicationReviewQuestions(
  questions: readonly ApplicationReviewQuestion[],
): ApplicationReviewQuestion[] {
  const normalized: ApplicationReviewQuestion[] = [];
  const indexByQuestion = new Map<string, number>();
  for (const question of questions) {
    const key = questionKey(question.question);
    if (!key) {
      normalized.push(question);
      continue;
    }
    const existingIndex = indexByQuestion.get(key);
    if (existingIndex === undefined) {
      indexByQuestion.set(key, normalized.length);
      normalized.push(question);
      continue;
    }
    const existing = normalized[existingIndex];
    const portalSelector = preferredPortalSelector(existing.portal_selector, question.portal_selector);
    const portalInputType = question.portal_input_type ?? existing.portal_input_type;
    const atsApiField = question.ats_api_field ?? existing.ats_api_field;
    if ((question.required && !existing.required) || (!existing.answer.trim() && question.answer.trim())) {
      const next = {
        ...existing,
        required: existing.required || question.required,
        answer: existing.answer.trim() ? existing.answer : question.answer,
      };
      normalized[existingIndex] = {
        ...next,
        ...(portalSelector ? { portal_selector: portalSelector } : {}),
        ...(portalInputType ? { portal_input_type: portalInputType } : {}),
        ...(atsApiField ? { ats_api_field: atsApiField } : {}),
      };
    } else if (
      (portalSelector && portalSelector !== existing.portal_selector)
      || (portalInputType && portalInputType !== existing.portal_input_type)
      || (atsApiField && atsApiField !== existing.ats_api_field)
    ) {
      normalized[existingIndex] = {
        ...existing,
        ...(portalSelector ? { portal_selector: portalSelector } : {}),
        ...(portalInputType ? { portal_input_type: portalInputType } : {}),
        ...(atsApiField ? { ats_api_field: atsApiField } : {}),
      };
    }
  }
  return normalized;
}

export function mergeSubmittedApplicationReviewQuestions(
  stored: readonly ApplicationReviewQuestion[],
  submitted: readonly ApplicationReviewQuestion[],
): ApplicationReviewQuestion[] {
  const submittedByQuestion = new Map<string, ApplicationReviewQuestion>();
  for (const question of submitted) {
    const key = questionKey(question.question);
    if (key) submittedByQuestion.set(key, question);
  }
  const merged = stored.map((question) => {
    const submittedQuestion = submittedByQuestion.get(questionKey(question.question));
    if (!submittedQuestion) return question;
    const portalSelector = preferredPortalSelector(question.portal_selector, submittedQuestion.portal_selector);
    const portalInputType = submittedQuestion.portal_input_type ?? question.portal_input_type;
    const atsApiField = question.ats_api_field;
    return {
      ...question,
      answer: submittedQuestion.answer,
      kind: submittedQuestion.kind,
      required: question.required || submittedQuestion.required,
      question: submittedQuestion.question.trim() ? submittedQuestion.question : question.question,
      ...(portalSelector ? { portal_selector: portalSelector } : {}),
      ...(portalInputType ? { portal_input_type: portalInputType } : {}),
      ...(atsApiField ? { ats_api_field: atsApiField } : {}),
    };
  });
  const storedKeys = new Set(stored.map((question) => questionKey(question.question)).filter(Boolean));
  for (const question of submitted) {
    const key = questionKey(question.question);
    if (!key || storedKeys.has(key)) continue;
    merged.push(question);
  }
  return normalizeApplicationReviewQuestions(merged);
}

function questionKey(question: string): string {
  return question.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isTemporaryPortalSelector(selector: string | undefined): boolean {
  return selector?.trim().startsWith('[data-litos-discovered-') === true;
}

function preferredPortalSelector(existing: string | undefined, next: string | undefined): string | undefined {
  if (!next) return existing;
  if (!existing || isTemporaryPortalSelector(existing)) return next;
  if (!isTemporaryPortalSelector(next)) return next;
  return existing;
}

export type ApplicationReviewState = {
  jd_text: string;
  role?: string;
  portal_url?: string;
  ats_name?: string;
  status:
    | 'resume_ready'
    | 'questions_ready'
    | 'ready_to_submit'
    | 'submit_requested'
    | 'preparing'
    | 'filling'
    | 'needs_attention'
    | 'ready_for_final_approval'
    | 'submitting'
    | 'submission_claimed'
    | 'submitted'
    | 'failed';
  edited_terms: string[];
  questions: ApplicationReviewQuestion[];
  skipped_reasons: string[];
  updated_at: string;
  submitted_at?: string;
  submission_error?: string;
  submission_run_id?: string;
  browser_context_id?: string;
  browser_session_id?: string;
  attention_reason?: string;
  attention_categories?: ApplicationAttentionCategory[];
  /* The TYPED half of attention_reason, which is prose and always will be.
   *
   * attention_reason is written for a person and is the right thing to show them. It is the wrong
   * thing to count: "how often does a challenge stop us, on which boards, and how long until it
   * clears" cannot be answered by grepping sentences. This is the machine-readable companion.
   * Nothing here is meant for DISPLAY, but it is not server-private either: the whole review object
   * is serialized to the dashboard and the extension, so this reaches clients.
   *
   * stalled_at is the QUEUE'S SORT KEY, not a duplicate of updated_at. updated_at moves on every
   * write, including writes that have nothing to do with the stall, so ordering a "waiting on you"
   * list by it would reshuffle the queue under the applicant. It survives re-observation of the
   * same challenge and only restarts after a resolved stall.
   *
   * A stall is CLOSED (resolved_at), never deleted, when the application stops waiting on a human.
   * See settleStall in applicationStall.ts: deleting it broke the clock and threw away the
   * time-to-resolution measurement. The queue selects on status, so a resolved stall is invisible
   * to it without needing to be destroyed. */
  stall?: {
    kind: 'human_verification';
    stalled_at: string;
    /* Where it stopped, because the two surfaces owe the applicant different next actions: a
     * server run needs them to open the portal themselves, an extension stall is already in front
     * of them. Only 'server_run' is written today; the extension writes 'extension' in step 4. */
    surface: 'server_run' | 'extension';
    provider: 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'turnstile' | 'arkose' | 'unknown';
    /* 'before_fill' means nothing was filled and the form is still blank. Governs which sentence
     * the applicant gets, and stops the queue promising a filled form that does not exist. */
    stage: 'before_fill' | 'at_submit';
    /* Whether the provider was seen on a live page or inferred from the portal family. An inferred
     * label must never be counted as evidence a family really uses that provider. */
    source: 'observed' | 'assumed';
    /* Set when the application stops waiting on a human. Presence means "this stall is over", and
     * resolved_at minus stalled_at is the time-to-resolution the instrumentation needs. */
    resolved_at?: string;
    /* When the applicant was emailed about this one. Written back after a successful send, and the
     * reason the nudge is not a daily letter: without it every open stall re-qualifies on every
     * run, so someone who saw the check and decided not to finish that application would hear about
     * it again every day forever. */
    nudged_at?: string;
  };
  handoff_expires_at?: string;
  final_approved_at?: string;
  cover_letter_supported?: boolean;
  /* Whether Litos can fill in this posting's application page AT ALL, derived from portal_url.
   *
   * Unlike cover_letter_supported, which can only be answered by looking at a live form mid-run,
   * this one is knowable the moment the packet exists - and not knowing it was the bug. Packets on
   * company-owned careers pages sat in the Tracker labelled "Ready" behind a live send button and
   * only revealed themselves after a multi-minute run failed with "This portal is not supported
   * yet". Honest at creation beats honest at minute three.
   *
   * Derived on read (see readApplicationReview) rather than only written at creation, so packets
   * created before this existed answer correctly too, with no migration. */
  portal_supported?: boolean;
  submission_claimed_at?: string;
  submission_claim_id?: string;
  /* WHICH ADDRESS THE EMPLOYER WAS GIVEN, and why that one.
   *
   * Litos prefers a per-application alias so replies come back through the product and can be
   * shown next to the application. On 2026-08-08 the alias domain had no MX record, so the address
   * on every submitted form could not receive mail at all, and nothing anywhere recorded that.
   * The fallback to the applicant's real address is now automatic, and it is written down here
   * because a SILENT fallback is its own defect: `tracked` false means the thread is in her own
   * mailbox and Litos will never see it, and no surface may promise otherwise.
   *
   * Absent on every packet prepared before this shipped, and on packets whose run never reached a
   * prepare step. Absent means unknown, not alias. */
  applicant_email?: {
    address: string;
    source: 'litos_alias' | 'contact_email' | 'account_email';
    /* 'deliverable' when the alias was used; otherwise the measured reason it was not, e.g.
     * 'no_mx_record', 'domain_not_verified_in_resend', 'inbound_route_missing',
     * 'check_unavailable'. */
    reason: string;
    tracked: boolean;
    decided_at: string;
  };
  filled_fields?: string[];
  preview_screenshot_url?: string;
  submission_authorization?: {
    source: 'standing_consent' | 'per_application_approval' | 'user_initiated_extension';
    authorized_at: string;
    consented_at?: string;
    consent_version?: string;
  };
  verification?: {
    status: 'not_needed' | 'searching' | 'completed' | 'handoff';
    provider?: 'gmail' | 'outlook';
    completed_at?: string;
  };
  receipt?: {
    confirmation_text: string;
    final_url: string;
    screenshot_url?: string;
    captured_at: string;
    reference_id?: string;
    source?: 'managed_browser' | 'chrome_extension' | 'email_fallback' | 'ats_api' | 'attended_handoff';
  };
};

const TERM_RE = /[A-Za-z][A-Za-z0-9+#./-]*/g;
const STOPWORDS = new Set(
  'the a an and or but to of in on for with from by as at is are was were be been being this that these those your our their'.split(
    ' ',
  ),
);

function terms(value: string): string[] {
  return (value.match(TERM_RE) ?? [])
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 2 && !STOPWORDS.has(term));
}

function overlapScore(left: string, right: string): number {
  const a = new Set(terms(left));
  const b = new Set(terms(right));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

/**
 * The words this job's tailoring is responsible for, in the resume as rendered.
 *
 * TWO THINGS COUNT AS TAILORING AT THE BULLET LAYER, and for a long time this function could only
 * see one of them.
 *
 * 1. REWORDING. A rendered bullet says something its source variant did not. Those words are the
 *    diff, and finding them is what this function was originally written to do.
 *
 * 2. SELECTION. Measured 2026-08-08 over the 25 most recent real packets: 245 of 267 rendered
 *    bullets are BYTE-IDENTICAL to a stored experience-bank variant, and the 22 that are not reduce
 *    to one bullet whose only difference is an em dash written as a comma. Tailoring below the
 *    skills line is not rewriting, it is CHOOSING which of the student's own phrasings to put on
 *    this page, which is exactly what gapEvidence.ts means by "SELECTION, NOT INVENTION". So
 *    rewording found nothing to report, `edited_terms` came back `[]` on all 25 - honestly - and
 *    the green tone in the review legend ("wording Litos changed for this job") had never rendered
 *    on a real packet. A student was shown a swatch for a colour that does not exist.
 *
 * WHAT MAKES A SELECTION ATTRIBUTABLE TO THIS JOB, and what stops this from fabricating one.
 * `bullet_variants` is ordered, and its head is the student's own default phrasing: it is what the
 * base resume renders (llm/baseResume.ts) and what the deterministic floor fills from
 * (engine/resumePolicy.ts enforceExperienceBulletFloor). So the bullets any job would have got are
 * `variants.slice(0, renderedCount)`. A rendered bullet sourced from OUTSIDE that prefix is one the
 * JD reached past the default to pick, and the words that carry the difference are the ones in it
 * that the default set never says. A bullet whose source IS in the default prefix reports nothing,
 * because nothing about this job caused it, which is the rule "do not mark a bullet as edited when
 * the same variant would have been chosen for any job".
 *
 * An entry with one variant, or one whose variants are all on the page, can produce no selection
 * edit at all: there was no choice to make. Every reported word is a word the student wrote and the
 * page actually shows. Grounding is still enforced by resumeValidate.ts; this is metadata for the
 * review UI only.
 */
export function deriveEditedTerms(
  spec: ResumeSpec,
  bank: ExperienceBankEntry[],
): string[] {
  const introduced = new Map<string, string>();

  for (const entry of spec.experience) {
    const sourceEntry = bank.find(
      (candidate) => candidate.org.trim().toLowerCase() === entry.org.trim().toLowerCase(),
    );
    if (!sourceEntry) continue;

    const variants = Array.isArray(sourceEntry.bullet_variants)
      ? sourceEntry.bullet_variants.filter((item): item is string => typeof item === 'string')
      : [];

    // What this entry would have rendered for any job at all, and every word it would have said.
    const defaultChoice = variants.slice(0, entry.bullets.length);
    const defaultTerms = new Set(defaultChoice.flatMap((variant) => terms(variant)));
    const isDefaultChoice = (variant: string) => defaultChoice.includes(variant);

    for (const bullet of entry.bullets) {
      const source = variants
        .map((variant) => ({ variant, score: overlapScore(bullet, variant) }))
        .sort((a, b) => b.score - a.score)[0]?.variant;
      if (!source) continue;

      // Rewording: what the page says that its own source variant does not.
      // Selection: what the page says that the default set never would have said. Only for a
      // bullet the JD reached past the default to pick, so a default bullet reports nothing.
      const baseline = isDefaultChoice(source)
        ? new Set(terms(source))
        : new Set([...terms(source)].filter((term) => defaultTerms.has(term)));

      for (const rendered of bullet.match(TERM_RE) ?? []) {
        const normalized = rendered.toLowerCase();
        if (
          normalized.length > 2 &&
          !STOPWORDS.has(normalized) &&
          !baseline.has(normalized)
        ) {
          introduced.set(normalized, rendered);
        }
      }
    }
  }

  return [...introduced.values()].slice(0, 80);
}

export function readApplicationReview(spec: unknown): ApplicationReviewState | null {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const review = (spec as Record<string, unknown>)._review;
  if (!review || typeof review !== 'object' || Array.isArray(review)) return null;
  const state = review as ApplicationReviewState;
  // Derived here, at the one choke point every caller already goes through, so a packet stored
  // before portal_supported existed still answers the question correctly and no backfill migration
  // is needed. A stored value always wins: this only fills a gap, it never overrides a decision.
  if (state.portal_supported === undefined && state.portal_url) {
    return { ...state, portal_supported: isPortalSupported(state.portal_url) };
  }
  return state;
}

export type ApplicationReviewEdit = {
  ats_name?: string;
  portal_url?: string;
  questions: ApplicationReviewQuestion[];
  skipped_reasons: string[];
};

/**
 * The third write path for portal_supported, and the one that can contradict itself.
 *
 * Creation writes the flag from the URL it was handed, and readApplicationReview derives it for
 * packets stored before the field existed. An EDIT is different: the body carries a new portal_url
 * and no portal_supported, so merging it over the stored review leaves the old verdict sitting next
 * to the new URL, and then persists it. Persisting is what makes it permanent, because the
 * derivation above only fills a gap: once the value is defined it is never recomputed, so re-saving
 * the URL cannot repair it.
 *
 * Both directions are wrong, but they are not equally bad. Supported edited to unsupported shows a
 * live send button on a packet that cannot be filled, and submit-request already refuses that in
 * front of the run. Unsupported edited to a working Greenhouse URL is the trap: the dashboard gates
 * the send button on this exact field, so a packet that would now submit fine is locked out with no
 * self-serve way back. Re-derive from the URL that is actually being stored.
 */
export function applyApplicationReviewEdit(
  current: ApplicationReviewState,
  edit: ApplicationReviewEdit,
): ApplicationReviewState {
  const canonicalPortalUrl = edit.portal_url === undefined
    ? undefined
    : canonicalSupportedPortalUrl(edit.portal_url, edit.ats_name ?? current.ats_name) ?? edit.portal_url;
  return {
    ...current,
    ...edit,
    ...(canonicalPortalUrl === undefined ? {} : {
      portal_url: canonicalPortalUrl,
      ats_name: isPortalSupported(canonicalPortalUrl) ? detectPortal(canonicalPortalUrl) : edit.ats_name ?? current.ats_name,
    }),
    // Only when the edit carries a URL. Deriving from an absent one would write false over a
    // perfectly good stored true, which is the same lockout arriving by a different door.
    ...(canonicalPortalUrl === undefined ? {} : { portal_supported: isPortalSupported(canonicalPortalUrl) }),
    status: edit.questions.length > 0 ? 'questions_ready' : 'ready_to_submit',
    updated_at: new Date().toISOString(),
  };
}
