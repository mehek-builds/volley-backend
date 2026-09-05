/* LITOS VERIFIES AN UNVERIFIED SEND ON ITS OWN.
 *
 * Mehek, 2026-09-05: "bake it into litos to do an external employer-page check to verify a
 * submission; not requiring user input just on litos' end." Until this file, a press whose page never
 * showed a receipt parked the packet at unverified_submission and the card told the applicant to open
 * the employer's page, look, and press one of two buttons. That is the one trip out of the dashboard
 * this product promises she never has to make.
 *
 * WHAT THIS SWEEP DOES, in the order the evidence is trusted, for every packet still parked at an
 * unresolved unverified_submission:
 *
 *   1. RE-READ THE STORED SUBMIT RESPONSE. The runner recorded the press-window network around the
 *      press (unverified_submission.network). exactManagedSubmitVerdict now reads a bound 2xx on the
 *      posting's own submit endpoint as the employer accepting (employerSubmitAcceptanceProof), so a
 *      record written before that rule existed, or one whose receipt arm simply missed, is settled
 *      from the wire: submission_confirmed on the ledger, `submitted` on the row, receipt on the
 *      card. Nothing is asked of anyone.
 *
 *   2. NAME WHAT THE RUNNER'S OWN RECORD SAYS, WITHOUT CLOSING ON IT. Two shapes say the press very
 *      likely never reached the employer: the runner's endpoint binding existed and no request ever
 *      matched it (submit_request_seen === false), or every request went to the human-check vendor
 *      and none to the employer (pressReachedOnlyChallengePlatform). The sweep carries that onto the
 *      card, but it does NOT write a not-sent proof for it: the ledger admits, after
 *      boundary_authorized, only the applicant's own look and the employer server's own refusal
 *      (AUTHORIZATION_ADMISSIBLE_NOT_SENT_PROOFS in submissionAttemptLedger.ts), and stratus's own
 *      comment on submit_request_seen lists the ways a false "false" can still happen (a beacon
 *      Chromium never surfaces, a popup page, the deadline race). Releasing on it would risk the
 *      duplicate application the whole ledger exists to prevent. Measured 2026-09-05 16:34Z: the
 *      first production pass tried exactly that release and the ledger's own safety recomputation
 *      refused it (VERIFICATION_SWEEP_NOT_SENT_FACT_INCOMPLETE, rolled back) - the rule held.
 *
 *   3. LOOK AT THE EMPLOYER'S PAGE ITSELF. A read-only managed run (allowSubmit false, no actions)
 *      opens the page the press landed on, reads it, and keeps the reading as evidence on the record
 *      (employer_page_checks): a receipt still on screen, an "already applied" marker, a posting the
 *      employer has since closed, or - the common honest case - the form open again with no record of
 *      any application (public boards do not show applicants their submissions). This is what the
 *      card used to ask HER to do. It changes the card's sentence from an instruction to a report:
 *      when Litos looked, what it saw, and that it keeps watching.
 *
 *   4. THE INBOX, through the existing reconciler. reconcileSubmissionConfirmations already files an
 *      authenticated employer confirmation against the packet; the sweep runs it for each account it
 *      touched so a confirmation that arrived between webhook deliveries is not left for the 3-hourly
 *      job.
 *
 * WHAT IT NEVER DOES. It never presses anything (the page check carries no actions and no submit
 * authority), never marks a packet submitted from a page marker alone (an "already applied" banner
 * on a fresh browser session is not bound to HER application - it is recorded, not acted on), never
 * releases an attempt while its boundary lease is live, and never overrides a resolution the
 * applicant already recorded. Every write runs under the same per-user ledger lock and the same
 * ledger-safety recomputation as the applicant's own resolution route. */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { generated_resumes } from '../db/schema';
import { applyReviewPatch } from './applicationStall';
import { readApplicationReview, type ApplicationReviewState } from './applicationReview';
import {
  exactManagedSubmitVerdict,
  pressReachedOnlyChallengePlatform,
  type ManagedReceiptResult,
} from './managedSubmitOutcome';
import { detectPortal, portalApplicationUrl } from './portalSubmission';
import {
  appendSubmissionAttemptEvent,
  lockSubmissionAttemptUser,
  submissionAttemptBindingFromEvent,
  submissionAttemptEventId,
  submissionAttemptEventsForPacket,
  submissionAttemptRetrySafety,
} from './submissionAttemptLedger';
import { syncCanonicalApplicationRow } from './canonicalApplicationSync';
import {
  authoritativeConfirmedProjectionMatches,
  authoritativeSubmissionProjection,
} from './authoritativeSubmissionProjection';
import { runManagedBrowser, type ManagedBrowserResult } from './browserbase';
import { withProviderCallFence } from './submissionAccountFence';
import { storeReceiptScreenshot } from './receiptScreenshot';
import { reconcileSubmissionConfirmations } from './applicationEmail';

export type UnverifiedSubmissionRecord = NonNullable<ApplicationReviewState['unverified_submission']>;
export type EmployerPageCheck = NonNullable<UnverifiedSubmissionRecord['employer_page_checks']>[number];
export type EmployerPageCheckOutcome = EmployerPageCheck['outcome'];

/* THE SCHEDULE. Three looks, spaced so the first catches a receipt that rendered a moment after the
 * runner stopped watching, the second a slow employer, the third the next working day - after which
 * the inbox reconciler is the only thing left that can settle it, and it keeps running on its own. */
export const EMPLOYER_PAGE_CHECK_OFFSETS_MS: readonly number[] = [5 * 60_000, 60 * 60_000, 24 * 60 * 60_000];
export const EMPLOYER_PAGE_CHECK_LIMIT = EMPLOYER_PAGE_CHECK_OFFSETS_MS.length;

const RECEIPT_ON_PAGE = /\bthank(?:s| you) for (?:submitting|applying|your application)\b|\b(?:your )?application (?:has been |was )?(?:successfully )?(?:submitted|received|sent)\b|\bwe(?: have|'ve)? received your application\b|\bsuccessfully (?:submitted|applied)\b/i;
const APPLIED_MARKER = /\b(?:you(?:'ve| have) already applied|already applied (?:to|for) this|you have already submitted|application already (?:submitted|received|exists)|duplicate application)\b/i;
const POSTING_CLOSED = /\b(?:this (?:job|position|posting|role) (?:is )?(?:no longer|not) (?:available|accepting|open)|no longer accepting applications|position has been filled|this job has (?:been )?(?:closed|filled|expired)|job not found|posting (?:has )?expired|applications (?:are )?closed)\b/i;
const FORM_MARKERS = /\b(?:first name|last name|resume\/cv|resume|cover letter|submit application|apply for this job|phone)\b/i;

export function classifyEmployerPage(text: string | null | undefined): EmployerPageCheckOutcome {
  const body = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!body) return 'unreadable';
  if (APPLIED_MARKER.test(body)) return 'applied_marker';
  if (RECEIPT_ON_PAGE.test(body) && !FORM_MARKERS.test(body)) return 'receipt_visible';
  if (POSTING_CLOSED.test(body)) return 'posting_closed';
  if (FORM_MARKERS.test(body)) return 'form_open_no_record';
  return 'unreadable';
}

export function employerPageCheckDue(
  record: Pick<UnverifiedSubmissionRecord, 'at' | 'employer_page_checks'>,
  nowMs: number,
): boolean {
  const done = record.employer_page_checks?.length ?? 0;
  if (done >= EMPLOYER_PAGE_CHECK_LIMIT) return false;
  const pressedAt = Date.parse(record.at);
  if (!Number.isFinite(pressedAt)) return false;
  return nowMs - pressedAt >= EMPLOYER_PAGE_CHECK_OFFSETS_MS[done]!;
}

export type UnverifiedAutoDecision =
  | { kind: 'confirm'; confirmationText: string; evidence: string }
  | { kind: 'no_verdict' };

/* What the runner's own record says about whether the press reached the employer at all. Copy only:
 * see step 2 in the file header for why this never becomes a ledger proof. */
export function providerRecordSaysNothingLeft(
  record: Pick<UnverifiedSubmissionRecord, 'submit_request_seen' | 'network'>,
  portalUrl: string | undefined,
): 'submit_request_never_issued' | 'challenge_only_transport' | null {
  if (record.submit_request_seen === false) return 'submit_request_never_issued';
  if (pressReachedOnlyChallengePlatform(record.network ?? null, portalUrl)) return 'challenge_only_transport';
  return null;
}

/* Step 1 as one pure reading of the stored record, so a test can pin every branch without a
 * database. */
export function unverifiedAutoDecision(
  record: UnverifiedSubmissionRecord,
  portalUrl: string | undefined,
): UnverifiedAutoDecision {
  if (record.resolution) return { kind: 'no_verdict' };
  const applicationUrl = (() => {
    if (!portalUrl) return null;
    try {
      return portalApplicationUrl(detectPortal(portalUrl), portalUrl);
    } catch {
      return null;
    }
  })();
  if (applicationUrl && record.network && record.network.length > 0) {
    const result: ManagedReceiptResult = {
      url: record.final_url ?? applicationUrl,
      submitOutcome: {
        pressed: true,
        state: 'unknown',
        source: null,
        evidence: null,
        message: record.observed_page_text ?? null,
        formStillPresent: null,
        network: record.network,
      },
    };
    const verdict = exactManagedSubmitVerdict(result, applicationUrl);
    if (verdict.kind === 'confirmed' && verdict.evidence.startsWith('employer_submit_response:')) {
      return { kind: 'confirm', confirmationText: verdict.confirmationText, evidence: verdict.evidence };
    }
  }
  return { kind: 'no_verdict' };
}

export function litosVerificationSentence(input: {
  checks: readonly EmployerPageCheck[];
  portalUrl?: string;
  providerRecord?: ReturnType<typeof providerRecordSaysNothingLeft>;
}): string {
  const latest = input.checks[input.checks.length - 1];
  const when = latest ? new Date(latest.checked_at).toISOString().slice(11, 16) + ' UTC' : null;
  const looked = !latest
    ? ''
    : latest.outcome === 'form_open_no_record'
      ? `Litos re-read the employer’s page at ${when}: the form is open again and shows no record of an application - this employer’s page does not show applicants what it has received. `
      : latest.outcome === 'applied_marker'
        ? `Litos re-read the employer’s page at ${when}: it says an application has already been made for this posting, which is consistent with yours having gone through but is not tied to your name, so Litos has not counted it yet. `
        : latest.outcome === 'receipt_visible'
          ? `Litos re-read the employer’s page at ${when} and a confirmation was still on it. `
          : latest.outcome === 'posting_closed'
            ? `Litos re-read the employer’s page at ${when}: the employer has since closed this posting. `
            : `Litos re-read the employer’s page at ${when} but could not read it. `;
  const remaining = EMPLOYER_PAGE_CHECK_LIMIT - input.checks.length;
  const next = remaining > 0
    ? `Litos will look again ${remaining === 1 ? 'once more' : `${remaining} more times`} and keeps watching your application inbox for the employer’s confirmation; `
    : 'Litos keeps watching your application inbox for the employer’s confirmation; ';
  const provider = input.providerRecord === 'submit_request_never_issued'
    ? 'Litos’s own record shows the press never produced a request to the employer’s server, so this very likely did not go through. '
    : input.providerRecord === 'challenge_only_transport'
      ? 'Litos’s own record shows the press only reached the human-verification service, never the employer, so this very likely did not go through. '
      : '';
  return `Litos pressed Send and is verifying this application on its own. ${provider}${looked}${next}`
    + 'the moment either proves it, this application is recorded as sent. Nothing is needed from you. '
    + 'Do not submit it by hand in the meantime, because two applications to the same posting count '
    + 'against you and cannot be taken back. If you already know the answer, the two buttons below record it.';
}

type SweepRow = { id: string; user_id: string; spec: unknown };

export type SubmissionVerificationSweepDeps = {
  listCandidates: (limit: number) => Promise<SweepRow[]>;
  readPage: (input: { userId: string; packetId: string; url: string }) => Promise<ManagedBrowserResult>;
  storeScreenshot: (objectKey: string, body: Buffer) => Promise<{ url: string }>;
  reconcileInbox: (userId: string) => Promise<unknown>;
  now: () => number;
};

async function listUnresolvedUnverifiedPackets(limit: number): Promise<SweepRow[]> {
  return db.select({ id: generated_resumes.id, user_id: generated_resumes.user_id, spec: generated_resumes.spec })
    .from(generated_resumes)
    .where(and(
      sql`${generated_resumes.spec}->'_review'->>'status' = 'needs_attention'`,
      sql`${generated_resumes.spec}->'_review'->'unverified_submission' is not null`,
      sql`${generated_resumes.spec}->'_review'->'unverified_submission'->>'resolution' is null`,
      sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' is not null`,
    ))
    .orderBy(sql`${generated_resumes.spec}->'_review'->'unverified_submission'->>'at' asc`)
    .limit(limit);
}

const productionDeps: SubmissionVerificationSweepDeps = {
  listCandidates: listUnresolvedUnverifiedPackets,
  readPage: ({ userId, url }) => withProviderCallFence(userId, () => runManagedBrowser(url, [], {
    screenshot: true,
    allowSubmit: false,
    timeoutMs: 60_000,
  })),
  storeScreenshot: (objectKey, body) => storeReceiptScreenshot(objectKey, body),
  reconcileInbox: (userId) => reconcileSubmissionConfirmations({ userId, limit: 50 }),
  now: () => Date.now(),
};

export type SweepOutcome =
  | 'confirmed_from_response'
  | 'page_checked'
  | 'page_check_failed'
  | 'not_due'
  | 'skipped'
  | 'error';

function reviewSpec(spec: unknown, review: ApplicationReviewState) {
  return { ...(spec as Record<string, unknown>), _review: review };
}

async function applyStoredEvidence(row: SweepRow, decision: UnverifiedAutoDecision, nowIso: string): Promise<SweepOutcome> {
  return db.transaction(async (tx): Promise<SweepOutcome> => {
    await lockSubmissionAttemptUser(tx, row.user_id);
    const [locked] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, row.user_id),
    )).limit(1).for('update');
    const current = locked ? readApplicationReview(locked.spec) : null;
    const pending = current?.unverified_submission;
    if (!locked || !current || !pending || pending.resolution || current.status !== 'needs_attention') return 'skipped';
    const claimId = current.submission_claim_id;
    if (!claimId) return 'skipped';
    const events = (await submissionAttemptEventsForPacket(row.user_id, locked.id, { executor: tx }))
      .filter((event) => event.attempt_id === claimId);
    const opening = events.find((event) => event.event_kind === 'attempt_opened');
    if (!opening || opening.submission_claim_id !== claimId || !opening.application_id) return 'skipped';
    if (submissionAttemptRetrySafety(events).kind !== 'blocked_unverified') return 'skipped';
    const binding = submissionAttemptBindingFromEvent(opening);
    const observedAt = new Date(nowIso);

    if (decision.kind === 'confirm') {
      const finalUrl = pending.final_url ?? pending.portal_url ?? current.portal_url;
      if (!finalUrl) return 'skipped';
      await appendSubmissionAttemptEvent({
        ...binding,
        eventId: submissionAttemptEventId(claimId, 'submission_confirmed', 'employer-submit-response'),
        eventKind: 'submission_confirmed',
        evidenceCode: 'employer_submit_response',
        observedAt,
      }, { executor: tx });
      const next = applyReviewPatch(current, {
        status: 'submitted',
        submitted_at: nowIso,
        submission_error: undefined,
        attention_reason: undefined,
        attention_categories: undefined,
        unverified_submission: { ...pending, resolution: 'sent', resolved_at: nowIso },
        receipt: {
          confirmation_text: decision.confirmationText,
          final_url: finalUrl,
          captured_at: nowIso,
          source: 'managed_browser',
        },
      }, () => nowIso);
      const [updated] = await tx.update(generated_resumes).set({
        spec: reviewSpec(locked.spec, next),
        pipeline_stage: 'applied',
        pipeline_stage_at: observedAt,
      }).where(and(
        eq(generated_resumes.id, locked.id),
        eq(generated_resumes.user_id, row.user_id),
        sql`${generated_resumes.spec} = ${JSON.stringify(locked.spec)}::jsonb`,
      )).returning({ id: generated_resumes.id });
      if (!updated) throw new Error('VERIFICATION_SWEEP_CONFIRM_WRITE_CONFLICT');
      await syncCanonicalApplicationRow({
        attemptId: claimId,
        packetId: locked.id,
        userId: row.user_id,
        applicationId: binding.applicationId,
        packetVersion: binding.packetVersion,
        postingIdentity: binding.postingIdentity,
      }, tx);
      const canonicalId = binding.applicationId!;
      const projections = await authoritativeSubmissionProjection({
        userId: row.user_id,
        packetIds: [locked.id],
        applicationIds: [canonicalId],
        executor: tx,
      });
      const exact = { attemptId: claimId, canonicalApplicationId: canonicalId, packetId: locked.id };
      if (!authoritativeConfirmedProjectionMatches(projections.byPacketId.get(locked.id), exact)
        || !authoritativeConfirmedProjectionMatches(projections.byApplicationId.get(canonicalId), exact)) {
        throw new Error('VERIFICATION_SWEEP_CONFIRMATION_PROJECTION_INCOMPLETE');
      }
      return 'confirmed_from_response';
    }

    return 'skipped';
  });
}

async function recordEmployerPageCheck(
  row: SweepRow,
  check: EmployerPageCheck,
  providerRecord: ReturnType<typeof providerRecordSaysNothingLeft>,
): Promise<SweepOutcome> {
  return db.transaction(async (tx): Promise<SweepOutcome> => {
    await lockSubmissionAttemptUser(tx, row.user_id);
    const [locked] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, row.user_id),
    )).limit(1).for('update');
    const current = locked ? readApplicationReview(locked.spec) : null;
    const pending = current?.unverified_submission;
    if (!locked || !current || !pending || pending.resolution || current.status !== 'needs_attention') return 'skipped';
    const checks = [...(pending.employer_page_checks ?? []), check].slice(-EMPLOYER_PAGE_CHECK_LIMIT);
    const next = applyReviewPatch(current, {
      unverified_submission: { ...pending, employer_page_checks: checks },
      attention_reason: litosVerificationSentence({ checks, portalUrl: pending.portal_url ?? current.portal_url, providerRecord }),
      attention_categories: ['unverified_submission'],
    }, () => check.checked_at);
    const [updated] = await tx.update(generated_resumes).set({ spec: reviewSpec(locked.spec, next) }).where(and(
      eq(generated_resumes.id, locked.id),
      eq(generated_resumes.user_id, row.user_id),
      sql`${generated_resumes.spec} = ${JSON.stringify(locked.spec)}::jsonb`,
    )).returning({ id: generated_resumes.id });
    if (!updated) throw new Error('VERIFICATION_SWEEP_PAGE_CHECK_WRITE_CONFLICT');
    return 'page_checked';
  });
}

export async function runSubmissionVerificationSweep(
  input: { limit?: number } = {},
  overrides: Partial<SubmissionVerificationSweepDeps> = {},
): Promise<{ scanned: number; outcomes: Record<SweepOutcome, number> }> {
  const deps = { ...productionDeps, ...overrides };
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const rows = await deps.listCandidates(limit);
  const outcomes: Record<SweepOutcome, number> = {
    confirmed_from_response: 0, page_checked: 0, page_check_failed: 0, not_due: 0, skipped: 0, error: 0,
  };
  const touchedUsers = new Set<string>();
  for (const row of rows) {
    const review = readApplicationReview(row.spec);
    const record = review?.unverified_submission;
    if (!review || !record || record.resolution) { outcomes.skipped += 1; continue; }
    touchedUsers.add(row.user_id);
    const nowMs = deps.now();
    const nowIso = new Date(nowMs).toISOString();
    let outcome: SweepOutcome;
    /* One packet's failure must not abort the pass: every row is its own transaction, and a throw
     * here would 500 the whole route and starve every later row on every later pass. */
    try {
      const decision = unverifiedAutoDecision(record, record.portal_url ?? review.portal_url);
      if (decision.kind === 'confirm') {
        outcome = await applyStoredEvidence(row, decision, nowIso);
        if (outcome !== 'skipped') { outcomes[outcome] += 1; continue; }
      }
    } catch {
      outcomes.error += 1;
      continue;
    }
    if (!employerPageCheckDue(record, nowMs)) { outcomes.not_due += 1; continue; }
    const url = record.final_url ?? record.portal_url ?? review.portal_url;
    if (!url) { outcomes.skipped += 1; continue; }
    try {
      const page = await deps.readPage({ userId: row.user_id, packetId: row.id, url });
      let screenshotUrl: string | undefined;
      if (page.screenshot) {
        try {
          const blob = await deps.storeScreenshot(
            `users/${row.user_id}/submission-verification/${row.id}/${nowMs}.png`,
            Buffer.from(page.screenshot, 'base64'),
          );
          screenshotUrl = blob.url;
        } catch { /* the reading stands without its picture */ }
      }
      const providerRecord = providerRecordSaysNothingLeft(record, record.portal_url ?? review.portal_url);
      const check: EmployerPageCheck = {
        checked_at: nowIso,
        url: (typeof page.url === 'string' && page.url ? page.url : url).slice(0, 2000),
        outcome: classifyEmployerPage(page.text),
        ...(page.text ? { page_text_excerpt: page.text.replace(/\s+/g, ' ').trim().slice(0, 600) } : {}),
        ...(screenshotUrl ? { screenshot_url: screenshotUrl } : {}),
      };
      outcome = await recordEmployerPageCheck(row, check, providerRecord);
    } catch {
      outcome = 'page_check_failed';
    }
    outcomes[outcome] += 1;
  }
  for (const userId of touchedUsers) {
    try { await deps.reconcileInbox(userId); } catch { /* the 3-hourly reconciler covers it */ }
  }
  return { scanned: rows.length, outcomes };
}
