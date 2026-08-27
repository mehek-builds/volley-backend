/* THE PACKET WHOSE FROZEN JOB DESCRIPTION IS AN APPLICATION FORM, REPAIRED FROM THE BOARD'S OWN
 * COPY OF THE POSTING - NEVER FROM A SECOND GUESS AT THE PAGE.
 *
 * WHAT WENT WRONG. POST /jobs/extract renders a pasted posting URL and stores `extract: 'body'` -
 * the WHOLE rendered page - after one check: `if (!jdText)`. Non-empty was the entire bar. The
 * route already knew that was not enough for exactly one board: jobDescriptionSourceUrl rewrites
 * Workable application URLs because "Workable's application route contains form labels, not the job
 * description". Other boards reach the same page shape through URLs that rewrite never saw.
 *
 * THE INTAKE HALF IS ALREADY FIXED AND DEPLOYED, at main fbd4379, by another session: the route now
 * refuses when leadRequirementCandidates states no ask, and separates `job_extract_no_requirements`
 * from `job_extract_truncated_past_description` for a page whose description was pushed past the
 * 20k cap. That guard is not restated here. This file is the other half - the rows frozen before it
 * shipped - plus, in routes/jobExtract.ts, the Lever apply-route derivation that stops the exact URL
 * shape below from being turned into a packet in the first place.
 *
 * MEASURED ON THE OWNER'S OWN ACCOUNT, packet c4413bff (Belvedere Trading, Lever, 2026-08-26). Its
 * frozen jd_text was 20,000 characters - exactly MAX_JD_TEXT_CHARS, the truncation ceiling - and
 * what filled it was the application form: "SUBMIT YOUR APPLICATION", "LinkedIn profile",
 * "Loading...", "Authorize sharing", and then roughly three thousand university names from a `Name
 * of School` dropdown, which consumed the whole budget before the posting's own text was reached.
 * The review screen scored it "Not much overlap - 1 of 12 requirements we counted", and its
 * requirement-gap list read `Japanese Red`, `Red Cross`, `Nursing`, `British Columbia`, `LinkedIn
 * URL`, `Loading`. Every one of those is a dropdown option. None is a job requirement.
 *
 * INCIDENCE IS LOW. Seventeen of the owner's packets were sampled through her own dashboard API and
 * exactly one was corrupted; Jump Trading, Databricks, Optiver, Deepgram, Flow Traders, cresta,
 * Redwood, Quandela and Faire all hold genuine descriptions. This is a correctness repair for a
 * handful of rows, not a migration, and it is built to refuse rather than to reach.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * THE TWO ROW SHAPES, BOTH MEASURED, AND WHY ONE SOURCE ANSWERS BOTH.
 *
 *   JANE STREET (packet 496cff97, Greenhouse). Its stored portal_url is ALREADY the canonical
 *   job-boards.greenhouse.io page; only the text frozen from it was bad. Re-rendering that stored
 *   URL through the deployed route returns HTTP 200 and 2,908 characters of real description.
 *
 *   BELVEDERE (packet c4413bff, Lever). Its stored portal_url IS the apply route -
 *   jobs.lever.co/belvederetrading/10746b3d-1760-4573-9b63-b93f5a5e4fc0/apply - so re-rendering it
 *   would scrape the same form again and be refused by the deployed guard: correct, and useless.
 *
 * BOTH SHAPES ARE ANSWERED BY THREE TIERS, tried cheapest and most tightly bound first.
 *
 *   1. monitored_jobs.description, the row job_context.job_id names. No network, no render, and the
 *      strongest binding there is - the packet's own pointer at the board row it was generated from.
 *   2. THE BOARD'S OWN PUBLIC API, keyed on the posting id, through the same fetchSourceJobs and
 *      normalizers the daily poll uses. The posting-id parsers read straight THROUGH an apply route
 *      - leverPostingFromUrl answers {belvederetrading, 10746b3d-...} for the apply URL and the
 *      overview alike - so both row shapes collapse into one lookup here. It returns the employer's
 *      own description field with no page chrome in it, costs no managed-browser run, and cannot be
 *      stopped by a bot wall.
 *   3. RE-EXTRACTION from jobDescriptionSourceUrl(portal_url), which is the path actually MEASURED
 *      on Belvedere: main eb8d319 added Lever's overview derivation and the session that shipped it
 *      confirmed live that the stored apply URL 502s while the derived overview returns 200 with
 *      6,251 characters of genuine description. Tiers 1 and 2 are better sources but neither has
 *      been checked against Belvedere's live board; this one has. It is also the only tier that can
 *      reach a provider with no board endpoint in this codebase.
 *
 * TIER 3 IS CLIPPED AT MAX_JD_TEXT_CHARS, NOT AT MAX_REPAIRED_JD_CHARS, because it performs exactly
 * the operation POST /jobs/extract performs and must not produce a row the route could not have
 * produced. That clip is what broke Belvedere - three thousand <select> options ate the budget - and
 * the acceptance test runs on the CLIPPED text, so a page that still truncates past its description
 * states no ask and is refused, which is the same answer the deployed guard gives it live.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * THE THREE QUESTIONS THIS FILE ANSWERS, AND WHY EACH ANSWER IS THE NARROW ONE.
 *
 * 1. IS THIS ROW CORRUPTED? Asked with leadRequirementCandidates, the SAME predicate the intake
 *    guard in routes/jobExtract.ts now refuses on, and the same one leadAlignment already uses to
 *    decide that a posting "contains no supported primary ask". A second private heuristic here -
 *    a list of form labels, a "does this read like a description" score - would be a fourth
 *    definition of what a requirement is, free to drift from the three that exist. See
 *    packetJdStatesNoRequirement for what this deliberately does NOT test.
 *
 * 2. WHERE IS THE REAL DESCRIPTION? From the board that published it, asked by posting id - not by
 *    rendering a page again. See THE TWO ROW SHAPES below for why that choice covers both of them.
 *
 * 3. IS THIS ROW SAFE TO REWRITE? Answered by packetJdIsRepairable, which is the gate from
 *    lib/packetApplicantEmailBackfill.ts (branch fix/backfill-applicant-alias) rather than a new
 *    one. That gate took three review rounds to reach, each round adding a broader definition of
 *    "already at an employer", and re-deriving it here would have started that count again.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * WHAT A REPAIR COSTS, STATED PLAINLY, BECAUSE IT IS NOT FREE.
 *
 *   - PACKET IDENTITY CHANGES. `jdSha256` is one of packetBindings' inputs and packet_version is a
 *     hash over all of them, so rewriting jd_text changes packet_version. Any stored
 *     packet_audit_acknowledgement for this row goes `packet_stale` and the applicant must approve
 *     the packet again. That is correct rather than unfortunate: what she approved was a resume
 *     scored against a form, and she is entitled to see the real one before it is sent.
 *
 *   - THE PACKET BECOMES UNSENDABLE UNTIL IT IS REGENERATED, and this is the important one.
 *     `spec.lead_alignment.jd_hash` is monitoredDescriptionHash of the OLD text, so
 *     runnerLeadAlignmentIssues answers "lead_alignment.jd_hash does not match the frozen job
 *     description used by this packet" and withholdInvalidLeadAlignment parks the row at
 *     needs_attention with "Regenerate or edit it before sending." A repaired packet therefore
 *     needs a fresh tailoring pass - which is a MODEL call, and both provider keys currently report
 *     `model_reason: "credit"`. So a repair run today leaves a correct description on a packet that
 *     cannot be sent until credit is restored and the resume is regenerated. Nothing here tries to
 *     paper over that by rewriting lead_alignment: fabricating a citation hash for a description
 *     the model never read is exactly the failure leadAlignment exists to prevent.
 *
 *   - QUESTION ANSWERS MAY MOVE LATER. jd_text is not hashed into questionsSha256 directly, but it
 *     is half of applicationContextForQuestionResolution, which refreshKnownQuestionAnswers
 *     resolves against on every history read. An answer that was resolved against form labels can
 *     resolve differently against the real posting, which changes `questions` and therefore
 *     packet_version a second time, at a moment this repair does not control.
 *
 * WHAT IS WRITTEN: `_review.jd_text` and `job_context.jd_hash`, and nothing else. The jd_hash is
 * written in the same breath because generation computes it AS sha256(jd_text).slice(0,16) - the
 * same function as monitoredDescriptionHash - and leaving the two disagreeing would silently break
 * monitoredJdAgrees, which is what lets applicationPortalRepair recover a portal URL.
 *
 * `_review.edited_terms` is deliberately NOT cleared even though the Belvedere row's terms were
 * drawn from a dropdown. packetAuditService reads them as a normalised STRING set and only reports
 * terms it can locate as an exact occurrence inside the current jd_text; a term that no longer
 * appears there simply never becomes an occurrence. They are inert, and clearing them would be a
 * second decision about the applicant's edits that this repair has no standing to make.
 *
 * NOTHING HERE IS WIRED TO A ROUTE, A CRON OR A READ PATH, and that is a decision, not an omission.
 * A repair that changes what a packet says the job is must be something the applicant asks for and
 * can see the result of, not something that happens under her while she reads a list. The planner
 * is pure and the executor is one owner-scoped CAS write; wiring is the owner's call.
 */
import { and, eq, or, sql } from 'drizzle-orm';
import { jobDescriptionSourceUrl, MAX_JD_TEXT_CHARS } from '../routes/jobExtract';
import { runManagedBrowser } from './browserbase';
import { db } from '../db/index';
import {
  application_artifacts,
  applications,
  artifacts,
  career_page_sources,
  generated_resumes,
  monitored_jobs,
} from '../db/schema';
import { leadRequirementCandidates } from '../engine/leadAlignment';
import { readApplicationReview, type ApplicationReviewState } from './applicationReview';
import { ashbyPostingFromUrl, leverPostingFromUrl } from './atsSubmissionChannels';
import { companyIdentity } from './companyIdentity';
import { isLegacyUnverifiedAttemptReason } from './duplicateApplication';
import { packetHasExtensionSubmissionOutcomeEvent } from './expiredHandoffClaimRelease';
import { greenhousePostingFromUrl } from './greenhousePublicApplication';
import { statesNoRequirement } from './jobDescriptionShape';
import { fetchSourceJobs, isIngestablePosting, type SupportedJobBoard } from './jobMonitor';
import { employerMayHoldApplication } from './managedSubmitOutcome';
import { monitoredDescriptionHash } from './monitoredPortalRepair';

type ResumeRow = typeof generated_resumes.$inferSelect;
type StoredSpec = Record<string, unknown>;

/* The same ceiling applicationPortalRepair already reads monitored descriptions under
   (`left(description, 60000)`), and the same one POST /jd-match will score against. Well inside
   RESUME_REQUEST_LIMITS.jobDescription (100_000), so a repaired packet can still be regenerated. */
export const MAX_REPAIRED_JD_CHARS = 60_000;

function specObject(spec: unknown): StoredSpec | null {
  return spec && typeof spec === 'object' && !Array.isArray(spec) ? spec as StoredSpec : null;
}

function jobContextObject(jobContext: unknown): StoredSpec {
  return jobContext && typeof jobContext === 'object' && !Array.isArray(jobContext)
    ? jobContext as StoredSpec
    : {};
}

function jobContextText(jobContext: unknown, key: string): string {
  const value = jobContextObject(jobContext)[key];
  return typeof value === 'string' ? value.trim() : '';
}

/* NO company/role CONTEXT IS PASSED, AND THAT IS THE INVARIANT RATHER THAN AN OVERSIGHT.
 *
 * leadRequirementCandidates takes an optional JdContext, and an earlier version of this file built
 * one from job_context on the reasoning that a stored packet knows its employer while the extraction
 * route does not. A mutation sweep killed that: removing the context changed no test, because the
 * context is INERT for this predicate. extractJdSignals threads it into extractJdTerms only, whose
 * output lands in `tools_and_skills` - and leadRequirementCandidates reads impact_examples,
 * hard_requirements and experience_requirements, never tools_and_skills. It could not have made a
 * difference to any input.
 *
 * So it is not passed, and the reason to keep it that way outlives the current implementation: the
 * route CANNOT pass one (the packet does not exist yet), and this detector must ask the identical
 * question the route asks or it will flag rows the live route is perfectly happy to create. If
 * leadRequirementCandidates ever becomes context-sensitive, the two callers still have to agree,
 * and agreeing means both asking without it. */

/**
 * THE DETECTOR: a frozen packet whose job description states no requirement at all.
 *
 * WHAT THIS DELIBERATELY DOES NOT ALSO TEST, and the omission is the design. The observed symptom
 * is "form-shaped AND states no ask", and it is tempting to require both. It is not done here, for
 * two reasons that point the same way.
 *
 * A form-marker test would be a hand-written corpus of labels ("Required fields", "Resume/CV",
 * "Submit your application"), and this repository has already deleted one of those this month -
 * `fix(ats): anchor comeet on shape, and stop trusting a hand-written corpus`. Every real posting
 * that carries its application form inline would match it, which is most Greenhouse pages, so it
 * could only ever be an AND-condition propping up the real predicate; and as an AND-condition it
 * silently narrows the detector by whatever the corpus has not seen yet. Belvedere's page says
 * "SUBMIT YOUR APPLICATION"; the next one may not.
 *
 * And the safety it would buy is bought better on the repair side. A false positive here - a real
 * but unstructured posting that happens to state no parseable ask - CANNOT cause a bad write,
 * because resolvePacketJdReplacement will only overwrite from a source bound to this same posting
 * by identifier, and only with text that itself states an ask. The worst case of a false positive
 * is that a packet is offered a repair which then declines to find anything, or that a posting is
 * replaced by the board's own better-structured copy of the SAME posting. Neither is a loss.
 *
 * THAT FALSE-POSITIVE CLASS IS REAL AND WAS MEASURED, not hypothetical. Swept across every `*_JD`
 * fixture in this repository, the predicate refuses two texts that came off real postings: the
 * Databricks Product Management internship paragraph in engine/jdMatch.test.ts ("At Databricks we
 * build the best data and AI infrastructure platform...", 458 characters, 0 asks) and the Litos QA
 * receipt posting (203 characters, 0 asks). Both are abridged prose with no section cues at all,
 * which is what extractJdSignals reads. Full postings all cleared: Deepgram 8, Gemini 12, PsiQuantum
 * 4, Truveta 2, Five Rings 2, KOS 5. So "states no ask" is a good enough bar for a REFUSAL that
 * costs one paste, and it is not on its own a good enough bar for a WRITE - which is why the write
 * has three more conditions after it.
 */
export function packetJdStatesNoRequirement(row: Pick<ResumeRow, 'spec'>): boolean {
  const review = readApplicationReview(row.spec);
  if (!review) return false;
  const jdText = typeof review.jd_text === 'string' ? review.jd_text : '';
  /* An empty frozen description is a different defect with a different answer - there is nothing
     to compare a replacement against, and `job_extract_empty` already refuses it at intake. */
  if (!jdText.trim()) return false;
  return statesNoRequirement(jdText);
}

/* ─── the employer-held gate, lifted rather than re-derived ─────────────────────────────────────
 *
 * EVERY LINE BELOW IS THE GATE FROM lib/packetApplicantEmailBackfill.ts (branch
 * fix/backfill-applicant-alias), and it is here in this shape on purpose. That gate reached its
 * current form over three review rounds, each of which found a definition of "already at an
 * employer" that the previous round had missed: the four stored facts in employerMayHoldApplication,
 * then the two prose markers that predate them, then the canonical ledger on the `applications`
 * row that no packet field can see. Writing a fresh gate for this repair would have restarted that
 * count with a different author.
 *
 * IT IS COPIED RATHER THAN IMPORTED ONLY BECAUSE packetApplicantEmailBackfill.ts IS NOT ON MAIN.
 * This branch is cut from origin/main, where that file does not exist. Whichever of the two lands
 * second should delete its copy and import the other's; the two must never be edited apart.
 *
 * alreadyAtEmployer() in lib/duplicateApplication.ts is deliberately NOT called, and the reason is
 * not that it is too broad. It is a SQL predicate over the user's OTHER packets, used to decide
 * whether a second application to the same posting would be a duplicate; that is not this question.
 * Applied to THIS row its four arms are each already refused here: `status = 'submitted'` is
 * outside REPAIRABLE_STATUSES, `pipeline_stage = 'applied'` is refused by name, an unresolved
 * unverified_submission is one of employerMayHoldApplication's four facts, and the legacy prose is
 * recordsAnUnverifiedPress. This gate is a strict superset of it, on the row it is asked about. */

/* AN ALLOW-LIST, BECAUSE A DENY-LIST OF SENT STATES CANNOT BE COMPLETED. Fails closed on any status
   added later, which is the property a deny-list could not have. These four are the ones
   submitRequestDisposition itself calls 'start' - the SEND-grade question, which is the right
   altitude: a repaired packet has to be regenerated and re-approved before it can go anywhere, so
   this is a reopening-a-send decision and not a save. */
const REPAIRABLE_STATUSES = new Set<ApplicationReviewState['status']>([
  'resume_ready',
  'questions_ready',
  'ready_to_submit',
  'failed',
]);

/* The prose an extension run writes when it pressed submit and could not confirm the result. A
   different producer from the pre-extension runner's, whose prefix isLegacyUnverifiedAttemptReason
   owns; the two are asked separately because either could change without the other. */
const EXTENSION_UNVERIFIED_PRESS_PREFIX =
  'litos clicked submit but could not verify the employer confirmation';

/** Either producer's way of saying "Submit was pressed and the result was never confirmed". */
export function recordsAnUnverifiedPress(reason: unknown): boolean {
  if (isLegacyUnverifiedAttemptReason(reason)) return true;
  return typeof reason === 'string'
    && reason.trim().toLowerCase().startsWith(EXTENSION_UNVERIFIED_PRESS_PREFIX);
}

/**
 * Pure. Whether this packet is far enough from the employer to have its job description rewritten.
 *
 * `submitted_at` and `pipeline_stage` are asked separately from employerMayHoldApplication because
 * neither is in StoredSendEvidence, and a torn write can leave pipeline_stage 'applied' beside a
 * non-submitted status.
 */
export function packetJdIsRepairable(
  review: Pick<
    ApplicationReviewState,
    'status' | 'submission_claimed_at' | 'submitted_at' | 'attention_reason'
    | 'submission_attempted_at' | 'receipt' | 'unverified_submission' | 'security_code'
  >,
  pipelineStage?: string | null,
): boolean {
  if (!REPAIRABLE_STATUSES.has(review.status)) return false;
  if (review.submission_claimed_at) return false;
  if (review.submitted_at) return false;
  if (pipelineStage === 'applied') return false;
  if (recordsAnUnverifiedPress(review.attention_reason)) return false;
  return !employerMayHoldApplication(review);
}

/**
 * THE FOURTH DEFINITION OF "THE EMPLOYER MAY HOLD THIS", AND THE ONE NO PACKET FIELD CAN SEE.
 *
 * POST /applications/:id/manual-submission-outcome writes applications.submission_state while
 * touching nothing on generated_resumes, so a packet whose application was marked submitted that
 * way keeps status 'ready_to_submit' and every packet-side guard above says "repairable".
 *
 * Both links are asked because neither is dependable alone: applications.legacy_generated_resume_id
 * is a single column under a unique index, so a SECOND packet generated against one canonical
 * application repoints it and the first stops being findable that way - while its application may
 * already be submitted. The per-packet artifact chain is written on every generation path and never
 * repointed.
 */
export async function canonicalApplicationRecordsASubmission(
  packetId: string,
  userId: string,
): Promise<boolean> {
  const [held] = await db.select({ id: applications.id })
    .from(applications)
    .leftJoin(application_artifacts, eq(application_artifacts.application_id, applications.id))
    .leftJoin(artifacts, eq(artifacts.id, application_artifacts.artifact_id))
    .where(and(
      eq(applications.user_id, userId),
      or(
        eq(applications.legacy_generated_resume_id, packetId),
        and(eq(artifacts.legacy_generated_resume_id, packetId), eq(artifacts.user_id, userId)),
      ),
      or(
        eq(applications.submission_state, 'submitted'),
        eq(applications.tracker_state, 'applied'),
      ),
    ))
    .limit(1);
  return Boolean(held);
}

/* ─── where the real description lives ──────────────────────────────────────────────────────────*/

export type PacketJdSource =
  /** monitored_jobs.description, the row job_context.job_id names. No network, no model. */
  | 'monitored_job'
  /** The board's own public posting API, keyed on the posting id in the packet's portal URL. */
  | 'board_api'
  /** The description page the packet's own portal URL resolves to, rendered once. */
  | 'reextraction';

export type PacketJdReplacement = {
  text: string;
  source: PacketJdSource;
  /** How the replacement was bound to THIS posting. Never a title or company similarity score. */
  binding: 'job_id' | 'ats_posting' | 'portal_url';
  /** What the replacement states, for the log line. Zero can never reach here. */
  askCount: number;
};

export type PacketJdRepairDeps = {
  /** The monitored_jobs row `job_context.job_id` names, joined to an enabled source. */
  loadMonitoredJob?: (jobId: string) => Promise<{ company: string; title: string; description: string } | null>;
  /** The board's public posting list. Same fetcher and normalizers the daily poll uses. */
  fetchBoardPostings?: typeof fetchSourceJobs;
  /** The managed browser, for the last tier. Same runner POST /jobs/extract uses. */
  renderPage?: typeof runManagedBrowser;
  /** Whether a browser the server does not control ever reported an outcome for this packet. */
  hasExtensionOutcome?: (packetId: string, userId: string) => Promise<boolean>;
  /** Whether the canonical ledger already records this packet's application as submitted. */
  canonicalSubmission?: (packetId: string, userId: string) => Promise<boolean>;
};

async function loadMonitoredJobById(
  jobId: string,
): Promise<{ company: string; title: string; description: string } | null> {
  const [job] = await db.select({
    company: monitored_jobs.company_name,
    title: monitored_jobs.title,
    /* The same bounded read applicationPortalRepair uses. Reading a whole description column out of
       Neon per request is what once exhausted the transfer allowance; see description_digest. */
    description: sql<string>`left(${monitored_jobs.description}, ${MAX_REPAIRED_JD_CHARS})`,
  })
    .from(monitored_jobs)
    .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
    .where(and(eq(monitored_jobs.id, jobId), eq(career_page_sources.enabled, true)))
    .limit(1);
  return job ?? null;
}

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type BoardPostingRef = { ats_name: SupportedJobBoard; board_token: string; external_id: string };

/**
 * The board and posting id this packet's portal URL names, for the four boards whose public API the
 * poller already reads and whose normalizers already produce `external_id` in the same spelling
 * these parsers produce.
 *
 * The parsers are the ones lib/duplicateApplication.ts uses to decide whether two packets are the
 * SAME posting. That is the identical question a repair has to get right, so it is the identical
 * reading - not a looser one that would let a repair reach a posting the duplicate guard would not
 * consider the same.
 *
 * Every other provider genericKnownPosting can name (Workday, iCIMS, SmartRecruiters and the rest)
 * returns null here on purpose: there is no board endpoint in this codebase to ask, and inventing
 * one for a repair is how a "fix" starts scraping pages nobody has ever measured.
 */
export function boardPostingFromPortalUrl(portalUrl: string | undefined | null): BoardPostingRef | null {
  const url = portalUrl?.trim();
  if (!url) return null;
  const greenhouse = greenhousePostingFromUrl(url);
  if (greenhouse) return { ats_name: 'greenhouse', board_token: greenhouse.boardToken, external_id: greenhouse.jobId };
  const lever = leverPostingFromUrl(url);
  if (lever) return { ats_name: 'lever', board_token: lever.site, external_id: lever.postingId };
  const ashby = ashbyPostingFromUrl(url);
  if (ashby) return { ats_name: 'ashby', board_token: ashby.organization, external_id: ashby.jobPostingId };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  // apply.workable.com/<account>/j/<shortcode>[/apply]. normalizeWorkableJobs keys on the shortcode.
  if (parsed.hostname.toLowerCase() === 'apply.workable.com' && parts.length >= 3 && parts[1] === 'j') {
    return { ats_name: 'workable', board_token: parts[0]!, external_id: parts[2]! };
  }
  return null;
}

/**
 * The description page a stored portal URL resolves to, or null when it is not a URL at all.
 *
 * jobDescriptionSourceUrl throws on an unparseable string - it is written for a route that has
 * already validated the URL against a zod schema, and a stored packet has no such guarantee. It
 * also returns the input untouched for every board it does not know, which is correct: a stored URL
 * that is already a description page is the Jane Street shape and needs no rewrite.
 */
function safeDescriptionUrl(portalUrl: string): string | null {
  try {
    const derived = jobDescriptionSourceUrl(portalUrl);
    return new URL(derived).protocol === 'https:' ? derived : null;
  } catch {
    return null;
  }
}

/** Boards spell their own ids inconsistently between the URL and the API (Ashby and Lever UUIDs). */
function sameExternalId(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * The real description for this packet, or null.
 *
 * TIER ORDER IS BY HOW TIGHTLY THE SOURCE IS BOUND TO THIS POSTING, not by convenience. job_id is
 * the surrogate this packet recorded at generation, pointing at the row the board itself was polled
 * into - the strongest link there is, and it costs no network. The board API is second: the posting
 * id is the EMPLOYER's own identifier, which lib/duplicateApplication measured as "at least as
 * discriminating as our surrogate and strictly more available", but reaching it means a live fetch
 * that can fail, be rate limited, or return a board that has since dropped the posting.
 *
 * COMPANY AND TITLE MUST STILL AGREE on tier 1, through companyIdentity - the one definition of
 * "the same company", shared with the prior-application resolver. A job_id that names a row whose
 * employer or title has drifted is a repointed or reused surrogate, not this posting.
 *
 * monitoredJdAgrees IS NOT ASKED, AND ITS ABSENCE IS THE POINT. That predicate asks whether the
 * packet's frozen jd_text and the board's description are the same posting's text, by comparing
 * job_context.jd_hash - which generation computes as sha256(jd_text).slice(0,16) - against the
 * board copy. On a corrupted row jd_hash is the hash of the FORM, so monitoredJdAgrees answers
 * false by construction on precisely the rows this repair exists for. Asking it would be asking
 * "are these already equal" of a repair whose whole job is that they are not. What replaces it is
 * the identifier binding above plus the two conditions below, neither of which can be satisfied by
 * a different posting's text.
 *
 * THE REPLACEMENT MUST CLEAR THE SAME TWO BARS A FRESHLY POLLED POSTING CLEARS. isIngestablePosting
 * is the poller's own ingest gate - the 120-character floor measured across 22,119 postings, the
 * placeholder set, the title-echo rule, and the self-declared-test-posting rule - so a repair can
 * never write text the poller itself would have refused to store. And it must state an ask, which
 * is the one thing the stored text failed at: swapping a form for a second form, or for a board's
 * empty stub, would spend the repair and leave the defect.
 */
export async function resolvePacketJdReplacement(
  row: Pick<ResumeRow, 'spec' | 'job_context'>,
  deps: PacketJdRepairDeps = {},
): Promise<PacketJdReplacement | null> {
  const review = readApplicationReview(row.spec);
  if (!review) return null;
  const expectedCompany = jobContextText(row.job_context, 'company');
  const expectedRole = jobContextText(row.job_context, 'role') || (review.role ?? '').trim();

  const accept = (text: string, title: string, source: PacketJdSource, binding: PacketJdReplacement['binding']) => {
    const description = (text ?? '').trim().slice(0, MAX_REPAIRED_JD_CHARS);
    if (!isIngestablePosting({ description, title })) return null;
    const asks = leadRequirementCandidates(description);
    if (asks.length === 0) return null;
    /* A replacement identical to what is stored cannot be a repair, and writing it would burn a
       packet_version - and therefore an acknowledgement - for no change at all. */
    if (description === review.jd_text) return null;
    return { text: description, source, binding, askCount: asks.length } satisfies PacketJdReplacement;
  };

  const jobId = jobContextText(row.job_context, 'job_id');
  if (JOB_ID_PATTERN.test(jobId)) {
    const job = await (deps.loadMonitoredJob ?? loadMonitoredJobById)(jobId).catch(() => null);
    if (job
      && expectedCompany && companyIdentity(job.company) === companyIdentity(expectedCompany)
      && expectedRole && companyIdentity(job.title) === companyIdentity(expectedRole)) {
      const accepted = accept(job.description, job.title, 'monitored_job', 'job_id');
      if (accepted) return accepted;
    }
  }

  const posting = boardPostingFromPortalUrl(review.portal_url);
  if (posting) {
    const board = await (deps.fetchBoardPostings ?? fetchSourceJobs)({
      ats_name: posting.ats_name,
      board_token: posting.board_token,
    }).catch(() => null);
    const match = board?.find((job) => sameExternalId(job.external_id, posting.external_id));
    if (match) {
      const accepted = accept(match.description, match.title, 'board_api', 'ats_posting');
      if (accepted) return accepted;
    }
  }

  /* THE LAST TIER, AND THE ONLY ONE MEASURED END TO END ON THE ROW THIS WAS WRITTEN FOR.
   *
   * jobDescriptionSourceUrl (routes/jobExtract.ts, main eb8d319) now derives Lever's overview from
   * an apply route, and the session that shipped it measured the result through the deployed route:
   * Belvedere's stored apply URL returns 502 with the intended refusal, and the overview URL the
   * rewrite produces returns 200 with 6,251 characters of genuine description, no school dropdown
   * and no form markers. The two tiers above are better SOURCES - the employer's own description
   * field, no page chrome, no render - but neither has been checked against Belvedere's live board,
   * and this one has. It also covers every provider with no board endpoint in this codebase.
   *
   * CLIPPED AT MAX_JD_TEXT_CHARS, NOT AT MAX_REPAIRED_JD_CHARS, and the difference is deliberate.
   * This tier performs exactly the operation POST /jobs/extract performs, so it must not be able to
   * produce a row the route itself could not have produced. The board tiers read a stored
   * description field rather than a rendered page and keep applicationPortalRepair's 60k bound.
   *
   * IT CANNOT REINTRODUCE THE DEFECT. The clip is what broke Belvedere in the first place - three
   * thousand `<select>` options ate the 20,000 characters before the description was reached - and
   * the acceptance test below is applied to the CLIPPED text, so a page that truncates past its
   * description states no ask and is refused, exactly as the deployed guard refuses it live.
   *
   * ONE RENDER, NEVER A RETRY LOOP, and only after both cheaper tiers have declined. */
  const descriptionUrl = review.portal_url ? safeDescriptionUrl(review.portal_url) : null;
  if (!descriptionUrl) return null;
  const rendered = await (deps.renderPage ?? runManagedBrowser)(descriptionUrl, [
    { type: 'waitForSelector', selector: '.litos-jd-extract-render-delay-noop', timeout: 5000, optional: true },
    { type: 'extract', selector: 'body' },
  ]).catch(() => null);
  if (!rendered) return null;
  return accept(
    (rendered.text ?? '').trim().slice(0, MAX_JD_TEXT_CHARS),
    rendered.title || expectedRole,
    'reextraction',
    'portal_url',
  );
}

/* ─── the plan and the write ────────────────────────────────────────────────────────────────────*/

export type PacketJdRepair = {
  /** The whole next spec. `_review.jd_text` is the only key that differs. */
  spec: StoredSpec;
  /** The whole next job_context. `jd_hash` is the only key that differs. */
  jobContext: StoredSpec;
  replacement: PacketJdReplacement;
};

/**
 * The whole decision, with no writes. Null means "leave this row alone", for every reason.
 *
 * ORDER IS DELIBERATE: the cheap pure refusals first, then the two lookups that can fail, and only
 * then the source resolution that touches the network. A row that is not corrupted, or that an
 * employer may hold, must never cause a board fetch on its behalf.
 */
export async function planPacketJdRepair(
  row: Pick<ResumeRow, 'id' | 'user_id' | 'spec' | 'job_context' | 'pipeline_stage'>,
  deps: PacketJdRepairDeps = {},
): Promise<PacketJdRepair | null> {
  const stored = specObject(row.spec);
  if (!stored) return null;
  const review = readApplicationReview(stored);
  if (!review) return null;
  if (!packetJdStatesNoRequirement(row)) return null;
  if (!packetJdIsRepairable(review, row.pipeline_stage)) return null;

  /* An extension outcome event means a browser the server does not control observed a submission
   * for this packet, and no field on the packet can see it: the writer records the event against
   * the canonical application and never touches `_review`. Fails CLOSED on a lookup that throws -
   * a repair must never out-argue an observation it could not read. */
  const observed = await (deps.hasExtensionOutcome ?? packetHasExtensionSubmissionOutcomeEvent)(
    row.id,
    row.user_id,
  ).catch(() => true);
  if (observed) return null;

  const ledgerSaysSubmitted = await (deps.canonicalSubmission ?? canonicalApplicationRecordsASubmission)(
    row.id,
    row.user_id,
  ).catch(() => true);
  if (ledgerSaysSubmitted) return null;

  const replacement = await resolvePacketJdReplacement(row, deps);
  if (!replacement) return null;

  const nextReview: ApplicationReviewState = { ...review, jd_text: replacement.text };
  return {
    replacement,
    spec: { ...stored, _review: nextReview },
    /* Written in the same statement as jd_text, never after it. Generation computes this as
       sha256(jd_text).slice(0,16), which is monitoredDescriptionHash; a row whose jd_hash describes
       a description it no longer holds cannot be matched back to its monitored job, which is what
       applicationPortalRepair needs to recover a portal URL. */
    jobContext: { ...jobContextObject(row.job_context), jd_hash: monitoredDescriptionHash(replacement.text) },
  };
}

/**
 * Plans the repair and writes it under an exact CAS on both columns.
 *
 * THE EXACT-SPEC CAS IS LOAD-BEARING. This writes the WHOLE spec, so without it a repair planned
 * from a stale read would silently discard whatever landed in between - a cover-letter reconcile,
 * an answer save, a refreshed `_review.questions`. job_context is CAS'd for the same reason and in
 * the same statement: the two must move together or monitoredJdAgrees is left describing neither.
 *
 * OWNERSHIP IS PROVEN BY THE WRITE ITSELF, which is enough here and was not enough for the alias
 * backfill: that one had a preceding side effect (minting a live inbound mail route) that had to be
 * ownership-checked before it ran. This has no side effect before the update, and the update is
 * owner-scoped, so a row presented under the wrong user_id simply matches nothing.
 *
 * A LOST CAS RETURNS NULL RATHER THAN RETRYING. The loser of this particular race is either a
 * concurrent repair - in which case the row is already correct and the caller should re-read it -
 * or an ordinary write to a row this repair had already decided to touch, which must be re-planned
 * against what actually landed rather than overwritten from a stale plan.
 */
export async function repairPacketJd(
  row: ResumeRow,
  deps: PacketJdRepairDeps = {},
): Promise<ResumeRow | null> {
  const planned = await planPacketJdRepair(row, deps);
  if (!planned) return null;

  const updated = await db.update(generated_resumes)
    .set({ spec: planned.spec, job_context: planned.jobContext })
    .where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, row.user_id),
      sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
      sql`${generated_resumes.job_context} = ${JSON.stringify(row.job_context)}::jsonb`,
    ))
    .returning({ id: generated_resumes.id });
  if (updated.length === 0) return null;

  return { ...row, spec: planned.spec, job_context: planned.jobContext };
}
